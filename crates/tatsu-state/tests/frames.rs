use std::{fs, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tatsu_state::wire::frames::{ClientFrame, ServerFrame};

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire")
}

fn read_cases(name: &str) -> Vec<Map<String, Value>> {
    let text = fs::read_to_string(fixtures_dir().join(name)).expect("read fixture");
    serde_json::from_str(&text).expect("parse fixture")
}

fn round_trip<T: Serialize + for<'de> Deserialize<'de>>(frame: &Value) -> Result<(), String> {
    let parsed: T = serde_json::from_value(frame.clone()).map_err(|e| e.to_string())?;
    let again = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
    if &again == frame {
        Ok(())
    } else {
        Err(format!("expected: {frame:#}\nactual: {again:#}"))
    }
}

fn ts_recorded_snapshots() -> Vec<Value> {
    read_cases("root.json")
        .into_iter()
        .filter(|case| case["kind"] == "strip")
        .map(|case| case["after"].clone())
        .collect()
}

fn ts_fixture_events() -> Vec<Value> {
    let mut paths: Vec<PathBuf> = fs::read_dir(fixtures_dir())
        .expect("read fixtures/wire")
        .map(|entry| entry.expect("fixture entry").path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            name.ends_with(".json")
                && name != "root.json"
                && name != "channels.json"
                && !name.starts_with("rust-")
        })
        .collect();
    paths.sort();
    paths
        .iter()
        .flat_map(|path| {
            let text = fs::read_to_string(path).expect("read fixture");
            let cases: Vec<Map<String, Value>> = serde_json::from_str(&text).expect("parse");
            cases
                .into_iter()
                .filter_map(|case| case.get("event").cloned())
        })
        .collect()
}

#[test]
fn every_ts_fixture_event_round_trips_inside_a_state_frame() {
    let events = ts_fixture_events();
    assert!(events.len() > 100, "only {} fixture events", events.len());
    let failures: Vec<String> = events
        .into_iter()
        .enumerate()
        .filter_map(|(seq, event)| {
            let frame = json!({ "t": "state", "event": event, "seq": seq });
            round_trip::<ServerFrame>(&frame).err()
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn snapres_frames_round_trip_with_ts_recorded_snapshots() {
    let snapshots = ts_recorded_snapshots();
    assert!(!snapshots.is_empty());
    for snapshot in snapshots {
        let frame = json!({ "t": "snapres", "id": "1", "ok": true, "snapshot": snapshot });
        round_trip::<ServerFrame>(&frame).unwrap();
    }
    round_trip::<ServerFrame>(&json!({ "t": "snapres", "id": "1", "ok": false, "error": "nope" }))
        .unwrap();
}

#[test]
fn res_and_sig_frames_round_trip_with_raw_json_payloads() {
    for frame in [
        json!({ "t": "res", "id": "2", "ok": true, "value": null }),
        json!({ "t": "res", "id": "2", "ok": true, "value": { "nested": [1, "a", true] } }),
        json!({ "t": "res", "id": "2", "ok": false, "error": "nope" }),
        json!({ "t": "sig", "name": "terminal:data", "args": ["x", 1.5, { "a": [] }] }),
        json!({ "t": "sig", "name": "noop", "args": [] }),
    ] {
        round_trip::<ServerFrame>(&frame).unwrap();
    }
}

#[test]
fn every_client_frame_variant_round_trips() {
    for frame in [
        json!({ "t": "snapreq", "id": "1" }),
        json!({ "t": "req", "id": "2", "name": "settings:setTheme", "args": ["dark"] }),
        json!({ "t": "req", "id": "3", "name": "app:ping", "args": [] }),
        json!({ "t": "send", "name": "pty:write", "args": ["t1", "ls\n"] }),
    ] {
        round_trip::<ClientFrame>(&frame).unwrap();
    }
}

#[test]
fn result_frames_mixing_ok_and_error_shapes_are_rejected() {
    for frame in [
        json!({ "t": "res", "id": "2", "ok": true, "error": "nope" }),
        json!({ "t": "res", "id": "2", "ok": false, "value": 1 }),
        json!({ "t": "snapres", "id": "1", "ok": false, "snapshot": { "seq": 0, "state": {} } }),
    ] {
        assert!(
            serde_json::from_value::<ServerFrame>(frame.clone()).is_err(),
            "{frame}"
        );
    }
}

#[test]
fn a_snapres_frame_whose_snapshot_is_not_a_state_snapshot_is_rejected() {
    let frame = json!({ "t": "snapres", "id": "1", "ok": true, "snapshot": 5 });
    assert!(serde_json::from_value::<ServerFrame>(frame).is_err());
}

#[test]
fn unknown_frame_tags_and_state_events_are_rejected() {
    for frame in [
        json!({ "t": "bogus", "id": "1" }),
        json!({ "t": "state", "event": { "type": "nope/x", "payload": 1 }, "seq": 0 }),
    ] {
        assert!(
            serde_json::from_value::<ServerFrame>(frame.clone()).is_err(),
            "{frame}"
        );
    }
    assert!(serde_json::from_value::<ClientFrame>(json!({ "t": "state", "id": "1" })).is_err());
}
