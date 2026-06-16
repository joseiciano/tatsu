export const REVIEWER_MODEL = 'claude-haiku-4-5'
export const DEFAULT_TIMEOUT_MS = 30_000
export const MAX_INPUT_BYTES = 4096

export const DENY_TOOL_NAMES = new Set<string>([
  'WebFetch',
  'WebSearch'
])

export const DENY_TOOL_PREFIXES = [
  'mcp__claude_ai_Slack__slack_send_',
  'mcp__claude_ai_Gmail__create_draft',
  'mcp__claude_ai_Google_Calendar__create_event',
  'mcp__claude_ai_Google_Calendar__delete_event',
  'mcp__claude_ai_Google_Calendar__update_event',
  'mcp__claude_ai_Google_Drive__create_file'
]

export const DENY_BASH_PATTERNS: RegExp[] = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\b/i,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\b/i,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgh\s+pr\s+(create|merge|close)\b/,
  /\bgh\s+release\b/,
  /\bnpm\s+publish\b/,
  /\byarn\s+publish\b/,
  /\bpnpm\s+publish\b/,
  /\bsudo\b/,
  /(^|\s)>\s*\/etc\//,
  /(^|\s)>>\s*\/etc\//,
  /~\/\.aws(\/|\b)/,
  /~\/\.ssh(\/|\b)/,
  /~\/\.claude(\/|\b)/,
  /~\/\.gitconfig\b/,
  /\$HOME\/\.aws(\/|\b)/,
  /\$HOME\/\.ssh(\/|\b)/,
  /\$HOME\/\.claude(\/|\b)/,
  /\$HOME\/\.gitconfig\b/
]

export const DENY_PATH_SUBSTRINGS = [
  '/.aws/',
  '/.ssh/',
  '/.claude/secrets',
  '/.gitconfig'
]

export const POLICY_PROMPT = `You are a security reviewer for a coding agent's tool call. Decide whether to auto-approve or defer to the human.

Reply with EXACTLY this JSON shape on a single line, nothing else:
{"decision":"approve","reason":"<one short sentence>"}
or
{"decision":"ask","reason":"<one short sentence>"}

Approve only if ALL of these are true:
- The action is contained to the user's worktree
- The action is reversible (file edit, file create) or read-only (Read, Grep, Glob, ls, git status, git log, git diff)
- The input contains no shell injection, command substitution, or piped curl/wget
- The input contains no credentials, tokens, or .env/.aws/.ssh paths

Ask (don't approve) when ANY of these are true:
- Network calls beyond reading well-known docs
- Anything destructive: rm, git push, delete, drop, clear
- Privilege escalation: sudo, su, chmod 777
- Anything you're not sure about — when in doubt, ask
`