use std::cmp::Ordering;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use specta::Type;

use crate::{js_string, wire::False};

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
    #[serde(serialize_with = "crate::wire::number::serialize")]
    #[specta(type = f64)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessConfigSyncDirection {
    SyncToDisk,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigSyncPlan {
    pub plan_id: String,
    pub scope: HarnessConfigScope,
    pub direction: HarnessConfigSyncDirection,
    pub status: HarnessConfigSyncStatus,
    pub config_only: Vec<HarnessConfigFileRef>,
    pub changed: Vec<HarnessConfigChangedRef>,
    pub generated_at: i64,
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub render_errors: Option<Vec<HarnessConfigRenderErrorEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment_errors: Option<Vec<HarnessConfigFragmentErrorEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fragment_edits: Option<Vec<HarnessConfigFragmentEditEntry>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detach: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum HarnessTemplateKind {
    Agent,
    Skill,
    Command,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTemplateReference {
    pub file_name: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTemplate {
    pub kind: HarnessTemplateKind,
    pub name: String,
    pub description: String,
    pub fragments: Vec<String>,
    pub body: String,
    pub harnesses: HarnessTemplateHarnesses,
    pub references: Vec<HarnessTemplateReference>,
    pub relative_path: String,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessFragment {
    pub name: String,
    pub content: String,
    pub relative_path: String,
    pub hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTemplateParseError {
    pub relative_path: String,
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessTemplateSourceState {
    pub templates: Vec<HarnessTemplate>,
    pub fragments: Vec<HarnessFragment>,
    pub errors: Vec<HarnessTemplateParseError>,
    pub loaded_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigTemplateSyncNotice {
    pub scopes: Vec<HarnessConfigScopeKey>,
    pub changed_at: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(default)]
pub struct HarnessConfigResources {
    pub agents: Vec<HarnessConfigFileRef>,
    pub skills: Vec<HarnessConfigFileRef>,
    pub commands: Vec<HarnessConfigFileRef>,
}

impl HarnessConfigResources {
    fn get_mut(
        &mut self,
        resource_type: HarnessConfigResourceType,
    ) -> &mut Vec<HarnessConfigFileRef> {
        match resource_type {
            HarnessConfigResourceType::Agents => &mut self.agents,
            HarnessConfigResourceType::Skills => &mut self.skills,
            HarnessConfigResourceType::Commands => &mut self.commands,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct HarnessConfigState {
    pub resources: HarnessConfigResources,
    pub comparisons: HarnessConfigComparisons,
    pub loading: bool,
    pub error: Option<String>,
    pub last_scanned_at: Option<i64>,
    pub last_synced_at: Option<i64>,
    pub templates: HarnessTemplateSourceState,
    pub template_sync_notice: Option<HarnessConfigTemplateSyncNotice>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigResourcesLoaded {
    pub scope: HarnessConfigScope,
    pub resources: Vec<HarnessConfigFileRef>,
    pub scanned_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigSyncApplied {
    pub scope: HarnessConfigScope,
    pub synced_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConfigResourceDeleted {
    pub agent_kind: ManagedHarnessKind,
    pub resource_type: HarnessConfigResourceType,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTemplatesLoaded {
    pub templates: Vec<HarnessTemplate>,
    pub errors: Vec<HarnessTemplateParseError>,
    pub loaded_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTemplateRemoved {
    pub kind: HarnessTemplateKind,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessFragmentsLoaded {
    pub fragments: Vec<HarnessFragment>,
    pub errors: Vec<HarnessTemplateParseError>,
    pub loaded_at: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
pub struct HarnessFragmentRemoved {
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTemplateSourceErrorChange {
    pub relative_path: String,
    pub message: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload")]
pub enum HarnessConfigEvent {
    #[serde(rename = "harnessConfig/loadingChanged")]
    LoadingChanged(bool),
    #[serde(rename = "harnessConfig/resourcesLoaded")]
    ResourcesLoaded(HarnessConfigResourcesLoaded),
    #[serde(rename = "harnessConfig/comparisonLoaded")]
    ComparisonLoaded(HarnessConfigComparison),
    #[serde(rename = "harnessConfig/syncApplied")]
    SyncApplied(HarnessConfigSyncApplied),
    #[serde(rename = "harnessConfig/resourceUpserted")]
    ResourceUpserted(HarnessConfigFileRef),
    #[serde(rename = "harnessConfig/resourceDeleted")]
    ResourceDeleted(HarnessConfigResourceDeleted),
    #[serde(rename = "harnessConfig/errorChanged")]
    ErrorChanged(Option<String>),
    #[serde(rename = "harnessConfig/templatesLoaded")]
    TemplatesLoaded(HarnessTemplatesLoaded),
    #[serde(rename = "harnessConfig/templateChanged")]
    TemplateChanged(HarnessTemplate),
    #[serde(rename = "harnessConfig/templateRemoved")]
    TemplateRemoved(HarnessTemplateRemoved),
    #[serde(rename = "harnessConfig/fragmentsLoaded")]
    FragmentsLoaded(HarnessFragmentsLoaded),
    #[serde(rename = "harnessConfig/fragmentChanged")]
    FragmentChanged(HarnessFragment),
    #[serde(rename = "harnessConfig/fragmentRemoved")]
    FragmentRemoved(HarnessFragmentRemoved),
    #[serde(rename = "harnessConfig/templateSyncNoticeChanged")]
    TemplateSyncNoticeChanged(Option<HarnessConfigTemplateSyncNotice>),
    #[serde(rename = "harnessConfig/templateSourceErrorChanged")]
    TemplateSourceErrorChanged(HarnessTemplateSourceErrorChange),
}

impl HarnessConfigRootKey {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeAgents => "claudeAgents",
            Self::ClaudeSkills => "claudeSkills",
            Self::ClaudeCommands => "claudeCommands",
            Self::CodexHome => "codexHome",
            Self::CodexSkills => "codexSkills",
            Self::OpencodeAgents => "opencodeAgents",
            Self::OpencodeSkills => "opencodeSkills",
            Self::OpencodeCommands => "opencodeCommands",
        }
    }
}

pub const HARNESS_CONFIG_ROOT_KEYS: [HarnessConfigRootKey; 8] = [
    HarnessConfigRootKey::ClaudeAgents,
    HarnessConfigRootKey::ClaudeSkills,
    HarnessConfigRootKey::ClaudeCommands,
    HarnessConfigRootKey::CodexHome,
    HarnessConfigRootKey::CodexSkills,
    HarnessConfigRootKey::OpencodeAgents,
    HarnessConfigRootKey::OpencodeSkills,
    HarnessConfigRootKey::OpencodeCommands,
];

pub fn is_harness_config_root_key(value: &str) -> bool {
    HARNESS_CONFIG_ROOT_KEYS
        .iter()
        .any(|key| key.as_str() == value)
}

pub const HARNESS_TEMPLATE_KINDS: [HarnessTemplateKind; 3] = [
    HarnessTemplateKind::Agent,
    HarnessTemplateKind::Skill,
    HarnessTemplateKind::Command,
];

pub const HARNESS_FRAGMENTS_DIR: &str = "fragments";

pub fn is_fragment_source_path(relative_path: &str) -> bool {
    relative_path
        .strip_prefix(HARNESS_FRAGMENTS_DIR)
        .is_some_and(|rest| rest.starts_with('/'))
}

pub fn harness_config_scope_key(scope: HarnessConfigScope) -> HarnessConfigScopeKey {
    use HarnessConfigResourceType::{Agents, Commands, Skills};
    use ManagedHarnessKind::{Claude, Codex, Opencode};
    match (scope.agent_kind, scope.resource_type) {
        (Claude, Agents) => HarnessConfigScopeKey::ClaudeAgents,
        (Claude, Skills) => HarnessConfigScopeKey::ClaudeSkills,
        (Claude, Commands) => HarnessConfigScopeKey::ClaudeCommands,
        (Codex, Agents) => HarnessConfigScopeKey::CodexAgents,
        (Codex, Skills) => HarnessConfigScopeKey::CodexSkills,
        (Codex, Commands) => HarnessConfigScopeKey::CodexCommands,
        (Opencode, Agents) => HarnessConfigScopeKey::OpencodeAgents,
        (Opencode, Skills) => HarnessConfigScopeKey::OpencodeSkills,
        (Opencode, Commands) => HarnessConfigScopeKey::OpencodeCommands,
    }
}

fn harness_order(kind: ManagedHarnessKind) -> u8 {
    match kind {
        ManagedHarnessKind::Claude => 0,
        ManagedHarnessKind::Codex => 1,
        ManagedHarnessKind::Opencode => 2,
    }
}

fn template_kind_order(kind: HarnessTemplateKind) -> u8 {
    match kind {
        HarnessTemplateKind::Agent => 0,
        HarnessTemplateKind::Skill => 1,
        HarnessTemplateKind::Command => 2,
    }
}

fn compare_resources(left: &HarnessConfigFileRef, right: &HarnessConfigFileRef) -> Ordering {
    harness_order(left.agent_kind)
        .cmp(&harness_order(right.agent_kind))
        .then_with(|| js_string::compare(&left.relative_path, &right.relative_path))
        .then_with(|| js_string::compare(&left.id, &right.id))
}

fn compare_templates(left: &HarnessTemplate, right: &HarnessTemplate) -> Ordering {
    template_kind_order(left.kind)
        .cmp(&template_kind_order(right.kind))
        .then_with(|| js_string::compare(&left.name, &right.name))
}

fn compare_fragments(left: &HarnessFragment, right: &HarnessFragment) -> Ordering {
    js_string::compare(&left.name, &right.name)
}

fn compare_errors(left: &HarnessTemplateParseError, right: &HarnessTemplateParseError) -> Ordering {
    js_string::compare(&left.relative_path, &right.relative_path)
}

fn upsert_sorted<T>(
    list: &mut Vec<T>,
    item: T,
    same: impl Fn(&T) -> bool,
    compare: impl Fn(&T, &T) -> Ordering,
) {
    if let Some(index) = list.iter().position(same) {
        list[index] = item;
        return;
    }
    let insertion = list
        .iter()
        .position(|entry| compare(&item, entry) == Ordering::Less)
        .unwrap_or(list.len());
    list.insert(insertion, item);
}

fn remove_first<T>(list: &mut Vec<T>, matches: impl Fn(&T) -> bool) {
    if let Some(index) = list.iter().position(matches) {
        list.remove(index);
    }
}

fn replace_errors(
    current: &mut Vec<HarnessTemplateParseError>,
    keep: impl Fn(&HarnessTemplateParseError) -> bool,
    incoming: Vec<HarnessTemplateParseError>,
) {
    current.retain(keep);
    current.extend(incoming);
    current.sort_by(compare_errors);
}

pub fn reduce(state: &mut HarnessConfigState, event: HarnessConfigEvent) {
    match event {
        HarnessConfigEvent::LoadingChanged(loading) => state.loading = loading,
        HarnessConfigEvent::ResourcesLoaded(loaded) => {
            let scope = loaded.scope;
            let list = state.resources.get_mut(scope.resource_type);
            list.retain(|resource| resource.agent_kind != scope.agent_kind);
            list.extend(loaded.resources.into_iter().filter(|resource| {
                resource.agent_kind == scope.agent_kind
                    && resource.resource_type == scope.resource_type
            }));
            list.sort_by(compare_resources);
            state.last_scanned_at = Some(loaded.scanned_at);
        }
        HarnessConfigEvent::ComparisonLoaded(comparison) => {
            state
                .comparisons
                .0
                .insert(harness_config_scope_key(comparison.scope), comparison);
        }
        HarnessConfigEvent::SyncApplied(applied) => state.last_synced_at = Some(applied.synced_at),
        HarnessConfigEvent::ResourceUpserted(resource) => {
            let (agent_kind, id) = (resource.agent_kind, resource.id.clone());
            upsert_sorted(
                state.resources.get_mut(resource.resource_type),
                resource,
                |entry| entry.agent_kind == agent_kind && entry.id == id,
                compare_resources,
            );
        }
        HarnessConfigEvent::ResourceDeleted(deleted) => {
            remove_first(state.resources.get_mut(deleted.resource_type), |resource| {
                resource.agent_kind == deleted.agent_kind && resource.id == deleted.id
            })
        }
        HarnessConfigEvent::ErrorChanged(error) => state.error = error,
        HarnessConfigEvent::TemplatesLoaded(loaded) => {
            let source = &mut state.templates;
            source.templates = loaded.templates;
            source.templates.sort_by(compare_templates);
            replace_errors(
                &mut source.errors,
                |error| is_fragment_source_path(&error.relative_path),
                loaded.errors,
            );
            source.loaded_at = Some(loaded.loaded_at);
        }
        HarnessConfigEvent::TemplateChanged(template) => {
            let source = &mut state.templates;
            remove_first(&mut source.errors, |error| {
                error.relative_path == template.relative_path
            });
            let (kind, name) = (template.kind, template.name.clone());
            upsert_sorted(
                &mut source.templates,
                template,
                |entry| entry.kind == kind && entry.name == name,
                compare_templates,
            );
        }
        HarnessConfigEvent::TemplateRemoved(removed) => {
            remove_first(&mut state.templates.templates, |entry| {
                entry.kind == removed.kind && entry.name == removed.name
            })
        }
        HarnessConfigEvent::FragmentsLoaded(loaded) => {
            let source = &mut state.templates;
            source.fragments = loaded.fragments;
            source.fragments.sort_by(compare_fragments);
            replace_errors(
                &mut source.errors,
                |error| !is_fragment_source_path(&error.relative_path),
                loaded.errors,
            );
            source.loaded_at = Some(loaded.loaded_at);
        }
        HarnessConfigEvent::FragmentChanged(fragment) => {
            let source = &mut state.templates;
            remove_first(&mut source.errors, |error| {
                error.relative_path == fragment.relative_path
            });
            let name = fragment.name.clone();
            upsert_sorted(
                &mut source.fragments,
                fragment,
                |entry| entry.name == name,
                compare_fragments,
            );
        }
        HarnessConfigEvent::FragmentRemoved(removed) => {
            remove_first(&mut state.templates.fragments, |entry| {
                entry.name == removed.name
            })
        }
        HarnessConfigEvent::TemplateSourceErrorChanged(change) => {
            let errors = &mut state.templates.errors;
            let relative_path = change.relative_path;
            match change.message {
                None => remove_first(errors, |error| error.relative_path == relative_path),
                Some(message) => upsert_sorted(
                    errors,
                    HarnessTemplateParseError {
                        relative_path: relative_path.clone(),
                        message,
                    },
                    |error| error.relative_path == relative_path,
                    compare_errors,
                ),
            }
        }
        HarnessConfigEvent::TemplateSyncNoticeChanged(notice) => {
            state.template_sync_notice = notice
        }
    }
}

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
    fn scope_key_is_agent_kind_colon_resource_type_for_every_scope() {
        let kinds = [
            ManagedHarnessKind::Claude,
            ManagedHarnessKind::Codex,
            ManagedHarnessKind::Opencode,
        ];
        let types = [
            HarnessConfigResourceType::Agents,
            HarnessConfigResourceType::Skills,
            HarnessConfigResourceType::Commands,
        ];
        let mut seen = Vec::new();
        for agent_kind in kinds {
            for resource_type in types {
                let key = harness_config_scope_key(HarnessConfigScope {
                    agent_kind,
                    resource_type,
                });
                let want = format!(
                    "{}:{}",
                    serde_json::to_value(agent_kind).unwrap().as_str().unwrap(),
                    serde_json::to_value(resource_type)
                        .unwrap()
                        .as_str()
                        .unwrap()
                );
                assert_eq!(serde_json::to_value(key).unwrap(), json!(want));
                seen.push(key);
            }
        }
        seen.sort_by_key(|key| format!("{key:?}"));
        seen.dedup();
        assert_eq!(seen.len(), 9);
    }

    #[test]
    fn root_keys_list_every_key_in_ts_order_and_match_their_wire_names() {
        let names: Vec<&str> = HARNESS_CONFIG_ROOT_KEYS
            .iter()
            .map(|key| key.as_str())
            .collect();
        assert_eq!(
            names,
            [
                "claudeAgents",
                "claudeSkills",
                "claudeCommands",
                "codexHome",
                "codexSkills",
                "opencodeAgents",
                "opencodeSkills",
                "opencodeCommands"
            ]
        );
        for key in HARNESS_CONFIG_ROOT_KEYS {
            assert_eq!(serde_json::to_value(key).unwrap(), json!(key.as_str()));
        }
    }

    #[test]
    fn root_key_check_accepts_only_exact_key_names() {
        assert!(is_harness_config_root_key("codexHome"));
        assert!(is_harness_config_root_key("opencodeCommands"));
        assert!(!is_harness_config_root_key("CodexHome"));
        assert!(!is_harness_config_root_key("codexAgents"));
        assert!(!is_harness_config_root_key(""));
    }

    #[test]
    fn template_kinds_are_agent_skill_command() {
        assert_eq!(
            serde_json::to_value(HARNESS_TEMPLATE_KINDS).unwrap(),
            json!(["agent", "skill", "command"])
        );
    }

    #[test]
    fn fragment_source_paths_start_with_the_fragments_folder() {
        assert_eq!(HARNESS_FRAGMENTS_DIR, "fragments");
        assert!(is_fragment_source_path("fragments/style.md"));
        assert!(is_fragment_source_path("fragments/"));
        assert!(!is_fragment_source_path("fragments"));
        assert!(!is_fragment_source_path("fragmentsx/style.md"));
        assert!(!is_fragment_source_path("agents/fragments/style.md"));
        assert!(!is_fragment_source_path("Fragments/style.md"));
    }

    #[test]
    fn initial_state_serializes_like_the_ts_initial_slice() {
        assert_eq!(
            serde_json::to_string(&HarnessConfigState::default()).unwrap(),
            r#"{"resources":{"agents":[],"skills":[],"commands":[]},"comparisons":{},"loading":false,"error":null,"lastScannedAt":null,"lastSyncedAt":null,"templates":{"templates":[],"fragments":[],"errors":[],"loadedAt":null},"templateSyncNotice":null}"#
        );
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
