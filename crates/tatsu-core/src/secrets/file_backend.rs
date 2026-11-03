use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use aes_gcm::aead::AeadInPlace;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, Tag};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use parking_lot::Mutex;
use serde_json::{Map, Value};

use super::{RandomSource, Secrets};
use crate::logs;

pub const SECRETS_FILE: &str = "secrets.enc";
pub const KEY_FILE: &str = ".secret-key";

const KEY_LEN: usize = 32;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
const NODE_AUTH_FAILURE: &str = "Unsupported state or unable to authenticate data";
const NOT_A_STRING: &str = "secret blob is not a string";

pub struct FileBackend {
    file: PathBuf,
    cipher: Aes256Gcm,
    random: Arc<dyn RandomSource>,
    lock: Mutex<()>,
}

impl FileBackend {
    pub fn open(dir: &Path, random: Arc<dyn RandomSource>) -> io::Result<Self> {
        let key = load_or_create_key(&dir.join(KEY_FILE), random.as_ref())?;
        Ok(Self {
            file: dir.join(SECRETS_FILE),
            cipher: Aes256Gcm::new(&key.into()),
            random,
            lock: Mutex::new(()),
        })
    }

    fn read_file(&self) -> Map<String, Value> {
        let bytes = match std::fs::read(&self.file) {
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

    fn write_file(&self, data: Map<String, Value>) -> bool {
        let text = tatsu_js::stringify_pretty(&Value::Object(data));
        match write_private(&self.file, text.as_bytes()) {
            Ok(()) => true,
            Err(e) => {
                logs::log_with("secrets", "failed to write secrets file", &e.to_string());
                false
            }
        }
    }

    fn encrypt(&self, value: &str) -> Option<String> {
        let mut iv = [0u8; IV_LEN];
        self.random.fill(&mut iv);
        let mut ct = value.as_bytes().to_vec();
        let tag = self
            .cipher
            .encrypt_in_place_detached(Nonce::from_slice(&iv), b"", &mut ct)
            .ok()?;
        let mut blob = Vec::with_capacity(IV_LEN + TAG_LEN + ct.len());
        blob.extend_from_slice(&iv);
        blob.extend_from_slice(&tag);
        blob.extend_from_slice(&ct);
        Some(STANDARD.encode(blob))
    }

    fn decrypt(&self, key: &str, blob: &str) -> Option<String> {
        let buf = node_base64_decode(blob);
        if buf.len() < IV_LEN + TAG_LEN + 1 {
            return None;
        }
        let (iv, rest) = buf.split_at(IV_LEN);
        let (tag, ct) = rest.split_at(TAG_LEN);
        let mut plain = ct.to_vec();
        match self.cipher.decrypt_in_place_detached(
            Nonce::from_slice(iv),
            b"",
            &mut plain,
            Tag::from_slice(tag),
        ) {
            Ok(()) => Some(String::from_utf8_lossy(&plain).into_owned()),
            Err(_) => {
                log_decrypt_failure(key, NODE_AUTH_FAILURE);
                None
            }
        }
    }
}

impl Secrets for FileBackend {
    fn get(&self, key: &str) -> Option<String> {
        let _guard = self.lock.lock();
        let data = self.read_file();
        match data.get(key).filter(|v| tatsu_js::truthy(v))? {
            Value::String(blob) => self.decrypt(key, blob),
            _ => {
                log_decrypt_failure(key, NOT_A_STRING);
                None
            }
        }
    }

    fn set(&self, key: &str, value: &str) -> bool {
        let _guard = self.lock.lock();
        let mut data = self.read_file();
        let Some(blob) = self.encrypt(value) else {
            return false;
        };
        data.insert(key.to_owned(), Value::String(blob));
        self.write_file(data)
    }

    fn has(&self, key: &str) -> bool {
        let _guard = self.lock.lock();
        self.read_file().get(key).is_some_and(tatsu_js::truthy)
    }

    fn delete(&self, key: &str) {
        let _guard = self.lock.lock();
        let mut data = self.read_file();
        data.shift_remove(key);
        self.write_file(data);
    }
}

fn log_decrypt_failure(key: &str, reason: &str) {
    logs::log_with(
        "secrets",
        &format!("failed to decrypt secret {key}"),
        reason,
    );
}

fn load_or_create_key(path: &Path, random: &dyn RandomSource) -> io::Result<[u8; KEY_LEN]> {
    match std::fs::read(path) {
        Ok(buf) => match <[u8; KEY_LEN]>::try_from(buf.as_slice()) {
            Ok(key) => return Ok(key),
            Err(_) => logs::log("secrets", "existing .secret-key is malformed; regenerating"),
        },
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut key = [0u8; KEY_LEN];
    random.fill(&mut key);
    write_private(path, &key)?;
    Ok(key)
}

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
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

fn node_base64_decode(text: &str) -> Vec<u8> {
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
