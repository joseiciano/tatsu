use serde_json::{Value, json};
use tatsu_state::AppState;
use tatsu_state::slices::onboarding::QuestStep;
use tatsu_state::slices::terminals::AgentKind;

use super::{SeedHook, build_with_report, constants::*};
use crate::config::{ConfigDoc, ConfigView};

fn view(config: Value) -> ConfigView {
    let Value::Object(map) = config else {
        panic!("config must be an object")
    };
    ConfigView::new(ConfigDoc::from_map(map))
}

fn build(config: Value, hooks: &[SeedHook]) -> (AppState, Vec<String>) {
    let mut reported = Vec::new();
    let state = build_with_report(&view(config), false, hooks, &mut |key| {
        reported.push(key.to_owned())
    });
    (state, reported)
}

#[test]
fn wrong_typed_hotkeys_fall_back_to_null_and_report() {
    for hotkeys in [json!("x"), json!(["a"]), json!({"newTab": 1}), json!(true)] {
        let (state, reported) = build(json!({ "hotkeys": hotkeys }), &[]);
        assert_eq!(state.settings.hotkeys, None, "{hotkeys}");
        assert_eq!(reported, ["hotkeys"], "{hotkeys}");
    }
}

#[test]
fn wrong_typed_truthy_values_of_or_fields_fall_back_to_their_defaults() {
    let (state, reported) = build(
        json!({
            "themeLight": 5,
            "defaultAgent": "gemini",
            "terminalFontSize": "14",
            "worktreeBase": "upstream",
            "claudeEnvVars": {"K": 1},
            "claudeModel": true,
            "repoRoots": "/repo",
        }),
        &[],
    );
    let s = &state.settings;
    assert_eq!(s.theme_light, DEFAULT_LIGHT_THEME);
    assert_eq!(s.default_agent, AgentKind::Claude);
    assert_eq!(s.terminal_font_size, DEFAULT_TERMINAL_FONT_SIZE);
    assert_eq!(s.worktree_base, DEFAULT_WORKTREE_BASE);
    assert!(s.claude_env_vars.is_empty());
    assert_eq!(s.claude_model, None);
    assert!(state.worktrees.repo_roots.is_empty());
    assert_eq!(
        reported,
        [
            "themeLight",
            "defaultAgent",
            "claudeEnvVars",
            "terminalFontSize",
            "worktreeBase",
            "claudeModel",
            "repoRoots"
        ]
    );
}

#[test]
fn wrong_typed_falsy_values_of_nullish_fields_fall_back_to_their_defaults() {
    for config in [
        json!({"onboarding": {"quest": ""}, "nameClaudeSessions": "", "wsTransportPort": "", "wsTransportHost": 0}),
        json!({"onboarding": {"quest": "bogus"}, "nameClaudeSessions": 0, "wsTransportPort": false, "wsTransportHost": false}),
    ] {
        let (state, reported) = build(config.clone(), &[]);
        assert_eq!(state.onboarding.quest, QuestStep::Hidden, "{config}");
        assert!(!state.settings.name_claude_sessions, "{config}");
        assert_eq!(
            state.settings.ws_transport_port, DEFAULT_WS_TRANSPORT_PORT,
            "{config}"
        );
        assert_eq!(
            state.settings.ws_transport_host, DEFAULT_WS_TRANSPORT_HOST,
            "{config}"
        );
        assert_eq!(
            reported,
            [
                "nameClaudeSessions",
                "wsTransportPort",
                "wsTransportHost",
                "onboarding.quest"
            ],
            "{config}"
        );
    }
}

#[test]
fn wrong_typed_slice_seeds_fall_back_and_keep_the_valid_parts() {
    let (state, reported) = build(
        json!({
            "costs": {"byTerminal": "x"},
            "snooze": {"/wt": {"path": "/wt"}},
            "scratchpadNotes": {"/repo": "text", "/repo/b": {"/wt/b": "kept"}},
        }),
        &[],
    );
    assert!(state.costs.by_terminal.is_empty());
    assert!(state.snooze.by_path.is_empty());
    assert_eq!(state.scratchpad.by_worktree_path.len(), 1);
    assert_eq!(state.scratchpad.by_worktree_path["/wt/b"], "kept");
    assert_eq!(reported, ["costs", "snooze", "scratchpadNotes"]);
}

#[test]
fn costs_with_unknown_keys_are_reported() {
    let (state, reported) = build(json!({"costs": {"byTerminal": {}, "extra": 1}}), &[]);
    assert!(state.costs.by_terminal.is_empty());
    assert_eq!(reported, ["costs"]);
}

#[test]
fn valid_config_reports_nothing() {
    let (_, reported) = build(
        json!({"hotkeys": {"a": "Cmd+A"}, "wsTransportPort": 0, "wsTransportHost": "", "nameClaudeSessions": false, "autoSleepMinutes": "5"}),
        &[],
    );
    assert!(reported.is_empty());
}

#[test]
fn seed_hooks_run_in_registration_order_after_the_core_rules() {
    let hooks: Vec<SeedHook> = vec![
        Box::new(|view: &ConfigView, state: &mut AppState| {
            assert_eq!(state.settings.theme_dark, "nord");
            let dir = view
                .get_raw("harnessConfigSourceDir")
                .and_then(Value::as_str);
            state.settings.harness_config_source_dir = dir.map(|d| format!("{d}/first"));
        }),
        Box::new(|_: &ConfigView, state: &mut AppState| {
            let first = state.settings.harness_config_source_dir.take().unwrap();
            state.settings.harness_config_source_dir = Some(format!("{first}/second"));
        }),
    ];
    let (state, _) = build(
        json!({"themeDark": "nord", "harnessConfigSourceDir": "/cfg"}),
        &hooks,
    );
    assert_eq!(
        state.settings.harness_config_source_dir.as_deref(),
        Some("/cfg/first/second")
    );
}

#[test]
fn without_hooks_the_root_settings_keep_their_initial_values() {
    let (state, _) = build(
        json!({"harnessConfigRoots": {"claudeAgents": "/a"}, "harnessConfigSourceDir": "/cfg"}),
        &[],
    );
    assert!(state.settings.harness_config_roots.0.is_empty());
    assert_eq!(state.settings.harness_config_source_dir, None);
}
