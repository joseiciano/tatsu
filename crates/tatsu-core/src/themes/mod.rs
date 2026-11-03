pub mod builtin;

#[cfg(test)]
mod tests;

use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tatsu_state::slices::settings::{CustomTheme, CustomThemeMode};

use crate::data_dir::DataDir;
use crate::logs;

pub fn dir(data_dir: &DataDir) -> io::Result<PathBuf> {
    let dir = data_dir.path().join("themes");
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir)
}

pub fn load(data_dir: &DataDir) -> io::Result<Vec<CustomTheme>> {
    let dir = dir(data_dir)?;
    Ok(load_from(&dir, &mut |message| {
        logs::log("themes", &message)
    }))
}

pub(crate) fn load_from(dir: &Path, log: &mut impl FnMut(String)) -> Vec<CustomTheme> {
    let entries = match sorted_entries(dir) {
        Ok(entries) => entries,
        Err(err) => {
            log(format!(
                "failed to read {}: {}",
                dir.display(),
                scandir_message(&err, dir)
            ));
            return Vec::new();
        }
    };
    let mut out: Vec<CustomTheme> = Vec::new();
    for (filename, path) in entries {
        if !has_json_suffix(&filename) {
            continue;
        }
        let id = derive_id(&filename);
        if id.is_empty() {
            log(format!("skipping {filename}: filename produces empty id"));
            continue;
        }
        if builtin::is_builtin(&id) {
            log(format!(
                "skipping {filename}: id \"{id}\" collides with built-in theme"
            ));
            continue;
        }
        if out.iter().any(|theme| theme.id == id) {
            log(format!(
                "skipping {filename}: duplicate id \"{id}\" (first one wins)"
            ));
            continue;
        }
        let parsed = match read_json(&path) {
            Ok(value) => value,
            Err(message) => {
                log(format!("skipping {filename}: parse error — {message}"));
                continue;
            }
        };
        match parse_theme(id, &parsed) {
            Some(theme) => out.push(theme),
            None => log(format!(
                "skipping {filename}: missing required name/mode or invalid shape"
            )),
        }
    }
    out
}

fn sorted_entries(dir: &Path) -> io::Result<Vec<(String, PathBuf)>> {
    let mut entries = std::fs::read_dir(dir)?
        .map(|entry| {
            let name = entry?.file_name().to_string_lossy().into_owned();
            let path = dir.join(&name);
            Ok((name, path))
        })
        .collect::<io::Result<Vec<_>>>()?;
    entries.sort();
    Ok(entries)
}

fn scandir_message(err: &io::Error, dir: &Path) -> String {
    let node = match err.raw_os_error() {
        Some(2) => Some(("ENOENT", "no such file or directory")),
        Some(13) => Some(("EACCES", "permission denied")),
        Some(20) => Some(("ENOTDIR", "not a directory")),
        _ => None,
    };
    match node {
        Some((code, text)) => format!("{code}: {text}, scandir '{}'", dir.display()),
        None => err.to_string(),
    }
}

fn has_json_suffix(filename: &str) -> bool {
    filename
        .len()
        .checked_sub(5)
        .and_then(|start| filename.get(start..))
        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(".json"))
}

pub(crate) fn derive_id(filename: &str) -> String {
    let stem = if has_json_suffix(filename) {
        &filename[..filename.len() - 5]
    } else {
        filename
    };
    let mut id = String::with_capacity(stem.len());
    for c in stem.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            id.push(c);
        } else if !id.ends_with('-') {
            id.push('-');
        }
    }
    id.trim_matches('-').to_owned()
}

fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|err| err.to_string())?;
    tatsu_js::parse_lenient(&String::from_utf8_lossy(&bytes)).map_err(|err| err.to_string())
}

fn parse_theme(id: String, raw: &Value) -> Option<CustomTheme> {
    let Value::Object(obj) = raw else {
        return None;
    };
    let name = match obj.get("name") {
        Some(Value::String(name)) => tatsu_js::trim(name),
        _ => "",
    };
    if name.is_empty() {
        return None;
    }
    let mode = match obj.get("mode").and_then(Value::as_str) {
        Some("light") => CustomThemeMode::Light,
        Some("dark") => CustomThemeMode::Dark,
        _ => return None,
    };
    let entries: Vec<(String, &Value)> = match obj.get("colors") {
        Some(Value::Object(map)) => tatsu_js::js_key_order(map)
            .into_iter()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        _ => Vec::new(),
    };
    let colors = entries
        .into_iter()
        .filter(|(key, _)| key != "__proto__")
        .filter_map(|(key, value)| match value {
            Value::String(color) if !color.is_empty() => Some((key, color.clone())),
            _ => None,
        })
        .collect();
    Some(CustomTheme {
        id,
        name: name.to_owned(),
        mode,
        colors,
    })
}
