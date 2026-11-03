use std::path::Path;
use std::sync::OnceLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::Secrets;
use super::oscrypt::OsCrypt;
use super::secrets_file::{NOT_A_STRING, SecretsFile, log_decrypt_failure, node_base64_decode};
use crate::data_dir::{Platform, Runtime};
use crate::logs;

pub const NOT_AVAILABLE_LOG: &str = "safeStorage encryption not available, refusing to store";

pub trait KeyStore: Send + Sync {
    fn password(&self) -> Option<Vec<u8>>;
}

pub struct Unavailable;

impl KeyStore for Unavailable {
    fn password(&self) -> Option<Vec<u8>> {
        None
    }
}

pub const ELECTRON_APP_NAME: &str = "harness";

pub fn electron_app_name(runtime: Runtime) -> Option<&'static str> {
    match runtime {
        Runtime::DesktopPackaged | Runtime::DesktopDev => Some(ELECTRON_APP_NAME),
        Runtime::Headless => None,
    }
}

pub fn os_key_store(runtime: Runtime) -> Box<dyn KeyStore> {
    let Some(app_name) = electron_app_name(runtime) else {
        return Box::new(Unavailable);
    };
    #[cfg(target_os = "macos")]
    let store = super::keychain_macos::KeychainPassword::for_app(app_name);
    #[cfg(target_os = "linux")]
    let store = super::secret_service_linux::LibsecretPassword::for_app(app_name);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let store = {
        let _ = app_name;
        Unavailable
    };
    Box::new(store)
}

pub struct DesktopBackend {
    file: SecretsFile,
    platform: Platform,
    key_store: Box<dyn KeyStore>,
    cipher: OnceLock<Option<OsCrypt>>,
}

impl DesktopBackend {
    pub fn new(dir: &Path, platform: Platform, key_store: Box<dyn KeyStore>) -> Self {
        Self {
            file: SecretsFile::in_dir(dir),
            platform,
            key_store,
            cipher: OnceLock::new(),
        }
    }

    fn cipher(&self) -> Option<&OsCrypt> {
        self.cipher
            .get_or_init(|| {
                self.key_store
                    .password()
                    .filter(|password| !password.is_empty())
                    .map(|password| OsCrypt::new(self.platform, &password))
            })
            .as_ref()
    }
}

impl Secrets for DesktopBackend {
    fn get(&self, key: &str) -> Option<String> {
        let cipher = self.cipher()?;
        let _guard = self.file.lock();
        let data = self.file.read();
        match data.get(key).filter(|v| tatsu_js::truthy(v))? {
            Value::String(blob) => match cipher.decrypt(&node_base64_decode(blob)) {
                Ok(plain) => Some(String::from_utf8_lossy(&plain).into_owned()),
                Err(e) => {
                    log_decrypt_failure(key, e.electron_message());
                    None
                }
            },
            _ => {
                log_decrypt_failure(key, NOT_A_STRING);
                None
            }
        }
    }

    fn set(&self, key: &str, value: &str) -> bool {
        let Some(cipher) = self.cipher() else {
            logs::log("secrets", NOT_AVAILABLE_LOG);
            return false;
        };
        let _guard = self.file.lock();
        let mut data = self.file.read();
        let blob = STANDARD.encode(cipher.encrypt(value.as_bytes()));
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tempfile::TempDir;

    use super::*;
    use crate::secrets::SECRETS_FILE;

    const MAC_PASSWORD: &[u8] = b"dGVzdC1rZXljaGFpbi1wd2Q=";
    const LINUX_PASSWORD: &[u8] = b"linux-secret-service-pw";
    const TOKEN: &str = "ghp_example-token-é";
    const NODE_MAC_V10: &str = "djEwjCiPTwDsG5mZxkS1FT7qkm2Ob9Yz7uWUOirlRfsuTQY=";
    const NODE_LINUX_V11: &str = "djExgqfdqhS3ua9tvONciRd3N6T/DFY7lFyJh/eHzSbZENc=";

    struct Counting {
        password: Option<&'static [u8]>,
        calls: Arc<AtomicUsize>,
    }

    impl KeyStore for Counting {
        fn password(&self) -> Option<Vec<u8>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.password.map(<[u8]>::to_vec)
        }
    }

    fn backend(
        dir: &Path,
        platform: Platform,
        password: Option<&'static [u8]>,
    ) -> (DesktopBackend, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let store = Counting {
            password,
            calls: calls.clone(),
        };
        (DesktopBackend::new(dir, platform, Box::new(store)), calls)
    }

    fn write_secrets(dir: &Path, text: &str) {
        std::fs::write(dir.join(SECRETS_FILE), text).unwrap();
    }

    fn stored(dir: &Path) -> serde_json::Map<String, Value> {
        match serde_json::from_str(&std::fs::read_to_string(dir.join(SECRETS_FILE)).unwrap()) {
            Ok(Value::Object(map)) => map,
            other => panic!("secrets file is not an object: {other:?}"),
        }
    }

    #[test]
    fn reads_an_electron_mac_blob_and_writes_the_same_bytes() {
        let tmp = TempDir::new().unwrap();
        write_secrets(
            tmp.path(),
            &format!("{{\n  \"githubToken\": \"{NODE_MAC_V10}\"\n}}"),
        );
        let (store, _) = backend(tmp.path(), Platform::MacOs, Some(MAC_PASSWORD));

        assert_eq!(store.get("githubToken").as_deref(), Some(TOKEN));

        assert!(store.set("backend-token:abc", TOKEN));
        let data = stored(tmp.path());
        assert_eq!(data["backend-token:abc"], NODE_MAC_V10);
        assert_eq!(
            data.keys().collect::<Vec<_>>(),
            ["githubToken", "backend-token:abc"]
        );
    }

    #[test]
    fn reads_and_writes_linux_v11_blobs() {
        let tmp = TempDir::new().unwrap();
        let (store, _) = backend(tmp.path(), Platform::Linux, Some(LINUX_PASSWORD));

        assert!(store.set("githubToken", TOKEN));

        assert_eq!(stored(tmp.path())["githubToken"], NODE_LINUX_V11);
        assert_eq!(store.get("githubToken").as_deref(), Some(TOKEN));
    }

    #[test]
    fn unavailable_store_reads_nothing_refuses_writes_and_still_answers_has() {
        let tmp = TempDir::new().unwrap();
        let original = format!("{{\n  \"githubToken\": \"{NODE_MAC_V10}\"\n}}");
        write_secrets(tmp.path(), &original);
        let (store, _) = backend(tmp.path(), Platform::MacOs, None);

        assert_eq!(store.get("githubToken"), None);
        assert!(!store.set("githubToken", "ghp_new"));
        assert!(!store.set("wsAuthToken", "abc"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join(SECRETS_FILE)).unwrap(),
            original
        );
        assert!(store.has("githubToken"));
        assert!(!store.has("wsAuthToken"));

        store.delete("githubToken");
        assert!(!store.has("githubToken"));
    }

    #[test]
    fn an_empty_password_counts_as_unavailable() {
        let tmp = TempDir::new().unwrap();
        let (store, _) = backend(tmp.path(), Platform::MacOs, Some(b""));

        assert!(!store.set("githubToken", TOKEN));
        assert!(!tmp.path().join(SECRETS_FILE).exists());
    }

    #[test]
    fn the_key_store_is_asked_once_and_never_by_has_or_delete() {
        let tmp = TempDir::new().unwrap();
        let (store, calls) = backend(tmp.path(), Platform::MacOs, Some(MAC_PASSWORD));

        store.has("githubToken");
        store.delete("githubToken");
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        store.set("githubToken", TOKEN);
        store.get("githubToken");
        store.get("githubToken");
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let (refused, calls) = backend(tmp.path(), Platform::MacOs, None);
        refused.get("githubToken");
        refused.set("githubToken", TOKEN);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn blobs_that_do_not_decrypt_read_as_absent() {
        let tmp = TempDir::new().unwrap();
        write_secrets(
            tmp.path(),
            &format!(
                "{{\"linux\": \"{NODE_LINUX_V11}\", \"plain\": \"Z2hwX3BsYWlu\", \"number\": 5}}"
            ),
        );
        let (store, _) = backend(tmp.path(), Platform::MacOs, Some(MAC_PASSWORD));

        assert_eq!(store.get("linux"), None);
        assert_eq!(store.get("plain"), None);
        assert_eq!(store.get("number"), None);
        assert!(store.has("plain"));
    }

    #[test]
    fn an_empty_value_is_stored_as_an_empty_blob_like_safe_storage() {
        let tmp = TempDir::new().unwrap();
        let (store, _) = backend(tmp.path(), Platform::MacOs, Some(MAC_PASSWORD));

        assert!(store.set("githubToken", ""));

        assert_eq!(stored(tmp.path())["githubToken"], "");
        assert_eq!(store.get("githubToken"), None);
        assert!(!store.has("githubToken"));
    }

    #[test]
    #[ignore = "reads the real OS key store (macOS Keychain or Secret Service) and may prompt; manual check only"]
    fn real_os_key_store_reports_password_length() {
        let store = os_key_store(Runtime::DesktopPackaged);
        let password = store.password();
        println!("password length: {:?}", password.map(|p| p.len()));
    }
}
