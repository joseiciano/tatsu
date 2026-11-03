#[path = "handler_fixtures/runner.rs"]
mod runner;

use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};
use tatsu_core::{ClientId, ConnCtx, Reply, Router, agent_kind};

use runner::{
    CaseResult, DEFAULT_WS_HOST, HOOKS_INSTALLER_ERROR, cases_in, handler_fixture_files, prepare,
    read_json, reply_of, repo_root, run_case,
};

const CASE_ENV: &str = "TATSU_HANDLER_FIXTURE_CASE";
const RESULT_MARKER: &str = "@@CASE-RESULT@@";
const ISOLATED_ENV: &str = "TATSU_HANDLER_FIXTURE_ISOLATED";

enum Pending {
    Unregistered,
    Differs(&'static [&'static str]),
}

const PENDING: &[(&str, &str, Pending)] = &[
    (
        "activityBefore: activity:clear drops one worktree",
        "ticket 30",
        Pending::Unregistered,
    ),
    (
        "ids + secrets: connections:add stores the token under the injected id",
        "ticket 31",
        Pending::Unregistered,
    ),
    (
        "worktrees: listChanged clears the removed worktree's snooze entry from config",
        "snooze prune (aux-services module) plus the boot worktree list (worktrees-git module)",
        Pending::Differs(&["configAfter", "events"]),
    ),
    (
        "kind event + setup: snooze/set persists every snoozed worktree",
        "snooze persistence (aux-services module)",
        Pending::Differs(&["configAfter"]),
    ),
];

fn case_name(case: &Value) -> &str {
    case["name"].as_str().unwrap_or("<unnamed>")
}

fn smoke_cases() -> Vec<Value> {
    cases_in(&repo_root().join("fixtures/core/handlers/smoke.json"))
}

fn smoke_case(name: &str) -> Value {
    smoke_cases()
        .into_iter()
        .find(|case| case_name(case) == name)
        .unwrap_or_else(|| panic!("smoke.json has no case {name:?}"))
}

fn run_in_worker(file: &Path, index: usize) -> Value {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["case_worker", "--exact", "--nocapture", "--test-threads=1"])
        .env(CASE_ENV, format!("{}\n{index}", file.display()))
        .output()
        .expect("spawn the case worker");
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| line.split_once(RESULT_MARKER).map(|(_, json)| json))
        .map(|json| tatsu_js::parse_lenient(json).expect("worker result is JSON"))
        .unwrap_or_else(|| {
            json!({
                "fault": format!(
                    "case worker gave no result (status {}):\n{stdout}\n{}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr)
                )
            })
        })
}

#[test]
fn handler_fixtures_match_the_ts_recording() {
    let mut failures = Vec::new();
    let mut seen = Vec::new();
    for file in handler_fixture_files() {
        for (index, case) in cases_in(&file).iter().enumerate() {
            let name = case_name(case).to_owned();
            let result = run_in_worker(&file, index);
            let pending = PENDING.iter().find(|(n, _, _)| *n == name);
            let fault = result["fault"].as_str();
            let mismatched: Vec<&str> = result["mismatched"]
                .as_array()
                .map(|fields| fields.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let detail = match fault {
                Some(fault) => format!("case {name:?}: {fault}"),
                None => result["report"].as_str().unwrap_or_default().to_owned(),
            };
            match pending {
                None if fault.is_none() && mismatched.is_empty() => {}
                None => failures.push(format!("{}: {detail}", file.display())),
                Some((_, owner, expect)) => {
                    let as_listed = match expect {
                        Pending::Unregistered => fault.is_some_and(|f| {
                            f.starts_with("no ") && f.contains(" handler registered for ")
                        }),
                        Pending::Differs(fields) => fault.is_none() && mismatched == *fields,
                    };
                    if !as_listed {
                        failures.push(format!(
                            "pending case {name:?} (waits on {owner}) no longer fails as listed; update PENDING:\n{detail}"
                        ));
                    }
                }
            }
            seen.push(name);
        }
    }
    for (name, _, _) in PENDING {
        if !seen.iter().any(|n| n == name) {
            failures.push(format!("PENDING names {name:?}, which no fixture records"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}

#[test]
fn case_worker() {
    let Ok(spec) = std::env::var(CASE_ENV) else {
        return;
    };
    let (file, index) = spec.split_once('\n').expect("case spec is file\\nindex");
    let case = cases_in(Path::new(file))
        .into_iter()
        .nth(index.parse().expect("case index"))
        .expect("case index in range");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = match runtime.block_on(run_case(&case)) {
        CaseResult::Fault(message) => json!({ "fault": message }),
        CaseResult::Compared { mismatched, actual } => json!({
            "report": runner::report(&case, &actual, &mismatched),
            "mismatched": mismatched,
        }),
    };
    println!("{RESULT_MARKER}{}", tatsu_js::stringify(&result));
}

#[tokio::test]
async fn a_reply_maps_to_the_fixture_reply_shape_like_ts_reply_of() {
    let router = Router::new();
    router
        .request("noValue", |_ctx, _args| async { Ok(Reply::NoValue) })
        .unwrap();
    router
        .request("asyncNoValue", |_ctx, _args| async {
            tokio::task::yield_now().await;
            Ok(Reply::NoValue)
        })
        .unwrap();
    router
        .request("null", |_ctx, _args| async {
            Ok(Reply::Value(Value::Null))
        })
        .unwrap();
    router
        .request("throws", |_ctx, _args| async { Err("boom".to_owned()) })
        .unwrap();
    let ctx = ConnCtx {
        client_id: ClientId("c".to_owned()),
    };
    let mut replies = Vec::new();
    for name in ["noValue", "asyncNoValue", "null", "throws"] {
        let routed = router.dispatch_request(ctx.clone(), name, Vec::new()).await;
        replies.push(reply_of(routed.reply));
    }
    assert_eq!(
        replies,
        vec![
            json!({"noValue": true}),
            json!({"noValue": true}),
            json!({"value": null}),
            json!({"error": "boom"}),
        ]
    );
}

#[test]
fn agent_kind_matches_the_ts_helper_fixtures() {
    let cases = read_json(&repo_root().join("fixtures/core/helpers/agent-kind.json"));
    let cases = cases.as_array().unwrap();
    assert!(cases.iter().any(|c| c.get("input").is_none()));
    for case in cases {
        let kind = agent_kind::parse(case.get("input").and_then(Value::as_str));
        assert_eq!(
            serde_json::to_value(kind).unwrap(),
            case["expected"],
            "case {:?}",
            case["name"]
        );
    }
}

fn files_under(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().unwrap().is_dir() {
            for (sub, bytes) in files_under(&entry.path()) {
                out.push((format!("{name}/{sub}"), bytes));
            }
        } else {
            out.push((name, std::fs::read(entry.path()).unwrap()));
        }
    }
    out.sort();
    out
}

#[tokio::test]
async fn smoke_themes_dir_is_copied_into_the_data_dir() {
    let case = smoke_case("themesDir: reloadCustomThemes reads the copied folder");
    let p = prepare(&case).unwrap();
    let source = repo_root()
        .join("fixtures/core/themes")
        .join(case["themesDir"].as_str().unwrap());
    assert!(!files_under(&source).is_empty());
    assert_eq!(
        files_under(&p.data_dir.join("themes")),
        files_under(&source)
    );
}

#[tokio::test]
async fn smoke_repo_files_are_placed_and_read_back_unchanged() {
    let case = smoke_case("repoFiles: repoConfig:set merges and writes .harness.json");
    let p = prepare(&case).unwrap();
    let files = case["repoFiles"].as_object().unwrap();
    assert!(files.values().any(Value::is_null));
    assert_eq!(p.repo_files_after(files), case["repoFiles"]);
    assert_eq!(
        p.map_case_value(&case["args"][0]),
        json!(p.repos_dir.join("app").to_string_lossy())
    );
}

#[tokio::test]
async fn smoke_activity_before_is_placed_and_read_back_unchanged() {
    let case = smoke_case("activityBefore: activity:clear drops one worktree");
    let p = prepare(&case).unwrap();
    assert_eq!(p.activity_after(), case["activityBefore"]);
}

// logs::init sets a process-global logger, so a test that reads debug.log runs in its own process where its boot owns the logger.
fn run_isolated(test: &str) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([test, "--exact", "--nocapture", "--test-threads=1"])
        .env(ISOLATED_ENV, test)
        .output()
        .expect("spawn the isolated test");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "isolated test {test} failed (status {}):\n{stdout}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn isolated(test: &str) -> bool {
    std::env::var(ISOLATED_ENV).is_ok_and(|name| name == test)
}

#[test]
fn smoke_debug_log_before_is_placed_and_its_lines_are_not_new() {
    run_isolated("isolated_debug_log_before_is_placed_and_its_lines_are_not_new");
}

#[tokio::test]
async fn isolated_debug_log_before_is_placed_and_its_lines_are_not_new() {
    if !isolated("isolated_debug_log_before_is_placed_and_its_lines_are_not_new") {
        return;
    }
    let case = smoke_case("debugLogBefore: existing lines are not new lines");
    let p = prepare(&case).unwrap();
    let before = case["debugLogBefore"].as_str().unwrap();
    let log = p.data_dir.join("debug.log");
    let content = std::fs::read_to_string(&log).unwrap();
    assert!(content.starts_with(before), "{content}");
    let header = "=== Claude Tatsu debug log session started at ";
    let lines = runner::new_log_lines(&log, 0, "debug.log");
    let header_line = lines[1]["line"].as_str().unwrap();
    assert!(
        header_line.starts_with(header)
            && header_line.ends_with("Z ===")
            && header_line.len() == header.len() + "2026-01-01T00:00:00.000Z ===".len(),
        "{header_line}"
    );
    let old = json!({"file": "debug.log", "line": "[<ts>] [old] earlier session line"});
    let boot = vec![
        json!({"file": "debug.log", "line": header_line}),
        json!({"file": "debug.log", "line": format!(
            "[<ts>] [app] started, log file: {}",
            log.display()
        )}),
    ];
    assert_eq!(lines, [vec![old], boot.clone()].concat());
    assert_eq!(
        runner::new_log_lines(&log, before.len() as u64, "debug.log"),
        boot
    );
}

#[tokio::test]
async fn smoke_secrets_before_are_seeded_and_read_back_by_name() {
    let case = smoke_case("ids + secrets: connections:add stores the token under the injected id");
    let p = prepare(&case).unwrap();
    let names = case["secretsBefore"].as_object().unwrap();
    assert!(names.values().any(Value::is_null));
    assert_eq!(p.secrets_after(names), case["secretsBefore"]);
}

#[tokio::test]
async fn smoke_ids_come_from_the_case_only_inside_the_handler() {
    let case = smoke_case("ids + secrets: connections:add stores the token under the injected id");
    let p = prepare(&case).unwrap();
    assert_eq!(p.core.new_id(), "00000000-0000-4000-8000-000000000001");
    p.faults.set_in_handler(true);
    assert_eq!(p.core.new_id(), case["ids"][0].as_str().unwrap());
    let core = p.core.clone();
    assert!(std::thread::spawn(move || core.new_id()).join().is_err());
    p.faults.set_in_handler(false);
    assert!(p.faults.take().unwrap().contains("`ids` exhausted"));
}

#[tokio::test]
async fn smoke_random_bytes_come_from_the_case_only_inside_the_handler() {
    let case = smoke_case("randomBytes: rotateWsToken uses the injected bytes");
    let p = prepare(&case).unwrap();
    let mut buf = [0u8; 32];
    p.core.random().fill(&mut buf);
    assert_eq!(buf, [0x5a; 32]);
    p.faults.set_in_handler(true);
    p.core.random().fill(&mut buf);
    assert_eq!(hex::encode(buf), case["randomBytes"][0].as_str().unwrap());
    let core = p.core.clone();
    assert!(
        std::thread::spawn(move || core.random().fill(&mut [0u8; 32]))
            .join()
            .is_err()
    );
    p.faults.set_in_handler(false);
    assert!(p.faults.take().unwrap().contains("`randomBytes` exhausted"));

    let mut short = case.clone();
    short["randomBytes"] = json!(["abab"]);
    let p = prepare(&short).unwrap();
    p.faults.set_in_handler(true);
    let core = p.core.clone();
    assert!(
        std::thread::spawn(move || core.random().fill(&mut [0u8; 32]))
            .join()
            .is_err()
    );
    assert!(p.faults.take().unwrap().contains("must be 32 bytes of hex"));
}

#[tokio::test]
async fn smoke_hooks_installer_fails_with_the_ts_message_only_inside_the_handler() {
    let ok = prepare(&smoke_case("hooksInstaller ok: hooks:accept saves consent")).unwrap();
    let throws = smoke_case("hooksInstaller throw: hooks:accept fails before saving");
    assert_eq!(
        throws["expected"]["reply"],
        json!({ "error": HOOKS_INSTALLER_ERROR })
    );
    let throw = prepare(&throws).unwrap();
    for p in [&ok, &throw] {
        p.faults.set_in_handler(true);
    }
    let installer = |p: &runner::Prepared| p.core.hooks_installer().unwrap();
    assert_eq!(installer(&ok).install(), Ok(()));
    assert_eq!(installer(&ok).uninstall(), Ok(()));
    assert_eq!(
        installer(&throw).install(),
        Err(HOOKS_INSTALLER_ERROR.to_owned())
    );
    assert_eq!(
        installer(&throw).uninstall(),
        Err(HOOKS_INSTALLER_ERROR.to_owned())
    );
    throw.faults.set_in_handler(false);
    assert_eq!(installer(&throw).install(), Ok(()));
}

#[tokio::test]
async fn smoke_ws_bound_reports_the_case_address_none_for_null_and_the_default_when_absent() {
    let bound = prepare(&smoke_case(
        "wsBound: getWsTransportInfo reports host, port and token",
    ))
    .unwrap();
    let ws = bound.core.ws_bound().unwrap();
    assert_eq!((ws.host.as_str(), ws.port), ("0.0.0.0", 41234));

    let none = prepare(&smoke_case("wsBound null: getWsTransportInfo returns null")).unwrap();
    assert_eq!(none.core.ws_bound(), None);

    let absent = prepare(&smoke_case("hooksInstaller ok: hooks:accept saves consent")).unwrap();
    let ws = absent.core.ws_bound().unwrap();
    assert_eq!((ws.host.as_str(), ws.port), (DEFAULT_WS_HOST, 0));
}

#[tokio::test]
async fn smoke_worktrees_map_case_paths_both_ways() {
    let case = smoke_case(
        "worktrees: listChanged prunes the removed worktree's scratchpad note from config",
    );
    let p = prepare(&case).unwrap();
    let placed = p.worktrees.to_string();
    assert!(!placed.contains(runner::CASE_ROOT_TOKEN));
    assert!(placed.contains(&p.case_root));
    assert_eq!(p.unmap_case_value(&p.worktrees), case["worktrees"]);
}

#[tokio::test]
async fn smoke_now_and_setup_reach_the_core_before_the_handler() {
    let case = smoke_case("kind event + setup: snooze/set persists every snoozed worktree");
    let p = prepare(&case).unwrap();
    assert_eq!(p.core.now_ms(), case["now"].as_i64().unwrap());
    let snoozed = |p: &runner::Prepared| {
        p.core
            .store()
            .read(|state| state.snooze.by_path.contains_key("/w/a"))
    };
    assert!(!snoozed(&p));
    runner::apply_setup(&p, &case).await.unwrap();
    assert!(snoozed(&p));
}

#[test]
fn smoke_a_signal_case_has_no_reply_and_reports_the_save_it_scheduled() {
    run_isolated("isolated_a_signal_case_has_no_reply_and_reports_the_save_it_scheduled");
}

#[tokio::test]
async fn isolated_a_signal_case_has_no_reply_and_reports_the_save_it_scheduled() {
    if !isolated("isolated_a_signal_case_has_no_reply_and_reports_the_save_it_scheduled") {
        return;
    }
    let case = smoke_case("kind signal: setLastEffectiveAppBg saves the hex");
    let p = prepare(&case).unwrap();
    assert!(
        p.core
            .router()
            .has_signal(case["channel"].as_str().unwrap())
    );
    let CaseResult::Compared { mismatched, actual } =
        runner::run_prepared(&p, &case).await.unwrap()
    else {
        panic!("signal case faulted");
    };
    assert!(actual.get("reply").is_none());
    assert_eq!(mismatched, Vec::<String>::new(), "{actual}");
}

async fn request_on_booted_core(channel: &str) -> Value {
    let p = prepare(&smoke_case("hooksInstaller ok: hooks:accept saves consent")).unwrap();
    let ctx = ConnCtx {
        client_id: ClientId("c".to_owned()),
    };
    let routed = p
        .core
        .router()
        .dispatch_request(ctx, channel, Vec::new())
        .await;
    reply_of(routed.reply)
}

#[tokio::test]
async fn updater_get_version_returns_the_package_json_version() {
    let package = read_json(&repo_root().join("package.json"));
    let version = package["version"].as_str().unwrap();
    assert_eq!(
        request_on_booted_core("updater:getVersion").await,
        json!({ "value": version })
    );
}

fn node_lan_addresses() -> Value {
    let script = "const r=[];for(const[n,l]of Object.entries(require('os').networkInterfaces())){for(const e of l||[]){if(e.family==='IPv4'&&!e.internal)r.push({iface:n,address:e.address})}}process.stdout.write(JSON.stringify(r))";
    let output = Command::new("node")
        .args(["-e", script])
        .output()
        .expect("node on PATH");
    assert!(output.status.success(), "{output:?}");
    tatsu_js::parse_lenient(&String::from_utf8(output.stdout).unwrap()).unwrap()
}

#[tokio::test]
async fn net_get_lan_addresses_returns_non_internal_ipv4_like_node_on_this_host() {
    let reply = request_on_booted_core("net:getLanAddresses").await;
    let entries = reply["value"].as_array().expect("an array reply");
    for entry in entries {
        let keys: Vec<&String> = entry.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["iface", "address"], "{entry}");
        let ip: std::net::Ipv4Addr = entry["address"].as_str().unwrap().parse().unwrap();
        assert!(!ip.is_loopback(), "{entry}");
    }
    assert_eq!(reply["value"], node_lan_addresses());
}
