# Kiwi Review/Fix Loop — BuilderGate Wave7

Date: 2026-06-29
Target: `0.5.5-buildergate-stability`
Requirement: `FR-BGSTAB-014`

## Scope

Wave7 frontend runtime resource consumers were implemented from:

- `docs/research/2026-06-29.buildergate-wave7-frontend-runtime-implementation-plan.md`
- `docs/research/plug-leak/wave6.md`
- `docs/plans/2026-06-29.projectmaster.bgwave7.plan.md`

## Review Findings Addressed

| Area | Finding | Fix |
| --- | --- | --- |
| AC-2 runtime residency | Grid-visible tabs could be under-pinned when server `gridLayouts` was stale or empty. | `resolveVisibleTerminalTabIds()` now conservatively pins all active workspace tabs in grid mode unless a complete current grid layout is available. |
| AC-3 snapshot limits | Auth-token quota recovery could evict fresh removal tombstones due `minEntriesToRemove`. | Snapshot eviction now applies minimum forced removal only to snapshot data entries, preserving fresh tombstones while under budget. |
| AC-4 cleanup | Tab deletion did not prune persisted mosaic layout for inactive workspaces. | Added `pruneMosaicLayoutForDeletedTab()` and call it from direct close and WS `tab:removed` paths. |
| AC-4 cleanup second-pass | Workspace deletion could leave `active_workspace_id` pointing at a deleted workspace, especially for WS delete events or deleting the last workspace. | Added `resolveActiveWorkspaceAfterRemoval()` and use it from direct and WS workspace delete paths to persist the next workspace id or clear the key. |
| AC-5 hidden output | Component-boundary regression coverage was missing for fallback placeholder not clearing dirty state. | Added `terminalContainerRecoveryContract.test.ts` to pin the TerminalContainer caller contract. |
| AC-6 visible overflow | Visible recovery was not mapped into input barriers and scheduler stale state was cleared too early. | Added `visible-output-recovery` barrier, kept scheduler stale until authoritative recovery, and flush pending repair after restore settles. |
| AC-6 visible overflow second-pass | The `visible-output-recovery` barrier could block the authoritative repair request itself, and queued input could flush while recovery was still pending. | Allowed screen repair readiness under the visible recovery barrier, deferred transport outbox flush while recovery blocks input, and retry flushed input after recovery finishes. |
| AC-5/AC-6 recovery contract third-pass | Fallback placeholder snapshots and recent repair suppression could make visible recovery look complete before authoritative state was available. | Finished visible recovery only after authoritative snapshot or local restore success, and allowed repair requests while visible recovery is pending. |
| AC-7 stale socket | Existing E2E expected stale-socket rejection, conflicting with Wave7 reconnect grace. | Updated TC-7212 to assert queue and flush during reconnect grace. |
| AC-7 send-failed exception | E2E coverage did not prove the browser `send-failed` path queued/retried input or redacted debug payloads. | Added TC-7213 and local debug override support for `send-failed`, recording `ws_send_failed_exception` and verifying retry order plus redaction. |
| AC-8 traceability | Server default/template files and shared protocol type files were underrepresented in Wave7 plan/SRS evidence. | Updated the plan, sidecar, and SRS trace links to include server defaults, config template/runtime-config tests, and shared WebSocket protocol files. |

## Verification

| Command | Result |
| --- | --- |
| `node --experimental-strip-types --test frontend/tests/unit/runtimeConfig.test.ts frontend/tests/unit/terminalSnapshot.test.ts frontend/tests/unit/terminalRuntimeRefs.test.ts frontend/tests/unit/mosaicLayoutStorage.test.ts frontend/tests/unit/terminalHiddenOutput.test.ts frontend/tests/unit/terminalOutputScheduler.test.ts frontend/tests/unit/visibleOutputRecovery.test.ts frontend/tests/unit/webSocketBackpressure.test.ts frontend/tests/unit/terminalTransportQueueDecision.test.ts frontend/tests/unit/useTerminalRuntimeResidency.test.ts frontend/tests/unit/terminalContainerRecoveryContract.test.ts frontend/tests/unit/terminalViewRecoveryContract.test.ts frontend/tests/unit/useWorkspaceManager.test.ts` | Passed, 90/90 |
| `npm --prefix frontend run typecheck` | Passed |
| `npm --prefix server test` | Passed, 290/290 |
| `npm --prefix frontend run build` | Passed; Vite chunk-size warning only |
| `PLAYWRIGHT_BASE_URL=https://localhost:2222 playwright test tests/e2e/settings-resource-limits.spec.ts --project "Desktop Chrome"` | Passed, 4/4 |
| `PLAYWRIGHT_BASE_URL=https://localhost:2222 playwright test tests/e2e/terminal-keyboard-regression.spec.ts --project "Desktop Chrome" --grep "TC-721[23]"` | Passed, 2/2 |
| Final sub-agent re-review | Passed; AC-1/3/8, AC-4, AC-5, AC-6, AC-7 reviewers reported `No findings` after second-pass fixes |

## Notes

- `server/dist/public` was refreshed from `frontend/dist` before Playwright checks because local validation targets the production static server at `https://localhost:2222`.
- `stop.bat` reported a sentinel graceful-exit timeout during the final static refresh; no broad process kill was used, and health check passed with redirect follow (`200`) before Playwright checks.
