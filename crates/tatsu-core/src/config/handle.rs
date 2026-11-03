use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use super::ConfigDoc;
use super::save::write_atomic;
use super::view::{ConfigView, decode};

pub const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct ConfigHandle {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    runtime: Handle,
    state: Mutex<State>,
    write_lock: Mutex<()>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

struct State {
    doc: ConfigDoc,
    dirty: bool,
}

impl ConfigHandle {
    pub fn new(path: impl Into<PathBuf>, doc: ConfigDoc, runtime: Handle) -> Self {
        Self {
            inner: Arc::new(Inner {
                path: path.into(),
                runtime,
                state: Mutex::new(State { doc, dirty: false }),
                write_lock: Mutex::new(()),
                timer: Mutex::new(None),
            }),
        }
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    pub fn get<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        decode(self.inner.state.lock().doc.get(key)?)
    }

    pub fn get_raw(&self, key: &str) -> Option<Value> {
        self.inner.state.lock().doc.get(key).cloned()
    }

    pub fn view(&self) -> ConfigView {
        ConfigView::new(self.inner.state.lock().doc.clone())
    }

    pub fn set(&self, key: impl Into<String>, value: Value) {
        self.update(|doc| doc.set(key, value));
    }

    pub fn remove(&self, key: &str) -> Option<Value> {
        self.update(|doc| doc.remove(key))
    }

    // The closure runs under the non-reentrant doc lock, so it must not call methods on this handle.
    pub fn update<R>(&self, change: impl FnOnce(&mut ConfigDoc) -> R) -> R {
        let result = {
            let mut state = self.inner.state.lock();
            let result = change(&mut state.doc);
            state.dirty = true;
            result
        };
        self.schedule_save();
        result
    }

    pub fn flush_sync(&self) {
        if let Some(timer) = self.inner.timer.lock().take() {
            timer.abort();
        }
        self.inner.write_pending();
    }

    fn schedule_save(&self) {
        let inner = Arc::clone(&self.inner);
        let deadline = tokio::time::Instant::now() + SAVE_DEBOUNCE;
        let mut timer = self.inner.timer.lock();
        if let Some(previous) = timer.take() {
            previous.abort();
        }
        *timer = Some(self.inner.runtime.spawn(async move {
            tokio::time::sleep_until(deadline).await;
            inner.write_pending();
        }));
    }
}

impl Inner {
    fn write_pending(&self) {
        let _write = self.write_lock.lock();
        let text = {
            let mut state = self.state.lock();
            if !state.dirty {
                return;
            }
            state.dirty = false;
            state.doc.to_json()
        };
        if let Err(err) = write_atomic(&self.path, &text, |from, to| std::fs::rename(from, to)) {
            self.state.lock().dirty = true;
            let _ = writeln!(std::io::stderr(), "Failed to save config: {err}");
        }
    }
}
