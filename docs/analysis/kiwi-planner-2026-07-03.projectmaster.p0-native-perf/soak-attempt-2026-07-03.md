# FR-BGSTAB-019 AC-3 Soak 시도 기록 (2026-07-03, 중단됨)

## 결론

2시간 무인 soak을 **실행하지 않고 중단**했다. 사전 소규모 검증(수동, 2세션)에서 soak이 통과 불가능함을 구조적으로 확인했기 때문이다 — 근본 원인을 고치기 전에는 몇 시간을 돌려도 AC-3("잔존 verified-descendant 0")을 만족하는 결과가 나올 수 없다.

## 사전 준비 중 발견 1: 환경변수가 잘못된 config를 가리킴 (해결됨)

- `BUILDERGATE_CONFIG_PATH` 환경변수가 전역으로 `C:\Work\agent-tools\builder-gate\config.json5`(별도 배포본, `processCleanup` 블록 자체 없음)를 가리키고 있어, 이 저장소의 `dev.js`가 기동될 때마다 **repo 소스의 `server/config.json5`(enforce 설정)가 아닌 배포본 config를 로드**했다.
- 확인: 첫 기동 시 `TerminalObs` 텔레메트리에 `"cleanup":{"mode":"observe",...}` 로 나타남 — repo config는 enforce인데 실제 로드값은 observe.
- 조치: `export BUILDERGATE_CONFIG_PATH="C:/Work/git/_Snoworca/ProjectMaster/server/config.json5"` 지정 후 재기동 → `"mode":"enforce"` 확인됨.
- **후속 조치 필요**: 이 환경변수가 사용자 전역 셸 프로파일에 설정되어 있어, 이 저장소에서 향후 `node dev.js`를 실행할 때마다 매번 동일한 문제가 재발한다. dev.js 또는 문서에 `.env`/README 안내 추가를 권고(코드 변경은 사용자 확인 필요 — 이번 세션에서는 미수정).

## 사전 준비 중 발견 2: PERF-BGSTAB-002 비동기 신원조회가 실환경에서 결정적으로 실패 (신규, BLOCKING)

### 재현 절차
1. enforce 모드로 정상 기동 확인.
2. 세션 생성 → WS `session:ready` 대기 → PowerShell 셸에 `Start-Process`(분리된 손자 프로세스) + 직접 자식 ping을 spawn하는 명령 전송.
3. spawn 확인(CIM으로 3개 프로세스 확인: 셸 PID의 직접 자식 PING.EXE, `Start-Process`로 분리된 cmd.exe와 그 자식 PING.EXE).
4. 세션 삭제(DELETE `/api/sessions/:id`).
5. 5초 대기 후 CIM 재조회.

### 결과
- `TerminalObs` cleanup 텔레메트리: `{"mode":"enforce","attempted":1,"completed":0,"degraded":0,"unverifiedSkipped":1,"recentResults":[{"reason":"direct-session-delete","rootPid":40740,"remainingDescendants":1,"verifiedRemainingDescendants":0,"unverifiedRemainingDescendants":1,"cleanupStatus":"skipped-unverified"}]}`
- 직접 자식(ping.exe)은 사라짐(ConPTY 자체의 소프트 종료로 콘솔 종료에 딸려 죽은 것으로 추정 — enforce taskkill이 실행된 증거는 아님).
- **`Start-Process`로 분리된 손자 프로세스(cmd.exe + 그 자식 ping.exe)는 생존**. `cleanupStatus: "skipped-unverified"`이므로 BuilderGate의 enforce 경로가 `taskkill /PID <rootPid> /T /F`를 아예 실행하지 않았다(스킵됨).
- 수동으로 동일 PID에 `taskkill /PID <rootPid> /T /F`를 직접 실행하자 트리 전체가 정상 종료됨 — **taskkill 메커니즘 자체는 유효**하다. 문제는 BuilderGate가 그것을 호출하는 조건에 도달하지 못한 것.

### 근본 원인 (코드 확인)

`server/src/utils/processTreeTerminator.ts:421`:
```ts
if (!metadata.osStartIdentity) {
  return this.skipped(rootPid, [rootPid], 'Session root identity is unavailable');
}
```
`metadata.osStartIdentity`가 없으면 신원 검증을 아예 건너뛰고 즉시 skipped-unverified로 귀결 — enforce의 taskkill 자체가 시도되지 않는다.

`server/src/services/SessionManager.ts:2355-2369` (`scheduleProcessStartIdentityCapture`, PERF-BGSTAB-002가 도입):
```ts
private scheduleProcessStartIdentityCapture(sessionId: string, data: SessionData): void {
  const rootPid = data.processMetadata.rootPid;
  void this.readProcessStartIdentityFn(rootPid, this.platform, this.execFileFn)
    .then((identity) => {
      if (!identity) { return; }
      ...
      current.processMetadata.osStartIdentity = identity;
    })
    .catch(() => {
      // Best-effort metadata only; cleanup will follow the unverified path if identity is unavailable.
    });
}
```
`readProcessStartIdentity`가 `null`을 반환하거나 reject되면 **재시도 없이, 아무 로그도 없이** 영구적으로 `osStartIdentity: null`로 남는다.

`server/src/utils/processTreeTerminator.ts:328-364` (`readProcessStartIdentity`, win32 분기):
```ts
execFileFn('powershell.exe', [...], { encoding: 'utf8', windowsHide: true, timeout: 1000 }, (error, stdout) => {
  if (error) { resolve(null); return; }
  ...
});
```
**`timeout: 1000`(1초)** — PowerShell 프로세스 콜드스타트 + `Get-CimInstance Win32_Process` WMI 질의를 1초 안에 마쳐야 한다. 부하가 있는 환경(이번 재현 시 시스템에 node.exe 프로세스 수백 개가 이미 떠 있었고, 서버 기동 직후 workspace의 orphan tab 8개가 동시 복구되며 각각 신원조회를 유발)에서는 1초를 넘기기 쉽고, 넘기면 **영구적으로 미검증 상태**가 된다.

### 판정: FR-BGSTAB-019 AC-3 soak은 현재 코드로 통과 불가능

이 결함은 우연한 레이스가 아니라 **부하 상황에서 결정적으로 재현되는 설계 결함**(1회 시도·재시도 없음·1초 타임아웃·관측 불가)이다. 2시간 다중세션 soak을 지금 실행해도, 시스템 부하가 있는 한 상당수 세션이 이 경로를 타 "verified-descendant 0"을 만족하지 못하고 반복적으로 `skipped-unverified`가 기록될 것이다. Soak을 계속 시도하는 것은 시간 낭비이며, 결함을 먼저 고쳐야 한다.

### 권고 수정안 (구현 전 사용자 확인 필요 — 이번 세션에서는 미적용)

1. `readProcessStartIdentity`의 `timeout: 1000`을 상향(예: 3000~5000ms) 또는 시스템 부하 기반 적응형 타임아웃.
2. `scheduleProcessStartIdentityCapture`에 지수 백오프 재시도(예: 최대 2~3회) 추가 — 세션 삭제 이전에 재시도 창을 확보.
3. 신원조회 성공/실패/타임아웃 카운터를 `TerminalObs` 텔레메트리에 노출(현재 완전히 불투명) — PERF-BGSTAB-002 자체의 관측성 갭.
4. 세션 삭제 시점에 `osStartIdentity`가 아직 null이면, 삭제를 아주 짧게(예: 500ms~1s) 지연해 진행 중인 캡처를 기다리는 최종 유예 옵션 검토(단, 삭제 지연은 UX 트레이드오프 있음 — 사용자 결정 필요).

### 부수 발견 (별도 트랙, non-blocking)

`node-pty`(server/node_modules/node-pty) 자체의 내부 `kill()` 구현이 ConPTY 비-DLL 모드(`useConptyDll: false`)에서 콘솔 프로세스 목록을 얻기 위해 별도 프로세스를 fork하는데(`conpty_console_list_agent.ts`), 이 fork된 에이전트가 매 세션 종료마다 `Error: AttachConsole failed`로 크래시했다(this repo's dev.js 호스팅 환경, 콘솔 미부착 백그라운드 프로세스 추정). node-pty 코드 자체에 해당 fork의 `error` 이벤트 핸들러가 없어 조용히 실패하고 5초 타임아웃 후 `[innerPid]`로 폴백한다. 이는 **BuilderGate 자체의 enforce 판정(processTreeTerminator.ts)과는 별개의 경로**이며 skipped-unverified 판정에 직접 영향을 주지 않았으나(직접 원인은 위 osStartIdentity), node-pty 자체의 보조 정리 기능이 이 환경에서 무력함을 시사한다. `useConptyDll: true` 전환을 검토 가치 있음(선행 연구 F3/베스트프랙티스에서도 권고).

## 처리한 테스트 잔여물

- 수동 검증용 세션 2개(soak-test-probe, soak-verify-2) 생성·삭제 완료.
- 잔존한 테스트 마커 프로세스(cmd.exe+ping.exe, 대상 PID 지정)를 `taskkill /PID <pid> /T /F`로 직접 정리 완료 — 잔존 0건 확인(CIM 재조회).
- 이 세션에서 기동했던 이 저장소 전용 dev 서버(포트 4242/4545)는 정상 중지됨. 기존에 실행 중이던 별도 배포본 서버(포트 2002, PID 11856)는 건드리지 않음.

## 다음 단계

1. 위 root cause(§근본 원인)의 수정 여부와 방식(타임아웃 상향/재시도/관측성/삭제 유예)에 대한 사용자 결정.
2. 수정 후 동일한 수동 검증 절차(본 문서 §재현 절차)로 먼저 단발 재현 테스트 → 통과 확인 후에만 2시간 soak 재시도.
3. `BUILDERGATE_CONFIG_PATH` 환경변수 문제는 향후 이 저장소에서 dev.js를 실행하는 모든 사람에게 재발하므로, 문서화 또는 코드 가드 추가를 별도로 검토.
