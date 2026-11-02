use serde::{Deserialize, Serialize};
use specta::Type;

use crate::slices::{
    announcements::{self, AnnouncementsEvent, AnnouncementsState},
    browser::{self, BrowserEvent, BrowserState},
    costs::{self, CostsEvent, CostsState},
    harness_config::{self, HarnessConfigEvent, HarnessConfigState},
    hooks::{self, HooksEvent, HooksState},
    json_claude::{self, JsonClaudeEvent, JsonClaudeState},
    onboarding::{self, OnboardingEvent, OnboardingState},
    prs::{self, PRsEvent, PRsState},
    repo_configs::{self, RepoConfigsEvent, RepoConfigsState},
    runtimes::{self, RuntimesEvent, RuntimesState},
    scratchpad::{self, ScratchpadEvent, ScratchpadState},
    settings::{self, SettingsEvent, SettingsState},
    snooze::{self, SnoozeEvent, SnoozeState},
    terminals::{self, TerminalsEvent, TerminalsState},
    updater::{self, UpdaterEvent, UpdaterState},
    worktrees::{self, WorktreesEvent, WorktreesState},
};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct AppState {
    pub settings: SettingsState,
    pub prs: PRsState,
    pub onboarding: OnboardingState,
    pub hooks: HooksState,
    pub worktrees: WorktreesState,
    pub terminals: TerminalsState,
    pub updater: UpdaterState,
    pub repo_configs: RepoConfigsState,
    pub costs: CostsState,
    pub browser: BrowserState,
    pub json_claude: JsonClaudeState,
    pub snooze: SnoozeState,
    pub runtimes: RuntimesState,
    pub announcements: AnnouncementsState,
    pub scratchpad: ScratchpadState,
    pub harness_config: HarnessConfigState,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum StateEvent {
    Settings(SettingsEvent),
    Prs(PRsEvent),
    Onboarding(OnboardingEvent),
    Hooks(HooksEvent),
    Worktrees(WorktreesEvent),
    Terminals(TerminalsEvent),
    Updater(UpdaterEvent),
    RepoConfigs(RepoConfigsEvent),
    Costs(CostsEvent),
    Browser(BrowserEvent),
    JsonClaude(JsonClaudeEvent),
    Snooze(SnoozeEvent),
    Runtimes(RuntimesEvent),
    Announcements(AnnouncementsEvent),
    Scratchpad(ScratchpadEvent),
    HarnessConfig(HarnessConfigEvent),
}

pub fn root_reduce(state: &mut AppState, event: StateEvent, now: i64) {
    match event {
        StateEvent::Settings(event) => settings::reduce(&mut state.settings, event),
        StateEvent::Prs(event) => prs::reduce(&mut state.prs, event),
        StateEvent::Onboarding(event) => onboarding::reduce(&mut state.onboarding, event),
        StateEvent::Hooks(event) => hooks::reduce(&mut state.hooks, event),
        StateEvent::Worktrees(event) => worktrees::reduce(&mut state.worktrees, event),
        StateEvent::Terminals(event) => terminals::reduce(&mut state.terminals, event),
        StateEvent::Updater(event) => updater::reduce(&mut state.updater, event),
        StateEvent::RepoConfigs(event) => repo_configs::reduce(&mut state.repo_configs, event),
        StateEvent::Costs(event) => costs::reduce(&mut state.costs, event),
        StateEvent::Browser(event) => browser::reduce(&mut state.browser, event),
        StateEvent::JsonClaude(event) => json_claude::reduce(&mut state.json_claude, event, now),
        StateEvent::Snooze(event) => snooze::reduce(&mut state.snooze, event),
        StateEvent::Runtimes(event) => runtimes::reduce(&mut state.runtimes, event),
        StateEvent::Announcements(event) => announcements::reduce(&mut state.announcements, event),
        StateEvent::Scratchpad(event) => scratchpad::reduce(&mut state.scratchpad, event),
        StateEvent::HarnessConfig(event) => {
            harness_config::reduce(&mut state.harness_config, event)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn non_default_state() -> AppState {
        serde_json::from_value(json!({
            "prs": { "byPath": { "/a": null }, "mergedByPath": { "/a": true }, "loading": false },
            "onboarding": { "quest": "finale" },
            "hooks": { "consent": "accepted" },
            "worktrees": {
                "list": [{ "path": "/a", "branch": "a", "head": "h", "isBare": false, "isMain": true, "createdAt": 1.5, "repoRoot": "/r" }],
                "repoRoots": ["/r"],
                "pending": [{ "id": "pending:1", "repoRoot": "/r", "branchName": "b", "status": "creating" }],
                "pendingDeletions": [{ "path": "/a", "repoRoot": "/r", "branch": "a", "phase": "running-teardown" }]
            },
            "terminals": {
                "statuses": { "t1": "idle" },
                "pendingTools": { "t1": null },
                "shellActivity": { "t1": { "active": false } },
                "progress": { "t1": { "state": 1, "value": 10 } },
                "panes": { "/a": { "type": "split", "id": "s1", "direction": "horizontal", "ratio": 0.5, "children": [
                    { "type": "leaf", "id": "p1", "activeTabId": "a1", "tabs": [
                        { "id": "a1", "type": "agent", "label": "A", "agentKind": "claude" },
                        { "id": "c1", "type": "json-claude", "label": "C", "agentKind": "codex", "sessionId": "c1", "mode": "awake" },
                        { "id": "sh", "type": "shell", "label": "zsh", "mode": "asleep" }
                    ] },
                    { "type": "leaf", "id": "p2", "activeTabId": "", "tabs": [] }
                ] } },
                "lastActive": { "/a": 1 },
                "sessions": { "t1": { "controllerClientId": "c1", "spectatorClientIds": ["c2"], "size": { "cols": 80, "rows": 24 } } }
            },
            "updater": { "status": { "state": "checking" } },
            "repoConfigs": { "byRepo": { "/a": { "setupCommand": "make", "hiddenRightPanels": { "pr": true } } } },
            "costs": { "byTerminal": { "t1": { "sessionId": "s1", "transcriptPath": "/t", "byModel": {}, "breakdown": { "text": 0.5, "thinking": 0, "toolUse": 0, "userPrompt": 0, "assistantEcho": 0, "toolResults": {} }, "currentModel": null, "updatedAt": 1 } } },
            "browser": { "byTab": { "b1": { "url": "x", "title": "X", "canGoBack": true, "canGoForward": false, "loading": false } } },
            "jsonClaude": {
                "sessions": { "s1": {
                    "sessionId": "s1", "worktreePath": "/a", "agentKind": "codex", "runtimeId": "codex", "state": "running",
                    "exitCode": null, "exitReason": null,
                    "entries": [
                        { "entryId": "u1", "kind": "user", "text": "hi", "timestamp": 1, "isQueued": true },
                        { "entryId": "a1", "kind": "assistant", "timestamp": 2, "isPartial": true, "blocks": [
                            { "type": "thinking", "text": "t" }, { "type": "text", "text": "x" }
                        ] }
                    ],
                    "entriesHydrated": true, "busy": false, "permissionMode": "default", "slashCommands": [],
                    "autoApprovedDecisions": {}, "sessionToolApprovals": ["Edit"], "sessionAllowedDecisions": {},
                    "capabilities": { "canInterrupt": true, "canRewind": false, "canSetPermissionMode": false, "canApproveTools": false, "canResume": true, "canOpenAuthLogin": false, "hasSlashCommands": false, "hasCostTracking": false }
                } },
                "pendingApprovals": { "r1": { "requestId": "r1", "sessionId": "s1", "toolName": "Bash", "input": {}, "timestamp": 1 } }
            },
            "snooze": { "byPath": { "/a": { "path": "/a", "snoozedAt": 1, "wakeAt": 2 } } },
            "runtimes": { "byAgent": { "codex": { "state": "bundled" } } },
            "announcements": { "items": [], "lastFetched": 1, "lastError": "old" },
            "scratchpad": { "byWorktreePath": { "/a": "note" } },
            "harnessConfig": {
                "resources": {
                    "agents": [],
                    "skills": [{ "id": "s1", "agentKind": "claude", "resourceType": "skills", "canonicalResourceType": "skills", "aliasResourceTypes": [], "label": "S", "relativePath": "skills/s1.md", "absolutePath": "/s1", "hash": "h", "existsOnDisk": true, "managed": true, "updatedAt": 1.5 }],
                    "commands": []
                },
                "comparisons": { "claude:skills": { "scope": { "agentKind": "claude", "resourceType": "skills" }, "status": "synced", "configOnly": [], "changed": [], "comparedAt": 1 } },
                "loading": false,
                "error": "old",
                "lastScannedAt": 1,
                "lastSyncedAt": 1,
                "templates": {
                    "templates": [{ "kind": "agent", "name": "a", "description": "", "fragments": [], "body": "", "harnesses": { "claude": { "frontmatter": { "z": 1, "a": 2 } }, "codex": false }, "references": [], "relativePath": "agents/a.md", "hash": "h" }],
                    "fragments": [{ "name": "f", "content": "c", "relativePath": "fragments/f.md", "hash": "h" }],
                    "errors": [{ "relativePath": "agents/b.md", "message": "bad" }],
                    "loadedAt": 1
                },
                "templateSyncNotice": { "scopes": ["claude:agents"], "changedAt": 1 }
            }
        }))
        .unwrap()
    }

    #[test]
    fn each_event_changes_only_its_own_slice() {
        let cases = [
            (
                "settings",
                json!({"type": "settings/themeModeChanged", "payload": "dark"}),
            ),
            (
                "settings",
                json!({"type": "settings/themeLightChanged", "payload": "github-light"}),
            ),
            (
                "settings",
                json!({"type": "settings/themeDarkChanged", "payload": "dracula"}),
            ),
            (
                "settings",
                json!({"type": "settings/customThemesChanged", "payload": [{"id": "night-owl", "name": "Night Owl", "mode": "dark", "colors": {"surface": "#011627", "accent": "#82aaff", "base": "#000"}}, {"id": "paper", "name": "Paper", "mode": "light", "colors": {}}]}),
            ),
            (
                "settings",
                json!({"type": "settings/hotkeysChanged", "payload": {"tab.new": "Cmd+T", "pane.split": "Cmd+D", "app.settings": "Cmd+,"}}),
            ),
            (
                "settings",
                json!({"type": "settings/defaultAgentChanged", "payload": "opencode"}),
            ),
            (
                "settings",
                json!({"type": "settings/claudeCommandChanged", "payload": "claude --verbose"}),
            ),
            (
                "settings",
                json!({"type": "settings/codexCommandChanged", "payload": "codex --full-auto"}),
            ),
            (
                "settings",
                json!({"type": "settings/opencodeCommandChanged", "payload": "opencode"}),
            ),
            (
                "settings",
                json!({"type": "settings/worktreeScriptsChanged", "payload": {"setup": "pnpm install", "teardown": "rm -rf node_modules"}}),
            ),
            (
                "settings",
                json!({"type": "settings/claudeEnvVarsChanged", "payload": {"ZED": "1", "ANTHROPIC_LOG": "debug"}}),
            ),
            (
                "settings",
                json!({"type": "settings/codexEnvVarsChanged", "payload": {"OPENAI_LOG": "info"}}),
            ),
            (
                "settings",
                json!({"type": "settings/opencodeEnvVarsChanged", "payload": {"OPENCODE_X": "y", "A": "b"}}),
            ),
            (
                "settings",
                json!({"type": "settings/harnessMcpEnabledChanged", "payload": false}),
            ),
            (
                "settings",
                json!({"type": "settings/nameClaudeSessionsChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/terminalFontFamilyChanged", "payload": "JetBrains Mono"}),
            ),
            (
                "settings",
                json!({"type": "settings/terminalFontSizeChanged", "payload": 16}),
            ),
            (
                "settings",
                json!({"type": "settings/editorChanged", "payload": "cursor"}),
            ),
            (
                "settings",
                json!({"type": "settings/worktreeBaseChanged", "payload": "local"}),
            ),
            (
                "settings",
                json!({"type": "settings/mergeStrategyChanged", "payload": "fast-forward"}),
            ),
            (
                "settings",
                json!({"type": "settings/worktreeDetailChanged", "payload": "none"}),
            ),
            (
                "settings",
                json!({"type": "settings/shareClaudeSettingsChanged", "payload": false}),
            ),
            (
                "settings",
                json!({"type": "settings/hasGithubTokenChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/githubAuthSourceChanged", "payload": "gh-cli"}),
            ),
            (
                "settings",
                json!({"type": "settings/viewerLoginChanged", "payload": "octocat"}),
            ),
            (
                "settings",
                json!({"type": "settings/harnessStarredChanged", "payload": false}),
            ),
            (
                "settings",
                json!({"type": "settings/claudeModelChanged", "payload": "claude-opus-4"}),
            ),
            (
                "settings",
                json!({"type": "settings/codexModelChanged", "payload": "gpt-5-codex"}),
            ),
            (
                "settings",
                json!({"type": "settings/opencodeModelChanged", "payload": "anthropic/claude-sonnet"}),
            ),
            (
                "settings",
                json!({"type": "settings/autoUpdateEnabledChanged", "payload": false}),
            ),
            (
                "settings",
                json!({"type": "settings/experimentalChatAgentsEnabledChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/harnessSystemPromptEnabledChanged", "payload": false}),
            ),
            (
                "settings",
                json!({"type": "settings/harnessSystemPromptChanged", "payload": "You are in a worktree.\nBe brief."}),
            ),
            (
                "settings",
                json!({"type": "settings/harnessSystemPromptMainChanged", "payload": "You are on main."}),
            ),
            (
                "settings",
                json!({"type": "settings/claudeTuiFullscreenChanged", "payload": false}),
            ),
            (
                "settings",
                json!({"type": "settings/wsTransportEnabledChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/wsTransportPortChanged", "payload": 40000}),
            ),
            (
                "settings",
                json!({"type": "settings/wsTransportHostChanged", "payload": "0.0.0.0"}),
            ),
            (
                "settings",
                json!({"type": "settings/browserToolsEnabledChanged", "payload": false}),
            ),
            (
                "settings",
                json!({"type": "settings/browserToolsModeChanged", "payload": "view"}),
            ),
            (
                "settings",
                json!({"type": "settings/defaultClaudeTabTypeChanged", "payload": "json"}),
            ),
            (
                "settings",
                json!({"type": "settings/defaultOpencodeTabTypeChanged", "payload": "json"}),
            ),
            (
                "settings",
                json!({"type": "settings/defaultCodexTabTypeChanged", "payload": "json"}),
            ),
            (
                "settings",
                json!({"type": "settings/chatPromotionDismissedChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/autoApprovePermissionsChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/autoApproveSteerInstructionsChanged", "payload": "approve pnpm install"}),
            ),
            (
                "settings",
                json!({"type": "settings/useSystemClaudeForJsonModeChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/jsonModeChatDensityChanged", "payload": "comfy"}),
            ),
            (
                "settings",
                json!({"type": "settings/uiScaleChanged", "payload": "x-large"}),
            ),
            (
                "settings",
                json!({"type": "settings/jsonModeSendOnEnterChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/jsonModeDefaultPermissionModeChanged", "payload": "plan"}),
            ),
            (
                "settings",
                json!({"type": "settings/autoSleepMinutesChanged", "payload": 0}),
            ),
            (
                "settings",
                json!({"type": "settings/snoozeDefaultDaysChanged", "payload": 14}),
            ),
            (
                "settings",
                json!({"type": "settings/expandedDiagnosticLoggingEnabledChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/prReviewPromptChanged", "payload": "Check the tests."}),
            ),
            (
                "settings",
                json!({"type": "settings/announcementDismissed", "payload": "b"}),
            ),
            (
                "settings",
                json!({"type": "settings/announcementsMutedChanged", "payload": true}),
            ),
            (
                "settings",
                json!({"type": "settings/piCommandChanged", "payload": "pi --fast"}),
            ),
            (
                "settings",
                json!({"type": "settings/piEnvVarsChanged", "payload": {"PI_HOME": "/p"}}),
            ),
            (
                "settings",
                json!({"type": "settings/piModelChanged", "payload": "pi-large"}),
            ),
            (
                "settings",
                json!({"type": "settings/harnessConfigRootsChanged", "payload": {"key": "claudeAgents", "path": "/c/agents"}}),
            ),
            (
                "settings",
                json!({"type": "settings/harnessConfigSourceDirChanged", "payload": "/templates"}),
            ),
            (
                "prs",
                json!({ "type": "prs/statusChanged", "payload": { "path": "/b", "status": null } }),
            ),
            (
                "prs",
                json!({ "type": "prs/bulkStatusChanged", "payload": {} }),
            ),
            (
                "prs",
                json!({ "type": "prs/mergedChanged", "payload": { "/a": false } }),
            ),
            (
                "prs",
                json!({ "type": "prs/loadingChanged", "payload": true }),
            ),
            (
                "onboarding",
                json!({ "type": "onboarding/questChanged", "payload": "done" }),
            ),
            (
                "hooks",
                json!({ "type": "hooks/consentChanged", "payload": "declined" }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/listChanged", "payload": [] }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/reposChanged", "payload": ["/r", "/s"] }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/pendingAdded", "payload": { "id": "pending:2", "repoRoot": "/r", "branchName": "c", "status": "setup" } }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/pendingUpdated", "payload": { "id": "pending:1", "patch": { "status": "error", "error": "boom" } } }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/pendingRemoved", "payload": "pending:1" }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/pendingDeletionStarted", "payload": { "path": "/b", "repoRoot": "/r", "branch": "b", "phase": "removing-worktree" } }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/pendingDeletionUpdated", "payload": { "path": "/a", "patch": { "teardownLog": "out" } } }),
            ),
            (
                "worktrees",
                json!({ "type": "worktrees/pendingDeletionRemoved", "payload": "/a" }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/statusChanged", "payload": { "id": "t2", "status": "processing", "pendingTool": null } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/shellActivityChanged", "payload": { "id": "t1", "active": true, "processName": "vim" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/progressChanged", "payload": { "id": "t1", "state": 0, "value": 0 } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/removed", "payload": "t1" }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/panesReplaced", "payload": {} }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/panesForWorktreeChanged", "payload": { "worktreePath": "/b", "panes": { "type": "leaf", "id": "pb", "activeTabId": "", "tabs": [] } } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/panesForWorktreeCleared", "payload": "/a" }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/lastActiveChanged", "payload": { "worktreePath": "/a", "ts": 2 } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/paneRatioChanged", "payload": { "worktreePath": "/a", "splitId": "s1", "ratio": 0.3 } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/sessionIdDiscovered", "payload": { "terminalId": "a1", "sessionId": "sess" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/controlTaken", "payload": { "terminalId": "t1", "clientId": "c3", "cols": 80, "rows": 24 } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/controlReleased", "payload": { "terminalId": "t1", "clientId": "c1" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/clientJoined", "payload": { "terminalId": "t2", "clientId": "c1" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/clientDisconnected", "payload": { "clientId": "c2" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/sizeChanged", "payload": { "terminalId": "t1", "cols": 100, "rows": 30 } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/tabTypeChanged", "payload": { "worktreePath": "/a", "tabId": "a1", "newId": "n1", "newType": "json-claude", "newLabel": "Chat", "agentKind": "claude" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/tabAgentSessionIdChanged", "payload": { "worktreePath": "/a", "tabId": "c1", "agentSessionId": "acp" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/tabSlept", "payload": { "worktreePath": "/a", "tabId": "c1" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/tabWoken", "payload": { "worktreePath": "/a", "tabId": "sh" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/tabRenamed", "payload": { "worktreePath": "/a", "tabId": "a1", "label": "Mine" } }),
            ),
            (
                "terminals",
                json!({ "type": "terminals/tabLabelChanged", "payload": { "worktreePath": "/a", "tabId": "a1", "label": "New" } }),
            ),
            (
                "updater",
                json!({ "type": "updater/statusChanged", "payload": { "state": "not-available" } }),
            ),
            (
                "repoConfigs",
                json!({ "type": "repoConfigs/loaded", "payload": { "/b": {} } }),
            ),
            (
                "repoConfigs",
                json!({ "type": "repoConfigs/changed", "payload": { "repoRoot": "/a", "config": { "rightPanelOrder": ["cost", "pr"] } } }),
            ),
            (
                "repoConfigs",
                json!({ "type": "repoConfigs/removed", "payload": "/a" }),
            ),
            (
                "costs",
                json!({ "type": "costs/usageUpdated", "payload": { "terminalId": "t2", "usage": { "sessionId": "s2", "transcriptPath": "/t", "byModel": { "m": { "messages": 1, "input": 2, "output": 3, "cacheRead": 4, "cacheWrite": 5, "cost": 0.25 } }, "breakdown": { "text": 0.1, "thinking": 0, "toolUse": 0, "userPrompt": 0, "assistantEcho": 0, "toolResults": { "Bash": 0.15 } }, "currentModel": "m", "updatedAt": 2 } } }),
            ),
            (
                "costs",
                json!({ "type": "costs/terminalCleared", "payload": { "terminalId": "t1" } }),
            ),
            (
                "costs",
                json!({ "type": "costs/hydrated", "payload": { "byTerminal": {} } }),
            ),
            (
                "browser",
                json!({ "type": "browser/tabStateChanged", "payload": { "tabId": "b2", "state": {} } }),
            ),
            (
                "browser",
                json!({ "type": "browser/tabRemoved", "payload": "b1" }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/sessionStarted", "payload": { "sessionId": "s1", "worktreePath": "/a", "agentKind": "codex", "runtimeId": "codex" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/agentSessionIdChanged", "payload": { "sessionId": "s1", "agentSessionId": "thread-1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/sessionTitleChanged", "payload": { "sessionId": "s1", "title": "T" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/sessionStateChanged", "payload": { "sessionId": "s1", "state": "exited", "exitCode": 1 } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/entryAppended", "payload": { "sessionId": "s1", "entry": { "entryId": "u2", "kind": "user", "timestamp": 3 } } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/entriesSeeded", "payload": { "sessionId": "s1", "entries": [] } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/assistantTextDelta", "payload": { "sessionId": "s1", "entryId": "a1", "textDelta": "y" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/assistantThinkingDelta", "payload": { "sessionId": "s1", "entryId": "a1", "textDelta": "u" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/assistantBlockAppended", "payload": { "sessionId": "s1", "entryId": "a1", "block": { "type": "text" } } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/assistantEntryFinalized", "payload": { "sessionId": "s1", "entryId": "a1", "blocks": [] } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/toolResultAttached", "payload": { "sessionId": "s1", "toolUseId": "tu", "content": "ok", "isError": false } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/busyChanged", "payload": { "sessionId": "s1", "busy": true } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/sessionCleared", "payload": { "sessionId": "s1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/approvalRequested", "payload": { "requestId": "r2", "sessionId": "s1", "toolName": "Edit", "input": { "a": 1 }, "timestamp": 2 } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/approvalResolved", "payload": { "requestId": "r1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/approvalAutoApproved", "payload": { "sessionId": "s1", "toolUseId": "tu", "model": "m", "reason": "r", "timestamp": 2 } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/approvalAutoReviewFinished", "payload": { "requestId": "r1", "decision": "ask", "reason": "r" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/permissionModeChanged", "payload": { "sessionId": "s1", "mode": "plan" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/userEntriesUnqueued", "payload": { "sessionId": "s1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/userEntryUnqueued", "payload": { "sessionId": "s1", "entryId": "u1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/entryRemoved", "payload": { "sessionId": "s1", "entryId": "u1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/entriesTruncated", "payload": { "sessionId": "s1", "fromEntryId": "a1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/slashCommandsChanged", "payload": { "sessionId": "s1", "slashCommands": ["clear"] } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/compactBoundaryReceived", "payload": { "sessionId": "s1", "entryId": "c1", "timestamp": 4 } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/sessionToolApprovalsGranted", "payload": { "sessionId": "s1", "toolNames": ["Write"] } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/sessionToolApprovalsCleared", "payload": { "sessionId": "s1" } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/approvalSessionAllowed", "payload": { "sessionId": "s1", "toolUseId": "tu", "toolName": "Edit", "timestamp": 5 } }),
            ),
            (
                "jsonClaude",
                json!({ "type": "jsonClaude/capabilitiesChanged", "payload": { "sessionId": "s1", "capabilities": { "canInterrupt": false, "canRewind": false, "canSetPermissionMode": false, "canApproveTools": false, "canResume": true, "canOpenAuthLogin": false, "hasSlashCommands": false, "hasCostTracking": false } } }),
            ),
            (
                "snooze",
                json!({ "type": "snooze/set", "payload": { "path": "/b", "snoozedAt": 1, "wakeAt": 2.5 } }),
            ),
            ("snooze", json!({ "type": "snooze/clear", "payload": "/a" })),
            (
                "runtimes",
                json!({ "type": "runtimes/statusChanged", "payload": { "agentKind": "codex", "status": { "state": "ready", "version": "1" } } }),
            ),
            (
                "announcements",
                json!({ "type": "announcements/loaded", "payload": { "items": [], "fetchedAt": 2 } }),
            ),
            (
                "announcements",
                json!({ "type": "announcements/fetchFailed", "payload": "new" }),
            ),
            (
                "scratchpad",
                json!({ "type": "scratchpad/loaded", "payload": { "/b": "other" } }),
            ),
            (
                "scratchpad",
                json!({ "type": "scratchpad/textChanged", "payload": { "worktreePath": "/a", "text": "edited" } }),
            ),
            (
                "scratchpad",
                json!({ "type": "scratchpad/worktreeRemoved", "payload": "/a" }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/loadingChanged", "payload": true }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/resourcesLoaded", "payload": { "scope": { "agentKind": "claude", "resourceType": "skills" }, "resources": [], "scannedAt": 2 } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/comparisonLoaded", "payload": { "scope": { "agentKind": "codex", "resourceType": "agents" }, "status": "conflict", "configOnly": [], "changed": [], "comparedAt": 2 } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/syncApplied", "payload": { "scope": { "agentKind": "claude", "resourceType": "skills" }, "syncedAt": 2 } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/resourceUpserted", "payload": { "id": "s0", "agentKind": "claude", "resourceType": "skills", "canonicalResourceType": "skills", "aliasResourceTypes": [], "label": "S0", "relativePath": "skills/s0.md", "absolutePath": "/s0", "hash": "h", "existsOnDisk": false, "managed": false, "updatedAt": 2, "source": "template" } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/resourceDeleted", "payload": { "agentKind": "claude", "resourceType": "skills", "id": "s1" } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/errorChanged", "payload": null }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/templatesLoaded", "payload": { "templates": [], "errors": [], "loadedAt": 2 } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/templateChanged", "payload": { "kind": "skill", "name": "b", "description": "", "fragments": [], "body": "", "harnesses": {}, "references": [], "relativePath": "skills/b/TEMPLATE.md", "hash": "h" } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/templateRemoved", "payload": { "kind": "agent", "name": "a" } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/fragmentsLoaded", "payload": { "fragments": [], "errors": [], "loadedAt": 1 } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/fragmentChanged", "payload": { "name": "g", "content": "c", "relativePath": "fragments/g.md", "hash": "h" } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/fragmentRemoved", "payload": { "name": "f" } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/templateSyncNoticeChanged", "payload": { "scopes": ["codex:skills"], "changedAt": 1 } }),
            ),
            (
                "harnessConfig",
                json!({ "type": "harnessConfig/templateSourceErrorChanged", "payload": { "relativePath": "agents/b.md", "message": null } }),
            ),
        ];
        let before = serde_json::to_value(non_default_state()).unwrap();

        for (slice, event) in cases {
            let mut state = non_default_state();
            root_reduce(
                &mut state,
                serde_json::from_value(event.clone()).unwrap(),
                0,
            );
            let after = serde_json::to_value(&state).unwrap();

            let before_slices = before.as_object().unwrap();
            for (key, value) in after.as_object().unwrap() {
                if key == slice {
                    assert_ne!(*value, before_slices[key], "{event} did not change {slice}");
                } else {
                    assert_eq!(*value, before_slices[key], "{event} changed {key}");
                }
            }
        }
    }

    #[test]
    fn root_event_serializes_without_a_wrapper() {
        let event = StateEvent::Snooze(SnoozeEvent::Clear("/a".to_string()));
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "type": "snooze/clear", "payload": "/a" })
        );
    }

    #[test]
    fn unknown_event_type_is_rejected() {
        let parsed =
            serde_json::from_value::<StateEvent>(json!({ "type": "snooze/nope", "payload": "/a" }));
        assert!(parsed.is_err());
    }
}
