#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::lifecycle::Clock;
use crate::logs;
use crate::themes::node_message;

pub const ACTIVITY_FILENAME: &str = "activity.json";
pub const SAVE_DELAY: Duration = Duration::from_millis(1000);
pub const MAX_EVENTS_PER_WORKTREE: usize = 5000;
const CATEGORY: &str = "activity";
const RECORD_FIELDS: [&str; 7] = [
    "branch",
    "repoRoot",
    "createdAt",
    "removedAt",
    "diffStats",
    "prNumber",
    "prState",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityState {
    Processing,
    Waiting,
    NeedsApproval,
    Idle,
    Merged,
}

impl ActivityState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Processing => "processing",
            Self::Waiting => "waiting",
            Self::NeedsApproval => "needs-approval",
            Self::Idle => "idle",
            Self::Merged => "merged",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrState {
    Open,
    Draft,
    Merged,
    Closed,
}

impl PrState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Draft => "draft",
            Self::Merged => "merged",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct DiffStats {
    pub added: f64,
    pub removed: f64,
    pub files: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeInfo {
    pub diff_stats: Option<DiffStats>,
    pub pr_number: Option<f64>,
    pub pr_state: Option<PrState>,
}

// A slot holding `None` is a key JS keeps with the value `undefined`: it is
// not written, but a later assignment fills it in place instead of appending.
#[derive(Clone, Debug, PartialEq)]
struct Record(Vec<(&'static str, Option<Value>)>);

impl Record {
    fn empty() -> Self {
        Self(vec![("events", Some(Value::Array(Vec::new())))])
    }

    fn get(&self, key: &str) -> Option<&Value> {
        self.0
            .iter()
            .find(|(k, _)| *k == key)
            .and_then(|(_, v)| v.as_ref())
    }

    fn set(&mut self, key: &'static str, value: Value) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some((_, slot)) => *slot = Some(value),
            None => self.0.push((key, Some(value))),
        }
    }

    fn events(&self) -> &[Value] {
        match self.get("events") {
            Some(Value::Array(events)) => events,
            _ => &[],
        }
    }

    fn push_event(&mut self, t: Value, s: &str) {
        let mut event = Map::new();
        event.insert("t".into(), t);
        event.insert("s".into(), Value::String(s.into()));
        if let Some((_, Some(Value::Array(events)))) =
            self.0.iter_mut().find(|(k, _)| *k == "events")
        {
            events.push(Value::Object(event));
            if events.len() > MAX_EVENTS_PER_WORKTREE {
                events.drain(..events.len() - MAX_EVENTS_PER_WORKTREE);
            }
        }
    }

    fn last_state_is(&self, states: &[&str]) -> bool {
        self.events()
            .last()
            .and_then(|last| last.get("s"))
            .and_then(Value::as_str)
            .is_some_and(|s| states.contains(&s))
    }

    fn has_last(&self) -> bool {
        self.events().last().is_some_and(tatsu_js::truthy)
    }

    fn to_value(&self) -> Value {
        Value::Object(
            self.0
                .iter()
                .filter_map(|(k, v)| v.clone().map(|v| ((*k).to_string(), v)))
                .collect(),
        )
    }
}

type Log = Vec<(String, Record)>;

fn migrate(raw: &Value) -> Log {
    let entries: Vec<(String, &Value)> = match raw {
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => return Vec::new(),
    };
    let mut out: Log = Vec::new();
    for (path, value) in entries {
        let record = match value {
            Value::Array(events) => {
                let created_at = events
                    .first()
                    .and_then(Value::as_object)
                    .and_then(|e| e.get("t"))
                    .cloned();
                Record(vec![
                    ("events", Some(value.clone())),
                    ("createdAt", created_at),
                ])
            }
            Value::Object(rec) => {
                let mut slots: Vec<(&'static str, Option<Value>)> = RECORD_FIELDS
                    .iter()
                    .map(|key| (*key, rec.get(*key).cloned()))
                    .collect();
                let events = match rec.get("events") {
                    Some(Value::Array(events)) => events.clone(),
                    _ => Vec::new(),
                };
                slots.push(("events", Some(Value::Array(events))));
                Record(slots)
            }
            _ => continue,
        };
        out.push((path, record));
    }
    out
}

fn read_log(path: &Path) -> Log {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| tatsu_js::parse_lenient(&text).ok())
        .map(|raw| migrate(&raw))
        .unwrap_or_default()
}

fn log_value(log: &Log) -> Value {
    Value::Object(
        log.iter()
            .map(|(path, record)| (path.clone(), record.to_value()))
            .collect(),
    )
}

fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

#[derive(Clone)]
pub struct ActivityLog {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    runtime: Handle,
    clock: Clock,
    state: Mutex<State>,
    write_lock: Mutex<()>,
    saves: watch::Sender<u64>,
}

#[derive(Default)]
struct State {
    cache: Option<Log>,
    timer: Option<JoinHandle<()>>,
    writing: bool,
}

impl State {
    fn log(&mut self, path: &Path) -> &mut Log {
        self.cache.get_or_insert_with(|| read_log(path))
    }
}

impl ActivityLog {
    pub fn new(path: impl Into<PathBuf>, runtime: Handle, clock: Clock) -> Self {
        Self {
            inner: Arc::new(Inner {
                path: path.into(),
                runtime,
                clock,
                state: Mutex::new(State::default()),
                write_lock: Mutex::new(()),
                saves: watch::channel(0).0,
            }),
        }
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    pub fn record(&self, worktree_path: &str, state: ActivityState) {
        let mut guard = self.inner.state.lock();
        let record = self.get_or_create(&mut guard, worktree_path);
        if record.last_state_is(&[state.as_str()]) {
            return;
        }
        let now = Value::from((self.inner.clock)());
        if !record.get("createdAt").is_some_and(tatsu_js::truthy) {
            record.set("createdAt", now.clone());
        }
        record.push_event(now, state.as_str());
        self.schedule_save(&mut guard);
    }

    pub fn touch_meta(&self, worktree_path: &str, branch: Option<&str>, repo_root: Option<&str>) {
        let mut guard = self.inner.state.lock();
        let record = self.get_or_create(&mut guard, worktree_path);
        let mut changed = false;
        for (key, value) in [("branch", branch), ("repoRoot", repo_root)] {
            if let Some(value) = value.filter(|v| !v.is_empty())
                && record.get(key).and_then(Value::as_str) != Some(value)
            {
                record.set(key, Value::String(value.into()));
                changed = true;
            }
        }
        if changed {
            self.schedule_save(&mut guard);
        }
    }

    pub fn finalize(&self, worktree_path: &str, info: &FinalizeInfo) {
        let mut guard = self.inner.state.lock();
        let log = guard.log(&self.inner.path);
        let Some((_, record)) = log.iter_mut().find(|(p, _)| p == worktree_path) else {
            return;
        };
        let removed_at = Value::from((self.inner.clock)());
        record.set("removedAt", removed_at.clone());
        if let Some(stats) = info.diff_stats {
            let mut map = Map::new();
            map.insert("added".into(), number(stats.added));
            map.insert("removed".into(), number(stats.removed));
            map.insert("files".into(), number(stats.files));
            record.set("diffStats", Value::Object(map));
        }
        if let Some(pr_number) = info.pr_number {
            record.set("prNumber", number(pr_number));
        }
        if let Some(pr_state) = info.pr_state {
            record.set("prState", Value::String(pr_state.as_str().into()));
        }
        let terminal = match info.pr_state {
            Some(PrState::Merged | PrState::Closed) => ActivityState::Merged,
            _ => ActivityState::Idle,
        };
        if !record.last_state_is(&[terminal.as_str()]) {
            record.push_event(removed_at, terminal.as_str());
        }
        self.schedule_save(&mut guard);
    }

    pub fn get(&self) -> Value {
        let mut guard = self.inner.state.lock();
        log_value(guard.log(&self.inner.path))
    }

    pub fn clear(&self, worktree_path: &str) {
        let mut guard = self.inner.state.lock();
        guard
            .log(&self.inner.path)
            .retain(|(p, _)| p != worktree_path);
        self.schedule_save(&mut guard);
    }

    pub fn clear_all(&self) {
        let mut guard = self.inner.state.lock();
        guard.cache = Some(Vec::new());
        self.schedule_save(&mut guard);
    }

    pub fn seal_all(&self) {
        let _write = self.inner.write_lock.lock();
        let text = {
            let mut guard = self.inner.state.lock();
            let mut changed = false;
            for (_, record) in guard.log(&self.inner.path).iter_mut() {
                if record.get("removedAt").is_some_and(tatsu_js::truthy) {
                    continue;
                }
                if record.has_last() && !record.last_state_is(&["idle", "merged"]) {
                    record.push_event(Value::from((self.inner.clock)()), "idle");
                    changed = true;
                }
            }
            if !changed {
                return;
            }
            if let Some(timer) = guard.timer.take() {
                timer.abort();
            }
            log_value(guard.log(&self.inner.path))
        };
        self.inner
            .write(&tatsu_js::stringify(&text), "seal save failed");
        self.inner.saves.send_modify(|n| *n += 1);
    }

    pub fn saves(&self) -> watch::Receiver<u64> {
        self.inner.saves.subscribe()
    }

    pub async fn settled(&self) {
        let mut saves = self.saves();
        loop {
            {
                let state = self.inner.state.lock();
                if state.timer.is_none() && !state.writing {
                    return;
                }
            }
            if saves.changed().await.is_err() {
                return;
            }
        }
    }

    fn get_or_create<'a>(&self, state: &'a mut State, worktree_path: &str) -> &'a mut Record {
        let log = state.log(&self.inner.path);
        let index = match log.iter().position(|(p, _)| p == worktree_path) {
            Some(index) => index,
            None => {
                log.push((worktree_path.to_string(), Record::empty()));
                log.len() - 1
            }
        };
        &mut log[index].1
    }

    fn schedule_save(&self, state: &mut State) {
        if state.timer.is_some() {
            return;
        }
        let inner = Arc::clone(&self.inner);
        state.timer = Some(self.inner.runtime.spawn(async move {
            tokio::time::sleep(SAVE_DELAY).await;
            let runtime = inner.runtime.clone();
            let _ = runtime.spawn_blocking(move || inner.timer_write()).await;
        }));
    }
}

impl Inner {
    fn timer_write(&self) {
        let _write = self.write_lock.lock();
        let snapshot = {
            let mut state = self.state.lock();
            state.timer = None;
            let Some(snapshot) = state.cache.as_ref().map(log_value) else {
                return;
            };
            state.writing = true;
            snapshot
        };
        self.write(&tatsu_js::stringify(&snapshot), "save failed");
        self.state.lock().writing = false;
        self.saves.send_modify(|n| *n += 1);
    }

    fn write(&self, text: &str, failure: &str) {
        if let Err(err) = std::fs::write(&self.path, text) {
            logs::log_with(CATEGORY, failure, &node_message(&err, "open", &self.path));
        }
    }
}
