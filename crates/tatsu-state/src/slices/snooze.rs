use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SnoozeEntry {
    pub path: String,
    pub snoozed_at: f64,
    pub wake_at: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct SnoozeState {
    pub by_path: IndexMap<String, SnoozeEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum SnoozeEvent {
    #[serde(rename = "snooze/set")]
    Set(SnoozeEntry),
    #[serde(rename = "snooze/clear")]
    Clear(String),
}

pub fn reduce(state: &mut SnoozeState, event: SnoozeEvent) {
    match event {
        SnoozeEvent::Set(entry) => {
            state.by_path.insert(entry.path.clone(), entry);
        }
        SnoozeEvent::Clear(path) => {
            state.by_path.shift_remove(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(path: &str, wake_at: f64) -> SnoozeEntry {
        SnoozeEntry {
            path: path.to_string(),
            snoozed_at: 100.0,
            wake_at,
        }
    }

    fn reduced(events: Vec<SnoozeEvent>) -> SnoozeState {
        let mut state = SnoozeState::default();
        for event in events {
            reduce(&mut state, event);
        }
        state
    }

    fn keys(state: &SnoozeState) -> Vec<&str> {
        state.by_path.keys().map(String::as_str).collect()
    }

    #[test]
    fn initial_state_serializes_to_empty_by_path() {
        assert_eq!(
            serde_json::to_value(SnoozeState::default()).unwrap(),
            json!({ "byPath": {} })
        );
    }

    #[test]
    fn events_use_the_ts_type_and_payload_shape() {
        let set = json!({
            "type": "snooze/set",
            "payload": { "path": "/a", "snoozedAt": 100.5, "wakeAt": 1000.25 }
        });
        let clear = json!({ "type": "snooze/clear", "payload": "/a" });

        let parsed_set: SnoozeEvent = serde_json::from_value(set.clone()).unwrap();
        let parsed_clear: SnoozeEvent = serde_json::from_value(clear.clone()).unwrap();

        assert_eq!(serde_json::to_value(&parsed_set).unwrap(), set);
        assert_eq!(serde_json::to_value(&parsed_clear).unwrap(), clear);
    }

    #[test]
    fn set_adds_an_entry() {
        let state = reduced(vec![SnoozeEvent::Set(entry("/a", 1000.0))]);
        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({ "byPath": { "/a": { "path": "/a", "snoozedAt": 100.0, "wakeAt": 1000.0 } } })
        );
    }

    #[test]
    fn set_replaces_an_existing_entry_in_place() {
        let state = reduced(vec![
            SnoozeEvent::Set(entry("/a", 1000.0)),
            SnoozeEvent::Set(entry("/b", 1000.0)),
            SnoozeEvent::Set(entry("/a", 2000.0)),
        ]);
        assert_eq!(keys(&state), ["/a", "/b"]);
        assert_eq!(state.by_path["/a"].wake_at, 2000.0);
    }

    #[test]
    fn set_keeps_max_safe_integer_wake_exact() {
        let max_wake = 9_007_199_254_740_991.0;
        let state = reduced(vec![SnoozeEvent::Set(entry("/a", max_wake))]);
        let text = serde_json::to_string(&state).unwrap();
        let round_trip: SnoozeState = serde_json::from_str(&text).unwrap();
        assert_eq!(round_trip.by_path["/a"].wake_at, max_wake);
    }

    #[test]
    fn clear_removes_the_entry_and_keeps_the_order_of_the_rest() {
        let state = reduced(vec![
            SnoozeEvent::Set(entry("/a", 1000.0)),
            SnoozeEvent::Set(entry("/b", 1000.0)),
            SnoozeEvent::Set(entry("/c", 1000.0)),
            SnoozeEvent::Clear("/a".to_string()),
        ]);
        assert_eq!(keys(&state), ["/b", "/c"]);
    }

    #[test]
    fn clear_of_an_unknown_path_leaves_the_state_unchanged() {
        let before = reduced(vec![SnoozeEvent::Set(entry("/a", 1000.0))]);
        let mut after = before.clone();
        reduce(&mut after, SnoozeEvent::Clear("/missing".to_string()));
        assert_eq!(after, before);
    }

    #[test]
    fn missing_by_path_deserializes_to_the_initial_state() {
        let state: SnoozeState = serde_json::from_value(json!({ "extra": 1 })).unwrap();
        assert_eq!(state, SnoozeState::default());
    }
}
