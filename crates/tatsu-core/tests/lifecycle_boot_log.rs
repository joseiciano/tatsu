use tatsu_core::{BootOptions, CoreBuilder, Env, Platform, Runtime};

#[tokio::test]
async fn boot_logs_the_ts_started_line_with_the_debug_log_path() {
    let dir = tempfile::tempdir().unwrap();
    let env = Env {
        platform: Platform::Linux,
        home: dir.path().to_path_buf(),
        cwd: dir.path().to_path_buf(),
        harness_data_dir: Some(dir.path().into()),
        xdg_config_home: None,
    };
    let core = CoreBuilder::new(Runtime::Headless, env)
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default())
        .unwrap();

    let log_path = core.data_dir().path().join("debug.log");
    let log = std::fs::read_to_string(&log_path).unwrap();
    let expected = format!("[app] started, log file: {}", log_path.display());
    assert!(
        log.lines()
            .any(|line| line.get(15..) == Some(expected.as_str())),
        "no boot line in debug.log:\n{log}"
    );
}
