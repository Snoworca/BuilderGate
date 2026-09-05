# S5-c0 ACK 도메인 전환 — 세션 핸드오프

| Field | Value |
| --- | --- |
| 작성일 | 2026-09-05 |
| 저장소 / 브랜치 | `C:\Work\git\_Snoworca\ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| 최종 작업 목표 | delivery ACK 의 정산 기준을 lane 스코프 `deliverySeq` 에서 세션 스코프 `sourceSeq` 로 옮긴다 |
| 현재 상태 | 작업 4건 중 #1(사이드카 승격)만 완료·커밋됨. #2~#4 미착수 |
| SSOT | `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\06-work-plan.md` 의 `#### S5-c0.` 절 |
| 다음 세션 첫 행동 | 아래 "0. 다음 세션의 첫 행동" 참조 |

이 문서에서 `<REPO>` 는 `C:\Work\git\_Snoworca\ProjectMaster` 를 가리킨다.

---

## 0. 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. `<REPO>\docs\research\binary-comms\06-work-plan.md` 에서 `#### S5-c0.` 을 검색해 그 절을 정독한다. **그 절의 줄 번호 인용은 현재 트리와 어긋나 있다** — 아래 "SSOT 줄 번호 드리프트" 참조.
3. `git log --oneline -3` 과 `git status --porcelain` 으로 아래 "3. 현재 상태" 와 일치하는지 확인한다.
4. **착수 전에 아래 "5. 확정된 결정" 을 반드시 읽는다.** 그 다섯 항목은 이미 조사 비용을 치르고 내린 결론이며, 그중 둘은 연구 문서의 서술을 뒤집은 것이다.
5. 작업 #2 부터 시작한다. **#2 는 `SessionManager` 까지 배선해야 끝나므로 중간에 멈추면 `tsc` 가 59건 깨진 채로 남는다.**

---

## 1. 최종 작업 목표

클라이언트가 ACK 할 때 기준으로 삼는 시퀀스를 lane 스코프 `deliverySeq` 에서 세션 스코프 `sourceSeq` 로 옮긴다. 근거는 `PERF-BGSTAB-011` AC-10(`<REPO>\docs\spec\30.buildergate-stability.srs.md:5144`)의 *"delivery 정산은 프레임 헤더의 `sourceSeq` 를 기준으로 수행되어야 한다"* 이다. 다만 그 조항은 **batching 이 서로 다른 session 의 프레임을 섞을 때**를 조건으로 달고 있고 batching 은 아직 없으므로, 이 작업은 S5-c(`binary-optin`) 진입 직전에 완결되면 된다.

⚠️ **`IR-BGSTAB-001` 의 AC-10 은 다른 조항이다** — 그것은 `:5007` 이고 `encodedBytes` 원장 도메인을 규정한다. 두 요구사항이 같은 번호의 AC 를 갖고 있으니 인용할 때 블록을 확인할 것.

완료 조건은 셋이다.

- SSOT 가 제시한 작업 4건이 전부 들어간다
- 새 lane 의 **첫 ACK 와 두 번째 ACK 를 둘 다** 단정하는 테스트가 있다 (아래 "6. 필수 경계 대조군")
- 핀 재발행 2건이 함께 커밋된다

---

## 2. 이번 세션에 완료한 것

### S5-c0 작업 #1 — 커밋 `808d3fb`

`WsTransportMessage` 에 `sourceSeq?: string` 를 사이드카로 승격했다. 승격 가드는 canonical unsigned decimal(`/^(0|[1-9][0-9]*)$/u`)만 통과시키며, 그 경계 대조군이 `<REPO>\server\src\ws\wsTransportSidecar.test.ts` 에 있다(거부 8종 · 수용 4종).

재발행 2건을 함께 커밋했고, 재생성된 decision artifact 는 **`sourceDigest` 하나만 달랐다**. 측정 quantile 이 전부 비트 단위로 같았으므로 사이드카 추가가 스케줄링을 건드리지 않았음이 확인된다.

### 이번 세션의 다른 완료 작업

| 작업 | 커밋 |
| --- | --- |
| S5-a0 `encodedBytes` 본문 도메인 전환 | `3bc3111` · `ec1723c` · `eb28adb` |
| S5-a policy 키 집합·source 리터럴 단정 | `811c130` · `563666f` |
| `IR-BGSTAB-001` AC-8 런타임 설정 노출 | `2f8ece1` · `8a33281` |
| S5-b `IR-BGSTAB-002` 신설과 양측 전환 | `d6d3822` · `3a79676` · `9ba8f93` · `51a96ea` · `baeecc3` · `1731325` · `727a6c7` |

---

## 3. 현재 상태

`HEAD` 는 `808d3fb` 이고 origin 과 같다. 추적 파일 변경은 이 문서와 `docs/next/LATEST.md` 둘뿐이며, 그 둘을 커밋하면 0건이 된다.

미추적 7개(`.codex/config.toml`, `CLAUDE.local.md`, `t1_verdict_*.txt` 2개, `t2_verdict_*.txt` 3개)는 이전 세션들에서 커밋 제외로 확정된 것이므로 건드리지 않는다.

⚠️ **이 저장소는 여러 세션이 공유한다.** `git stash` · `git checkout` · `git reset` 을 워킹트리에 쓰지 않는다. mutate → run → restore 는 스크래치 백업과 sha256 대조로 한다.

---

## 4. 남은 작업 4건 중 3건

SSOT 가 표로 제시한 것에 이번 조사가 하나를 더했다.

| # | 작업 | 위치 |
| --- | --- | --- |
| ~~1~~ | ~~`WsTransportMessage` 에 `sourceSeq` 사이드카 승격~~ | **완료 (`808d3fb`)** |
| 2 | `FairTerminalDeliveryInput` / `FairTerminalDelivery` 에 `sourceSeq` 부착 | `<REPO>\server\src\ws\wsSendPolicy.ts` |
| 3 | `acknowledge` 를 `deliverySeq \| sourceSeq` 판별 유니온으로 | 같은 파일 |
| 4 | `TerminalDeliveryAckMessage` 변형 추가 + 프론트 사본 | `<REPO>\server\src\types\ws-protocol.ts` |
| **3b** | **`ACK_OVER_ACK` 천장도 함께 도메인 전환** | 같은 파일. **SSOT 가 빠뜨렸다** — 아래 참조 |

### 작업 #2 를 이번 세션에 착수했다가 되돌린 이유

`FairTerminalDeliveryInput.sourceSeq` 를 필수 필드로 추가하면 `tsc --noEmit` 이 **정확히 59건** 깨진다. 분포는 `FairTerminalDeliveryScheduler.test.ts` 52건, `terminalFairnessCharacterization.ts` 5건, `WsRouter.ts` 2건이다(2026-09-05 실측). ⚠️ 미검증 — 그 변경을 되돌렸으므로 재현하려면 필수 필드를 다시 추가해야 한다. 현재 트리의 `tsc` 는 오류 0건이다.

프로덕션 7건을 채우려면 `WsRouter.ts:5310`(output)과 `:5280`(dataGap)이 값을 가져야 하고, 그 값은 `OutputAuthorityMetadata`(`WsRouter.ts:244`)를 통해 `SessionManager` 가 넣어야 한다. 즉 **#2 는 한 파일의 작업이 아니다.** 중간에 멈추면 타입과 호출부가 어긋난 채로 남으므로, 되돌리고 온전한 상태로 넘긴다.

---

## 5. 확정된 결정 (변경 금지)

이번 세션의 조사가 내린 결론이며 **두 항목은 연구 문서의 서술을 뒤집은 것**이다.

1. **경로는 "delivery 가 값을 데려온다" 로 한다** — **확정**. `getLane` 이 세션을 조회하거나 스케줄러가 콜백을 받는 안은 같은 값을 두 번째 경로로 또 가져오는 것이라, 조회 시점의 세션 값과 실제 첫 delivery 의 값이 다른 출처가 되어 사이에 출력이 하나만 끼어도 어긋난다. 작업 #1·#2 가 들어가면 `enqueue` 는 이미 그 값을 손에 쥐므로 추가 배선이 0이다.

2. **새 ACK 도메인은 권한 뷰 lane 에만 적용한다** — **확정**. `routeSessionOutput` 의 프로덕션 호출부 다섯 중 **둘(`SessionManager.ts:7682` 저하 모드 상시 경로, `:7738` 큐 오버플로 청크)은 대응 ordinal 을 아예 갖지 못한다.** 그 출력들은 `queueAcceptedHeadlessOutput` 에 도달하기 전에 거부되어 ordinal 이 예약된 적이 없고, 그 시점에 필드를 읽으면 직전에 수락된 **다른** 출력의 ordinal 이 나온다. 그 둘은 전부 `audience: 'legacy-unnegotiated'` 이고 `WsRouter.ts:5145-5148` 이 권한 뷰 등록 클라이언트를 건너뛰므로, 범위를 좁히면 자연히 제외된다.

   ⚠️ `:7682` 는 드문 경로가 아니다. `headlessHealth` 를 `healthy` 로 되돌리는 자리가 세션 생성과 디버그 격리뿐이라, **한 번 저하되면 그 세션의 남은 출력 전량**이 그 경로를 탄다.

3. **`sourceSeq` 를 선택 인자로 두지 않는다** — **확정**. `routeSessionOutput` 의 호출부 집합은 고정된 적이 없다(구버전 워크트리와 배포 백업은 **넷**이고 `audience` 인자 자체가 없다). 선택 인자면 앞으로 추가되는 호출부가 조용히 값 없이 통과하고 그 기본값 갈래가 뮤테이션에서 살아남는다.

4. **출처는 `SessionData.nextTerminalAuthoritySourceSeq` 이며 `retained.sourceSeq` 가 아니다** — **확정**. 다만 근거가 앞선 판정과 다르다. **롤오버 축에서는 둘 다 0 으로 돌아간다** — 같은 `advanceRetainedTerminalOrdinal` 을 쓰므로 uint64 소진 시 함께 리셋된다. 두 값을 가르는 진짜 차이는 (a) `retained.sourceSeq` 는 **거부된 출력에도** 전진하고 (b) shadow 모드가 아니면 전진하지 않는 경로가 있다는 것이다.

   ⚠️ 권한 런타임 부착 시점(`SessionManager.ts:4929`·`:5066`)에 `nextTerminalAuthoritySourceSeq` 가 상향 클램프로 **불연속 점프**한다. ACK 설계가 이것을 감당해야 한다.

5. **`ACK_OVER_ACK` 천장을 함께 전환한다** — **확정**. SSOT 작업표 #3 은 `acknowledge` 를 판별 유니온으로 만들라고만 적고 이 천장을 언급하지 않는다. `nextDeliverySeq - 1` 이 lane 카운터로 남으면 **모든 정상 ACK 가 거절되어** `ackTimeoutMs` fallback 이 상시 발동한다.

### 연구 문서가 틀린 곳

`docs/research/binary-comms/01-frame-format-and-negotiation.md` 의 §2.4(a)가 *"새 lane 의 첫 ACK 가 과거 전체를 정산해 버린다"* 고 적었으나 **현행 자료구조에서는 성립하지 않는다.** 정산 대상은 `lane.sent` 배열이고 새 lane 의 그것은 비어 있다.

실제로 깨지는 것은 정산량이 아니라 **가드**다.

| 검사 | 초기값이 틀렸을 때 |
| --- | --- |
| `input <= lane.lastAcknowledgedSeq` → `ACK_DUPLICATE` | 가드가 공허해져 낮은 seq 가 통과하고 값을 **후퇴 설정**한다 |
| `input > lane.nextDeliverySeq - 1` → `ACK_OVER_ACK` | 반대로 **모든 정상 ACK 를 거절**한다 |
| `input > lane.lastSentSeq` → `ACK_OUT_OF_ORDER` | `sendOne` 이 매 전송마다 덮으므로 자기교정된다 |

**이 구분이 테스트 설계를 바꾼다 — `creditedBytes` 만 단언하는 테스트는 초기값이 틀려도 green 으로 통과한다.**

---

## 6. 필수 경계 대조군

SSOT 가 못박은 것이다. **새 lane 의 첫 ACK 와 두 번째 ACK 를 둘 다 단정한다.** `FairTerminalDeliveryScheduler.test.ts` 의 기존 크레딧 테스트는 첫 ACK 만 보므로 `lane.lastAcknowledgedSeq === 0` 이라 델타와 누적 총액이 우연히 일치해 오류를 못 잡는다. 도메인 전환 테스트에서 같은 사각지대를 반복하면 그 테스트도 공허하다.

같은 파일의 `Fair delivery scheduler and ACK credit RED contract — PERF-BGSTAB-010 AC-5` 테스트가 이번 세션에 두 번째 ACK 를 갖추었으니 그 형태를 참고한다.

---

## 7. 착수 전 확인이 남은 것

- **`PendingHeadlessOutput` 에 예약 ordinal 필드가 없다** (`SessionManager.ts:399-414`). 조사 판정으로 `SessionManager.ts:4536`·`:7883`·`:7888` 세 호출부는 대응 ordinal 이 실재하나 **호출 시점에 필드를 읽어서는 얻을 수 없다**(그 사이 큐잉된 출력만큼 앞서 있다). `:4536` 은 클로저의 `reservedAuthorityOrdinal` 로, `:7888` 은 컨트롤러 record 로 되찾을 수 있고, `:7883` 은 현재 어느 쪽으로도 못 얻으므로 필드 추가가 필요하다.
- **`WsRouter.ts:5280` 의 dataGap 이 어떤 ordinal 을 가져야 하는지** 미정이다. 라우터가 만드는 메시지라 세션 ordinal 과의 대응이 자명하지 않다.

---

## 8. SSOT 줄 번호 드리프트

아래 인용들이 현재 트리와 어긋나 있다(2026-09-05 실측). 착수 시 재측정할 것.

앞의 네 행은 `#### S5-c0.` 절에서 왔고, `fairLaneKey` 와 lane 리셋 두 행은 그 절에 없다 — 출처는 `docs/research/binary-comms/01-frame-format-and-negotiation.md:446` 과 `:817` 이다.

⚠️ **"현재" 열은 `808d3fb` 이후 값이다.** 그 커밋이 `wsSendPolicy.ts` 에 16줄을 더했으므로, 그 이전에 적힌 줄 번호를 보면 전부 16 을 더해야 한다.

| SSOT 인용 | 현재 |
| --- | --- |
| `createWsTransportMessage` `85-131` | `:117` |
| `FairTerminalDeliveryInput` `500-519` | `:541` |
| `acknowledge` `838-853` | `:871-887` |
| `fairLaneKey` `578` | `:627` |
| lane 리셋 `644` | `:686` |
| `01:742` (연구 문서) | 그 파일 `:817` |

---

## 9. 거버넌스·게이트·함정

**규칙**

- dev 서버 포트는 항상 2222. `kill {pid}` 와 `taskkill /F /IM node.exe` 금지
- 연구·계획은 서브에이전트에 위임(모델 opus5). 검증도 서브에이전트
- 커밋 메시지에 시그니처 금지, 제목에 `Phase N`·`Step N`·`TASK-XXX` 금지
- 코드 주석은 검증 범위에서 제외
- 결정 게이트는 묻지 말고 권장안을 자동 선택

### 핀 재발행은 두 곳이다

`wsSendPolicy.ts` · `WsRouter.ts` · `terminalFairnessCharacterization.ts` 가 모두 핀 파일이므로, 작업 #2~#4 는 **셋 다 건드린다.** 재발행 절차는 다음과 같다.

1. **authority generation 재게시** — `publishFairSchedulerAuthorityGeneration` 을 `authorityRoot: '../docs/analysis/terminal-fairness-authority'`, `clients: [1,2,8]`, `wanLatencyMs: 150`, `wanJitterMs: 20`, `wanLossPercent: 0`, `seed: 20260723`, `repeats: 5`, `samples: 30` 으로 호출한다. 프로덕션 스크립트가 없으므로 스크래치에 `.mjs` 를 만들어 **cwd=`server/`** 에서 tsx 로 돌린다. 약 2.2초에 끝난다(⚠️ 미검증 — 재실행하면 새 세대를 쓰므로 재측정하지 않았다).
2. **consumer manifest 재봉인** — `node server/node_modules/tsx/dist/cli.mjs tools/wave3/terminal-resource-consumer-manifest-reseal.ts --reseal` (repo root). 인자 없이 돌리면 dry-run 이다.

**새 generation 디렉터리의 18개 파일을 반드시 함께 커밋한다.** 빼면 `write-fair-scheduler-evidence-bundle.mjs` 가 대상을 못 찾아 server build 가 깨진다. 기존 세대는 손대지 않는다 — append-only 아카이브다.

**재게시 후 `sourceDigest` 외에 바뀐 키가 있으면 스케줄링이 실제로 달라진 것이다.** 이번 작업 #1 에서는 그 하나만 바뀌었다.

### 그 밖의 함정

- **`Write` 툴이 `\x1b` 를 실제 ESC 제어문자로 파일에 쓴다.** 그러면 이후 셸을 거친 치환이 백슬래시를 잃어 고칠 수 없다(ESC 를 ESC 로 치환하는 무변화가 된다). 이스케이프 표기가 필요하면 `.cjs` 스크립트에서 `String.fromCharCode(0x5c) + 'u001b'` 로 조립한다.
- **정규식이나 특수문자가 든 치환은 반드시 `.cjs` 스크립트 파일로 한다.** `python -c` 든 heredoc 이든 셸을 거치면 백슬래시가 벗겨진다.
- **소스 텍스트를 계약으로 삼는 테스트는 주석까지 읽는다.** 금지어를 주석에 쓰면 red 가 된다. 주석을 걷어내고 코드만 보게 할 것.
- **광역 node:test 는 부하에서 흔들린다.** 프로세스를 띄우는 10~24초짜리 테스트 셋이 병렬 실행 시 타임아웃한다. 실패하면 그 파일만 단독으로 다시 돌려 판정한다. 서브에이전트가 동시에 테스트를 돌리는 동안에는 수집 자체가 615로 줄고 11건이 실패하기도 했다.
- **`git show --stat` 은 긴 경로를 `...` 로 축약한다.** 파일을 셀 때는 `--name-only` 를 쓴다.

**복붙 가능한 테스트 명령**

```
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs --test src/ws/FairTerminalDeliveryScheduler.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs --test src/ws/wsTransportSidecar.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/tsx/dist/cli.mjs src/test-runner.ts
cd C:\Work\git\_Snoworca\ProjectMaster\server && node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

광역 node:test 는 **exit code 를 믿을 수 없다.** `ℹ fail N` 요약 줄과 `✖ failing tests:` 목록을 봐야 한다.

---

## 10. 그 밖의 남은 작업

- **`IR-BGSTAB-002` AC-2 · AC-4** — 각각 binary 경로 배선과 capability 협상이 선행되어야 한다. 사유가 그 요구사항 블록의 Implementation Notes 에 2026-09-05 자로 기록되어 있다.
- **S5-a `bulkSliceBytes` 의 배치 상한 역할 재측정** — 와이어 도메인이라 `binary-optin` 이후다.
- **S5-b · S5-c** — SSOT `06-work-plan.md` §S5
- **`admission-gate` 시간 예산** — 이것이 해결되기 전에는 저장소에 green 인 closure 집합 게이트가 하나도 없다. 결정 방법: 사용자 확인
- **`lexical.test.mjs:95` 합계 단언 실질화** — 결정 방법: 사용자 확인
- **C2 · C4 · B3** — `<REPO>\docs\plan\2026-09-01.remaining-work-backlog.plan.md` 의 `:82` · `:84` · `:63`
- **숨김 탭 스크롤백 유실** — `<REPO>\docs\next\2026-09-02-long-red-suite-cleanup.md` 의 `:132` · `:154` · `:208`. 사용자 확인 필요
