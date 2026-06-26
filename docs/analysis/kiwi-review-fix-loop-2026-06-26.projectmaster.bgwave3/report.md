# Wave3 Review-Fix Loop Report

Date: 2026-06-26

Requirement: `FR-BGSTAB-010`

## Summary

Wave3 implemented shared session lifecycle semantics and orphan recovery guards. Natural PTY exit now goes through the same SessionManager finalizer as explicit deletion. Workspace tabs now carry additive lifecycle metadata so intentional deletes and stopped tabs are not silently resurrected by orphan recovery.

## Review Findings And Resolution

Initial independent review found three issues:

- High: async finalizer callbacks could race with `deleteTab()` and `deleteWorkspace()` and persist stale pre-removal state.
- Medium: tests did not exercise production-like finalizer callbacks during workspace/tab deletion.
- Low: orphan recovery skip tests covered stopped+non-recoverable together, but not `recoverable:false` as an independent skip reason.

Resolution:

- `WorkspaceService` now persists finalizer callbacks only for `process-exit` and `direct-session-delete`.
- `tab-delete`, `workspace-delete`, and `tab-restart` finalizer callbacks are ignored because those flows are already handled by explicit WorkspaceService operations.
- The test harness now records and emits `SessionFinalizedEvent` from delete stubs.
- Delete workspace/delete tab tests now assert no stale save is introduced by finalizer callbacks.
- Orphan recovery tests now cover both stopped tabs and active-but-non-recoverable tabs.

Final independent re-review result: `No findings`.

## Commands

```powershell
npm --prefix server test
npm --prefix frontend exec tsc -- --noEmit --skipLibCheck --lib ES2020,DOM --module ESNext --moduleResolution Bundler --target ES2020 frontend/src/types/workspace.ts
git diff --check
```

Results:

- Server build plus tests passed: 255 tests in the 2026-06-26 follow-up verification.
- Targeted Wave3 frontend workspace type check passed.
- Diff check passed with line-ending warnings only.
- Full frontend typecheck passes in the 2026-06-26 follow-up verification.
- SpecKiwi strict validation passed with 0 errors and 0 warnings.

## Code Touchpoints

- `server/src/services/SessionManager.ts`
- `server/src/services/WorkspaceService.ts`
- `server/src/routes/sessionRoutes.ts`
- `server/src/routes/workspaceRoutes.ts`
- `server/src/index.ts`
- `server/src/types/workspace.types.ts`
- `frontend/src/types/workspace.ts`
- `server/src/test-runner.ts`

## Status

Wave3 is implemented and aligned with `docs/research/plug-leak/wave3.md`.
