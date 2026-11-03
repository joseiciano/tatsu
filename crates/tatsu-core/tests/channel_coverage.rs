use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tatsu_core::{BootOptions, Core, CoreBuilder, Env, Platform, Router, Runtime};

const CORE_OWNER: &str = "core-server";

#[derive(Default)]
struct KindSets {
    core: BTreeSet<String>,
    others: BTreeSet<String>,
}

struct Catalog {
    requests: KindSets,
    signals: KindSets,
}

struct Registered {
    requests: Vec<String>,
    signals: Vec<String>,
}

fn kind_sets(entries: &Value) -> KindSets {
    let mut sets = KindSets::default();
    for entry in entries.as_array().expect("catalog kind is an array") {
        let name = entry["name"].as_str().expect("entry has a name").to_owned();
        if entry["owner"] == CORE_OWNER {
            sets.core.insert(name);
        } else {
            sets.others.insert(name);
        }
    }
    sets
}

fn catalog_from(json: &Value) -> Catalog {
    Catalog {
        requests: kind_sets(&json["requests"]),
        signals: kind_sets(&json["signals"]),
    }
}

fn load_catalog() -> Catalog {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire/channels.json");
    catalog_from(&tatsu_js::parse_lenient(&std::fs::read_to_string(path).unwrap()).unwrap())
}

fn built_ins() -> Registered {
    let router = Router::new();
    Registered {
        requests: router.request_names(),
        signals: router.signal_names(),
    }
}

fn kind_failures(
    kind: &str,
    catalog: &KindSets,
    registered: &[String],
    built_ins: &[String],
) -> Vec<String> {
    let registered: BTreeSet<&String> = registered.iter().collect();
    let mut failures: Vec<String> = catalog
        .core
        .iter()
        .filter(|name| !registered.contains(name))
        .map(|name| format!("missing core {kind} {name}"))
        .collect();
    for name in registered {
        if catalog.core.contains(name) || built_ins.contains(name) {
            continue;
        }
        if catalog.others.contains(name) {
            failures.push(format!(
                "core registers {kind} {name}, which the catalog gives to another module"
            ));
        } else {
            failures.push(format!(
                "core registers {kind} {name}, which the catalog does not list"
            ));
        }
    }
    failures
}

fn coverage_failures(
    catalog: &Catalog,
    registered: &Registered,
    built_ins: &Registered,
) -> Vec<String> {
    let mut failures = kind_failures(
        "request",
        &catalog.requests,
        &registered.requests,
        &built_ins.requests,
    );
    failures.extend(kind_failures(
        "signal",
        &catalog.signals,
        &registered.signals,
        &built_ins.signals,
    ));
    failures
}

fn boot(data_dir: &Path) -> Arc<Core> {
    let env = Env {
        platform: Platform::Linux,
        home: data_dir.to_path_buf(),
        cwd: data_dir.to_path_buf(),
        harness_data_dir: Some(data_dir.into()),
        xdg_config_home: None,
    };
    CoreBuilder::new(Runtime::Headless, env)
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default())
        .unwrap()
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn synthetic_catalog() -> Catalog {
    catalog_from(&serde_json::json!({
        "requests": [
            {"name": "config:setA", "owner": "core-server"},
            {"name": "config:setB", "owner": "core-server"},
            {"name": "pty:write", "owner": "terminals"}
        ],
        "signals": [
            {"name": "perf:logSlowRender", "owner": "core-server"},
            {"name": "terminal:input", "owner": "terminals"}
        ]
    }))
}

#[tokio::test]
async fn core_registers_exactly_the_catalog_core_channels_plus_router_built_ins() {
    let dir = tempfile::tempdir().unwrap();
    let core = boot(dir.path());
    let registered = Registered {
        requests: core.router().request_names(),
        signals: core.router().signal_names(),
    };
    let catalog = load_catalog();

    let failures = coverage_failures(&catalog, &registered, &built_ins());

    assert!(
        failures.is_empty(),
        "channel coverage gate failed:\n{}\n\ncatalog core requests: {:?}\ncatalog core signals: {:?}\nregistered requests: {:?}\nregistered signals: {:?}",
        failures.join("\n"),
        catalog.requests.core,
        catalog.signals.core,
        registered.requests,
        registered.signals,
    );
    core.shutdown().await;
}

#[test]
fn router_built_ins_are_exactly_transport_get_client_id() {
    let built_ins = built_ins();
    assert_eq!(built_ins.requests, names(&["transport:getClientId"]));
    assert!(built_ins.signals.is_empty());
}

#[test]
fn a_missing_core_registration_is_named() {
    let registered = Registered {
        requests: names(&["config:setA"]),
        signals: names(&["perf:logSlowRender"]),
    };
    assert_eq!(
        coverage_failures(&synthetic_catalog(), &registered, &built_ins()),
        vec!["missing core request config:setB"]
    );
}

#[test]
fn registering_another_modules_channel_or_an_unlisted_one_fails_but_built_ins_pass() {
    let registered = Registered {
        requests: names(&[
            "config:setA",
            "config:setB",
            "pty:write",
            "transport:getClientId",
            "x:unlisted",
        ]),
        signals: names(&["perf:logSlowRender", "terminal:input"]),
    };
    assert_eq!(
        coverage_failures(&synthetic_catalog(), &registered, &built_ins()),
        vec![
            "core registers request pty:write, which the catalog gives to another module",
            "core registers request x:unlisted, which the catalog does not list",
            "core registers signal terminal:input, which the catalog gives to another module",
        ]
    );
}

#[test]
fn a_core_signal_registered_as_a_request_fails_both_ways() {
    let registered = Registered {
        requests: names(&["config:setA", "config:setB", "perf:logSlowRender"]),
        signals: Vec::new(),
    };
    assert_eq!(
        coverage_failures(&synthetic_catalog(), &registered, &built_ins()),
        vec![
            "core registers request perf:logSlowRender, which the catalog does not list",
            "missing core signal perf:logSlowRender",
        ]
    );
}
