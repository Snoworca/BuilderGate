# #112 — flood-triggered input rejection, reason-precision measurement

Read-only Playwright measurement script (`measure-flood-input-gate.mjs`) that floods a fresh
session with N lines, waits for the flood to confirm in the viewport via
`window.__buildergateTerminalDebug.captureTerminalText`, then sends a probe command and
samples `readInputGateSnapshot` every ~300ms while collecting the full debug event log. The
workspace it creates is deleted by the script itself on exit; it never touches `Workspace-1`.

Usage: `node measure-flood-input-gate.mjs <floodCount> <outFile>` from `frontend/`, with
`BUILDERGATE_PASSWORD` set in the environment. Requires the 2222 lane to be empty first
(`ss -tn | grep -c ':2222 '` == 0).

The script imports `@playwright/test`, which Node's ESM resolver looks for starting from the
script's OWN directory upward -- so running it in place from here throws
`ERR_MODULE_NOT_FOUND` (there is no `docs/analysis/**/node_modules`). Copy it into `frontend/`
for the run and delete the copy afterward; do not leave a permanent duplicate there. The
canonical copy stays here.

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
- `raw/after-split-fix-run2-target-identity-stale.json` — after `SessionManager.writeInput`'s
  two `TARGET_NOT_LIVE`-producing branches were split into distinct codes/wire reasons
  (`target-session-gone` for `!data`, `target-identity-stale` for
  `acceptRetainedTerminalMutationIdentity` refusing). `ws_input_sent` fires twice at t=10.25s,
  and both are answered by `server_input_rejected reason: 'target-identity-stale'` at t=10.26s.
  This converts the mutation-identity hypothesis from inference to measurement: the session was
  not gone, this specific client's retained-terminal identity was.
- `raw/after-split-fix-run1-client-gate-stall.json`,
  `raw/after-split-fix-run3-client-gate-stall.json` — two of the three post-split-fix runs did
  NOT reproduce the server-rejection path at all. See "A second, more frequent symptom" below.

## What this settles and what it does not

Settled: the loss is not the network (the browser's send is confirmed via `ws_input_sent` when
it gets that far). When the write does reach `SessionInputGateway`, the server explicitly
refuses it, and as of the split-fix measurement the specific reason is
`acceptRetainedTerminalMutationIdentity` rejecting a stale retained-terminal mutation identity
(`target-identity-stale`), not a gone session (`target-session-gone` was never observed). This
matches the earlier `sessionGeneration: 2` anomaly noted in the pre-split raw captures -- some
generation bump happens mid-flood that the client's held identity does not survive.

Not yet settled, and now sharper than before: WHY the retained-terminal identity goes stale
mid-flood (what bumps `authorityEpoch`/`viewGeneration`/`leaseGeneration` during a plain output
flood with no client-side reconnect or view change), and the relationship between that and the
second symptom below.

## A second, more frequent symptom, found while re-measuring (not yet triaged)

Three post-split-fix runs of the identical 15,000-line flood + probe did NOT all reproduce the
same failure. Two of three (`run1`, `run3`) never reached the server at all: the client's own
input gate stayed `captureState: 'transient-blocked'`, `barrierReason: 'visible-output-recovery'`
from a single `input_gate_synced` event onward (~t=16s) with no further gate-state event for the
rest of the run, and the probe keystroke sat in the client-side queue until a client-side
`timeout-enter-safety` rejected it locally (`terminal_input_rejected`, ~30s after being queued) --
`ws_input_sent` never fired. Only one of three (`run2`) reached the server and produced the
`target-identity-stale` result described above.

`visible-output-recovery` is an existing, deliberate mechanism
(`frontend/src/utils/visibleOutputRecovery.ts`), not something introduced by this round's
changes -- it appears to hold new input until the client judges the visible screen has caught up
with a large output burst. Under this exact 15,000-line workload it did not resolve within the
probe's 60s window in 2 of 3 runs. Whether this is the SAME underlying cause manifesting two
ways, a separate pre-existing bug that also matches #112's user-facing symptom ("terminal
permanently stops accepting input"), or expected behavior under load that the probe's timeout is
simply too short for, is not established by this measurement and needs a decision before further
work.
