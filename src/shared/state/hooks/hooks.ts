export type HooksConsent = 'pending' | 'accepted' | 'declined'

export interface CodexHookTrustSummary {
  state: 'ok' | 'needs-review' | 'not-installed' | 'unknown'
  reviewEvents: string[]
}

export interface HooksState {
  /** User's choice about installing Harness's status hooks at user scope
   *  (~/.claude/settings.json, ~/.codex/hooks.json). The hook command is
   *  env-gated on $HARNESS_TERMINAL_ID, so sessions outside Harness aren't
   *  affected. Main seeds this on boot from config.hooksConsent; the accept
   *  / decline / uninstall IPC handlers keep the persisted copy in sync. */
  consent: HooksConsent
  /** Trust state of Tatsu's Codex hook entries on this backend machine,
   *  null until main has computed it. */
  codexTrust: CodexHookTrustSummary | null
}

export type HooksEvent =
  | { type: 'hooks/consentChanged'; payload: HooksConsent }
  | { type: 'hooks/codexTrustChanged'; payload: CodexHookTrustSummary }

export const initialHooks: HooksState = {
  consent: 'pending',
  codexTrust: null
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function hooksReducer(state: HooksState, event: HooksEvent): HooksState {
  switch (event.type) {
    case 'hooks/consentChanged':
      return { ...state, consent: event.payload }
    case 'hooks/codexTrustChanged': {
      const cur = state.codexTrust
      if (cur && cur.state === event.payload.state && sameList(cur.reviewEvents, event.payload.reviewEvents)) {
        return state
      }
      return { ...state, codexTrust: event.payload }
    }
  }
  return state
}
