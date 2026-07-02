# Code Context

Frontend:

- `frontend/src/components/Terminal/TerminalContainer.tsx:131` defines `FALLBACK_EMPTY_MESSAGE`.
- `frontend/src/components/Terminal/TerminalContainer.tsx:1399-1446` handles fallback snapshots. Empty fallback first tries local restore, then applies the placeholder if restore fails.
- `frontend/src/components/Terminal/TerminalContainer.tsx:1476-1494` sends `screen-snapshot:ready` and only finishes visible recovery when snapshot recovery succeeded.
- `frontend/src/components/Terminal/TerminalView.tsx:1260-1320` restores/replaces snapshots and writes data to xterm.

Server:

- `server/src/services/SessionManager.ts:2147-2152` creates fallback snapshots when headless health is degraded or headless is unavailable.
- `server/src/services/SessionManager.ts:3014-3051` marks headless degraded for create/write/resize/serialize failures.
- `server/src/services/SessionManager.ts:3065-3075` creates degraded snapshots with empty `data`.
- `server/src/ws/WsRouter.ts:1519-1536` sends degraded/truncated-empty snapshots as `mode: "fallback"`.
- `server/src/ws/WsRouter.ts:1566-1580` queues output while replay is pending.
- `server/src/ws/WsRouter.ts:1215-1235` handles replay ACK timeout but does not flush queued output in the reviewed path.

Tests:

- `frontend/tests/unit/terminalContainerRecoveryContract.test.ts` asserts placeholder fallback does not finish visible/hidden recovery.
- `frontend/tests/unit/terminalHiddenOutput.test.ts:131-152` rejects fallback placeholders for hidden-output recovery clearing.
- `server/src/test-runner.ts` contains degraded snapshot, fallback replay refresh, and queued output tests that lock portions of existing behavior.

