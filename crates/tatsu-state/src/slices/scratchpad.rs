use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct ScratchpadState {
    pub by_worktree_path: IndexMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScratchpadTextChange {
    pub worktree_path: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum ScratchpadEvent {
    #[serde(rename = "scratchpad/loaded")]
    Loaded(IndexMap<String, String>),
    #[serde(rename = "scratchpad/textChanged")]
    TextChanged(ScratchpadTextChange),
    #[serde(rename = "scratchpad/worktreeRemoved")]
    WorktreeRemoved(String),
}

pub fn reduce(state: &mut ScratchpadState, event: ScratchpadEvent) {
    match event {
        ScratchpadEvent::Loaded(by_worktree_path) => state.by_worktree_path = by_worktree_path,
        ScratchpadEvent::TextChanged(change) if change.text.is_empty() => {
            state.by_worktree_path.shift_remove(&change.worktree_path);
        }
        ScratchpadEvent::TextChanged(change) => {
            state
                .by_worktree_path
                .insert(change.worktree_path, change.text);
        }
        ScratchpadEvent::WorktreeRemoved(worktree_path) => {
            state.by_worktree_path.shift_remove(&worktree_path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state_with(entries: &[(&str, &str)]) -> ScratchpadState {
        ScratchpadState {
            by_worktree_path: entries
                .iter()
                .map(|(path, text)| (path.to_string(), text.to_string()))
                .collect(),
        }
    }

    fn keys(state: &ScratchpadState) -> Vec<&str> {
        state.by_worktree_path.keys().map(String::as_str).collect()
    }

    fn text_changed(path: &str, text: &str) -> ScratchpadEvent {
        ScratchpadEvent::TextChanged(ScratchpadTextChange {
            worktree_path: path.to_string(),
            text: text.to_string(),
        })
    }

    #[test]
    fn initial_state_serializes_to_an_empty_map() {
        assert_eq!(
            serde_json::to_value(ScratchpadState::default()).unwrap(),
            json!({ "byWorktreePath": {} })
        );
    }

    #[test]
    fn text_changed_on_an_existing_path_keeps_its_position() {
        let mut state = state_with(&[("/a", "1"), ("/b", "2"), ("/c", "3")]);
        reduce(&mut state, text_changed("/a", "new"));
        assert_eq!(keys(&state), ["/a", "/b", "/c"]);
        assert_eq!(state.by_worktree_path["/a"], "new");
    }

    #[test]
    fn empty_text_removes_the_path_and_keeps_the_order_of_the_rest() {
        let mut state = state_with(&[("/a", "1"), ("/b", "2"), ("/c", "3")]);
        reduce(&mut state, text_changed("/a", ""));
        assert_eq!(keys(&state), ["/b", "/c"]);
    }

    #[test]
    fn worktree_removed_keeps_the_order_of_the_rest() {
        let mut state = state_with(&[("/a", "1"), ("/b", "2"), ("/c", "3")]);
        reduce(
            &mut state,
            ScratchpadEvent::WorktreeRemoved("/b".to_string()),
        );
        assert_eq!(keys(&state), ["/a", "/c"]);
    }
}
