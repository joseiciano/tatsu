use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tatsu_core::{ClientId, Hub, Reply, Router, RouterOptions, Store, StoreOptions};
use tatsu_state::{AppState, StateEvent};
use tatsu_ws::{BoundServer, WsOptions};
use tokio::runtime::Runtime;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::stream::MaybeTlsStream;
use tokio_tungstenite::tungstenite::{self, Message, WebSocket};

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

type Client = WebSocket<MaybeTlsStream<TcpStream>>;
type Signal = (ClientId, Vec<Value>);

struct Server {
    rt: Runtime,
    bound: Option<BoundServer>,
    store: Arc<Store>,
    router: Arc<Router>,
    hub: Arc<Hub>,
    lines: Arc<Mutex<Vec<String>>>,
}

impl Server {
    fn start() -> Self {
        Self::start_with(tatsu_ws::WRITE_TIMEOUT)
    }

    fn start_with(write_timeout: Duration) -> Self {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let store = Arc::new(Store::with_options(
            AppState::default(),
            StoreOptions {
                now_ms: Box::new(|| 1_700_000_000_000),
                timer_ms: Box::new(|| 0.0),
                perf: Box::new(|_, _, _| {}),
            },
        ));
        let router = Arc::new(Router::with_options(RouterOptions {
            timer_ms: Box::new(|| 0.0),
            perf: Box::new(|_, _, _| {}),
            debug: Box::new(|_, _, _| {}),
        }));
        let hub = Hub::new(store.clone(), router.clone(), rt.handle().clone());
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let options = WsOptions {
            debug: Arc::new(move |message, data| {
                let line = match data {
                    Some(data) => format!("{message} {data}"),
                    None => message.to_string(),
                };
                sink.lock().push(line);
            }),
            write_timeout,
        };
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let bound = rt
            .block_on(tatsu_ws::listen_with(addr, hub.clone(), TOKEN, options))
            .unwrap();
        Server {
            rt,
            bound: Some(bound),
            store,
            router,
            hub,
            lines,
        }
    }

    fn url(&self, query: &str) -> String {
        let addr = self.bound.as_ref().unwrap().local_addr();
        format!("ws://{addr}/{query}")
    }

    fn connect(&self) -> Client {
        self.connect_request(self.url(&format!("?token={TOKEN}")), None)
            .unwrap()
    }

    fn connect_request(
        &self,
        url: String,
        bearer: Option<&str>,
    ) -> Result<Client, tungstenite::Error> {
        let mut request = url.into_client_request().unwrap();
        if let Some(token) = bearer {
            request
                .headers_mut()
                .insert("authorization", format!("Bearer {token}").parse().unwrap());
        }
        let (client, _) = tungstenite::connect(request)?;
        if let MaybeTlsStream::Plain(stream) = client.get_ref() {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
        }
        Ok(client)
    }

    fn lines(&self) -> Vec<String> {
        self.lines.lock().clone()
    }

    fn wait_for_line(&self, wanted: impl Fn(&str) -> bool) -> String {
        for _ in 0..500 {
            if let Some(line) = self.lines().into_iter().find(|l| wanted(l)) {
                return line;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("log line never appeared; lines: {:?}", self.lines());
    }

    fn shutdown(&mut self) {
        if let Some(bound) = self.bound.take() {
            self.rt.block_on(bound.shutdown());
        }
    }

    fn assert_no_token_logged(&self) {
        for line in self.lines() {
            assert!(!line.contains(TOKEN), "token leaked into log line {line:?}");
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn send(client: &mut Client, frame: Value) {
    client.send(Message::text(frame.to_string())).unwrap();
}

fn next_frame(client: &mut Client, wanted: impl Fn(&Value) -> bool) -> Value {
    loop {
        match client.read().unwrap() {
            Message::Text(text) => {
                let frame: Value = serde_json::from_str(text.as_str()).unwrap();
                if wanted(&frame) {
                    return frame;
                }
            }
            Message::Close(close) => panic!("unexpected close {close:?}"),
            _ => {}
        }
    }
}

fn reply(client: &mut Client, id: &str) -> Value {
    next_frame(client, |f| f["t"] == "res" && f["id"] == id)
}

fn client_id(client: &mut Client, id: &str) -> String {
    send(
        client,
        json!({"t": "req", "id": id, "name": "transport:getClientId"}),
    );
    reply(client, id)["value"].as_str().unwrap().to_string()
}

fn theme_dark(name: &str) -> StateEvent {
    serde_json::from_value(json!({"type": "settings/themeDarkChanged", "payload": name})).unwrap()
}

fn rejected_status(result: Result<Client, tungstenite::Error>) -> (u16, String) {
    match result {
        Err(tungstenite::Error::Http(response)) => (
            response.status().as_u16(),
            String::from_utf8_lossy(response.body().as_deref().unwrap_or_default()).into_owned(),
        ),
        Err(other) => panic!("expected an HTTP rejection, got {other}"),
        Ok(_) => panic!("expected an HTTP rejection, the upgrade was accepted"),
    }
}

#[test]
fn rejects_clients_without_a_valid_token() {
    let server = Server::start();
    for query in ["", "?token=wrong", "?token="] {
        let result = server.connect_request(server.url(query), None);
        assert_eq!(rejected_status(result), (401, "unauthorized".to_string()));
    }
    let result = server.connect_request(server.url("?token=0123"), None);
    assert_eq!(rejected_status(result).0, 401);
    let rejected = server
        .lines()
        .iter()
        .filter(|l| *l == "rejected unauth ws handshake")
        .count();
    assert_eq!(rejected, 4);
    assert!(
        !server
            .lines()
            .iter()
            .any(|l| l.starts_with("client connected"))
    );
}

#[test]
fn bearer_header_wins_over_the_query_token() {
    let server = Server::start();
    let accepted = server.connect_request(server.url("?token=wrong"), Some(TOKEN));
    assert!(
        accepted.is_ok(),
        "right bearer with a wrong query must connect"
    );

    let rejected = server.connect_request(server.url(&format!("?token={TOKEN}")), Some("wrong"));
    assert_eq!(rejected_status(rejected).0, 401);
    server.assert_no_token_logged();
}

#[test]
fn upgrade_is_accepted_on_any_path() {
    let server = Server::start();
    let addr = server.bound.as_ref().unwrap().local_addr();
    let mut client = server
        .connect_request(format!("ws://{addr}/some/deep/path?token={TOKEN}"), None)
        .unwrap();
    assert!(!client_id(&mut client, "1").is_empty());
}

#[test]
fn handles_snapshot_requests_state_events_rpc_and_client_signals() {
    let server = Server::start();
    let signals: Arc<Mutex<Vec<Signal>>> = Arc::default();
    let seen = signals.clone();
    server
        .router
        .signal("pty:write", move |ctx, args| {
            seen.lock().push((ctx.client_id, args));
            Ok(())
        })
        .unwrap();
    server
        .router
        .request("echo", |_ctx, args| async move {
            Ok(Reply::Value(json!({ "args": args })))
        })
        .unwrap();

    let mut client = server.connect();

    send(&mut client, json!({"t": "snapreq", "id": "1"}));
    let snap = next_frame(&mut client, |f| f["t"] == "snapres" && f["id"] == "1");
    assert_eq!(snap["ok"], true);
    assert_eq!(snap["snapshot"]["seq"], 0);
    assert_eq!(snap["snapshot"]["state"]["settings"]["themeDark"], "dark");

    server.store.dispatch(theme_dark("solarized-dark"));
    let state = next_frame(&mut client, |f| f["t"] == "state");
    assert_eq!(
        state,
        json!({"t": "state", "event": {"type": "settings/themeDarkChanged", "payload": "solarized-dark"}, "seq": 1})
    );

    send(
        &mut client,
        json!({"t": "req", "id": "2", "name": "echo", "args": ["hi", 42]}),
    );
    assert_eq!(
        reply(&mut client, "2"),
        json!({"t": "res", "id": "2", "ok": true, "value": {"args": ["hi", 42]}})
    );

    let id = client_id(&mut client, "3");
    send(
        &mut client,
        json!({"t": "send", "name": "pty:write", "args": ["term-1", "ls\n"]}),
    );
    send(
        &mut client,
        json!({"t": "req", "id": "4", "name": "echo", "args": []}),
    );
    reply(&mut client, "4");
    assert_eq!(
        *signals.lock(),
        vec![(ClientId(id), vec![json!("term-1"), json!("ls\n")])]
    );

    server
        .hub
        .broadcast_signal("terminal:data", vec![json!("term-1"), json!("hello")]);
    let sig = next_frame(&mut client, |f| f["t"] == "sig");
    assert_eq!(
        sig,
        json!({"t": "sig", "name": "terminal:data", "args": ["term-1", "hello"]})
    );
}

#[test]
fn get_client_id_without_args_returns_a_uuid() {
    let server = Server::start();
    let mut client = server.connect();
    client
        .send(Message::text(
            r#"{"t":"req","id":"1","name":"transport:getClientId"}"#,
        ))
        .unwrap();
    let res = reply(&mut client, "1");
    assert_eq!(res["ok"], true);
    let value = res["value"].as_str().unwrap();
    assert_eq!(value.len(), 36);
    assert_eq!(value.matches('-').count(), 4);
}

#[test]
fn broadcasts_state_events_to_every_connected_client() {
    let server = Server::start();
    let mut a = server.connect();
    let mut b = server.connect();
    assert_ne!(client_id(&mut a, "a"), client_id(&mut b, "b"));
    for client in [&mut a, &mut b] {
        send(client, json!({"t": "snapreq", "id": "s"}));
        next_frame(client, |f| f["t"] == "snapres");
    }

    server.store.dispatch(theme_dark("one"));
    server.store.dispatch(theme_dark("two"));
    for client in [&mut a, &mut b] {
        let first = next_frame(client, |f| f["t"] == "state");
        let second = next_frame(client, |f| f["t"] == "state");
        assert_eq!(
            (first["seq"].clone(), first["event"]["payload"].clone()),
            (json!(1), json!("one"))
        );
        assert_eq!(
            (second["seq"].clone(), second["event"]["payload"].clone()),
            (json!(2), json!("two"))
        );
    }
}

#[test]
fn unknown_request_names_get_an_error_frame() {
    let server = Server::start();
    let mut client = server.connect();
    send(
        &mut client,
        json!({"t": "req", "id": "9", "name": "nope:missing", "args": []}),
    );
    assert_eq!(
        reply(&mut client, "9"),
        json!({"t": "res", "id": "9", "ok": false, "error": "no handler registered for 'nope:missing'"})
    );
}

#[test]
fn malformed_text_is_dropped_and_logged_and_binary_is_ignored() {
    let server = Server::start();
    let mut client = server.connect();
    client.send(Message::text("{not json")).unwrap();
    client
        .send(Message::binary(
            b"{\"t\":\"req\",\"id\":\"b\",\"name\":\"transport:getClientId\"}".to_vec(),
        ))
        .unwrap();
    assert!(!client_id(&mut client, "1").is_empty());
    let dropped = server
        .lines()
        .iter()
        .filter(|l| *l == "dropped malformed frame")
        .count();
    assert_eq!(dropped, 1);
    send(
        &mut client,
        json!({"t": "req", "id": "2", "name": "transport:getClientId"}),
    );
    let res = reply(&mut client, "2");
    assert_eq!(res["id"], "2");
}

#[test]
fn logs_connect_and_disconnect_with_totals_and_runs_disconnect_callbacks() {
    let server = Server::start();
    let gone: Arc<Mutex<Vec<String>>> = Arc::default();
    let seen = gone.clone();
    server
        .hub
        .on_disconnect(move |id| seen.lock().push(id.as_str().to_string()));

    let mut a = server.connect();
    let id_a = client_id(&mut a, "a");
    let mut b = server.connect();
    let id_b = client_id(&mut b, "b");
    server.wait_for_line(|l| l == format!("client connected id={id_a} (total=1)"));
    server.wait_for_line(|l| l == format!("client connected id={id_b} (total=2)"));

    a.close(None).unwrap();
    while a.read().is_ok() {}
    server.wait_for_line(|l| l == format!("client disconnected id={id_a} (total=1)"));
    assert_eq!(*gone.lock(), vec![id_a]);

    server.wait_for_line(|l| l.starts_with("listening on ws://127.0.0.1:"));
    server.assert_no_token_logged();
}

#[test]
fn shutdown_closes_every_socket_with_1001() {
    let mut server = Server::start();
    let mut a = server.connect();
    let mut b = server.connect();
    client_id(&mut a, "a");
    client_id(&mut b, "b");

    server.shutdown();

    for client in [&mut a, &mut b] {
        let close = loop {
            match client.read() {
                Ok(Message::Close(close)) => break close,
                Ok(_) => {}
                Err(err) => panic!("expected a close frame, got {err}"),
            }
        };
        let close = close.expect("close frame has a code");
        assert_eq!(close.code, CloseCode::Away);
        assert_eq!(close.reason.as_str(), "server shutting down");
    }
    let disconnected = server
        .lines()
        .iter()
        .filter(|l| l.starts_with("client disconnected"))
        .count();
    assert_eq!(disconnected, 2);
}

#[test]
fn a_client_that_stops_reading_is_closed_above_the_limit() {
    let server = Server::start();
    let mut client = server.connect();
    client_id(&mut client, "1");

    let chunk = "x".repeat(1024 * 1024);
    let sent = 64;
    for _ in 0..sent {
        server
            .hub
            .broadcast_signal("terminal:data", vec![json!(chunk)]);
    }

    let mut received = 0;
    let close = loop {
        match client.read().unwrap() {
            Message::Text(_) => received += 1,
            Message::Close(close) => break close.expect("close frame has a code"),
            _ => {}
        }
    };
    assert_eq!(close.code, CloseCode::from(tatsu_ws::OVERFLOW_CODE));
    assert_eq!(close.reason.as_str(), tatsu_ws::OVERFLOW_REASON);
    assert!(received < sent, "received {received} of {sent} frames");
    server.wait_for_line(|l| l.starts_with("closed slow client id=") && l.contains(" queued="));
}

fn raw_handshake(addr: SocketAddr) -> TcpStream {
    let mut stream = TcpStream::connect(addr).unwrap();
    write!(
        stream,
        "GET /?token={TOKEN} HTTP/1.1\r\nHost: {addr}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    )
    .unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    assert!(
        head.starts_with(b"HTTP/1.1 101"),
        "{}",
        String::from_utf8_lossy(&head)
    );
    stream
}

#[test]
fn a_client_that_never_reads_is_dropped_after_the_write_timeout() {
    let mut server = Server::start_with(Duration::from_millis(300));
    let addr = server.bound.as_ref().unwrap().local_addr();
    let _silent = raw_handshake(addr);
    server.wait_for_line(|l| l.starts_with("client connected"));

    let chunk = "x".repeat(1024 * 1024);
    for _ in 0..64 {
        server
            .hub
            .broadcast_signal("terminal:data", vec![json!(chunk)]);
    }

    server.wait_for_line(|l| l == "socket error write timed out");
    server.wait_for_line(|l| l.starts_with("client disconnected") && l.ends_with("(total=0)"));

    let started = Instant::now();
    server.shutdown();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "shutdown took {:?}",
        started.elapsed()
    );
}
