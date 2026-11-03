export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const OPENCODE_SESSION_ID_PATTERN = /^ses_[0-9A-Za-z]{1,64}$/

export function isAgentSessionId(agent: string, sessionId: string): boolean {
  return (agent === 'opencode' ? OPENCODE_SESSION_ID_PATTERN : SESSION_ID_PATTERN).test(sessionId)
}
