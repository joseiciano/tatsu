use std::io::{self, Read};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const CATEGORY: &str = "path-fix";
pub const BEGIN: &str = "__HARNESS_PATH_BEGIN__";
pub const END: &str = "__HARNESS_PATH_END__";
pub const DEFAULT_TIMEOUT: Duration = Duration::from_millis(3000);
const EXIT_POLL: Duration = Duration::from_millis(5);

pub fn probe_command() -> String {
    format!("printf '{BEGIN}\\n%s\\n{END}\\n' \"$PATH\"")
}

pub fn parse_probe_output(stdout: &str) -> Option<&str> {
    let begin = stdout.find(BEGIN)?;
    let line_start = begin + BEGIN.len() + stdout[begin + BEGIN.len()..].find('\n')?;
    let end = line_start + 1 + stdout[line_start + 1..].find(END)?;
    let inner_end = stdout[..end].rfind('\n')?;
    if inner_end <= line_start {
        return None;
    }
    Some(&stdout[line_start + 1..inner_end])
}

pub fn merge_paths(existing: Option<&str>, captured: &str) -> String {
    let captured: Vec<&str> = captured.split(':').filter(|e| !e.is_empty()).collect();
    let existing_only =
        existing
            .unwrap_or("")
            .split(':')
            .fold(Vec::<&str>::new(), |mut kept, entry| {
                if !entry.is_empty() && !captured.contains(&entry) && !kept.contains(&entry) {
                    kept.push(entry);
                }
                kept
            });
    [existing_only, captured].concat().join(":")
}

pub fn capture_path(shell: &Path, timeout: Duration, log: &mut dyn FnMut(&str)) -> Option<String> {
    let shell_text = shell.display();
    let spawned = Command::new(shell)
        .args(["-ilc", &probe_command()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        // Node throws synchronously on an invalid argument (a NUL byte in the
        // path); the message text is Rust's, as Node's quotes its own
        // argument validator.
        Err(err) if err.kind() == io::ErrorKind::InvalidInput => {
            log(&format!("spawn failed (shell={shell_text}): {err}"));
            return None;
        }
        Err(err) => {
            // Node reports a failed exec as `error` and then `close`, so TS
            // logs the spawn error followed by the missing-sentinels line.
            log(&format!(
                "spawn error (shell={shell_text}): {}",
                node_spawn_message(&err, shell)
            ));
            log(&format!(
                "probe output missing sentinels (shell={shell_text})"
            ));
            return None;
        }
    };
    let deadline = Instant::now() + timeout;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        let _ = tx.send(bytes);
    });
    let bytes = rx
        .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
        .filter(|_| exited_by(&mut child, deadline));
    let Some(bytes) = bytes else {
        log(&format!(
            "probe timed out after {}ms (shell={shell_text})",
            timeout.as_millis()
        ));
        let _ = child.kill();
        let _ = child.wait();
        // A grandchild of the shell can hold the pipe open past the kill, so
        // the reader is left detached instead of joined.
        drop(reader);
        return None;
    };
    let _ = reader.join();
    let stdout = String::from_utf8_lossy(&bytes);
    let captured = parse_probe_output(&stdout).map(str::to_owned);
    if captured.is_none() {
        log(&format!(
            "probe output missing sentinels (shell={shell_text})"
        ));
    }
    captured
}

fn exited_by(child: &mut Child, deadline: Instant) -> bool {
    loop {
        if matches!(child.try_wait(), Ok(Some(_)) | Err(_)) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(EXIT_POLL);
    }
}

fn node_spawn_message(err: &io::Error, shell: &Path) -> String {
    let code = match err.raw_os_error() {
        Some(2) => "ENOENT",
        Some(13) => "EACCES",
        Some(20) => "ENOTDIR",
        _ => return err.to_string(),
    };
    format!("spawn {} {code}", shell.display())
}

pub fn fix_with(
    resolve_shell: impl FnOnce() -> std::path::PathBuf,
    existing: &str,
    capture: impl FnOnce(&Path, &mut dyn FnMut(&str)) -> Option<String>,
    log: &mut dyn FnMut(&str),
) -> Option<String> {
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        let shell = resolve_shell();
        let captured = capture(&shell, &mut *log)?;
        let merged = merge_paths(Some(existing), &captured);
        if merged == existing {
            return None;
        }
        log(&format!(
            "PATH merged from {} ({} → {} chars)",
            shell.display(),
            js_length(existing),
            js_length(&merged)
        ));
        Some(merged)
    }));
    outcome.unwrap_or_else(|panic| {
        log(&format!(
            "unexpected error, skipping fix: {}",
            panic_text(panic.as_ref())
        ));
        None
    })
}

fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_owned()))
        .unwrap_or_else(|| "panic".to_owned())
}

#[cfg(target_os = "macos")]
pub(crate) fn thread_count() -> Option<i32> {
    #[repr(C)]
    struct ProcTaskInfo {
        sizes_and_times: [u64; 6],
        counters: [i32; 9],
        threadnum: i32,
        numrunning: i32,
        priority: i32,
    }
    const PROC_PIDTASKINFO: i32 = 4;
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            buffersize: i32,
        ) -> i32;
    }
    let mut info = std::mem::MaybeUninit::<ProcTaskInfo>::zeroed();
    let size = std::mem::size_of::<ProcTaskInfo>() as i32;
    // SAFETY: the buffer is a zeroed `proc_taskinfo` of the size passed in,
    // and the kernel writes at most that many bytes.
    let written = unsafe {
        proc_pidinfo(
            std::process::id() as i32,
            PROC_PIDTASKINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    // SAFETY: the struct was zero-initialised and every field is plain data.
    (written == size).then(|| unsafe { info.assume_init() }.threadnum)
}

#[cfg(test)]
mod tests;
