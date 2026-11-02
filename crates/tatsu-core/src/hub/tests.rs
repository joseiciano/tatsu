use std::sync::atomic::Ordering;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tatsu_state::wire::frames::ServerFrame;
use tatsu_state::{AppState, StateEvent};

use super::*;
use crate::router::{Reply, RouterOptions};
use crate::store::StoreOptions;

fn theme_dark(name: &str) -> StateEvent {
    serde_json::from_value(json!({"type": "settings/themeDarkChanged", "payload": name})).unwrap()
}

fn quiet_store() -> Arc<Store> {
    Arc::new(Store::with_options(
        AppState::default(),
        StoreOptions {
            now_ms: Box::new(|| 1_700_000_000_000),
            timer_ms: Box::new(|| 0.0),
            perf: Box::new(|_, _, _| {}),
        },
    ))
}

fn quiet_router() -> Arc<Router> {
    Arc::new(Router::with_options(RouterOptions {
        timer_ms: Box::new(|| 0.0),
        perf: Box::new(|_, _, _| {}),
        debug: Box::new(|_, _, _| {}),
    }))
}

fn hub_on(store: &Arc<Store>, router: &Arc<Router>, runtime: Handle) -> Arc<Hub> {
    Hub::new(store.clone(), router.clone(), runtime)
}

fn drain(rx: &mut OutboundRx) -> Vec<Outbound> {
    std::iter::from_fn(|| rx.try_recv()).collect()
}

fn frames(rx: &mut OutboundRx) -> Vec<Value> {
    drain(rx)
        .into_iter()
        .map(|out| match out {
            Outbound::Frame(text) => serde_json::from_str(&text).unwrap(),
            Outbound::Close(cause) => panic!("unexpected close {cause:?}"),
        })
        .collect()
}

async fn next_frame(rx: &mut OutboundRx) -> Value {
    match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        Ok(Some(Outbound::Frame(text))) => serde_json::from_str(&text).unwrap(),
        other => panic!("expected a frame, got {other:?}"),
    }
}

fn assert_gap_free_after_snapres(frames: &[Value], final_seq: u64) {
    let (snapres, rest) = frames.split_first().expect("a snapres frame");
    assert_eq!(snapres["t"], "snapres", "first frame must be the snapres");
    let snap_seq = snapres["snapshot"]["seq"].as_u64().unwrap();
    let seqs: Vec<u64> = rest
        .iter()
        .map(|f| {
            assert_eq!(f["t"], "state");
            f["seq"].as_u64().unwrap()
        })
        .collect();
    let expected: Vec<u64> = (snap_seq + 1..=final_seq).collect();
    assert_eq!(seqs, expected);
}

fn nesting_subscriber(store: &Arc<Store>) {
    let weak = Arc::downgrade(store);
    store.subscribe(move |event, _| {
        if let Some(store) = weak.upgrade()
            && let Ok(v) = serde_json::to_value(event)
            && v["payload"]
                .as_str()
                .is_some_and(|p| !p.starts_with("nested"))
        {
            store.dispatch(theme_dark("nested-1"));
            store.dispatch(theme_dark("nested-2"));
        }
    });
}

#[tokio::test]
async fn hub_state_frames_stay_in_seq_order_with_nested_dispatch_on_three_connections() {
    let store = quiet_store();
    let hub = hub_on(&store, &quiet_router(), Handle::current());
    nesting_subscriber(&store);
    let mut conns: Vec<ConnHandle> = (0..3)
        .map(|_| hub.open(OverflowPolicy::Unbounded))
        .collect();

    for (i, conn) in conns.iter().enumerate() {
        store.dispatch(theme_dark(&format!("root-{i}")));
        hub.on_frame(
            &conn.client_id,
            &format!(r#"{{"t":"snapreq","id":"s{i}"}}"#),
        )
        .unwrap();
        store.dispatch(theme_dark(&format!("after-{i}")));
    }

    let final_seq = store.seq();
    assert_eq!(final_seq, 18);
    for conn in &mut conns {
        let frames = frames(&mut conn.outbound);
        assert_gap_free_after_snapres(&frames, final_seq);
    }
    assert_eq!(store.frames_sent.load(Ordering::Relaxed), 15 + 9 + 3);
}

#[test]
fn hub_snapreq_racing_dispatch_threads_never_sees_a_gap_or_duplicate() {
    let (done_tx, done_rx) = mpsc::channel();
    thread::spawn(move || {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let store = quiet_store();
        let hub = hub_on(&store, &quiet_router(), runtime.handle().clone());
        nesting_subscriber(&store);

        let dispatchers: Vec<_> = (0..4)
            .map(|t| {
                let store = store.clone();
                thread::spawn(move || {
                    for i in 0..300 {
                        store.dispatch(theme_dark(&format!("{t}-{i}")));
                    }
                })
            })
            .collect();
        let clients: Vec<_> = (0..6)
            .map(|c| {
                let hub = hub.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_micros(200 * c));
                    let conn = hub.open(OverflowPolicy::Unbounded);
                    hub.on_frame(&conn.client_id, r#"{"t":"snapreq","id":"x"}"#)
                        .unwrap();
                    conn
                })
            })
            .collect();
        for d in dispatchers {
            d.join().unwrap();
        }
        let conns: Vec<ConnHandle> = clients.into_iter().map(|c| c.join().unwrap()).collect();
        let final_seq = store.seq();
        assert_eq!(final_seq, 4 * 300 * 3);
        for mut conn in conns {
            assert_gap_free_after_snapres(&frames(&mut conn.outbound), final_seq);
        }
        done_tx.send(()).unwrap();
    });
    done_rx
        .recv_timeout(Duration::from_secs(30))
        .expect("snapreq and dispatch threads finished without deadlock");
}

#[tokio::test]
async fn hub_sends_no_state_frames_before_snapres() {
    let store = quiet_store();
    let hub = hub_on(&store, &quiet_router(), Handle::current());
    let mut conn = hub.open(OverflowPolicy::Unbounded);

    store.dispatch(theme_dark("a"));
    assert!(drain(&mut conn.outbound).is_empty());
    assert_eq!(store.frames_sent.load(Ordering::Relaxed), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hub_slow_request_does_not_delay_a_second_request() {
    let store = quiet_store();
    let router = quiet_router();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));
    router
        .request("test:slow", move |_, _| {
            let rx = release_rx.lock().take().unwrap();
            async move {
                rx.await.unwrap();
                Ok(Reply::Value(json!("slow")))
            }
        })
        .unwrap();
    router
        .request("test:fast", |_, _| async {
            Ok(Reply::Value(json!("fast")))
        })
        .unwrap();
    let hub = hub_on(&store, &router, Handle::current());
    let mut conn = hub.open(OverflowPolicy::Unbounded);

    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"1","name":"test:slow","args":[]}"#,
    )
    .unwrap();
    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"2","name":"test:fast","args":[]}"#,
    )
    .unwrap();

    let first = next_frame(&mut conn.outbound).await;
    assert_eq!(first, json!({"t":"res","id":"2","ok":true,"value":"fast"}));
    release_tx.send(()).unwrap();
    let second = next_frame(&mut conn.outbound).await;
    assert_eq!(second, json!({"t":"res","id":"1","ok":true,"value":"slow"}));
}

#[tokio::test]
async fn hub_signals_on_one_connection_run_in_arrival_order() {
    let store = quiet_store();
    let router = quiet_router();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    router
        .signal("pty:write", move |_, args| {
            sink.lock().push(args[0].as_u64().unwrap());
            Ok(())
        })
        .unwrap();
    let hub = hub_on(&store, &router, Handle::current());
    let conn = hub.open(OverflowPolicy::Unbounded);

    for i in 0..200 {
        hub.on_frame(
            &conn.client_id,
            &format!(r#"{{"t":"send","name":"pty:write","args":[{i}]}}"#),
        )
        .unwrap();
    }

    assert_eq!(*seen.lock(), (0..200).collect::<Vec<u64>>());
}

#[tokio::test]
async fn hub_res_frames_distinguish_no_value_null_and_error() {
    let store = quiet_store();
    let router = quiet_router();
    router
        .request("test:none", |_, _| async { Ok(Reply::NoValue) })
        .unwrap();
    router
        .request("test:null", |_, _| async { Ok(Reply::Value(Value::Null)) })
        .unwrap();
    router
        .request("test:fail", |_, _| async { Err("boom".to_string()) })
        .unwrap();
    let hub = hub_on(&store, &router, Handle::current());
    let mut conn = hub.open(OverflowPolicy::Unbounded);

    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"a","name":"test:none","args":[]}"#,
    )
    .unwrap();
    let none = next_frame(&mut conn.outbound).await;
    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"b","name":"test:null","args":[]}"#,
    )
    .unwrap();
    let null = next_frame(&mut conn.outbound).await;
    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"c","name":"test:fail","args":[]}"#,
    )
    .unwrap();
    let fail = next_frame(&mut conn.outbound).await;

    assert_eq!(none, json!({"t":"res","id":"a","ok":true}));
    assert!(none.get("value").is_none());
    assert_eq!(null, json!({"t":"res","id":"b","ok":true,"value":null}));
    assert_eq!(fail, json!({"t":"res","id":"c","ok":false,"error":"boom"}));
    println!("no-value res frame: {}", tatsu_js::stringify(&none));
}

#[tokio::test]
async fn hub_frame_without_args_runs_with_an_empty_array() {
    let store = quiet_store();
    let router = quiet_router();
    router
        .request("test:argc", |_, args| async move {
            Ok(Reply::Value(json!(args.len())))
        })
        .unwrap();
    let hub = hub_on(&store, &router, Handle::current());
    let mut conn = hub.open(OverflowPolicy::Unbounded);

    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"1","name":"test:argc"}"#,
    )
    .unwrap();
    assert_eq!(next_frame(&mut conn.outbound).await["value"], json!(0));
    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"2","name":"test:argc","args":null}"#,
    )
    .unwrap();
    assert_eq!(next_frame(&mut conn.outbound).await["value"], json!(0));
}

#[tokio::test]
async fn hub_request_guard_drops_after_its_res_is_queued() {
    struct DispatchOnDrop(Arc<Store>);
    impl Drop for DispatchOnDrop {
        fn drop(&mut self) {
            self.0.dispatch(theme_dark("after-guard"));
        }
    }
    let store = quiet_store();
    let router = quiet_router();
    let guard_store = store.clone();
    router
        .request("test:guarded", move |_, _| {
            let guard = DispatchOnDrop(guard_store.clone());
            async move { Ok(Reply::WithGuard(Box::new(Reply::NoValue), Box::new(guard))) }
        })
        .unwrap();
    let hub = hub_on(&store, &router, Handle::current());
    let mut conn = hub.open(OverflowPolicy::Unbounded);
    hub.on_frame(&conn.client_id, r#"{"t":"snapreq","id":"s"}"#)
        .unwrap();
    assert_eq!(next_frame(&mut conn.outbound).await["t"], "snapres");

    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"g","name":"test:guarded","args":[]}"#,
    )
    .unwrap();

    assert_eq!(next_frame(&mut conn.outbound).await["t"], "res");
    assert_eq!(next_frame(&mut conn.outbound).await["t"], "state");
}

#[tokio::test]
async fn hub_drops_unknown_and_untyped_frames_and_reports_bad_input() {
    let store = quiet_store();
    let hub = hub_on(&store, &quiet_router(), Handle::current());
    let mut conn = hub.open(OverflowPolicy::Unbounded);

    assert_eq!(
        hub.on_frame(&conn.client_id, r#"{"t":"bogus","id":"1"}"#),
        Ok(())
    );
    assert_eq!(hub.on_frame(&conn.client_id, r#"{"id":"1"}"#), Ok(()));
    assert_eq!(hub.on_frame(&conn.client_id, r#"[1,2]"#), Ok(()));
    assert_eq!(
        hub.on_frame(&conn.client_id, "{nope"),
        Err(FrameError::Malformed)
    );
    assert_eq!(
        hub.on_frame(&ClientId("ghost".into()), r#"{"t":"snapreq","id":"1"}"#),
        Err(FrameError::UnknownClient)
    );
    tokio::task::yield_now().await;
    assert!(drain(&mut conn.outbound).is_empty());
}

#[tokio::test]
async fn hub_output_frames_parse_as_tatsu_state_server_frames() {
    let store = quiet_store();
    let router = quiet_router();
    router
        .request("test:obj", |_, _| async {
            Ok(Reply::Value(
                json!({"a": [1, 2.5, "x\u{1F600}"], "b": null}),
            ))
        })
        .unwrap();
    router
        .request("test:fail", |_, _| async { Err("nope".to_string()) })
        .unwrap();
    let hub = hub_on(&store, &router, Handle::current());
    let mut conn = hub.open(OverflowPolicy::Unbounded);

    hub.on_frame(&conn.client_id, r#"{"t":"snapreq","id":"s"}"#)
        .unwrap();
    store.dispatch(theme_dark("dracula"));
    hub.broadcast_signal("toast", vec![json!("hello"), json!(3)]);
    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"r","name":"test:obj","args":[]}"#,
    )
    .unwrap();
    let mut texts: Vec<Arc<str>> = drain(&mut conn.outbound)
        .into_iter()
        .map(|o| match o {
            Outbound::Frame(t) => t,
            Outbound::Close(c) => panic!("{c:?}"),
        })
        .collect();
    if let Some(Outbound::Frame(t)) = conn.outbound.recv().await {
        texts.push(t);
    }
    hub.on_frame(
        &conn.client_id,
        r#"{"t":"req","id":"e","name":"test:fail","args":[]}"#,
    )
    .unwrap();
    if let Some(Outbound::Frame(t)) = conn.outbound.recv().await {
        texts.push(t);
    }

    let kinds: Vec<String> = texts
        .iter()
        .map(|text| {
            let parsed: ServerFrame = serde_json::from_str(text).unwrap();
            let reencoded = serde_json::to_value(&parsed).unwrap();
            let original: Value = serde_json::from_str(text).unwrap();
            assert_eq!(
                reencoded, original,
                "hub frame drifted from ServerFrame: {text}"
            );
            original["t"].as_str().unwrap().to_string()
        })
        .collect();
    assert_eq!(kinds, ["snapres", "state", "sig", "res", "res"]);
    let exact: Vec<&str> = texts[1..].iter().map(|t| &**t).collect();
    assert_eq!(
        exact,
        [
            r#"{"t":"state","event":{"type":"settings/themeDarkChanged","payload":"dracula"},"seq":1}"#,
            r#"{"t":"sig","name":"toast","args":["hello",3]}"#,
            "{\"t\":\"res\",\"id\":\"r\",\"ok\":true,\"value\":{\"a\":[1,2.5,\"x\u{1F600}\"],\"b\":null}}",
            r#"{"t":"res","id":"e","ok":false,"error":"nope"}"#,
        ]
    );
    let snapres = texts[0].to_string();
    println!("snapres frame: {snapres}");
    assert!(snapres.starts_with(r#"{"t":"snapres","id":"s","ok":true,"snapshot":{"#));
}

#[tokio::test]
async fn hub_broadcast_signal_reaches_every_connection_and_is_not_counted() {
    let store = quiet_store();
    let hub = hub_on(&store, &quiet_router(), Handle::current());
    let mut a = hub.open(OverflowPolicy::Unbounded);
    let mut b = hub.open(OverflowPolicy::Unbounded);
    hub.on_frame(&a.client_id, r#"{"t":"snapreq","id":"s"}"#)
        .unwrap();
    drain(&mut a.outbound);

    hub.broadcast_signal("toast", vec![json!("hi")]);

    let expected = json!({"t":"sig","name":"toast","args":["hi"]});
    assert_eq!(frames(&mut a.outbound), std::slice::from_ref(&expected));
    assert_eq!(frames(&mut b.outbound), [expected]);
    assert_eq!(store.frames_sent.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn hub_close_calls_each_disconnect_callback_once_with_the_client_id() {
    let store = quiet_store();
    let hub = hub_on(&store, &quiet_router(), Handle::current());
    let seen = Arc::new(Mutex::new(Vec::new()));
    for tag in ["first", "second"] {
        let seen = seen.clone();
        hub.on_disconnect(move |id| seen.lock().push((tag, id.clone())));
    }
    let conn = hub.open(OverflowPolicy::Unbounded);

    assert!(hub.close(&conn.client_id));
    assert!(!hub.close(&conn.client_id));

    assert_eq!(
        *seen.lock(),
        [
            ("first", conn.client_id.clone()),
            ("second", conn.client_id.clone())
        ]
    );
    assert_eq!(
        hub.on_frame(&conn.client_id, r#"{"t":"snapreq","id":"1"}"#),
        Err(FrameError::UnknownClient)
    );
}

#[tokio::test]
async fn hub_closes_a_connection_over_its_close_above_limit() {
    let store = quiet_store();
    let hub = hub_on(&store, &quiet_router(), Handle::current());
    let mut slow = hub.open(OverflowPolicy::CloseAbove { bytes: 4096 });
    let mut fast = hub.open(OverflowPolicy::Unbounded);
    for conn in [&slow, &fast] {
        hub.on_frame(&conn.client_id, r#"{"t":"snapreq","id":"s"}"#)
            .unwrap();
    }

    for i in 0..200 {
        store.dispatch(theme_dark(&format!("theme-{i}")));
    }

    assert_eq!(
        slow.outbound.try_recv(),
        Some(Outbound::Close(CloseCause::Overflow))
    );
    assert_eq!(slow.outbound.try_recv(), None);
    assert_eq!(frames(&mut fast.outbound).len(), 201);
    hub.broadcast_signal("toast", vec![]);
    assert_eq!(slow.outbound.try_recv(), None);
}

#[tokio::test]
async fn hub_shutdown_closes_every_connection_with_code_and_reason() {
    let store = quiet_store();
    let hub = hub_on(&store, &quiet_router(), Handle::current());
    let mut conns: Vec<ConnHandle> = (0..3)
        .map(|_| hub.open(OverflowPolicy::Unbounded))
        .collect();
    hub.broadcast_signal("pending", vec![]);

    hub.shutdown(1001, "server shutting down");

    for conn in &mut conns {
        assert_eq!(
            conn.outbound.recv().await,
            Some(Outbound::Close(CloseCause::Shutdown {
                code: 1001,
                reason: "server shutting down".to_string(),
            }))
        );
        assert_eq!(conn.outbound.recv().await, None);
    }
    hub.broadcast_signal("late", vec![]);
    for conn in &mut conns {
        assert_eq!(conn.outbound.try_recv(), None);
    }
}
