# #112 — flood-triggered input rejection, reason-precision measurement

Read-only Playwright measurement script (`measure-flood-input-gate.mjs`) that floods a fresh
session with N lines, waits for the flood to confirm in the viewport via
`window.__buildergateTerminalDebug.captureTerminalText`, then sends a probe command and
samples `readInputGateSnapshot` every ~300ms while collecting the full debug event log. The
workspace it creates is deleted by the script itself on exit; it never touches `Workspace-1`.

Usage: `node measure-flood-input-gate.mjs <floodCount> <outFile>` from `frontend/`, with
`BUILDERGATE_PASSWORD` set in the environment. Requires the 2222 lane to be empty first
(`ss -tn | grep -c ':2222 '` == 0).

## Raw captures

- `raw/before-fix-target-was-server-error.json` — HEAD before the #112 reason-fix. 15,000-line
  flood at commit-time state: input gate stays `inputReady: true` / `captureState: 'open'` for
  the entire post-flood window, `ws_input_sent` fires (browser sent it), and 20ms later
  `server_input_rejected` answers `reason: 'server-error'` — the router's old mapping
  collapsing every `SessionInputGateway` denial except `INPUT_REJECTED_REPLAY_PENDING` into one
  opaque label.
- `raw/after-fix-target-not-live.json` — same flood size, same steps, after `WsRouter.ts`'s
  `mapSessionInputGatewayDenialToRejectedReason` fix landed and the server was rebuilt +
  restarted. Same lockup (this fix does not resolve the underlying defect, only names it):
  `server_input_rejected` now answers `reason: 'target-not-live'`.

## What this settles and what it does not

Settled: the loss is not the client-side input gate (stays open throughout) and not the
network (the browser's send is confirmed via `ws_input_sent`). The server explicitly refuses
the write with `SessionInputGateway`'s `TARGET_NOT_LIVE` code, meaning the write never reached
the PTY.

Not yet settled: which of `TARGET_NOT_LIVE`'s two possible origins in
`SessionManager.writeInput` is the actual one here -- the session lookup (`!data`, considered
unlikely since the session's own buffer keeps updating throughout) or
`acceptRetainedTerminalMutationIdentity` refusing the write (a mutation-identity/authority-lease
check that is only live when the session's retained-terminal mode is `'shadow'`, which this
measurement did not directly confirm one way or the other). That is the next measurement, not
this one.
