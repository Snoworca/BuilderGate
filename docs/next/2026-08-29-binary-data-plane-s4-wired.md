# 바이너리 데이터 평면 — S4 배선 완료 · 사다리 상승 대기 — 세션 핸드오프

2026-08-29 작성 · 브랜치 `work/mcp-session-orchestration-20260709` · **미커밋**

---

## 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. `cd C:/Work/git/_Snoworca/ProjectMaster && git status --porcelain | wc -l` 이 **418 근처**인지 본다. 크게 다르면 그 사이 누가 커밋했거나 되돌린 것이니 아래 「워킹트리 상태」를 믿지 말고 실제를 믿어라.
3. **사용자에게 커밋 범위를 물어본다.** 이것이 유일하게 남은 blocking 결정이다 — 아래 「먼저 물어야 할 것」 참조.
4. 답을 기다리는 동안 **작업 A**(codex 워크스페이스 전환 시 세션 종료 오진단)를 조사한다. 사용자가 이번 세션에 새로 지시한 항목이고 선행이 없다.

---

## 1. 최종 작업 목표

터미널 출력을 JSON 이 아닌 바이너리 프레임으로 보내고, 클라이언트가 그것을 화면에 그리게 한다.

**S4 완료 조건 (S4-d 진입)**: `realtime.terminalWireFormat: 'binary-shadow'` 로 설정한 서버가 output 을 JSON·바이너리 양쪽으로 인코딩하고, 와이어에는 JSON 만 내보내며, 바이너리를 디코드해 JSON 과 의미 동등성을 비교해 불일치 0건이 나온다.

**S4-d 진입 조건 세 가지가 모두 충족되었다** (2026-08-28~29 측정):
- ① 기준선 대비 신규 red 0 — 서버 전수 52파일 / pass 878 / fail 24, 24건 전부 기존 실패
- ② S1~S3 이 신설·변경한 테스트 전건 green — `src/ws` 전건 green
- ③ S3 의 조용한 폐기 8항목 전건이 명시 실패로 전환됨

⚠️ **기본 배포 동작은 여전히 불변이다.** `realtime.terminalWireFormat` 기본값이 `json` 이고, 그 값에서는 협상이 `group-not-eligible` 로 거절되며 그룹 상태조차 할당되지 않는다.

## 2. 이번 세션(2026-08-28~29)에 완료한 것

전부 test-first 로 red 를 확인한 뒤 구현했다. 모든 뮤테이션 하네스에 **살아남아야 하는 대조 뮤턴트**를 넣었다.

| 항목 | 내용 | 테스트 | 뮤턴트 |
|---|---|---:|---|
| A1 | `WirePayload` 판별 유니온 + `encodeFor` (신규 `server/src/ws/wirePayload.ts`). `WsTransportMessage.payload` 를 유니온으로 전환하고 송신 지점이 갈래를 지명 | 24 + 9 | 13/13 |
| A2 | `streamEpoch` 전체 승격 — 원장 위임, `adopt` 도입, 전역 단조 발급 유지, `ordinal-rollover`·`authority-rollback` 배선, 세션 제거 시 정리 | 19 + 28 | 10/10 + 18/18 |
| A3~A5 | `WsRouter` 가 그룹 세션 보유 · `terminal-binary:capability` 핸들러 · `subscribed` 채널 장식(이슈 #29) · `channel-retired` 통지 | 31 + 28 | 20/20 |
| A6 | `codecEpoch` 게이트(`codec-epoch-retired` 로 종결) + `createWsTransportMessage` codec 파라미터화 | 9 + 18 | 7/7 + M4 별도 |
| A7~A8 | 프론트 협상 배선 · offer 송신(소켓이 새로 쓸 수 있게 된 3지점) · `unknown-channel` 복구 요청 + 서버 재announce | 31 + 10 | 11/11 |
| A9 | xterm 이중 디코더 위험 실측 + 직렬화 회귀 테스트 | 5 | 3/3 |
| A10 | shadow 등가 비교기 (신규 `server/src/ws/terminalWireShadowComparator.ts`) | 17 | 12/12 |
| A11 | S4-d 진입 게이트 — 조건 ①②③ 전부 충족 | — | — |
| B1 | 조용한 폐기 8항목 전건을 명시 실패로 전환 | 4 + E2E | 결함 주입 5/5 |
| B2 | S4-0b 열린 항목 **9건 전건 판정** | 8 | 4/4 |

## 3. 확정된 결정 (재논의 금지)

| # | 결정 | 근거 |
|---|---|---|
| 1 | `realtime.terminalWireFormat` 기본값은 `json` | `server/src/schemas/config.schema.ts:60`. 이 기본값을 `binary` 로 바꾸는 뮤턴트가 테스트로 죽는다 |
| 2 | 바이너리는 `wsTransportMode === 'unified'` 에서만 허용 | `server/src/ws/terminalWireFormat.ts` 의 `isTransportEligible` |
| 3 | `binary-shadow` 는 협상을 열지 않는다 | 그 단계는 와이어에 바이너리가 나가지 않는다 |
| 4 | `streamEpoch` 은 **전역 단조 발급**을 유지한다 | 세션별 1부터로 바꾸자 `RetainedTerminalAuthority` 가 깨졌다. `01:466` 이 "새 저장소를 만들지 않고 이것을 정본으로 승격한다"고 못박는다 (`01:462` 는 "`streamEpoch` 은 세션이 소유한다"는 설계결정 줄이다) |
| 5 | 설정 사실(`terminalWireFormat`)과 소켓 능력은 분리한다 | 섞으면 원인이 `group-not-eligible` 인데 `socket-not-binary-capable` 로 오보한다 |
| 6 | 바이너리 그룹 세션은 **offer 핸들러만** 생성한다 | 협상을 시도하지 않은 클라이언트는 그룹 상태를 할당하지 않는다 |
| 7 | `retained.checkpoint.cursor` 는 **uint32 를 유지한다** | uint16 으로 좁히면 도달 가능한 값이 잘린다 (아래 B2 #4) |
| 8 | `responderLeaseId` 의 v1 처분은 **현행 가변 슬롯 유지** | 이미 구현되어 있다. "인코더가 거부"·"인덱스 신설" 둘 다 폐기 |

## 4. B2 — S4-0b 열린 항목 9건 전건 판정

| # | 판정 | 핵심 근거 (2026-08-28~29 현재 소스 실측) |
|---:|---|---|
| 1 | **중복 아님** | 세션 epoch 과 controller epoch 은 `server/src/services/SessionManager.ts:4961` 의 `initialStreamEpoch:` 로 생성 시점에 같고 이후 갈릴 수 있다 → `0x04` 의 `checkpointStreamEpoch` 8 B 는 중복이 아니다 |
| 2 | **반증 — 폴백이 없다** | `server/src/ws/WsRouter.ts:1124-1128` 가드가 split 에서 output 소켓이 OPEN 이 아니면 `{ sent: false }` 로 **거부**한다(재라우팅 아님). `:1130-1132` 의 control 낙하는 `unified` 한정이고, `unified` 는 `:1601` 조건으로 output 채널 부착 자체가 `close(1008,'invalid-output-pair')`(`:1605`) 된다 |
| 3 | **대입 경로 있음** | `server/src/services/TerminalAuthorityController.ts:1588-1594` 가 rollback 경로에서 `recovery.checkpointMessages` 전 원소에 주입한다. 대조군 promotion 경로 `:761-763` 은 맨몸 `enqueue(message)` |
| 4 | **uint32 유지** | xterm 이 `cols = 70000` 을 클램프하지 않아 `cursor.x` 가 **69999** 에 도달한다(실측). 서버 어디에도 `cols`/`rows` 상한이 없고 `VALIDATION_LIMITS.MAX_COLS`/`MAX_ROWS`(`server/src/utils/constants.ts:131-137`)는 **사용처 0건** |
| 5 | **control 이 발급, output 이 상속** | `WsRouter.ts:1685-1687` 이 발급하고 output 은 `group.connectionId` 를 상속한다. `:717` 이 뷰 수집에서 output meta 를 배제한다 |
| 6 | **프론트 외부 소비자 0건** | `tools/`·`server/tools/` 전수 |
| 7 | **`authorityEpochIndex = 0` 은 최소값이지 부재가 아님** | 골든 벡터 `output-minimal-52` 는 `screenSeq`·`chunkIdBase`·`authorityRevision`·`segmentCount` 가 전부 0 인 최소 유효 프레임이다 |
| 8 | **(소켓,세션)당 동시 1개** | 발급 지점 전수 2곳(`WsRouter.ts:3574`·`:5406`), refresh 는 제자리 덮어쓰기, `consumeReplayPendingForPair`(`:3717`)가 수퍼시드 토큰을 즉시 거부 |
| 9 | **수렴한다** | 타임아웃 핸들러(`WsRouter.ts:4180-4214`)가 pending 을 삭제한 뒤 복구를 호출하고, 복구(`:4283-`)는 repair 타임아웃을 재무장하지 않는다 |

⚠️ **#5 는 조건부다.** `0x04` 프롤로그에서 `connectionId` 를 제거하면 `frontend/src/utils/terminalCheckpointRuntime.ts:519` 의 `identity.connectionId === value.connectionId` 비교가 **두 피연산자의 출처가 같아져 항상 참**이 된다. `06` 이 이 항목을 "D3 상 v1 범위 밖"으로 분류했으므로 v1 에서 제거하지 않으면 손실은 발생하지 않는다.

⚠️ **`docs/research/binary-comms/06-work-plan.md` §S4-0b 는 #2·#3 을 여전히 "판정 필수 열린 항목"으로 싣고 있다.** `07` 이 2026-08-19 에 둘 다 닫았는데 `06` 이 갱신되지 않았다. `CLAUDE.local.md` 규칙 1 에 따라 고치지 않았다.

## 5. 워킹트리 상태

- 브랜치 `work/mcp-session-orchestration-20260709` — `origin/main` 대비 **ahead 137 / behind 0**
- `git status --porcelain` 총 **418 엔트리** (2026-08-29 측정). **공유 워킹트리**이고 대부분이 이 작업과 무관한 남의 미커밋 작업이다. 스테이징된 변경 0건

**이 작업이 만든 파일** (전부 `??`):

```
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\wirePayload.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\wirePayload.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\terminalWireShadowComparator.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\terminalWireShadowComparator.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouterWireCodecSend.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouterScreenRepairAckTimeout.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouterUndecodableFrame.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\services\SessionManagerStreamEpoch.test.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\unit\terminalWriteInterleaving.test.ts
```

**이 작업이 수정한 추적 파일** (` M`):

```
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouter.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\wsSendPolicy.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\wsTransportSidecar.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouterSendPriority.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\services\SessionManager.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\services\RuntimeConfigStore.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\schemas\config.schema.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\types\ws-protocol.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\src\contexts\WebSocketContext.tsx
C:\Work\git\_Snoworca\ProjectMaster\frontend\src\types\ws-protocol.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tsconfig.test.json
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\e2e\terminal-authority.spec.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\e2e\grid-equal-mode.spec.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\support\perfBgstab010Ac6BrowserAckHarness.ts
```

**이 작업이 수정했으나 `??` 인 파일** (이전 세션이 만들어 아직 커밋되지 않은 것들):

```
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\terminalBinaryGroupSession.ts (+ .test.ts)
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\terminalStreamEpoch.ts (+ .test.ts)
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouterBinaryChannels.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\WsRouterRestoreMetadata.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\wsSendPolicyRestoreMetadata.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\utils\headlessTerminal.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\services\TerminalAuthorityController.test.ts
C:\Work\git\_Snoworca\ProjectMaster\server\src\services\TerminalResourcePolicyCanary.test.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\src\utils\terminalBinaryNegotiationClient.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\unit\terminalBinaryNegotiationClient.test.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\unit\binaryFrameIntakeWiring.test.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\e2e\wave1-retained-state-characterization.spec.ts
C:\Work\git\_Snoworca\ProjectMaster\frontend\tests\e2e\wave1-split-characterization.spec.ts
```

## 6. 먼저 물어야 할 것 (blocking)

🔴 **커밋 단위를 어떻게 나눌지.**

부분 커밋은 CI 를 깬다 — `frontend/tests/unit/binaryFrameIntakeWiring.test.ts` 가 미커밋 상태인 `WebSocketContext.tsx` 의 소스 텍스트를 검사한다. 전부 커밋하면 남의 미커밋 델타를 쓸어간다.

⚠️ **`git commit` 은 인덱스 전체를 커밋한다.** 경로를 지정해 `git add` 해도 소용없다. 반드시 `git commit -- <경로들>` 형태로 쓸 것.

선택지:
- (a) 이 작업의 파일만 `git commit -- <경로 나열>` 로 커밋 (위 「워킹트리 상태」의 세 목록 전부)
- (b) 커밋하지 않고 다음 세션으로 계속 넘김
- (c) 다른 것

## 7. 남은 작업 전체 목록

### A. codex 워크스페이스 전환 시 세션 종료 오진단 (사용자 신규 지시, 2026-08-29)

- [ ] **A. codex 에이전트 실행 중 워크스페이스를 전환했다가 돌아오면 "세션이 종료되었습니다" 상태가 된다.**
  - **증상**: codex 에이전트가 실행 중인 터미널 세션에서 다른 워크스페이스로 갔다가 돌아오면 세션이 종료된 것으로 표시된다. 실제 PTY 프로세스가 죽은 것인지, UI 가 오진단하는 것인지는 **미확인**이다.
  - **완료 조건**: ① 재현 절차를 하나 확정한다 ② PTY 가 실제로 죽는지, 아니면 살아 있는데 UI/서버가 죽었다고 판정하는지를 **로그·프로세스 목록으로 구분**해 확정한다 ③ 근본 원인을 파일:줄로 지목한다 ④ 재현하는 실패 테스트를 먼저 쓰고 고친다.
  - **조사 출발점 (추정, 미검증)**: 워크스페이스 전환은 구독 해제/재구독을 유발한다. `server/src/ws/WsRouter.ts` 의 `handleUnsubscribe`(`:2771`)와 세션 종료 판정 경로, `server/src/services/SessionManager.ts` 의 세션 정리 경로(`this.sessions.delete(sessionId)` 는 `:6598` 부근 한 곳뿐), 프론트의 `frontend/src/hooks/useWorkspaceManager.ts` 를 볼 것.
  - ⚠️ 이 항목은 이번 세션에서 **전혀 조사하지 않았다.** 위 출발점은 추정이다.
  - **추가 단서 (2026-08-29 실측, 연관 여부는 추정)**: 프로덕션 데몬을 `node tools/start-runtime.js stop` 으로 정식 종료했을 때 아래가 출력됐다.

    ```
    [stop] Session cleanup attempted=11 completed=0 degraded=0 skippedUnverified=11 remainingVerifiedDescendants=0
    [stop] WARNING: session cleanup skipped-unverified=11
    ```

    세션 11개의 정리가 **전부 `skippedUnverified`** 이고 `completed=0` 이다. 즉 세션의 생사를 **검증하지 못해** 정리를 건너뛴다. codex 항목도 세션 수명 판정 문제이므로 같은 판정 경로를 공유할 가능성이 있다 — **다만 이것은 추정이고 연관성을 확인하지 않았다.** `skippedUnverified` 를 내는 코드를 찾아 그 판정 기준을 먼저 읽어 보라.

### B. 사다리 상승 (S4-d 이후)

- [ ] **B1. S5 회계 재벤치 + 증거 번들 재발행 → `binary-optin`** — 정책 키 처분이 셋으로 갈린다(`docs/research/binary-comms/06-work-plan.md:909`): 바이트 도메인 5개(`socketSoftGateBytes`·`bulkSliceBytes`·`smallOutputBypassBytes`·`creditWindowBytes`·`queueMaxBytes`)는 재측정, `strategy`·`visibilityWeight`·`driverWeight` 는 재귀속, `ackTimeoutMs` 는 시간 도메인이라 별도. `bulkSliceBytes` 는 한 키가 두 도메인에 걸쳐 각각 재측정이 필요하다
- [ ] **B2. S6 혼합 버전 + 롤백 드릴 → `binary` 기본값 전환** — 이탈 조건에 **두 릴리스 soak**(달력 시간)이 포함되어 개발 속도로 앞당길 수 없다
- [ ] **B3. S7 legacy JSON 인코딩 경로 제거** — 이슈 #22 조건 + 달력 두 릴리스. JSON control 평면은 제거 대상이 아니다
- [ ] **B4. C6 마이크로벤치 + 동등성** — 선행: 위 전부

### C. 운영 결함 (이번 세션에 발견, 미수정)

- [ ] **C1. 데몬 로그가 로테이션 없이 3.14 GB 로 자랐다** — `C:\Work\git\_Snoworca\ProjectMaster\runtime\buildergate-daemon.log`. E2E 부하 중 GB 단위 로그를 계속 쓰는 것이 열화 요인이며 독립적으로도 결함이다
- [ ] **C2. 프로덕션 앱이 E2E 실행 중 죽고 sentinel 이 재시작했다** — `runtime/buildergate.daemon.json` 의 `restartCount = 1`, `lastExitCode = "app PID 47776 is not running"`, `lastRestartAt = 2026-08-29T00:42:22.432Z`. `fatalReason` 은 `None` 이라 **사인은 미확인**이다
- [ ] **C3. `VALIDATION_LIMITS.MAX_COLS`/`MAX_ROWS` 가 사용처 0건** — `server/src/utils/constants.ts:131-137`. resize 경로 어디에도 상한 검사가 없다. 이것을 강제하면 B2 #4 의 uint32 결정을 다시 열 수 있다

### D. 문서·이슈 (코드 무관)

⚠️ `C:\Work\git\_Snoworca\ProjectMaster\CLAUDE.local.md` 규칙 1: 사용자가 직접 지시하지 않으면 문서를 자동으로 검증·개선하지 않는다. 아래는 **지시가 있을 때만** 한다.

- [ ] `docs/research/binary-comms/06-work-plan.md` §S4-0b 가 #2·#3 을 여전히 열린 항목으로 싣는다 (`07` 이 2026-08-19 에 닫음)
- [ ] `06-work-plan.md` 가 `01` 을 인용한 앵커 중 최소 2건이 낡았다 — `01:810-835`(실제 `:888-890`), `01:1066-1081`(실제 `codec-epoch-retired` 서술은 `:1193`)
- [ ] `08:145`·`08:207-210`·`08:226`·`01:1308`·`05:545` 의 낡은 앵커·불일치
- [ ] GitHub 이슈 #2·#19·#20·#21·#22 가 폐기된 측정 게이트를 언급

## 8. 검증 결과 (전부 2026-08-28~29 실행)

| 명령 (cwd 명시) | 결과 |
| --- | --- |
| `cd C:/Work/git/_Snoworca/ProjectMaster/server` 에서 `find src -name "*.test.ts"` 전건 `env -u NODE_ENV npx tsx --test <파일>` | **52파일 / pass 878 / fail 24** — 24건 전부 기존 실패, **신규 red 0** |
| `cd C:/Work/git/_Snoworca/ProjectMaster/frontend` 에서 `tests/unit/*.test.ts` 전건 `env -u NODE_ENV node --experimental-strip-types --test <파일>` | **74파일 / pass 888 / fail 6** — 실패 4파일 집합이 기준선과 동일 |
| `cd C:/Work/git/_Snoworca/ProjectMaster/server && env -u NODE_ENV npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `cd C:/Work/git/_Snoworca/ProjectMaster/frontend && env -u NODE_ENV npx tsc -p tsconfig.app.json --noEmit` | exit 0 |
| `cd C:/Work/git/_Snoworca/ProjectMaster/frontend && env -u NODE_ENV npm run typecheck:tests` | exit 0 |
| `cd C:/Work/git/_Snoworca/ProjectMaster/server && env -u NODE_ENV npm run build` | exit 0 |

⚠️ **서버 스윕에 flaky 가 하나 더 있다.** 독립 검증에서 같은 스윕이 `pass 877 / fail 25` 로 나왔고, 초과분 1건은 `server/src/benchmarks/FairSchedulerRuntimePolicyProfile.test.ts` 였다. 그 파일은 **단독 재실행 시 10/10 통과**한다(검증자가 프론트 스윕과 병행 실행한 경합으로 판단). 다음 세션이 25건을 보더라도 그 파일 하나면 새로 깬 것이 아니다.

**서버 기존 실패 24건의 귀속**: `TerminalAuthorityProductionRegression` 13(`CLAUDE.md` 가 문서화한 기지 실패) · `SessionManagerPartialEscapeTail` 5 · `TerminalResourcePolicy` 4 · `RetainedTerminalAuthority` 1 · `TerminalResourcePolicyCanary` 1.

- `RetainedTerminalAuthority` 의 1건(`RED reviewer — populated Ordinal64 rollover…`)은 소스 편집을 되돌린 대조군에서도 동일하게 실패해 기존 실패로 확정했다.
- `TerminalResourcePolicy` 의 4번째는 남의 미커밋 프론트 델타(`terminalOutputScheduler.ts` 의 `enqueueLegacy` → `enqueueBytesLegacy` 이동)가 원인이다.

**프론트 기존 실패 6건**: `terminalCheckpointRuntime.test.ts` 3 · `terminalContainerRecoveryContract.test.ts` 1 · `terminalHiddenOutput.test.ts` 1 · `wsCheckpointProtocol.test.ts` 1.

### 8.1 E2E

프로덕션 번들(`node tools/start-runtime.js --port 2222`) 대상, `--project="Desktop Chrome"`, 5개 spec 결합: **22 passed / 15+ failed (28.2분)**.

실패는 전부 귀속을 확정했고 **제 편집과 무관하다** — 추가한 단언이 두 실행 모두에서 **한 번도 발화하지 않았다**.

| 실패 | 귀속 근거 |
| --- | --- |
| `terminal-authority` TC-7101·TC-7103 | 편집을 되돌린 대조군에서 `passed=0 failed=2` 로 **동일** |
| `wave1-retained-state` AC-1~7·REL-BGSTAB-012 | 대조군에서 `passed=5 failed=2` 로 **동일** |
| `wave1-split` REL-BGSTAB-006 AC-2 | 고정 문자열 ``return `${protocol}//${host}/ws?token=`` 이 소스에 0건 — `getWsUrl` 이 `buildControlWebSocketUrl` 로 바뀐 남의 미커밋 델타 때문 |
| `grid-equal-mode` 10건 | **서버 가용성**. 실패 사유가 `net::ERR_CONNECTION_REFUSED` / `Failed to fetch` / workspace API `500` 이다. 단독 재실행에서는 5건만 실패했고 **실패 집합이 서로 다르다**(TC-6603·6613 은 결합에서 통과, TC-6599·6600·6606·6608·6609·6610 은 단독에서 통과) → flaky |

⚠️ **dev 번들 대비**: dev 번들 실행은 32 passed / 6 failed 였다. 갈린 것은 `grid-equal-mode` 뿐이고, 그 원인이 위의 서버 재시작이다.

### 8.2 B1 단언이 공허하지 않다는 증거

계수가 0 인 동안에는 단언이 발화하지 않으므로 결함 주입으로 발화 가능성을 확인했다. 각 지점마다 결함 없는 대조군(침묵)과 결함 주입(발화)을 한 쌍으로 측정했고 **5/5 전부 발화**했다.

이 과정에서 실제 결함 두 건을 잡았다.
1. AC-6 하네스의 단언이 **도달 불가능**했다 — 파싱이 실패하면 `page.evaluate` 가 먼저 거부된다. 실패 경로로 옮겼다.
2. `wave1-split` 의 단언이 poll 뒤에 있었다 — 프레임을 못 읽으면 소켓 식별 poll 이 먼저 타임아웃해 "프로덕션 소켓 없음"으로 오보한다. poll 실패 시 원인을 먼저 지명하도록 바꿨다.

## 9. 거버넌스·게이트·함정

- **`kill <pid>` / `taskkill /F /IM node.exe` 절대 금지.** dev 서버 포트는 항상 **2222**. 이번 세션은 사용자가 "제가 시작한 PID 만 지목해 종료" 를 명시 승인했을 때만 종료했다
- **커밋 메시지에 어떤 시그니처도 넣지 않는다.** 제목에 `Phase n`/`Step n`/`TASK-XXX` 도 금지
- 🔴 **셸에 `BUILDERGATE_*` 15개 + `NODE_ENV=production` 이 있고 다른 설치본(`C:\Work\agent-tools\builder-gate__`)을 가리킨다.** 이것을 지우지 않고 서버를 띄우면 그 설치본의 `config.json5`(`twoFactor.enabled: true`)를 읽어 E2E `login()` 이 2FA 단계에서 멈춘다. **서버 기동·테스트·Playwright 전부 `env -u NODE_ENV -u BUILDERGATE_*` 로 실행할 것**
- 🔴 **프로덕션 런타임의 싱글턴 충돌도 같은 원인이었다.** 상속된 `BUILDERGATE_DAEMON_STATE_PATH` 가 다른 설치본의 상태 파일을 가리켜 남의 데몬을 자기 것으로 착각하고 거부한다. 깨끗한 환경에서는 `statePath = C:\Work\git\_Snoworca\ProjectMaster\runtime\buildergate.daemon.json` 으로 해석되어 충돌하지 않는다. **2002 의 남의 데몬은 건드릴 필요가 없다**
- 🔴 **뮤테이션 하네스가 provenance 핀 파일에서 공허하게 KILLED 를 낸다.** 핀 소스(`server/src/ws/WsRouter.ts`·`wsSendPolicy.ts` 등 6개)를 건드리면 published generation 이 무효화되어 capability admission 게이트가 닫히고, 그 게이트를 타는 스펙은 뮤턴트와 무관하게 빨개진다. **모든 하네스에 "살아남아야 하는 대조 뮤턴트"를 넣고, 대조군이 KILLED 로 나온 판정은 전부 폐기할 것.** 실제로 이번 세션에 4/4 KILLED 보고가 나왔다가 그 스펙을 빼자 2건이 살아남았다
- **핀 파일을 편집할 때마다 authority generation 을 재발행한다.** 절차: `publishFairSchedulerAuthorityGeneration`(워크로드 `{clients:[1,2,8], wanLatencyMs:150, wanJitterMs:20, wanLossPercent:0, seed:20260723, repeats:5, samples:30}`, `authorityRoot = C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority`) → `server` 에서 `npm run build`. 약 6초. 최종 상태에서 워킹트리·`dist`·decision artifact 의 `sourceDigest` 가 셋 다 일치하는지 확인할 것
- 🔴 **하네스는 앵커를 전부 사전 검증하고 `finally` 로 복원해야 한다.** 중간에 죽으면 프로덕션 파일에 뮤턴트가 남고, 다음 실행이 그 오염된 파일을 "original" 로 삼아 `restored: OK` 를 보고한다. 이번 세션에 실제로 `WsRouter.ts` 에 `?? 'binary'` 가 남아 있었다
- 🔴 **치환 앵커가 다른 줄의 접미사와도 일치할 수 있다.** 이번 세션에 10칸 들여쓰기 앵커가 12칸 줄의 접미사와 일치해 한 지점에 두 번 적용되고, 의도한 두 번째 지점은 누락됐다. **치환 후 반드시 결과를 눈으로 확인할 것**
- **`cd` 가 Bash 호출 간에 유지된다.** 이번 세션에 세 번 밟았다. **매 호출마다 절대경로 `cd` 를 쓸 것**
- **node 의 `ℹ` 는 멀티바이트다.** `grep "^. pass"` 로 파싱하면 조용히 0건이 된다. `grep -oE "pass [0-9]+" | tail -1` 을 쓸 것
- 🔴 **`npx tsx --test` 는 타입을 검사하지 않는다.** 서버 테스트를 쓴 뒤 반드시 `tsc` 를 따로 돌릴 것
- 🔴 **`npm run typecheck:tests` 는 새 테스트 파일을 보지 않는다.** `frontend/tsconfig.test.json` 의 `files` 는 손으로 늘리는 허용목록이다. **테스트 파일을 새로 만들면 그 자리에서 `files` 에 추가할 것**
- 🔴 **E2E spec 은 어떤 tsconfig 도 검사하지 않는다.** 여러 spec 을 한 프로그램으로 묶어 컴파일하면 서로의 `declare global` 이 충돌해 기존 오류가 쏟아진다. **파일별로 따로 검사할 것**
- **Playwright 를 `spawnSync` 로 부를 때 배열 인자 + `shell: true` 는 `--project="Desktop Chrome"` 의 공백을 쪼갠다.** 단일 명령 문자열로 쓰고, `-g "A|B"` 의 `|` 도 반드시 따옴표로 감쌀 것. 그리고 **"0개 수집" 을 감지해 실패시킬 것** — 아니면 `passed=0 failed=0` 이 통과처럼 보인다
- **백그라운드 명령의 출력을 `tail -N` 으로 파이프하지 마라.** 이번 세션에 28분짜리 E2E 의 실패 사유가 통째로 사라졌고 `test-results/` 에는 페이지 스냅샷만 남아 복원할 수 없었다. **파일로 리다이렉트할 것**
- **PowerShell 로 프로세스를 필터링할 때 자기 자신을 제외하라.** 명령 문자열에 저장소 경로가 들어가 있어 필터에 걸리면 자기 셸을 죽인다. 이번 세션에 한 번 밟았다

## 10. 관련 문서·코드 (절대경로)

| 문서 | 절대경로 | 역할 |
| --- | --- | --- |
| SSOT (작업 계획) | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\06-work-plan.md` | S0~S7 단계 정의 |
| SSOT (프레임 사양) | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\01-frame-format-and-negotiation.md` | 프레임·협상·채널의 정본. **1622줄을 유지해야 한다** |
| 프롤로그 부록 | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\07-prologue-spec-remaining-opcodes.md` | `0x03`~`0x07` 프롤로그. §2.6.1 이 `responderLeaseId` 슬롯을 정한다 |
| 롤아웃 사다리 | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\05-test-migration-rollback.md` | §8.2 가 4단계 진입·이탈 조건 |
| 클라이언트 배선 설계 | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\08-client-wiring-design.md` | C0~C6. 낡은 앵커 있음 |
| 이번 세션 보고서 | `C:\Work\git\_Snoworca\ProjectMaster\docs\report\2026-08-28.binary-data-plane-s4-wiring.md` | A1~A10·B1·B2 전건의 설계 근거와 검증 |
| 선행 핸드오프 | `C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-08-27-binary-data-plane-s4-completion.md` | 8개 순수 모듈의 설계 근거 |
| 작업 로그 | `C:\Work\git\_Snoworca\ProjectMaster\docs\worklog\2026-08-28.jsonl` | 이번 세션 5개 항목 |

**신규 모듈 (이번 세션)**:

- `C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\wirePayload.ts` — `WirePayload` 유니온 · `encodeFor` · `jsonWirePayloadText` · `wirePayloadByteLength`
- `C:\Work\git\_Snoworca\ProjectMaster\server\src\ws\terminalWireShadowComparator.ts` — `compareTerminalWireEncoding` (shadow 등가 비교)

## 11. 리스크·잔존 이슈

- **커밋되지 않은 상태로 세션이 세 번 넘어갔다.** 이 작업의 산출물이 `??` 와 ` M` 로만 존재한다. 공유 워킹트리이므로 남이 같은 파일을 만지면 충돌한다
- **바이너리 갈래는 "게이트가 닫혀 있어 도달 불가"다.** `terminalWireFormat` 기본값 `json` 이 그 게이트다. 설정을 올리는 순간 도달 가능해진다
- **바이너리 프레임이 grace 버퍼에 들어가지 못한다.** 세션 핸들러가 붙어 있지 않은 순간 도착한 프레임은 버려진다. `GraceBufferedSessionState.output` 의 타입이 `TerminalOutputMessage[]` 라 `TerminalOutputDelivery` 를 담을 수 없다
- **서브에이전트 5회 위임 중 2회 회신, 3회 기권.** 회신한 2건도 하중 주장을 재검증하니 각각 한 군데씩 틀렸다 — 하나는 존재하지 않는 프론트 가드를 인용했고, 다른 하나는 공허화 대상을 잘못 지목했다. **위임 결과는 반드시 현재 소스로 재확인할 것**
- **프로덕션 데몬은 정리되어 있다.** 이 문서를 쓴 뒤 사용자 지시로 `node tools/start-runtime.js stop` 을 실행해 정식 종료했다 — 포트 2221·2222·2223 전부 free, `/health` 무응답. 다음 세션이 E2E 를 돌리려면 다시 띄워야 한다(기동 방법은 위 「거버넌스·게이트·함정」의 `BUILDERGATE_*` 항목 참조).
  - 종료 출력에 경고가 있었다: `Session cleanup attempted=11 completed=0 degraded=0 skippedUnverified=11`. 위 작업 A 의 단서와 같은 항목이다.
  - `runtime/buildergate-daemon.log` 는 로테이션 없이 **3 GB 대**로 자랐다(2026-08-29 측정 시점 약 3.39 GB, 십진). 다시 띄우면 계속 자란다
