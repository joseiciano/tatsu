use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RightPanelKey {
    Merge,
    Pr,
    Todos,
    Commits,
    ChangedFiles,
    AllFiles,
    Cost,
    Scratchpad,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum MergeStrategy {
    Squash,
    MergeCommit,
    FastForward,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teardown_command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_strategy: Option<MergeStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_merge_panel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_pr_panel: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_right_panels: Option<IndexMap<RightPanelKey, bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_panel_order: Option<Vec<RightPanelKey>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoConfigsState {
    pub by_repo: IndexMap<String, RepoConfig>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfigChange {
    pub repo_root: String,
    pub config: RepoConfig,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum RepoConfigsEvent {
    #[serde(rename = "repoConfigs/loaded")]
    Loaded(IndexMap<String, RepoConfig>),
    #[serde(rename = "repoConfigs/changed")]
    Changed(RepoConfigChange),
    #[serde(rename = "repoConfigs/removed")]
    Removed(String),
}

pub fn reduce(state: &mut RepoConfigsState, event: RepoConfigsEvent) {
    match event {
        RepoConfigsEvent::Loaded(by_repo) => state.by_repo = by_repo,
        RepoConfigsEvent::Changed(change) => {
            state.by_repo.insert(change.repo_root, change.config);
        }
        RepoConfigsEvent::Removed(repo_root) => {
            state.by_repo.shift_remove(&repo_root);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with(repos: &[&str]) -> RepoConfigsState {
        RepoConfigsState {
            by_repo: repos
                .iter()
                .map(|repo| (repo.to_string(), RepoConfig::default()))
                .collect(),
        }
    }

    fn keys(state: &RepoConfigsState) -> Vec<&str> {
        state.by_repo.keys().map(String::as_str).collect()
    }

    #[test]
    fn changed_on_an_existing_repo_keeps_its_position() {
        let mut state = state_with(&["/a", "/b", "/c"]);
        reduce(
            &mut state,
            RepoConfigsEvent::Changed(RepoConfigChange {
                repo_root: "/a".to_string(),
                config: RepoConfig {
                    setup_command: Some("make".to_string()),
                    ..Default::default()
                },
            }),
        );
        assert_eq!(keys(&state), ["/a", "/b", "/c"]);
        assert_eq!(state.by_repo["/a"].setup_command.as_deref(), Some("make"));
    }

    #[test]
    fn removed_keeps_the_order_of_the_rest() {
        let mut state = state_with(&["/a", "/b", "/c"]);
        reduce(&mut state, RepoConfigsEvent::Removed("/a".to_string()));
        assert_eq!(keys(&state), ["/b", "/c"]);
    }
}
