use std::collections::HashSet;
use std::sync::{Arc, Weak};

use serde_json::{Map, Value};
use tatsu_state::StateEvent;
use tatsu_state::slices::scratchpad::{ScratchpadEvent, ScratchpadTextChange};
use tatsu_state::slices::worktrees::WorktreesEvent;

use super::upgrade;
use crate::lifecycle::Core;
use crate::router::Reply;

const NOTES_KEY: &str = "scratchpadNotes";

pub(super) fn register(core: &Arc<Core>) {
    let weak = Arc::downgrade(core);
    core.router()
        .request("scratchpad:setText", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let (Some(Value::String(worktree_path)), Some(Value::String(text))) =
                    (args.first(), args.get(1))
                else {
                    return Ok(Reply::Value(Value::Bool(false)));
                };
                if worktree_path.is_empty() {
                    return Ok(Reply::Value(Value::Bool(false)));
                }
                set_text(&core, worktree_path, text);
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("scratchpad:setText registers once");

    let weak = Arc::downgrade(core);
    core.store().subscribe(move |event, _seq| {
        if let StateEvent::Worktrees(WorktreesEvent::ListChanged(_)) = event {
            prune_removed_worktrees(&weak);
        }
    });
}

fn set_text(core: &Core, worktree_path: &str, text: &str) {
    let repo_root = core.store().read(|state| {
        state
            .worktrees
            .list
            .iter()
            .find(|wt| wt.path == worktree_path)
            .map(|wt| wt.repo_root.clone())
    });
    if let Some(repo_root) = repo_root.filter(|root| !root.is_empty()) {
        core.config().update(|doc| {
            let mut notes = object_or_empty(doc.get(NOTES_KEY));
            let mut repo_map = object_or_empty(notes.get(&repo_root));
            if text.is_empty() {
                repo_map.shift_remove(worktree_path);
            } else {
                repo_map.insert(worktree_path.to_owned(), Value::String(text.to_owned()));
            }
            if repo_map.is_empty() {
                notes.shift_remove(&repo_root);
            } else {
                notes.insert(repo_root, Value::Object(repo_map));
            }
            if notes.is_empty() {
                doc.remove(NOTES_KEY);
            } else {
                doc.set(NOTES_KEY, Value::Object(notes));
            }
        });
    }
    core.store()
        .dispatch(StateEvent::Scratchpad(ScratchpadEvent::TextChanged(
            ScratchpadTextChange {
                worktree_path: worktree_path.to_owned(),
                text: text.to_owned(),
            },
        )));
}

fn object_or_empty(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

// `worktrees/listChanged` replaces the whole list, so sweeping every note here is the intended scope.
fn prune_removed_worktrees(core: &Weak<Core>) {
    let Some(core) = core.upgrade() else {
        return;
    };
    let removed: Vec<String> = core.store().read(|state| {
        let live: HashSet<&str> = state
            .worktrees
            .list
            .iter()
            .map(|wt| wt.path.as_str())
            .collect();
        state
            .scratchpad
            .by_worktree_path
            .keys()
            .filter(|path| !live.contains(path.as_str()))
            .cloned()
            .collect()
    });
    if removed.is_empty() {
        return;
    }
    let mut notes = core.config().get_raw(NOTES_KEY);
    let mut pruned_disk = false;
    for path in removed {
        core.store()
            .dispatch(StateEvent::Scratchpad(ScratchpadEvent::WorktreeRemoved(
                path.clone(),
            )));
        if let Some(Value::Object(notes)) = notes.as_mut() {
            notes.retain(|_, repo_map| {
                let Value::Object(repo_map) = repo_map else {
                    return true;
                };
                if repo_map.shift_remove(&path).is_none() {
                    return true;
                }
                pruned_disk = true;
                !repo_map.is_empty()
            });
        }
    }
    if pruned_disk {
        core.config().update(|doc| match notes {
            Some(Value::Object(notes)) if notes.is_empty() => {
                doc.remove(NOTES_KEY);
            }
            Some(notes) => doc.set(NOTES_KEY, notes),
            None => {}
        });
    }
}
