use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Opencode,
    Pi,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalTabType {
    Agent,
    Shell,
    Diff,
    File,
    Browser,
    JsonClaude,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum TerminalTabMode {
    Awake,
    Asleep,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTab {
    pub id: String,
    #[serde(rename = "type")]
    pub tab_type: TerminalTabType,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<TerminalTabMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<AgentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staged: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_diff: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teleport_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SplitDirection {
    Horizontal,
    Vertical,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PaneLeaf {
    pub id: String,
    pub tabs: Vec<TerminalTab>,
    pub active_tab_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PaneSplit {
    pub id: String,
    pub direction: SplitDirection,
    pub children: Box<(PaneNode, PaneNode)>,
    pub ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PaneNode {
    Leaf(PaneLeaf),
    Split(PaneSplit),
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pane_tree_round_trips_with_the_ts_shape() {
        let tree = json!({
            "type": "split",
            "id": "s1",
            "direction": "horizontal",
            "children": [
                { "type": "leaf", "id": "l1", "activeTabId": "t1", "tabs": [
                    { "id": "t1", "type": "json-claude", "label": "Chat", "agentKind": "codex" }
                ] },
                { "type": "split", "id": "s2", "direction": "vertical", "ratio": 0.25, "children": [
                    { "type": "leaf", "id": "l2", "activeTabId": "t2", "tabs": [
                        { "id": "t2", "type": "shell", "label": "zsh", "mode": "asleep" }
                    ] },
                    { "type": "leaf", "id": "l3", "activeTabId": "", "tabs": [] }
                ] }
            ],
            "ratio": 0.5
        });

        let parsed: PaneNode = serde_json::from_value(tree.clone()).unwrap();

        assert_eq!(serde_json::to_value(&parsed).unwrap(), tree);
    }
}
