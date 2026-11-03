use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::json;
use tempfile::TempDir;

use super::*;
use crate::data_dir::Platform;
use crate::hub::{CloseCause, Outbound, OverflowPolicy};

fn env(dir: &TempDir) -> Env {
    Env {
        platform: Platform::Linux,
        home: dir.path().to_path_buf(),
        cwd: dir.path().to_path_buf(),
        harness_data_dir: Some(dir.path().join("data").into()),
        xdg_config_home: None,
    }
}

fn boot(dir: &TempDir) -> Arc<Core> {
    CoreBuilder::new(Runtime::Headless, env(dir))
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default())
        .unwrap()
}

fn config_text(core: &Core) -> String {
    std::fs::read_to_string(core.config().path()).unwrap_or_default()
}

#[test]
fn boot_slots_run_theme_scan_then_core_handlers_then_repo_configs() {
    assert_eq!(PRE_RUNTIME_SLOTS, [PreRuntimeSlot::PathFix]);
    assert_eq!(
        BOOT_SLOTS,
        [
            BootSlot::ThemeScan,
            BootSlot::CoreHandlers,
            BootSlot::RepoConfigsLoaded
        ]
    );
}

#[tokio::test]
async fn shutdown_runs_module_steps_then_core_steps_then_closes_then_flushes() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    let order = Arc::new(Mutex::new(Vec::<&str>::new()));
    for name in ["first", "second", "third"] {
        let order = order.clone();
        core.on_shutdown(name, move || async move {
            order.lock().push(name);
            if name == "second" {
                panic!("second step broke");
            }
        });
    }
    let mut conn = core.hub().open(OverflowPolicy::Unbounded);
    core.config().set("themeLight", json!("pending-theme"));

    let seen_at_core_step = Arc::new(Mutex::new(None));
    {
        let order = order.clone();
        let seen = seen_at_core_step.clone();
        let weak = Arc::downgrade(&core);
        core.push_core_step("core", move || async move {
            order.lock().push("core");
            let core = weak.upgrade().unwrap();
            *seen.lock() = Some(config_text(&core).contains("pending-theme"));
        });
    }
    assert_eq!(conn.outbound.try_recv(), None);

    core.shutdown().await;

    assert_eq!(*order.lock(), ["first", "second", "third", "core"]);
    assert_eq!(*seen_at_core_step.lock(), Some(false));
    assert_eq!(
        conn.outbound.try_recv(),
        Some(Outbound::Close(CloseCause::Shutdown {
            code: 1001,
            reason: "server shutting down".to_owned()
        }))
    );
    let saved: serde_json::Value = serde_json::from_str(&config_text(&core)).unwrap();
    assert_eq!(saved["themeLight"], "pending-theme");
}

#[tokio::test]
async fn the_connection_is_still_open_while_steps_run() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    let conn = Arc::new(Mutex::new(core.hub().open(OverflowPolicy::Unbounded)));
    let seen = Arc::new(Mutex::new(None));
    {
        let conn = conn.clone();
        let seen = seen.clone();
        core.push_core_step("core", move || async move {
            *seen.lock() = Some(conn.lock().outbound.try_recv());
        });
    }

    core.shutdown().await;

    assert_eq!(*seen.lock(), Some(None));
    assert!(matches!(
        conn.lock().outbound.try_recv(),
        Some(Outbound::Close(CloseCause::Shutdown { code: 1001, .. }))
    ));
}

#[tokio::test(start_paused = true)]
async fn a_step_that_never_finishes_is_cut_off_and_the_rest_still_run() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    let ran = Arc::new(Mutex::new(Vec::new()));
    core.on_shutdown("stuck", std::future::pending::<()>);
    {
        let ran = ran.clone();
        core.on_shutdown("after", move || async move { ran.lock().push("after") });
    }
    let started = tokio::time::Instant::now();

    core.shutdown().await;

    assert_eq!(*ran.lock(), ["after"]);
    assert!(started.elapsed() >= SHUTDOWN_STEP_TIMEOUT);
}

#[tokio::test]
async fn shutdown_twice_runs_each_step_once() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    let count = Arc::new(Mutex::new(0));
    {
        let count = count.clone();
        core.on_shutdown("count", move || async move { *count.lock() += 1 });
    }

    core.shutdown().await;
    core.shutdown().await;

    assert_eq!(*count.lock(), 1);
}

#[tokio::test]
async fn values_set_after_boot_are_read_at_call_time() {
    struct Installer;
    impl HooksInstaller for Installer {
        fn install(&self) -> Result<(), String> {
            Ok(())
        }
        fn uninstall(&self) -> Result<(), String> {
            Err("nope".to_owned())
        }
    }
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    assert_eq!(core.ws_bound(), None);
    assert!(core.hooks_installer().is_none());
    assert_eq!(core.resources_dir(), None);

    core.set_ws_bound("127.0.0.1", 37291);
    core.set_hooks_installer(Arc::new(Installer));
    core.set_resources_dir(dir.path());

    assert_eq!(
        core.ws_bound(),
        Some(WsBound {
            host: "127.0.0.1".to_owned(),
            port: 37291
        })
    );
    assert_eq!(
        core.hooks_installer().unwrap().uninstall(),
        Err("nope".to_owned())
    );
    assert_eq!(core.resources_dir().as_deref(), Some(dir.path()));
}

#[tokio::test(start_paused = true)]
async fn a_concurrent_second_shutdown_waits_for_the_flush() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    let count = Arc::new(Mutex::new(0));
    {
        let count = count.clone();
        core.on_shutdown("slow", move || async move {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            *count.lock() += 1;
        });
    }
    core.config().set("themeLight", json!("pending-theme"));

    let saved_when_done = |core: Arc<Core>| async move {
        core.shutdown().await;
        config_text(&core).contains("pending-theme")
    };
    let (first, second) =
        tokio::join!(saved_when_done(core.clone()), saved_when_done(core.clone()));

    assert!(first && second);
    assert_eq!(*count.lock(), 1);
}

#[tokio::test(start_paused = true)]
async fn dropping_the_first_shutdown_midway_does_not_lose_steps_or_the_flush() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    let ran = Arc::new(Mutex::new(Vec::new()));
    for name in ["slow", "after"] {
        let ran = ran.clone();
        core.on_shutdown(name, move || async move {
            if name == "slow" {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            ran.lock().push(name);
        });
    }
    core.config().set("themeLight", json!("pending-theme"));

    let first = tokio::time::timeout(std::time::Duration::from_millis(100), core.shutdown()).await;
    assert!(first.is_err());
    assert!(ran.lock().is_empty());

    core.shutdown().await;

    assert_eq!(*ran.lock(), ["slow", "after"]);
    assert!(config_text(&core).contains("pending-theme"));
}

#[test]
fn boot_outside_a_runtime_is_an_error_not_a_panic() {
    let dir = TempDir::new().unwrap();
    let result = CoreBuilder::new(Runtime::Headless, env(&dir))
        .pre_runtime()
        .unwrap()
        .boot(Vec::new(), BootOptions::default());

    assert!(result.is_err());
}

#[tokio::test]
async fn ws_token_is_read_once_so_a_rotation_takes_effect_on_next_launch() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    core.secrets().set(secrets::ws_token::SECRET_KEY, "stored");
    core.set_ws_bound("127.0.0.1", 0);
    assert_eq!(core.ws_token(), "stored");

    let rotated = secrets::ws_token::rotate(core.secrets().as_ref(), core.random().as_ref());
    assert_ne!(rotated, "stored");
    assert_eq!(core.ws_token(), "stored");
}

#[tokio::test]
async fn ws_bound_creates_and_stores_a_token_when_none_exists() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    assert_eq!(core.secrets().get(secrets::ws_token::SECRET_KEY), None);
    core.set_ws_bound("127.0.0.1", 0);
    let stored = core.secrets().get(secrets::ws_token::SECRET_KEY).unwrap();
    assert_eq!(stored.len(), 64);
    assert_eq!(core.ws_token(), stored);
}

#[tokio::test]
async fn set_ws_token_replaces_the_token_the_listener_reports() {
    let dir = TempDir::new().unwrap();
    let core = boot(&dir);
    core.set_ws_token("listener-token");
    core.set_ws_bound("127.0.0.1", 0);
    assert_eq!(core.ws_token(), "listener-token");
    assert_eq!(core.secrets().get(secrets::ws_token::SECRET_KEY), None);
}

#[tokio::test]
async fn an_injected_timer_drives_both_store_and_router_timing() {
    let dir = TempDir::new().unwrap();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = calls.clone();
    let core = CoreBuilder::new(Runtime::Headless, env(&dir))
        .pre_runtime()
        .unwrap()
        .boot(
            Vec::new(),
            BootOptions {
                timer_ms: Some(Arc::new(move || {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    0.0
                })),
                ..BootOptions::default()
            },
        )
        .unwrap();
    let before = calls.load(std::sync::atomic::Ordering::SeqCst);
    core.store().dispatch(
        serde_json::from_value(json!({"type": "settings/themeDarkChanged", "payload": "x"}))
            .unwrap(),
    );
    let after_dispatch = calls.load(std::sync::atomic::Ordering::SeqCst);
    assert!(after_dispatch > before);
    let ctx = crate::router::ConnCtx {
        client_id: crate::router::ClientId("t".to_owned()),
    };
    core.router()
        .dispatch_request(ctx, "config:getWsTransportInfo", Vec::new())
        .await;
    assert!(calls.load(std::sync::atomic::Ordering::SeqCst) > after_dispatch);
}

fn boot_at(dir: &TempDir, now: i64) -> Arc<Core> {
    CoreBuilder::new(Runtime::Headless, env(dir))
        .pre_runtime()
        .unwrap()
        .boot(
            Vec::new(),
            BootOptions {
                clock: Arc::new(move || now),
                ..BootOptions::default()
            },
        )
        .unwrap()
}

fn record_signal(core: &Core, args: serde_json::Value) {
    let ctx = crate::router::ConnCtx {
        client_id: crate::router::ClientId("test".to_owned()),
    };
    let serde_json::Value::Array(args) = args else {
        panic!("args must be an array");
    };
    core.router().dispatch_signal(ctx, "activity:record", args);
}

fn activity_text(core: &Core) -> Option<String> {
    std::fs::read_to_string(core.activity().path()).ok()
}

#[tokio::test]
async fn shutdown_seals_open_activity_after_module_steps_and_before_the_config_flush() {
    let dir = TempDir::new().unwrap();
    let core = boot_at(&dir, 1_000);
    record_signal(&core, json!(["/w/a", "processing"]));
    core.config().set("themeLight", json!("pending-theme"));

    let at_module_step = Arc::new(Mutex::new(None));
    {
        let seen = at_module_step.clone();
        let weak = Arc::downgrade(&core);
        core.on_shutdown("module", move || async move {
            *seen.lock() = Some(activity_text(&weak.upgrade().unwrap()));
        });
    }
    let after_seal = Arc::new(Mutex::new(None));
    {
        let seen = after_seal.clone();
        let weak = Arc::downgrade(&core);
        core.push_core_step("after seal", move || async move {
            let core = weak.upgrade().unwrap();
            *seen.lock() = Some((activity_text(&core), config_text(&core)));
        });
    }

    core.shutdown().await;

    assert_eq!(*at_module_step.lock(), Some(None));
    let (activity, config) = after_seal.lock().clone().unwrap();
    assert_eq!(
        activity.as_deref(),
        Some(
            r#"{"/w/a":{"events":[{"t":1000,"s":"processing"},{"t":1000,"s":"idle"}],"createdAt":1000}}"#
        )
    );
    assert!(!config.contains("pending-theme"));
    assert!(config_text(&core).contains("pending-theme"));
}
