#[allow(dead_code)]
#[path = "handler_fixtures/runner.rs"]
mod runner;

use std::process::Command;

use serde_json::{Value, json};

use runner::{CaseResult, cases_in, repo_root, run_case};

const CASE_ENV: &str = "TATSU_HANDLER_RUST_ONLY_CASE";
const RESULT_MARKER: &str = "@@CASE-RESULT@@";

fn recorded(file: &str, name: &str) -> Value {
    cases_in(&repo_root().join("fixtures/core/handlers").join(file))
        .into_iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("{file} has no case {name:?}"))
}

// Each case boots in its own process: the first boot in a process owns the global logger, so concurrent cases would write their boot lines into its debug.log.
fn assert_matches_recording_with_args(file: &str, name: &str, args: Value) {
    let mut case = recorded(file, name);
    case["args"] = args.clone();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["case_worker", "--exact", "--nocapture", "--test-threads=1"])
        .env(CASE_ENV, tatsu_js::stringify(&case))
        .output()
        .expect("spawn the case worker");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let result = stdout
        .lines()
        .find_map(|line| line.split_once(RESULT_MARKER).map(|(_, json)| json))
        .map(|json| tatsu_js::parse_lenient(json).expect("worker result is JSON"))
        .unwrap_or_else(|| {
            panic!(
                "{name} with {args}: case worker gave no result (status {}):\n{stdout}\n{}",
                output.status,
                String::from_utf8_lossy(&output.stderr)
            )
        });
    if let Some(fault) = result["fault"].as_str() {
        panic!("{name} with {args}: {fault}");
    }
    let mismatched = &result["mismatched"];
    assert!(
        mismatched.as_array().is_some_and(Vec::is_empty),
        "{name} with {args}: {mismatched} differ\n{:#}",
        result["actual"]
    );
}

#[test]
fn case_worker() {
    let Ok(case) = std::env::var(CASE_ENV) else {
        return;
    };
    let case = tatsu_js::parse_lenient(&case).expect("case is JSON");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = match runtime.block_on(run_case(&case)) {
        CaseResult::Fault(message) => json!({ "fault": message }),
        CaseResult::Compared { mismatched, actual } => json!({
            "mismatched": mismatched,
            "actual": actual,
        }),
    };
    println!("{RESULT_MARKER}{}", tatsu_js::stringify(&result));
}

// Accepted difference: TS dispatches the raw argument (payload `1`, `"no"`, `0`, ...); the bool event carries its JS truthiness.
#[test]
fn expanded_diagnostic_logging_with_a_truthy_non_bool_acts_as_true() {
    for args in [json!([1]), json!(["no"]), json!([{}])] {
        assert_matches_recording_with_args(
            "toggles.json",
            "setExpandedDiagnosticLoggingEnabled: true writes true",
            args,
        );
    }
}

#[test]
fn expanded_diagnostic_logging_with_a_falsy_non_bool_acts_as_false() {
    for args in [json!([0]), json!([""]), json!([null]), json!([])] {
        assert_matches_recording_with_args(
            "toggles.json",
            "setExpandedDiagnosticLoggingEnabled: false removes a stored true",
            args,
        );
    }
}

// Accepted difference: TS dispatches the raw argument (payload `1`, `"no"`, `0`, ...); the bool event carries its JS truthiness.
#[test]
fn chat_promotion_dismissed_with_a_truthy_non_bool_acts_as_true() {
    for args in [json!([1]), json!(["no"]), json!([{}]), json!([[]])] {
        assert_matches_recording_with_args(
            "tab-types-chat-ui.json",
            "setChatPromotionDismissed: true writes the key",
            args,
        );
    }
}

#[test]
fn chat_promotion_dismissed_with_a_falsy_non_bool_acts_as_false() {
    for args in [json!([0]), json!([""]), json!([null]), json!([])] {
        assert_matches_recording_with_args(
            "tab-types-chat-ui.json",
            "setChatPromotionDismissed: false removes the stored key",
            args,
        );
    }
}

// Accepted difference: TS dispatches the raw argument (payload `1`, `"no"`, `0`, ...); the bool event carries its JS truthiness.
#[test]
fn ws_transport_enabled_with_a_truthy_non_bool_acts_as_true() {
    for args in [json!([1]), json!(["no"]), json!([{}]), json!([[]])] {
        assert_matches_recording_with_args(
            "ws.json",
            "setWsTransportEnabled: true stores the flag",
            args,
        );
    }
}

#[test]
fn ws_transport_enabled_with_a_falsy_non_bool_acts_as_false() {
    for args in [json!([0]), json!([""]), json!([null]), json!([])] {
        assert_matches_recording_with_args(
            "ws.json",
            "setWsTransportEnabled: false deletes the stored flag",
            args,
        );
    }
}

// Accepted difference: TS writes a truthy `mergeStrategy` or `hiddenRightPanels` value the strict RepoConfig type cannot hold into `.harness.json`; Rust drops it before saving.
#[test]
fn repo_config_set_drops_next_values_the_strict_type_cannot_hold() {
    assert_matches_recording_with_args(
        "repo-config.json",
        "repoConfig:set: a new file gets version first, a trimmed command and a newline",
        json!([
            "$CASE/repos/app",
            {
                "setupCommand": "  pnpm i  ",
                "mergeStrategy": "bogus",
                "version": "1",
                "hiddenRightPanels": {"sidebar": true},
                "rightPanelOrder": "x"
            }
        ]),
    );
}
