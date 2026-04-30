# Phase 5 Verification

Completed: 2026-04-30

## Implementation Summary

- Added `frontend/src/utils/imeTransaction.ts` as the IME transaction state machine.
- `TerminalView` now tracks `idle -> composing -> committing -> settling -> idle` without creating input sequence ranges.
- `xterm.onData` remains the source of truth for committed text. Composition metadata is attached only as `compositionSeq`/length telemetry.
- `repairLayout`, `restoreSnapshot`, and `replaceWithSnapshot` wait for IME idle before applying transient repair/restore work.
- Snapshot and repair waits survive an immediate next composition and apply only after the newer composition settles; generation/dispose changes still cancel waits.
- Transient capture close/replay barriers record `ime_capture_close_deferred` while keeping helper textarea input capture open.
- Guarded fallback is observe-only. Missing xterm data records `ime_commit_without_xterm_data` and `ime_fallback_observed`; it does not transmit committed text.
- Added a local-only debug repair hook to exercise IME repair deferral in Playwright without changing UI.

## Verification Checklist

- [x] IME state transitions through `idle -> composing -> committing -> settling -> idle`.
- [x] Composition during transient capture barrier records `ime_capture_close_deferred` and keeps helper textarea enabled.
- [x] Composition during repair layout records `ime_repair_deferred` and repair runs after `ime_settled`.
- [x] Fast `compositionend -> compositionstart` retargets pending repair/snapshot work to the newer composition instead of running during composition.
- [x] Closed/error/session/auth/workspace generation changes cancel IME waits instead of flushing queued input.
- [x] Final xterm data before `compositionend` is treated as a native commit and does not trigger fallback.
- [x] IME timers are guarded by active `compositionSeq` and `sessionGeneration`.
- [x] Fast `compositionend -> compositionstart` does not let an older settle timer idle the newer composition.
- [x] Fallback remains observe-only by default.
- [x] Synthetic Space/Backspace/repair/capture-close IME E2E tests pass.
- [ ] Real Windows Korean IME manual validation: carried to Phase 6 because it requires human keyboard/IME validation.

## Tests Run

- `npm --prefix frontend run build` - PASS
- `npm --prefix server run build` - PASS
- `npm --prefix server run test` - PASS, 176 tests
- `node --import ./server/node_modules/tsx/dist/loader.mjs --test ./frontend/tests/unit/imeTransaction.test.ts` - PASS, 7 tests
- `node --import ./server/node_modules/tsx/dist/loader.mjs --test ./frontend/tests/unit/terminalInputSequencer.test.ts` - PASS, 2 tests
- `npx playwright test tests/e2e/terminal-korean-ime.spec.ts --project="Desktop Chrome" --workers=1` - PASS, 6 tests
- `npx playwright test tests/e2e/terminal-keyboard-regression.spec.ts --project="Desktop Chrome" --workers=1` - PASS, 13 tests
- `npx playwright test tests/e2e/terminal-paste.spec.ts --project="Desktop Chrome" --workers=1` - PASS, 2 tests
- `npm run test:docs` - PASS, 4 tests
- `git diff --check` - PASS

Note: an earlier keyboard regression attempt was run at the same time as paste verification and left a stale Vite process after the HTTPS test server exited. The final keyboard regression result above is the isolated rerun after cleaning only the stale project Vite process.

## Review

- Status: No findings.
