#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tatsu_state::slices::repo_configs::{RepoConfig, RightPanelKey};

use crate::logs;
use crate::themes::node_message;

pub const REPO_CONFIG_FILENAME: &str = ".harness.json";
const CATEGORY: &str = "repo-config";

pub fn config_path(repo_root: &str) -> PathBuf {
    Path::new(repo_root).join(REPO_CONFIG_FILENAME)
}

fn hidden_by_default(key: RightPanelKey) -> bool {
    key == RightPanelKey::Scratchpad
}

#[derive(Default)]
pub struct RepoConfigStore {
    cache: Mutex<HashMap<String, RepoConfig>>,
}

impl RepoConfigStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load(&self, repo_root: &str) -> RepoConfig {
        load_cached(&mut self.cache.lock(), repo_root)
    }

    pub fn save(&self, repo_root: &str, next: &RepoConfig) -> RepoConfig {
        save_cached(&mut self.cache.lock(), repo_root, next)
    }

    pub fn update(
        &self,
        repo_root: &str,
        change: impl FnOnce(RepoConfig) -> RepoConfig,
    ) -> RepoConfig {
        let mut cache = self.cache.lock();
        let next = change(load_cached(&mut cache, repo_root));
        save_cached(&mut cache, repo_root, &next)
    }

    pub fn invalidate(&self, repo_root: Option<&str>) {
        let mut cache = self.cache.lock();
        match repo_root {
            Some(root) => {
                cache.remove(root);
            }
            None => cache.clear(),
        }
    }
}

type Cache = HashMap<String, RepoConfig>;

fn load_cached(cache: &mut Cache, repo_root: &str) -> RepoConfig {
    if repo_root.is_empty() {
        return RepoConfig::default();
    }
    if let Some(cached) = cache.get(repo_root) {
        return cached.clone();
    }
    let config = read(&config_path(repo_root));
    cache.insert(repo_root.to_owned(), config.clone());
    config
}

fn save_cached(cache: &mut Cache, repo_root: &str, next: &RepoConfig) -> RepoConfig {
    if repo_root.is_empty() {
        return RepoConfig::default();
    }
    let cleaned = clean(next);
    let path = config_path(repo_root);
    match write(&path, cleaned) {
        Ok(saved) => {
            cache.insert(repo_root.to_owned(), saved.clone());
            saved
        }
        Err(message) => {
            logs::log(
                CATEGORY,
                &format!("failed to save {}: {message}", path.display()),
            );
            cache.get(repo_root).cloned().unwrap_or_default()
        }
    }
}

fn read(path: &Path) -> RepoConfig {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return RepoConfig::default(),
        Err(err) => {
            logs::log(
                CATEGORY,
                &format!(
                    "failed to load {}: {}",
                    path.display(),
                    node_message(&err, "open", path)
                ),
            );
            return RepoConfig::default();
        }
    };
    match tatsu_js::parse_lenient(&String::from_utf8_lossy(&bytes)) {
        Ok(value) => {
            let (config, dropped) = sanitize(&value);
            for field in dropped {
                logs::log(
                    CATEGORY,
                    &format!("ignored invalid {field} in {}", path.display()),
                );
            }
            config
        }
        Err(err) => {
            logs::log(
                CATEGORY,
                &format!("failed to load {}: {err}", path.display()),
            );
            RepoConfig::default()
        }
    }
}

/// Builds the strict `RepoConfig` from a hand-edited value, one field at a time.
/// Returns the fields (or `hiddenRightPanels.<key>` / `rightPanelOrder[<i>]`
/// entries) dropped because their value does not fit. Unknown top-level keys
/// are dropped without being reported. The legacy hide flags take the value's
/// JS truthiness, as the TS save does.
pub fn sanitize(value: &Value) -> (RepoConfig, Vec<String>) {
    let mut dropped = Vec::new();
    let Value::Object(map) = value else {
        return (RepoConfig::default(), dropped);
    };
    let mut config = RepoConfig {
        version: field(map, "version", &mut dropped, as_integer),
        setup_command: field(map, "setupCommand", &mut dropped, |v| {
            v.as_str().map(str::to_owned)
        }),
        teardown_command: field(map, "teardownCommand", &mut dropped, |v| {
            v.as_str().map(str::to_owned)
        }),
        merge_strategy: field(map, "mergeStrategy", &mut dropped, decode),
        hide_merge_panel: map.get("hideMergePanel").map(tatsu_js::truthy),
        hide_pr_panel: map.get("hidePrPanel").map(tatsu_js::truthy),
        hidden_right_panels: None,
        right_panel_order: panel_order(map, &mut dropped),
    };
    hidden_panels(map, &mut dropped, &mut config);
    (config, dropped)
}

fn field<'a, T>(
    map: &'a Map<String, Value>,
    key: &str,
    dropped: &mut Vec<String>,
    convert: impl FnOnce(&'a Value) -> Option<T>,
) -> Option<T> {
    let value = map.get(key)?;
    let converted = convert(value);
    if converted.is_none() {
        dropped.push(key.to_owned());
    }
    converted
}

fn as_integer(value: &Value) -> Option<i64> {
    let n = value.as_number()?;
    n.as_i64().or_else(|| {
        n.as_f64()
            .filter(|f| f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0)
            .map(|f| f as i64)
    })
}

fn decode<T: DeserializeOwned>(value: &Value) -> Option<T> {
    match value {
        Value::String(_) => serde_json::from_value(value.clone()).ok(),
        _ => None,
    }
}

fn hidden_panels(map: &Map<String, Value>, dropped: &mut Vec<String>, config: &mut RepoConfig) {
    let Some(entries) = field(map, "hiddenRightPanels", dropped, Value::as_object) else {
        return;
    };
    let hidden = config.hidden_right_panels.insert(Default::default());
    for (key, value) in tatsu_js::js_key_order(entries) {
        match (decode(&Value::String(key.clone())), value.as_bool()) {
            (Some(panel), Some(flag)) => {
                hidden.insert(panel, flag);
            }
            _ => dropped.push(format!("hiddenRightPanels.{key}")),
        }
    }
}

fn panel_order(map: &Map<String, Value>, dropped: &mut Vec<String>) -> Option<Vec<RightPanelKey>> {
    let entries = field(map, "rightPanelOrder", dropped, Value::as_array)?;
    let mut order = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        match decode(entry) {
            Some(panel) => order.push(panel),
            None => dropped.push(format!("rightPanelOrder[{index}]")),
        }
    }
    Some(order)
}

fn clean(next: &RepoConfig) -> RepoConfig {
    let trimmed = |command: &Option<String>| {
        command
            .as_deref()
            .map(tatsu_js::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let mut hidden = next.hidden_right_panels.clone().unwrap_or_default();
    if next.hide_merge_panel == Some(true) && !hidden.contains_key(&RightPanelKey::Merge) {
        hidden.insert(RightPanelKey::Merge, true);
    }
    if next.hide_pr_panel == Some(true) && !hidden.contains_key(&RightPanelKey::Pr) {
        hidden.insert(RightPanelKey::Pr, true);
    }
    hidden.retain(|key, flag| *flag || hidden_by_default(*key));
    RepoConfig {
        version: Some(1),
        setup_command: trimmed(&next.setup_command),
        teardown_command: trimmed(&next.teardown_command),
        merge_strategy: next.merge_strategy,
        hide_merge_panel: None,
        hide_pr_panel: None,
        hidden_right_panels: Some(hidden).filter(|h| !h.is_empty()),
        right_panel_order: next.right_panel_order.clone().filter(|o| !o.is_empty()),
    }
}

fn write(path: &Path, cleaned: RepoConfig) -> Result<RepoConfig, String> {
    let has_any = cleaned.setup_command.is_some()
        || cleaned.teardown_command.is_some()
        || cleaned.merge_strategy.is_some()
        || cleaned.hidden_right_panels.is_some()
        || cleaned.right_panel_order.is_some();
    if !has_any {
        return match std::fs::remove_file(path) {
            Err(err) if err.kind() != io::ErrorKind::NotFound => {
                Err(node_message(&err, "unlink", path))
            }
            _ => Ok(RepoConfig::default()),
        };
    }
    let value = serde_json::to_value(&cleaned).map_err(|err| err.to_string())?;
    let text = format!("{}\n", tatsu_js::stringify_pretty(&value));
    std::fs::write(path, text).map_err(|err| node_message(&err, "open", path))?;
    Ok(cleaned)
}
