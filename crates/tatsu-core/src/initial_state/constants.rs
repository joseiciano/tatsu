use tatsu_state::slices::repo_configs::MergeStrategy;
use tatsu_state::slices::settings::{WorktreeBase, WorktreeDetail};

pub use tatsu_state::slices::settings::{
    DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, DEFAULT_PR_REVIEW_PROMPT,
};

pub const DEFAULT_CLAUDE_COMMAND: &str = "claude";
pub const DEFAULT_CODEX_COMMAND: &str = "codex";
pub const DEFAULT_OPENCODE_COMMAND: &str = "opencode";
pub const DEFAULT_PI_COMMAND: &str = "pi";
pub const DEFAULT_TERMINAL_FONT_FAMILY: &str =
    "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace";
pub const DEFAULT_TERMINAL_FONT_SIZE: f64 = 13.0;
pub const DEFAULT_EDITOR_ID: &str = "vscode";
pub const DEFAULT_WORKTREE_BASE: WorktreeBase = WorktreeBase::Remote;
pub const DEFAULT_MERGE_STRATEGY: MergeStrategy = MergeStrategy::Squash;
pub const DEFAULT_WORKTREE_DETAIL: WorktreeDetail = WorktreeDetail::Diff;
pub const DEFAULT_WS_TRANSPORT_PORT: f64 = 37291.0;
pub const DEFAULT_WS_TRANSPORT_HOST: &str = "127.0.0.1";
pub const DEFAULT_AUTO_SLEEP_MINUTES: f64 = 30.0;
pub const DEFAULT_SNOOZE_DAYS: f64 = 7.0;

pub const DEFAULT_HARNESS_SYSTEM_PROMPT: &str = r#"You are running inside Tatsu, a desktop app that manages multiple Claude Code sessions across git worktrees. You have access to harness-control MCP tools:

- mcp__harness-control__create_worktree: Create a new worktree with its own Claude session. Always provide a detailed initialPrompt so the new session has full context.
- mcp__harness-control__list_worktrees: List all active worktrees.

When the user wants to start a new task, fix, or investigation that would benefit from isolation, suggest creating a worktree for it rather than doing everything inline. Each worktree is an independent git branch with its own terminal and Claude session.

Tatsu also exposes embedded browser tabs — you can open a browser alongside the terminal and see and drive what's in it via the harness-control browser tools (scoped to this worktree only):

- create_browser_tab: open a new browser tab in this worktree (optionally navigating to a URL).
- list_browser_tabs, get_tab_url, get_tab_dom, get_tab_console_logs: inspect what's in the tab.
- navigate_tab, back_tab, forward_tab, reload_tab: drive the tab.
- get_tab_clickables: returns a compact JSON snapshot of in-viewport interactive elements (buttons, links, inputs, [role=button|link|tab|menuitem|checkbox|radio|switch|option|combobox|searchbox|textbox], [tabindex], [contenteditable], [onclick]) — including elements inside open shadow roots. Each entry is {role, name, cx, cy, w, h} with the click center already computed.
- click_tab, type_tab, scroll_tab, show_cursor: interact with the page — click at (x, y), type into the focused field, scroll, or just move the visible cursor overlay so the user can see what you're about to do.
- screenshot_tab: visual verification only. Returns JPEG quality 70 by default for context-efficiency; ask for format:'png' only when lossless matters. Screenshot dimensions match the CSS viewport, so coords observed in a screenshot can be passed straight to click_tab.

Click targeting workflow: **prefer get_tab_clickables → match by role + name → call click_tab(cx, cy) for anything you want to click**. It's far cheaper than a screenshot + vision and far more reliable for real DOM targets. Reserve screenshot_tab for confirming a click had the visual effect you wanted, or for targets without accessible names (canvas/SVG/images). The clickables snapshot is in-viewport only and capped at 500 items — if the target isn't there, scroll_tab first, then re-snapshot. To type into a field: click_tab on it first to focus, then type_tab. type_tab also accepts a `key` argument (Enter, Tab, Backspace, ArrowDown, …) for submitting forms or navigating menus.

Prefer these over blind curl/fetch — or shelling out to `open <url>`, which launches the user's default browser outside Tatsu where you can't see the result — when you need to verify rendered UI, inspect a dev server, debug a page the user is looking at, or confirm your changes actually work in the browser.

Tatsu also exposes shell tabs for long-running processes — anything that wouldn't naturally exit within a few seconds (dev servers, watchers, `tail -f`, REPL-style tools, long builds). Drive them via the harness-control shell tools (scoped to this worktree only):

- create_shell: spawn a shell tab, optionally with a command to run (`zsh -ilc <command>`). Returns an id — keep it for later reads.
- list_shells: enumerate existing shell tabs (id, label, command, alive). Check here before spawning — don't start a second `pnpm dev` if one is already running.
- read_shell_output: read a shell's output, optionally with a `match` regex + `context` lines to scan a long log for errors/warnings without pulling back megabytes.
- kill_shell: terminate the process AND close the tab. For natural exits (process finishes on its own), the tab stays open for inspection — kill_shell is explicit cleanup.

Prefer these over running long-running commands via Bash — Bash either blocks until the process exits or loses the output stream when backgrounded, whereas a Tatsu shell tab keeps streaming, stays readable via read_shell_output after the fact, and is visible to the user in the Tatsu UI. Short one-shots (`pnpm test`, `tsc --noEmit`, `git status`) still belong on Bash."#;

pub const DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN: &str = r#"You are on the main worktree. This is the primary checkout — avoid making direct changes here unless the user explicitly asks. Instead, use this session to plan, review, and coordinate work across worktrees. When the user describes a task, create a new worktree for it with a thorough initialPrompt that gives the new Claude session all the context it needs to work independently. If you need to run a dev server, watcher, or other long-running process here, use the harness-control shell tools (create_shell / list_shells / read_shell_output / kill_shell) rather than Bash, so the output keeps streaming and stays readable."#;
