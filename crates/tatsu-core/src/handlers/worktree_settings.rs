use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::repo_configs::MergeStrategy;
use tatsu_state::slices::settings::{SettingsEvent, WorktreeBase, WorktreeDetail, WorktreeScripts};

use super::{trim_or_empty, upgrade};
use crate::initial_state::constants::{DEFAULT_WORKTREE_BASE, DEFAULT_WORKTREE_DETAIL};
use crate::lifecycle::Core;
use crate::router::Reply;

const SCRIPT_TRIM_EXPR: &str = "(intermediate value) || \"\"";

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    let weak = Arc::downgrade(core);
    router
        .request("config:setWorktreeScripts", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let field = |key: &str| args.first().and_then(|scripts| scripts.get(key));
                let setup = trim_or_empty(field("setup"), SCRIPT_TRIM_EXPR)?.to_owned();
                let teardown = trim_or_empty(field("teardown"), SCRIPT_TRIM_EXPR)?.to_owned();
                set_or_remove(&core, "worktreeSetupCommand", &setup);
                set_or_remove(&core, "worktreeTeardownCommand", &teardown);
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::WorktreeScriptsChanged(
                        WorktreeScripts { setup, teardown },
                    )));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setWorktreeScripts registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setWorktreeBase", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let mode = match str_arg(args.first()) {
                    Some("remote") => WorktreeBase::Remote,
                    Some("local") => WorktreeBase::Local,
                    _ => return Ok(Reply::Value(Value::Bool(false))),
                };
                if mode == DEFAULT_WORKTREE_BASE {
                    core.config().remove("worktreeBase");
                } else {
                    core.config().set("worktreeBase", args[0].clone());
                }
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::WorktreeBaseChanged(
                        mode,
                    )));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setWorktreeBase registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setMergeStrategy", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let strategy = match str_arg(args.first()) {
                    Some("squash") => MergeStrategy::Squash,
                    Some("merge-commit") => MergeStrategy::MergeCommit,
                    Some("fast-forward") => MergeStrategy::FastForward,
                    _ => return Ok(Reply::Value(Value::Bool(false))),
                };
                core.config().set("mergeStrategy", args[0].clone());
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::MergeStrategyChanged(
                        strategy,
                    )));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setMergeStrategy registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:setWorktreeDetail", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let detail = match str_arg(args.first()) {
                    Some("diff") => WorktreeDetail::Diff,
                    Some("age") => WorktreeDetail::Age,
                    Some("pr") => WorktreeDetail::Pr,
                    Some("none") => WorktreeDetail::None,
                    _ => return Ok(Reply::Value(Value::Bool(false))),
                };
                if detail == DEFAULT_WORKTREE_DETAIL {
                    core.config().remove("worktreeDetail");
                } else {
                    core.config().set("worktreeDetail", args[0].clone());
                }
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::WorktreeDetailChanged(
                        detail,
                    )));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setWorktreeDetail registers once");
}

fn str_arg(arg: Option<&Value>) -> Option<&str> {
    arg.and_then(Value::as_str)
}

fn set_or_remove(core: &Core, key: &str, value: &str) {
    if value.is_empty() {
        core.config().remove(key);
    } else {
        core.config().set(key, Value::String(value.to_owned()));
    }
}
