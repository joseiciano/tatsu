use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::wire::Patch;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabState {
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabStatePatch {
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub url: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub title: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub can_go_back: Patch<bool>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub can_go_forward: Patch<bool>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub loading: Patch<bool>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub error: Patch<String>,
}

impl BrowserTabStatePatch {
    pub fn apply(self, target: &mut BrowserTabState) {
        self.url.apply_to_required(&mut target.url);
        self.title.apply_to_required(&mut target.title);
        self.can_go_back.apply_to_required(&mut target.can_go_back);
        self.can_go_forward
            .apply_to_required(&mut target.can_go_forward);
        self.loading.apply_to_required(&mut target.loading);
        self.error.apply_to(&mut target.error);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct BrowserState {
    pub by_tab: IndexMap<String, BrowserTabState>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTabStateChange {
    pub tab_id: String,
    pub state: BrowserTabStatePatch,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum BrowserEvent {
    #[serde(rename = "browser/tabStateChanged")]
    TabStateChanged(BrowserTabStateChange),
    #[serde(rename = "browser/tabRemoved")]
    TabRemoved(String),
}

pub fn reduce(state: &mut BrowserState, event: BrowserEvent) {
    match event {
        BrowserEvent::TabStateChanged(change) => {
            change
                .state
                .apply(state.by_tab.entry(change.tab_id).or_default());
        }
        BrowserEvent::TabRemoved(tab_id) => {
            state.by_tab.shift_remove(&tab_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn changed(tab_id: &str, patch: serde_json::Value) -> BrowserEvent {
        serde_json::from_value(json!({
            "type": "browser/tabStateChanged",
            "payload": { "tabId": tab_id, "state": patch }
        }))
        .unwrap()
    }

    fn keys(state: &BrowserState) -> Vec<&str> {
        state.by_tab.keys().map(String::as_str).collect()
    }

    #[test]
    fn initial_state_serializes_to_empty_by_tab() {
        assert_eq!(
            serde_json::to_value(BrowserState::default()).unwrap(),
            json!({ "byTab": {} })
        );
    }

    #[test]
    fn a_new_tab_starts_from_the_ts_initial_tab_state() {
        let mut state = BrowserState::default();
        reduce(&mut state, changed("b1", json!({ "url": "x" })));
        assert_eq!(
            serde_json::to_value(&state.by_tab["b1"]).unwrap(),
            json!({ "url": "x", "title": "", "canGoBack": false, "canGoForward": false, "loading": false })
        );
    }

    #[test]
    fn a_change_to_an_existing_tab_keeps_its_position() {
        let mut state = BrowserState::default();
        for tab in ["b1", "b2", "b3"] {
            reduce(&mut state, changed(tab, json!({})));
        }
        reduce(&mut state, changed("b1", json!({ "title": "T" })));
        assert_eq!(keys(&state), ["b1", "b2", "b3"]);
    }

    #[test]
    fn tab_removed_keeps_the_order_of_the_rest() {
        let mut state = BrowserState::default();
        for tab in ["b1", "b2", "b3"] {
            reduce(&mut state, changed(tab, json!({})));
        }
        reduce(&mut state, BrowserEvent::TabRemoved("b1".to_string()));
        assert_eq!(keys(&state), ["b2", "b3"]);
    }
}
