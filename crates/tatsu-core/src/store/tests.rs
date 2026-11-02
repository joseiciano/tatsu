use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tatsu_state::{AppState, StateEvent};
use tempfile::TempDir;

use super::*;
use crate::logs::PerfLog;

pub(super) fn theme_dark(name: &str) -> StateEvent {
    serde_json::from_value(json!({"type": "settings/themeDarkChanged", "payload": name})).unwrap()
}

fn name_sessions(on: bool) -> StateEvent {
    serde_json::from_value(json!({"type": "settings/nameClaudeSessionsChanged", "payload": on}))
        .unwrap()
}

type Captured = Arc<Mutex<Vec<(String, String, Value)>>>;

fn capturing(timer: impl Fn() -> f64 + Send + Sync + 'static) -> (StoreOptions, Captured) {
    let captured: Captured = Arc::default();
    let sink = captured.clone();
    let options = StoreOptions {
        now_ms: Box::new(|| 1_700_000_000_000),
        timer_ms: Box::new(timer),
        perf: Box::new(move |category, message, data| {
            sink.lock()
                .unwrap()
                .push((category.into(), message.into(), data.clone()))
        }),
    };
    (options, captured)
}

fn quiet_store() -> (Arc<Store>, Captured) {
    let (options, captured) = capturing(|| 0.0);
    (
        Arc::new(Store::with_options(AppState::default(), options)),
        captured,
    )
}

fn of(captured: &Captured, category: &str) -> Vec<(String, Value)> {
    captured
        .lock()
        .unwrap()
        .iter()
        .filter(|(c, _, _)| c == category)
        .map(|(_, m, d)| (m.clone(), d.clone()))
        .collect()
}

#[test]
fn starts_at_seq_zero_with_the_initial_state() {
    let (store, _) = quiet_store();
    assert_eq!(store.seq(), 0);
    assert!(store.read(|s| *s == AppState::default()));
}

#[test]
fn applies_dispatched_events_through_the_reducer() {
    let (store, _) = quiet_store();
    store.dispatch(theme_dark("solarized"));
    assert_eq!(store.read(|s| s.settings.theme_dark.clone()), "solarized");
}

#[test]
fn seq_increments_once_per_dispatch() {
    let (store, _) = quiet_store();
    store.dispatch(theme_dark("a"));
    assert_eq!(store.seq(), 1);
    store.dispatch(theme_dark("b"));
    assert_eq!(store.seq(), 2);
    store.dispatch(name_sessions(true));
    assert_eq!(store.seq(), 3);
}

#[test]
fn accepts_a_custom_initial_state() {
    let mut initial = AppState::default();
    initial.settings.theme_dark = "preseeded".into();
    let store = Store::new(initial);
    assert_eq!(store.read(|s| s.settings.theme_dark.clone()), "preseeded");
    assert_eq!(store.seq(), 0);
}

#[test]
fn subscribers_get_the_event_and_its_seq() {
    let (store, _) = quiet_store();
    let seen = Arc::new(Mutex::new(Vec::new()));
    for _ in 0..2 {
        let seen = seen.clone();
        store.subscribe(move |event, seq| seen.lock().unwrap().push((event.clone(), seq)));
    }
    store.dispatch(theme_dark("c"));
    assert_eq!(
        *seen.lock().unwrap(),
        vec![(theme_dark("c"), 1), (theme_dark("c"), 1)]
    );
}

#[test]
fn unsubscribe_removes_the_listener() {
    let (store, _) = quiet_store();
    let calls = Arc::new(AtomicU64::new(0));
    let c = calls.clone();
    let id = store.subscribe(move |_, _| {
        c.fetch_add(1, Ordering::SeqCst);
    });
    store.unsubscribe(id);
    store.dispatch(theme_dark("e"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn fan_out_follows_js_set_iteration() {
    let (store, _) = quiet_store();
    let order = Arc::new(Mutex::new(Vec::new()));
    let late_id = Arc::new(Mutex::new(None));
    {
        let (store2, order, late_id) = (store.clone(), order.clone(), late_id.clone());
        store.subscribe(move |_, seq| {
            order.lock().unwrap().push(format!("first@{seq}"));
            if seq == 1 {
                let o = order.clone();
                store2.subscribe(move |_, seq| o.lock().unwrap().push(format!("added@{seq}")));
                if let Some(id) = late_id.lock().unwrap().take() {
                    store2.unsubscribe(id);
                }
            }
        });
    }
    let o = order.clone();
    let id = store.subscribe(move |_, seq| o.lock().unwrap().push(format!("removed@{seq}")));
    *late_id.lock().unwrap() = Some(id);

    store.dispatch(theme_dark("x"));
    store.dispatch(theme_dark("y"));

    assert_eq!(
        *order.lock().unwrap(),
        ["first@1", "added@1", "first@2", "added@2"]
    );
}

#[test]
fn nested_dispatch_is_visible_to_a_read_in_the_same_subscriber() {
    let (store, _) = quiet_store();
    let seen = Arc::new(Mutex::new(None));
    {
        let (store2, seen) = (store.clone(), seen.clone());
        store.subscribe(move |event, _| {
            if *event == theme_dark("root") {
                store2.dispatch(name_sessions(true));
                *seen.lock().unwrap() =
                    Some(store2.read(|s| (s.settings.name_claude_sessions, store2.seq())));
            }
        });
    }
    store.dispatch(theme_dark("root"));
    assert_eq!(*seen.lock().unwrap(), Some((true, 2)));
}

#[test]
fn hub_sink_runs_first_and_sees_increasing_seq_with_nested_dispatches() {
    let (store, _) = quiet_store();
    let log = Arc::new(Mutex::new(Vec::new()));
    {
        let (store2, log) = (store.clone(), log.clone());
        store.subscribe(move |event, seq| {
            log.lock().unwrap().push(format!("sub@{seq}"));
            if *event == theme_dark("root") {
                store2.dispatch(name_sessions(true));
                store2.dispatch(name_sessions(false));
            }
        });
    }
    let l = log.clone();
    store.set_hub_sink(move |_, seq| l.lock().unwrap().push(format!("hub@{seq}")));

    store.dispatch(theme_dark("root"));

    let log = log.lock().unwrap().clone();
    assert_eq!(log, ["hub@1", "sub@1", "hub@2", "sub@2", "hub@3", "sub@3"]);
}

#[test]
#[should_panic(expected = "Store::dispatch called inside Store::read")]
fn dispatch_inside_read_panics_with_a_clear_message() {
    let (store, _) = quiet_store();
    store.read(|_| store.dispatch(theme_dark("nope")));
}

#[test]
fn a_panicking_subscriber_does_not_leave_the_store_nested() {
    let (store, captured) = quiet_store();
    let armed = Arc::new(AtomicBool::new(true));
    let a = armed.clone();
    store.subscribe(move |_, _| {
        if a.swap(false, Ordering::SeqCst) {
            panic!("boom");
        }
    });
    let s = store.clone();
    let _ = std::thread::spawn(move || s.dispatch(theme_dark("x"))).join();
    cascade_with(&store, 16);
    assert_eq!(of(&captured, "cascade").len(), 1);
}

fn cascade_with(store: &Arc<Store>, nested: usize) {
    let fired = Arc::new(AtomicBool::new(false));
    let (store2, f) = (store.clone(), fired.clone());
    let id = store.subscribe(move |event, _| {
        if *event == theme_dark("root") && !f.swap(true, Ordering::SeqCst) {
            for i in 0..nested {
                store2.dispatch(name_sessions(i % 2 == 0));
            }
        }
    });
    store.dispatch(theme_dark("root"));
    store.unsubscribe(id);
}

#[test]
fn no_cascade_for_a_plain_dispatch() {
    let (store, captured) = quiet_store();
    store.dispatch(theme_dark("a"));
    assert!(of(&captured, "cascade").is_empty());
}

#[test]
fn cascade_logged_above_the_threshold_with_the_ts_line() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("perf.log");
    let log = Arc::new(Mutex::new(PerfLog::new(&path)));
    let options = StoreOptions {
        now_ms: Box::new(|| 0),
        timer_ms: Box::new(|| 0.0),
        perf: Box::new(move |c, m, d| log.lock().unwrap().log_with(c, m, d)),
    };
    let store = Arc::new(Store::with_options(AppState::default(), options));

    cascade_with(&store, 16);

    let text = std::fs::read_to_string(&path).unwrap();
    println!("{text}");
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(
        &lines[1][13..],
        r#"] [cascade] settings/themeDarkChanged caused 16 nested dispatches {"rootEvent":"settings/themeDarkChanged","childCount":16}"#
    );
}

#[test]
fn no_cascade_at_or_below_the_threshold() {
    let (store, captured) = quiet_store();
    cascade_with(&store, 10);
    cascade_with(&store, 15);
    assert!(of(&captured, "cascade").is_empty());
}

#[test]
fn separate_root_dispatches_count_separately() {
    let (store, captured) = quiet_store();
    for _ in 0..10 {
        store.dispatch(name_sessions(true));
    }
    cascade_with(&store, 8);
    assert!(of(&captured, "cascade").is_empty());
    cascade_with(&store, 16);
    assert_eq!(
        of(&captured, "cascade"),
        [(
            "settings/themeDarkChanged caused 16 nested dispatches".into(),
            json!({"rootEvent": "settings/themeDarkChanged", "childCount": 16})
        )]
    );
}

fn scripted(ticks: &[f64]) -> impl Fn() -> f64 + Send + Sync + 'static {
    let ticks = ticks.to_vec();
    let next = AtomicU64::new(0);
    move || ticks[next.fetch_add(1, Ordering::SeqCst) as usize]
}

#[test]
fn slow_dispatch_writes_the_ts_store_slow_line() {
    let (options, captured) = capturing(scripted(&[100.0, 101.25, 106.25]));
    let store = Store::with_options(AppState::default(), options);

    store.dispatch(theme_dark("slow"));

    assert_eq!(
        of(&captured, "store-slow"),
        [(
            "settings/themeDarkChanged reducer=1.3ms total=6.3ms".into(),
            json!({
                "type": "settings/themeDarkChanged",
                "reducerMs": 1.25,
                "listenerMs": 5.0,
                "totalMs": 6.25
            })
        )]
    );
    let data = &of(&captured, "store-slow")[0].1;
    assert_eq!(
        tatsu_js::stringify(data),
        r#"{"type":"settings/themeDarkChanged","reducerMs":1.25,"listenerMs":5,"totalMs":6.25}"#
    );
}

#[test]
fn store_slow_rounds_like_to_fixed() {
    let (options, captured) = capturing(scripted(&[0.0, 0.125, 5.0]));
    let store = Store::with_options(AppState::default(), options);
    store.dispatch(theme_dark("x"));
    let (message, data) = of(&captured, "store-slow").remove(0);
    assert_eq!(
        message,
        "settings/themeDarkChanged reducer=0.1ms total=5.0ms"
    );
    assert_eq!(
        tatsu_js::stringify(&data),
        r#"{"type":"settings/themeDarkChanged","reducerMs":0.13,"listenerMs":4.88,"totalMs":5}"#
    );
}

#[test]
fn dispatch_under_the_slow_threshold_writes_nothing() {
    let (options, captured) = capturing(scripted(&[0.0, 1.0, 4.999]));
    let store = Store::with_options(AppState::default(), options);
    store.dispatch(theme_dark("fast"));
    assert!(captured.lock().unwrap().is_empty());
}

#[test]
fn snapshot_with_hands_the_stripped_wire_snapshot_and_seq() {
    let (store, _) = quiet_store();
    store.dispatch(theme_dark("snap"));
    let (json, seq) = store.snapshot_with(|json, seq| (json.to_string(), seq));
    assert_eq!(seq, 1);
    let parsed: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["seq"], 1);
    assert_eq!(parsed["state"]["settings"]["themeDark"], "snap");
}
