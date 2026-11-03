use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::hooks::{HooksConsent, HooksEvent};

use super::upgrade;
use crate::lifecycle::{Core, HooksInstaller};
use crate::logs;
use crate::router::Reply;

const CONSENT_KEY: &str = "hooksConsent";
const CATEGORY: &str = "hooks";

#[derive(Clone, Copy)]
enum InstallerStep {
    None,
    Install,
    Uninstall,
}

pub(super) fn register(core: &Arc<Core>) {
    for (channel, step, consent) in [
        (
            "hooks:accept",
            InstallerStep::Install,
            HooksConsent::Accepted,
        ),
        ("hooks:decline", InstallerStep::None, HooksConsent::Declined),
        (
            "hooks:uninstall",
            InstallerStep::Uninstall,
            HooksConsent::Pending,
        ),
    ] {
        let weak = Arc::downgrade(core);
        core.router()
            .request(channel, move |_ctx, _args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    run_installer(&core, step).await?;
                    persist_consent(&core, consent);
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .unwrap_or_else(|_| panic!("{channel} registers once"));
    }
}

async fn run_installer(core: &Core, step: InstallerStep) -> Result<(), String> {
    let call: fn(&dyn HooksInstaller) -> Result<(), String> = match step {
        InstallerStep::None => return Ok(()),
        InstallerStep::Install => |installer| installer.install(),
        InstallerStep::Uninstall => |installer| installer.uninstall(),
    };
    let Some(installer) = core.hooks_installer() else {
        logs::log(CATEGORY, "no hooks installer registered");
        return Ok(());
    };
    tokio::task::spawn_blocking(move || call(installer.as_ref()))
        .await
        .map_err(|e| e.to_string())?
}

fn persist_consent(core: &Core, consent: HooksConsent) {
    let raw = serde_json::to_value(consent).expect("HooksConsent serializes");
    core.config().set(CONSENT_KEY, raw);
    core.store()
        .dispatch(StateEvent::Hooks(HooksEvent::ConsentChanged(consent)));
}
