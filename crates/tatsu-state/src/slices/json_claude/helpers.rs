use super::{
    JsonClaudeBlockType, JsonClaudeChatEntry, JsonClaudeCompactBoundary, JsonClaudeEntryKind,
    JsonClaudeMessageBlock, JsonClaudeSession, JsonClaudeState, JsonClaudeTextDelta,
    JsonClaudeToolResult,
};

pub(super) fn entry_mut<'a>(
    state: &'a mut JsonClaudeState,
    session_id: &str,
    entry_id: &str,
) -> Option<&'a mut JsonClaudeChatEntry> {
    state
        .sessions
        .get_mut(session_id)?
        .entries
        .iter_mut()
        .find(|entry| entry.entry_id == entry_id)
}

pub(super) fn apply_block_text_delta(
    state: &mut JsonClaudeState,
    delta: JsonClaudeTextDelta,
    block_type: JsonClaudeBlockType,
) {
    if delta.text_delta.is_empty() {
        return;
    }
    let Some(entry) = entry_mut(state, &delta.session_id, &delta.entry_id) else {
        return;
    };
    let Some(block) = entry
        .blocks
        .iter_mut()
        .flatten()
        .rev()
        .find(|block| block.block_type == block_type)
    else {
        return;
    };
    block
        .text
        .get_or_insert_with(String::new)
        .push_str(&delta.text_delta);
}

fn bare_entry(entry_id: String, kind: JsonClaudeEntryKind, timestamp: i64) -> JsonClaudeChatEntry {
    JsonClaudeChatEntry {
        entry_id,
        kind,
        timestamp,
        blocks: None,
        text: None,
        compact_trigger: None,
        compact_pre_tokens: None,
        compact_post_tokens: None,
        is_partial: None,
        is_queued: None,
        images: None,
        parent_tool_use_id: None,
        error_kind: None,
        error_message: None,
        auth_methods: None,
        exit_was_clean: None,
        transcript_uuid: None,
        api_message_id: None,
        rate_limit_detail: None,
    }
}

pub(super) fn tool_result_entry(
    session: &JsonClaudeSession,
    result: JsonClaudeToolResult,
    now: i64,
) -> JsonClaudeChatEntry {
    let entry_id = format!(
        "{}-tr-{}-{}",
        session.session_id,
        result.tool_use_id,
        session.entries.len()
    );
    JsonClaudeChatEntry {
        blocks: Some(vec![JsonClaudeMessageBlock {
            block_type: JsonClaudeBlockType::ToolResult,
            text: None,
            id: None,
            name: None,
            input: None,
            tool_use_id: Some(result.tool_use_id),
            content: Some(result.content),
            is_error: Some(result.is_error),
        }]),
        ..bare_entry(entry_id, JsonClaudeEntryKind::ToolResult, now)
    }
}

pub(super) fn compact_entry(boundary: JsonClaudeCompactBoundary) -> JsonClaudeChatEntry {
    JsonClaudeChatEntry {
        compact_trigger: boundary.trigger,
        compact_pre_tokens: boundary.pre_tokens,
        compact_post_tokens: boundary.post_tokens,
        ..bare_entry(
            boundary.entry_id,
            JsonClaudeEntryKind::Compact,
            boundary.timestamp,
        )
    }
}

pub(super) fn grant_tool_approvals(approvals: &mut Vec<String>, tool_names: Vec<String>) {
    if tool_names.iter().all(|name| approvals.contains(name)) {
        return;
    }
    let mut granted: Vec<String> = Vec::with_capacity(approvals.len() + tool_names.len());
    for name in approvals.drain(..).chain(tool_names) {
        if !granted.contains(&name) {
            granted.push(name);
        }
    }
    *approvals = granted;
}
