mod tree_helpers;

use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error};
use serde_json::{Map, Value};
use specta::{Type, Types, datatype::DataType};

use crate::js_string;

pub use tree_helpers::{
    find_leaf, find_leaf_by_tab_id, find_split, get_leaves, has_any_tabs, map_leaves, remove_leaf,
    replace_node,
};

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
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PaneNode {
    Leaf(PaneLeaf),
    Split(PaneSplit),
}

impl PaneNode {
    pub fn id(&self) -> &str {
        match self {
            PaneNode::Leaf(leaf) => &leaf.id,
            PaneNode::Split(split) => &split.id,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PtyStatus {
    Idle,
    Processing,
    Waiting,
    NeedsApproval,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingTool {
    pub name: String,
    pub input: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShellActivity {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TerminalProgressState {
    None,
    Normal,
    Error,
    Indeterminate,
    Paused,
}

impl TerminalProgressState {
    const VALUES: [TerminalProgressState; 5] = [
        TerminalProgressState::None,
        TerminalProgressState::Normal,
        TerminalProgressState::Error,
        TerminalProgressState::Indeterminate,
        TerminalProgressState::Paused,
    ];

    fn code(self) -> u8 {
        self as u8
    }
}

impl Serialize for TerminalProgressState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u8(self.code())
    }
}

impl<'de> Deserialize<'de> for TerminalProgressState {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let code = u8::deserialize(deserializer)?;
        Self::VALUES
            .get(usize::from(code))
            .copied()
            .ok_or_else(|| D::Error::custom("expected `0 | 1 | 2 | 3 | 4`"))
    }
}

impl Type for TerminalProgressState {
    fn definition(_: &mut Types) -> DataType {
        DataType::Reference(specta_typescript::define("0 | 1 | 2 | 3 | 4"))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProgress {
    pub state: TerminalProgressState,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub cols: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub rows: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSession {
    pub controller_client_id: Option<String>,
    pub spectator_client_ids: Vec<String>,
    pub size: Option<TerminalSize>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalsState {
    pub statuses: IndexMap<String, PtyStatus>,
    pub pending_tools: IndexMap<String, Option<PendingTool>>,
    pub shell_activity: IndexMap<String, ShellActivity>,
    pub progress: IndexMap<String, TerminalProgress>,
    pub panes: IndexMap<String, PaneNode>,
    pub last_active: IndexMap<String, i64>,
    pub sessions: IndexMap<String, TerminalSession>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatusChange {
    pub id: String,
    pub status: PtyStatus,
    pub pending_tool: Option<PendingTool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShellActivityChange {
    pub id: String,
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalProgressChange {
    pub id: String,
    pub state: TerminalProgressState,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub value: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPanesForWorktree {
    pub worktree_path: String,
    pub panes: PaneNode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLastActiveChange {
    pub worktree_path: String,
    pub ts: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPaneRatioChange {
    pub worktree_path: String,
    pub split_id: String,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub ratio: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionIdDiscovery {
    pub terminal_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalControlTake {
    pub terminal_id: String,
    pub client_id: String,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub cols: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub rows: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClientRef {
    pub terminal_id: String,
    pub client_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalClientDisconnect {
    pub client_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSizeChange {
    pub terminal_id: String,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub cols: f64,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub rows: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum ConvertibleTabType {
    Agent,
    JsonClaude,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTabTypeChange {
    pub worktree_path: String,
    pub tab_id: String,
    pub new_id: String,
    pub new_type: ConvertibleTabType,
    pub new_label: String,
    pub agent_kind: AgentKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTabAgentSessionIdChange {
    pub worktree_path: String,
    pub tab_id: String,
    pub agent_session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTabRef {
    pub worktree_path: String,
    pub tab_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTabLabelChange {
    pub worktree_path: String,
    pub tab_id: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum TerminalsEvent {
    #[serde(rename = "terminals/statusChanged")]
    StatusChanged(TerminalStatusChange),
    #[serde(rename = "terminals/shellActivityChanged")]
    ShellActivityChanged(TerminalShellActivityChange),
    #[serde(rename = "terminals/progressChanged")]
    ProgressChanged(TerminalProgressChange),
    #[serde(rename = "terminals/removed")]
    Removed(String),
    #[serde(rename = "terminals/panesReplaced")]
    PanesReplaced(IndexMap<String, PaneNode>),
    #[serde(rename = "terminals/panesForWorktreeChanged")]
    PanesForWorktreeChanged(TerminalPanesForWorktree),
    #[serde(rename = "terminals/panesForWorktreeCleared")]
    PanesForWorktreeCleared(String),
    #[serde(rename = "terminals/lastActiveChanged")]
    LastActiveChanged(TerminalLastActiveChange),
    #[serde(rename = "terminals/paneRatioChanged")]
    PaneRatioChanged(TerminalPaneRatioChange),
    #[serde(rename = "terminals/sessionIdDiscovered")]
    SessionIdDiscovered(TerminalSessionIdDiscovery),
    #[serde(rename = "terminals/controlTaken")]
    ControlTaken(TerminalControlTake),
    #[serde(rename = "terminals/controlReleased")]
    ControlReleased(TerminalClientRef),
    #[serde(rename = "terminals/clientJoined")]
    ClientJoined(TerminalClientRef),
    #[serde(rename = "terminals/clientDisconnected")]
    ClientDisconnected(TerminalClientDisconnect),
    #[serde(rename = "terminals/sizeChanged")]
    SizeChanged(TerminalSizeChange),
    #[serde(rename = "terminals/tabTypeChanged")]
    TabTypeChanged(TerminalTabTypeChange),
    #[serde(rename = "terminals/tabAgentSessionIdChanged")]
    TabAgentSessionIdChanged(TerminalTabAgentSessionIdChange),
    #[serde(rename = "terminals/tabSlept")]
    TabSlept(TerminalTabRef),
    #[serde(rename = "terminals/tabWoken")]
    TabWoken(TerminalTabRef),
    #[serde(rename = "terminals/tabRenamed")]
    TabRenamed(TerminalTabLabelChange),
    #[serde(rename = "terminals/tabLabelChanged")]
    TabLabelChanged(TerminalTabLabelChange),
}

fn update_first_tab_per_leaf(
    state: &mut TerminalsState,
    worktree_path: &str,
    tab_id: &str,
    mut update: impl FnMut(&mut TerminalTab),
) {
    let Some(tree) = state.panes.get_mut(worktree_path) else {
        return;
    };
    map_leaves(tree, &mut |leaf| {
        if let Some(tab) = leaf.tabs.iter_mut().find(|tab| tab.id == tab_id) {
            update(tab);
        }
    });
}

fn converted_tab(tab: &TerminalTab, change: &TerminalTabTypeChange) -> TerminalTab {
    let session_id = tab
        .session_id
        .clone()
        .unwrap_or_else(|| change.new_id.clone());
    let base = TerminalTab {
        id: change.new_id.clone(),
        tab_type: TerminalTabType::Agent,
        label: change.new_label.clone(),
        custom_label: None,
        mode: None,
        agent_kind: Some(change.agent_kind),
        model: None,
        file_path: None,
        staged: None,
        branch_diff: None,
        commit_hash: None,
        session_id: None,
        agent_session_id: None,
        initial_prompt: None,
        teleport_session_id: None,
        url: None,
        command: None,
        cwd: None,
    };
    match change.new_type {
        ConvertibleTabType::JsonClaude => TerminalTab {
            tab_type: TerminalTabType::JsonClaude,
            session_id: Some(session_id),
            agent_session_id: change.agent_session_id.clone().filter(|id| !id.is_empty()),
            mode: Some(TerminalTabMode::Awake),
            ..base
        },
        ConvertibleTabType::Agent => TerminalTab {
            session_id: Some(change.agent_session_id.clone().unwrap_or(session_id)),
            ..base
        },
    }
}

fn set_mode(state: &mut TerminalsState, tab: TerminalTabRef, target: TerminalTabMode) {
    update_first_tab_per_leaf(state, &tab.worktree_path, &tab.tab_id, |tab| {
        if matches!(
            tab.tab_type,
            TerminalTabType::JsonClaude | TerminalTabType::Shell
        ) && tab.mode.unwrap_or(TerminalTabMode::Awake) != target
        {
            tab.mode = Some(target);
        }
    });
}

pub fn reduce(state: &mut TerminalsState, event: TerminalsEvent) {
    match event {
        TerminalsEvent::StatusChanged(change) => {
            let pending_tool = if change.status == PtyStatus::NeedsApproval {
                change.pending_tool
            } else {
                None
            };
            state.statuses.insert(change.id.clone(), change.status);
            state.pending_tools.insert(change.id, pending_tool);
        }
        TerminalsEvent::ShellActivityChanged(change) => {
            state.shell_activity.insert(
                change.id,
                ShellActivity {
                    active: change.active,
                    process_name: change.process_name,
                },
            );
        }
        TerminalsEvent::ProgressChanged(change) => {
            if change.state == TerminalProgressState::None {
                state.progress.shift_remove(&change.id);
                return;
            }
            state.progress.insert(
                change.id,
                TerminalProgress {
                    state: change.state,
                    value: change.value,
                },
            );
        }
        TerminalsEvent::Removed(id) => {
            state.statuses.shift_remove(&id);
            state.pending_tools.shift_remove(&id);
            state.shell_activity.shift_remove(&id);
            state.progress.shift_remove(&id);
            state.sessions.shift_remove(&id);
        }
        TerminalsEvent::PanesReplaced(panes) => state.panes = panes,
        TerminalsEvent::PanesForWorktreeChanged(change) => {
            state.panes.insert(change.worktree_path, change.panes);
        }
        TerminalsEvent::PanesForWorktreeCleared(worktree_path) => {
            state.panes.shift_remove(&worktree_path);
        }
        TerminalsEvent::LastActiveChanged(change) => {
            state.last_active.insert(change.worktree_path, change.ts);
        }
        TerminalsEvent::PaneRatioChanged(change) => {
            let Some(tree) = state.panes.get_mut(&change.worktree_path) else {
                return;
            };
            let Some(split) = find_split(tree, &change.split_id) else {
                return;
            };
            let replacement = PaneNode::Split(PaneSplit {
                ratio: change.ratio,
                ..split.clone()
            });
            replace_node(tree, &change.split_id, &replacement);
        }
        TerminalsEvent::SessionIdDiscovered(discovery) => {
            for tree in state.panes.values_mut() {
                map_leaves(tree, &mut |leaf| {
                    for tab in &mut leaf.tabs {
                        if tab.id == discovery.terminal_id
                            && tab.session_id.as_deref().is_none_or(str::is_empty)
                        {
                            tab.session_id = Some(discovery.session_id.clone());
                        }
                    }
                });
            }
        }
        TerminalsEvent::ControlTaken(take) => {
            let existing = state.sessions.get(&take.terminal_id);
            let previous = existing.and_then(|s| s.controller_client_id.clone());
            let mut spectators: Vec<String> = existing
                .map(|s| s.spectator_client_ids.clone())
                .unwrap_or_default();
            spectators.retain(|id| *id != take.client_id);
            if let Some(previous) = previous.filter(|p| !p.is_empty() && *p != take.client_id)
                && !spectators.contains(&previous)
            {
                spectators.push(previous);
            }
            state.sessions.insert(
                take.terminal_id,
                TerminalSession {
                    controller_client_id: Some(take.client_id),
                    spectator_client_ids: spectators,
                    size: Some(TerminalSize {
                        cols: take.cols,
                        rows: take.rows,
                    }),
                },
            );
        }
        TerminalsEvent::ControlReleased(release) => {
            let Some(session) = state.sessions.get_mut(&release.terminal_id) else {
                return;
            };
            if session.controller_client_id.as_deref() == Some(release.client_id.as_str()) {
                session.controller_client_id = None;
            } else {
                session
                    .spectator_client_ids
                    .retain(|id| *id != release.client_id);
            }
        }
        TerminalsEvent::ClientJoined(join) => {
            let Some(session) = state.sessions.get_mut(&join.terminal_id) else {
                state.sessions.insert(
                    join.terminal_id,
                    TerminalSession {
                        controller_client_id: Some(join.client_id),
                        spectator_client_ids: Vec::new(),
                        size: None,
                    },
                );
                return;
            };
            if session.controller_client_id.as_deref() == Some(join.client_id.as_str())
                || session.spectator_client_ids.contains(&join.client_id)
            {
                return;
            }
            if session.controller_client_id.is_none() {
                session.controller_client_id = Some(join.client_id);
            } else {
                session.spectator_client_ids.push(join.client_id);
            }
        }
        TerminalsEvent::ClientDisconnected(disconnect) => {
            for session in state.sessions.values_mut() {
                if session.controller_client_id.as_deref() == Some(disconnect.client_id.as_str()) {
                    session.controller_client_id = None;
                }
                session
                    .spectator_client_ids
                    .retain(|id| *id != disconnect.client_id);
            }
        }
        TerminalsEvent::SizeChanged(change) => {
            let size = Some(TerminalSize {
                cols: change.cols,
                rows: change.rows,
            });
            match state.sessions.get_mut(&change.terminal_id) {
                Some(session) => session.size = size,
                None => {
                    state.sessions.insert(
                        change.terminal_id,
                        TerminalSession {
                            controller_client_id: None,
                            spectator_client_ids: Vec::new(),
                            size,
                        },
                    );
                }
            }
        }
        TerminalsEvent::TabTypeChanged(change) => {
            let Some(tree) = state.panes.get_mut(&change.worktree_path) else {
                return;
            };
            map_leaves(tree, &mut |leaf| {
                if !leaf.tabs.iter().any(|tab| tab.id == change.tab_id) {
                    return;
                }
                for tab in &mut leaf.tabs {
                    if tab.id == change.tab_id {
                        *tab = converted_tab(tab, &change);
                    }
                }
                if leaf.active_tab_id == change.tab_id {
                    leaf.active_tab_id = change.new_id.clone();
                }
            });
        }
        TerminalsEvent::TabAgentSessionIdChanged(change) => {
            update_first_tab_per_leaf(state, &change.worktree_path, &change.tab_id, |tab| {
                tab.agent_session_id = Some(change.agent_session_id.clone());
            });
        }
        TerminalsEvent::TabSlept(tab) => set_mode(state, tab, TerminalTabMode::Asleep),
        TerminalsEvent::TabWoken(tab) => set_mode(state, tab, TerminalTabMode::Awake),
        TerminalsEvent::TabLabelChanged(change) => {
            let label = js_string::trim(&change.label);
            if label.is_empty() {
                return;
            }
            update_first_tab_per_leaf(state, &change.worktree_path, &change.tab_id, |tab| {
                tab.label = label.to_string();
            });
        }
        TerminalsEvent::TabRenamed(change) => {
            let label = js_string::trim(&change.label);
            update_first_tab_per_leaf(state, &change.worktree_path, &change.tab_id, |tab| {
                tab.custom_label = (!label.is_empty()).then(|| label.to_string());
            });
        }
    }
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
