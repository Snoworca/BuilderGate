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

## Correction: `sessionGeneration: 2` was a red herring

Earlier notes here (and the report that went with them) treated `sessionGeneration: 2` in the
`ws_input_sent` client debug events as a lead -- evidence that something bumped a generation
counter mid-flood. A control measurement disproves that: `raw/before-fix-target-was-server-error`
and every later capture create their session through `page.reload()`, and `sessionGeneration` is
a purely client-local `useRef(1)` in `TerminalContainer.tsx`, bumped only by
`bumpSessionGeneration()` (reasons: `reconnect-ttl-expired`, `ws-disconnected`,
`session-id-changed`) -- none of which fired in any capture (`input_session_generation_bumped`
never appears in `allEvents`). A control run with a trivial 10-line flood that did NOT reproduce
the lockup still showed `sessionGeneration: 2` in its `ws_input_sent` events
(`raw/control-tiny-flood` was not archived, but is reproducible: any fresh session created via
this script's own `page.reload()` starts at 2). The bump happens during the page's initial
connection handshake, before the measurement's `clear()`/`enable()` call, and is unrelated to the
flood or to `target-identity-stale`. This is a correction to what was reported earlier, not new
information layered on top of it.

## Root cause, measured: headless shadow-PTY queue overflow silently revokes the mutation lease

Added a server-side diagnostic (`SessionManager.acceptRetainedTerminalMutationIdentity`, event
kind `mutation_identity_rejected`, read via the existing `GET/POST
/api/sessions/debug-capture/:id` routes -- a SEPARATE store from
`window.__buildergateTerminalDebug`, which only sees client-side events) and re-measured.
`raw/root-cause-instrumented-run1.json` shows four `mutation_identity_rejected` events, all
identical:

```
cause: 'field-mismatch', admissionMode: 'none', driverActive: 'null', responderActive: 'null',
authorityEpochMatch: true, clientRegistered: true, clientViewGenerationMatch: true,
hasSuspendedBrowserDriver: false, legacyDriverLeaseActive: false, legacyDriverIdentityMatch: false
```

The client's identity is NOT stale in the sense of a mismatched epoch or view generation --
`authorityEpochMatch` and `clientViewGenerationMatch` are both `true`. The rejection happens
because `acceptRetainedTerminalMutationIdentity` (`SessionManager.ts:3263`) requires an ACTIVE
driver lease (legacy `retained.driverLease.state === 'active'`, or a server-authority
`suspendedBrowserDriver` match) on top of that identity match, and neither exists: `admissionMode`
is `'none'` (not even the shadow-mode default of `'legacy'`), and both `driverActive` and
`responderActive` are `null`.

Immediately before these four rejections, the same capture shows `headless_degraded` with
`phase: 'queue-overflow'`, then `snapshot_requested` / `snapshot_fallback_degraded`. Tracing
`markHeadlessDegraded()` (`SessionManager.ts:8808`, called from the queue-overflow site at
`SessionManager.ts:8080`) shows it unconditionally tears down the session's authority state when
the server's HEADLESS shadow-PTY (a second, server-only PTY instance that exists purely to
maintain reconnect-recoverable retained state, separate from the primary PTY the user's keystrokes
actually reach) cannot keep up with output volume and its queue overflows:

```
authorityRuntime.admission.mode = 'none';
authorityRuntime.driver.active = null;
authorityRuntime.driver.activeLeaseId = null;
authorityRuntime.responder.active = null;
authorityRuntime.responder.activeLeaseId = null;
```

It also revokes the active driver/responder lease ids and calls
`disposeTerminalAuthorityRuntimeForSession`. **No wire message tells the client this happened.**
The client keeps attaching its now-invalid `retainedIdentity` (built from the lease it believes it
still holds, per `attachRetainedMutationLease` in
`frontend/src/utils/terminalCheckpointRuntime.ts`) to every keystroke, and the server correctly
refuses each one, forever, until something re-negotiates a lease the client has no reason to know
it needs.

The same queue-overflow path also calls `startDegradedReplayRecovery()`
(`SessionManager.ts:8983`), which calls `wsRouter.refreshReplaySnapshots(sessionId, { origin:
'degraded', ... })` -- pushing the client into a resync/repair cycle. This is very likely the
same event that produces the `visible-output-recovery` barrier stall described below: one
`queue-overflow` event, two client-visible symptoms (a resync push that may or may not complete,
and a silently revoked lease that blocks every keystroke once it does).

This also explains why "large retained scrollback" was the common factor across all three
observations team-lead noted (this flood, the other two flood runs, and the unrelated 41-hour-old
session): the headless shadow-PTY's queue overflows relative to how much retained state it is
already carrying and how fast output arrives, not specifically because a "flood" script sent
15,000 lines. A flood is just the fastest way to reach the same queue-overflow condition that
size and age reach independently.

This is squarely the retained-terminal authority side (`SessionManager.ts`'s shadow/driver-lease
bookkeeping), not the input-reliability/ledger path (`SessionInputGateway`, the input sequencer,
the dedup ledger) that #18's lane built -- no handoff needed.

## Fixed: (b) then (a), decided by team-lead 2026-09-19

Decision: (b) is the real fix, in a precise form -- do not remove the lease *requirement* from
`acceptRetainedTerminalMutationIdentity` (single-writer discipline is worth keeping), only stop
headless degradation from revoking the driver lease it never held. (a) is required regardless,
not as a fallback, because a lease can legitimately be revoked for other reasons and the client
must always be told. (c) (raise the queue capacity) was rejected as a fix -- it changes how often
the defect fires and nothing else.

**(b)** -- `detachTerminalAuthorityRuntime` (`SessionManager.ts`) captures
`runtime.driver.active === 'server-headless'` at detach time and only revokes
`retained.driverLease` (the legacy browser lease) when that is true. Measured: when
`markHeadlessDegraded` calls it, `driver.active` has already been nulled by
`markHeadlessDegraded`'s own preceding code, so this branch was never reachable via that path in
the first place -- the fail-closed revocation only fires for a genuine server-headless authority
detach (session finalization, factory-registration rollback), where it is still correct.

**(a)** -- a new wire message, `terminal-checkpoint:lease-revoked`, sent via
`WsRouter.notifyRetainedTerminalDriverLeaseRevoked(sessionId, clientId, reason)` to the one
connection that held the lease (not broadcast to every session subscriber), fired from both real
revocation sites: the `wasServerHeadlessDriver` branch above, and
`revokeTerminalAuthorityDriverLease` (the MIG-BGSTAB-002 admin-triggered revocation, a second,
independent silent-revocation path found while fixing this). The client clears its cached lease
for that session and calls `requestCurrentTerminalCheckpointCapability()` to renegotiate
immediately, rather than waiting for the next `session:ready` or reconnect.

**Re-measured after the fix: 3/3 flood runs, zero rejections, zero gate stalls.**
`raw/after-fix-run{1,2,3}-clean.json` -- same 15,000-line flood, same probe. All three: `ws_input_sent`
fires, the probe echoes back within ~0.4s of being sent, no `server_input_rejected`, no
`terminal_input_rejected`, and `input_gate_synced` never reports `barrierReason:
'visible-output-recovery'` sticking. This settles the open question below: the server rejection and
the client-side gate stall were one event with two faces, not two independent defects -- both
symptoms disappeared together once the headless queue-overflow stopped revoking the lease.

## A second, more frequent symptom, found while re-measuring -- resolved by the same fix, see above

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
