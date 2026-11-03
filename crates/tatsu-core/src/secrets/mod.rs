pub mod desktop;
mod file_backend;
#[cfg(target_os = "macos")]
mod keychain_macos;
pub mod oscrypt;
#[cfg(target_os = "linux")]
mod secret_service_linux;
mod secrets_file;
pub mod ws_token;

#[cfg(test)]
mod tests;

use std::io;
use std::sync::Arc;

use crate::data_dir::{DataDir, Platform, Runtime};
use crate::logs;

pub use desktop::{DesktopBackend, KeyStore};
pub use file_backend::{FileBackend, KEY_FILE};
pub use secrets_file::SECRETS_FILE;

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

pub fn open_desktop(data_dir: &DataDir, runtime: Runtime) -> Arc<dyn Secrets> {
    let platform = if cfg!(target_os = "macos") {
        Platform::MacOs
    } else {
        Platform::Linux
    };
    Arc::new(DesktopBackend::new(
        data_dir.path(),
        platform,
        desktop::os_key_store(runtime),
    ))
}
