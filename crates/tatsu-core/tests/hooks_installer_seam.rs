use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tatsu_core::{
    BootOptions, ClientId, ConnCtx, Core, CoreBuilder, Env, HooksInstaller, Platform, RouterReply,
    Runtime,
};

#[derive(Default)]
struct CountingInstaller {
    calls: Mutex<Vec<&'static str>>,
}

impl HooksInstaller for CountingInstaller {
    fn install(&self) -> Result<(), String> {
        self.calls.lock().push("install");
        Ok(())
    }

    fn uninstall(&self) -> Result<(), String> {
        self.calls.lock().push("uninstall");
        Ok(())
    }
}

fn boot(dir: &tempfile::TempDir) -> Arc<Core> {
    let env = Env {
        platform: Platform::Linux,
        home: dir.path().join("home"),
        cwd: dir.path().to_path_buf(),
        harness_data_dir: Some(dir.path().join("data").into()),
        xdg_config_home: None,
    };
    CoreBuilder::new(Runtime::Headless, env)
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default())
        .unwrap()
}

async fn request(core: &Core, channel: &str) -> Value {
    let ctx = ConnCtx {
        client_id: ClientId("test".to_owned()),
    };
    match core
        .router()
        .dispatch_request(ctx, channel, Vec::new())
        .await
        .reply
    {
        RouterReply::Value(value) => value,
        other => panic!("{channel} did not reply with a value: {other:?}"),
    }
}

#[tokio::test]
async fn accept_installs_once_uninstall_uninstalls_once_and_decline_never_calls_the_installer() {
    let dir = tempfile::tempdir().unwrap();
    let core = boot(&dir);
    let installer = Arc::new(CountingInstaller::default());
    core.set_hooks_installer(installer.clone());

    assert_eq!(request(&core, "hooks:accept").await, json!(true));
    assert_eq!(*installer.calls.lock(), ["install"]);
    assert_eq!(request(&core, "hooks:decline").await, json!(true));
    assert_eq!(*installer.calls.lock(), ["install"]);
    assert_eq!(request(&core, "hooks:uninstall").await, json!(true));
    assert_eq!(*installer.calls.lock(), ["install", "uninstall"]);
}
