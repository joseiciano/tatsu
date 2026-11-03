use std::io::{BufRead, BufReader, Read};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
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
    home: tempfile::TempDir,
}

fn fake_shell(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("fake-login-shell");
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn start(extra: &[&str]) -> Running {
    start_in(tempfile::tempdir().unwrap(), extra)
}

// The test server runs the login-shell PATH fix on macOS; a passthrough fake
// shell and a temp HOME keep the user's real shell and rc files out of it.
fn start_in(dir: tempfile::TempDir, extra: &[&str]) -> Running {
    let home = tempfile::tempdir().unwrap();
    let shell = fake_shell(home.path(), r#"exec /bin/sh -c "$2""#);
    let mut command = Command::new(env!("CARGO_BIN_EXE_tatsu-core-testserver"));
    command.env("HOME", home.path()).env("SHELL", shell);
    start_with(dir, home, command, extra)
}

fn start_with(
    dir: tempfile::TempDir,
    home: tempfile::TempDir,
    mut command: Command,
    extra: &[&str],
) -> Running {
    let mut child = command
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
        home,
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
    let base = next_frame(&mut client, |f| f["t"] == "snapres")["snapshot"]["seq"]
        .as_u64()
        .unwrap();
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
    let seqs: Vec<u64> = states.iter().map(|f| f["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, [base + 1, base + 2, base + 3, base + 4]);
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

#[test]
fn serves_the_state_booted_from_the_data_dir_config() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("config.json"),
        r#"{"repoRoot": "/repo", "themeLight": "solarized-light", "terminalFontSize": 15}"#,
    )
    .unwrap();
    let server = start_in(dir, &[]);
    let mut client = server.connect();

    send(&mut client, json!({"t": "snapreq", "id": "s"}));
    let snapres = next_frame(&mut client, |f| f["t"] == "snapres");

    let state = &snapres["snapshot"]["state"];
    assert_eq!(state["settings"]["themeLight"], "solarized-light");
    assert_eq!(state["settings"]["terminalFontSize"], 15);
    assert_eq!(state["settings"]["claudeCommand"], "claude");
    assert_eq!(state["worktrees"]["repoRoots"], json!(["/repo"]));
    server.stop();
}

#[test]
fn ws_transport_info_reports_the_bound_address_and_the_listener_token() {
    let server = start(&[]);
    let port: u64 = server.url.rsplit(':').next().unwrap().parse().unwrap();
    let mut client = server.connect();
    let info = request(&mut client, "1", "config:getWsTransportInfo", json!([]));
    assert_eq!(info["ok"], true);
    assert_eq!(
        info["value"],
        json!({"port": port, "token": TOKEN, "host": "127.0.0.1"})
    );
    let rotated = request(&mut client, "2", "config:rotateWsToken", json!([]));
    let rotated = rotated["value"].as_str().unwrap().to_owned();
    let again = request(&mut client, "3", "config:getWsTransportInfo", json!([]));
    assert_eq!(again["value"]["token"], TOKEN);
    drop(client);

    let (stdout, log) = server.stop();
    assert!(log.contains("[ws-transport] auth token rotated — takes effect on next launch"));
    for line in stdout.iter().map(String::as_str).chain(log.lines()) {
        assert!(!line.contains(TOKEN), "token leaked: {line:?}");
        assert!(!line.contains(&rotated), "rotated token leaked: {line:?}");
    }
}

const STRIPPED_PATH: &str = "/launcher/bin:/usr/bin:/bin";
const LOGIN_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

fn start_with_noisy_login_shell() -> Running {
    let home = tempfile::tempdir().unwrap();
    let shell = fake_shell(
        home.path(),
        &format!(
            "touch \"$HOME/probed\"\necho 'starship init: ok'\nprintf '__HARNESS_PATH_BEGIN__\\n{LOGIN_PATH}\\n__HARNESS_PATH_END__\\n'\necho goodbye"
        ),
    );
    let mut command = Command::new(env!("CARGO_BIN_EXE_tatsu-core-testserver"));
    command
        .env_clear()
        .env("PATH", STRIPPED_PATH)
        .env("HOME", home.path())
        .env("SHELL", shell);
    start_with(
        tempfile::tempdir().unwrap(),
        home,
        command,
        &["--test-hooks"],
    )
}

fn path_env(server: &Running) -> Value {
    let mut client = server.connect();
    let res = request(&mut client, "1", "test:pathEnv", json!([]));
    assert_eq!(res["ok"], true, "{res}");
    res["value"].clone()
}

#[cfg(target_os = "macos")]
#[test]
fn path_fix_merges_the_login_shell_path_into_the_server_and_its_children() {
    let server = start_with_noisy_login_shell();
    let shell = server.home.path().join("fake-login-shell");
    let merged = "/launcher/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
    assert_eq!(
        path_env(&server),
        json!({"mergedPath": merged, "childPath": merged})
    );
    assert!(server.home.path().join("probed").exists());
    let (_, log) = server.stop();
    let expected = format!(
        "[path-fix] PATH merged from {} ({} \u{2192} {} chars)",
        shell.display(),
        STRIPPED_PATH.len(),
        merged.len()
    );
    assert!(
        log.lines()
            .any(|line| line.get(15..) == Some(expected.as_str())),
        "{log}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn path_fix_leaves_path_unchanged_and_runs_no_probe_on_linux() {
    let server = start_with_noisy_login_shell();
    assert_eq!(
        path_env(&server),
        json!({"mergedPath": STRIPPED_PATH, "childPath": STRIPPED_PATH})
    );
    assert!(!server.home.path().join("probed").exists());
    let (_, log) = server.stop();
    assert!(!log.contains("[path-fix]"), "{log}");
}
