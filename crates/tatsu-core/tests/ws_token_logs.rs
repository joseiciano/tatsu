use tatsu_core::{
    BootOptions, ClientId, ConnCtx, CoreBuilder, Env, Platform, RouterReply, Runtime, logs,
};

#[tokio::test]
async fn ws_token_handlers_never_write_the_token_to_a_log() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let env = Env {
        platform: Platform::Linux,
        home: dir.path().join("home"),
        cwd: dir.path().to_path_buf(),
        harness_data_dir: Some(data.clone().into()),
        xdg_config_home: None,
    };
    let core = CoreBuilder::new(Runtime::Headless, env)
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default())
        .unwrap();
    core.set_ws_bound("127.0.0.1", 41234);
    let request = |channel: &'static str| {
        let ctx = ConnCtx {
            client_id: ClientId("test".to_owned()),
        };
        core.router().dispatch_request(ctx, channel, Vec::new())
    };

    let RouterReply::Value(info) = request("config:getWsTransportInfo").await.reply else {
        panic!("getWsTransportInfo did not reply with a value");
    };
    let boot_token = info["token"].as_str().unwrap().to_owned();
    let RouterReply::Value(rotated) = request("config:rotateWsToken").await.reply else {
        panic!("rotateWsToken did not reply with a value");
    };
    let rotated = rotated.as_str().unwrap().to_owned();
    assert_eq!(rotated.len(), 64);
    assert_ne!(rotated, boot_token);
    logs::flush();

    let debug = std::fs::read_to_string(data.join("debug.log")).unwrap();
    assert!(debug.contains("[ws-transport] auth token rotated — takes effect on next launch"));
    let perf = std::fs::read_to_string(data.join("perf.log")).unwrap_or_default();
    for token in [&boot_token, &rotated] {
        assert!(
            !debug.contains(token.as_str()),
            "debug.log leaked the WS token"
        );
        assert!(
            !perf.contains(token.as_str()),
            "perf.log leaked the WS token"
        );
    }
}
