use std::fs;

use tatsu_core::secrets::desktop::Unavailable;
use tatsu_core::secrets::{DesktopBackend, Secrets};
use tatsu_core::{DataDir, Platform, logs};

#[test]
fn secrets_set_without_a_key_store_writes_the_safe_storage_log_line() {
    let tmp = tempfile::TempDir::new().unwrap();
    let data_dir = DataDir::from_path(tmp.path()).unwrap();
    logs::init(&data_dir);
    let store = DesktopBackend::new(tmp.path(), Platform::MacOs, Box::new(Unavailable));

    assert!(!store.set("githubToken", "ghp_secret-value"));

    let log = fs::read_to_string(tmp.path().join("debug.log")).unwrap();
    let line = log
        .lines()
        .find(|line| line.contains("[secrets]"))
        .expect("no secrets line in debug.log");
    assert!(
        line.ends_with("] [secrets] safeStorage encryption not available, refusing to store"),
        "{line}"
    );
    assert!(!log.contains("ghp_secret-value"));
}
