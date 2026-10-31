# Tool approvals

When an OpenCode or Codex agent wants to run a tool that its permission mode does not auto-allow, Tatsu shows the same approval card used for Claude: Allow runs the tool once, Allow always skips future cards of that kind in the session, Reject stops the tool and tells the agent.

## Sub-features

- `approval-card` a tool call in `default` mode creates a pending approval with the ACP tool kind as `toolName` and the agent's title in `input.title`.
- `approval-allow` allowing runs the tool and the turn completes with its side effect.
- `approval-reject` rejecting ends the tool call and the agent reports the rejection.
- `approval-always` "Allow always" auto-allows the next call of the same kind in that session.
- `approval-accept-edits` in `acceptEdits` mode, `edit` kinds never produce a card.

## How to get to it (user POV)

- Permission mode `default` in the chat composer, then any prompt that makes the agent edit a file or run a command.
- The approval card's Allow / Allow always / Reject buttons.

## Driving it with control.mjs

Preconditions:

- An agent that is authenticated on this machine, in a started chat tab `ap-1` (see [ACP chat session](./acp-chat-session.md)).
- `node $C req jsonClaude:setPermissionMode ap-1 default` returned `true`.
- `$WT/pong.txt` does not exist.

- **Trigger.** Ask for a file edit. Run `node $C signal jsonClaude:send ap-1 "Create a file named pong.txt in the current directory containing exactly the word pong. Use your file-writing tool, not a shell command."` then `node $C wait jsonClaude.pendingApprovals 'Object.keys(v).length > 0' --timeout 120000 --save approval-pending`. One approval exists with `sessionId: "ap-1"` and a `toolName` such as `edit`.
- **Allow.** Resolve it and wait for the turn. Run `RID=$(node $C get jsonClaude.pendingApprovals | node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0)))[0]')`, `node $C req jsonClaude:resolveApproval "$RID" '{"behavior":"allow"}'`, `node $C wait jsonClaude.sessions.ap-1 '!v.busy' --timeout 120000`. `node $C get jsonClaude.pendingApprovals` is `{}` and `cat "$WT/pong.txt"` prints `pong`.
- **Reject.** Ask for a second file and reject. Send `"Create pong2.txt containing pong."`, wait for the approval, run `node $C req jsonClaude:resolveApproval "$RID" '{"behavior":"deny","message":"not now"}'`, wait for `!v.busy`. `$WT/pong2.txt` does not exist and `node $C req jsonClaude:getEntries ap-1 --save approval-entries` ends with an `assistant` entry acknowledging the rejection.
- **Always.** Grant the kind for the session and repeat. Run `node $C req jsonClaude:grantSessionToolApprovals ap-1 '["edit"]'`, send `"Create pong3.txt containing pong."`, wait for `!v.busy` with `--timeout 120000`. No approval appeared (`node $C get jsonClaude.pendingApprovals` stays `{}` during the turn) and `$WT/pong3.txt` exists.
- **Proof.** `approval-pending.json`, `approval-entries.json`, and `ls $WT` showing `pong.txt` and `pong3.txt` but not `pong2.txt`.

## Gotchas

- Without working agent credentials no tool call ever happens and the wait times out. Report the whole feature as not run with the credential reason; do not substitute a Claude tab, which uses a different runtime.
- The settings default permission mode is `acceptEdits`, which auto-allows `edit` kinds. Set `default` first or the card never appears.
- Grants are keyed on the ACP tool kind (`edit`, `execute`, `read`, …), not the per-call title. A grant on `edit` does not cover a shell command.
- Approvals are cancelled when the session is interrupted, killed, or the agent exits; a `pendingApprovals` entry that vanishes without a resolve means the agent died. Check `node $C log 40`.
