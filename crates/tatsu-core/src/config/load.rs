use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::ConfigDoc;
use super::migrations::{self, JsObject, MigrationCtx, MigrationError};
use crate::logs;

pub const CONFIG_FILE: &str = "config.json";
const LOCAL_BACKEND_ID: &str = "local";

pub(crate) type Migration = fn(&mut JsObject, &mut MigrationCtx) -> Result<(), MigrationError>;

pub(crate) const MIGRATIONS: &[Migration] = &[
    migrations::repo_root_to_repo_roots,
    migrations::terminal_tabs_to_flat_panes,
    migrations::flat_panes_to_nested_panes,
    migrations::claude_tab_type_to_agent,
    migrations::pane_lists_to_trees,
    migrations::snooze_fields,
    migrations::legacy_theme_to_theme_mode,
    migrations::seed_harness_config,
    migrations::backfill_json_claude_agent_kind,
];

pub const SCHEMA_VERSION: u64 = MIGRATIONS.len() as u64;

pub fn run_migrations(
    parsed: &mut Map<String, Value>,
    ctx: &mut MigrationCtx,
) -> Result<(), MigrationError> {
    let from = match parsed.get("schemaVersion") {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        _ => 0.0,
    };
    if from < MIGRATIONS.len() as f64 {
        if from < 0.0 || from.fract() != 0.0 {
            return Err(MigrationError("schemaVersion is not a migration index"));
        }
        let mut config = JsObject::from_map(std::mem::take(parsed));
        let ran = MIGRATIONS[from as usize..]
            .iter()
            .try_for_each(|migration| migration(&mut config, ctx));
        *parsed = config.to_map();
        ran?;
    }
    parsed.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    Ok(())
}

pub fn load(path: &Path, now_ms: i64) -> ConfigDoc {
    load_with(path, &mut MigrationCtx::new(now_ms))
}

pub fn load_with(path: &Path, ctx: &mut MigrationCtx) -> ConfigDoc {
    let mut doc = defaults();
    if let Some(mut parsed) = read_parsed(path, ctx.now_ms)
        && run_migrations(&mut parsed, ctx).is_ok()
    {
        for (key, value) in parsed {
            doc.set(key, value);
        }
    }
    doc.set("schemaVersion", json!(SCHEMA_VERSION));
    apply_connection_defaults(&mut doc, ctx.now_ms);
    doc
}

fn defaults() -> ConfigDoc {
    let mut doc = ConfigDoc::new();
    doc.set("schemaVersion", json!(0));
    doc.set("windowBounds", Value::Null);
    doc.set("repoRoots", json!([]));
    doc
}

fn read_parsed(path: &Path, now_ms: i64) -> Option<Map<String, Value>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return None,
        Err(err) => {
            logs::log_with(
                "config",
                "config.json could not be read; using defaults",
                &json!({ "error": err.to_string() }),
            );
            return None;
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let error = match tatsu_js::parse_lenient(&text) {
        Ok(Value::Object(map)) => return Some(map),
        Ok(_) => "top-level value is not an object".to_owned(),
        Err(err) => err.to_string(),
    };
    let backup = backup_path(path, now_ms);
    let renamed = std::fs::rename(path, &backup);
    logs::log_with(
        "config",
        "config.json did not parse; kept a backup and using defaults",
        &json!({
            "error": error,
            "backup": backup.to_string_lossy(),
            "renameError": renamed.err().map(|e| e.to_string()),
        }),
    );
    None
}

fn backup_path(path: &Path, now_ms: i64) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| CONFIG_FILE.to_owned());
    path.with_file_name(format!("{name}.bad-{now_ms}"))
}

fn apply_connection_defaults(doc: &mut ConfigDoc, now_ms: i64) {
    if doc.get("connections").is_none_or(needs_default_connections) {
        doc.set(
            "connections",
            json!([{
                "id": LOCAL_BACKEND_ID,
                "label": "Local",
                "url": "",
                "kind": "local",
                "addedAt": now_ms,
            }]),
        );
    }
    if !doc.get("activeBackendId").is_some_and(tatsu_js::truthy) {
        doc.set("activeBackendId", json!(LOCAL_BACKEND_ID));
    }
}

fn needs_default_connections(value: &Value) -> bool {
    if !tatsu_js::truthy(value) {
        return true;
    }
    match value {
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map
            .get("length")
            .and_then(Value::as_f64)
            .is_some_and(|len| len == 0.0),
        _ => false,
    }
}
