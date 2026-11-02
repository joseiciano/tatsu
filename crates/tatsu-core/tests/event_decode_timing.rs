use std::path::Path;
use std::time::Instant;

use serde_json::Value;
use tatsu_core::{Store, StoreOptions};
use tatsu_state::{AppState, StateEvent};

const PASSES: usize = 200;

fn fixture_events() -> Vec<String> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire");
    let mut paths: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    let mut events = Vec::new();
    for path in paths {
        let Ok(Value::Array(cases)) =
            serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap())
        else {
            continue;
        };
        for case in cases {
            if let Some(event) = case.get("event") {
                events.push(serde_json::to_string(event).unwrap());
            }
        }
    }
    events
}

#[test]
fn state_event_decode_vs_dispatch() {
    let texts = fixture_events();
    assert!(!texts.is_empty());
    let events: Vec<StateEvent> = texts
        .iter()
        .map(|text| serde_json::from_str(text).unwrap_or_else(|err| panic!("{text}: {err}")))
        .collect();

    let start = Instant::now();
    for _ in 0..PASSES {
        for text in &texts {
            std::hint::black_box(serde_json::from_str::<StateEvent>(text).unwrap());
        }
    }
    let decode = start.elapsed();

    let store = Store::with_options(
        AppState::default(),
        StoreOptions {
            perf: Box::new(|_, _, _| {}),
            ..StoreOptions::default()
        },
    );
    let start = Instant::now();
    for _ in 0..PASSES {
        for event in &events {
            store.dispatch(event.clone());
        }
    }
    let dispatch = start.elapsed();

    let n = (PASSES * events.len()) as f64;
    println!(
        "events={} passes={PASSES} decode={:.3}us/event dispatch={:.3}us/event (incl. one clone in the loop and one in dispatch)",
        events.len(),
        decode.as_secs_f64() * 1e6 / n,
        dispatch.as_secs_f64() * 1e6 / n,
    );
}
