use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ops::Bound::{Excluded, Unbounded};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::ReentrantMutex;
use serde_json::{Value, json};
use tatsu_state::{AppState, StateEvent, StateSnapshot, root_reduce, strip_snapshot_for_wire};

#[cfg(test)]
mod tests;
#[cfg(test)]
mod threads;

pub const SLOW_DISPATCH_MS: f64 = 5.0;
pub const CASCADE_THRESHOLD: u32 = 15;

pub type Listener = Arc<dyn Fn(&StateEvent, u64) + Send + Sync>;
pub type NowMs = Box<dyn Fn() -> i64 + Send + Sync>;
pub type TimerMs = Box<dyn Fn() -> f64 + Send + Sync>;
pub type PerfSink = Box<dyn Fn(&str, &str, &Value) + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SubscriptionId(u64);

pub struct StoreOptions {
    pub now_ms: NowMs,
    pub timer_ms: TimerMs,
    pub perf: PerfSink,
}

impl Default for StoreOptions {
    fn default() -> Self {
        let start = Instant::now();
        Self {
            now_ms: Box::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as i64)
            }),
            timer_ms: Box::new(move || start.elapsed().as_secs_f64() * 1000.0),
            perf: Box::new(|category, message, data| {
                crate::logs::perf_with(category, message, data)
            }),
        }
    }
}

struct Inner {
    state: AppState,
    seq: u64,
    hub: Option<Listener>,
    listeners: BTreeMap<u64, Listener>,
    next_id: u64,
    depth: u32,
    cascade_root: Option<&'static str>,
    cascade_children: u32,
}

pub struct Store {
    inner: ReentrantMutex<RefCell<Inner>>,
    options: StoreOptions,
    pub frames_sent: AtomicU64,
}

const DISPATCH_IN_READ: &str =
    "Store::dispatch called inside Store::read; a read closure must not dispatch";

impl Store {
    pub fn new(initial: AppState) -> Self {
        Self::with_options(initial, StoreOptions::default())
    }

    pub fn with_options(initial: AppState, options: StoreOptions) -> Self {
        Self {
            inner: ReentrantMutex::new(RefCell::new(Inner {
                state: initial,
                seq: 0,
                hub: None,
                listeners: BTreeMap::new(),
                next_id: 0,
                depth: 0,
                cascade_root: None,
                cascade_children: 0,
            })),
            options,
            frames_sent: AtomicU64::new(0),
        }
    }

    pub fn read<R>(&self, f: impl FnOnce(&AppState) -> R) -> R {
        let guard = self.inner.lock();
        let inner = guard.borrow();
        f(&inner.state)
    }

    pub fn seq(&self) -> u64 {
        self.inner.lock().borrow().seq
    }

    pub fn snapshot_with<R>(&self, f: impl FnOnce(&str, u64) -> R) -> R {
        let guard = self.inner.lock();
        let (snapshot, seq) = {
            let inner = guard.borrow();
            let snapshot = strip_snapshot_for_wire(StateSnapshot {
                state: inner.state.clone(),
                seq: inner.seq,
            });
            (snapshot, inner.seq)
        };
        let value = serde_json::to_value(&snapshot).expect("AppState serializes to JSON");
        f(&tatsu_js::stringify(&value), seq)
    }

    pub fn record_frames(&self, n: u64) {
        self.frames_sent
            .fetch_add(n, std::sync::atomic::Ordering::Relaxed);
    }

    pub fn set_hub_sink(&self, sink: impl Fn(&StateEvent, u64) + Send + Sync + 'static) {
        self.inner.lock().borrow_mut().hub = Some(Arc::new(sink));
    }

    pub fn subscribe(
        &self,
        listener: impl Fn(&StateEvent, u64) + Send + Sync + 'static,
    ) -> SubscriptionId {
        let guard = self.inner.lock();
        let mut inner = guard.borrow_mut();
        inner.next_id += 1;
        let id = inner.next_id;
        inner.listeners.insert(id, Arc::new(listener));
        SubscriptionId(id)
    }

    pub fn unsubscribe(&self, id: SubscriptionId) {
        self.inner.lock().borrow_mut().listeners.remove(&id.0);
    }

    pub fn dispatch(&self, event: StateEvent) {
        let guard = self.inner.lock();
        let t0 = (self.options.timer_ms)();
        let _depth = DepthGuard {
            store: self,
            guard: &guard,
        };
        let (seq, hub) = {
            let mut inner = guard.try_borrow_mut().expect(DISPATCH_IN_READ);
            inner.depth += 1;
            if inner.depth == 1 {
                inner.cascade_root = Some(event.type_name());
                inner.cascade_children = 0;
            } else {
                inner.cascade_children += 1;
            }
            root_reduce(&mut inner.state, event.clone(), (self.options.now_ms)());
            inner.seq += 1;
            (inner.seq, inner.hub.clone())
        };
        let t1 = (self.options.timer_ms)();
        if let Some(hub) = hub {
            hub(&event, seq);
        }
        let mut last = 0;
        loop {
            let next = guard
                .borrow()
                .listeners
                .range((Excluded(last), Unbounded))
                .next()
                .map(|(id, listener)| (*id, listener.clone()));
            let Some((id, listener)) = next else { break };
            last = id;
            listener(&event, seq);
        }
        let t2 = (self.options.timer_ms)();
        let total_ms = t2 - t0;
        if total_ms >= SLOW_DISPATCH_MS {
            let reducer_ms = t1 - t0;
            let ty = event.type_name();
            (self.options.perf)(
                "store-slow",
                &format!(
                    "{ty} reducer={}ms total={}ms",
                    tatsu_js::to_fixed(reducer_ms, 1),
                    tatsu_js::to_fixed(total_ms, 1)
                ),
                &json!({
                    "type": ty,
                    "reducerMs": round2(reducer_ms),
                    "listenerMs": round2(total_ms - reducer_ms),
                    "totalMs": round2(total_ms),
                }),
            );
        }
    }
}

fn round2(x: f64) -> f64 {
    tatsu_js::to_fixed(x, 2).parse().unwrap_or(f64::NAN)
}

struct DepthGuard<'a> {
    store: &'a Store,
    guard: &'a parking_lot::ReentrantMutexGuard<'a, RefCell<Inner>>,
}

impl Drop for DepthGuard<'_> {
    fn drop(&mut self) {
        let Ok(mut inner) = self.guard.try_borrow_mut() else {
            return;
        };
        if inner.depth == 0 {
            return;
        }
        inner.depth -= 1;
        if inner.depth > 0 {
            return;
        }
        let root = inner.cascade_root.take();
        let children = std::mem::take(&mut inner.cascade_children);
        drop(inner);
        if let Some(root) = root
            && children > CASCADE_THRESHOLD
        {
            (self.store.options.perf)(
                "cascade",
                &format!("{root} caused {children} nested dispatches"),
                &json!({ "rootEvent": root, "childCount": children }),
            );
        }
    }
}
