use std::sync::Arc;

use serde_json::json;
use tatsu_core::{
    BootOptions, ClientId, ConnCtx, CoreBuilder, Env, HooksInstaller, Platform, RouterReply,
    Runtime,
};

struct PanickingInstaller;

impl HooksInstaller for PanickingInstaller {
    fn install(&self) -> Result<(), String> {
        panic!("installer exploded");
    }

    fn uninstall(&self) -> Result<(), String> {
        Ok(())
    }
}

#[tokio::test]
async fn an_installer_panic_fails_accept_and_changes_neither_config_nor_consent() {
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
    core.set_hooks_installer(Arc::new(PanickingInstaller));
    core.config().flush_sync();
    let config_before = std::fs::read_to_string(core.config().path()).ok();
    let consent = || {
        core.store()
            .read(|state| serde_json::to_value(&state.hooks).unwrap())
    };
    let consent_before = consent();

    let ctx = ConnCtx {
        client_id: ClientId("test".to_owned()),
    };
    let reply = core
        .router()
        .dispatch_request(ctx, "hooks:accept", Vec::new())
        .await
        .reply;

    assert!(
        matches!(&reply, RouterReply::Error(message) if message.contains("installer exploded")),
        "expected an error reply, got {reply:?}"
    );
    assert_eq!(core.config().pending_save(), None);
    core.config().flush_sync();
    assert_eq!(
        std::fs::read_to_string(core.config().path()).ok(),
        config_before
    );
    assert_eq!(consent(), consent_before);
    assert_eq!(consent_before, json!({"consent": "pending"}));
}
