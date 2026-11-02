use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CheckState {
    Success,
    Failure,
    Pending,
    Neutral,
    Skipped,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CheckStatus {
    pub name: String,
    pub state: CheckState,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PRReviewState {
    Approved,
    ChangesRequested,
    Commented,
    Dismissed,
    Pending,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PRReview {
    pub user: String,
    pub avatar_url: String,
    pub state: PRReviewState,
    pub body: String,
    pub submitted_at: String,
    pub html_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum PRState {
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ChecksOverall {
    Success,
    Failure,
    Pending,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    ReviewRequired,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum OpenClosed {
    Open,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    pub login: String,
    pub avatar_url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PRMilestone {
    pub title: String,
    pub url: String,
    pub state: OpenClosed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PRLinkedIssue {
    pub number: u64,
    pub title: String,
    pub state: OpenClosed,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PRLabel {
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PRStatus {
    pub number: u64,
    pub title: String,
    pub state: PRState,
    pub url: String,
    pub branch: String,
    pub author: Option<GithubUser>,
    pub checks: Vec<CheckStatus>,
    pub checks_overall: ChecksOverall,
    pub has_conflict: Option<bool>,
    pub reviews: Vec<PRReview>,
    pub review_decision: ReviewDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub additions: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletions: Option<u64>,
    pub base_branch: String,
    pub is_default_base: bool,
    #[serde(
        default,
        deserialize_with = "crate::wire::nullable::deserialize",
        skip_serializing_if = "Option::is_none"
    )]
    #[specta(type = Option<Option<PRMilestone>>)]
    pub milestone: Option<Option<PRMilestone>>,
    pub assignees: Vec<GithubUser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_position: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queue_estimated_seconds: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind_by: Option<u64>,
    pub linked_issues: Vec<PRLinkedIssue>,
    pub labels: Vec<PRLabel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_release_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_milestones: Option<bool>,
}

impl PRStatus {
    pub fn is_merged(&self) -> bool {
        matches!(self.state, PRState::Merged | PRState::Closed)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct PRsState {
    pub by_path: IndexMap<String, Option<PRStatus>>,
    pub merged_by_path: IndexMap<String, bool>,
    pub loading: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PRStatusChange {
    pub path: String,
    pub status: Option<Box<PRStatus>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum PRsEvent {
    #[serde(rename = "prs/statusChanged")]
    StatusChanged(PRStatusChange),
    #[serde(rename = "prs/bulkStatusChanged")]
    BulkStatusChanged(IndexMap<String, Option<PRStatus>>),
    #[serde(rename = "prs/mergedChanged")]
    MergedChanged(IndexMap<String, bool>),
    #[serde(rename = "prs/loadingChanged")]
    LoadingChanged(bool),
}

pub fn is_worktree_merged(prs: &PRsState, worktree_path: &str) -> bool {
    prs.merged_by_path
        .get(worktree_path)
        .copied()
        .unwrap_or(false)
        || prs
            .by_path
            .get(worktree_path)
            .and_then(Option::as_ref)
            .is_some_and(PRStatus::is_merged)
}

pub fn reduce(state: &mut PRsState, event: PRsEvent) {
    match event {
        PRsEvent::StatusChanged(change) => {
            state
                .by_path
                .insert(change.path, change.status.map(|status| *status));
        }
        PRsEvent::BulkStatusChanged(by_path) => state.by_path = by_path,
        PRsEvent::MergedChanged(merged_by_path) => state.merged_by_path = merged_by_path,
        PRsEvent::LoadingChanged(loading) => state.loading = loading,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pr(state: &str) -> Option<PRStatus> {
        Some(
            serde_json::from_value(json!({
                "number": 1, "title": "t", "state": state, "url": "u", "branch": "b",
                "author": null, "checks": [], "checksOverall": "none", "hasConflict": null,
                "reviews": [], "reviewDecision": "none", "baseBranch": "main",
                "isDefaultBase": true, "assignees": [], "linkedIssues": [], "labels": []
            }))
            .unwrap(),
        )
    }

    fn prs(by_path: &[(&str, Option<PRStatus>)], merged: &[(&str, bool)]) -> PRsState {
        PRsState {
            by_path: by_path
                .iter()
                .map(|(path, status)| (path.to_string(), status.clone()))
                .collect(),
            merged_by_path: merged
                .iter()
                .map(|(path, merged)| (path.to_string(), *merged))
                .collect(),
            loading: false,
        }
    }

    #[test]
    fn worktree_is_merged_when_the_local_flag_is_set_even_with_an_open_pr() {
        let state = prs(&[("/a", pr("open"))], &[("/a", true)]);
        assert!(is_worktree_merged(&state, "/a"));
    }

    #[test]
    fn worktree_is_merged_when_its_pr_is_merged_or_closed() {
        let state = prs(
            &[("/m", pr("merged")), ("/c", pr("closed"))],
            &[("/m", false)],
        );
        assert!(is_worktree_merged(&state, "/m"));
        assert!(is_worktree_merged(&state, "/c"));
    }

    #[test]
    fn worktree_is_not_merged_with_an_open_or_draft_pr_or_no_pr() {
        let state = prs(
            &[("/o", pr("open")), ("/d", pr("draft")), ("/n", None)],
            &[("/f", false)],
        );
        for path in ["/o", "/d", "/n", "/f"] {
            assert!(!is_worktree_merged(&state, path), "{path}");
        }
    }

    #[test]
    fn unknown_path_is_not_merged() {
        let state = prs(&[("/a", pr("merged"))], &[("/a", true)]);
        assert!(!is_worktree_merged(&state, "/other"));
    }

    #[test]
    fn milestone_keeps_absent_null_and_object_apart() {
        let base = serde_json::to_value(pr("open")).unwrap();
        for milestone in [
            None,
            Some(json!(null)),
            Some(json!({ "title": "v1", "url": "m", "state": "closed" })),
        ] {
            let mut input = base.clone();
            if let Some(milestone) = &milestone {
                input["milestone"] = milestone.clone();
            }
            let status: PRStatus = serde_json::from_value(input.clone()).unwrap();
            assert_eq!(serde_json::to_value(&status).unwrap(), input);
        }
    }

    #[test]
    fn status_changed_on_an_existing_path_keeps_its_position() {
        let mut state = prs(&[("/a", None), ("/b", None)], &[]);
        reduce(
            &mut state,
            PRsEvent::StatusChanged(PRStatusChange {
                path: "/a".to_string(),
                status: pr("open").map(Box::new),
            }),
        );
        assert_eq!(state.by_path.keys().collect::<Vec<_>>(), ["/a", "/b"]);
        assert!(state.by_path["/a"].is_some());
    }
}
