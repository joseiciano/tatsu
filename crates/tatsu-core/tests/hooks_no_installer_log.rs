use serde_json::json;
use tatsu_core::{
    BootOptions, ClientId, ConnCtx, CoreBuilder, Env, Platform, RouterReply, Runtime, logs,
};

#[tokio::test]
async fn without_an_installer_accept_and_uninstall_persist_consent_and_log_the_missing_installer() {
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
    assert!(core.hooks_installer().is_none());
    let consent_on_disk = || {
        core.config().flush_sync();
        let text = std::fs::read_to_string(core.config().path()).unwrap();
        tatsu_js::parse_lenient(&text).unwrap()["hooksConsent"].clone()
    };
    let request = |channel: &'static str| {
        let ctx = ConnCtx {
            client_id: ClientId("test".to_owned()),
        };
        core.router().dispatch_request(ctx, channel, Vec::new())
    };

    assert_eq!(
        request("hooks:accept").await.reply,
        RouterReply::Value(json!(true))
    );
    assert_eq!(consent_on_disk(), json!("accepted"));
    assert_eq!(
        request("hooks:uninstall").await.reply,
        RouterReply::Value(json!(true))
    );
    assert_eq!(consent_on_disk(), json!("pending"));
    assert_eq!(
        core.store()
            .read(|state| serde_json::to_value(&state.hooks).unwrap()),
        json!({"consent": "pending"})
    );

    logs::flush();
    let log = std::fs::read_to_string(dir.path().join("data/debug.log")).unwrap();
    let lines: Vec<&str> = log
        .lines()
        .filter_map(|line| line.split_once("] ").map(|(_, rest)| rest))
        .filter(|rest| rest.starts_with("[hooks]"))
        .collect();
    assert_eq!(
        lines,
        [
            "[hooks] no hooks installer registered",
            "[hooks] no hooks installer registered"
        ]
    );
}
