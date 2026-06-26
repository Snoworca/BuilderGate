# Wave 2 — Verified Process-Tree Termination

## 목표

세션 소유 process tree를 안전하게 종료하는 서버 유틸과 async session termination API를 도입한다. Wave 1에서 쌓은 ownership metadata와 observation을 바탕으로 enforce mode를 구현한다.

## 구현 범위

생성 대상:

- `server/src/utils/processTreeTerminator.ts`

수정 대상:

- `server/src/services/SessionManager.ts`
- `server/src/routes/sessionRoutes.ts`
- `server/src/services/WorkspaceService.ts`
- `server/src/routes/workspaceRoutes.ts`
- `server/src/services/gracefulShutdown.ts`는 이 wave에서는 직접 shutdown enforce까지 하지 않고 API 준비만 한다.

Process terminator interface:

```ts
interface ProcessTreeTerminator {
  inspect(metadata: SessionProcessMetadata): Promise<ProcessTreeInspection>;
  terminate(metadata: SessionProcessMetadata, options: TerminateOptions): Promise<ProcessTreeTerminationResult>;
}

interface ProcessTreeTerminationResult {
  status: 'completed' | 'degraded' | 'failed' | 'skipped-unverified';
  rootPid: number | null;
  terminatedPids: number[];
  remainingPids: number[];
  unverifiedPids: number[];
  method: 'pty-kill-only' | 'windows-taskkill-tree' | 'posix-process-group' | 'posix-leaf-first' | 'wsl-process-group' | 'observe';
  message?: string;
}
```

SessionManager API:

```ts
terminateSession(id: string, options: {
  reason: 'tab-delete' | 'workspace-delete' | 'tab-restart' | 'direct-session-delete' | 'process-exit' | 'shutdown';
  mode?: 'legacy' | 'observe' | 'enforce';
  waitMs?: number;
}): Promise<boolean>;

terminateMultipleSessions(ids: string[], options: TerminateSessionOptions): Promise<SessionTerminationBatchResult>;
terminateAllSessions(options: TerminateSessionOptions): Promise<SessionTerminationBatchResult>;
```

Compatibility:

- Keep `deleteSession(id): boolean` as a wrapper initially.
- Route new workspace and session delete paths through async `terminateSession()`.
- Preserve existing HTTP status compatibility. Detailed cleanup result can be exposed through telemetry first.

## Safety policy

- PID alone is insufficient. Validate executable/command/cwd/start identity where possible.
- Windows fallback may use `taskkill.exe /PID <verifiedRootPid> /T /F` only after root identity validation.
- POSIX may signal process group only when group is verified as session-owned; otherwise use verified descendant leaf-first.
- WSL requires numeric Linux PID/PGID from shell integration before Linux-side kill.
- Unverified detached children are reported as degraded, not force-killed.
- No `taskkill /IM`, no `killall`, no process-name broad kill.

## 테스트 계획

Server unit tests:

- Windows process parser rejects PID reuse.
- POSIX process parser rejects start-token mismatch.
- taskkill command uses PID only and no `shell: true`.
- unverified child is skipped and reported.
- direct session delete awaits `terminateSession`.
- tab delete and workspace delete await session termination.
- restart tab creates replacement first, then terminates old session.

Live marker tests:

- PowerShell marker PID exits after tab close.
- bash marker PID exits after tab close.
- WSL marker PID exits after tab close when WSL support is available.

## 검증 명령

```powershell
npm --prefix server test
node --test tools/daemon/process-info.test.js tools/daemon/stop-client.test.js
```

## 롤백

- Set `session.processCleanup.mode = 'observe'` or `legacy`.
- Keep async API but disable force stage.

## 완료 조건

- Verified owned descendants are terminated for explicit session/tab/workspace close.
- Unverified descendants are not force killed and are visible in telemetry.
- Existing delete route semantics remain compatible.
