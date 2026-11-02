use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
use tokio::sync::mpsc::{
    UnboundedReceiver, UnboundedSender, error::TryRecvError, unbounded_channel,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverflowPolicy {
    Unbounded,
    CloseAbove { bytes: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseCause {
    Overflow,
    Shutdown { code: u16, reason: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outbound {
    Frame(Arc<str>),
    Close(CloseCause),
}

#[derive(Default)]
struct Shared {
    queued: AtomicUsize,
    close: Mutex<Option<CloseCause>>,
}

pub struct OutboundRx {
    rx: UnboundedReceiver<Arc<str>>,
    shared: Arc<Shared>,
    done: bool,
}

impl OutboundRx {
    pub async fn recv(&mut self) -> Option<Outbound> {
        if self.done {
            return None;
        }
        if let Some(close) = self.take_close() {
            return Some(close);
        }
        let frame = self.rx.recv().await;
        self.deliver(frame)
    }

    pub fn try_recv(&mut self) -> Option<Outbound> {
        if self.done {
            return None;
        }
        if let Some(close) = self.take_close() {
            return Some(close);
        }
        match self.rx.try_recv() {
            Ok(frame) => self.deliver(Some(frame)),
            Err(TryRecvError::Disconnected) => self.deliver(None),
            Err(TryRecvError::Empty) => None,
        }
    }

    pub fn queued_bytes(&self) -> usize {
        self.shared.queued.load(Ordering::Acquire)
    }

    fn take_close(&mut self) -> Option<Outbound> {
        if self.done {
            return None;
        }
        let cause = self.shared.close.lock().take()?;
        self.done = true;
        self.rx.close();
        Some(Outbound::Close(cause))
    }

    fn deliver(&mut self, frame: Option<Arc<str>>) -> Option<Outbound> {
        if let Some(frame) = &frame {
            self.shared.queued.fetch_sub(frame.len(), Ordering::AcqRel);
        }
        if let Some(close) = self.take_close() {
            return Some(close);
        }
        frame.map(Outbound::Frame)
    }
}

pub(super) struct Conn {
    tx: Option<UnboundedSender<Arc<str>>>,
    shared: Arc<Shared>,
    policy: OverflowPolicy,
    pub(super) live_from: Option<u64>,
}

impl Conn {
    pub(super) fn new(policy: OverflowPolicy) -> (Self, OutboundRx) {
        let (tx, rx) = unbounded_channel();
        let shared = Arc::new(Shared::default());
        let conn = Conn {
            tx: Some(tx),
            shared: shared.clone(),
            policy,
            live_from: None,
        };
        let rx = OutboundRx {
            rx,
            shared,
            done: false,
        };
        (conn, rx)
    }

    pub(super) fn is_open(&self) -> bool {
        self.tx.is_some()
    }

    pub(super) fn push(&mut self, frame: &Arc<str>) -> bool {
        let Some(tx) = &self.tx else { return false };
        let queued = self.shared.queued.load(Ordering::Acquire);
        if let OverflowPolicy::CloseAbove { bytes } = self.policy
            && queued > 0
            && queued + frame.len() > bytes
        {
            self.close(CloseCause::Overflow);
            return false;
        }
        self.shared.queued.fetch_add(frame.len(), Ordering::AcqRel);
        if tx.send(frame.clone()).is_err() {
            self.shared.queued.fetch_sub(frame.len(), Ordering::AcqRel);
            return false;
        }
        true
    }

    pub(super) fn close(&mut self, cause: CloseCause) {
        if self.tx.is_some() {
            *self.shared.close.lock() = Some(cause);
            self.tx = None;
        }
    }
}
