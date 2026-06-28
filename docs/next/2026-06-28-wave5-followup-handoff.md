# Wave5 Follow-up Handoff

Date: 2026-06-28

## Purpose

This note is a next-session handoff for the Wave5 shutdown cleanup evidence work. It records what has already been implemented and the remaining review findings that should be handled before treating Wave5 as fully hardened.

Source documents:

- `docs/research/2026-06-27.buildergate-wave5-shutdown-evidence-soak-plan.md`
- `docs/research/plug-leak/wave5.md`
- `docs/plans/2026-06-28.projectmaster.bgwave5.plan.md`
- `docs/research/2026-06-28.buildergate-wave5-implementation-report.md`
- `docs/spec/30.buildergate-stability.srs.md`

## Current State

Wave5 implementation is present in the working tree.

Implemented:

- `performGracefulShutdown()` returns shutdown session cleanup evidence and performs first/final workspace flushes.
- `/api/internal/shutdown` returns the graceful shutdown result with workspace and session cleanup evidence.
- `SessionManager` separates verified and unverified remaining cleanup details in telemetry and batch termination results.
- `stop-client.js` validates shutdown session cleanup evidence before health nonresponse verification.
- Default daemon stop fails on `remainingVerifiedDescendants > 0`, warns on degraded/skipped-unverified cleanup, and supports strict failure through `strictSessionCleanupEvidence`.
- `REL-BGSTAB-002` is recorded as implemented with test, review, static-scan, and remaining-validation evidence.
- Live/server-only soak and long-duration browser validation are explicitly recorded as remaining operational validation, not completed coverage.

Validation already run:

| Command | Result |
| --- | --- |
| `npm --prefix server test` | Passed, 290 tests |
| `npm run test:daemon:wave5` | Passed, 55 tests; includes process-info, stop-client, sentinel, broad-kill guard, and native stop integration checks |
| `speckiwi --root . validate --fail-on-warning --json` | Passed, 0 errors / 0 warnings |
| `git diff --check` | Passed, CRLF warnings only |
| Static broad-kill scan | Passed, no prohibited runtime patterns found |

Current worktree caution:

- There are unrelated frontend/recovery changes in the working tree. Do not revert them while handling Wave5 follow-up work.
- Keep Wave5 changes scoped to server shutdown, daemon stop, tests, and documentation unless the user explicitly expands scope.

## Follow-up Resolution

Resolution date: 2026-06-28

- MED-1 was resolved by carrying the effective per-call cleanup mode into session finalization and cleanup telemetry.
- MED-2 was resolved by adding `tools/daemon/no-broad-kill.test.js` and `npm run test:daemon:wave5`.
- LOW-1 was resolved by re-reading final workspace JSON after `flush-2` and asserting `lastCwd` preservation.
- LOW-2 was resolved by adding a post-implementation traceability note to the Wave5 research plan.
- A broader `node --test tools/daemon/*.test.js` run still depends on packaged README artifacts for `tools/daemon/docs.test.js`; the Wave5-related native stop integration failure from missing session cleanup evidence was fixed and its focused integration file now passes.

## Resolved Findings

### MED-1: Per-call cleanup mode override can be hidden by runtime `legacy`

Status: resolved

Severity: Medium

Relevant code:

- `server/src/services/SessionManager.ts`
- `server/src/services/gracefulShutdown.ts`
- `server/src/test-runner.ts`

Situation:

- `performGracefulShutdown()` accepts `sessionCleanupMode` and passes it to `terminateAllSessions()`.
- `terminateSession()` uses `options.mode` to decide whether to run enforce cleanup.
- `recordCleanupObservation()` still branches on `this.runtimeSessionConfig.processCleanup.mode`.
- If runtime config is `legacy` but a caller explicitly passes `sessionCleanupMode: 'enforce'`, enforcement can run while telemetry records `not-started` with zero verified/unverified remaining counts.
- This is not the default shutdown path because Wave5 intentionally preserves the runtime default. It affects strict or override shutdown validation.

Impact:

- A strict/override shutdown run could mask verified remaining owned PIDs in evidence.
- `remainingVerifiedDescendants` may be reported as 0 even though the enforce terminator returned remaining verified PIDs.

Recommended fix:

1. Add an effective cleanup mode to the finalization/recording path.
   - Add `cleanupModeOverride?: SessionProcessCleanupConfig['mode']` or equivalent to `SessionFinalizerOptions`.
   - Pass the effective `mode` from `terminateSession()` into `finalizeSession()`.
   - Make `recordCleanupObservation()` use the effective mode for the legacy branch decision.
2. Do not change the default runtime cleanup mode.
3. If `cleanupOverride` exists, do not discard it only because runtime mode is `legacy`.
4. Add a regression test:
   - Runtime config: `processCleanup.mode = 'legacy'`.
   - Call `terminateAllSessions({ reason: 'shutdown', mode: 'enforce' })`.
   - Fake terminator returns a degraded result with `remainingPids`.
   - Assert batch result includes `remainingVerifiedDescendants > 0` and cleanup telemetry does not record `not-started`.

Acceptance target:

- Per-call `mode: 'enforce'` produces enforce cleanup evidence even when runtime default is `legacy`.
- Default shutdown with no `sessionCleanupMode` still follows runtime config unchanged.

### MED-2: No-broad-kill policy is not enforced by a checked-in static guard

Status: resolved

Severity: Medium

Relevant files:

- `tools/daemon/stop-client.test.js`
- `tools/daemon/sentinel.test.js`
- `server/src/utils/processTreeTerminator.ts`
- `package.json`

Situation:

- Current tests verify injected `killProcess` is not called in key stop failure paths.
- Manual static search found no prohibited patterns.
- However, checked-in test commands do not include a static guard that would catch a direct broad-kill command added outside the injected `killProcess` path.

Prohibited patterns:

- `taskkill /IM`
- `killall`
- `Stop-Process`
- process-name based `node.exe` termination in stop/shutdown paths
- shell-constructed broad kill fallback

Allowed existing path:

- `taskkill.exe /PID <verifiedRootPid> /T /F` in `DefaultProcessTreeTerminator`, because it is verified PID based and does not use `/IM`.

Recommended fix:

1. Add a small checked-in guard test or script.
   - Prefer a Node test such as `tools/daemon/no-broad-kill.test.js`.
   - Scan production runtime files only, not docs or tests.
   - Include at least:
     - `server/src/services`
     - `server/src/utils/processTreeTerminator.ts`
     - `tools/daemon`
     - `stop.bat`
     - `start.bat`
   - Exclude known test fixtures and documentation.
2. Assert prohibited regexes are absent.
3. Allow the exact verified-PID `taskkill.exe` path.
4. Add the guard to the Wave5 daemon verification command or the relevant npm script.

Acceptance target:

- A direct `taskkill /IM node.exe`, `killall`, `Stop-Process`, or stop-path process-name kill addition fails an automated check.
- Existing verified PID termination continues to pass.

### LOW-1: Final workspace flush CWD preservation is not asserted after session cleanup

Status: resolved

Severity: Low

Relevant file:

- `server/src/test-runner.ts`

Situation:

- `testPerformGracefulShutdownTerminatesSessionsAfterWorkspaceFlush()` confirms the first workspace flush contains `lastCwd` before the CWD temp file is removed.
- The same test confirms the final flush happens after termination.
- It does not re-read the workspace JSON after the final flush to assert `lastCwd` is still preserved.

Impact:

- A regression that clears `lastCwd` between termination and final flush could slip through the current test.
- Current implementation appears correct, but the test does not fully lock the invariant.

Recommended fix:

1. In `testPerformGracefulShutdownTerminatesSessionsAfterWorkspaceFlush()`, after `performGracefulShutdown()` returns, read `workspaceFilePath` again.
2. Assert:
   - `file.state.tabs[0].lastCwd === cwd`
   - `flushCount === 2`
   - event order remains `stop-watchers -> snapshot -> flush-1 -> terminate:shutdown -> flush-2`
3. Keep the test focused; no production code change is expected unless the test exposes a bug.

Acceptance target:

- The test proves CWD is preserved both before termination and after the final shutdown flush.

### LOW-2: Pre-implementation research traceability still points only to `REL-BGSTAB-001`

Status: resolved

Severity: Low

Relevant docs:

- `docs/research/2026-06-27.buildergate-wave5-shutdown-evidence-soak-plan.md`
- `docs/spec/30.buildergate-stability.srs.md`
- `docs/plans/2026-06-28.projectmaster.bgwave5.plan.md`
- `docs/research/2026-06-28.buildergate-wave5-implementation-report.md`

Situation:

- The pre-implementation research plan says Wave5 should be traced through `REL-BGSTAB-001`.
- The final implemented SRS, plan, and report use `REL-BGSTAB-002`, with `REL-BGSTAB-002` extending `REL-BGSTAB-001`.
- This does not break validation, but it can confuse a future audit.

Recommended fix:

1. Add a short post-implementation note to the research plan.
2. State that the initial `REL-BGSTAB-001` traceability plan was superseded by `REL-BGSTAB-002`.
3. Clarify that `REL-BGSTAB-002` remains a reliability requirement, does not create `FR-BGSTAB-013`, and extends `REL-BGSTAB-001`.
4. Keep the original research conclusion visible rather than rewriting history silently.

Acceptance target:

- A reader can follow Wave5 from research plan to `REL-BGSTAB-002` without thinking the final implementation ignored the research.

## Follow-up Verification Order

Run verification:

```powershell
npm --prefix server test
npm run test:daemon:wave5
node --test tools/daemon/native-daemon.integration.test.js
speckiwi --root . validate --fail-on-warning --json
git diff --check
```

## Do Not Do In The Next Session

- Do not change frontend runtime, UI, split WebSocket, browser worker, or Settings UI as part of these follow-ups.
- Do not force `session.processCleanup.mode` default to `enforce`.
- Do not add broad kill fallback.
- Do not claim live PowerShell/bash/WSL soak or long-duration browser memory validation as completed unless it is actually run and recorded.
- Do not revert unrelated frontend/recovery work already present in the worktree.

## Residual Operational Validation

These remain outside automated Wave5 completion and should stay documented as remaining until actually run:

- Repeated create/delete tab with PowerShell through `https://localhost:2222`.
- Repeated create/delete tab with bash or WSL where available.
- Restart tab loop with process descendant inspection.
- High-output server soak with queue baseline comparison through `/api/sessions/telemetry`.
- Live direct session delete and orphan recovery check.
- Long-duration browser memory/input-lag validation.
