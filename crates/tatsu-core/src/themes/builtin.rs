pub const AVAILABLE_THEMES: [&str; 10] = [
    "dark",
    "dracula",
    "nord",
    "gruvbox-dark",
    "tokyo-night",
    "catppuccin-mocha",
    "one-dark",
    "solarized-dark",
    "solarized-light",
    "cyberfunk",
];

pub const THEME_APP_BG: [(&str, &str); 10] = [
    ("dark", "#0a0a0a"),
    ("dracula", "#282a36"),
    ("nord", "#2e3440"),
    ("gruvbox-dark", "#282828"),
    ("tokyo-night", "#1a1b26"),
    ("catppuccin-mocha", "#1e1e2e"),
    ("one-dark", "#282c34"),
    ("solarized-dark", "#002b36"),
    ("solarized-light", "#fdf6e3"),
    ("cyberfunk", "#000000"),
];

pub fn is_builtin(theme_id: &str) -> bool {
    AVAILABLE_THEMES.contains(&theme_id)
}

pub fn app_bg_for(theme_id: &str) -> Option<&'static str> {
    THEME_APP_BG
        .iter()
        .find(|(id, _)| *id == theme_id)
        .map(|(_, bg)| *bg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn recorded() -> Value {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/core/themes/builtin.json"
        );
        let cases: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        cases[0].clone()
    }

    #[test]
    fn available_themes_match_the_ts_list_in_order() {
        let expected: Vec<String> =
            serde_json::from_value(recorded()["availableThemes"].clone()).unwrap();
        assert_eq!(AVAILABLE_THEMES.to_vec(), expected);
    }

    #[test]
    fn app_bg_for_returns_the_ts_value_for_every_builtin_id() {
        let Value::Object(table) = recorded()["themeAppBg"].clone() else {
            panic!("themeAppBg is not an object");
        };
        assert_eq!(table.len(), THEME_APP_BG.len());
        for (id, bg) in &table {
            assert_eq!(app_bg_for(id), bg.as_str(), "{id}");
        }
        for id in AVAILABLE_THEMES {
            assert!(table.contains_key(id), "{id} has no recorded background");
        }
    }

    #[test]
    fn app_bg_for_an_unknown_or_custom_id_is_none() {
        assert_eq!(app_bg_for("my-custom-theme"), None);
        assert_eq!(app_bg_for("Dark"), None);
        assert_eq!(app_bg_for(""), None);
    }
}
