use tatsu_core::{BootOptions, CoreBuilder, Env, Platform, Runtime};

#[tokio::test]
async fn a_panicking_shutdown_step_writes_a_lifecycle_line_and_the_next_step_runs() {
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
    let (tx, rx) = std::sync::mpsc::channel();
    core.on_shutdown("pty-kill", || async { panic!("pty manager gone") });
    core.on_shutdown("after", move || async move { tx.send(()).unwrap() });

    core.shutdown().await;

    assert!(rx.try_recv().is_ok());
    let log = std::fs::read_to_string(dir.path().join("debug.log")).unwrap();
    let line = log
        .lines()
        .find(|line| line.contains("[lifecycle]"))
        .expect("no lifecycle line in debug.log");
    assert!(
        line.ends_with(
            r#"] [lifecycle] shutdown step failed {"step":"pty-kill","error":"pty manager gone"}"#
        ),
        "{line}"
    );
}
