use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use tempfile::TempDir;

use super::*;

fn fake_shell(dir: &TempDir, name: &str, body: &str) -> PathBuf {
    let path = dir.path().join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn capture(shell: &Path, timeout: Duration) -> (Option<String>, Vec<String>) {
    let mut lines = Vec::new();
    let got = capture_path(shell, timeout, &mut |line| lines.push(line.to_owned()));
    (got, lines)
}

#[test]
fn parse_extracts_the_value_between_sentinels() {
    let stdout = "__HARNESS_PATH_BEGIN__\n/usr/local/bin:/usr/bin\n__HARNESS_PATH_END__\n";
    assert_eq!(parse_probe_output(stdout), Some("/usr/local/bin:/usr/bin"));
}

#[test]
fn parse_tolerates_rc_file_noise_before_and_after_the_sentinels() {
    let stdout = "starship init: ok\nnvm: Loading...\n\
        __HARNESS_PATH_BEGIN__\n/opt/homebrew/bin:/usr/bin\n__HARNESS_PATH_END__\n\
        goodbye\n";
    assert_eq!(
        parse_probe_output(stdout),
        Some("/opt/homebrew/bin:/usr/bin")
    );
}

#[test]
fn parse_returns_none_when_sentinels_are_missing() {
    assert_eq!(parse_probe_output("no sentinels here\n"), None);
    assert_eq!(parse_probe_output("__HARNESS_PATH_BEGIN__\n/x:/y\n"), None);
    assert_eq!(parse_probe_output(""), None);
}

#[test]
fn parse_matches_ts_on_empty_values() {
    assert_eq!(
        parse_probe_output("__HARNESS_PATH_BEGIN__\n__HARNESS_PATH_END__\n"),
        None
    );
    assert_eq!(
        parse_probe_output("__HARNESS_PATH_BEGIN__\n\n__HARNESS_PATH_END__\n"),
        Some("")
    );
}

#[test]
fn probe_command_is_the_ts_printf() {
    assert_eq!(
        probe_command(),
        r#"printf '__HARNESS_PATH_BEGIN__\n%s\n__HARNESS_PATH_END__\n' "$PATH""#
    );
}

#[test]
fn merge_preserves_launcher_prepended_entries_at_the_front() {
    let existing = "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin:/bin";
    let captured = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    assert_eq!(
        merge_paths(Some(existing), captured),
        "/repo/node_modules/.bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    );
}

#[test]
fn merge_expands_a_stripped_path_to_the_captured_value() {
    let captured = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    assert_eq!(
        merge_paths(Some("/usr/bin:/bin:/usr/sbin:/sbin"), captured),
        captured
    );
}

#[test]
fn merge_returns_existing_when_captured_is_a_subset() {
    assert_eq!(
        merge_paths(Some("/foo:/bar:/usr/bin:/bin"), "/usr/bin:/bin"),
        "/foo:/bar:/usr/bin:/bin"
    );
}

#[test]
fn merge_is_identity_when_existing_equals_captured() {
    let path = "/opt/homebrew/bin:/usr/bin:/bin";
    assert_eq!(merge_paths(Some(path), path), path);
}

#[test]
fn merge_dedupes_within_existing_only_entries() {
    assert_eq!(
        merge_paths(Some("/foo:/bar:/foo:/usr/bin"), "/usr/bin:/bin"),
        "/foo:/bar:/usr/bin:/bin"
    );
}

#[test]
fn merge_drops_empty_entries_from_both_inputs() {
    assert_eq!(
        merge_paths(Some(":/foo:"), "/usr/bin::/bin"),
        "/foo:/usr/bin:/bin"
    );
}

#[test]
fn merge_returns_captured_when_existing_is_empty_or_missing() {
    assert_eq!(merge_paths(Some(""), "/usr/bin:/bin"), "/usr/bin:/bin");
    assert_eq!(merge_paths(None, "/usr/bin:/bin"), "/usr/bin:/bin");
}

#[test]
fn capture_reads_the_path_through_rc_noise_with_stdin_closed() {
    let dir = TempDir::new().unwrap();
    let shell = fake_shell(
        &dir,
        "noisy.sh",
        r#"echo "starship init: ok"
read line && echo "stdin was open: $line"
[ "$1" = "-ilc" ] && eval "$2"
echo goodbye"#,
    );
    let (got, lines) = capture(&shell, Duration::from_secs(5));
    assert!(got.as_deref().is_some_and(|p| !p.is_empty()), "{got:?}");
    assert!(lines.is_empty(), "{lines:?}");
}

#[test]
fn capture_returns_inner_content_from_a_sentinel_printing_shell() {
    let dir = TempDir::new().unwrap();
    let shell = fake_shell(
        &dir,
        "good.sh",
        r"printf 'nvm: Loading...\n__HARNESS_PATH_BEGIN__\n/fake/path:/usr/bin\n__HARNESS_PATH_END__\nbye\n'",
    );
    assert_eq!(
        capture(&shell, Duration::from_secs(5)),
        (Some("/fake/path:/usr/bin".to_owned()), vec![])
    );
}

#[test]
fn capture_logs_missing_sentinels() {
    let dir = TempDir::new().unwrap();
    let shell = fake_shell(&dir, "nosentinel.sh", "echo nope");
    assert_eq!(
        capture(&shell, Duration::from_secs(5)),
        (
            None,
            vec![format!(
                "probe output missing sentinels (shell={})",
                shell.display()
            )]
        )
    );
}

#[test]
fn capture_kills_the_probe_and_logs_on_timeout_even_when_a_grandchild_holds_stdout() {
    let dir = TempDir::new().unwrap();
    let shell = fake_shell(&dir, "slow.sh", "sleep 5; echo late");
    let start = Instant::now();
    let got = capture(&shell, Duration::from_millis(200));
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "{:?}",
        start.elapsed()
    );
    assert_eq!(
        got,
        (
            None,
            vec![format!(
                "probe timed out after 200ms (shell={})",
                shell.display()
            )]
        )
    );
}

#[test]
fn capture_logs_the_node_spawn_error_for_a_missing_shell() {
    let shell = Path::new("/definitely/not/a/real/shell/binary");
    assert_eq!(
        capture(shell, Duration::from_secs(5)),
        (
            None,
            vec![
                "spawn error (shell=/definitely/not/a/real/shell/binary): spawn /definitely/not/a/real/shell/binary ENOENT"
                    .to_owned(),
                "probe output missing sentinels (shell=/definitely/not/a/real/shell/binary)"
                    .to_owned()
            ]
        )
    );
}

fn fix(existing: &str, captured: Option<&str>) -> (Option<String>, Vec<String>) {
    let mut lines = Vec::new();
    let got = fix_with(
        || PathBuf::from("/fake/zsh"),
        existing,
        |_, _| captured.map(str::to_owned),
        &mut |l| lines.push(l.to_owned()),
    );
    (got, lines)
}

#[test]
fn fix_returns_the_merged_path_and_logs_the_ts_merged_line() {
    assert_eq!(
        fix("/usr/bin:/bin", Some("/opt/homebrew/bin:/usr/bin:/bin")),
        (
            Some("/opt/homebrew/bin:/usr/bin:/bin".to_owned()),
            vec!["PATH merged from /fake/zsh (13 → 31 chars)".to_owned()]
        )
    );
}

#[test]
fn fix_counts_chars_in_utf16_units_like_js_length() {
    let (_, lines) = fix("/ü", Some("/😀"));
    assert_eq!(lines, ["PATH merged from /fake/zsh (2 → 6 chars)"]);
}

#[test]
fn fix_is_silent_and_changes_nothing_when_the_merge_is_identity() {
    assert_eq!(fix("/foo:/usr/bin", Some("/usr/bin")), (None, vec![]));
}

#[test]
fn fix_does_nothing_when_capture_fails() {
    assert_eq!(fix("/usr/bin", None), (None, vec![]));
}

#[test]
fn fix_logs_unexpected_error_and_skips_when_the_probe_panics() {
    let mut lines = Vec::new();
    let got = fix_with(
        || PathBuf::from("/fake/zsh"),
        "/usr/bin",
        |_, _| panic!("boom"),
        &mut |l| lines.push(l.to_owned()),
    );
    assert_eq!(got, None);
    assert_eq!(lines, ["unexpected error, skipping fix: boom"]);
}

#[test]
fn fix_passes_capture_log_lines_through() {
    let mut lines = Vec::new();
    fix_with(
        || PathBuf::from("/fake/zsh"),
        "/usr/bin",
        |shell, log| {
            log(&format!(
                "probe output missing sentinels (shell={})",
                shell.display()
            ));
            None
        },
        &mut |l| lines.push(l.to_owned()),
    );
    assert_eq!(lines, ["probe output missing sentinels (shell=/fake/zsh)"]);
}

#[cfg(target_os = "macos")]
#[test]
fn thread_count_sees_a_new_thread() {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || {
        let _ = rx.recv();
    });
    let during = thread_count().unwrap();
    tx.send(()).unwrap();
    handle.join().unwrap();
    assert!(during >= 2, "{during}");
}

#[test]
fn capture_logs_the_node_spawn_error_for_a_non_executable_shell() {
    let dir = TempDir::new().unwrap();
    let shell = dir.path().join("noexec.sh");
    std::fs::write(&shell, "#!/bin/sh\n").unwrap();
    let shown = shell.display();
    assert_eq!(
        capture(&shell, Duration::from_secs(5)),
        (
            None,
            vec![
                format!("spawn error (shell={shown}): spawn {shown} EACCES"),
                format!("probe output missing sentinels (shell={shown})"),
            ]
        )
    );
}

#[test]
fn capture_times_out_when_the_shell_closes_stdout_but_keeps_running() {
    let dir = TempDir::new().unwrap();
    let shell = fake_shell(&dir, "detached.sh", "exec >/dev/null\nsleep 5");
    let start = Instant::now();
    let got = capture(&shell, Duration::from_millis(200));
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "{:?}",
        start.elapsed()
    );
    assert_eq!(
        got,
        (
            None,
            vec![format!(
                "probe timed out after 200ms (shell={})",
                shell.display()
            )]
        )
    );
}

#[test]
fn capture_logs_spawn_failed_without_the_sentinels_line_for_an_invalid_shell_path() {
    let shell = Path::new("/bin/sh\0x");
    assert_eq!(
        capture(shell, Duration::from_secs(5)),
        (
            None,
            vec!["spawn failed (shell=/bin/sh\0x): nul byte found in provided data".to_owned()]
        )
    );
}
