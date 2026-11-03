use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use super::*;

fn existing(paths: &'static [&'static str]) -> impl Fn(&Path) -> bool {
    move |p| paths.iter().any(|e| Path::new(e) == p)
}

#[test]
fn picks_shell_env_when_it_exists() {
    let got = resolve_with(
        Some(OsStr::new("/opt/fake/fish")),
        existing(&["/opt/fake/fish", "/bin/zsh"]),
    );
    assert_eq!(got, PathBuf::from("/opt/fake/fish"));
}

#[test]
fn skips_missing_shell_env_and_missing_candidates_in_order() {
    let got = resolve_with(
        Some(OsStr::new("/opt/fake/missing")),
        existing(&["/usr/bin/bash", "/usr/bin/zsh", "/bin/sh"]),
    );
    assert_eq!(got, PathBuf::from("/usr/bin/zsh"));
}

#[test]
fn empty_shell_env_is_skipped() {
    let got = resolve_with(Some(OsStr::new("")), |p| {
        p == Path::new("") || p == Path::new("/bin/bash")
    });
    assert_eq!(got, PathBuf::from("/bin/bash"));
}

#[test]
fn falls_back_to_bin_sh_when_nothing_exists() {
    assert_eq!(resolve_with(None, |_| false), PathBuf::from("/bin/sh"));
    assert_eq!(
        resolve_with(Some(OsStr::new("/opt/fake/missing")), |_| false),
        PathBuf::from("/bin/sh")
    );
}

#[test]
fn real_existence_check_counts_a_temp_file_as_a_shell() {
    let dir = tempfile::tempdir().unwrap();
    let fake = dir.path().join("fake-shell");
    std::fs::write(&fake, "").unwrap();
    assert_eq!(resolve_with(Some(fake.as_os_str()), Path::exists), fake);
}

#[test]
fn login_shell_helpers_return_the_three_argument_shapes() {
    assert_eq!(login_command_args("echo hi"), ["-ilc", "echo hi"]);
    assert_eq!(
        login_noninteractive_args("gh auth token"),
        ["-lc", "gh auth token"]
    );
    assert_eq!(login_shell_args(), ["-il"]);
}
