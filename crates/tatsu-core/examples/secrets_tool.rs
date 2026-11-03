use std::io::Read;
use std::process::ExitCode;
use std::sync::Arc;

use serde_json::{Map, Value};
use tatsu_core::DataDir;
use tatsu_core::secrets::{self, OsRandom, Secrets};

const USAGE: &str = "usage: secrets_tool <data-dir> (write | verify | delete <key>); write and verify read a JSON object from stdin";

fn stdin_object() -> Result<Map<String, Value>, String> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    match tatsu_js::parse_lenient(&text).map_err(|e| e.to_string())? {
        Value::Object(map) => Ok(map),
        _ => Err("stdin must hold a JSON object".to_owned()),
    }
}

fn verify(store: &dyn Secrets, expected: Map<String, Value>) -> Vec<String> {
    expected
        .into_iter()
        .filter(|(key, want)| store.get(key).as_deref() != want.as_str())
        .map(|(key, _)| key)
        .collect()
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let dir = args.next().ok_or(USAGE)?;
    let command = args.next().ok_or(USAGE)?;
    let dir = DataDir::from_path(dir).map_err(|e| e.to_string())?;
    let store = secrets::open_headless(&dir, Arc::new(OsRandom)).map_err(|e| e.to_string())?;
    match command.as_str() {
        "write" => {
            for (key, value) in stdin_object()? {
                let value = value.as_str().ok_or("values must be strings")?;
                if !store.set(&key, value) {
                    return Err(format!("set refused for {key}"));
                }
            }
            Ok(())
        }
        "verify" => match verify(store.as_ref(), stdin_object()?).as_slice() {
            [] => Ok(()),
            wrong => Err(format!("mismatched keys: {}", wrong.join(", "))),
        },
        "delete" => {
            store.delete(&args.next().ok_or(USAGE)?);
            Ok(())
        }
        _ => Err(USAGE.to_owned()),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}
