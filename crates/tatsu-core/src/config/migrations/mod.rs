mod js;
mod path;

use serde_json::Number;

pub(crate) use js::JsObject;
use js::{Js, truthy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationError(pub &'static str);

pub struct MigrationCtx<'a> {
    pub now_ms: i64,
    random_suffix: Box<dyn FnMut() -> String + 'a>,
}

impl<'a> MigrationCtx<'a> {
    pub fn new(now_ms: i64) -> Self {
        Self::with_random_suffix(now_ms, random_base36_suffix)
    }

    pub fn with_random_suffix(now_ms: i64, random_suffix: impl FnMut() -> String + 'a) -> Self {
        Self {
            now_ms,
            random_suffix: Box::new(random_suffix),
        }
    }
}

fn random_base36_suffix() -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    uuid::Uuid::new_v4().as_bytes()[..6]
        .iter()
        .map(|b| DIGITS[*b as usize % 36] as char)
        .collect()
}

type Step = Result<(), MigrationError>;

pub(crate) fn repo_root_to_repo_roots(c: &mut JsObject, _: &mut MigrationCtx) -> Step {
    if let Some(Js::String(root)) = c.get("repoRoot")
        && !matches!(c.get("repoRoots"), Some(Js::Array(_)))
    {
        let roots = Js::array(vec![Js::str(root.clone())]);
        c.insert("repoRoots", roots);
    }
    c.shift_remove("repoRoot");
    Ok(())
}

pub(crate) fn terminal_tabs_to_flat_panes(c: &mut JsObject, ctx: &mut MigrationCtx) -> Step {
    let Some(terminal_tabs) = c.get("terminalTabs").filter(|v| v.truthy()).cloned() else {
        return Ok(());
    };
    if truthy(c.get("panes")) {
        return Ok(());
    }
    let active_tab_id = c.get("activeTabId").cloned();
    let mut migrated = JsObject::default();
    for (wt_path, tabs) in terminal_tabs.entries()? {
        let empty = tabs
            .prop("length")
            .is_some_and(|len| matches!(len, Js::Number(n) if n.as_f64() == Some(0.0)));
        if !tabs.truthy() || empty {
            continue;
        }
        let active = active_tab_id
            .as_ref()
            .and_then(|ids| ids.prop(&wt_path))
            .filter(Js::truthy);
        let active = match active {
            Some(id) => Some(id),
            None => match tabs.prop("0") {
                None | Some(Js::Null) => return Err(MigrationError("tabs[0] is not an object")),
                Some(first) => first.prop("id"),
            },
        };
        let mut pane = JsObject::default();
        let suffix = (ctx.random_suffix)();
        pane.insert("id", Js::str(format!("pane-{}-{suffix}", ctx.now_ms)));
        pane.insert("tabs", tabs);
        if let Some(active) = active {
            pane.insert("activeTabId", active);
        }
        migrated.insert(wt_path, Js::array(vec![Js::object(pane)]));
    }
    c.insert("panes", Js::object(migrated));
    Ok(())
}

fn looks_flat(panes: Option<&Js>) -> bool {
    let Some(panes) = panes.filter(|p| p.truthy() && p.is_object()) else {
        return false;
    };
    panes
        .values()
        .first()
        .is_some_and(|first| matches!(first, Js::Array(_)))
}

fn owns(prefix: &str, wt_path: &str) -> bool {
    wt_path == prefix
        || if prefix.ends_with('/') {
            wt_path.starts_with(prefix)
        } else {
            wt_path.starts_with(&format!("{prefix}/"))
        }
}

pub(crate) fn flat_panes_to_nested_panes(c: &mut JsObject, _: &mut MigrationCtx) -> Step {
    if !looks_flat(c.get("panes")) {
        return Ok(());
    }
    let flat = c.get("panes").cloned().unwrap_or(Js::Null);
    let repo_roots = match c.get("repoRoots") {
        Some(roots @ Js::Array(_)) => roots.values(),
        _ => Vec::new(),
    };
    let mut owners = Vec::with_capacity(repo_roots.len());
    for root in &repo_roots {
        let Js::String(root) = root else {
            return Err(MigrationError("repo root is not a string"));
        };
        let worktrees = format!("{}-worktrees", path::basename(root));
        let sibling = path::join(&[&path::dirname(root), &worktrees]) + "/";
        owners.push((root.clone(), [root.clone(), sibling]));
    }
    let mut nested = JsObject::default();
    let mut orphan = JsObject::default();
    for (wt_path, pane_list) in flat.entries()? {
        let owner = owners
            .iter()
            .find(|(_, prefixes)| prefixes.iter().any(|p| owns(p, &wt_path)));
        match owner {
            Some((repo_root, _)) => {
                if !nested.contains_key(repo_root) {
                    nested.insert(repo_root.clone(), Js::object(JsObject::default()));
                }
                if let Some(Js::Object(by_wt)) = nested.get(repo_root) {
                    by_wt.borrow_mut().insert(wt_path, pane_list);
                }
            }
            None => orphan.insert(wt_path, pane_list),
        }
    }
    if !orphan.is_empty() {
        nested.insert("__orphan__", Js::object(orphan));
    }
    c.insert("legacyPanes", flat);
    c.insert("panes", Js::object(nested));
    Ok(())
}

fn pane_maps(c: &JsObject) -> Vec<Js> {
    match c.get("panes") {
        Some(panes) if panes.truthy() && panes.is_object() => panes
            .values()
            .into_iter()
            .filter(|by_wt| by_wt.truthy() && by_wt.is_object())
            .collect(),
        _ => Vec::new(),
    }
}

fn tabs_of(node: &Js) -> Vec<Js> {
    match node.prop("tabs") {
        Some(tabs @ Js::Array(_)) => tabs.values(),
        _ => Vec::new(),
    }
}

pub(crate) fn claude_tab_type_to_agent(c: &mut JsObject, _: &mut MigrationCtx) -> Step {
    for by_wt in pane_maps(c) {
        for pane_list in by_wt.values() {
            if !matches!(pane_list, Js::Array(_)) {
                continue;
            }
            for pane in pane_list.values() {
                for tab in tabs_of(&pane) {
                    match tab {
                        Js::Null => return Err(MigrationError("tab is null")),
                        Js::Object(tab) => {
                            let mut tab = tab.borrow_mut();
                            if tab.get("type").is_some_and(|t| t.is_str("claude")) {
                                tab.insert("type", Js::str("agent"));
                                tab.insert("agentKind", Js::str("claude"));
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn pane_lists_to_trees(c: &mut JsObject, _: &mut MigrationCtx) -> Step {
    let Some(panes) = c
        .get("panes")
        .filter(|p| p.truthy() && p.is_object())
        .cloned()
    else {
        return Ok(());
    };
    let repos = panes.entries()?;
    for (_, by_wt) in &repos {
        let already_tree = by_wt
            .entries()?
            .iter()
            .any(|(_, v)| matches!(v, Js::Object(_)) && v.has_own("type"));
        if already_tree {
            return Ok(());
        }
    }
    let mut migrated = JsObject::default();
    for (repo, by_wt) in repos {
        let mut trees = JsObject::default();
        for (wt_path, pane_list) in by_wt.entries()? {
            let Js::Array(_) = pane_list else {
                continue;
            };
            let pane_list = pane_list.values();
            if pane_list.is_empty() {
                continue;
            }
            trees.insert(wt_path, flat_panes_to_tree(&pane_list)?);
        }
        migrated.insert(repo, Js::object(trees));
    }
    c.insert("panes", Js::object(migrated));
    c.shift_remove("paneSplitDirections");
    Ok(())
}

fn leaf(pane: &Js) -> Result<Js, MigrationError> {
    if matches!(pane, Js::Null) {
        return Err(MigrationError("pane is null"));
    }
    let mut node = JsObject::default();
    node.insert("type", Js::str("leaf"));
    for key in ["id", "tabs", "activeTabId"] {
        if let Some(value) = pane.prop(key) {
            node.insert(key, value);
        }
    }
    Ok(Js::object(node))
}

fn flat_panes_to_tree(panes: &[Js]) -> Result<Js, MigrationError> {
    let leaves = panes.iter().map(leaf).collect::<Result<Vec<_>, _>>()?;
    let count = leaves.len();
    let mut leaves = leaves.into_iter().rev();
    let mut result = leaves.next().unwrap_or(Js::Null);
    for (i, node) in (0..count.saturating_sub(1)).rev().zip(leaves) {
        let ratio = Number::from_f64(1.0 / (count - i) as f64)
            .ok_or(MigrationError("ratio is not finite"))?;
        let mut split = JsObject::default();
        split.insert("type", Js::str("split"));
        split.insert("id", Js::str(format!("split-migrated-{i}")));
        split.insert("direction", Js::str("horizontal"));
        split.insert("children", Js::array(vec![node, result]));
        split.insert("ratio", Js::Number(ratio));
        result = Js::object(split);
    }
    Ok(result)
}

pub(crate) fn snooze_fields(_: &mut JsObject, _: &mut MigrationCtx) -> Step {
    Ok(())
}

pub(crate) fn legacy_theme_to_theme_mode(c: &mut JsObject, _: &mut MigrationCtx) -> Step {
    let Some(Js::String(legacy)) = c.get("theme").cloned() else {
        return Ok(());
    };
    if legacy == "solarized-light" {
        c.insert("themeMode", Js::str("light"));
        c.insert("themeLight", Js::str(legacy));
    } else {
        c.insert("themeMode", Js::str("dark"));
        c.insert("themeDark", Js::str(legacy));
    }
    c.shift_remove("theme");
    Ok(())
}

pub(crate) fn seed_harness_config(c: &mut JsObject, _: &mut MigrationCtx) -> Step {
    if !c.contains_key("harnessConfig") {
        let mut seed = JsObject::default();
        seed.insert("version", Js::Number(1.into()));
        seed.insert("resources", Js::array(Vec::new()));
        c.insert("harnessConfig", Js::object(seed));
    }
    Ok(())
}

pub(crate) fn backfill_json_claude_agent_kind(c: &mut JsObject, _: &mut MigrationCtx) -> Step {
    for by_wt in pane_maps(c) {
        for tree in by_wt.values() {
            if tree.has_own("type") {
                walk(&tree)?;
            }
        }
    }
    Ok(())
}

fn walk(node: &Js) -> Step {
    match node {
        Js::Null => return Err(MigrationError("pane node is null")),
        Js::Object(_) => {}
        _ => return Ok(()),
    }
    if node.prop("type").is_some_and(|t| t.is_str("split")) {
        let Some(children @ Js::Array(_)) = node.prop("children") else {
            return Err(MigrationError("split children is not an array"));
        };
        return children.values().iter().try_for_each(walk);
    }
    for tab in tabs_of(node) {
        match tab {
            Js::Null => return Err(MigrationError("tab is null")),
            Js::Object(tab) => {
                let mut tab = tab.borrow_mut();
                if tab.get("type").is_some_and(|t| t.is_str("json-claude"))
                    && !truthy(tab.get("agentKind"))
                {
                    tab.insert("agentKind", Js::str("claude"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}
