# P0 Native Performance Implementation Evidence

Date: 2026-07-03
Target: 0.5.5-buildergate-stability
Plan: `docs/plans/2026-07-03.projectmaster.p0-native-perf.plan.md`

## Implemented Scope

- PERF-BGSTAB-001: visible output scheduler now drains multiple chunks within a per-frame time budget, preserves UTF-8 boundary safety, yields on pending input, and exposes a 7 ms default frame budget.
- PERF-BGSTAB-002: `SessionManager.createSession` no longer calls the synchronous `readProcessStartIdentitySync`; process start identity capture is scheduled asynchronously and late/failed capture falls back to unverified cleanup behavior.
- PERF-BGSTAB-003: input debug metadata can be computed once and reused downstream; `TextEncoder` and `Intl.Segmenter` are module singletons; high-cost payload details can be skipped when capture is disabled.
- PERF-BGSTAB-004: terminal output byte-length calculation uses a singleton `TextEncoder`; output resource limits are cached until `runtimeConfigVersion` changes.
- FR-BGSTAB-019: `server/config.json5` currently contains `session.processCleanup.mode: "enforce"` with an inline observe rollback comment, and schema default remains `observe`. This file is local/ignored; tracked bootstrap activation is not complete because the soak gate did not pass in this run.

## Automated Verification

- `node .agents\skills\kiwi-planner\scripts\validator.mjs docs\plans\2026-07-03.projectmaster.p0-native-perf.plan.md docs\plans\2026-07-03.projectmaster.p0-native-perf.sidecar.json --target 0.5.5-buildergate-stability --inventory-file docs\analysis\kiwi-planner-2026-07-03.projectmaster.p0-native-perf\inventory.json --out docs\plans\2026-07-03.projectmaster.p0-native-perf.validator.json --check-files --dry-run`
  - Result: pass, 27 checks, 0 warnings, 0 errors.
- `node --experimental-strip-types --test tests\unit\terminalOutputScheduler.test.ts`
  - Result: pass, 12/12.
- `node --experimental-strip-types --test tests\unit\terminalInputSequencer.test.ts`
  - Result: pass, 5/5.
- `node --experimental-strip-types --test tests\unit\runtimeConfig.test.ts`
  - Result: pass, 12/12.
- `node --experimental-strip-types --test tests\unit\terminalHiddenOutput.test.ts`
  - Result: pass, 10/10.
- `node --experimental-strip-types --test tests\unit\terminalViewRecoveryContract.test.ts`
  - Result: pass, 5/5.
- `npm run typecheck` in `frontend`
  - Result: pass.
- `npm run build` in `frontend`
  - Result: pass; Vite reported the existing large chunk warning.
- `npm test` in `server`
  - Result: pass; build plus server test-runner completed successfully.

Follow-up fixes after sub-agent review:

- PERF-BGSTAB-003: added `clientObservedMetricsSkipped` metadata so debug-disabled frontend input can preserve sequence metadata without recomputing byte/grapheme metrics in `TerminalInputSequencer`.
- PERF-BGSTAB-004: switched `TerminalView` visible output scheduler setup to `getCachedTerminalOutputResourceLimits()` and added a source-level regression in `terminalViewRecoveryContract.test.ts`.
- FR-BGSTAB-019: replaced the ignored local-config assertion with a reproducible temp-config loader test that proves `enforce` and `visibleFlushBudgetBytes: 262144` overrides work while schema omission remains `observe`.

## Full Frontend Unit Sweep

Command:

`$unitTests = Get-ChildItem -Path tests\unit -Filter *.test.ts | Sort-Object FullName | ForEach-Object { $_.FullName }; node --experimental-strip-types --test @unitTests`

Result:

- 198 total
- 192 passed
- 6 failed

The 6 failures are all existing recovery-option source-scanning tests outside this P0 performance scope:

- `tests/unit/recoveryOptionDialog.test.ts`: AC-1 desktop Tools menu opens recovery option dialog
- `tests/unit/recoveryOptionDialog.test.ts`: E2E repeatable default icons
- `tests/unit/recoveryOptionDialog.test.ts`: matched icon data reaches tab metadata display paths
- `tests/unit/recoveryOptionIcon.test.ts`: built-in recovery icon keys render through allowlist
- `tests/unit/recoveryOptionIcon.test.ts`: text icons render as text data
- `tests/unit/recoveryOptionIcon.test.ts`: unsupported persisted icons are omitted

No P0 performance files or tests were involved in those failures.

## Live Validation Probe

Target: `https://localhost:2222`

Health:

- `curl.exe -k https://localhost:2222/health`
- Result: HTTP body reported `status: "ok"` from PID 67440.

Operational restart attempt:

- `.\stop.bat`
  - Result: `[stop] BuilderGate daemon is not running.`
- `.\start.bat --port 2222`
  - Result: exit 1.
- Runtime state after start attempt:
  - `runtime/buildergate.daemon.json` reported `status: "fatal"`, `fatalReason: "readiness identity mismatch"`.
  - `netstat -ano` showed port 2222 still bound by old PID 67440.

Because the managed stop path could not stop the stale listener, no broad `node.exe` termination was attempted.

5 MiB terminal output probe:

- A Playwright one-off probe logged in, created disposable `BG-PERF-*` workspaces, started terminal debug capture, and sent a PowerShell command that writes 5 MiB to the active terminal followed by a split completion marker.
- Result: the completion marker did not become visible within 180 seconds.
- Cleanup: three `BG-PERF-*` workspaces created by failed probes were deleted through the API.

Cleanup telemetry after probe cleanup:

- Running server telemetry still reported `cleanup.mode: "observe"`, confirming the live process had not picked up the edited config.
- Recent cleanup results for the disposable sessions had `cleanupStatus: "skipped-unverified"` and `verifiedRemainingDescendants: 0`.

## Soak Gate Status

Not executed:

- 2 hour multi-session enforce-mode soak required by FR-BGSTAB-019 AC-3.
- 54-session round-robin input/output soak from research section 6.
- True keydown-to-echo p99 under 54-session load from research section 6.

Reason:

- The managed runtime could not be restarted into the new config because the stale PID 67440 continued serving port 2222 and `stop.bat` did not recognize it as a running daemon.
- The live 5 MiB replay probe did not complete within 180 seconds, which is consistent with the research note that P0-1 removes one throttle but the later renderer work remains necessary for the full throughput target.

## Completion Status

- PERF-BGSTAB-001, PERF-BGSTAB-002, PERF-BGSTAB-003, and PERF-BGSTAB-004 have automated coverage and passed focused verification.
- FR-BGSTAB-019 is not complete because AC-3 requires the 2 hour multi-session soak before tracked operational activation is treated as committed.
- The complete frontend unit suite is not green due to the unrelated recovery-option tests listed above.
