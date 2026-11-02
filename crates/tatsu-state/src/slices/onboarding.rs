use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum QuestStep {
    #[default]
    Hidden,
    SpawnSecond,
    SwitchBetween,
    Finale,
    Done,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct OnboardingState {
    pub quest: QuestStep,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum OnboardingEvent {
    #[serde(rename = "onboarding/questChanged")]
    QuestChanged(QuestStep),
}

pub fn reduce(state: &mut OnboardingState, event: OnboardingEvent) {
    match event {
        OnboardingEvent::QuestChanged(quest) => state.quest = quest,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initial_state_is_hidden() {
        assert_eq!(
            serde_json::to_value(OnboardingState::default()).unwrap(),
            json!({ "quest": "hidden" })
        );
    }

    #[test]
    fn quest_steps_use_the_ts_kebab_case_names() {
        let event: OnboardingEvent = serde_json::from_value(
            json!({ "type": "onboarding/questChanged", "payload": "switch-between" }),
        )
        .unwrap();
        let mut state = OnboardingState::default();
        reduce(&mut state, event);
        assert_eq!(state.quest, QuestStep::SwitchBetween);
    }
}
