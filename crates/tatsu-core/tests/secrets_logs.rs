use std::sync::Arc;

use tatsu_core::DataDir;
use tatsu_core::logs;
use tatsu_core::secrets::{self, KEY_FILE, OsRandom, SECRETS_FILE, ws_token};

#[test]
fn secrets_never_reach_the_debug_log() {
    let tmp = tempfile::TempDir::new().unwrap();
    let dir = DataDir::from_path(tmp.path()).unwrap();
    logs::init(&dir);
    std::fs::write(tmp.path().join(KEY_FILE), [0x11; 31]).unwrap();

    let store = secrets::open_headless(&dir, Arc::new(OsRandom)).unwrap();
    store.set("githubToken", "ghp_SUPERSECRETVALUE");
    store.set("backend-token:abc", "BACKENDSECRETVALUE");
    let token = ws_token::get_or_create(store.as_ref(), &OsRandom);
    let file = std::fs::read_to_string(tmp.path().join(SECRETS_FILE)).unwrap();
    let blobs: Vec<String> = match tatsu_js::parse_lenient(&file).unwrap() {
        serde_json::Value::Object(map) => map
            .values()
            .map(|v| v.as_str().unwrap().to_owned())
            .collect(),
        other => panic!("not an object: {other}"),
    };
    std::fs::write(tmp.path().join(KEY_FILE), [0x22; 32]).unwrap();
    let reopened = secrets::open_headless(&dir, Arc::new(OsRandom)).unwrap();
    assert_eq!(reopened.get("githubToken"), None);
    std::fs::write(tmp.path().join(SECRETS_FILE), "{broken").unwrap();
    assert_eq!(reopened.get("githubToken"), None);

    let log = std::fs::read_to_string(tmp.path().join("debug.log")).unwrap();
    assert!(log.contains("[secrets] existing .secret-key is malformed; regenerating"));
    assert!(log.contains("[secrets] failed to decrypt secret githubToken"));
    assert!(log.contains("[secrets] failed to read secrets file"));
    let mut forbidden = vec![
        "ghp_SUPERSECRETVALUE".to_owned(),
        "BACKENDSECRETVALUE".to_owned(),
        token,
    ];
    forbidden.extend(blobs);
    for value in forbidden {
        assert!(!log.contains(&value), "debug.log leaked a secret");
    }
}
