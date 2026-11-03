use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::SettingsEvent;

use super::upgrade;
use crate::initial_state::constants::{
    DEFAULT_HARNESS_SYSTEM_PROMPT, DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN, DEFAULT_PR_REVIEW_PROMPT,
};
use crate::lifecycle::Core;
use crate::router::Reply;

type PromptSetter = (
    &'static str,
    &'static str,
    &'static str,
    fn(String) -> SettingsEvent,
);

const PROMPTS: [PromptSetter; 3] = [
    (
        "config:setHarnessSystemPrompt",
        "harnessSystemPrompt",
        DEFAULT_HARNESS_SYSTEM_PROMPT,
        SettingsEvent::HarnessSystemPromptChanged,
    ),
    (
        "config:setHarnessSystemPromptMain",
        "harnessSystemPromptMain",
        DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
        SettingsEvent::HarnessSystemPromptMainChanged,
    ),
    (
        "config:setPrReviewPrompt",
        "prReviewPrompt",
        DEFAULT_PR_REVIEW_PROMPT,
        SettingsEvent::PrReviewPromptChanged,
    ),
];

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    for (channel, key, default, event) in PROMPTS {
        let weak = Arc::downgrade(core);
        router
            .request(channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let prompt = prompt_arg(args.first())?;
                    let trimmed = tatsu_js::trim(prompt);
                    let payload = if trimmed.is_empty() || trimmed == default {
                        core.config().remove(key);
                        default.to_owned()
                    } else {
                        core.config().set(key, Value::String(prompt.to_owned()));
                        prompt.to_owned()
                    };
                    core.store().dispatch(StateEvent::Settings(event(payload)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .expect("prompt setter registers once");
    }
}

fn prompt_arg(arg: Option<&Value>) -> Result<&str, String> {
    match arg {
        Some(Value::String(prompt)) => Ok(prompt),
        None => Err("Cannot read properties of undefined (reading 'trim')".to_owned()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'trim')".to_owned()),
        Some(_) => Err("prompt.trim is not a function".to_owned()),
    }
}
