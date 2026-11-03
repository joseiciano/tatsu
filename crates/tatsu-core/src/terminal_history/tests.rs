use super::*;

fn data_dir() -> (tempfile::TempDir, DataDir) {
    let tmp = tempfile::tempdir().unwrap();
    let dir = DataDir::from_path(tmp.path()).unwrap();
    (tmp, dir)
}

fn names(dir: &DataDir) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir.path().join(DIR))
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    out.sort();
    out
}

#[test]
fn save_then_load_round_trips_under_the_history_folder() {
    let (_tmp, dir) = data_dir();
    save(&dir, "wt:1/tab", "hello\n");
    assert_eq!(names(&dir), ["wt_1_tab.txt"]);
    assert_eq!(load(&dir, "wt:1/tab").as_deref(), Some("hello\n"));
}

#[test]
fn load_of_a_missing_id_is_none_and_creates_the_folder() {
    let (_tmp, dir) = data_dir();
    assert_eq!(load(&dir, "nope"), None);
    assert!(dir.path().join(DIR).is_dir());
}

#[test]
fn load_decodes_invalid_utf8_lossily_like_read_file_sync() {
    let (_tmp, dir) = data_dir();
    save(&dir, "a", "");
    std::fs::write(dir.path().join(DIR).join("a.txt"), b"ok\xffend").unwrap();
    assert_eq!(load(&dir, "a").as_deref(), Some("ok\u{fffd}end"));
}

#[test]
fn clear_removes_the_file_and_ignores_a_missing_one() {
    let (_tmp, dir) = data_dir();
    save(&dir, "a", "x");
    clear(&dir, "a");
    clear(&dir, "a");
    assert_eq!(load(&dir, "a"), None);
}

#[test]
fn path_traversal_ids_stay_inside_the_history_folder() {
    let (tmp, dir) = data_dir();
    save(&dir, "../../escape", "x");
    assert_eq!(names(&dir), [".._.._escape.txt"]);
    assert!(!tmp.path().join("escape.txt").exists());
    assert!(!tmp.path().parent().unwrap().join("escape.txt").exists());
}

#[test]
fn prune_keeps_only_the_given_ids() {
    let (_tmp, dir) = data_dir();
    for id in ["keep/1", "drop", "keep-2"] {
        save(&dir, id, id);
    }
    std::fs::write(dir.path().join(DIR).join("stray.log"), "").unwrap();
    prune(&dir, ["keep/1", "keep-2", "never-saved"]);
    assert_eq!(names(&dir), ["keep-2.txt", "keep_1.txt"]);
    assert_eq!(load(&dir, "keep/1").as_deref(), Some("keep/1"));
}

#[test]
fn prune_leaves_subfolders_because_unlink_fails_on_them() {
    let (_tmp, dir) = data_dir();
    std::fs::create_dir_all(dir.path().join(DIR).join("sub")).unwrap();
    prune(&dir, []);
    assert_eq!(names(&dir), ["sub"]);
}

#[test]
fn save_failure_is_swallowed() {
    let (_tmp, dir) = data_dir();
    std::fs::write(dir.path().join(DIR), "not a folder").unwrap();
    save(&dir, "a", "x");
    assert_eq!(load(&dir, "a"), None);
    prune(&dir, []);
    clear(&dir, "a");
}
