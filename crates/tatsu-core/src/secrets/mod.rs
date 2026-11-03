mod file_backend;
pub mod ws_token;

#[cfg(test)]
mod tests;

use std::io;
use std::sync::Arc;

use crate::data_dir::DataDir;
use crate::logs;

pub use file_backend::{FileBackend, KEY_FILE, SECRETS_FILE};

pub trait Secrets: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> bool;
    fn has(&self, key: &str) -> bool;
    fn delete(&self, key: &str);
}

pub trait RandomSource: Send + Sync {
    fn fill(&self, buf: &mut [u8]);
}

pub struct OsRandom;

impl RandomSource for OsRandom {
    fn fill(&self, buf: &mut [u8]) {
        use rand::TryRngCore;
        rand::rngs::OsRng
            .try_fill_bytes(buf)
            .expect("operating system random source failed");
    }
}

pub fn open_headless(
    data_dir: &DataDir,
    random: Arc<dyn RandomSource>,
) -> io::Result<Arc<dyn Secrets>> {
    let backend = FileBackend::open(data_dir.path(), random)?;
    logs::log(
        "secrets",
        "using local encrypted file backend (dev/self-hosted only)",
    );
    Ok(Arc::new(backend))
}
