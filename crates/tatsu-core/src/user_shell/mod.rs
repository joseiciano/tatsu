use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const FALLBACKS: [&str; 5] = [
    "/bin/zsh",
    "/bin/bash",
    "/usr/bin/zsh",
    "/usr/bin/bash",
    "/bin/sh",
];

pub fn resolve() -> &'static Path {
    static CACHED: OnceLock<PathBuf> = OnceLock::new();
    CACHED.get_or_init(|| resolve_with(std::env::var_os("SHELL").as_deref(), Path::exists))
}

pub fn resolve_with(shell_env: Option<&OsStr>, exists: impl Fn(&Path) -> bool) -> PathBuf {
    shell_env
        .filter(|s| !s.is_empty())
        .map(Path::new)
        .into_iter()
        .chain(FALLBACKS.iter().map(Path::new))
        .find(|candidate| exists(candidate))
        .unwrap_or(Path::new("/bin/sh"))
        .to_path_buf()
}

pub fn login_command_args(cmd: &str) -> [String; 2] {
    ["-ilc".to_string(), cmd.to_string()]
}

// No TS counterpart: `github` runs `gh auth token` through a login shell
// without `-i`, so rc-file prompts and job control stay out of a
// non-interactive token probe.
pub fn login_noninteractive_args(cmd: &str) -> [String; 2] {
    ["-lc".to_string(), cmd.to_string()]
}

pub fn login_shell_args() -> [&'static str; 1] {
    ["-il"]
}

#[cfg(test)]
mod tests;
