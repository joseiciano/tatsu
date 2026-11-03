use std::sync::Arc;

use serde_json::{Map, Value};
use tatsu_state::StateEvent;
use tatsu_state::slices::onboarding::{OnboardingEvent, QuestStep};

use super::upgrade;
use crate::lifecycle::Core;
use crate::router::Reply;

const ONBOARDING_KEY: &str = "onboarding";

pub(super) fn register(core: &Arc<Core>) {
    let weak = Arc::downgrade(core);
    core.router()
        .request("config:setOnboardingQuest", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let Some(quest) = args.first().and_then(quest_step) else {
                    return Ok(Reply::Value(Value::Bool(false)));
                };
                let raw = args[0].clone();
                core.config().update(|doc| {
                    let mut onboarding = spread(doc.get(ONBOARDING_KEY));
                    onboarding.insert("quest".to_owned(), raw);
                    doc.set(ONBOARDING_KEY, Value::Object(onboarding));
                });
                core.store()
                    .dispatch(StateEvent::Onboarding(OnboardingEvent::QuestChanged(quest)));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setOnboardingQuest registers once");
}

fn quest_step(value: &Value) -> Option<QuestStep> {
    match value.as_str()? {
        "hidden" => Some(QuestStep::Hidden),
        "spawn-second" => Some(QuestStep::SpawnSecond),
        "switch-between" => Some(QuestStep::SwitchBetween),
        "finale" => Some(QuestStep::Finale),
        "done" => Some(QuestStep::Done),
        _ => None,
    }
}

fn spread(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, item)| (i.to_string(), item.clone()))
            .collect(),
        Some(Value::String(text)) => text
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| {
                (
                    i.to_string(),
                    Value::String(String::from_utf16_lossy(&[unit])),
                )
            })
            .collect(),
        _ => Map::new(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::spread;

    #[test]
    fn spread_copies_js_object_spread_of_the_old_value() {
        assert_eq!(
            spread(Some(&json!({"a": 1, "quest": "done"}))),
            json!({"a": 1, "quest": "done"})
                .as_object()
                .unwrap()
                .clone()
        );
        assert_eq!(
            spread(Some(&json!(["x", "y"]))),
            json!({"0": "x", "1": "y"}).as_object().unwrap().clone()
        );
        assert_eq!(
            spread(Some(&json!("ab"))),
            json!({"0": "a", "1": "b"}).as_object().unwrap().clone()
        );
        for falsy_or_primitive in [json!(null), json!(0), json!(""), json!(true), json!(5)] {
            assert!(spread(Some(&falsy_or_primitive)).is_empty());
        }
        assert!(spread(None).is_empty());
    }
}
