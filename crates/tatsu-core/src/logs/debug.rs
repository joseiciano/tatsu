use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use time::OffsetDateTime;

use super::format::{append, data_suffix, iso, line_now};

pub const MAX_BYTES: u64 = 10 * 1024 * 1024;
pub const ROTATE_CHECK_EVERY: u32 = 1000;

pub struct DebugLog {
    path: PathBuf,
    opened: bool,
    writes_since_rotate_check: u32,
    echo: Box<dyn Write + Send>,
}

impl DebugLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self::with_echo(path, Box::new(std::io::stdout()))
    }

    pub fn with_echo(path: impl Into<PathBuf>, echo: Box<dyn Write + Send>) -> Self {
        Self {
            path: path.into(),
            opened: false,
            writes_since_rotate_check: 0,
            echo,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn log(&mut self, category: &str, message: &str) {
        self.write_line(line_now(category, message, ""));
    }

    pub fn log_with<T: Serialize + ?Sized>(&mut self, category: &str, message: &str, data: &T) {
        self.write_line(line_now(category, message, &data_suffix(data)));
    }

    fn write_line(&mut self, line: String) {
        let _ = writeln!(self.echo, "{line}");
        self.open();
        let _ = append(&self.path, &format!("{line}\n"));
        self.writes_since_rotate_check += 1;
        if self.writes_since_rotate_check >= ROTATE_CHECK_EVERY {
            self.writes_since_rotate_check = 0;
            rotate_if_needed(&self.path);
        }
    }

    fn open(&mut self) {
        if self.opened {
            return;
        }
        self.opened = true;
        rotate_if_needed(&self.path);
        let now = OffsetDateTime::now_utc();
        if append(&self.path, &session_header(now)).is_err() {
            let _ = std::fs::write(&self.path, fresh_header(now));
        }
    }
}

fn session_header(at: OffsetDateTime) -> String {
    format!(
        "=== Claude Tatsu debug log session started at {} ===\n",
        iso(at)
    )
}

fn fresh_header(at: OffsetDateTime) -> String {
    format!("=== Claude Tatsu debug log started at {} ===\n", iso(at))
}

fn rotate_if_needed(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() < MAX_BYTES {
        return;
    }
    let mut archive = path.as_os_str().to_owned();
    archive.push(".1");
    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::rename(path, &archive);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::format::tests::Unserializable;
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;
    use time::macros::datetime;

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl Write for Captured {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Captured {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn open(dir: &TempDir) -> (DebugLog, Captured) {
        let echo = Captured::default();
        let log = DebugLog::with_echo(dir.path().join("debug.log"), Box::new(echo.clone()));
        (log, echo)
    }

    fn lines(log: &DebugLog) -> Vec<String> {
        std::fs::read_to_string(log.path())
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn assert_stamped(line: &str, rest: &str) {
        let b = line.as_bytes();
        assert_eq!(line.len(), 15 + rest.len(), "{line}");
        assert!(
            b[0] == b'['
                && b[3] == b':'
                && b[6] == b':'
                && b[9] == b'.'
                && b[13] == b']'
                && b[14] == b' ',
            "{line}"
        );
        assert_eq!(&line[15..], rest);
    }

    fn assert_session_header(line: &str) {
        let prefix = "=== Claude Tatsu debug log session started at ";
        assert!(
            line.starts_with(prefix) && line.ends_with("Z ==="),
            "{line}"
        );
        assert_eq!(
            line.len(),
            prefix.len() + "2026-01-01T00:00:00.000Z ===".len()
        );
    }

    #[test]
    fn nothing_is_written_until_the_first_log_call() {
        let dir = TempDir::new().unwrap();
        let (log, _) = open(&dir);
        assert!(!log.path().exists());
    }

    #[test]
    fn fresh_file_gets_the_session_header_then_the_line() {
        let dir = TempDir::new().unwrap();
        let (mut log, _) = open(&dir);

        log.log("boot", "ready");

        let lines = lines(&log);
        assert_eq!(lines.len(), 2);
        assert_session_header(&lines[0]);
        assert_stamped(&lines[1], "[boot] ready");
    }

    #[test]
    fn existing_file_is_appended_with_a_session_header() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("debug.log"), "old line\n").unwrap();
        let (mut log, _) = open(&dir);

        log.log("boot", "again");
        log.log("boot", "twice");

        let lines = lines(&log);
        assert_eq!(lines[0], "old line");
        assert_session_header(&lines[1]);
        assert_stamped(&lines[2], "[boot] again");
        assert_stamped(&lines[3], "[boot] twice");
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn header_texts_match_both_ts_branches() {
        let at = datetime!(2026-07-08 09:10:11.012 UTC);
        assert_eq!(
            session_header(at),
            "=== Claude Tatsu debug log session started at 2026-07-08T09:10:11.012Z ===\n"
        );
        assert_eq!(
            fresh_header(at),
            "=== Claude Tatsu debug log started at 2026-07-08T09:10:11.012Z ===\n"
        );
    }

    #[test]
    fn lines_carry_data_or_unserializable_and_echo_to_stdout() {
        let dir = TempDir::new().unwrap();
        let (mut log, echo) = open(&dir);

        log.log_with("pty", "spawned", &json!({"id": "t1", "cols": 80.0}));
        log.log_with("pty", "bad", &Unserializable);

        let lines = lines(&log);
        assert_stamped(&lines[1], r#"[pty] spawned {"id":"t1","cols":80}"#);
        assert_stamped(&lines[2], "[pty] bad [unserializable]");
        assert_eq!(echo.text(), format!("{}\n{}\n", lines[1], lines[2]));
    }

    #[test]
    fn rotates_at_first_use_when_file_reached_the_limit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("debug.log");
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize]).unwrap();
        std::fs::write(dir.path().join("debug.log.1"), "older archive").unwrap();
        let (mut log, _) = open(&dir);

        log.log("boot", "after rotate");

        let archive = std::fs::metadata(dir.path().join("debug.log.1")).unwrap();
        assert_eq!(archive.len(), MAX_BYTES);
        let lines = lines(&log);
        assert_eq!(lines.len(), 2);
        assert_session_header(&lines[0]);
    }

    #[test]
    fn does_not_rotate_below_the_limit() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("debug.log");
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize - 1]).unwrap();
        let (mut log, _) = open(&dir);

        log.log("boot", "kept");

        assert!(!dir.path().join("debug.log.1").exists());
    }

    #[test]
    fn rechecks_size_every_thousand_writes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("debug.log");
        std::fs::write(&path, vec![b'x'; MAX_BYTES as usize - 1]).unwrap();
        let (mut log, _) = open(&dir);

        for _ in 0..ROTATE_CHECK_EVERY - 1 {
            log.log("tick", "t");
        }
        assert!(!dir.path().join("debug.log.1").exists());

        log.log("tick", "t");

        assert!(dir.path().join("debug.log.1").exists());
        assert!(!path.exists());
        log.log("tick", "after");
        let lines = lines(&log);
        assert_eq!(lines.len(), 1);
        assert_stamped(&lines[0], "[tick] after");
    }

    #[test]
    fn write_errors_are_dropped() {
        let dir = TempDir::new().unwrap();
        let echo = Captured::default();
        let mut log = DebugLog::with_echo(
            dir.path().join("missing").join("debug.log"),
            Box::new(echo.clone()),
        );

        log.log("boot", "still echoed");

        assert!(echo.text().ends_with("[boot] still echoed\n"));
    }
}
