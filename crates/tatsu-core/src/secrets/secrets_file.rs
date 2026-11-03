use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use parking_lot::{Mutex, MutexGuard};
use serde_json::{Map, Value};

use crate::logs;

pub const SECRETS_FILE: &str = "secrets.enc";
pub(super) const NOT_A_STRING: &str = "secret blob is not a string";

pub(super) struct SecretsFile {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SecretsFile {
    pub(super) fn in_dir(dir: &Path) -> Self {
        Self {
            path: dir.join(SECRETS_FILE),
            lock: Mutex::new(()),
        }
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock()
    }

    pub(super) fn read(&self) -> Map<String, Value> {
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Map::new(),
            Err(e) => {
                logs::log_with("secrets", "failed to read secrets file", &e.to_string());
                return Map::new();
            }
        };
        match tatsu_js::parse_lenient(&String::from_utf8_lossy(&bytes)) {
            Ok(Value::Object(map)) => map,
            Ok(_) => Map::new(),
            Err(e) => {
                logs::log_with("secrets", "failed to read secrets file", &e.to_string());
                Map::new()
            }
        }
    }

    pub(super) fn write(&self, data: Map<String, Value>) -> bool {
        let text = tatsu_js::stringify_pretty(&Value::Object(data));
        match write_private(&self.path, text.as_bytes()) {
            Ok(()) => true,
            Err(e) => {
                logs::log_with("secrets", "failed to write secrets file", &e.to_string());
                false
            }
        }
    }

    pub(super) fn has(&self, key: &str) -> bool {
        let _guard = self.lock();
        self.read().get(key).is_some_and(tatsu_js::truthy)
    }

    pub(super) fn delete(&self, key: &str) {
        let _guard = self.lock();
        let mut data = self.read();
        data.shift_remove(key);
        self.write(data);
    }
}

pub(super) fn log_decrypt_failure(key: &str, reason: &str) {
    logs::log_with(
        "secrets",
        &format!("failed to decrypt secret {key}"),
        reason,
    );
}

pub(super) fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)
}

pub(super) fn node_base64_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for byte in text.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(sextet);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}
