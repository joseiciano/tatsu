use std::{collections::BTreeSet, fs, path::PathBuf};

use serde_json::{Value, json};
use tatsu_state::{AppState, StateEvent};

fn slice_keys() -> Vec<String> {
    let state = serde_json::to_value(AppState::default()).unwrap();
    state.as_object().unwrap().keys().cloned().collect()
}

fn corpus() -> Vec<(String, Vec<Value>)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/wire");
    slice_keys()
        .into_iter()
        .map(|key| {
            let path = dir.join(format!("{key}.json"));
            let text =
                fs::read_to_string(&path).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
            let cases = serde_json::from_str(&text)
                .unwrap_or_else(|err| panic!("{}: {err}", path.display()));
            (key, cases)
        })
        .collect()
}

fn coverage_errors(corpus: &[(String, Vec<Value>)]) -> Vec<String> {
    let variants: BTreeSet<String> = StateEvent::type_names().into_iter().collect();
    let mut covered = BTreeSet::new();
    let mut errors = Vec::new();
    for (key, cases) in corpus {
        for case in cases {
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            match case["event"]["type"].as_str() {
                Some(kind) if variants.contains(kind) => {
                    if kind.split_once('/').is_some_and(|(slice, _)| slice == key) {
                        covered.insert(kind.to_string());
                    }
                }
                Some(kind) => errors.push(format!(
                    "{key}.json case `{name}` has unknown event type `{kind}`"
                )),
                None => errors.push(format!("{key}.json case `{name}` has no event type")),
            }
        }
    }
    errors.extend(
        variants
            .difference(&covered)
            .map(|kind| format!("event type `{kind}` has no fixture case")),
    );
    errors
}

#[test]
fn every_state_event_variant_has_a_fixture_case() {
    let errors = coverage_errors(&corpus());
    assert!(errors.is_empty(), "\n{}", errors.join("\n"));
}

#[test]
fn a_variant_with_no_case_is_named() {
    let mut corpus = corpus();
    let (_, cases) = corpus.iter_mut().find(|(key, _)| key == "snooze").unwrap();
    cases.retain(|case| case["event"]["type"] != "snooze/clear");
    assert_eq!(
        coverage_errors(&corpus),
        ["event type `snooze/clear` has no fixture case"]
    );
}

#[test]
fn a_case_with_an_unknown_event_type_is_named() {
    let mut corpus = corpus();
    let (_, cases) = corpus.iter_mut().find(|(key, _)| key == "snooze").unwrap();
    cases
        .push(json!({ "name": "renamed", "event": { "type": "snooze/renamed", "payload": "/a" } }));
    assert_eq!(
        coverage_errors(&corpus),
        ["snooze.json case `renamed` has unknown event type `snooze/renamed`"]
    );
}
