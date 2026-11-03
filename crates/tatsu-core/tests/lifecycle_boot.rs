use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use tatsu_core::secrets::{FileBackend, OsRandom, Secrets};
use tatsu_core::{BootOptions, Core, CoreBuilder, Env, Platform, Runtime};

fn env(data_dir: &Path) -> Env {
    Env {
        platform: Platform::Linux,
        home: data_dir.to_path_buf(),
        cwd: data_dir.to_path_buf(),
        harness_data_dir: Some(data_dir.into()),
        xdg_config_home: None,
    }
}

fn boot(data_dir: &Path) -> Arc<Core> {
    CoreBuilder::new(Runtime::Headless, env(data_dir))
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default())
        .unwrap()
}

fn write_config(data_dir: &Path, config: &Value) {
    std::fs::write(data_dir.join("config.json"), tatsu_js::stringify(config)).unwrap();
}

fn wire_state(core: &Core) -> Value {
    let snapshot = core
        .store()
        .snapshot_with(|json, _| tatsu_js::parse_lenient(json).unwrap());
    snapshot["state"].clone()
}

fn fixture_cases() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/core/config/initial-state.json");
    let Value::Array(cases) =
        tatsu_js::parse_lenient(&std::fs::read_to_string(path).unwrap()).unwrap()
    else {
        panic!("fixture is not an array");
    };
    cases
}

fn holds_root_settings(config: &Map<String, Value>) -> bool {
    config.contains_key("harnessConfigRoots") || config.contains_key("harnessConfigSourceDir")
}

#[tokio::test]
async fn boot_on_a_real_config_file_gives_the_recorded_initial_state() {
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in fixture_cases() {
        let mut config = case["config"].as_object().unwrap().clone();
        if holds_root_settings(&config) {
            continue;
        }
        config.insert("schemaVersion".into(), json!(9));
        let dir = tempfile::tempdir().unwrap();
        write_config(dir.path(), &Value::Object(config));
        if case["hasGithubToken"] == true {
            FileBackend::open(dir.path(), Arc::new(OsRandom))
                .unwrap()
                .set("githubToken", "ghp_test");
        }

        let core = boot(dir.path());

        let actual = wire_state(&core);
        let mut expected = case["expected"].clone();
        // The recording is buildInitialAppState; boot then loads each repo root's .harness.json (none exist here).
        for root in expected["worktrees"]["repoRoots"]
            .as_array()
            .unwrap()
            .clone()
        {
            expected["repoConfigs"]["byRepo"][root.as_str().unwrap()] = json!({});
        }
        if actual != expected {
            failures.push(format!(
                "{}:\n- {}\n+ {}",
                case["name"],
                tatsu_js::stringify(&expected),
                tatsu_js::stringify(&actual)
            ));
        }
        checked += 1;
    }
    assert!(checked > 50, "only {checked} cases checked");
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[tokio::test]
async fn boot_migrates_an_old_config_before_building_state() {
    let dir = tempfile::tempdir().unwrap();
    write_config(dir.path(), &json!({"repoRoot": "/repo"}));

    let core = boot(dir.path());

    assert_eq!(
        wire_state(&core)["worktrees"]["repoRoots"],
        json!(["/repo"])
    );
    assert_eq!(core.config().get_raw("schemaVersion"), Some(json!(9)));
    assert_eq!(core.config().get_raw("repoRoots"), Some(json!(["/repo"])));
}

#[tokio::test]
async fn boot_with_injected_secrets_and_clock_uses_them() {
    struct Memory;
    impl Secrets for Memory {
        fn get(&self, _: &str) -> Option<String> {
            None
        }
        fn set(&self, _: &str, _: &str) -> bool {
            false
        }
        fn has(&self, key: &str) -> bool {
            key == "githubToken"
        }
        fn delete(&self, _: &str) {}
    }
    let dir = tempfile::tempdir().unwrap();

    let core = CoreBuilder::new(Runtime::Headless, env(dir.path()))
        .pre_runtime()
        .unwrap()
        .boot(
            Vec::new(),
            BootOptions {
                secrets: Some(Arc::new(Memory)),
                clock: Arc::new(|| 1_700_000_000_000),
                ..BootOptions::default()
            },
        )
        .unwrap();

    assert_eq!(wire_state(&core)["settings"]["hasGithubToken"], true);
    assert_eq!(core.now_ms(), 1_700_000_000_000);
    assert_eq!(
        core.config().get_raw("connections").unwrap()[0]["addedAt"],
        json!(1_700_000_000_000_i64)
    );
    assert!(!dir.path().join(".secret-key").exists());
}

#[tokio::test]
async fn reducers_that_read_time_see_the_injected_clock() {
    let dir = tempfile::tempdir().unwrap();
    let core = CoreBuilder::new(Runtime::Headless, env(dir.path()))
        .pre_runtime()
        .unwrap()
        .boot(
            Vec::new(),
            BootOptions {
                clock: Arc::new(|| 1_700_000_000_123),
                ..BootOptions::default()
            },
        )
        .unwrap();
    for event in [
        json!({"type": "jsonClaude/sessionStarted", "payload": {"sessionId": "s", "worktreePath": "/tmp/wt", "agentKind": "claude", "runtimeId": "claude"}}),
        json!({"type": "jsonClaude/toolResultAttached", "payload": {"sessionId": "s", "toolUseId": "tu", "content": "ok", "isError": false}}),
    ] {
        core.store()
            .dispatch(serde_json::from_value(event).unwrap());
    }
    let last = core
        .store()
        .read(|state| serde_json::to_value(&state.json_claude.sessions["s"].entries).unwrap());
    assert_eq!(
        last.as_array().unwrap().last().unwrap()["timestamp"],
        json!(1_700_000_000_123_i64)
    );
}

#[tokio::test]
async fn boot_lists_the_custom_themes_in_the_first_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("themes")).unwrap();
    std::fs::write(
        dir.path().join("themes/Ocean Deep.json"),
        r##"{"name": "Ocean", "mode": "dark", "colors": {"background": "#001122"}}"##,
    )
    .unwrap();

    let core = boot(dir.path());

    assert_eq!(
        wire_state(&core)["settings"]["customThemes"],
        json!([{"id": "ocean-deep", "name": "Ocean", "mode": "dark", "colors": {"background": "#001122"}}])
    );
}

#[tokio::test]
async fn boot_continues_when_the_themes_path_cannot_be_read() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("themes"), "not a folder").unwrap();

    let core = boot(dir.path());

    assert_eq!(wire_state(&core)["settings"]["customThemes"], json!([]));
    assert!(core.router().has_request("config:reloadCustomThemes"));
}

#[tokio::test]
async fn boot_loads_every_repo_root_config_in_one_dispatch() {
    let empty = tempfile::tempdir().unwrap();
    write_config(empty.path(), &json!({"schemaVersion": 9, "repoRoots": []}));
    let baseline = boot(empty.path());

    let dir = tempfile::tempdir().unwrap();
    let with_file = dir.path().join("with-file");
    let without_file = dir.path().join("without-file");
    std::fs::create_dir(&with_file).unwrap();
    std::fs::create_dir(&without_file).unwrap();
    std::fs::write(
        with_file.join(".harness.json"),
        r#"{"version": 1, "setupCommand": "pnpm i", "mergeStrategy": "bogus"}"#,
    )
    .unwrap();
    let roots = [
        with_file.to_string_lossy().into_owned(),
        without_file.to_string_lossy().into_owned(),
    ];
    let data = tempfile::tempdir().unwrap();
    write_config(
        data.path(),
        &json!({"schemaVersion": 9, "repoRoots": roots}),
    );

    let core = boot(data.path());

    let mut expected = Map::new();
    expected.insert(
        roots[0].clone(),
        json!({"version": 1, "setupCommand": "pnpm i"}),
    );
    expected.insert(roots[1].clone(), json!({}));
    assert_eq!(
        wire_state(&core)["repoConfigs"]["byRepo"],
        Value::Object(expected)
    );
    assert_eq!(core.store().seq(), baseline.store().seq());
    assert_eq!(
        core.repo_configs().load(&roots[0]).setup_command.as_deref(),
        Some("pnpm i")
    );
}
