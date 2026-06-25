# Wave1 Review-Fix Loop Report

- Target: `0.5.5-buildergate-stability`
- Requirement: `FR-BGSTAB-009`
- Plan: `docs/plans/2026-06-25.projectmaster.bgwave1.plan.md`
- Date: 2026-06-25

## Scope

Wave1 implements observe-only session process cleanup telemetry:

- `session.processCleanup` schema defaults and strict validation
- session process metadata capture without terminal input/output
- bounded cleanup telemetry in `SessionManager.getObservabilitySnapshot()`
- explicit cleanup reasons for direct, tab, workspace, restart, and process-exit paths
- regression tests for observe-only cleanup and telemetry behavior

## Automated Verification

Red evidence:

- `npm --prefix server run build`
- Result: failed before implementation because `session.processCleanup` did not exist on parsed session config.

Green evidence:

- `npm --prefix server run build`
- Result: passed.
- `node --test server/dist/schemas/config.schema.test.js server/dist/utils/configTemplate.test.js`
- Result: 11 tests passed.
- `npm --prefix server test`
- Result: 229 tests passed.
- `node C:\Users\beom\.codex\skills\kiwi-planner\scripts\validator.mjs docs\plans\2026-06-25.projectmaster.bgwave1.plan.md docs\plans\2026-06-25.projectmaster.bgwave1.sidecar.json --target 0.5.5-buildergate-stability --inventory-file docs\analysis\kiwi-planner-2026-06-25.projectmaster.buildergate-wave1\inventory.json --out docs\plans\2026-06-25.projectmaster.bgwave1.validator.json`
- Result: 0 errors, 0 warnings.

## Review Findings And Fixes

Reviewer Rawls found two actionable issues:

1. The first implementation fabricated `osStartIdentity` from `platform:pid:launchedAt` and the default inspector treated PID-only data as verified. This was fixed by leaving `osStartIdentity` as `null` unless a real OS identity is available and making the default inspector return `skipped-unverified`.
2. The bounded `cleanupRecordedSessionIds` set could theoretically allow a very late PTY `onExit` callback to double-count after set eviction. This was fixed by adding a per-`SessionData` `cleanupRecorded` flag that remains visible to the closure captured by `onExit`.

Additional regression tests were added:

- `SessionManager does not double-count delete followed by process exit`
- `SessionManager default cleanup inspector skips unverified observations`

## Final Re-Review

Reviewer Erdos returned `No findings`.

Summary:

- Default cleanup inspection now reports `skipped-unverified` rather than fabricating OS identity.
- Delayed `onExit` after explicit delete does not double-count, even if the bounded ID set is cleared or evicted.
- Delete reasons, observe-only behavior, telemetry shape, and config defaults were reviewed.
- `npm --prefix server test` passed with 229 tests.

## Status

Complete. No force-kill or broad process-name kill path was introduced.
