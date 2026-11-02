use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};

use super::*;

type Lines = Arc<Mutex<Vec<(String, String, String)>>>;

struct Harness {
    router: Router,
    clock: Arc<Mutex<f64>>,
    perf: Lines,
    debug: Lines,
}

fn harness() -> Harness {
    let clock = Arc::new(Mutex::new(0.0));
    let perf: Lines = Arc::default();
    let debug: Lines = Arc::default();
    let capture = |lines: &Lines| {
        let lines = lines.clone();
        Box::new(move |category: &str, message: &str, data: &Value| {
            lines.lock().push((
                category.to_string(),
                message.to_string(),
                tatsu_js::stringify(data),
            ))
        })
    };
    let timer = clock.clone();
    let router = Router::with_options(RouterOptions {
        timer_ms: Box::new(move || *timer.lock()),
        perf: capture(&perf),
        debug: capture(&debug),
    });
    Harness {
        router,
        clock,
        perf,
        debug,
    }
}

fn ctx() -> ConnCtx {
    ConnCtx {
        client_id: ClientId("client-1".to_string()),
    }
}

async fn call(router: &Router, name: &str, args: Vec<Value>) -> RouterReply {
    router.dispatch_request(ctx(), name, args).await.reply
}

#[tokio::test]
async fn unknown_request_uses_the_ws_transport_text() {
    let h = harness();

    assert_eq!(
        call(&h.router, "nope:missing", vec![]).await,
        RouterReply::Error("no handler registered for 'nope:missing'".to_string())
    );
}

#[tokio::test]
async fn no_value_and_null_replies_stay_distinct() {
    let h = harness();
    h.router
        .request("a:none", |_, _| async { Ok(Reply::NoValue) })
        .unwrap();
    h.router
        .request("a:null", |_, _| async { Ok(Reply::Value(Value::Null)) })
        .unwrap();

    assert_eq!(
        call(&h.router, "a:none", vec![]).await,
        RouterReply::NoValue
    );
    assert_eq!(
        call(&h.router, "a:null", vec![]).await,
        RouterReply::Value(Value::Null)
    );
}

#[tokio::test]
async fn handler_error_becomes_an_error_reply() {
    let h = harness();
    h.router
        .request("a:fail", |_, _| async { Err("disk full".to_string()) })
        .unwrap();

    assert_eq!(
        call(&h.router, "a:fail", vec![]).await,
        RouterReply::Error("disk full".to_string())
    );
    assert!(h.debug.lock().is_empty());
}

#[tokio::test]
async fn handler_panics_become_a_generic_error_and_the_router_keeps_working() {
    let h = harness();
    h.router
        .request("a:panic-in-future", |_, _| async { panic!("boom") })
        .unwrap();
    h.router
        .request("a:panic-before-future", |_, _| -> std::future::Ready<_> {
            panic!("boom")
        })
        .unwrap();

    for name in ["a:panic-in-future", "a:panic-before-future"] {
        assert_eq!(
            call(&h.router, name, vec![]).await,
            RouterReply::Error("handler panicked".to_string())
        );
    }
    assert_eq!(
        call(&h.router, "transport:getClientId", vec![]).await,
        RouterReply::Value(json!("client-1"))
    );
}

#[test]
fn registering_a_name_twice_fails_for_requests_and_signals() {
    let h = harness();
    h.router.signal("s:one", |_, _| Ok(())).unwrap();

    assert_eq!(
        h.router
            .request("transport:getClientId", |_, _| async { Ok(Reply::NoValue) }),
        Err(RegisterError::Duplicate(
            "transport:getClientId".to_string()
        ))
    );
    assert_eq!(
        h.router.signal("s:one", |_, _| Ok(())),
        Err(RegisterError::Duplicate("s:one".to_string()))
    );
    assert_eq!(
        h.router
            .request_typed("transport:getClientId", |_, (): ()| async {
                Ok(Reply::NoValue)
            }),
        Err(RegisterError::Duplicate(
            "transport:getClientId".to_string()
        ))
    );
}

#[test]
fn has_queries_report_only_registered_names_of_their_kind() {
    let h = harness();
    h.router.signal("s:one", |_, _| Ok(())).unwrap();

    assert!(h.router.has_request("transport:getClientId"));
    assert!(!h.router.has_request("s:one"));
    assert!(h.router.has_signal("s:one"));
    assert!(!h.router.has_signal("transport:getClientId"));
    assert!(!h.router.has_request("x:missing"));
}

#[tokio::test]
async fn get_client_id_returns_the_callers_id() {
    let h = harness();
    let other = ConnCtx {
        client_id: ClientId("client-2".to_string()),
    };

    let reply = h
        .router
        .dispatch_request(other, "transport:getClientId", vec![json!("ignored")])
        .await;

    assert_eq!(reply.reply, RouterReply::Value(json!("client-2")));
}

fn echo_typed(router: &Router) {
    router
        .request_typed(
            "t:echo",
            |_, (name, count): (String, Option<u32>)| async move {
                Ok(Reply::Value(json!({"name": name, "count": count})))
            },
        )
        .unwrap();
}

#[tokio::test]
async fn typed_args_decode_missing_trailing_options_as_none_and_ignore_extras() {
    let h = harness();
    echo_typed(&h.router);

    assert_eq!(
        call(&h.router, "t:echo", vec![json!("a")]).await,
        RouterReply::Value(json!({"name": "a", "count": null}))
    );
    assert_eq!(
        call(
            &h.router,
            "t:echo",
            vec![json!("a"), json!(3), json!("extra")]
        )
        .await,
        RouterReply::Value(json!({"name": "a", "count": 3}))
    );
}

#[tokio::test]
async fn typed_decode_errors_reply_with_the_serde_message() {
    let h = harness();
    echo_typed(&h.router);

    assert_eq!(
        call(&h.router, "t:echo", vec![json!(5)]).await,
        RouterReply::Error("invalid type: integer `5`, expected a string".to_string())
    );
    assert_eq!(
        call(&h.router, "t:echo", vec![]).await,
        RouterReply::Error("invalid type: null, expected a string".to_string())
    );
    assert_eq!(
        call(&h.router, "t:echo", vec![json!("a"), json!("x")]).await,
        RouterReply::Error("invalid type: string \"x\", expected u32".to_string())
    );
}

struct Tracked(Arc<Mutex<Vec<&'static str>>>);

impl Drop for Tracked {
    fn drop(&mut self) {
        self.0.lock().push("guard dropped");
    }
}

#[tokio::test]
async fn release_guard_is_handed_back_so_the_hub_drops_it_after_queueing() {
    let h = harness();
    let queue: Arc<Mutex<Vec<&'static str>>> = Arc::default();
    let tracked = queue.clone();
    h.router
        .request("a:guarded", move |_, _| {
            let guard = Tracked(tracked.clone());
            async move {
                Ok(Reply::WithGuard(
                    Box::new(Reply::Value(json!(true))),
                    Box::new(guard),
                ))
            }
        })
        .unwrap();

    let routed = h.router.dispatch_request(ctx(), "a:guarded", vec![]).await;
    assert!(queue.lock().is_empty());
    assert_eq!(routed.reply, RouterReply::Value(json!(true)));
    queue.lock().push("res queued");
    drop(routed.guard);

    assert_eq!(*queue.lock(), vec!["res queued", "guard dropped"]);
}

fn slow_request(h: &Harness, name: &str, ms: f64) {
    let clock = h.clock.clone();
    h.router
        .request(name, move |_, _| {
            *clock.lock() += ms;
            async { Ok(Reply::NoValue) }
        })
        .unwrap();
}

#[tokio::test]
async fn slow_requests_write_the_ts_ipc_slow_line() {
    let h = harness();
    slow_request(&h, "a:slow", 60.25);
    slow_request(&h, "a:edge", 50.0);
    slow_request(&h, "a:fast", 49.9);

    call(&h.router, "a:slow", vec![json!(1), json!(2)]).await;
    call(&h.router, "a:edge", vec![]).await;
    call(&h.router, "a:fast", vec![]).await;

    assert_eq!(
        *h.perf.lock(),
        vec![
            (
                "ipc-slow".to_string(),
                "a:slow 60ms".to_string(),
                r#"{"name":"a:slow","ms":60.3,"argCount":2}"#.to_string()
            ),
            (
                "ipc-slow".to_string(),
                "a:edge 50ms".to_string(),
                r#"{"name":"a:edge","ms":50,"argCount":0}"#.to_string()
            ),
        ]
    );
}

#[test]
fn slow_signals_write_the_ts_ipc_slow_line_with_the_signal_marker() {
    let h = harness();
    let clock = h.clock.clone();
    h.router
        .signal("s:slow", move |_, _| {
            *clock.lock() += 75.55;
            Ok(())
        })
        .unwrap();

    h.router.dispatch_signal(ctx(), "s:slow", vec![json!("x")]);

    assert_eq!(
        *h.perf.lock(),
        vec![(
            "ipc-slow".to_string(),
            "s:slow 76ms (signal)".to_string(),
            r#"{"name":"s:slow","ms":75.5,"argCount":1,"signal":true}"#.to_string()
        )]
    );
}

#[test]
fn failing_signals_write_the_ts_debug_line_and_unknown_signals_are_dropped() {
    let h = harness();
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let record = seen.clone();
    h.router
        .signal("s:fail", |_, _| Err("bad input".to_string()))
        .unwrap();
    h.router.signal("s:panic", |_, _| panic!("boom")).unwrap();
    h.router
        .signal("s:ok", move |_, args| {
            record.lock().extend(args);
            Ok(())
        })
        .unwrap();

    h.router.dispatch_signal(ctx(), "s:missing", vec![]);
    h.router.dispatch_signal(ctx(), "s:fail", vec![]);
    h.router.dispatch_signal(ctx(), "s:panic", vec![]);
    h.router.dispatch_signal(ctx(), "s:ok", vec![json!(7)]);

    assert_eq!(
        *h.debug.lock(),
        vec![
            (
                "ws-transport".to_string(),
                "signal handler 's:fail' threw".to_string(),
                r#""bad input""#.to_string()
            ),
            (
                "ws-transport".to_string(),
                "signal handler 's:panic' threw".to_string(),
                r#""handler panicked""#.to_string()
            ),
        ]
    );
    assert_eq!(*seen.lock(), vec![json!(7)]);
    assert!(h.perf.lock().is_empty());
}
