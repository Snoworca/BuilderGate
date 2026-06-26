# Wave 3 — Session Lifecycle Semantics And Orphan Recovery

## 목표

세션 종료 의미를 서버 전체에서 일관화한다. PTY 자연 종료, explicit delete, restart, workspace delete, direct session delete, orphan recovery가 같은 lifecycle model을 공유하게 한다.

## 현재 문제

- PTY `onExit`는 cleanup 없이 `session:exited`만 broadcast한다.
- direct `DELETE /api/sessions/:id`는 workspace tab metadata를 갱신하지 않는다.
- `checkOrphanTabs()`는 missing session이면 의도적 종료인지 구분하지 않고 새 세션을 만든다.

## 구현 범위

생성 후보:

- `server/src/services/SessionLifecycleService.ts`

수정 대상:

- `server/src/services/SessionManager.ts`
- `server/src/services/WorkspaceService.ts`
- `server/src/routes/sessionRoutes.ts`
- `server/src/types/workspace.types.ts`
- `frontend/src/types/workspace.ts`는 타입 수신 호환만 반영한다. UI 변경은 하지 않는다.

Workspace tab lifecycle metadata:

```ts
interface WorkspaceTabLifecycle {
  lifecycleState?: 'active' | 'stopped';
  recoverable?: boolean;
  lifecycleReason?: 'tab-delete' | 'workspace-delete' | 'tab-restart' | 'direct-session-delete' | 'process-exit' | 'shutdown' | 'orphan-recovery';
  cleanupStatus?: 'not-started' | 'observed' | 'completed' | 'degraded' | 'failed';
  lastExitCode?: number | null;
  lifecycleUpdatedAt?: string;
  generation?: number;
}
```

Behavior:

- PTY natural exit calls shared finalizer. It clears timers, detectors, headless state, CWD watcher/temp file, WS replay/debug state.
- direct session delete on workspace-owned session marks tab stopped/non-recoverable instead of leaving an auto-recoverable orphan.
- `checkOrphanTabs()` recovers only active/recoverable tabs.
- restart tab keeps safe ordering: create replacement, persist new session id/generation, then terminate old session.
- shutdown policy is left to Wave 5. Initially shutdown tabs can remain recoverable unless product policy decides otherwise.

## 테스트 계획

Server tests:

- PTY `onExit` runs full finalizer once.
- double finalizer is idempotent.
- direct session delete prevents orphan recovery.
- orphan recovery skips stopped/non-recoverable tabs.
- restart tab does not delete old session if replacement creation fails.
- workspace delete removes tabs and terminates sessions as non-recoverable.

Frontend type tests:

- `WorkspaceTabRuntime` accepts optional lifecycle fields.
- disconnected state can be derived without visual redesign.

## 검증 명령

```powershell
npm --prefix server test
npm --prefix frontend run typecheck
```

## 롤백

- Lifecycle metadata is additive.
- If needed, ignore new fields and revert `checkOrphanTabs()` to legacy recovery only after confirming no stopped tabs are present.

## 완료 조건

- Natural PTY exit and explicit delete share cleanup.
- Direct session deletion cannot silently resurrect through orphan recovery.
- Workspace tab lifecycle fields are persisted compatibly.
