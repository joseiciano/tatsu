use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum HooksConsent {
    #[default]
    Pending,
    Accepted,
    Declined,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct HooksState {
    pub consent: HooksConsent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum HooksEvent {
    #[serde(rename = "hooks/consentChanged")]
    ConsentChanged(HooksConsent),
}

pub fn reduce(state: &mut HooksState, event: HooksEvent) {
    match event {
        HooksEvent::ConsentChanged(consent) => state.consent = consent,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initial_state_is_pending() {
        assert_eq!(
            serde_json::to_value(HooksState::default()).unwrap(),
            json!({ "consent": "pending" })
        );
    }
}
