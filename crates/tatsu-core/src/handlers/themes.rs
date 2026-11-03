use std::sync::Arc;

use serde_json::Value;
use tatsu_state::StateEvent;
use tatsu_state::slices::settings::{
    CustomThemeMode, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, SettingsEvent, ThemeMode,
};

use super::upgrade;
use crate::lifecycle::Core;
use crate::router::Reply;
use crate::themes;

pub(crate) fn reload_custom_themes(core: &Core) -> Result<usize, String> {
    let loaded = themes::load(core.data_dir()).map_err(|err| err.to_string())?;
    let count = loaded.len();
    core.store()
        .dispatch(StateEvent::Settings(SettingsEvent::CustomThemesChanged(
            loaded,
        )));
    Ok(count)
}

fn is_known_theme(core: &Core, id: &str, mode: CustomThemeMode) -> bool {
    themes::builtin::is_builtin(id)
        || core.store().read(|state| {
            state
                .settings
                .custom_themes
                .iter()
                .any(|theme| theme.id == id && theme.mode == mode)
        })
}

struct ThemeSlot {
    channel: &'static str,
    key: &'static str,
    mode: CustomThemeMode,
    default: &'static str,
    event: fn(String) -> SettingsEvent,
}

static THEME_SLOTS: [ThemeSlot; 2] = [
    ThemeSlot {
        channel: "config:setThemeLight",
        key: "themeLight",
        mode: CustomThemeMode::Light,
        default: DEFAULT_LIGHT_THEME,
        event: SettingsEvent::ThemeLightChanged,
    },
    ThemeSlot {
        channel: "config:setThemeDark",
        key: "themeDark",
        mode: CustomThemeMode::Dark,
        default: DEFAULT_DARK_THEME,
        event: SettingsEvent::ThemeDarkChanged,
    },
];

pub(super) fn register(core: &Arc<Core>) {
    let router = core.router();

    let weak = Arc::downgrade(core);
    router
        .request("config:setThemeMode", move |_ctx, args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let mode = match args.first().and_then(Value::as_str) {
                    Some("light") => ThemeMode::Light,
                    Some("dark") => ThemeMode::Dark,
                    Some("system") => ThemeMode::System,
                    _ => return Ok(Reply::Value(Value::Bool(false))),
                };
                match mode {
                    ThemeMode::Light => core.config().set("themeMode", "light".into()),
                    ThemeMode::Dark => core.config().set("themeMode", "dark".into()),
                    ThemeMode::System => {
                        core.config().remove("themeMode");
                    }
                }
                core.store()
                    .dispatch(StateEvent::Settings(SettingsEvent::ThemeModeChanged(mode)));
                Ok(Reply::Value(Value::Bool(true)))
            }
        })
        .expect("config:setThemeMode registers once");

    for slot in &THEME_SLOTS {
        let weak = Arc::downgrade(core);
        router
            .request(slot.channel, move |_ctx, args| {
                let core = upgrade(&weak);
                async move {
                    let core = core?;
                    let theme = match args.first() {
                        Some(Value::String(theme)) if is_known_theme(&core, theme, slot.mode) => {
                            theme.clone()
                        }
                        _ => return Ok(Reply::Value(Value::Bool(false))),
                    };
                    if theme == slot.default {
                        core.config().remove(slot.key);
                    } else {
                        core.config().set(slot.key, Value::String(theme.clone()));
                    }
                    core.store()
                        .dispatch(StateEvent::Settings((slot.event)(theme)));
                    Ok(Reply::Value(Value::Bool(true)))
                }
            })
            .unwrap_or_else(|_| panic!("{} registers once", slot.channel));
    }

    let weak = Arc::downgrade(core);
    router
        .signal("config:setLastEffectiveAppBg", move |_ctx, args| {
            let core = upgrade(&weak)?;
            let Some(Value::String(hex)) = args.first() else {
                return Ok(());
            };
            if hex.is_empty() {
                return Ok(());
            }
            let next = Value::String(hex.clone());
            if core.config().get_raw("lastEffectiveAppBg").as_ref() == Some(&next) {
                return Ok(());
            }
            core.config().set("lastEffectiveAppBg", next);
            Ok(())
        })
        .expect("config:setLastEffectiveAppBg registers once");

    let weak = Arc::downgrade(core);
    router
        .request("config:reloadCustomThemes", move |_ctx, _args| {
            let core = upgrade(&weak);
            async move {
                let core = core?;
                let count = reload_custom_themes(&core)?;
                Ok(Reply::Value(Value::from(count)))
            }
        })
        .expect("config:reloadCustomThemes registers once");

    router
        .request("config:getAvailableThemes", |_ctx, _args| async {
            Ok(Reply::Value(Value::from(
                themes::builtin::AVAILABLE_THEMES.to_vec(),
            )))
        })
        .expect("config:getAvailableThemes registers once");
}
