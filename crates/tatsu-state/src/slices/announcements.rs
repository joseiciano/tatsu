use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    pub id: String,
    pub title: String,
    pub href: String,
    pub published_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AnnouncementsState {
    pub items: Vec<Announcement>,
    #[serde(serialize_with = "crate::wire::number::option::serialize")]
    #[specta(type = Option<f64>)]
    pub last_fetched: Option<f64>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnnouncementsLoaded {
    pub items: Vec<Announcement>,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub fetched_at: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum AnnouncementsEvent {
    #[serde(rename = "announcements/loaded")]
    Loaded(AnnouncementsLoaded),
    #[serde(rename = "announcements/fetchFailed")]
    FetchFailed(String),
}

pub fn reduce(state: &mut AnnouncementsState, event: AnnouncementsEvent) {
    match event {
        AnnouncementsEvent::Loaded(loaded) => {
            *state = AnnouncementsState {
                items: loaded.items,
                last_fetched: Some(loaded.fetched_at),
                last_error: None,
            };
        }
        AnnouncementsEvent::FetchFailed(error) => state.last_error = Some(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initial_state_has_no_items_fetch_or_error() {
        assert_eq!(
            serde_json::to_value(AnnouncementsState::default()).unwrap(),
            json!({ "items": [], "lastFetched": null, "lastError": null })
        );
    }

    #[test]
    fn whole_fetched_at_serializes_as_an_integer() {
        let mut state = AnnouncementsState::default();
        reduce(
            &mut state,
            AnnouncementsEvent::Loaded(AnnouncementsLoaded {
                items: vec![],
                fetched_at: 1_717_000_000_000.0,
            }),
        );
        assert!(
            serde_json::to_string(&state)
                .unwrap()
                .contains("\"lastFetched\":1717000000000,")
        );
    }
}
