use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use tempfile::TempDir;

use super::ws_token;
use super::*;

const KEYS: [&str; 4] = [
    "githubToken",
    "wsAuthToken",
    "backend-token:abc",
    "openaiApiKey",
];

struct Counter(AtomicU8);

impl Counter {
    fn starting_at(byte: u8) -> Arc<Self> {
        Arc::new(Self(AtomicU8::new(byte)))
    }
}

impl RandomSource for Counter {
    fn fill(&self, buf: &mut [u8]) {
        buf.fill(self.0.fetch_add(1, Ordering::Relaxed));
    }
}

fn open(dir: &Path, first_byte: u8) -> FileBackend {
    FileBackend::open(dir, Counter::starting_at(first_byte)).unwrap()
}

fn secrets_text(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(SECRETS_FILE)).unwrap()
}

fn write_secrets(dir: &Path, text: &str) {
    std::fs::write(dir.join(SECRETS_FILE), text).unwrap();
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

#[test]
fn values_round_trip_across_backend_instances() {
    let tmp = TempDir::new().unwrap();
    let writer = open(tmp.path(), 1);
    for (i, key) in KEYS.iter().enumerate() {
        assert!(writer.set(key, &format!("value-{i}-é")));
    }

    let reader = open(tmp.path(), 100);
    for (i, key) in KEYS.iter().enumerate() {
        assert_eq!(reader.get(key), Some(format!("value-{i}-é")));
        assert!(reader.has(key));
    }
    assert_eq!(reader.get("missing"), None);
    assert!(!reader.has("missing"));
}

#[test]
fn decrypts_a_blob_written_by_node() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join(KEY_FILE), [0x11; 32]).unwrap();
    write_secrets(
        tmp.path(),
        "{\n  \"githubToken\": \"IiIiIiIiIiIiIiIiDDERTGIqAT5MdNzye+DyVXCfdxa0quwr\"\n}",
    );

    let backend = open(tmp.path(), 0);

    assert_eq!(backend.get("githubToken").as_deref(), Some("ghp_test"));
}

#[test]
fn writes_node_layout_with_iv_tag_ciphertext() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join(KEY_FILE), [0x11; 32]).unwrap();
    let backend = FileBackend::open(tmp.path(), Counter::starting_at(0x22)).unwrap();

    backend.set("githubToken", "ghp_test");

    assert_eq!(
        secrets_text(tmp.path()),
        "{\n  \"githubToken\": \"IiIiIiIiIiIiIiIiDDERTGIqAT5MdNzye+DyVXCfdxa0quwr\"\n}"
    );
}

#[test]
fn key_order_survives_set_and_delete() {
    let tmp = TempDir::new().unwrap();
    let backend = open(tmp.path(), 1);
    for key in KEYS {
        backend.set(key, "v");
    }

    backend.set("wsAuthToken", "changed");
    backend.delete("wsAuthToken");
    backend.delete("never-set");

    let doc: Vec<String> = match tatsu_js::parse_lenient(&secrets_text(tmp.path())).unwrap() {
        serde_json::Value::Object(map) => map.keys().cloned().collect(),
        other => panic!("not an object: {other}"),
    };
    assert_eq!(doc, ["githubToken", "backend-token:abc", "openaiApiKey"]);
    assert_eq!(backend.get("wsAuthToken"), None);
}

#[test]
fn deleting_the_last_key_leaves_an_empty_object() {
    let tmp = TempDir::new().unwrap();
    let backend = open(tmp.path(), 1);
    backend.set("githubToken", "v");

    backend.delete("githubToken");

    assert_eq!(secrets_text(tmp.path()), "{}");
}

#[test]
fn has_reads_presence_without_decrypting() {
    let tmp = TempDir::new().unwrap();
    let backend = open(tmp.path(), 1);
    write_secrets(
        tmp.path(),
        r#"{"corrupt": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "short": "AAAA", "empty": "", "number": 1, "nul": null}"#,
    );

    assert!(backend.has("corrupt"));
    assert_eq!(backend.get("corrupt"), None);
    assert!(backend.has("short"));
    assert_eq!(backend.get("short"), None);
    assert!(!backend.has("empty"));
    assert_eq!(backend.get("empty"), None);
    assert!(backend.has("number"));
    assert_eq!(backend.get("number"), None);
    assert!(!backend.has("nul"));
}

#[test]
fn a_blob_under_another_key_fails_authentication() {
    let tmp = TempDir::new().unwrap();
    open(tmp.path(), 1).set("githubToken", "secret");
    std::fs::write(tmp.path().join(KEY_FILE), [0x77; 32]).unwrap();

    assert_eq!(open(tmp.path(), 1).get("githubToken"), None);
}

#[test]
fn unreadable_json_reads_as_empty_and_the_next_set_rewrites_it() {
    let tmp = TempDir::new().unwrap();
    let backend = open(tmp.path(), 1);
    write_secrets(tmp.path(), "{not json");

    assert!(!backend.has("githubToken"));
    assert!(backend.set("githubToken", "v"));
    assert_eq!(backend.get("githubToken").as_deref(), Some("v"));
}

#[test]
fn a_missing_key_file_is_created_from_the_random_source() {
    let tmp = TempDir::new().unwrap();

    open(tmp.path(), 0x42);

    assert_eq!(
        std::fs::read(tmp.path().join(KEY_FILE)).unwrap(),
        [0x42; 32]
    );
}

#[test]
fn a_wrong_length_key_file_is_regenerated() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join(KEY_FILE), [0x11; 31]).unwrap();

    open(tmp.path(), 0x42);

    assert_eq!(
        std::fs::read(tmp.path().join(KEY_FILE)).unwrap(),
        [0x42; 32]
    );
}

#[test]
fn a_valid_key_file_is_kept() {
    let tmp = TempDir::new().unwrap();
    std::fs::write(tmp.path().join(KEY_FILE), [0x11; 32]).unwrap();

    open(tmp.path(), 0x42);

    assert_eq!(
        std::fs::read(tmp.path().join(KEY_FILE)).unwrap(),
        [0x11; 32]
    );
}

#[cfg(unix)]
#[test]
fn both_files_are_private_even_when_they_existed_wider() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = TempDir::new().unwrap();
    let key = tmp.path().join(KEY_FILE);
    let file = tmp.path().join(SECRETS_FILE);
    std::fs::write(&key, [0x11; 31]).unwrap();
    std::fs::write(&file, "{}").unwrap();
    for path in [&key, &file] {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644)).unwrap();
    }

    open(tmp.path(), 1).set("githubToken", "v");

    assert_eq!(mode(&key), 0o600);
    assert_eq!(mode(&file), 0o600);
}

#[cfg(unix)]
#[test]
fn fresh_files_are_private() {
    let tmp = TempDir::new().unwrap();

    open(tmp.path(), 1).set("githubToken", "v");

    assert_eq!(mode(&tmp.path().join(KEY_FILE)), 0o600);
    assert_eq!(mode(&tmp.path().join(SECRETS_FILE)), 0o600);
}

#[test]
fn ws_token_is_created_once_then_reused() {
    let tmp = TempDir::new().unwrap();
    let backend = open(tmp.path(), 1);
    let random = Counter::starting_at(0xab);

    let first = ws_token::get_or_create(&backend, random.as_ref());
    let second = ws_token::get_or_create(&open(tmp.path(), 1), random.as_ref());

    assert_eq!(first, "ab".repeat(32));
    assert_eq!(second, first);
    assert_eq!(backend.get("wsAuthToken"), Some(first));
}

#[test]
fn ws_token_returns_a_stored_token_untouched() {
    let tmp = TempDir::new().unwrap();
    let backend = open(tmp.path(), 1);
    backend.set("wsAuthToken", "pinned-token");

    let token = ws_token::get_or_create(&backend, Counter::starting_at(0xab).as_ref());

    assert_eq!(token, "pinned-token");
}

#[test]
fn ws_token_rotate_replaces_the_stored_token() {
    let tmp = TempDir::new().unwrap();
    let backend = open(tmp.path(), 1);
    let random = Counter::starting_at(0x0f);
    let first = ws_token::get_or_create(&backend, random.as_ref());

    let rotated = ws_token::rotate(&backend, random.as_ref());

    assert_eq!(first, "0f".repeat(32));
    assert_eq!(rotated, "10".repeat(32));
    assert_eq!(backend.get("wsAuthToken"), Some(rotated));
}

struct Refusing;

impl Secrets for Refusing {
    fn get(&self, _: &str) -> Option<String> {
        None
    }
    fn set(&self, _: &str, _: &str) -> bool {
        false
    }
    fn has(&self, _: &str) -> bool {
        false
    }
    fn delete(&self, _: &str) {}
}

#[test]
fn ws_token_is_fresh_each_time_when_the_store_refuses() {
    let random = Counter::starting_at(1);

    let first = ws_token::get_or_create(&Refusing, random.as_ref());
    let second = ws_token::get_or_create(&Refusing, random.as_ref());

    assert_eq!(first.len(), 64);
    assert_ne!(first, second);
}

#[test]
fn os_random_fills_distinct_buffers() {
    let mut a = [0u8; 32];
    let mut b = [0u8; 32];
    OsRandom.fill(&mut a);
    OsRandom.fill(&mut b);
    assert_ne!(a, b);
}
