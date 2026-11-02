use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::wire::False;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum HarnessConfigResourceType {
    Agents,
    Skills,
    Commands,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ManagedHarnessKind {
    Claude,
    Codex,
    Opencode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum HarnessConfigRootKey {
    ClaudeAgents,
    ClaudeSkills,
    ClaudeCommands,
    CodexHome,
    CodexSkills,
    OpencodeAgents,
    OpencodeSkills,
    OpencodeCommands,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct HarnessConfigRoots(pub IndexMap<HarnessConfigRootKey, String>);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum HarnessConfigScopeKey {
    #[serde(rename = "claude:agents")]
    ClaudeAgents,
    #[serde(rename = "claude:skills")]
    ClaudeSkills,
    #[serde(rename = "claude:commands")]
    ClaudeCommands,
    #[serde(rename = "codex:agents")]
    CodexAgents,
    #[serde(rename = "codex:skills")]
    CodexSkills,
    #[serde(rename = "codex:commands")]
    CodexCommands,
    #[serde(rename = "opencode:agents")]
    OpencodeAgents,
    #[serde(rename = "opencode:skills")]
    OpencodeSkills,
    #[serde(rename = "opencode:commands")]
    OpencodeCommands,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigScope {
    pub agent_kind: ManagedHarnessKind,
    pub resource_type: HarnessConfigResourceType,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessConfigSyncStatus {
    Synced,
    ConfigOnly,
    Conflict,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum HarnessConfigFileSource {
    Template,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigFileRef {
    pub id: String,
    pub agent_kind: ManagedHarnessKind,
    pub resource_type: HarnessConfigResourceType,
    pub canonical_resource_type: HarnessConfigResourceType,
    pub alias_resource_types: Vec<HarnessConfigResourceType>,
    pub label: String,
    pub relative_path: String,
    pub absolute_path: String,
    pub hash: String,
    pub exists_on_disk: bool,
    pub managed: bool,
    pub updated_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<HarnessConfigFileSource>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct HarnessConfigChangedRef {
    pub disk: HarnessConfigFileRef,
    pub config: HarnessConfigFileRef,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigRenderErrorEntry {
    pub template_ref: String,
    pub message: String,
    pub held: Vec<HarnessConfigFileRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigFragmentErrorEntry {
    pub id: String,
    pub label: String,
    pub relative_path: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<HarnessConfigFileRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigFragmentEditEntry {
    pub id: String,
    pub label: String,
    pub relative_path: String,
    pub fragments: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigComparison {
    pub scope: HarnessConfigScope,
    pub status: HarnessConfigSyncStatus,
    pub config_only: Vec<HarnessConfigFileRef>,
    pub changed: Vec<HarnessConfigChangedRef>,
    pub compared_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_errors: Option<Vec<HarnessConfigRenderErrorEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment_errors: Option<Vec<HarnessConfigFragmentErrorEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment_edits: Option<Vec<HarnessConfigFragmentEditEntry>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct HarnessConfigComparisons(pub IndexMap<HarnessConfigScopeKey, HarnessConfigComparison>);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct HarnessTemplateHarnessBlock {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragments: Option<Vec<String>>,
    pub frontmatter: Map<String, Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum HarnessTemplateHarnessEntry {
    Block(HarnessTemplateHarnessBlock),
    Disabled(False),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(transparent)]
pub struct HarnessTemplateHarnesses(pub IndexMap<ManagedHarnessKind, HarnessTemplateHarnessEntry>);

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn harnesses_keep_key_order_and_the_false_variant() {
        let harnesses = json!({
            "opencode": false,
            "claude": {
                "name": "reviewer",
                "frontmatter": { "zeta": 1, "alpha": { "nested": [true, null] }, "mid": "x" }
            },
            "codex": { "fragments": ["a"], "frontmatter": {} }
        });

        let parsed: HarnessTemplateHarnesses = serde_json::from_value(harnesses.clone()).unwrap();
        let written = serde_json::to_string(&parsed).unwrap();

        assert_eq!(
            written,
            r#"{"opencode":false,"claude":{"name":"reviewer","frontmatter":{"zeta":1,"alpha":{"nested":[true,null]},"mid":"x"}},"codex":{"fragments":["a"],"frontmatter":{}}}"#
        );
        assert_eq!(
            parsed.0.get(&ManagedHarnessKind::Opencode),
            Some(&HarnessTemplateHarnessEntry::Disabled(False))
        );
    }

    #[test]
    fn a_true_harness_entry_is_rejected() {
        let parsed = serde_json::from_value::<HarnessTemplateHarnesses>(json!({ "claude": true }));
        assert!(parsed.is_err());
    }

    #[test]
    fn comparisons_keep_insertion_order_of_scope_keys() {
        let comparison = |agent: &str, resource: &str| {
            json!({
                "scope": { "agentKind": agent, "resourceType": resource },
                "status": "config-only",
                "configOnly": [],
                "changed": [],
                "comparedAt": 7
            })
        };
        let text = format!(
            r#"{{"opencode:commands":{},"claude:agents":{},"codex:skills":{}}}"#,
            comparison("opencode", "commands"),
            comparison("claude", "agents"),
            comparison("codex", "skills")
        );

        let parsed: HarnessConfigComparisons = serde_json::from_str(&text).unwrap();

        assert_eq!(
            parsed.0.keys().copied().collect::<Vec<_>>(),
            vec![
                HarnessConfigScopeKey::OpencodeCommands,
                HarnessConfigScopeKey::ClaudeAgents,
                HarnessConfigScopeKey::CodexSkills
            ]
        );
        assert_eq!(serde_json::to_string(&parsed).unwrap(), text);
    }

    #[test]
    fn roots_keep_insertion_order() {
        let text = r#"{"opencodeSkills":"/o","claudeAgents":"/c"}"#;
        let parsed: HarnessConfigRoots = serde_json::from_str(text).unwrap();
        assert_eq!(serde_json::to_string(&parsed).unwrap(), text);
    }

    #[test]
    fn single_literal_source_accepts_only_template() {
        assert_eq!(
            serde_json::to_value(HarnessConfigFileSource::Template).unwrap(),
            json!("template")
        );
        assert!(serde_json::from_value::<HarnessConfigFileSource>(json!("disk")).is_err());
    }
}
