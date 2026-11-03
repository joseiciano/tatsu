use serde_json::{Value, json};
use tatsu_core::{BootOptions, ClientId, ConnCtx, CoreBuilder, Env, Platform, Runtime, logs};

#[tokio::test]
async fn activity_record_with_bad_args_is_dropped_and_logs_the_signal_error() {
    let dir = tempfile::tempdir().unwrap();
    let env = Env {
        platform: Platform::Linux,
        home: dir.path().join("home"),
        cwd: dir.path().to_path_buf(),
        harness_data_dir: Some(dir.path().join("data").into()),
        xdg_config_home: None,
    };
    let core = CoreBuilder::new(Runtime::Headless, env)
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default())
        .unwrap();
    let record = |args: Value| {
        let ctx = ConnCtx {
            client_id: ClientId("test".to_owned()),
        };
        let Value::Array(args) = args else {
            panic!("args must be an array");
        };
        core.router().dispatch_signal(ctx, "activity:record", args);
    };

    record(json!(["/w/a", "working"]));
    record(json!([7, "processing"]));

    assert_eq!(core.activity().get(), json!({}));
    logs::flush();
    let log = std::fs::read_to_string(dir.path().join("data/debug.log")).unwrap();
    let lines: Vec<&str> = log
        .lines()
        .filter_map(|line| line.split_once("] ").map(|(_, rest)| rest))
        .filter(|rest| rest.starts_with("[ws-transport]"))
        .collect();
    assert_eq!(lines.len(), 2, "{log}");
    assert_eq!(
        lines[0],
        "[ws-transport] signal handler 'activity:record' threw \"unknown variant `working`, expected one of `processing`, `waiting`, `needs-approval`, `idle`, `merged`\""
    );
    assert_eq!(
        lines[1],
        "[ws-transport] signal handler 'activity:record' threw \"invalid type: integer `7`, expected a string\""
    );
}
