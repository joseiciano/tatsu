use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelTally {
    pub messages: u64,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub cost: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContentBreakdown {
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub text: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub thinking: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub tool_use: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub user_prompt: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub assistant_echo: f64,
    #[serde(serialize_with = "crate::wire::number::map::serialize")]
    #[specta(type = IndexMap<String, f64>)]
    pub tool_results: IndexMap<String, f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub session_id: String,
    pub transcript_path: String,
    pub by_model: IndexMap<String, ModelTally>,
    pub breakdown: ContentBreakdown,
    pub current_model: Option<String>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct CostsState {
    pub by_terminal: IndexMap<String, SessionUsage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CostsUsageUpdate {
    pub terminal_id: String,
    pub usage: Box<SessionUsage>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CostsTerminalRef {
    pub terminal_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum CostsEvent {
    #[serde(rename = "costs/usageUpdated")]
    UsageUpdated(CostsUsageUpdate),
    #[serde(rename = "costs/terminalCleared")]
    TerminalCleared(CostsTerminalRef),
    #[serde(rename = "costs/hydrated")]
    Hydrated(CostsState),
}

pub fn reduce(state: &mut CostsState, event: CostsEvent) {
    match event {
        CostsEvent::UsageUpdated(update) => {
            state.by_terminal.insert(update.terminal_id, *update.usage);
        }
        CostsEvent::TerminalCleared(cleared) => {
            state.by_terminal.shift_remove(&cleared.terminal_id);
        }
        CostsEvent::Hydrated(hydrated) => *state = hydrated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn usage(session_id: &str) -> SessionUsage {
        serde_json::from_value(json!({
            "sessionId": session_id, "transcriptPath": "/t.jsonl", "currentModel": null,
            "updatedAt": 1000, "byModel": {},
            "breakdown": { "text": 0, "thinking": 0, "toolUse": 0, "userPrompt": 0,
                           "assistantEcho": 0, "toolResults": {} }
        }))
        .unwrap()
    }

    fn state_with(ids: &[&str]) -> CostsState {
        CostsState {
            by_terminal: ids.iter().map(|id| (id.to_string(), usage(id))).collect(),
        }
    }

    fn keys(state: &CostsState) -> Vec<&str> {
        state.by_terminal.keys().map(String::as_str).collect()
    }

    #[test]
    fn usage_updated_on_an_existing_terminal_keeps_its_position() {
        let mut state = state_with(&["t1", "t2", "t3"]);
        reduce(
            &mut state,
            CostsEvent::UsageUpdated(CostsUsageUpdate {
                terminal_id: "t1".to_string(),
                usage: Box::new(usage("new")),
            }),
        );
        assert_eq!(keys(&state), ["t1", "t2", "t3"]);
        assert_eq!(state.by_terminal["t1"].session_id, "new");
    }

    #[test]
    fn terminal_cleared_keeps_the_order_of_the_rest() {
        let mut state = state_with(&["t1", "t2", "t3"]);
        reduce(
            &mut state,
            CostsEvent::TerminalCleared(CostsTerminalRef {
                terminal_id: "t1".to_string(),
            }),
        );
        assert_eq!(keys(&state), ["t2", "t3"]);
    }
}
