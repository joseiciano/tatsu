mod helpers;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::slices::terminals::AgentKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ChatRuntimeId {
    Claude,
    Opencode,
    Codex,
}

pub const CHAT_RUNTIME_IDS: [ChatRuntimeId; 3] = [
    ChatRuntimeId::Claude,
    ChatRuntimeId::Opencode,
    ChatRuntimeId::Codex,
];

impl ChatRuntimeId {
    fn from_agent_kind(kind: AgentKind) -> Option<Self> {
        match kind {
            AgentKind::Claude => Some(ChatRuntimeId::Claude),
            AgentKind::Opencode => Some(ChatRuntimeId::Opencode),
            AgentKind::Codex => Some(ChatRuntimeId::Codex),
            AgentKind::Pi => None,
        }
    }
}

pub fn is_chat_runtime_id(kind: Option<AgentKind>) -> bool {
    kind.and_then(ChatRuntimeId::from_agent_kind).is_some()
}

pub fn chat_runtime_available(
    kind: Option<AgentKind>,
    experimental_chat_agents_enabled: bool,
) -> bool {
    is_chat_runtime_id(kind)
        && (kind == Some(AgentKind::Claude) || experimental_chat_agents_enabled)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JsonClaudePermissionMode {
    Default,
    AcceptEdits,
    Plan,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum JsonClaudeSessionState {
    Idle,
    Connecting,
    Running,
    Exited,
    AuthRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum JsonClaudeAuthMethodType {
    Agent,
    Terminal,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeAuthMethod {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub method_type: Option<JsonClaudeAuthMethodType>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChatRuntimeCapabilities {
    pub can_interrupt: bool,
    pub can_rewind: bool,
    pub can_set_permission_mode: bool,
    pub can_approve_tools: bool,
    pub can_resume: bool,
    pub can_open_auth_login: bool,
    pub has_slash_commands: bool,
    pub has_cost_tracking: bool,
}

impl ChatRuntimeCapabilities {
    fn acp_defaults() -> Self {
        ChatRuntimeCapabilities {
            can_interrupt: true,
            can_rewind: false,
            can_set_permission_mode: false,
            can_approve_tools: false,
            can_resume: true,
            can_open_auth_login: false,
            has_slash_commands: false,
            has_cost_tracking: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum JsonClaudeBlockType {
    Text,
    Thinking,
    ToolUse,
    ToolResult,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeMessageBlock {
    #[serde(rename = "type")]
    pub block_type: JsonClaudeBlockType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum JsonClaudeEntryKind {
    User,
    Assistant,
    System,
    Error,
    ToolResult,
    Compact,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum JsonClaudeCompactTrigger {
    Auto,
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum JsonClaudeErrorKind {
    SubprocessExit,
    RateLimit,
    RateLimitWarning,
    RateLimitError,
    AuthFailure,
    ProtocolVersion,
    RuntimeMissing,
    SessionLoadFailed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeImageAttachment {
    pub path: String,
    pub media_type: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeRateLimitDetail {
    #[serde(
        default,
        serialize_with = "crate::wire::number::option::serialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[specta(type = Option<f64>)]
    pub utilization: Option<f64>,
    #[serde(
        default,
        serialize_with = "crate::wire::number::option::serialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[specta(type = Option<f64>)]
    pub reset_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_using_overage: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeChatEntry {
    pub entry_id: String,
    pub kind: JsonClaudeEntryKind,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<JsonClaudeMessageBlock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_trigger: Option<JsonClaudeCompactTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_pre_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_post_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_partial: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_queued: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<JsonClaudeImageAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<JsonClaudeErrorKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_methods: Option<Vec<JsonClaudeAuthMethod>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_was_clean: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_detail: Option<JsonClaudeRateLimitDetail>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeAutoApprovedDecision {
    pub model: String,
    pub reason: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSessionAllowedDecision {
    pub tool_name: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSession {
    pub session_id: String,
    pub worktree_path: String,
    pub agent_kind: AgentKind,
    pub runtime_id: ChatRuntimeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub state: JsonClaudeSessionState,
    pub exit_code: Option<i64>,
    pub exit_reason: Option<String>,
    pub entries: Vec<JsonClaudeChatEntry>,
    pub entries_hydrated: bool,
    pub busy: bool,
    pub permission_mode: JsonClaudePermissionMode,
    pub slash_commands: Vec<String>,
    pub auto_approved_decisions: IndexMap<String, JsonClaudeAutoApprovedDecision>,
    pub session_tool_approvals: Vec<String>,
    pub session_allowed_decisions: IndexMap<String, JsonClaudeSessionAllowedDecision>,
    pub capabilities: ChatRuntimeCapabilities,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AutoReviewState {
    Pending,
    Finished,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum AutoReviewDecision {
    Approve,
    Ask,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AutoReviewStatus {
    pub state: AutoReviewState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<AutoReviewDecision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudePendingApproval {
    pub request_id: String,
    pub session_id: String,
    pub tool_name: String,
    pub input: Map<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    pub timestamp: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_review: Option<AutoReviewStatus>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct JsonClaudeState {
    pub sessions: IndexMap<String, JsonClaudeSession>,
    pub pending_approvals: IndexMap<String, JsonClaudePendingApproval>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSessionStart {
    pub session_id: String,
    pub worktree_path: String,
    pub agent_kind: AgentKind,
    pub runtime_id: ChatRuntimeId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_permission_mode: Option<JsonClaudePermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ChatRuntimeCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeAgentSessionIdChange {
    pub session_id: String,
    pub agent_session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSessionTitleChange {
    pub session_id: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSessionStateChange {
    pub session_id: String,
    pub state: JsonClaudeSessionState,
    #[serde(
        default,
        deserialize_with = "crate::wire::nullable::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[specta(type = Option<Option<i64>>)]
    pub exit_code: Option<Option<i64>>,
    #[serde(
        default,
        deserialize_with = "crate::wire::nullable::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[specta(type = Option<Option<String>>)]
    pub exit_reason: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeEntryAppend {
    pub session_id: String,
    pub entry: Box<JsonClaudeChatEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeEntriesSeed {
    pub session_id: String,
    pub entries: Vec<JsonClaudeChatEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeTextDelta {
    pub session_id: String,
    pub entry_id: String,
    pub text_delta: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeBlockAppend {
    pub session_id: String,
    pub entry_id: String,
    pub block: JsonClaudeMessageBlock,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeEntryFinalize {
    pub session_id: String,
    pub entry_id: String,
    pub blocks: Vec<JsonClaudeMessageBlock>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeToolResult {
    pub session_id: String,
    pub tool_use_id: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeBusyChange {
    pub session_id: String,
    pub busy: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSessionRef {
    pub session_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeApprovalRef {
    pub request_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeAutoApproval {
    pub session_id: String,
    pub tool_use_id: String,
    pub model: String,
    pub reason: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeAutoReviewFinish {
    pub request_id: String,
    pub decision: AutoReviewDecision,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudePermissionModeChange {
    pub session_id: String,
    pub mode: JsonClaudePermissionMode,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeEntryRef {
    pub session_id: String,
    pub entry_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeEntriesTruncate {
    pub session_id: String,
    pub from_entry_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSlashCommandsChange {
    pub session_id: String,
    pub slash_commands: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeCompactBoundary {
    pub session_id: String,
    pub entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<JsonClaudeCompactTrigger>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pre_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_tokens: Option<i64>,
    pub timestamp: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeToolApprovalsGrant {
    pub session_id: String,
    pub tool_names: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeToolApprovalsClear {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_names: Option<Vec<String>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeSessionAllowance {
    pub session_id: String,
    pub tool_use_id: String,
    pub tool_name: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JsonClaudeCapabilitiesChange {
    pub session_id: String,
    pub capabilities: ChatRuntimeCapabilities,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum JsonClaudeEvent {
    #[serde(rename = "jsonClaude/sessionStarted")]
    SessionStarted(JsonClaudeSessionStart),
    #[serde(rename = "jsonClaude/agentSessionIdChanged")]
    AgentSessionIdChanged(JsonClaudeAgentSessionIdChange),
    #[serde(rename = "jsonClaude/sessionTitleChanged")]
    SessionTitleChanged(JsonClaudeSessionTitleChange),
    #[serde(rename = "jsonClaude/sessionStateChanged")]
    SessionStateChanged(JsonClaudeSessionStateChange),
    #[serde(rename = "jsonClaude/entryAppended")]
    EntryAppended(JsonClaudeEntryAppend),
    #[serde(rename = "jsonClaude/entriesSeeded")]
    EntriesSeeded(JsonClaudeEntriesSeed),
    #[serde(rename = "jsonClaude/assistantTextDelta")]
    AssistantTextDelta(JsonClaudeTextDelta),
    #[serde(rename = "jsonClaude/assistantThinkingDelta")]
    AssistantThinkingDelta(JsonClaudeTextDelta),
    #[serde(rename = "jsonClaude/assistantBlockAppended")]
    AssistantBlockAppended(JsonClaudeBlockAppend),
    #[serde(rename = "jsonClaude/assistantEntryFinalized")]
    AssistantEntryFinalized(JsonClaudeEntryFinalize),
    #[serde(rename = "jsonClaude/toolResultAttached")]
    ToolResultAttached(JsonClaudeToolResult),
    #[serde(rename = "jsonClaude/busyChanged")]
    BusyChanged(JsonClaudeBusyChange),
    #[serde(rename = "jsonClaude/sessionCleared")]
    SessionCleared(JsonClaudeSessionRef),
    #[serde(rename = "jsonClaude/approvalRequested")]
    ApprovalRequested(Box<JsonClaudePendingApproval>),
    #[serde(rename = "jsonClaude/approvalResolved")]
    ApprovalResolved(JsonClaudeApprovalRef),
    #[serde(rename = "jsonClaude/approvalAutoApproved")]
    ApprovalAutoApproved(JsonClaudeAutoApproval),
    #[serde(rename = "jsonClaude/approvalAutoReviewFinished")]
    ApprovalAutoReviewFinished(JsonClaudeAutoReviewFinish),
    #[serde(rename = "jsonClaude/permissionModeChanged")]
    PermissionModeChanged(JsonClaudePermissionModeChange),
    #[serde(rename = "jsonClaude/userEntriesUnqueued")]
    UserEntriesUnqueued(JsonClaudeSessionRef),
    #[serde(rename = "jsonClaude/userEntryUnqueued")]
    UserEntryUnqueued(JsonClaudeEntryRef),
    #[serde(rename = "jsonClaude/entryRemoved")]
    EntryRemoved(JsonClaudeEntryRef),
    #[serde(rename = "jsonClaude/entriesTruncated")]
    EntriesTruncated(JsonClaudeEntriesTruncate),
    #[serde(rename = "jsonClaude/slashCommandsChanged")]
    SlashCommandsChanged(JsonClaudeSlashCommandsChange),
    #[serde(rename = "jsonClaude/compactBoundaryReceived")]
    CompactBoundaryReceived(JsonClaudeCompactBoundary),
    #[serde(rename = "jsonClaude/sessionToolApprovalsGranted")]
    SessionToolApprovalsGranted(JsonClaudeToolApprovalsGrant),
    #[serde(rename = "jsonClaude/sessionToolApprovalsCleared")]
    SessionToolApprovalsCleared(JsonClaudeToolApprovalsClear),
    #[serde(rename = "jsonClaude/approvalSessionAllowed")]
    ApprovalSessionAllowed(JsonClaudeSessionAllowance),
    #[serde(rename = "jsonClaude/capabilitiesChanged")]
    CapabilitiesChanged(JsonClaudeCapabilitiesChange),
}

pub fn reduce(state: &mut JsonClaudeState, event: JsonClaudeEvent, now: i64) {
    match event {
        JsonClaudeEvent::SessionStarted(start) => {
            let existing = state.sessions.get(&start.session_id);
            let session = JsonClaudeSession {
                session_id: start.session_id.clone(),
                worktree_path: start.worktree_path,
                agent_kind: existing.map_or(start.agent_kind, |s| s.agent_kind),
                runtime_id: existing.map_or(start.runtime_id, |s| s.runtime_id),
                agent_session_id: existing
                    .and_then(|s| s.agent_session_id.clone())
                    .or(start.agent_session_id)
                    .filter(|id| !id.is_empty()),
                title: existing
                    .and_then(|s| s.title.clone())
                    .filter(|title| !title.is_empty()),
                state: JsonClaudeSessionState::Connecting,
                exit_code: None,
                exit_reason: None,
                entries: existing.map(|s| s.entries.clone()).unwrap_or_default(),
                entries_hydrated: existing.is_some_and(|s| s.entries_hydrated),
                busy: false,
                permission_mode: existing
                    .map(|s| s.permission_mode)
                    .or(start.default_permission_mode)
                    .unwrap_or(JsonClaudePermissionMode::Default),
                slash_commands: existing
                    .map(|s| s.slash_commands.clone())
                    .unwrap_or_default(),
                auto_approved_decisions: existing
                    .map(|s| s.auto_approved_decisions.clone())
                    .unwrap_or_default(),
                session_tool_approvals: existing
                    .map(|s| s.session_tool_approvals.clone())
                    .unwrap_or_default(),
                session_allowed_decisions: existing
                    .map(|s| s.session_allowed_decisions.clone())
                    .unwrap_or_default(),
                capabilities: existing
                    .map(|s| s.capabilities)
                    .or(start.capabilities)
                    .unwrap_or_else(ChatRuntimeCapabilities::acp_defaults),
            };
            state.sessions.insert(start.session_id, session);
        }
        JsonClaudeEvent::AgentSessionIdChanged(change) => {
            if let Some(session) = state.sessions.get_mut(&change.session_id) {
                session.agent_session_id = Some(change.agent_session_id);
            }
        }
        JsonClaudeEvent::SessionTitleChanged(change) => {
            if let Some(session) = state.sessions.get_mut(&change.session_id) {
                session.title = Some(change.title);
            }
        }
        JsonClaudeEvent::SessionStateChanged(change) => {
            if let Some(session) = state.sessions.get_mut(&change.session_id) {
                session.state = change.state;
                if let Some(Some(code)) = change.exit_code {
                    session.exit_code = Some(code);
                }
                if let Some(Some(reason)) = change.exit_reason {
                    session.exit_reason = Some(reason);
                }
            }
        }
        JsonClaudeEvent::EntryAppended(append) => {
            if let Some(session) = state.sessions.get_mut(&append.session_id) {
                session.entries.push(*append.entry);
            }
        }
        JsonClaudeEvent::EntriesSeeded(seed) => {
            if let Some(session) = state.sessions.get_mut(&seed.session_id) {
                session.entries = seed.entries;
                session.entries_hydrated = true;
            }
        }
        JsonClaudeEvent::AssistantTextDelta(delta) => {
            helpers::apply_block_text_delta(state, delta, JsonClaudeBlockType::Text);
        }
        JsonClaudeEvent::AssistantThinkingDelta(delta) => {
            helpers::apply_block_text_delta(state, delta, JsonClaudeBlockType::Thinking);
        }
        JsonClaudeEvent::AssistantBlockAppended(append) => {
            if let Some(entry) = helpers::entry_mut(state, &append.session_id, &append.entry_id) {
                entry.blocks.get_or_insert_with(Vec::new).push(append.block);
            }
        }
        JsonClaudeEvent::AssistantEntryFinalized(finalize) => {
            if let Some(entry) = helpers::entry_mut(state, &finalize.session_id, &finalize.entry_id)
            {
                entry.is_partial = None;
                entry.blocks = Some(finalize.blocks);
            }
        }
        JsonClaudeEvent::ToolResultAttached(result) => {
            if let Some(session) = state.sessions.get_mut(&result.session_id) {
                let entry = helpers::tool_result_entry(session, result, now);
                session.entries.push(entry);
            }
        }
        JsonClaudeEvent::BusyChanged(change) => {
            if let Some(session) = state.sessions.get_mut(&change.session_id) {
                session.busy = change.busy;
            }
        }
        JsonClaudeEvent::SessionCleared(clear) => {
            if state.sessions.shift_remove(&clear.session_id).is_some() {
                state
                    .pending_approvals
                    .retain(|_, req| req.session_id != clear.session_id);
            }
        }
        JsonClaudeEvent::ApprovalRequested(req) => {
            state.pending_approvals.insert(req.request_id.clone(), *req);
        }
        JsonClaudeEvent::ApprovalResolved(resolve) => {
            state.pending_approvals.shift_remove(&resolve.request_id);
        }
        JsonClaudeEvent::ApprovalAutoApproved(approval) => {
            if let Some(session) = state.sessions.get_mut(&approval.session_id) {
                session.auto_approved_decisions.insert(
                    approval.tool_use_id,
                    JsonClaudeAutoApprovedDecision {
                        model: approval.model,
                        reason: approval.reason,
                        timestamp: approval.timestamp,
                    },
                );
            }
        }
        JsonClaudeEvent::ApprovalAutoReviewFinished(finish) => {
            if let Some(req) = state.pending_approvals.get_mut(&finish.request_id) {
                req.auto_review = Some(AutoReviewStatus {
                    state: AutoReviewState::Finished,
                    decision: Some(finish.decision),
                    reason: Some(finish.reason),
                    model: finish.model,
                });
            }
        }
        JsonClaudeEvent::PermissionModeChanged(change) => {
            if let Some(session) = state.sessions.get_mut(&change.session_id) {
                session.permission_mode = change.mode;
            }
        }
        JsonClaudeEvent::UserEntriesUnqueued(unqueue) => {
            if let Some(session) = state.sessions.get_mut(&unqueue.session_id) {
                for entry in &mut session.entries {
                    if entry.is_queued == Some(true) {
                        entry.is_queued = None;
                    }
                }
            }
        }
        JsonClaudeEvent::UserEntryUnqueued(target) => {
            if let Some(session) = state.sessions.get_mut(&target.session_id)
                && let Some(entry) = session
                    .entries
                    .iter_mut()
                    .find(|e| e.entry_id == target.entry_id && e.is_queued == Some(true))
            {
                entry.is_queued = None;
            }
        }
        JsonClaudeEvent::EntryRemoved(target) => {
            if let Some(session) = state.sessions.get_mut(&target.session_id) {
                session.entries.retain(|e| e.entry_id != target.entry_id);
            }
        }
        JsonClaudeEvent::EntriesTruncated(truncate) => {
            if let Some(session) = state.sessions.get_mut(&truncate.session_id)
                && let Some(idx) = session
                    .entries
                    .iter()
                    .position(|e| e.entry_id == truncate.from_entry_id)
            {
                session.entries.truncate(idx);
            }
        }
        JsonClaudeEvent::SlashCommandsChanged(change) => {
            if let Some(session) = state.sessions.get_mut(&change.session_id) {
                session.slash_commands = change.slash_commands;
            }
        }
        JsonClaudeEvent::CompactBoundaryReceived(boundary) => {
            if let Some(session) = state.sessions.get_mut(&boundary.session_id) {
                session.entries.push(helpers::compact_entry(boundary));
            }
        }
        JsonClaudeEvent::SessionToolApprovalsGranted(grant) => {
            if let Some(session) = state.sessions.get_mut(&grant.session_id) {
                helpers::grant_tool_approvals(
                    &mut session.session_tool_approvals,
                    grant.tool_names,
                );
            }
        }
        JsonClaudeEvent::SessionToolApprovalsCleared(clear) => {
            if let Some(session) = state.sessions.get_mut(&clear.session_id) {
                match clear.tool_names {
                    None => session.session_tool_approvals.clear(),
                    Some(drop) => session
                        .session_tool_approvals
                        .retain(|name| !drop.contains(name)),
                }
            }
        }
        JsonClaudeEvent::ApprovalSessionAllowed(allowance) => {
            if let Some(session) = state.sessions.get_mut(&allowance.session_id) {
                session.session_allowed_decisions.insert(
                    allowance.tool_use_id,
                    JsonClaudeSessionAllowedDecision {
                        tool_name: allowance.tool_name,
                        timestamp: allowance.timestamp,
                    },
                );
            }
        }
        JsonClaudeEvent::CapabilitiesChanged(change) => {
            if let Some(session) = state.sessions.get_mut(&change.session_id) {
                session.capabilities = change.capabilities;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KINDS: [AgentKind; 4] = [
        AgentKind::Claude,
        AgentKind::Opencode,
        AgentKind::Codex,
        AgentKind::Pi,
    ];

    #[test]
    fn chat_runtime_available_offers_claude_always_and_acp_agents_only_behind_the_setting() {
        let expected = [
            (Some(AgentKind::Claude), false, true),
            (Some(AgentKind::Claude), true, true),
            (Some(AgentKind::Opencode), false, false),
            (Some(AgentKind::Opencode), true, true),
            (Some(AgentKind::Codex), false, false),
            (Some(AgentKind::Codex), true, true),
            (Some(AgentKind::Pi), false, false),
            (Some(AgentKind::Pi), true, false),
            (None, false, false),
            (None, true, false),
        ];
        for (kind, enabled, available) in expected {
            assert_eq!(
                chat_runtime_available(kind, enabled),
                available,
                "{kind:?} with experimental={enabled}"
            );
        }
    }

    #[test]
    fn chat_runtime_ids_are_every_agent_kind_except_pi() {
        let ids: Vec<bool> = KINDS.iter().map(|k| is_chat_runtime_id(Some(*k))).collect();
        assert_eq!(ids, [true, true, true, false]);
        assert!(!is_chat_runtime_id(None));
        assert_eq!(
            serde_json::to_value(CHAT_RUNTIME_IDS).unwrap(),
            serde_json::json!(["claude", "opencode", "codex"])
        );
    }
}
