const USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi
const TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g

export function scrubCredentials(text: string): string {
  return text.replace(USERINFO_PATTERN, '$1').replace(TOKEN_PATTERN, '[redacted]')
}
