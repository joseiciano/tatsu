use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(
    tag = "state",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum UpdaterStatus {
    Checking,
    Available {
        version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        release_url: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        manual_install_required: Option<bool>,
    },
    NotAvailable,
    Downloading {
        #[serde(serialize_with = "crate::wire::number::serialize")]
        #[specta(type = f64)]
        percent: f64,
        version: String,
    },
    Downloaded {
        version: String,
    },
    Error {
        error: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct UpdaterState {
    pub status: Option<UpdaterStatus>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum UpdaterEvent {
    #[serde(rename = "updater/statusChanged")]
    StatusChanged(UpdaterStatus),
}

pub fn reduce(state: &mut UpdaterState, event: UpdaterEvent) {
    match event {
        UpdaterEvent::StatusChanged(status) => state.status = Some(status),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initial_status_serializes_as_null() {
        assert_eq!(
            serde_json::to_value(UpdaterState::default()).unwrap(),
            json!({ "status": null })
        );
    }

    #[test]
    fn statuses_round_trip_by_state_tag() {
        for status in [
            json!({ "state": "checking" }),
            json!({ "state": "available", "version": "1.13.0" }),
            json!({ "state": "available", "version": "2.8.0", "releaseUrl": "https://x", "manualInstallRequired": false }),
            json!({ "state": "not-available" }),
            json!({ "state": "downloading", "percent": 42.5, "version": "1.13.0" }),
            json!({ "state": "downloading", "percent": 100, "version": "1.13.0" }),
            json!({ "state": "downloaded", "version": "1.13.0" }),
            json!({ "state": "error", "error": "no internet" }),
        ] {
            let parsed: UpdaterStatus = serde_json::from_value(status.clone()).unwrap();
            assert_eq!(serde_json::to_string(&parsed).unwrap(), status.to_string());
        }
    }
}
