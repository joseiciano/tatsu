use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
use std::process::{Child, ChildStdout, Command, Stdio};
use std::time::Duration;

use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::stream::MaybeTlsStream;
use tokio_tungstenite::tungstenite::{self, Message, WebSocket};

const TOKEN: &str = "f00dfeedf00dfeedf00dfeedf00dfeed";

type Client = WebSocket<MaybeTlsStream<TcpStream>>;

struct Running {
    child: Child,
    stdout: BufReader<ChildStdout>,
    url: String,
    seen: Vec<String>,
    dir: tempfile::TempDir,
}

fn start(extra: &[&str]) -> Running {
    let dir = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_tatsu-core-testserver"))
        .args([
            "--data-dir",
            dir.path().to_str().unwrap(),
            "--token",
            TOKEN,
            "--port",
            "0",
        ])
        .args(extra)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut seen = Vec::new();
    let url = loop {
        let mut line = String::new();
        assert!(
            stdout.read_line(&mut line).unwrap() > 0,
            "server exited; stdout: {seen:?}"
        );
        let line = line.trim_end().to_string();
        seen.push(line.clone());
        if line.starts_with("ws://") {
            break line;
        }
    };
    Running {
        child,
        stdout,
        url,
        seen,
        dir,
    }
}

impl Running {
    fn connect(&self) -> Client {
        let (client, _) = tungstenite::connect(format!("{}/?token={TOKEN}", self.url)).unwrap();
        if let MaybeTlsStream::Plain(stream) = client.get_ref() {
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
        }
        client
    }

    fn stop(mut self) -> (Vec<String>, String) {
        self.kill();
        let mut rest = String::new();
        self.stdout.read_to_string(&mut rest).unwrap();
        self.seen.extend(rest.lines().map(str::to_string));
        let log = std::fs::read_to_string(self.dir.path().join("debug.log")).unwrap_or_default();
        (std::mem::take(&mut self.seen), log)
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.kill();
    }
}

fn send(client: &mut Client, frame: Value) {
    client.send(Message::text(frame.to_string())).unwrap();
}

fn next_frame(client: &mut Client, mut wanted: impl FnMut(&Value) -> bool) -> Value {
    loop {
        if let Message::Text(text) = client.read().unwrap() {
            let frame: Value = serde_json::from_str(text.as_str()).unwrap();
            if wanted(&frame) {
                return frame;
            }
        }
    }
}

fn request(client: &mut Client, id: &str, name: &str, args: Value) -> Value {
    send(
        client,
        json!({"t": "req", "id": id, "name": name, "args": args}),
    );
    next_frame(client, |f| f["t"] == "res" && f["id"] == id)
}

#[test]
fn prints_a_url_clients_connect_to_and_never_prints_the_token() {
    let server = start(&[]);
    assert!(server.url.starts_with("ws://127.0.0.1:"));
    let mut client = server.connect();
    client
        .send(Message::text(
            r#"{"t":"req","id":"1","name":"transport:getClientId"}"#,
        ))
        .unwrap();
    let res = next_frame(&mut client, |f| f["t"] == "res");
    assert_eq!(res["ok"], true);
    assert_eq!(res["value"].as_str().unwrap().len(), 36);
    drop(client);

    let unauthorized = tungstenite::connect(format!("{}/?token=nope", server.url));
    assert!(matches!(unauthorized, Err(tungstenite::Error::Http(r)) if r.status() == 401));

    let (stdout, log) = server.stop();
    assert!(log.contains("[ws-transport] listening on ws://127.0.0.1:"));
    assert!(log.contains("[ws-transport] client connected id="));
    assert!(log.contains("[ws-transport] rejected unauth ws handshake"));
    for line in stdout.iter().map(String::as_str).chain(log.lines()) {
        assert!(!line.contains(TOKEN), "token leaked: {line:?}");
    }
}

#[test]
fn channels_are_registered_only_with_test_hooks() {
    let server = start(&[]);
    let mut client = server.connect();
    let res = request(&mut client, "1", "test:null", json!([]));
    assert_eq!(res["error"], "no handler registered for 'test:null'");
    server.stop();
}

#[test]
fn test_hooks_give_reply_shapes_echo_signals_and_nested_dispatches() {
    let server = start(&["--test-hooks"]);
    let mut client = server.connect();

    assert_eq!(
        request(&mut client, "n", "test:null", json!([])),
        json!({"t": "res", "id": "n", "ok": true, "value": null})
    );
    assert_eq!(
        request(&mut client, "f", "test:fail", json!([])),
        json!({"t": "res", "id": "f", "ok": false, "error": "test failure"})
    );

    send(&mut client, json!({"t": "snapreq", "id": "s"}));
    next_frame(&mut client, |f| f["t"] == "snapres");
    let marker = json!({"type": "settings/themeLightChanged", "payload": "nested:3"});
    send(
        &mut client,
        json!({"t": "req", "id": "d", "name": "test:dispatch", "args": [marker]}),
    );
    let mut states = Vec::new();
    let res = next_frame(&mut client, |f| {
        if f["t"] == "state" {
            states.push(f.clone());
        }
        f["t"] == "res"
    });
    assert_eq!(res, json!({"t": "res", "id": "d", "ok": true}));
    let seqs: Vec<&Value> = states.iter().map(|f| &f["seq"]).collect();
    assert_eq!(seqs, [&json!(1), &json!(2), &json!(3), &json!(4)]);
    assert_eq!(states[0]["event"], marker);
    assert_eq!(states[3]["event"]["payload"], "nested-2");

    send(
        &mut client,
        json!({"t": "send", "name": "test:echo", "args": ["a", 1]}),
    );
    assert_eq!(
        next_frame(&mut client, |f| f["t"] == "sig"),
        json!({"t": "sig", "name": "test:echo", "args": ["a", 1]})
    );
    server.stop();
}
