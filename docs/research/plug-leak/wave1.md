# Wave 1 — Server Session Process Observation

## 목표

세션 종료를 강제 변경하기 전에 observe-only telemetry를 추가한다. 이 wave는 기존 `data.pty.kill()` 동작을 유지하면서, 세션이 어떤 root PID와 descendant를 가졌고 종료 시 무엇이 남는지 증거를 수집한다.

## 현재 관찰

- `SessionManager.ts:503`의 PTY `onExit`는 `session:exited`만 broadcast한다.
- `SessionManager.ts:823`의 `deleteSession()`은 `data.pty.kill()` 후 내부 상태를 정리하지만 OS process tree 종료를 검증하지 않는다.
- `WorkspaceService.deleteTab/deleteWorkspace/restartTab`은 모두 `deleteSession()` 또는 `deleteMultipleSessions()`에 의존한다.
- `tools/daemon/process-info.js`는 daemon PID identity 검증 패턴을 이미 갖고 있다. 세션 프로세스에도 같은 원칙이 필요하다.

## 세션 닫기 정적 분석

현재 정적 경로상 의심은 사실일 가능성이 높다. 세션 닫기, tab delete, workspace delete, restart는 서버 내부 session map과 workspace metadata를 정리하지만, OS 관점에서 shell descendant가 사라졌는지 확인하지 않는다.

확인된 경로:

1. 사용자가 세션을 닫는다.
2. route 또는 workspace service가 `SessionManager.deleteSession()`/`deleteMultipleSessions()`를 호출한다.
3. `deleteSession()`은 `data.pty.kill()`을 호출하고 서버 내부 상태를 제거한다.
4. PTY `onExit`는 `session:exited` broadcast 중심이며, descendant process tree sample, wait, force cleanup, remaining child report가 없다.
5. `WorkspaceService.checkOrphanTabs()`는 missing session을 의도적 종료인지 구분하지 못하면 새 session을 만들 수 있다.

Shell별 위험:

- PowerShell: `node-pty`가 console root를 종료해도 PowerShell이 띄운 long-running child가 별도 process로 남을 수 있다. 현재 경로는 child PID identity를 확인하지 않는다.
- bash: POSIX shell은 process group과 descendant 관계가 중요하다. 현재 경로는 session-owned process group인지 검증한 뒤 signal을 보내는 절차가 없다.
- WSL: Windows PID와 WSL 내부 Linux PID/PGID가 다르다. 현재 경로는 WSL 내부 descendant를 샘플링하거나 종료 결과를 보고하지 않는다.

따라서 Wave 1은 바로 강제 종료를 추가하지 않고, root PID, start identity, descendant sample, remaining process evidence를 먼저 수집한다. Wave 2에서만 verified-owned tree에 대해 enforce mode를 켠다.

## 구현 범위

수정 대상:

- `server/src/services/SessionManager.ts`
- `server/src/types/config.types.ts`
- `server/src/schemas/config.schema.ts`
- `server/src/utils/configTemplate.ts`
- `server/src/types/ws-protocol.ts`
- `server/src/index.ts`의 `/api/sessions/telemetry`

설정 추가:

```ts
session: {
  processCleanup?: {
    mode: 'legacy' | 'observe' | 'enforce';
    gracefulWaitMs: number;
    forceWaitMs: number;
    descendantSampleLimit: number;
  }
}
```

초기 기본값:

- `mode: 'observe'`
- `gracefulWaitMs: 750`
- `forceWaitMs: 1500`
- `descendantSampleLimit: 64`

Session metadata:

```ts
interface SessionProcessMetadata {
  rootPid: number;
  shellCommand: string;
  shellArgs: string[];
  shellType: string;
  cwd: string;
  platform: NodeJS.Platform;
  backend?: 'conpty' | 'winpty' | 'unix' | 'wsl';
  launchedAt: string;
  osStartIdentity?: string;
  wslLinuxPid?: number;
  wslLinuxPgid?: number;
}
```

Telemetry:

```ts
interface SessionCleanupTelemetry {
  mode: 'legacy' | 'observe' | 'enforce';
  attempted: number;
  completed: number;
  degraded: number;
  unverifiedSkipped: number;
  lastResults: Array<{
    sessionId: string;
    reason: string;
    rootPid: number | null;
    remainingDescendants: number;
    cleanupStatus: 'not-started' | 'observed' | 'completed' | 'degraded' | 'failed';
    recordedAt: string;
  }>;
}
```

Behavior:

- In observe mode, tab/session/workspace delete records what would be terminated but does not force-kill beyond current `pty.kill()`.
- Never kill by process name.
- Never run shell-constructed commands with user-controlled content.
- Record degraded/unverified status rather than taking unsafe action.

## 테스트 계획

Server tests in `server/src/test-runner.ts`:

- create session captures root PID and shell command.
- delete session in observe mode calls current `pty.kill()` and records dry-run telemetry.
- PID identity mismatch records unverified/skipped.
- double delete does not duplicate cleanup records.
- telemetry redacts raw terminal data.

## 검증 명령

```powershell
npm --prefix server test
curl -k https://localhost:2002/api/sessions/telemetry
```

Manual/live observation should only sample descendant PIDs for the known app PID/session root PIDs. It must not kill anything in this wave.

## 롤백

- Set `session.processCleanup.mode = 'legacy'`.
- Telemetry fields are additive and can remain unused.

## 완료 조건

- Session metadata is captured for new sessions.
- Delete/exit paths produce cleanup observation evidence.
- No behavior-changing process-tree kill is introduced.
