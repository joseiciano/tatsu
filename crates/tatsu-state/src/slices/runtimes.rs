use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum DownloadableRuntime {
    Opencode,
    Codex,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeStatus {
    Bundled,
    Ready {
        version: String,
    },
    Missing {
        version: String,
        size_bytes: Option<u64>,
    },
    Downloading {
        version: String,
        received_bytes: u64,
        total_bytes: Option<u64>,
    },
    Error {
        version: String,
        error: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct RuntimesState {
    pub by_agent: IndexMap<DownloadableRuntime, RuntimeStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatusChange {
    pub agent_kind: DownloadableRuntime,
    pub status: RuntimeStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum RuntimesEvent {
    #[serde(rename = "runtimes/statusChanged")]
    StatusChanged(RuntimeStatusChange),
}

pub fn reduce(state: &mut RuntimesState, event: RuntimesEvent) {
    match event {
        RuntimesEvent::StatusChanged(change) => {
            state.by_agent.insert(change.agent_kind, change.status);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn status_changed(agent_kind: DownloadableRuntime, version: &str) -> RuntimesEvent {
        RuntimesEvent::StatusChanged(RuntimeStatusChange {
            agent_kind,
            status: RuntimeStatus::Ready {
                version: version.to_string(),
            },
        })
    }

    #[test]
    fn initial_state_serializes_to_empty_by_agent() {
        assert_eq!(
            serde_json::to_value(RuntimesState::default()).unwrap(),
            json!({ "byAgent": {} })
        );
    }

    #[test]
    fn status_changed_replaces_an_entry_in_place() {
        let mut state = RuntimesState::default();
        reduce(&mut state, status_changed(DownloadableRuntime::Codex, "1"));
        reduce(
            &mut state,
            status_changed(DownloadableRuntime::Opencode, "1"),
        );
        reduce(&mut state, status_changed(DownloadableRuntime::Codex, "2"));
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"byAgent":{"codex":{"state":"ready","version":"2"},"opencode":{"state":"ready","version":"1"}}}"#
        );
    }

    #[test]
    fn null_byte_counts_serialize_as_null() {
        let status = RuntimeStatus::Downloading {
            version: "1.2.0".to_string(),
            received_bytes: 10,
            total_bytes: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({ "state": "downloading", "version": "1.2.0", "receivedBytes": 10, "totalBytes": null })
        );
    }

    #[test]
    fn statuses_round_trip_by_state_tag() {
        let by_agent = json!({
            "codex": { "state": "missing", "version": "0.1", "sizeBytes": null },
            "opencode": { "state": "bundled" }
        });
        let parsed: RuntimesState =
            serde_json::from_value(json!({ "byAgent": by_agent.clone() })).unwrap();
        assert_eq!(
            serde_json::to_string(&parsed.by_agent).unwrap(),
            serde_json::to_string(&by_agent).unwrap()
        );
    }
}
