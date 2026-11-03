use serde_json::{Value, json};

use super::{WsCli, WsSettings, resolve};
use crate::config::{ConfigDoc, ConfigView};
use crate::data_dir::Runtime;

fn config(value: Value) -> ConfigView {
    match value {
        Value::Object(map) => ConfigView::new(ConfigDoc::from_map(map)),
        _ => panic!("config must be an object"),
    }
}

fn run(runtime: Runtime, cli: WsCli, env: &[(&str, &str)], cfg: Value) -> WsSettings {
    let env: Vec<(String, String)> = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let lookup = move |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    resolve(runtime, cli, &lookup, &config(cfg))
}

fn desktop(env: &[(&str, &str)], cfg: Value) -> WsSettings {
    run(Runtime::DesktopPackaged, WsCli::default(), env, cfg)
}

fn cli_port(port: i64) -> WsCli {
    WsCli {
        port: Some(port),
        host: None,
    }
}

fn cli_host(host: &str) -> WsCli {
    WsCli {
        port: None,
        host: Some(host.to_owned()),
    }
}

#[test]
fn headless_is_always_enabled() {
    let s = run(
        Runtime::Headless,
        WsCli::default(),
        &[],
        json!({"wsTransportEnabled": false}),
    );
    assert!(s.enabled);
}

#[test]
fn desktop_is_enabled_only_by_config_true_or_env_one() {
    assert!(!desktop(&[], json!({})).enabled);
    assert!(!run(Runtime::DesktopDev, WsCli::default(), &[], json!({})).enabled);
    assert!(desktop(&[], json!({"wsTransportEnabled": true})).enabled);
    assert!(desktop(&[("HARNESS_WS_TRANSPORT", "1")], json!({})).enabled);
}

#[test]
fn enabled_uses_strict_equality_not_truthiness() {
    assert!(!desktop(&[], json!({"wsTransportEnabled": 1})).enabled);
    assert!(!desktop(&[], json!({"wsTransportEnabled": "true"})).enabled);
    assert!(!desktop(&[("HARNESS_WS_TRANSPORT", "true")], json!({})).enabled);
    assert!(!desktop(&[("HARNESS_WS_TRANSPORT", " 1")], json!({})).enabled);
}

#[test]
fn cli_port_zero_wins_over_env_and_config() {
    let s = run(
        Runtime::Headless,
        cli_port(0),
        &[("HARNESS_WS_PORT", "5000")],
        json!({"wsTransportPort": 6000}),
    );
    assert_eq!(s.port, 0.0);
}

#[test]
fn negative_cli_port_falls_through_to_env() {
    let s = run(
        Runtime::Headless,
        cli_port(-1),
        &[("HARNESS_WS_PORT", "5000")],
        json!({}),
    );
    assert_eq!(s.port, 5000.0);
}

#[test]
fn absent_cli_port_uses_env_parsed_with_parse_int() {
    assert_eq!(
        desktop(
            &[("HARNESS_WS_PORT", "  5001abc")],
            json!({"wsTransportPort": 6000})
        )
        .port,
        5001.0
    );
}

#[test]
fn env_port_zero_and_junk_fall_through_to_config() {
    let cfg = json!({"wsTransportPort": 6000});
    assert_eq!(
        desktop(&[("HARNESS_WS_PORT", "0")], cfg.clone()).port,
        6000.0
    );
    assert_eq!(
        desktop(&[("HARNESS_WS_PORT", "junk")], cfg.clone()).port,
        6000.0
    );
    assert_eq!(
        desktop(&[("HARNESS_WS_PORT", "-5")], cfg.clone()).port,
        6000.0
    );
    assert_eq!(desktop(&[("HARNESS_WS_PORT", "")], cfg).port, 6000.0);
}

#[test]
fn config_port_is_used_when_cli_and_env_are_absent() {
    assert_eq!(desktop(&[], json!({"wsTransportPort": 6000})).port, 6000.0);
}

#[test]
fn config_port_nullish_uses_default_but_other_values_pass_through() {
    assert_eq!(desktop(&[], json!({})).port, 37291.0);
    assert_eq!(desktop(&[], json!({"wsTransportPort": null})).port, 37291.0);
    assert_eq!(desktop(&[], json!({"wsTransportPort": 0})).port, 0.0);
    assert_eq!(
        desktop(&[], json!({"wsTransportPort": "8080"})).port,
        8080.0
    );
}

#[test]
fn host_prefers_cli_then_env_then_config_then_loopback() {
    let cfg = json!({"wsTransportHost": "10.0.0.3"});
    let env = [("HARNESS_WS_HOST", "10.0.0.2")];
    assert_eq!(
        run(Runtime::Headless, cli_host("10.0.0.1"), &env, cfg.clone()).host,
        "10.0.0.1"
    );
    assert_eq!(desktop(&env, cfg.clone()).host, "10.0.0.2");
    assert_eq!(desktop(&[], cfg).host, "10.0.0.3");
    assert_eq!(desktop(&[], json!({})).host, "127.0.0.1");
}

#[test]
fn empty_host_at_each_level_falls_through() {
    let s = run(
        Runtime::Headless,
        cli_host(""),
        &[("HARNESS_WS_HOST", "")],
        json!({"wsTransportHost": ""}),
    );
    assert_eq!(s.host, "127.0.0.1");
}

#[test]
fn falsy_config_host_of_another_type_falls_back_to_loopback() {
    assert_eq!(
        desktop(&[], json!({"wsTransportHost": false})).host,
        "127.0.0.1"
    );
    assert_eq!(
        desktop(&[], json!({"wsTransportHost": 0})).host,
        "127.0.0.1"
    );
}
