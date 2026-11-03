use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tatsu_core::secrets::{RandomSource, Secrets};
use tatsu_core::{
    BootOptions, ClientId, ConnCtx, Core, CoreBuilder, Env, HooksInstaller, IdSource, Platform,
    RouterReply, Runtime,
};
use tatsu_state::StateEvent;

pub const CASE_ROOT_TOKEN: &str = "$CASE";
pub const HOOKS_INSTALLER_ERROR: &str = "hooks installer failed (fixture)";
pub const DEFAULT_WS_HOST: &str = "127.0.0.1";
const CLIENT_ID: &str = "core-recorder";
const SETTLE: Duration = Duration::from_millis(20);
const ACTIVITY_FLUSH: Duration = Duration::from_millis(1000);

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn read_json(path: &Path) -> Value {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    tatsu_js::parse_lenient(&text).unwrap_or_else(|e| panic!("bad JSON in {}: {e}", path.display()))
}

pub fn handler_fixture_files() -> Vec<PathBuf> {
    let dir = repo_root().join("fixtures/core/handlers");
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()))
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    files
}

pub fn cases_in(path: &Path) -> Vec<Value> {
    match read_json(path) {
        Value::Array(cases) => cases,
        _ => panic!("{} is not an array of cases", path.display()),
    }
}

pub fn reply_of(reply: RouterReply) -> Value {
    match reply {
        RouterReply::Value(value) => json!({ "value": value }),
        RouterReply::NoValue => json!({ "noValue": true }),
        RouterReply::Error(message) => json!({ "error": message }),
    }
}

pub fn map_strings(value: &Value, map: &dyn Fn(&str) -> String) -> Value {
    match value {
        Value::String(text) => Value::String(map(text)),
        Value::Array(items) => Value::Array(items.iter().map(|v| map_strings(v, map)).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, field)| (map(key), map_strings(field, map)))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub fn mask_log_line(line: &str) -> String {
    let bytes = line.as_bytes();
    let stamped = bytes.len() >= 14
        && bytes[0] == b'['
        && bytes[13] == b']'
        && bytes[3] == b':'
        && bytes[6] == b':'
        && bytes[9] == b'.'
        && [1, 2, 4, 5, 7, 8, 10, 11, 12]
            .iter()
            .all(|&i| bytes[i].is_ascii_digit());
    if stamped {
        format!("[<ts>]{}", &line[14..])
    } else {
        line.to_owned()
    }
}

pub fn new_log_lines(path: &Path, from: u64, file: &str) -> Vec<Value> {
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    let start = (from as usize).min(bytes.len());
    String::from_utf8_lossy(&bytes[start..])
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(|line| json!({ "file": file, "line": mask_log_line(line) }))
        .collect()
}

fn size_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn file_or_null(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[derive(Default)]
pub struct Faults {
    in_handler: AtomicBool,
    fault: Mutex<Option<String>>,
}

impl Faults {
    fn record(&self, message: String) -> ! {
        self.fault.lock().get_or_insert(message.clone());
        panic!("{message}");
    }

    pub fn in_handler(&self) -> bool {
        self.in_handler.load(Ordering::SeqCst)
    }

    pub fn set_in_handler(&self, on: bool) {
        self.in_handler.store(on, Ordering::SeqCst);
    }

    pub fn take(&self) -> Option<String> {
        self.fault.lock().take()
    }
}

pub struct FixtureIds {
    faults: Arc<Faults>,
    ids: Mutex<Vec<String>>,
    boot_count: AtomicU64,
}

impl IdSource for FixtureIds {
    fn next_id(&self) -> String {
        if self.faults.in_handler() {
            let next = {
                let mut ids = self.ids.lock();
                (!ids.is_empty()).then(|| ids.remove(0))
            };
            return next.unwrap_or_else(|| {
                self.faults
                    .record("fixture `ids` exhausted: add more ids to the case".to_owned())
            });
        }
        let n = self.boot_count.fetch_add(1, Ordering::SeqCst) + 1;
        format!("00000000-0000-4000-8000-{n:012}")
    }
}

pub struct FixtureRandom {
    faults: Arc<Faults>,
    bytes: Mutex<Vec<String>>,
}

impl RandomSource for FixtureRandom {
    fn fill(&self, buf: &mut [u8]) {
        if !self.faults.in_handler() {
            buf.fill(0x5a);
            return;
        }
        let next = {
            let mut bytes = self.bytes.lock();
            (!bytes.is_empty()).then(|| bytes.remove(0))
        };
        let Some(text) = next else {
            self.faults.record(
                "fixture `randomBytes` exhausted: add more hex strings to the case".to_owned(),
            );
        };
        match hex::decode(&text) {
            Ok(decoded) if decoded.len() == buf.len() && hex::encode(&decoded) == text => {
                buf.copy_from_slice(&decoded)
            }
            _ => self.faults.record(format!(
                "fixture `randomBytes` entry must be {} bytes of hex, got {:?}",
                buf.len(),
                text
            )),
        }
    }
}

pub struct MemorySecrets(Mutex<HashMap<String, String>>);

impl Secrets for MemorySecrets {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().get(key).cloned()
    }

    fn set(&self, key: &str, value: &str) -> bool {
        self.0.lock().insert(key.to_owned(), value.to_owned());
        true
    }

    fn has(&self, key: &str) -> bool {
        self.0.lock().contains_key(key)
    }

    fn delete(&self, key: &str) {
        self.0.lock().remove(key);
    }
}

pub struct FakeInstaller {
    faults: Arc<Faults>,
    throws: bool,
}

impl FakeInstaller {
    fn run(&self) -> Result<(), String> {
        if self.throws && self.faults.in_handler() {
            Err(HOOKS_INSTALLER_ERROR.to_owned())
        } else {
            Ok(())
        }
    }
}

impl HooksInstaller for FakeInstaller {
    fn install(&self) -> Result<(), String> {
        self.run()
    }

    fn uninstall(&self) -> Result<(), String> {
        self.run()
    }
}

pub struct Prepared {
    _temp: tempfile::TempDir,
    pub case_root: String,
    pub data_dir: PathBuf,
    pub repos_dir: PathBuf,
    pub core: Arc<Core>,
    pub faults: Arc<Faults>,
    pub worktrees: Value,
}

impl Prepared {
    pub fn map_case(&self, text: &str) -> String {
        text.replace(CASE_ROOT_TOKEN, &self.case_root)
    }

    pub fn unmap_case(&self, text: &str) -> String {
        text.replace(&self.case_root, CASE_ROOT_TOKEN)
    }

    pub fn map_case_value(&self, value: &Value) -> Value {
        map_strings(value, &|text| self.map_case(text))
    }

    pub fn unmap_case_value(&self, value: &Value) -> Value {
        map_strings(value, &|text| self.unmap_case(text))
    }

    pub fn repo_file(&self, key: &str) -> PathBuf {
        self.repos_dir.join(key).join(".harness.json")
    }

    pub fn repo_files_after(&self, keys: &Map<String, Value>) -> Value {
        Value::Object(
            keys.keys()
                .map(|key| {
                    let bytes = match file_or_null(&self.repo_file(key)) {
                        Value::String(text) => Value::String(self.unmap_case(&text)),
                        other => other,
                    };
                    (key.clone(), bytes)
                })
                .collect(),
        )
    }

    pub fn secrets_after(&self, keys: &Map<String, Value>) -> Value {
        let secrets = self.core.secrets();
        Value::Object(
            keys.keys()
                .map(|key| {
                    let value = secrets
                        .get(key)
                        .map(|v| Value::String(self.unmap_case(&v)))
                        .unwrap_or(Value::Null);
                    (key.clone(), value)
                })
                .collect(),
        )
    }

    pub fn activity_after(&self) -> Value {
        file_or_null(&self.data_dir.join("activity.json"))
    }
}

fn str_field<'a>(case: &'a Value, key: &str) -> Option<&'a str> {
    case.get(key).and_then(Value::as_str)
}

fn string_list(case: &Value, key: &str) -> Vec<String> {
    case.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|v| v.as_str().expect("list entries are strings").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

pub fn prepare(case: &Value) -> Result<Prepared, String> {
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let root = std::fs::canonicalize(temp.path()).map_err(|e| e.to_string())?;
    let case_root = root.to_string_lossy().into_owned();
    let data_dir = root.join("data");
    let home_dir = root.join("home");
    let repos_dir = root.join("repos");
    for dir in [&data_dir, &home_dir, &repos_dir] {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let to_case = |text: &str| text.replace(CASE_ROOT_TOKEN, &case_root);

    let config_before = str_field(case, "configBefore").ok_or("case has no configBefore")?;
    std::fs::write(data_dir.join("config.json"), to_case(config_before))
        .map_err(|e| e.to_string())?;
    if let Some(name) = str_field(case, "themesDir") {
        copy_dir(
            &repo_root().join("fixtures/core/themes").join(name),
            &data_dir.join("themes"),
        );
    }
    if let Some(bytes) = str_field(case, "activityBefore") {
        std::fs::write(data_dir.join("activity.json"), bytes).map_err(|e| e.to_string())?;
    }
    if let Some(bytes) = str_field(case, "debugLogBefore") {
        std::fs::write(data_dir.join("debug.log"), bytes).map_err(|e| e.to_string())?;
    }
    if let Some(Value::Object(files)) = case.get("repoFiles") {
        for (key, bytes) in files {
            if key.split('/').any(|part| part == "..") {
                return Err(format!("repoFiles key {key} leaves the repos folder"));
            }
            let dir = repos_dir.join(key);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            if let Value::String(bytes) = bytes {
                std::fs::write(dir.join(".harness.json"), to_case(bytes))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    let mut secrets = HashMap::new();
    if let Some(Value::Object(seed)) = case.get("secretsBefore") {
        for (key, value) in seed {
            if let Value::String(value) = value {
                secrets.insert(key.clone(), value.clone());
            }
        }
    }

    let faults = Arc::new(Faults::default());
    let now = case
        .get("now")
        .and_then(Value::as_i64)
        .ok_or("case has no integer `now`")?;
    let env = Env {
        platform: if cfg!(target_os = "macos") {
            Platform::MacOs
        } else {
            Platform::Linux
        },
        home: home_dir.clone(),
        cwd: root.clone(),
        harness_data_dir: Some(data_dir.clone().into()),
        xdg_config_home: None,
    };
    let core = CoreBuilder::new(Runtime::Headless, env)
        .pre_runtime()
        .map_err(|e| e.to_string())?
        .boot(
            Vec::new(),
            BootOptions {
                secrets: Some(Arc::new(MemorySecrets(Mutex::new(secrets)))),
                random: Arc::new(FixtureRandom {
                    faults: faults.clone(),
                    bytes: Mutex::new(string_list(case, "randomBytes")),
                }),
                ids: Arc::new(FixtureIds {
                    faults: faults.clone(),
                    ids: Mutex::new(string_list(case, "ids")),
                    boot_count: AtomicU64::new(0),
                }),
                clock: Arc::new(move || now),
                timer_ms: Some(Arc::new(|| 0.0)),
            },
        )
        .map_err(|e| e.to_string())?;

    core.set_hooks_installer(Arc::new(FakeInstaller {
        faults: faults.clone(),
        throws: str_field(case, "hooksInstaller") == Some("throw"),
    }));
    match case.get("wsBound") {
        None => core.set_ws_bound(DEFAULT_WS_HOST, 0),
        Some(Value::Null) => {}
        Some(bound) => {
            let host = bound["host"]
                .as_str()
                .ok_or("wsBound.host is not a string")?;
            let port = bound["port"]
                .as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .ok_or("wsBound.port is not a port number")?;
            core.set_ws_bound(host, port);
        }
    }

    let prepared = Prepared {
        _temp: temp,
        case_root,
        data_dir,
        repos_dir,
        core,
        faults,
        worktrees: Value::Null,
    };
    let worktrees = prepared.map_case_value(case.get("worktrees").unwrap_or(&json!([])));
    Ok(Prepared {
        worktrees,
        ..prepared
    })
}

fn decode_event(value: &Value) -> Result<StateEvent, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("bad event {value}: {e}"))
}

pub fn event_json(event: &StateEvent) -> Value {
    serde_json::to_value(event).expect("StateEvent serializes")
}

pub enum CaseResult {
    Fault(String),
    Compared {
        mismatched: Vec<String>,
        actual: Value,
    },
}

pub async fn run_case(case: &Value) -> CaseResult {
    let result = match prepare(case) {
        Ok(p) => run_prepared(&p, case).await,
        Err(message) => Err(message),
    };
    result.unwrap_or_else(CaseResult::Fault)
}

pub async fn apply_setup(p: &Prepared, case: &Value) -> Result<(), String> {
    for event in case
        .get("setup")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        p.core
            .store()
            .dispatch(decode_event(&p.map_case_value(event))?);
    }
    tokio::time::sleep(SETTLE).await;
    p.core.config().flush_sync();
    Ok(())
}

pub async fn run_prepared(p: &Prepared, case: &Value) -> Result<CaseResult, String> {
    let core = p.core.clone();
    if let Some(bytes) = core.config().pending_save() {
        return Err(format!(
            "boot scheduled a config save; boot must not rewrite config.json:\n{}",
            p.unmap_case(&bytes)
        ));
    }
    apply_setup(p, case).await?;

    let debug_log = p.data_dir.join("debug.log");
    let perf_log = p.data_dir.join("perf.log");
    let log_start = (size_of(&debug_log), size_of(&perf_log));
    let captured: Arc<Mutex<Vec<(u64, Value)>>> = Arc::default();
    let sink = captured.clone();
    let subscription = core
        .store()
        .subscribe(move |event, seq| sink.lock().push((seq, event_json(event))));

    let kind = str_field(case, "kind").ok_or("case has no kind")?;
    let args = match case.get("args") {
        Some(Value::Array(args)) => args.iter().map(|a| p.map_case_value(a)).collect(),
        _ => Vec::new(),
    };
    let ctx = ConnCtx {
        client_id: ClientId(CLIENT_ID.to_owned()),
    };
    p.faults.set_in_handler(true);
    let invoked = invoke(&core, case, kind, ctx, args, p).await;
    p.faults.set_in_handler(false);
    tokio::time::sleep(SETTLE).await;
    core.store().unsubscribe(subscription);
    let reply = invoked?;
    if let Some(fault) = p.faults.take() {
        return Err(fault);
    }

    let mut events = std::mem::take(&mut *captured.lock());
    events.sort_by_key(|(seq, _)| *seq);
    let mut actual = Map::new();
    actual.insert(
        "configAfter".to_owned(),
        core.config()
            .pending_save()
            .map(|bytes| Value::String(p.unmap_case(&bytes)))
            .unwrap_or(Value::Null),
    );
    actual.insert(
        "events".to_owned(),
        Value::Array(
            events
                .into_iter()
                .map(|(_, e)| p.unmap_case_value(&e))
                .collect(),
        ),
    );
    if let Some(reply) = reply {
        actual.insert("reply".to_owned(), p.unmap_case_value(&reply));
    }
    if let Some(Value::Object(keys)) = case.get("repoFiles") {
        actual.insert("repoFilesAfter".to_owned(), p.repo_files_after(keys));
    }
    if let Some(Value::Object(keys)) = case.get("secretsBefore") {
        actual.insert("secretsAfter".to_owned(), p.secrets_after(keys));
    }
    let mut log_lines = new_log_lines(&debug_log, log_start.0, "debug.log");
    log_lines.extend(new_log_lines(&perf_log, log_start.1, "perf.log"));
    if !log_lines.is_empty() {
        actual.insert(
            "logLines".to_owned(),
            p.unmap_case_value(&Value::Array(log_lines)),
        );
    }
    if let Some(before) = str_field(case, "debugLogBefore") {
        let now = std::fs::read_to_string(&debug_log).unwrap_or_default();
        if !now.starts_with(before) {
            return Err("debugLogBefore did not survive at the start of debug.log".to_owned());
        }
    }
    if case.get("activityBefore").is_some() {
        tokio::time::sleep(ACTIVITY_FLUSH).await;
        core.activity().settled().await;
        actual.insert("activityAfter".to_owned(), p.activity_after());
    }
    let actual = Value::Object(actual);
    let expected = case.get("expected").ok_or("case has no expected")?;
    Ok(CaseResult::Compared {
        mismatched: mismatched_fields(expected, &actual),
        actual,
    })
}

async fn invoke(
    core: &Arc<Core>,
    case: &Value,
    kind: &str,
    ctx: ConnCtx,
    args: Vec<Value>,
    p: &Prepared,
) -> Result<Option<Value>, String> {
    if kind == "event" {
        let event = case.get("event").ok_or("kind \"event\" needs `event`")?;
        core.store()
            .dispatch(decode_event(&p.map_case_value(event))?);
        return Ok(None);
    }
    let channel = str_field(case, "channel").ok_or("case needs `channel`")?;
    match kind {
        "signal" => {
            if !core.router().has_signal(channel) {
                return Err(format!("no signal handler registered for {channel}"));
            }
            core.router().dispatch_signal(ctx, channel, args);
            Ok(None)
        }
        "request" => {
            if !core.router().has_request(channel) {
                return Err(format!("no request handler registered for {channel}"));
            }
            let routed = core.router().dispatch_request(ctx, channel, args).await;
            Ok(Some(reply_of(routed.reply)))
        }
        other => Err(format!("unknown case kind {other:?}")),
    }
}

pub fn mismatched_fields(expected: &Value, actual: &Value) -> Vec<String> {
    let mut keys: Vec<&String> = expected
        .as_object()
        .into_iter()
        .flat_map(|m| m.keys())
        .chain(actual.as_object().into_iter().flat_map(|m| m.keys()))
        .collect();
    keys.sort();
    keys.dedup();
    keys.into_iter()
        .filter(|key| {
            let canon = |v: Option<&Value>| v.map(tatsu_js::stringify);
            canon(expected.get(key.as_str())) != canon(actual.get(key.as_str()))
        })
        .cloned()
        .collect()
}

pub fn report(case: &Value, actual: &Value, mismatched: &[String]) -> String {
    let mut input = case.clone();
    let expected = input
        .as_object_mut()
        .and_then(|m| m.remove("expected"))
        .unwrap_or(Value::Null);
    format!(
        "case {:?}: fields differ: {}\n--- input ---\n{}\n--- expected ---\n{}\n--- actual ---\n{}",
        str_field(case, "name").unwrap_or("<unnamed>"),
        mismatched.join(", "),
        tatsu_js::stringify_pretty(&input),
        tatsu_js::stringify_pretty(&expected),
        tatsu_js::stringify_pretty(actual),
    )
}
