use serde::{Deserialize, Serialize};
use specta::Type;

use crate::slices::snooze::{self, SnoozeEvent, SnoozeState};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub snooze: SnoozeState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum StateEvent {
    Snooze(SnoozeEvent),
}

pub fn root_reduce(state: &mut AppState, event: StateEvent, _now: i64) {
    match event {
        StateEvent::Snooze(event) => snooze::reduce(&mut state.snooze, event),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn routes_a_ts_snooze_event_to_the_snooze_slice() {
        let event: StateEvent = serde_json::from_value(json!({
            "type": "snooze/set",
            "payload": { "path": "/a", "snoozedAt": 1, "wakeAt": 2.5 }
        }))
        .unwrap();
        let mut state = AppState::default();

        root_reduce(&mut state, event, 0);

        assert_eq!(
            serde_json::to_value(&state).unwrap(),
            json!({ "snooze": { "byPath": { "/a": { "path": "/a", "snoozedAt": 1, "wakeAt": 2.5 } } } })
        );
    }

    #[test]
    fn root_event_serializes_without_a_wrapper() {
        let event = StateEvent::Snooze(SnoozeEvent::Clear("/a".to_string()));
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "type": "snooze/clear", "payload": "/a" })
        );
    }

    #[test]
    fn unknown_event_type_is_rejected() {
        let parsed =
            serde_json::from_value::<StateEvent>(json!({ "type": "snooze/nope", "payload": "/a" }));
        assert!(parsed.is_err());
    }
}
