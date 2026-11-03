use serde_json::json;
use tatsu_core::config::{ConfigDoc, ConfigView};
use tatsu_core::{DataDir, build_initial_state, logs};

#[test]
fn a_wrong_typed_hotkeys_value_writes_a_config_debug_line() {
    let tmp = tempfile::TempDir::new().unwrap();
    logs::init(&DataDir::from_path(tmp.path()).unwrap());
    let serde_json::Value::Object(map) = json!({"hotkeys": "x"}) else {
        unreachable!()
    };

    let state = build_initial_state(&ConfigView::new(ConfigDoc::from_map(map)), false, &[]);

    assert_eq!(state.settings.hotkeys, None);
    let log = std::fs::read_to_string(tmp.path().join("debug.log")).unwrap();
    assert!(log.contains(
        "[config] initial state: config value for hotkeys has the wrong type; using the default"
    ));
}
