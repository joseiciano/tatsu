use serde::Serialize;
use tatsu_state::slices::harness_config::HarnessConfigResourceType;
use tatsu_state::slices::terminals::AgentKind;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessTemplateOutput {
    pub frontmatter_name: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityLayout {
    PerResource,
    SingleFile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessConfigCapabilityStatus {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum CapabilityAvailability {
    Supported {
        #[serde(skip_serializing_if = "Option::is_none")]
        notes: Option<&'static str>,
        #[serde(skip_serializing_if = "Option::is_none")]
        alias_resource_types: Option<&'static [HarnessConfigResourceType]>,
        #[serde(skip_serializing_if = "Option::is_none")]
        layout: Option<CapabilityLayout>,
        #[serde(skip_serializing_if = "Option::is_none")]
        template_output: Option<HarnessTemplateOutput>,
    },
    Unsupported {
        notes: &'static str,
    },
    Unknown {
        notes: &'static str,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigCapability {
    pub resource_type: HarnessConfigResourceType,
    pub label: &'static str,
    #[serde(flatten)]
    pub availability: CapabilityAvailability,
}

impl AgentConfigCapability {
    pub fn status(&self) -> HarnessConfigCapabilityStatus {
        match self.availability {
            CapabilityAvailability::Supported { .. } => HarnessConfigCapabilityStatus::Supported,
            CapabilityAvailability::Unsupported { .. } => {
                HarnessConfigCapabilityStatus::Unsupported
            }
            CapabilityAvailability::Unknown { .. } => HarnessConfigCapabilityStatus::Unknown,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub kind: AgentKind,
    pub display_name: &'static str,
    pub vendor: &'static str,
    pub assigns_session_id: bool,
    pub config_capabilities: &'static [AgentConfigCapability],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    Current,
    Legacy,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: &'static str,
    pub display_name: &'static str,
    pub tier: ModelTier,
}

const NAMED: Option<HarnessTemplateOutput> = Some(HarnessTemplateOutput {
    frontmatter_name: true,
});
const PATH_NAMED: Option<HarnessTemplateOutput> = Some(HarnessTemplateOutput {
    frontmatter_name: false,
});
const PI_DEFERRED: &str = "Pi config management is deferred; its resource capabilities and layouts are not yet specified.";

const fn supported(
    resource_type: HarnessConfigResourceType,
    label: &'static str,
    template_output: Option<HarnessTemplateOutput>,
) -> AgentConfigCapability {
    AgentConfigCapability {
        resource_type,
        label,
        availability: CapabilityAvailability::Supported {
            notes: None,
            alias_resource_types: None,
            layout: None,
            template_output,
        },
    }
}

const fn pi_unknown(
    resource_type: HarnessConfigResourceType,
    label: &'static str,
) -> AgentConfigCapability {
    AgentConfigCapability {
        resource_type,
        label,
        availability: CapabilityAvailability::Unknown { notes: PI_DEFERRED },
    }
}

use HarnessConfigResourceType::{Agents, Commands, Skills};

pub static AGENT_REGISTRY: [AgentInfo; 4] = [
    AgentInfo {
        kind: AgentKind::Claude,
        display_name: "Claude Code",
        vendor: "Anthropic",
        assigns_session_id: true,
        config_capabilities: &[
            supported(Agents, "Agents", NAMED),
            AgentConfigCapability {
                resource_type: Skills,
                label: "Skills",
                availability: CapabilityAvailability::Supported {
                    notes: Some(
                        "Claude skills also appear in the Commands view as the same physical resource.",
                    ),
                    alias_resource_types: Some(&[Commands]),
                    layout: None,
                    template_output: NAMED,
                },
            },
            AgentConfigCapability {
                resource_type: Commands,
                label: "Commands",
                availability: CapabilityAvailability::Supported {
                    notes: Some("Includes native Claude commands and aliases of Claude skills."),
                    alias_resource_types: None,
                    layout: None,
                    template_output: NAMED,
                },
            },
        ],
    },
    AgentInfo {
        kind: AgentKind::Codex,
        display_name: "Codex",
        vendor: "OpenAI",
        assigns_session_id: false,
        config_capabilities: &[
            AgentConfigCapability {
                resource_type: Agents,
                label: "Agents",
                availability: CapabilityAvailability::Supported {
                    notes: Some(
                        "Codex agents are one top-level AGENTS.md file, not a folder of agents.",
                    ),
                    alias_resource_types: None,
                    layout: Some(CapabilityLayout::SingleFile),
                    template_output: None,
                },
            },
            supported(Skills, "Skills", NAMED),
            AgentConfigCapability {
                resource_type: Commands,
                label: "Commands",
                availability: CapabilityAvailability::Unsupported {
                    notes: "Tatsu has no verified first-version custom-command filesystem contract.",
                },
            },
        ],
    },
    AgentInfo {
        kind: AgentKind::Opencode,
        display_name: "Opencode",
        vendor: "Opencode",
        assigns_session_id: false,
        config_capabilities: &[
            supported(Agents, "Agents", PATH_NAMED),
            supported(Skills, "Skills", NAMED),
            supported(Commands, "Commands", PATH_NAMED),
        ],
    },
    AgentInfo {
        kind: AgentKind::Pi,
        display_name: "Pi",
        vendor: "Earendil",
        assigns_session_id: false,
        config_capabilities: &[
            pi_unknown(Agents, "Agents"),
            pi_unknown(Skills, "Skills"),
            pi_unknown(Commands, "Commands"),
        ],
    },
];

const fn model(id: &'static str, display_name: &'static str, tier: ModelTier) -> ModelOption {
    ModelOption {
        id,
        display_name,
        tier,
    }
}

pub static CLAUDE_MODELS: [ModelOption; 12] = [
    model("claude-opus-4-7", "Claude Opus 4.7", ModelTier::Current),
    model("claude-sonnet-4-6", "Claude Sonnet 4.6", ModelTier::Current),
    model("claude-haiku-4-5", "Claude Haiku 4.5", ModelTier::Current),
    model("claude-opus-4-6", "Claude Opus 4.6", ModelTier::Legacy),
    model("claude-sonnet-4-5", "Claude Sonnet 4.5", ModelTier::Legacy),
    model("claude-opus-4-5", "Claude Opus 4.5", ModelTier::Legacy),
    model("claude-opus-4-1", "Claude Opus 4.1", ModelTier::Legacy),
    model("claude-sonnet-4-0", "Claude Sonnet 4.0", ModelTier::Legacy),
    model("claude-opus-4-0", "Claude Opus 4.0", ModelTier::Legacy),
    model(
        "claude-3-5-sonnet-latest",
        "Claude 3.5 Sonnet",
        ModelTier::Legacy,
    ),
    model(
        "claude-3-5-haiku-latest",
        "Claude 3.5 Haiku",
        ModelTier::Legacy,
    ),
    model("claude-3-opus-latest", "Claude 3 Opus", ModelTier::Legacy),
];

pub static CODEX_MODELS: [ModelOption; 13] = [
    model("gpt-5-codex", "GPT-5 Codex", ModelTier::Current),
    model("gpt-5.3-codex", "GPT-5.3 Codex", ModelTier::Current),
    model("gpt-5.2-codex", "GPT-5.2 Codex", ModelTier::Current),
    model("gpt-5.1-codex", "GPT-5.1 Codex", ModelTier::Current),
    model("gpt-5.1-codex-max", "GPT-5.1 Codex Max", ModelTier::Current),
    model(
        "gpt-5.1-codex-mini",
        "GPT-5.1 Codex Mini",
        ModelTier::Current,
    ),
    model("gpt-5.4", "GPT-5.4", ModelTier::Current),
    model("gpt-5.4-mini", "GPT-5.4 Mini", ModelTier::Current),
    model("gpt-5.4-nano", "GPT-5.4 Nano", ModelTier::Current),
    model("o3", "o3", ModelTier::Legacy),
    model("o4-mini", "o4-mini", ModelTier::Legacy),
    model("gpt-4.1", "GPT-4.1", ModelTier::Legacy),
    model("gpt-4.1-mini", "GPT-4.1 Mini", ModelTier::Legacy),
];

pub fn is_harness_config_capability_enabled(capability: &AgentConfigCapability) -> bool {
    capability.status() == HarnessConfigCapabilityStatus::Supported
}

pub fn get_agent_info(kind: AgentKind) -> &'static AgentInfo {
    AGENT_REGISTRY
        .iter()
        .find(|info| info.kind == kind)
        .unwrap_or(&AGENT_REGISTRY[0])
}

pub fn agent_display_name(kind: Option<AgentKind>) -> &'static str {
    match kind {
        Some(kind) => get_agent_info(kind).display_name,
        None => AGENT_REGISTRY[0].display_name,
    }
}

pub fn resource_path_for_name(
    agent_kind: AgentKind,
    resource_type: HarnessConfigResourceType,
    name: &str,
) -> Option<String> {
    match (agent_kind, resource_type) {
        (AgentKind::Pi, _) | (AgentKind::Codex, Commands) => None,
        (_, Agents | Commands) => Some(format!("{name}.md")),
        (_, Skills) => Some(format!("{name}/SKILL.md")),
    }
}

pub fn template_output_for(
    agent_kind: AgentKind,
    resource_type: HarnessConfigResourceType,
) -> Option<HarnessTemplateOutput> {
    let capability = get_agent_info(agent_kind)
        .config_capabilities
        .iter()
        .find(|entry| entry.resource_type == resource_type)?;
    match capability.availability {
        CapabilityAvailability::Supported {
            template_output, ..
        } => template_output,
        _ => None,
    }
}

// The TS version also accepts kinds missing from the registry (index -1 wraps
// to the first agent). `AgentKind` is closed and every variant is registered,
// so that branch is unreachable here and the agreement fixture covers only
// registered kinds.
pub fn get_next_agent_kind(default_agent: AgentKind) -> AgentKind {
    let next = AGENT_REGISTRY
        .iter()
        .position(|info| info.kind == default_agent)
        .map_or(0, |idx| idx + 1);
    AGENT_REGISTRY[next % AGENT_REGISTRY.len()].kind
}

// `usize` rules out the negative and fractional click counts that make the TS
// version index past the array and throw.
pub fn cycle_alt_agent(default_agent: AgentKind, click_count: usize) -> AgentKind {
    let alt: Vec<AgentKind> = AGENT_REGISTRY
        .iter()
        .map(|info| info.kind)
        .filter(|kind| *kind != default_agent)
        .collect();
    if alt.is_empty() {
        return default_agent;
    }
    alt[click_count % alt.len()]
}
