use serde::{Deserialize, Serialize};
use specta::Type;

use crate::slices::{
    announcements::{self, AnnouncementsEvent, AnnouncementsState},
    browser::{self, BrowserEvent, BrowserState},
    hooks::{self, HooksEvent, HooksState},
    onboarding::{self, OnboardingEvent, OnboardingState},
    runtimes::{self, RuntimesEvent, RuntimesState},
    scratchpad::{self, ScratchpadEvent, ScratchpadState},
    snooze::{self, SnoozeEvent, SnoozeState},
    updater::{self, UpdaterEvent, UpdaterState},
};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub onboarding: OnboardingState,
    pub hooks: HooksState,
    pub updater: UpdaterState,
    pub browser: BrowserState,
    pub snooze: SnoozeState,
    pub runtimes: RuntimesState,
    pub announcements: AnnouncementsState,
    pub scratchpad: ScratchpadState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum StateEvent {
    Onboarding(OnboardingEvent),
    Hooks(HooksEvent),
    Updater(UpdaterEvent),
    Browser(BrowserEvent),
    Snooze(SnoozeEvent),
    Runtimes(RuntimesEvent),
    Announcements(AnnouncementsEvent),
    Scratchpad(ScratchpadEvent),
}

pub fn root_reduce(state: &mut AppState, event: StateEvent, _now: i64) {
    match event {
        StateEvent::Onboarding(event) => onboarding::reduce(&mut state.onboarding, event),
        StateEvent::Hooks(event) => hooks::reduce(&mut state.hooks, event),
        StateEvent::Updater(event) => updater::reduce(&mut state.updater, event),
        StateEvent::Browser(event) => browser::reduce(&mut state.browser, event),
        StateEvent::Snooze(event) => snooze::reduce(&mut state.snooze, event),
        StateEvent::Runtimes(event) => runtimes::reduce(&mut state.runtimes, event),
        StateEvent::Announcements(event) => announcements::reduce(&mut state.announcements, event),
        StateEvent::Scratchpad(event) => scratchpad::reduce(&mut state.scratchpad, event),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn non_default_state() -> AppState {
        serde_json::from_value(json!({
            "onboarding": { "quest": "finale" },
            "hooks": { "consent": "accepted" },
            "updater": { "status": { "state": "checking" } },
            "browser": { "byTab": { "b1": { "url": "x", "title": "X", "canGoBack": true, "canGoForward": false, "loading": false } } },
            "snooze": { "byPath": { "/a": { "path": "/a", "snoozedAt": 1, "wakeAt": 2 } } },
            "runtimes": { "byAgent": { "codex": { "state": "bundled" } } },
            "announcements": { "items": [], "lastFetched": 1, "lastError": "old" },
            "scratchpad": { "byWorktreePath": { "/a": "note" } }
        }))
        .unwrap()
    }

    #[test]
    fn each_event_changes_only_its_own_slice() {
        let cases = [
            (
                "onboarding",
                json!({ "type": "onboarding/questChanged", "payload": "done" }),
            ),
            (
                "hooks",
                json!({ "type": "hooks/consentChanged", "payload": "declined" }),
            ),
            (
                "updater",
                json!({ "type": "updater/statusChanged", "payload": { "state": "not-available" } }),
            ),
            (
                "browser",
                json!({ "type": "browser/tabStateChanged", "payload": { "tabId": "b2", "state": {} } }),
            ),
            (
                "browser",
                json!({ "type": "browser/tabRemoved", "payload": "b1" }),
            ),
            (
                "snooze",
                json!({ "type": "snooze/set", "payload": { "path": "/b", "snoozedAt": 1, "wakeAt": 2.5 } }),
            ),
            ("snooze", json!({ "type": "snooze/clear", "payload": "/a" })),
            (
                "runtimes",
                json!({ "type": "runtimes/statusChanged", "payload": { "agentKind": "codex", "status": { "state": "ready", "version": "1" } } }),
            ),
            (
                "announcements",
                json!({ "type": "announcements/loaded", "payload": { "items": [], "fetchedAt": 2 } }),
            ),
            (
                "announcements",
                json!({ "type": "announcements/fetchFailed", "payload": "new" }),
            ),
            (
                "scratchpad",
                json!({ "type": "scratchpad/loaded", "payload": { "/b": "other" } }),
            ),
            (
                "scratchpad",
                json!({ "type": "scratchpad/textChanged", "payload": { "worktreePath": "/a", "text": "edited" } }),
            ),
            (
                "scratchpad",
                json!({ "type": "scratchpad/worktreeRemoved", "payload": "/a" }),
            ),
        ];
        let before = serde_json::to_value(non_default_state()).unwrap();

        for (slice, event) in cases {
            let mut state = non_default_state();
            root_reduce(
                &mut state,
                serde_json::from_value(event.clone()).unwrap(),
                0,
            );
            let after = serde_json::to_value(&state).unwrap();

            let before_slices = before.as_object().unwrap();
            for (key, value) in after.as_object().unwrap() {
                if key == slice {
                    assert_ne!(*value, before_slices[key], "{event} did not change {slice}");
                } else {
                    assert_eq!(*value, before_slices[key], "{event} changed {key}");
                }
            }
        }
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
