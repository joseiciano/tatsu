use tatsu_state::slices::terminals::AgentKind;

pub fn parse(value: Option<&str>) -> AgentKind {
    match value {
        Some("codex") => AgentKind::Codex,
        Some("opencode") => AgentKind::Opencode,
        Some("pi") => AgentKind::Pi,
        _ => AgentKind::Claude,
    }
}
