# Wave3 Research-Code Alignment Report

Date: 2026-06-26

Scope:

- Research source: `docs/research/plug-leak/wave3.md`
- SRS: `FR-BGSTAB-010`
- Plan: `docs/plans/2026-06-26.projectmaster.bgwave3.plan.md`
- Implementation diff: current Wave3 working tree changes

## Conclusion

Wave3 research intent and the implemented code are aligned.

One implementation choice differs from the research document: `server/src/services/SessionLifecycleService.ts` was listed as a creation candidate, but no new service file was added. The lifecycle logic remained in `SessionManager` and `WorkspaceService` because the required behavior could be implemented by extracting a private SessionManager finalizer and adding WorkspaceService lifecycle helpers without introducing another service boundary.

## Alignment Matrix

| Wave3 requirement | Code alignment | Test alignment |
| --- | --- | --- |
| PTY natural `onExit` uses the shared cleanup path and still emits `session:exited`. | `server/src/services/SessionManager.ts:629`, `server/src/services/SessionManager.ts:957`, `server/src/services/SessionManager.ts:2076`, `server/src/services/SessionManager.ts:2091` | `server/src/test-runner.ts:124`, `server/src/test-runner.ts:1406` |
| Finalization is idempotent across natural exit/delete races. | `server/src/services/SessionManager.ts:2076`, `server/src/services/SessionManager.ts:2088`, `server/src/services/SessionManager.ts:2156` | `server/src/test-runner.ts:125`, `server/src/test-runner.ts:1471` |
| Direct `DELETE /api/sessions/:id` marks workspace-owned tabs stopped/non-recoverable. | `server/src/routes/sessionRoutes.ts:61`, `server/src/routes/sessionRoutes.ts:65`, `server/src/index.ts:321`, `server/src/index.ts:322`, `server/src/services/WorkspaceService.ts:401` | `server/src/test-runner.ts:247`, `server/src/test-runner.ts:6542` |
| `checkOrphanTabs()` recovers only active/recoverable tabs. | `server/src/services/WorkspaceService.ts:553`, `server/src/services/WorkspaceService.ts:826`, `server/src/services/WorkspaceService.ts:830` | `server/src/test-runner.ts:246`, `server/src/test-runner.ts:6505` |
| Restart ordering creates replacement, persists new session id/generation, then deletes old session. | `server/src/services/WorkspaceService.ts:382` | `server/src/test-runner.ts:239`, `server/src/test-runner.ts:6185` |
| Workspace delete treats owned tabs as non-recoverable before session cleanup and final removal. | `server/src/services/WorkspaceService.ts:230` | `server/src/test-runner.ts:242`, `server/src/test-runner.ts:6351` |
| Tab delete does not race with asynchronous finalizer callback after pre-marking. | `server/src/services/WorkspaceService.ts:84`, `server/src/services/WorkspaceService.ts:603` | `server/src/test-runner.ts:243`, `server/src/test-runner.ts:6365` |
| Frontend receives optional lifecycle metadata without UI redesign. | `frontend/src/types/workspace.ts:24`, `frontend/src/types/workspace.ts:35` | Targeted TypeScript check passed for `frontend/src/types/workspace.ts` |

## Race Review Result

The first independent review found a real race: finalizer callbacks for `tab-delete` and `workspace-delete` could save stale pre-removal workspace state after delete operations. The fix limits asynchronous finalizer persistence to reasons that need post-finalization metadata persistence: `process-exit` and `direct-session-delete`. Workspace-owned delete/restart flows now remain owned by the explicit WorkspaceService operation that already pre-marks or replaces the tab.

The test harness now emits `SessionFinalizedEvent` from `deleteSession()` and `deleteMultipleSessions()` so the delete race path is covered by tests rather than hidden behind a no-op callback.

## Verification

- `npm --prefix server test`: passed, 234 tests.
- `npm --prefix frontend exec tsc -- --noEmit --skipLibCheck --lib ES2020,DOM --module ESNext --moduleResolution Bundler --target ES2020 frontend/src/types/workspace.ts`: passed.
- `npm --prefix frontend run typecheck`: attempted, blocked by unrelated untracked `RecoveryOptionManager` export/API work.
- `git diff --check`: passed, line-ending warnings only.
- SpecKiwi strict validation: passed with 0 errors and 0 warnings.
- Independent re-review: `No findings`.

## Residual Risk

`process-exit` and `direct-session-delete` lifecycle metadata persistence still depends on the existing asynchronous WorkspaceService save path. That matches the current persistence model and is acceptable for Wave3, but shutdown-time durability policy remains a Wave5 concern as stated in the research document.
