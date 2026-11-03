use std::collections::HashSet;
use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

use crate::DataDir;

const DIR: &str = "terminal-history";

pub fn sanitize_id(id: &str) -> String {
    id.encode_utf16()
        .map(|unit| match char::from_u32(u32::from(unit)) {
            Some(c) if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') => c,
            _ => '_',
        })
        .collect()
}

fn file_name(id: &str) -> String {
    format!("{}.txt", sanitize_id(id))
}

fn history_path(data_dir: &DataDir, id: &str) -> io::Result<PathBuf> {
    Ok(data_dir.module_dir(DIR)?.join(file_name(id)))
}

pub fn save(data_dir: &DataDir, id: &str, content: &str) {
    if let Err(e) = history_path(data_dir, id).and_then(|path| std::fs::write(path, content)) {
        eprintln!("Failed to save terminal history: {e}");
    }
}

pub fn load(data_dir: &DataDir, id: &str) -> Option<String> {
    let bytes = std::fs::read(history_path(data_dir, id).ok()?).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn clear(data_dir: &DataDir, id: &str) {
    if let Ok(path) = history_path(data_dir, id) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn prune<'a>(data_dir: &DataDir, keep_ids: impl IntoIterator<Item = &'a str>) {
    let Ok(dir) = data_dir.module_dir(DIR) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let keep: HashSet<OsString> = keep_ids
        .into_iter()
        .map(|id| file_name(id).into())
        .collect();
    for entry in entries.flatten() {
        if !keep.contains(&entry.file_name()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests;
