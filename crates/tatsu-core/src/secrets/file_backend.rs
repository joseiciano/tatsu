use std::io;
use std::path::Path;
use std::sync::Arc;

use aes_gcm::aead::AeadInPlace;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce, Tag};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::secrets_file::{
    NOT_A_STRING, SecretsFile, log_decrypt_failure, node_base64_decode, write_private,
};
use super::{RandomSource, Secrets};
use crate::logs;

pub const KEY_FILE: &str = ".secret-key";

const KEY_LEN: usize = 32;
const IV_LEN: usize = 12;
const TAG_LEN: usize = 16;
const NODE_AUTH_FAILURE: &str = "Unsupported state or unable to authenticate data";

pub struct FileBackend {
    file: SecretsFile,
    cipher: Aes256Gcm,
    random: Arc<dyn RandomSource>,
}

impl FileBackend {
    pub fn open(dir: &Path, random: Arc<dyn RandomSource>) -> io::Result<Self> {
        let key = load_or_create_key(&dir.join(KEY_FILE), random.as_ref())?;
        Ok(Self {
            file: SecretsFile::in_dir(dir),
            cipher: Aes256Gcm::new(&key.into()),
            random,
        })
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
        let _guard = self.file.lock();
        let data = self.file.read();
        match data.get(key).filter(|v| tatsu_js::truthy(v))? {
            Value::String(blob) => self.decrypt(key, blob),
            _ => {
                log_decrypt_failure(key, NOT_A_STRING);
                None
            }
        }
    }

    fn set(&self, key: &str, value: &str) -> bool {
        let _guard = self.file.lock();
        let mut data = self.file.read();
        let Some(blob) = self.encrypt(value) else {
            return false;
        };
        data.insert(key.to_owned(), Value::String(blob));
        self.file.write(data)
    }

    fn has(&self, key: &str) -> bool {
        self.file.has(key)
    }

    fn delete(&self, key: &str) {
        self.file.delete(key);
    }
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
