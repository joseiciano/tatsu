use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::{BrowserToolsMode, SettingsEvent};

use super::upgrade;
use crate::lifecycle::Core;
use crate::router::Reply;

type Toggle = (&'static str, &'static str, fn(bool) -> SettingsEvent);

const DEFAULT_TRUE: [Toggle; 6] = [
    (
        "config:setShareClaudeSettings",
        "shareClaudeSettings",
        SettingsEvent::ShareClaudeSettingsChanged,
    ),
    (
        "config:setHarnessMcpEnabled",
        "harnessMcpEnabled",
        SettingsEvent::HarnessMcpEnabledChanged,
    ),
    (
        "config:setClaudeTuiFullscreen",
        "claudeTuiFullscreen",
        SettingsEvent::ClaudeTuiFullscreenChanged,
    ),
    (
        "config:setHarnessSystemPromptEnabled",
        "harnessSystemPromptEnabled",
        SettingsEvent::HarnessSystemPromptEnabledChanged,
    ),
    (
        "config:setBrowserToolsEnabled",
        "browserToolsEnabled",
        SettingsEvent::BrowserToolsEnabledChanged,
    ),
    (
        "config:setAutoUpdateEnabled",
        "autoUpdateEnabled",
        SettingsEvent::AutoUpdateEnabledChanged,
    ),
];

const DEFAULT_FALSE: [Toggle; 3] = [
    (
        "config:setNameClaudeSessions",
        "nameClaudeSessions",
        SettingsEvent::NameClaudeSessionsChanged,
    ),
    (
        "config:setExperimentalChatAgentsEnabled",
        "experimentalChatAgentsEnabled",
        SettingsEvent::ExperimentalChatAgentsEnabledChanged,
    ),
    (
        "config:setExpandedDiagnosticLoggingEnabled",
        "expandedDiagnosticLoggingEnabled",
        SettingsEvent::ExpandedDiagnosticLoggingEnabledChanged,
    ),
];

const BROWSER_TOOLS_MODE_KEY: &str = "browserToolsMode";

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    for (channel, key, event) in DEFAULT_TRUE {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let enabled = enabled_arg(args.first());
                    if enabled {
                        core.config().remove(key);
                    } else {
                        core.config().set(key, Value::Bool(false));
                    }
                    core.store().dispatch(StateEvent::Settings(event(enabled)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("default-true toggle registers once");
    }

    for (channel, key, event) in DEFAULT_FALSE {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    // setExpandedDiagnosticLoggingEnabled dispatches the raw argument in TS; the bool event carries its truthiness instead.
                    let enabled = enabled_arg(args.first());
                    if enabled {
                        core.config().set(key, Value::Bool(true));
                    } else {
                        core.config().remove(key);
                    }
                    core.store().dispatch(StateEvent::Settings(event(enabled)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("default-false toggle registers once");
    }

    let weak = Arc::downgrade(core);
    router
        .request("config:setBrowserToolsMode", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let mode = browser_tools_mode_arg(args.first());
                match mode {
                    BrowserToolsMode::Full => {
                        core.config().remove(BROWSER_TOOLS_MODE_KEY);
                    }
                    BrowserToolsMode::View => {
                        core.config()
                            .set(BROWSER_TOOLS_MODE_KEY, Value::String("view".to_owned()));
                    }
                }
                core.store().dispatch(StateEvent::Settings(
                    SettingsEvent::BrowserToolsModeChanged(mode),
                ));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setBrowserToolsMode registers once");
}

fn enabled_arg(arg: Option<&Value>) -> bool {
    arg.is_some_and(tatsu_js::truthy)
}

fn browser_tools_mode_arg(arg: Option<&Value>) -> BrowserToolsMode {
    match arg {
        Some(Value::String(mode)) if mode == "view" => BrowserToolsMode::View,
        _ => BrowserToolsMode::Full,
    }
}
