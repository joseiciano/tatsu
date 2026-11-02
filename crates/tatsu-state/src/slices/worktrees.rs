use serde::{Deserialize, Serialize};
use specta::Type;

use crate::wire::Patch;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub head: String,
    pub is_bare: bool,
    pub is_main: bool,
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
    pub created_at: f64,
    pub repo_root: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PendingStatus {
    Creating,
    Setup,
    SetupFailed,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingWorktree {
    pub id: String,
    pub repo_root: String,
    pub branch_name: String,
    pub status: PendingStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_log: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teleport_session_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingWorktreePatch {
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub id: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub repo_root: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub branch_name: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub status: Patch<PendingStatus>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub error: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub setup_log: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub setup_exit_code: Patch<i64>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub created_path: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub initial_prompt: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub teleport_session_id: Patch<String>,
}

impl PendingWorktreePatch {
    pub fn apply(self, target: &mut PendingWorktree) {
        self.id.apply_to_required(&mut target.id);
        self.repo_root.apply_to_required(&mut target.repo_root);
        self.branch_name.apply_to_required(&mut target.branch_name);
        self.status.apply_to_required(&mut target.status);
        self.error.apply_to(&mut target.error);
        self.setup_log.apply_to(&mut target.setup_log);
        self.setup_exit_code.apply_to(&mut target.setup_exit_code);
        self.created_path.apply_to(&mut target.created_path);
        self.initial_prompt.apply_to(&mut target.initial_prompt);
        self.teleport_session_id
            .apply_to(&mut target.teleport_session_id);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum PendingDeletionPhase {
    RunningTeardown,
    RemovingWorktree,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeletion {
    pub path: String,
    pub repo_root: String,
    pub branch: String,
    pub phase: PendingDeletionPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teardown_log: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teardown_exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeletionPatch {
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub path: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub repo_root: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub branch: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub phase: Patch<PendingDeletionPhase>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub teardown_log: Patch<String>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub teardown_exit_code: Patch<i64>,
    #[serde(default, skip_serializing_if = "Patch::is_absent")]
    pub error: Patch<String>,
}

impl PendingDeletionPatch {
    pub fn apply(self, target: &mut PendingDeletion) {
        self.path.apply_to_required(&mut target.path);
        self.repo_root.apply_to_required(&mut target.repo_root);
        self.branch.apply_to_required(&mut target.branch);
        self.phase.apply_to_required(&mut target.phase);
        self.teardown_log.apply_to(&mut target.teardown_log);
        self.teardown_exit_code
            .apply_to(&mut target.teardown_exit_code);
        self.error.apply_to(&mut target.error);
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct WorktreesState {
    pub list: Vec<Worktree>,
    pub repo_roots: Vec<String>,
    pub pending: Vec<PendingWorktree>,
    pub pending_deletions: Vec<PendingDeletion>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingWorktreeUpdate {
    pub id: String,
    pub patch: PendingWorktreePatch,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PendingDeletionUpdate {
    pub path: String,
    pub patch: PendingDeletionPatch,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum WorktreesEvent {
    #[serde(rename = "worktrees/listChanged")]
    ListChanged(Vec<Worktree>),
    #[serde(rename = "worktrees/reposChanged")]
    ReposChanged(Vec<String>),
    #[serde(rename = "worktrees/pendingAdded")]
    PendingAdded(PendingWorktree),
    #[serde(rename = "worktrees/pendingUpdated")]
    PendingUpdated(PendingWorktreeUpdate),
    #[serde(rename = "worktrees/pendingRemoved")]
    PendingRemoved(String),
    #[serde(rename = "worktrees/pendingDeletionStarted")]
    PendingDeletionStarted(PendingDeletion),
    #[serde(rename = "worktrees/pendingDeletionUpdated")]
    PendingDeletionUpdated(PendingDeletionUpdate),
    #[serde(rename = "worktrees/pendingDeletionRemoved")]
    PendingDeletionRemoved(String),
}

pub fn reduce(state: &mut WorktreesState, event: WorktreesEvent) {
    match event {
        WorktreesEvent::ListChanged(list) => state.list = list,
        WorktreesEvent::ReposChanged(repo_roots) => state.repo_roots = repo_roots,
        WorktreesEvent::PendingAdded(pending) => state.pending.push(pending),
        WorktreesEvent::PendingUpdated(update) => {
            if let Some(pending) = state.pending.iter_mut().find(|p| p.id == update.id) {
                update.patch.apply(pending);
            }
        }
        WorktreesEvent::PendingRemoved(id) => state.pending.retain(|p| p.id != id),
        WorktreesEvent::PendingDeletionStarted(deletion) => {
            state.pending_deletions.retain(|d| d.path != deletion.path);
            state.pending_deletions.push(deletion);
        }
        WorktreesEvent::PendingDeletionUpdated(update) => {
            if let Some(deletion) = state
                .pending_deletions
                .iter_mut()
                .find(|d| d.path == update.path)
            {
                update.patch.apply(deletion);
            }
        }
        WorktreesEvent::PendingDeletionRemoved(path) => {
            state.pending_deletions.retain(|d| d.path != path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn failed_pending() -> PendingWorktree {
        PendingWorktree {
            id: "pending:1".to_string(),
            repo_root: "/repo".to_string(),
            branch_name: "feat".to_string(),
            status: PendingStatus::Error,
            error: Some("boom".to_string()),
            setup_log: Some("log".to_string()),
            setup_exit_code: Some(1),
            created_path: Some("/repo/feat".to_string()),
            initial_prompt: None,
            teleport_session_id: None,
        }
    }

    #[test]
    fn unchanged_and_cleared_fields_both_serialize_as_absent_keys() {
        let patch = PendingWorktreePatch {
            status: Patch::Set(PendingStatus::Creating),
            error: Patch::Cleared,
            setup_log: Patch::Cleared,
            ..Default::default()
        };

        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({ "status": "creating" })
        );
    }

    #[test]
    fn applying_a_cleared_field_removes_it_in_memory() {
        let mut pending = failed_pending();
        let patch = PendingWorktreePatch {
            status: Patch::Set(PendingStatus::Creating),
            error: Patch::Cleared,
            setup_log: Patch::Cleared,
            setup_exit_code: Patch::Cleared,
            created_path: Patch::Cleared,
            ..Default::default()
        };

        patch.apply(&mut pending);

        assert_eq!(
            serde_json::to_value(&pending).unwrap(),
            json!({ "id": "pending:1", "repoRoot": "/repo", "branchName": "feat", "status": "creating" })
        );
    }

    #[test]
    fn an_absent_key_from_json_leaves_the_field_unchanged() {
        let mut pending = failed_pending();
        let patch: PendingWorktreePatch =
            serde_json::from_value(json!({ "setupLog": "more" })).unwrap();

        patch.apply(&mut pending);

        assert_eq!(pending.error.as_deref(), Some("boom"));
        assert_eq!(pending.setup_log.as_deref(), Some("more"));
        assert_eq!(pending.status, PendingStatus::Error);
    }

    #[test]
    fn pending_updated_with_a_cleared_field_removes_it_from_the_entry_in_state() {
        let mut state = WorktreesState {
            pending: vec![failed_pending()],
            ..Default::default()
        };
        let patch = PendingWorktreePatch {
            status: Patch::Set(PendingStatus::Setup),
            error: Patch::Cleared,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({ "status": "setup" })
        );

        reduce(
            &mut state,
            WorktreesEvent::PendingUpdated(PendingWorktreeUpdate {
                id: "pending:1".to_string(),
                patch,
            }),
        );

        let entry = &state.pending[0];
        assert_eq!(entry.status, PendingStatus::Setup);
        assert_eq!(entry.error, None);
        assert_eq!(entry.setup_log.as_deref(), Some("log"));
        assert!(serde_json::to_value(entry).unwrap().get("error").is_none());
    }

    #[test]
    fn pending_updated_patches_only_the_first_matching_entry() {
        let mut state = WorktreesState {
            pending: vec![failed_pending(), failed_pending()],
            ..Default::default()
        };
        reduce(
            &mut state,
            serde_json::from_value(json!({
                "type": "worktrees/pendingUpdated",
                "payload": { "id": "pending:1", "patch": { "status": "setup" } }
            }))
            .unwrap(),
        );
        assert_eq!(state.pending[0].status, PendingStatus::Setup);
        assert_eq!(state.pending[1].status, PendingStatus::Error);
    }

    #[test]
    fn deletion_patch_clears_and_sets() {
        let mut deletion = PendingDeletion {
            path: "/repo/feat".to_string(),
            repo_root: "/repo".to_string(),
            branch: "feat".to_string(),
            phase: PendingDeletionPhase::Failed,
            teardown_log: Some("log".to_string()),
            teardown_exit_code: Some(2),
            error: Some("boom".to_string()),
        };
        let patch = PendingDeletionPatch {
            phase: Patch::Set(PendingDeletionPhase::RunningTeardown),
            error: Patch::Cleared,
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({ "phase": "running-teardown" })
        );

        patch.apply(&mut deletion);

        assert_eq!(deletion.error, None);
        assert_eq!(deletion.teardown_exit_code, Some(2));
    }
}
