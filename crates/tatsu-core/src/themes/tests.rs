use std::fs;
use std::path::Path;

use tatsu_state::slices::settings::CustomThemeMode;

use super::*;

fn load_logged(dir: &Path) -> (Vec<CustomTheme>, Vec<String>) {
    let mut lines = Vec::new();
    let themes = load_from(dir, &mut |line| lines.push(line));
    (themes, lines)
}

fn write(dir: &Path, name: &str, body: &str) {
    fs::write(dir.join(name), body).unwrap();
}

#[test]
fn derive_id_follows_the_ts_filename_rule() {
    let cases = [
        ("My Cool Theme!.json", "my-cool-theme"),
        ("Case.json", "case"),
        ("Upper.JSON", "upper"),
        ("--edge--dashes--.json", "edge-dashes"),
        ("a___b.json", "a-b"),
        ("a-_-b.json", "a-b"),
        ("Spécial.json", "sp-cial"),
        ("theme.json.json", "theme-json"),
        ("!!!.json", ""),
        (".json", ""),
        ("-.json", ""),
    ];
    for (filename, id) in cases {
        assert_eq!(derive_id(filename), id, "{filename}");
    }
}

#[test]
fn files_are_scanned_in_sorted_name_order_and_non_json_is_ignored() {
    let tmp = tempfile::TempDir::new().unwrap();
    for name in ["zeta.json", "Alpha.json", "mid.JSON"] {
        write(tmp.path(), name, r#"{"name":"x","mode":"dark"}"#);
    }
    write(tmp.path(), "notes.txt", r#"{"name":"x","mode":"dark"}"#);
    write(tmp.path(), "a.json.bak", r#"{"name":"x","mode":"dark"}"#);

    let (themes, lines) = load_logged(tmp.path());

    let ids: Vec<&str> = themes.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["alpha", "mid", "zeta"]);
    assert!(lines.is_empty(), "{lines:?}");
}

#[test]
fn an_invalid_first_file_does_not_claim_its_id() {
    let tmp = tempfile::TempDir::new().unwrap();
    write(tmp.path(), "My Theme.json", r#"{"name":"bad"}"#);
    write(
        tmp.path(),
        "my-theme.json",
        r#"{"name":"Good","mode":"light"}"#,
    );
    write(
        tmp.path(),
        "my_theme.json",
        r#"{"name":"Late","mode":"dark"}"#,
    );

    let (themes, lines) = load_logged(tmp.path());

    assert_eq!(themes.len(), 1);
    assert_eq!(themes[0].name, "Good");
    assert_eq!(
        lines,
        [
            "skipping My Theme.json: missing required name/mode or invalid shape",
            "skipping my_theme.json: duplicate id \"my-theme\" (first one wins)",
        ]
    );
}

#[test]
fn built_in_ids_are_never_shadowed_even_by_valid_files() {
    let tmp = tempfile::TempDir::new().unwrap();
    write(tmp.path(), "Nord.json", r#"{"name":"Nord","mode":"dark"}"#);

    let (themes, lines) = load_logged(tmp.path());

    assert!(themes.is_empty());
    assert_eq!(
        lines,
        ["skipping Nord.json: id \"nord\" collides with built-in theme"]
    );
}

#[test]
fn colors_keep_non_empty_strings_in_js_key_order_and_drop_proto() {
    let tmp = tempfile::TempDir::new().unwrap();
    write(
        tmp.path(),
        "t.json",
        r##"{"name":" T ","mode":"light","colors":{"b":"#1","2":"#2","__proto__":"#3","a":"","1":"#4","n":5}}"##,
    );

    let (themes, _) = load_logged(tmp.path());

    let colors: Vec<(&str, &str)> = themes[0]
        .colors
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    assert_eq!(colors, [("1", "#4"), ("2", "#2"), ("b", "#1")]);
    assert_eq!(themes[0].name, "T");
    assert_eq!(themes[0].mode, CustomThemeMode::Light);
}

#[test]
fn array_colors_use_their_indexes_as_keys() {
    let tmp = tempfile::TempDir::new().unwrap();
    write(
        tmp.path(),
        "t.json",
        r##"{"name":"T","mode":"dark","colors":["#0","",7,"#3"]}"##,
    );

    let (themes, _) = load_logged(tmp.path());

    let keys: Vec<&str> = themes[0].colors.keys().map(String::as_str).collect();
    assert_eq!(keys, ["0", "3"]);
}

#[test]
fn unreadable_and_unparsable_files_log_a_parse_error() {
    let tmp = tempfile::TempDir::new().unwrap();
    fs::create_dir(tmp.path().join("folder.json")).unwrap();
    write(tmp.path(), "broken.json", "{");

    let (themes, lines) = load_logged(tmp.path());

    assert!(themes.is_empty());
    assert_eq!(lines.len(), 2);
    assert!(lines[0].starts_with("skipping broken.json: parse error — "));
    assert!(lines[1].starts_with("skipping folder.json: parse error — "));
}

#[test]
fn a_themes_path_that_is_a_file_logs_the_node_scandir_message() {
    let tmp = tempfile::TempDir::new().unwrap();
    let data = DataDir::from_path(tmp.path()).unwrap();
    let themes = tmp.path().join("themes");
    fs::write(&themes, "").unwrap();

    let dir = dir(&data).unwrap();
    let (loaded, lines) = load_logged(&dir);

    assert!(loaded.is_empty());
    let path = themes.display();
    assert_eq!(
        lines,
        [format!(
            "failed to read {path}: ENOTDIR: not a directory, scandir '{path}'"
        )]
    );
}

#[test]
fn a_missing_folder_logs_the_node_enoent_message() {
    let tmp = tempfile::TempDir::new().unwrap();
    let missing = tmp.path().join("gone");

    let (_, lines) = load_logged(&missing);

    let path = missing.display();
    assert_eq!(
        lines,
        [format!(
            "failed to read {path}: ENOENT: no such file or directory, scandir '{path}'"
        )]
    );
}

#[test]
fn dir_creates_the_themes_folder_when_missing() {
    let tmp = tempfile::TempDir::new().unwrap();
    let data = DataDir::from_path(tmp.path()).unwrap();

    let dir = dir(&data).unwrap();

    assert_eq!(dir, tmp.path().join("themes"));
    assert!(dir.is_dir());
}

#[cfg(unix)]
#[test]
fn dir_reports_a_mkdir_failure_with_the_node_message() {
    use std::os::unix::fs::PermissionsExt;
    let tmp = tempfile::TempDir::new().unwrap();
    let data = DataDir::from_path(tmp.path()).unwrap();
    fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o555)).unwrap();

    let result = dir(&data);

    fs::set_permissions(tmp.path(), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        result.unwrap_err().to_string(),
        format!(
            "EACCES: permission denied, mkdir '{}'",
            tmp.path().join("themes").display()
        )
    );
}
