mod debug;
mod format;
mod perf;

use std::io::Write;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::Serialize;

use crate::data_dir::DataDir;

pub use debug::{DebugLog, MAX_BYTES, ROTATE_CHECK_EVERY};
pub use format::LogClock;
pub use perf::PerfLog;

struct Logs {
    debug: Mutex<DebugLog>,
    perf: Mutex<PerfLog>,
}

static LOGS: OnceLock<Logs> = OnceLock::new();

pub fn init(data_dir: &DataDir) {
    let _ = LOGS.set(Logs {
        debug: Mutex::new(DebugLog::new(data_dir.path().join("debug.log"))),
        perf: Mutex::new(PerfLog::new(data_dir.path().join("perf.log"))),
    });
}

pub fn set_clock(clock: LogClock) {
    if let Some(logs) = LOGS.get() {
        guard(&logs.debug).set_clock(clock.clone());
        guard(&logs.perf).set_clock(clock);
    }
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn echo(line: &str) {
    let _ = writeln!(std::io::stdout(), "{line}");
}

pub fn log(category: &str, message: &str) {
    match LOGS.get() {
        Some(logs) => guard(&logs.debug).log(category, message),
        None => echo(&format::line_now(category, message, "")),
    }
}

pub fn log_with<T: Serialize + ?Sized>(category: &str, message: &str, data: &T) {
    match LOGS.get() {
        Some(logs) => guard(&logs.debug).log_with(category, message, data),
        None => echo(&format::line_now(
            category,
            message,
            &format::data_suffix(data),
        )),
    }
}

pub fn perf(category: &str, message: &str) {
    if let Some(logs) = LOGS.get() {
        guard(&logs.perf).log(category, message);
    }
}

pub fn perf_with<T: Serialize + ?Sized>(category: &str, message: &str, data: &T) {
    if let Some(logs) = LOGS.get() {
        guard(&logs.perf).log_with(category, message, data);
    }
}

pub fn flush() {
    let _ = std::io::stdout().flush();
}
