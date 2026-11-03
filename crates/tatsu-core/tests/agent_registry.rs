use std::collections::BTreeSet;
use std::path::Path;

use serde_json::{Value, json};
use tatsu_core::agent_registry::{
    AGENT_REGISTRY, CLAUDE_MODELS, CODEX_MODELS, agent_display_name, cycle_alt_agent,
    get_agent_info, get_next_agent_kind, is_harness_config_capability_enabled,
    resource_path_for_name, template_output_for,
};
use tatsu_state::slices::harness_config::HarnessConfigResourceType;
use tatsu_state::slices::terminals::AgentKind;

const ALL_KINDS: [AgentKind; 4] = [
    AgentKind::Claude,
    AgentKind::Codex,
    AgentKind::Opencode,
    AgentKind::Pi,
];
const ALL_RESOURCE_TYPES: [HarnessConfigResourceType; 3] = [
    HarnessConfigResourceType::Agents,
    HarnessConfigResourceType::Skills,
    HarnessConfigResourceType::Commands,
];

fn cases() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/core/helpers/agent-registry.json");
    let text = std::fs::read_to_string(&path).unwrap();
    match serde_json::from_str(&text).unwrap() {
        Value::Array(cases) => cases,
        other => panic!("fixture is not an array: {other}"),
    }
}

fn first_difference(path: &str, expected: &Value, actual: &Value) -> Option<String> {
    match (expected, actual) {
        (Value::Object(e), Value::Object(a)) => {
            let keys: BTreeSet<&String> = e.keys().chain(a.keys()).collect();
            keys.into_iter()
                .find_map(|key| match (e.get(key), a.get(key)) {
                    (Some(ev), Some(av)) => first_difference(&format!("{path}.{key}"), ev, av),
                    (Some(ev), None) => {
                        Some(format!("{path}.{key}: expected {ev}, missing in Rust"))
                    }
                    (None, Some(av)) => Some(format!("{path}.{key}: not in TS, Rust has {av}")),
                    (None, None) => None,
                })
        }
        (Value::Array(e), Value::Array(a)) if e.len() == a.len() => e
            .iter()
            .zip(a)
            .enumerate()
            .find_map(|(i, (ev, av))| first_difference(&format!("{path}[{i}]"), ev, av)),
        _ if expected == actual => None,
        _ => Some(format!("{path}: expected {expected}, Rust gave {actual}")),
    }
}

fn assert_agrees(path: &str, expected: &Value, actual: Value) {
    if let Some(diff) = first_difference(path, expected, &actual) {
        panic!("{diff}");
    }
}

fn kind(case: &Value) -> Option<AgentKind> {
    case.get("kind")
        .map(|kind| serde_json::from_value(kind.clone()).unwrap())
}

fn resource_type(case: &Value) -> HarnessConfigResourceType {
    serde_json::from_value(case["resourceType"].clone()).unwrap()
}

fn rust_result(case: &Value) -> Value {
    let name = case["name"].as_str().unwrap();
    let required = || kind(case).unwrap_or_else(|| panic!("{name}: missing kind"));
    match case["fn"].as_str().unwrap() {
        "registry" => json!({
            "agentRegistry": AGENT_REGISTRY,
            "claudeModels": CLAUDE_MODELS,
            "codexModels": CODEX_MODELS,
        }),
        "getAgentInfo" => json!(get_agent_info(required())),
        "agentDisplayName" => json!(agent_display_name(kind(case))),
        "isHarnessConfigCapabilityEnabled" => {
            let resource_type = resource_type(case);
            let capability = get_agent_info(required())
                .config_capabilities
                .iter()
                .find(|entry| entry.resource_type == resource_type)
                .unwrap();
            json!(is_harness_config_capability_enabled(capability))
        }
        "resourcePathForName" => json!(resource_path_for_name(
            required(),
            resource_type(case),
            case["resourceName"].as_str().unwrap(),
        )),
        "templateOutputFor" => json!(template_output_for(required(), resource_type(case))),
        "getNextAgentKind" => json!(get_next_agent_kind(required())),
        "cycleAltAgent" => json!(cycle_alt_agent(
            required(),
            usize::try_from(case["clickCount"].as_u64().unwrap()).unwrap(),
        )),
        other => panic!("{name}: unknown fn {other}"),
    }
}

fn cases_for<'a>(cases: &'a [Value], func: &'a str) -> impl Iterator<Item = &'a Value> {
    cases.iter().filter(move |case| case["fn"] == func)
}

#[test]
fn registry_and_model_lists_match_the_recorded_ts_values() {
    let cases = cases();
    let registry: Vec<&Value> = cases_for(&cases, "registry").collect();
    assert_eq!(registry.len(), 1);
    assert_agrees(
        "registry",
        &registry[0]["expected"],
        rust_result(registry[0]),
    );
}

#[test]
fn every_ported_function_matches_every_recorded_ts_result() {
    let cases = cases();
    let mut checked = 0;
    for case in cases.iter().filter(|case| case["fn"] != "registry") {
        let name = case["name"].as_str().unwrap();
        assert!(case.get("expected").is_some(), "{name}: not recorded");
        assert_agrees(name, &case["expected"], rust_result(case));
        checked += 1;
    }
    assert!(checked > 0);
}

#[test]
fn fixture_covers_every_agent_kind_and_resource_type_for_each_function() {
    let cases = cases();
    for func in [
        "getAgentInfo",
        "agentDisplayName",
        "getNextAgentKind",
        "cycleAltAgent",
    ] {
        for expected in ALL_KINDS {
            assert!(
                cases_for(&cases, func).any(|case| kind(case) == Some(expected)),
                "{func} has no case for {expected:?}"
            );
        }
    }
    assert!(cases_for(&cases, "agentDisplayName").any(|case| kind(case).is_none()));
    for func in [
        "isHarnessConfigCapabilityEnabled",
        "resourcePathForName",
        "templateOutputFor",
    ] {
        for expected_kind in ALL_KINDS {
            for expected_type in ALL_RESOURCE_TYPES {
                assert!(
                    cases_for(&cases, func).any(|case| kind(case) == Some(expected_kind)
                        && resource_type(case) == expected_type),
                    "{func} has no case for {expected_kind:?} {expected_type:?}"
                );
            }
        }
    }
    let alt_count = ALL_KINDS.len() - 1;
    assert!(
        cases_for(&cases, "cycleAltAgent")
            .any(|case| case["clickCount"].as_u64().unwrap() as usize > alt_count)
    );
}
