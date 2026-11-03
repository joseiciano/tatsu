use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tatsu_state::StateEvent;
use tokio::runtime::Handle;

use crate::router::{ClientId, ConnCtx, Routed, Router};
use crate::store::Store;

mod frame;
mod outbound;
#[cfg(test)]
mod tests;

use outbound::Conn;
pub use outbound::{CloseCause, Outbound, OutboundRx, OverflowPolicy};

pub const SHUTDOWN_CODE: u16 = 1001;
pub const SHUTDOWN_REASON: &str = "server shutting down";

pub type DisconnectCallback = Arc<dyn Fn(&ClientId) + Send + Sync>;

pub struct ConnHandle {
    pub client_id: ClientId,
    pub outbound: OutboundRx,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    Malformed,
    UnknownClient,
}

pub struct Hub {
    store: Arc<Store>,
    router: Arc<Router>,
    runtime: Handle,
    conns: Mutex<HashMap<ClientId, Conn>>,
    disconnect: RwLock<Vec<DisconnectCallback>>,
}

impl Hub {
    pub fn new(store: Arc<Store>, router: Arc<Router>, runtime: Handle) -> Arc<Hub> {
        let hub = Arc::new(Hub {
            store: store.clone(),
            router,
            runtime,
            conns: Mutex::new(HashMap::new()),
            disconnect: RwLock::new(Vec::new()),
        });
        let weak = Arc::downgrade(&hub);
        store.set_hub_sink(move |event, seq| {
            if let Some(hub) = weak.upgrade() {
                hub.on_state(event, seq);
            }
        });
        hub
    }

    pub fn open(&self, policy: OverflowPolicy) -> ConnHandle {
        let client_id = ClientId(uuid::Uuid::new_v4().to_string());
        let (conn, outbound) = Conn::new(policy);
        self.conns.lock().insert(client_id.clone(), conn);
        ConnHandle {
            client_id,
            outbound,
        }
    }

    pub fn close(&self, client_id: &ClientId) -> bool {
        if self.conns.lock().remove(client_id).is_none() {
            return false;
        }
        let callbacks = self.disconnect.read().clone();
        for callback in callbacks {
            callback(client_id);
        }
        true
    }

    pub fn on_disconnect(&self, callback: impl Fn(&ClientId) + Send + Sync + 'static) {
        self.disconnect.write().push(Arc::new(callback));
    }

    pub fn on_frame(self: &Arc<Self>, client_id: &ClientId, raw: &str) -> Result<(), FrameError> {
        let value = tatsu_js::parse_lenient(raw).map_err(|_| FrameError::Malformed)?;
        if !self.conns.lock().contains_key(client_id) {
            return Err(FrameError::UnknownClient);
        }
        let ctx = ConnCtx {
            client_id: client_id.clone(),
        };
        match frame::decode(value) {
            frame::Inbound::Snapreq { id } => self.snapreq(client_id, id),
            frame::Inbound::Req { id, name, args } => {
                let hub = self.clone();
                self.runtime.spawn(async move {
                    let Routed { reply, guard } =
                        hub.router.dispatch_request(ctx.clone(), &name, args).await;
                    hub.push_to(&ctx.client_id, frame::res(id, reply).into());
                    drop(guard);
                });
            }
            frame::Inbound::Send { name, args } => self.router.dispatch_signal(ctx, &name, args),
            frame::Inbound::Ignored => {}
        }
        Ok(())
    }

    pub fn broadcast_signal(&self, name: &str, args: Vec<Value>) {
        let frame: Arc<str> = frame::sig(name, args).into();
        for conn in self.conns.lock().values_mut() {
            conn.push(&frame);
        }
    }

    pub fn shutdown(&self, code: u16, reason: &str) {
        for conn in self.conns.lock().values_mut() {
            conn.close(CloseCause::Shutdown {
                code,
                reason: reason.to_string(),
            });
        }
    }

    fn snapreq(&self, client_id: &ClientId, id: Option<Value>) {
        self.store.snapshot_with(|snapshot_json, seq| {
            let frame: Arc<str> = frame::snapres(id.as_ref(), snapshot_json).into();
            if let Some(conn) = self.conns.lock().get_mut(client_id)
                && conn.push(&frame)
            {
                conn.live_from = Some(seq);
            }
        });
    }

    fn push_to(&self, client_id: &ClientId, frame: Arc<str>) {
        if let Some(conn) = self.conns.lock().get_mut(client_id) {
            conn.push(&frame);
        }
    }

    fn on_state(&self, event: &StateEvent, seq: u64) {
        let mut conns = self.conns.lock();
        let receives =
            |conn: &Conn| conn.is_open() && conn.live_from.is_some_and(|from| from < seq);
        if !conns.values().any(receives) {
            return;
        }
        let frame: Arc<str> = frame::state(event, seq).into();
        let mut sent = 0;
        for conn in conns.values_mut() {
            if receives(conn) && conn.push(&frame) {
                sent += 1;
            }
        }
        drop(conns);
        self.store.record_frames(sent);
    }
}
