use std::os::unix::fs::PermissionsExt;
use std::process::Command;

use tatsu_core::{CoreBuilder, Env, Platform, Runtime};

const WORKER_ENV: &str = "TATSU_PATH_FIX_WORKER_DIR";
const STRIPPED_PATH: &str = "/usr/bin:/bin";

// The worker runs in its own process with a marker shell as SHELL, so the
// test never touches this process's PATH or the user's login shell.
#[test]
fn path_fix_default_builder_runs_no_probe_and_keeps_path() {
    let dir = tempfile::tempdir().unwrap();
    let shell = dir.path().join("marker.sh");
    std::fs::write(
        &shell,
        format!(
            "#!/bin/sh\ntouch '{}/probed'\nprintf '__HARNESS_PATH_BEGIN__\\n/opt/fake/bin\\n__HARNESS_PATH_END__\\n'\n",
            dir.path().display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();

    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "path_fix_worker",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env_clear()
        .env("PATH", STRIPPED_PATH)
        .env("HOME", dir.path())
        .env("SHELL", &shell)
        .env(WORKER_ENV, dir.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!dir.path().join("probed").exists());
    let log = std::fs::read_to_string(dir.path().join("data/debug.log")).unwrap_or_default();
    assert!(!log.contains("[path-fix]"), "{log}");
}

#[test]
fn path_fix_worker() {
    let Some(dir) = std::env::var_os(WORKER_ENV) else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let env = Env {
        platform: Platform::MacOs,
        home: dir.clone(),
        cwd: dir.clone(),
        harness_data_dir: Some(dir.join("data").into()),
        xdg_config_home: None,
    };
    let pre = CoreBuilder::new(Runtime::Headless, env)
        .pre_runtime()
        .unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let _guard = runtime.enter();
    let core = pre
        .boot(Vec::new(), tatsu_core::BootOptions::default())
        .unwrap();
    assert_eq!(core.merged_path(), STRIPPED_PATH);
    assert_eq!(std::env::var("PATH").unwrap(), STRIPPED_PATH);
}
