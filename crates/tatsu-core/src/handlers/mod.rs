mod agents;
mod onboarding;
mod settings;

use std::sync::{Arc, Weak};

use crate::lifecycle::Core;

pub fn register_core_handlers(core: &Arc<Core>) {
    settings::register(core);
    onboarding::register(core);
    agents::register(core);
}

fn upgrade(core: &Weak<Core>) -> Result<Arc<Core>, String> {
    core.upgrade().ok_or_else(|| "core shut down".to_owned())
}
