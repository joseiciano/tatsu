use std::io::Read;
use std::process::ExitCode;

use serde_json::{Map, Value};
use tatsu_core::Platform;
use tatsu_core::secrets::desktop::Unavailable;
use tatsu_core::secrets::{DesktopBackend, KeyStore, Secrets};

const USAGE: &str = "usage: oscrypt_tool <data-dir> (mac | linux) (write | read) [--unavailable]; the key store password comes from OSCRYPT_TEST_PASSWORD, write reads a JSON object of values from stdin, read reads a JSON array of keys from stdin and prints RESULT <json>";

struct EnvPassword(Vec<u8>);

impl KeyStore for EnvPassword {
    fn password(&self) -> Option<Vec<u8>> {
        Some(self.0.clone())
    }
}

fn stdin_json() -> Result<Value, String> {
    let mut text = String::new();
    std::io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| e.to_string())?;
    tatsu_js::parse_lenient(&text).map_err(|e| e.to_string())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [dir, platform, command, rest @ ..] = args.as_slice() else {
        return Err(USAGE.to_owned());
    };
    let platform = match platform.as_str() {
        "mac" => Platform::MacOs,
        "linux" => Platform::Linux,
        _ => return Err(USAGE.to_owned()),
    };
    let key_store: Box<dyn KeyStore> = match rest {
        [flag] if flag == "--unavailable" => Box::new(Unavailable),
        [] => Box::new(EnvPassword(
            std::env::var("OSCRYPT_TEST_PASSWORD")
                .map_err(|_| "OSCRYPT_TEST_PASSWORD is not set")?
                .into_bytes(),
        )),
        _ => return Err(USAGE.to_owned()),
    };
    let store = DesktopBackend::new(dir.as_ref(), platform, key_store);
    match command.as_str() {
        "write" => {
            let Value::Object(values) = stdin_json()? else {
                return Err("stdin must hold a JSON object".to_owned());
            };
            for (key, value) in values {
                let value = value.as_str().ok_or("values must be strings")?;
                if !store.set(&key, value) {
                    return Err(format!("set refused for {key}"));
                }
            }
            Ok(())
        }
        "read" => {
            let Value::Array(keys) = stdin_json()? else {
                return Err("stdin must hold a JSON array".to_owned());
            };
            let mut out = Map::new();
            for key in keys {
                let key = key.as_str().ok_or("keys must be strings")?;
                let value = store.get(key).map_or(Value::Null, Value::String);
                out.insert(key.to_owned(), value);
            }
            println!("RESULT {}", Value::Object(out));
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
