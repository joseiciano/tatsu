use std::path::PathBuf;

use serde_json::{Map, Value};
use tatsu_core::config::{ConfigDoc, ConfigView};
use tatsu_core::initial_state::{SeedHook, build_initial_state, constants};
use tatsu_state::AppState;
use tatsu_state::slices::harness_config::{HarnessConfigRootKey, HarnessConfigRoots};

const ROOT_KEYS: [HarnessConfigRootKey; 8] = [
    HarnessConfigRootKey::ClaudeAgents,
    HarnessConfigRootKey::ClaudeSkills,
    HarnessConfigRootKey::ClaudeCommands,
    HarnessConfigRootKey::CodexHome,
    HarnessConfigRootKey::CodexSkills,
    HarnessConfigRootKey::OpencodeAgents,
    HarnessConfigRootKey::OpencodeSkills,
    HarnessConfigRootKey::OpencodeCommands,
];

struct Case {
    name: String,
    config: Map<String, Value>,
    has_github_token: bool,
    expected: Value,
}

fn cases() -> Vec<Case> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/core/config/initial-state.json");
    let text = std::fs::read_to_string(path).unwrap();
    let Value::Array(items) = tatsu_js::parse_lenient(&text).unwrap() else {
        panic!("fixture is not an array");
    };
    items
        .into_iter()
        .map(|item| {
            let name = item["name"].as_str().unwrap().to_owned();
            let expected = item
                .get("expected")
                .cloned()
                .unwrap_or_else(|| panic!("{name}: not recorded; run pnpm fixtures:record-core"));
            Case {
                config: item["config"].as_object().unwrap().clone(),
                has_github_token: item["hasGithubToken"].as_bool().unwrap(),
                name,
                expected,
            }
        })
        .collect()
}

fn resolve_posix(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

fn normalize_config_folder(value: Option<&Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    if trimmed.is_empty() || trimmed.contains('\0') || !trimmed.starts_with('/') {
        return None;
    }
    Some(resolve_posix(trimmed))
}

fn harness_config_test_hook() -> SeedHook {
    Box::new(|view: &ConfigView, state: &mut AppState| {
        let mut roots = HarnessConfigRoots::default();
        if let Some(Value::Object(raw)) = view.get_raw("harnessConfigRoots") {
            for key in ROOT_KEYS {
                let name = serde_json::to_value(key).unwrap();
                if let Some(folder) = normalize_config_folder(raw.get(name.as_str().unwrap())) {
                    roots.0.insert(key, folder);
                }
            }
        }
        state.settings.harness_config_roots = roots;
        state.settings.harness_config_source_dir =
            normalize_config_folder(view.get_raw("harnessConfigSourceDir"));
    })
}

fn holds_root_settings(config: &Map<String, Value>) -> bool {
    config.contains_key("harnessConfigRoots") || config.contains_key("harnessConfigSourceDir")
}

fn build(case: &Case, hooks: &[SeedHook]) -> Value {
    let view = ConfigView::new(ConfigDoc::from_map(case.config.clone()));
    serde_json::to_value(build_initial_state(&view, case.has_github_token, hooks)).unwrap()
}

fn root_fields(state: &Value) -> (Value, Value) {
    (
        state["settings"]["harnessConfigRoots"].clone(),
        state["settings"]["harnessConfigSourceDir"].clone(),
    )
}

fn without_root_fields(mut state: Value) -> Value {
    let settings = state["settings"].as_object_mut().unwrap();
    settings.remove("harnessConfigRoots");
    settings.remove("harnessConfigSourceDir");
    state
}

#[test]
fn initial_state_matches_the_recorded_ts_build() {
    let cases = cases();
    assert!(!cases.is_empty());
    let hooks = [harness_config_test_hook()];
    let mut failures = Vec::new();
    for case in &cases {
        let actual = build(case, &hooks);
        if actual != case.expected {
            failures.push(format!(
                "{}:\n- {}\n+ {}",
                case.name,
                tatsu_js::stringify(&case.expected),
                tatsu_js::stringify(&actual)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn without_a_seed_hook_the_root_settings_keep_their_initial_values() {
    let initial = serde_json::to_value(AppState::default()).unwrap();
    for case in cases() {
        let actual = build(&case, &[]);
        assert_eq!(root_fields(&actual), root_fields(&initial), "{}", case.name);
        if !holds_root_settings(&case.config) {
            assert_eq!(actual, case.expected, "{}", case.name);
        } else {
            assert_eq!(
                without_root_fields(actual),
                without_root_fields(case.expected.clone()),
                "{}",
                case.name
            );
        }
    }
}

#[test]
fn the_root_settings_case_exercises_the_hook() {
    let case = cases()
        .into_iter()
        .find(|c| c.name == "harness config roots and source dir through the seed hook")
        .unwrap();
    let (roots, source_dir) = root_fields(&case.expected);
    assert_ne!(roots, Value::Object(Map::new()));
    assert_ne!(source_dir, Value::Null);
}

#[test]
fn default_texts_are_byte_equal_to_ts() {
    let case = cases()
        .into_iter()
        .find(|c| c.name == "empty config gives every default")
        .unwrap();
    let settings = &case.expected["settings"];
    for (key, text) in [
        ("claudeCommand", constants::DEFAULT_CLAUDE_COMMAND),
        (
            "harnessSystemPrompt",
            constants::DEFAULT_HARNESS_SYSTEM_PROMPT,
        ),
        (
            "harnessSystemPromptMain",
            constants::DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
        ),
        ("prReviewPrompt", constants::DEFAULT_PR_REVIEW_PROMPT),
        (
            "terminalFontFamily",
            constants::DEFAULT_TERMINAL_FONT_FAMILY,
        ),
        ("themeLight", constants::DEFAULT_LIGHT_THEME),
        ("themeDark", constants::DEFAULT_DARK_THEME),
        ("editor", constants::DEFAULT_EDITOR_ID),
        ("worktreeBase", "remote"),
        ("mergeStrategy", "squash"),
        ("worktreeDetail", "diff"),
        ("wsTransportHost", constants::DEFAULT_WS_TRANSPORT_HOST),
    ] {
        assert_eq!(settings[key].as_str(), Some(text), "{key}");
    }
    assert_eq!(
        settings["wsTransportPort"].as_f64(),
        Some(constants::DEFAULT_WS_TRANSPORT_PORT)
    );
    assert_eq!(
        settings["terminalFontSize"].as_f64(),
        Some(constants::DEFAULT_TERMINAL_FONT_SIZE)
    );
}
