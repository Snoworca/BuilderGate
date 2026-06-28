# Wave 5 — Shutdown Evidence And Server Soak Gate

상세 연구/구현 계획: [2026-06-27.buildergate-wave5-shutdown-evidence-soak-plan.md](../2026-06-27.buildergate-wave5-shutdown-evidence-soak-plan.md)

## 목표

서버 측 cleanup wave가 실제 장시간 사용 누적을 막는지 프론트엔드 변경 전에 검증한다. graceful shutdown과 daemon stop도 session process cleanup evidence를 포함하게 한다.

## 구현 범위

수정 대상:

- `server/src/services/gracefulShutdown.ts`
- `server/src/routes/internalShutdownRoutes.ts`
- `server/src/index.ts`
- `tools/daemon/stop-client.js`
- `tools/daemon/stop-client.test.js`
- `tools/daemon/sentinel.test.js`

Shutdown order:

1. active tab CWD snapshot.
2. workspace flush.
3. owned session termination with bounded timeout.
4. cleanup evidence collection.
5. final workspace flush.
6. process exit.

Shutdown evidence:

```ts
interface ShutdownSessionCleanupEvidence {
  sessionCleanupAttempted: number;
  sessionCleanupCompleted: number;
  sessionCleanupDegraded: number;
  sessionCleanupSkippedUnverified: number;
  remainingVerifiedDescendants: number;
}
```

`stop-client.js` should validate and print this evidence, but it must not add broad process-tree kill fallback outside the server-owned session cleanup path.

## Server-only soak scenarios

- Repeated create/delete tab with PowerShell.
- Repeated create/delete tab with bash or WSL where available.
- Restart tab loop verifies old session descendants disappear.
- High-output command verifies headless queue and WS queue return to baseline.
- Direct session delete verifies orphan recovery does not recreate stopped tab.
- Internal shutdown verifies no verified session descendants remain.

Metrics:

- `/api/sessions/telemetry` before/during/after.
- process descendants of known app PID and known session root PIDs.
- queue bytes/chunks.
- `TerminalObs` summary only.
- log size delta.

## 테스트 계획

Automated:

```powershell
npm --prefix server test
node --test tools/daemon/process-info.test.js tools/daemon/stop-client.test.js tools/daemon/sentinel.test.js
```

Manual/live:

- Use project-approved local validation port: app `https://localhost:2222`, health `http://localhost:2221/health`.
- Start with `start.bat --port 2222` and stop with `stop.bat`.
- Do not kill by process name.
- Do not terminate all `node.exe` processes.
- Record only test-started root PIDs.

## 롤백

- Disable shutdown session termination and return to flush-only shutdown.
- Keep telemetry and evidence fields additive.

## 완료 조건

- Repeated server-only lifecycle tests return session/process/queue counts to baseline.
- Shutdown evidence is available and validated by daemon stop.
- No broad kill path is introduced.
- Degraded, skipped-unverified, unavailable bash/WSL, and unrun long-duration soak scenarios are recorded explicitly instead of being claimed as completed coverage.
