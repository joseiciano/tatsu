use std::path::{Path, PathBuf};

use serde::Serialize;
use time::OffsetDateTime;

use super::format::{append, data_suffix, iso, line_now};

pub struct PerfLog {
    path: PathBuf,
    header_written: bool,
}

impl PerfLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            header_written: false,
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
        self.ensure_header();
        let _ = append(&self.path, &format!("{line}\n"));
    }

    fn ensure_header(&mut self) {
        if self.header_written {
            return;
        }
        self.header_written = true;
        let sep = if self.path.exists() { "\n" } else { "" };
        let _ = append(
            &self.path,
            &format!(
                "{sep}=== session started at {} ===\n",
                iso(OffsetDateTime::now_utc())
            ),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logs::format::tests::Unserializable;
    use serde_json::json;
    use tempfile::TempDir;

    fn read(log: &PerfLog) -> String {
        std::fs::read_to_string(log.path()).unwrap()
    }

    fn assert_separator(line: &str) {
        assert!(
            line.starts_with("=== session started at ") && line.ends_with("Z ==="),
            "{line}"
        );
        assert_eq!(
            line.len(),
            "=== session started at 2026-01-01T00:00:00.000Z ===".len()
        );
    }

    #[test]
    fn fresh_file_starts_with_the_separator_and_no_blank_line() {
        let dir = TempDir::new().unwrap();
        let mut log = PerfLog::new(dir.path().join("perf.log"));

        log.log_with("store-slow", "settings/themeChanged", &json!({"ms": 6.0}));
        log.log("snapshot", "ok");

        let text = read(&log);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_separator(lines[0]);
        assert_eq!(
            &lines[1][13..],
            r#"] [store-slow] settings/themeChanged {"ms":6}"#
        );
        assert_eq!(&lines[2][13..], "] [snapshot] ok");
    }

    #[test]
    fn existing_file_gets_a_blank_line_before_the_separator() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("perf.log");
        std::fs::write(&path, "earlier\n").unwrap();
        let mut log = PerfLog::new(&path);

        log.log_with("ipc-slow", "x", &Unserializable);

        let text = read(&log);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "earlier");
        assert_eq!(lines[1], "");
        assert_separator(lines[2]);
        assert_eq!(&lines[3][13..], "] [ipc-slow] x [unserializable]");
        assert_eq!(lines.len(), 4);
    }

    #[test]
    fn large_files_are_never_rotated() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("perf.log");
        std::fs::write(&path, vec![b'x'; crate::logs::MAX_BYTES as usize]).unwrap();
        let mut log = PerfLog::new(&path);

        log.log("snapshot", "ok");

        assert!(!dir.path().join("perf.log.1").exists());
        assert!(std::fs::metadata(&path).unwrap().len() > crate::logs::MAX_BYTES);
    }
}
