#[allow(dead_code)]
#[path = "handler_fixtures/runner.rs"]
mod runner;

use serde_json::{Value, json};

use runner::{CaseResult, cases_in, repo_root, run_case};

fn recorded(file: &str, name: &str) -> Value {
    cases_in(&repo_root().join("fixtures/core/handlers").join(file))
        .into_iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("{file} has no case {name:?}"))
}

async fn assert_matches_recording_with_args(file: &str, name: &str, args: Value) {
    let mut case = recorded(file, name);
    case["args"] = args.clone();
    match run_case(&case).await {
        CaseResult::Compared { mismatched, actual } => assert!(
            mismatched.is_empty(),
            "{name} with {args}: {mismatched:?} differ\n{actual:#}"
        ),
        CaseResult::Fault(fault) => panic!("{name} with {args}: {fault}"),
    }
}

// Accepted difference: TS dispatches the raw argument (payload `1`, `"no"`, `0`, ...); the bool event carries its JS truthiness.
#[tokio::test]
async fn expanded_diagnostic_logging_with_a_truthy_non_bool_acts_as_true() {
    for args in [json!([1]), json!(["no"]), json!([{}])] {
        assert_matches_recording_with_args(
            "toggles.json",
            "setExpandedDiagnosticLoggingEnabled: true writes true",
            args,
        )
        .await;
    }
}

#[tokio::test]
async fn expanded_diagnostic_logging_with_a_falsy_non_bool_acts_as_false() {
    for args in [json!([0]), json!([""]), json!([null]), json!([])] {
        assert_matches_recording_with_args(
            "toggles.json",
            "setExpandedDiagnosticLoggingEnabled: false removes a stored true",
            args,
        )
        .await;
    }
}
