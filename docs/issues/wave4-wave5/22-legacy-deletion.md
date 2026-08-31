# 두 번의 릴리스를 무사히 넘긴 뒤에야 옛 위험 코드를 진짜로 지우기

> 원문 제목: `[Orca][P10-B] 두 release soak 후 unsafe legacy terminal 경로 물리 제거`
> 원본 이슈: `Snoworca/BuilderGate#22` — https://github.com/Snoworca/BuilderGate/issues/22

## 한 줄 요약

새 터미널 경로가 기본값이 된 뒤 **최소 두 릴리스 동안 실사용에서 버티는 것을 확인하고 나서야** 옛 코드를 파일에서 실제로 지우는 작업이며, **기술적으로 준비됐다는 것만으로는 절대 닫을 수 없고 달력상의 시간이 필요한** 이슈다.

## 지금 무슨 문제가 있나요?

지금 BuilderGate 는 **새 코드와 옛 코드를 같이 배포하고 있다.** 옛 코드 중 일부는 단순히 낡은 게 아니라, wave-2~wave-4 가 애초에 고치려 했던 **위험한 동작** 그 자체다. 상한 없는 버퍼, 한 번에 다 쏟아붓는 flush, 코디네이터를 우회하는 직접 쓰기 같은 것들이다.

다만 — **2026-08 현재 실제 소스를 확인해 보면, 이슈에 적힌 삭제 대상 중 상당수는 이미 사라졌다.** wave-2~wave-4 가 진행되면서 "제거"가 아니라 "안전한 구현으로 교체"되는 방식으로 정리됐기 때문이다. 실제 상태는 아래와 같다.

### 이미 사라진 것 (확인 완료)

| 삭제 대상 | 현재 상태 | 근거 |
| --- | --- | --- |
| code-point encoder (코드포인트별 `TextEncoder.encode()`) | **이미 없음.** 모든 호출이 문자열 전체를 한 번에 인코딩한다 | `frontend/src/utils/terminalOutputHotPath.ts:11-13`, `terminalOutputScheduler.ts:810,1367,1460` |
| unbounded remount/restore buffer | **이미 상한 있음.** 바이트와 청크 수 양쪽으로 막고, 넘치면 `restore_pending_output_overflow` 를 낸다 | `frontend/src/components/Terminal/TerminalView.tsx:428-431`, `:1745-1778`; 기본 4 MiB / 512 chunks `frontend/src/utils/inputReliabilityMode.ts:70-71` |
| giant join/flush | **이미 없음.** 배열 전체를 join 해서 한 번에 쓰는 코드가 없다. 바이트 예산 단위로 잘라서 쓴다 | `frontend/src/utils/terminalOutputScheduler.ts:1156`, `:1308`; 기본 예산 262,144 B `inputReliabilityMode.ts:72` |
| recovery direct writer | **이미 없음.** `visibleOutputRecovery.ts` 에는 `term.write` 호출이 0건이다. 실제 xterm 쓰기는 코디네이터의 어댑터에만 있다 | `frontend/src/utils/terminalRawMutationAdapter.ts:82,87,89` ← `terminalWriteCoordinator.ts:1046,1050,1095,1101` |
| global FIFO (전역 터미널 FIFO) | **live 경로에서는 이미 없음.** 소켓별·세션별 lane 을 가진 fair scheduler 가 실제 경로다. FIFO 는 벤치마크 비교군으로만 남아 있다 | live: `server/src/ws/WsRouter.ts:542-546`, `:5143-5156`; 비교군: `server/src/benchmarks/terminalFairnessCharacterization.ts:1273`, `server/src/ws/wsSendPolicy.ts:929` |
| context-menu direct `sendInput` | **이미 없음.** 우클릭 메뉴의 붙여넣기는 클립보드 파사드를 거친다 | `frontend/src/utils/contextMenuBuilder.ts:126-132` → `frontend/src/App.tsx:488-489` → `TerminalContainer.tsx:2093` → `frontend/src/utils/terminalClipboardCoordinator.ts` |
| literal frontend scrollback | **이미 없음.** `scrollbackLines` 는 별도 버퍼가 아니라 xterm 의 `scrollback` 옵션 숫자로만 쓰인다 | `frontend/src/utils/terminalViewAttributes.ts:75-79` → `TerminalView.tsx:3121` |

### 아직 남아 있는 것 (진짜 삭제 대상)

**1. `terminal_snapshot_*` localStorage 계열 — 전부 살아 있다.**

- 키 접두사: `frontend/src/utils/terminalSnapshot.ts:1-2`, 중복 상수 `frontend/src/utils/inputReliabilityMode.ts:4`
- 파서: `terminalSnapshot.ts:109-163` (`parseTerminalViewportSnapshot`)
- quota(용량 초과) 복구: `terminalSnapshot.ts:175-192`, `:250-314`, `:338-407`
- tombstone(삭제 예약 표식): `terminalSnapshot.ts:409-505`, TTL 24시간 `:8`
- **local restore success authority**: 로컬 복원이 성공했다는 사실만으로 dirty 를 지우고 그 내용을 최신으로 채택하는 경로 — `TerminalView.tsx:2309-2338`, `frontend/src/utils/terminalHiddenOutput.ts:109`, `frontend/src/utils/visibleOutputRecovery.ts:1292`(`provisionalLocalState = false`)
- 호출부(같이 정리해야 하는 곳): `TerminalView.tsx:1405,1415,1435-1447,1472,2297,4178-4179`, `frontend/src/hooks/useWorkspaceManager.ts:49-56,314,324,499,549`(`clearTerminalSnapshot` → `markTerminalSnapshotForRemoval`)

이게 남아 있는 한 **"화면의 진실은 서버에 있다"는 단일 authority 원칙이 완성되지 않는다.** 브라우저가 자기 로컬 저장소만 보고 "복구 끝났다"고 판단할 수 있기 때문이다.

**2. inert 설정 — 일부만 실제로 inert 하다.**

- `resourceLimits.headless.writeLagWarnMs`, `writeBatchMaxBytes`: **진짜 inert.** 코드가 스스로 `applyBoundary: 'reserved-unapplied'` 라고 표시해 두었다 (`server/src/services/TerminalResourcePolicy.ts:102-103`). 스키마·타입 레이어에만 존재하며 런타임 capability 는 명시적으로 `available: false` 다 (`server/src/services/RuntimeConfigStore.ts:145-146` 의 `RESERVED_WAVE6_SETTING_KEYS` 가 두 키를 모두 담아 `available: false` 를 강제한다; `writeLagWarnMs` 는 `RuntimeConfigStore.test.ts:114` 가 단언한다).
  같이 지워야 하는 선언 지점: `server/src/schemas/config.schema.ts:116-117`, `server/src/types/config.types.ts:124-125`, `frontend/src/types/settings.ts:27-28,80-81`. ⚠️ 같은 파일의 `:54-55` 와 `:119-120` 은 **telemetry 필드**(`sampleIntervalMs` / `recentEventLimit`)이지 headless 가 아니다. 그 줄을 같이 지우면 아래에서 "살아 있다"고 판정한 `recentEventLimit` 이 함께 사라진다.
- `resourceLimits.telemetry.sampleIntervalMs`: **진짜 inert.** 런타임 소비처가 없다. 스키마(`server/src/schemas/config.schema.ts:185`)와 설정 파일 렌더링(`ConfigFileRepository.ts:226`, `:311`)에만 존재하고, `server/src/services/RuntimeConfigStore.ts:127` 에 capability 항목으로 등록돼 있을 뿐 그 값을 읽어 동작을 바꾸는 코드가 없다. **이 부재는 테스트로 못 박혀 있다** — `server/src/test-runner.ts:1620` 과 `server/src/services/RuntimeConfigStore.test.ts:118-119` 가 이 키의 `available` 이 `false` 이고 사유가 `later stability wave` 임을 단언한다.
- `resourceLimits.telemetry.recentEventLimit`: **살아 있다.** `server/src/services/RuntimeConfigStore.ts:246`, `:400` 에서 실제로 쓰인다.
- `headlessQueueMode`: ⚠️ **판정 보류.** 이슈 본문과 연구·계획 문서 `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`(이하 "연구 문서")는 이 키를 inert 후보로 적었다. 스키마·타입·에러 리포팅에는 플럼돼 있으나(`server/src/services/SessionManager.ts:1149`, `:1265`, 에러 메시지 문자열 `:7610`), **서버 런타임 어디에도 `'observe'` / `'bounded'` 를 분기하는 코드가 없다.** 실제 오버플로는 `resourceLimits.headless.overflowPolicy` 가 좌우한다 — `server/src/utils/headlessOutputQueue.ts:93` 의 `this.overflowPolicy === 'degrade-headless'` 가 `shouldDegradeHeadless` 를 만들고, `SessionManager.ts:7604` 가 그것을 보고 degrade 한다. **inert 여부는 0단계에서 재판정한다.**

**3. 잔여 fallback 경로.** `server/src/ws/WsRouter.ts:5159-5167` 에는 해당 소켓에 fair scheduler 가 등록돼 있지 않을 때 직접 전송하는 경로가 남아 있다. 전역 FIFO 는 아니고 소켓 단위 예외 경로다.

**4. viewport-only 서버 스냅샷 계열 — 위치 확정됨.**

- `server/src/utils/headlessTerminal.ts:211` 의 `VIEWPORT_ONLY_SERIALIZE_OPTIONS`(`{ scrollback: 0 }`)가 그 상수이고, `:260` 에서 `serializeHeadlessTerminal` 의 **기본값**으로 쓰인다. 즉 서버 스냅샷은 스크롤백을 버리고 **현재 화면만** 담는다. 호출부는 `server/src/services/SessionManager.ts:6028`, `:6120`.
- **oversized empty fallback** 도 같은 함수 안에 있다 — `headlessTerminal.ts:261-268`. 직렬화 결과가 `maxSnapshotBytes` 를 넘으면 `data: ''`, `truncated: true` 를 돌려준다. **내용이 있는데 빈 스냅샷을 성공처럼 반환**하는 것이 문제다.
- 능력이 없어서가 아니다. 같은 파일 `:301` 의 retained-checkpoint 경로는 옵션 없이 `serializeAddon.serialize()` 를 호출해 **전체 스크롤백을 직렬화한다.** 즉 이 작업은 새 능력을 만드는 것이 아니라 **어느 경로가 어떤 범위를 쓰는지를 통일**하는 쪽에 가깝다.
- ⚠️ **소유권 주의.** #16 도 같은 상수를 짚지만 **결론이 다르다.** #16 의 「무엇을 만들어야 하나요」 5번은 `VIEWPORT_ONLY_SERIALIZE_OPTIONS` 를 **설정된 보존 범위로 교체**하는 것을 wave-4 작업으로 소유한다. #22 는 wave-5 이므로, #22 가 실제로 착수하는 시점에는 상수가 이미 교체돼 있을 수 있다. 그렇다면 여기서 할 일은 "삭제"가 아니라 **"잔여 viewport-only 전제 제거"** 다. 0단계에서 #16 의 실제 결과를 확인하고 다시 판정한다.

**5. 아직 코드 위치가 확정되지 않은 항목.** 아래 두 항목은 이슈 원문에 있으나 이번 조사에서 해당 코드를 특정하지 못했다. #21 완료 시점에 다시 조사한다.

- `viewport-only reveal/overflow repair` — 숨긴 탭을 다시 보일 때의 viewport 한정 복구/오버플로 수리 경로
- `bounded tail 을 정상 연속 출력처럼 재생하는 경로`
- `legacy snapshot/replay path` — parity 통과 후 지울 대상. 어디까지가 "legacy" 인지의 경계 자체가 아직 그어지지 않았다.

## 왜 고쳐야 하나요?

**옛 코드를 안 지우면**

- 두 벌을 계속 유지해야 한다. 버그 하나에 두 곳을 고쳐야 하고, 한쪽만 고쳐지면 조용히 어긋난다.
- 로컬 스냅샷 authority 가 남아 있는 한 "서버가 유일한 진실"이라는 계약이 코드로 성립하지 않는다. 계약서와 코드가 다른 상태가 지속된다.
- 아무 동작도 좌우하지 않는 설정 키(`writeLagWarnMs`, `writeBatchMaxBytes`, `telemetry.sampleIntervalMs`)가 스키마·타입 선언에 계속 남아 있다. 코드를 읽는 사람은 선언이 있으면 무언가를 한다고 가정하고, 그 잘못된 가정 위에 다음 코드가 얹힌다.

**하지만 성급하게 지우면 더 나쁘다**

- 지운 코드는 롤백으로 복구되지 않는다. 배포된 옛 빌드로 되돌려도, 그 사이 새 빌드가 만들어 놓은 **데이터**(retained state, 설정 파일)를 옛 빌드가 못 읽을 수 있다. 이건 사용자 데이터 손실이다.
- 삭제는 diff 가 크고 영향 범위가 넓다. 문제가 나면 어디서 났는지 좁히기 어렵다.

그래서 이 이슈는 프로젝트에서 **가장 엄격한 통과 조건**을 갖는다.

> **주니어가 반드시 이해해야 할 것**: 이 이슈는 **"코드가 다 준비됐다"만으로는 절대 닫을 수 없다.** wave-master 계획 `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:24` 에 이렇게 못 박혀 있다 — *"Wave 5의 two-release soak와 물리 삭제는 외부 시간·Tier 3 gate를 만족할 때까지 완료 처리하지 않는다."* **외부 시간**, 즉 달력상의 두 릴리스가 실제로 지나가야 한다. 개발이 아무리 빨리 끝나도 시간을 앞당길 수 없다.

## 배경 지식

### soak / two-release soak (담금 / 두 릴리스 담금)

**새 코드를 실제 사용자 환경에서 충분히 오래 돌려 보며 문제가 드러나기를 기다리는 기간**이다. 무언가를 액체에 담가 두고 스며들기를 기다리는 것과 같은 그림이라고 생각하면 된다 — 짧게 담그면 아무 일도 일어나지 않는다. 짧은 테스트로는 절대 안 나오는 종류의 버그가 있기 때문이다. 예: 메모리 누수는 며칠 켜 둬야 보이고, 특정 설정을 쓰는 소수 사용자는 몇 주가 지나야 한 번 마주친다. **두 릴리스**로 정한 이유는, 한 릴리스는 우연히 조용할 수 있지만 두 번 연속 조용하기는 어렵기 때문이다. 그리고 이건 **작업량이 아니라 시간**이다. 사람을 더 투입해도 줄어들지 않는다.

### Tier 3 review (3등급 리뷰)

**변경의 위험도에 따라 리뷰 강도를 등급으로 나눈 것 중 가장 높은 등급**이다. 이 저장소에서는 `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md:427` 이 조건을 정의한다 — *"Large deletion은 Tier 3 blast-radius와 두 independent reviewer의 `No findings`가 필요하다."* 검증 범위가 대략 어느 정도인지는 다른 문서의 **한 Tier 3 급 작업 예시**에서 짐작할 수 있다 — `docs/research/mcp/06.security-ops-test-plan.md:131` 은 MCP 쪽 어떤 작업 하나를 두고 *"이 작업은 Tier 3에 가깝다"* 며 그 검증 범위를 *"단위, 통합, E2E, 보안 회귀를 모두 포함"* 으로 적는다. ⚠️ 이것은 **그 작업 하나에 대한 서술이지 Tier 3 의 일반 정의가 아니다.** #22 의 검증 범위는 Tier 3 리뷰 시점에 별도로 합의해야 한다.

핵심은 **두 명의 독립 리뷰어**다. 독립이란 서로의 결론을 보지 않고 각자 판단한다는 뜻이다. 한 명이 놓친 것을 다른 한 명이 잡을 확률을 높이기 위해서다. 그리고 두 명 모두 `No findings`(지적사항 0건)여야 한다. 한 명이라도 지적하면 고치고 **다시** 두 명에게 받는다.

### blast radius (폭발 반경)

**이 변경이 잘못됐을 때 피해가 미치는 범위**다. 함수 하나 이름 바꾸기는 반경이 좁고, localStorage 스냅샷 계열을 통째로 지우는 것은 모든 세션·모든 사용자·모든 새로고침에 닿으므로 반경이 넓다. Tier 3 리뷰는 이 반경을 명시적으로 문서화할 것을 요구한다.

### rollback drill vs downgrade drill (롤백 훈련 vs 다운그레이드 훈련)

둘 다 "되돌리기 연습"이지만 대상이 다르다.

- **rollback drill**(#21 이 만든 것): **실행 중인 시스템**을 옛 상태로 되돌리는 훈련. 기본값 복귀 → 설정 백업 복원 → epoch 증가 → fresh snapshot.
- **downgrade drill / post-deletion downgrade drill**(#22 가 요구하는 것): **데이터**를 옛 버전이 읽을 수 있는지 확인하는 훈련. 새 빌드로 세션을 만들어 retained state 를 생성한 다음, **이전에 배포했던 서명된 빌드** 또는 **버전 대응 변환기**로 그 데이터를 읽어서 같은 내용이 복구되는지 본다.

두 번째가 더 어렵다. 코드는 되돌릴 수 있지만 **데이터는 이미 새 형식으로 저장된 뒤**이기 때문이다. 이슈는 명시적으로 말한다 — **이 훈련이 불가능하면 물리 삭제 자체를 시작하지 않는다(`Drill이 불가능하면 physical deletion은 blocked다`).**

### schema adapter / down-converter (스키마 어댑터 / 하향 변환기)

- **schema adapter**: 서로 다른 버전의 데이터 형식 사이를 번역하는 층. 예를 들어 v2 형식으로 저장된 스냅샷을 v1 만 아는 코드가 읽을 수 있게 바꿔 준다.
- **down-converter**: 방향이 정해진 어댑터로, **새 형식 → 옛 형식** 한 방향 변환을 담당한다. 롤백 시나리오에서 결정적으로 필요하다.

이슈는 이것들을 **삭제 후에도 최소 두 supported release 동안 별도 compatibility package 로 보존**하라고 요구한다. 즉 "지운다"는 것이 "번역기까지 없앤다"는 뜻은 아니다. 옛 코드는 지우되 **번역기는 남긴다.**

### facade (파사드)

호출 방식은 그대로 두고 속을 새 구현으로 넘겨 주는 얇은 껍데기 층. 이미 `frontend/src/components/Terminal/TerminalView.tsx:1495-1539` 의 `writeOutputDirect` 가 그렇게 동작한다(이름은 "직접 쓰기"지만 실제로는 코디네이터로 위임한다). #22 도 support 기간 동안은 이 파사드를 **compatibility package 로 분리해 보존**하라고 요구한다.

### signed build (서명된 빌드)

일반적으로는 **배포 시 서명이 붙어 진위와 무결성을 확인할 수 있는 정식 빌드**를 뜻한다. 긴급 롤백에서 "예전 버전"이라며 아무 빌드나 쓰면 안 되므로, 이전에 정식으로 배포했던 서명 빌드를 기준으로 삼는다는 발상이다.

⚠️ **그런데 BuilderGate 에는 현재 코드 서명 파이프라인이 없다.** 확인한 것은 다음과 같다.

- 릴리스 자동화는 `.github/workflows/release.yml` 하나이며, 태그를 GitHub Release 로 만드는 워크플로다.
- 저장소 전체에서 `codesign` / `signtool` / `notarize` / `sigstore` / GPG 서명 관련 설정은 **한 건도 발견되지 않았다.**
- `CLAUDE.md` 에도 서명·배포 파이프라인에 대한 언급이 없다.

**이게 왜 중요하냐면**, 완료 조건이 downgrade drill 을 하드 게이트로 걸고 그 drill 의 첫 번째 방법이 "이전에 배포했던 서명 빌드로 되돌려 읽기"이기 때문이다 — `Drill이 불가능하면 physical deletion은 blocked다`. **서명 빌드가 없으면 이 경로는 지금 성립하지 않는다.**

다행히 완료 조건 자체가 두 번째 경로를 함께 적어 두었다 — *"이전 supported signed release **또는** versioned compatibility reader/down-converter"*. 즉 **서명 빌드가 없으면 버전 대응 reader/down-converter 쪽으로 drill 을 성립시키면 된다.**

따라서 **"둘 중 어느 경로로 drill 을 성립시킬 것인가를 정하는 것이 이 이슈의 0단계"** 다. 서명 파이프라인을 새로 만들 것인지, down-converter 로 갈 것인지를 먼저 결정하지 않으면 삭제는 시작조차 할 수 없다.

### forward / backward compatibility (전방 / 후방 호환성)

- **backward compatibility**: 새 버전이 옛 데이터를 읽을 수 있다.
- **forward compatibility**: 옛 버전이 새 데이터를 (적어도 깨지지 않게) 다룰 수 있다.

롤백에서 진짜로 필요한 것은 forward compatibility 쪽이고, 이게 훨씬 어렵다. 옛 코드는 새 형식을 모르는 채로 작성됐기 때문이다. 그래서 down-converter 가 필요한 것이다.

### parity (동등성)

**두 경로가 같은 입력에 같은 결과를 내는 것**이다. 새 snapshot/replay 경로와 legacy snapshot/replay 경로가 같은 화면을 만들어 내야 legacy 를 지울 수 있다. "새 게 더 좋다"가 아니라 **"결과가 같다"** 가 삭제의 근거다.

### tombstone (툼스톤, 묘비)

**"이건 지워졌다"는 사실 자체를 기록해 두는 표식**이다. 그냥 지우면 다른 곳(다른 탭, 다른 세션)이 "아직 있는 줄 알고" 다시 만들어 낼 수 있다. 그래서 삭제 표식을 일정 기간 남긴다. BuilderGate 는 24시간 TTL 로 이걸 관리한다(`frontend/src/utils/terminalSnapshot.ts:8`, `:409-505`).

### quota (할당량)

브라우저 localStorage 는 용량 상한이 있고, 넘으면 예외가 난다. `terminalSnapshot.ts:338-407` 의 `setTerminalSnapshotWithQuotaRecovery` 는 넘쳤을 때 오래된 스냅샷을 밀어내고 다시 시도하는 복구 로직이다. 이슈는 **이 quota 처리 코드도 함께 지우라**고 요구한다. 스냅샷 자체가 없어지면 quota 관리도 필요 없기 때문이다.

### cache absent / poisoned hard-reload suite (캐시 없음 / 오염된 캐시 강제 새로고침 스위트)

삭제 후에도 계속 통과해야 하는 테스트 묶음이다.

- **absent**: 로컬 캐시가 아예 비어 있는 상태에서 강제 새로고침 → 서버만으로 화면이 복구되는가
- **poisoned**: 로컬 캐시에 잘못된/깨진 데이터가 들어 있는 상태 → 그걸 믿지 않고 서버에서 다시 받는가

`poisoned` 쪽이 특히 중요하다. 로컬 데이터를 지우는 작업이므로, "지우다 만" 상태나 옛 버전이 남긴 데이터를 만났을 때 안전하게 무시하는지 확인해야 한다.

### emergency fallback (비상 대체 경로)

무언가 심각하게 잘못됐을 때 마지막으로 붙잡는 경로다. AC 는 여기에 강한 제약을 건다 — **비상 상황이라도 무제한 버퍼, 거대 flush, recovery direct writer 는 되살리지 않는다.** "급하니까 옛날 방식으로 일단 돌리자"가 금지된다. 그 옛날 방식들이 애초에 이 프로젝트를 시작하게 만든 원인이기 때문이다.

### effective retained-history policy (실효 보존 이력 정책)

터미널이 얼마나 많은 과거 출력을 기억할지에 대한 **최종적으로 적용되는 하나의 정책**이다. 지금은 브라우저 쪽 설정과 서버 쪽 retention 설정이 같은 것을 두 곳에서 정의할 여지가 있다. AC 는 **정의를 하나만 남기라**고 요구한다. 두 곳에서 정의하면 값이 갈리고, 갈린 값은 아무도 눈치채지 못한다.

## 무엇을 만들어야 하나요?

이 이슈에서 "만든다"는 것의 절반은 **삭제할 자격을 증명하는 일**이고, 나머지 절반이 실제 삭제다.

### 0단계 — 시작 전 확인 (제일 중요)

1. **#21 이 완료되었는가.** 새 경로가 기본값인가.
2. **그 시점부터 두 릴리스가 실제로 지나갔는가.** 지나가지 않았으면 여기서 멈춘다. 다른 준비를 아무리 해도 이 조건은 못 채운다.
3. **post-deletion downgrade drill 을 어느 경로로 성립시킬 것인가를 정한다.** 완료 조건이 주는 선택지는 둘이다 — (a) 이전 supported **signed release** 로 되돌려 읽기, (b) **versioned compatibility reader / down-converter** 로 변환해 읽기. ⚠️ 현재 이 저장소에는 코드 서명 파이프라인이 없으므로(배경 지식의 `signed build` 항목 참고) **(a)는 지금 성립하지 않는다.** (a)를 새로 만들 것인지 (b)로 갈 것인지를 **여기서 결정한다.** 둘 다 불가능하면 삭제를 시작하지 않는다.
4. **아직 코드 위치가 확정되지 않은 삭제 대상을 재조사한다** — `viewport-only reveal/overflow repair`, `bounded tail 재생 경로`, `legacy snapshot/replay path` 의 경계. 지울 것이 어디 있는지 모르는 채로 삭제 diff 를 열 수 없다.
5. wave-5 SRS 요구사항이 있는가. **현재 wave-5 에 배정된 요구사항은 0건이다** — `speckiwi list --target wave-5 --json` 이 `{"records":[]}` 를 돌려준다. (`docs/spec/00.index.md:37,45` 는 target 등록 위치일 뿐 건수를 말하지 않는다.)
6. **`headlessQueueMode` inert 여부를 재판정한다.** 런타임에 `'observe'` / `'bounded'` 를 분기하는 코드가 생겼는지 확인하고, 없으면 스키마·타입 선언을 삭제할지 여기서 확정한다. 재판정 없이는 3단계의 「지우지 말 것」에 그대로 남는다. (위 「아직 남아 있는 것」 2번)
7. **#16 의 `VIEWPORT_ONLY_SERIALIZE_OPTIONS` 처리 결과를 확인한다.** 이미 설정된 보존 범위로 교체돼 있으면, 이 이슈의 작업은 "삭제"가 아니라 **"잔여 viewport-only 전제 제거"** 다. 어느 쪽인지 정하지 않으면 3단계에서 이미 없는 상수를 지우려 들게 된다. (위 「아직 남아 있는 것」 4번)

### 1단계 — 증거 수집 (삭제 전)

- 모든 target workload 에서 두 릴리스 soak 결과
- rollback drill 반복 통과 기록
- **비기본 legacy 키를 쓰는 사용자 식별 및 마이그레이션.** #21 이 남긴 백업 산출물의 `explicit/non-default key` 목록이 여기 쓰인다
- support 중인 이전 릴리스와의 forward/backward 호환성 테스트
- G9 recovery-equivalence 증거 (#23)

### 2단계 — 변환기 준비

- checkpoint/state/protocol down-converter 와 schema adapter 를 **별도 compatibility package 로 분리**한다
- **post-deletion downgrade drill 을 먼저 통과시킨다**: 새 빌드로 normal buffer / alternate buffer / Unicode 를 포함한 retained state 를 만들고, 이전 supported signed release 또는 변환기로 되돌려 **같은 contracted retained state 와 승인된 server-restart/offline 범위**가 복구되는지 확인
- 이 훈련이 실패하면 3단계로 넘어가지 않는다

### 3단계 — 실제 삭제

앞의 조사 결과를 반영하면, **실제로 지울 것은 이슈 목록보다 짧다.** 이미 사라진 항목은 삭제가 아니라 "이미 없음"을 증거로 기록하면 된다.

지울 것:

- `terminal_snapshot_*` localStorage 계열 전부: 키, 파서, quota 복구, tombstone, 그리고 **local restore success authority**(`TerminalView.tsx:2309-2338`, `terminalHiddenOutput.ts:109`, `visibleOutputRecovery.ts:1292`)
- 진짜 inert 설정: `resourceLimits.headless.writeLagWarnMs`, `writeBatchMaxBytes`, `resourceLimits.telemetry.sampleIntervalMs` — **서버 스키마·서버 타입과 프론트엔드 타입 선언 양쪽에서** 함께 제거한다 (설정 UI 에는 노출돼 있지 않다)
- viewport-only 서버 serialize/scope — `server/src/utils/headlessTerminal.ts:211`(`VIEWPORT_ONLY_SERIALIZE_OPTIONS`), 기본값 사용처 `:260`, 호출부 `SessionManager.ts:6028,6120`
- oversized empty fallback — `server/src/utils/headlessTerminal.ts:261-268` (`data: ''` + `truncated: true` 반환)
- viewport-only reveal/overflow repair **(위치 미확정 — 0단계에서 재조사)**
- bounded tail 을 정상 출력처럼 재생하는 경로 **(위치 미확정 — 0단계에서 재조사)**
- parity·soak 를 통과한 뒤의 legacy snapshot/replay path **(위치 미확정 — 0단계에서 재조사)**
- 브라우저 literal scrollback 과 서버 retention 을 **중복 정의**하는 설정/consumer (하나의 실효 정책만 남긴다)
- `server/src/ws/WsRouter.ts:5159-5167` 의 스케줄러 미등록 시 직접 전송 fallback 재검토

지우지 말 것:

- ⚠️ `headlessQueueMode` — **판정 보류이므로 이번 diff 에서 건드리지 않는다.** 플럼은 돼 있으나 런타임 분기가 없다(위 2번 참고). inert 여부를 0단계에서 재판정하기 전에는 삭제도 존치도 확정하지 않는다
- `resourceLimits.telemetry.recentEventLimit` — 살아 있는 설정이다
- compatibility package 안의 facade / schema adapter / down-converter — **최소 두 supported release 동안 보존**
- 벤치마크 FIFO 비교군(`terminalFairnessCharacterization.ts:1273`) — 삭제 대상 아닌 측정 도구

### 4단계 — 삭제 후 검증

- cache absent / poisoned hard-reload 스위트가 **계속** 통과하는가
- post-deletion downgrade drill 이 다시 통과하는가
- 삭제 diff 에 대한 Tier 3 blast-radius / rollback 리뷰
- **두 명의 독립 리뷰어가 각각 `No findings`**

## 완료 조건 (원문 유지)

### Acceptance criteria

- [ ] 새 path가 모든 target workload에서 두 release 이상 soak되고 rollback drill이 반복 통과한다.

**해설**: `두 release 이상` 은 코드로 앞당길 수 없는 **달력 조건**이다. `반복 통과` 는 한 번 성공이 아니라 계속 성공해야 한다는 뜻이다.

- [ ] non-default legacy key 사용자가 식별·migration되며 support 중 이전 release의 forward/backward compatibility가 통과한다.

**해설**: 기본값을 그대로 쓰던 사용자는 자동으로 넘어가지만, **일부러 다른 값을 지정해 둔 사용자**는 개별 확인이 필요하다. 이 목록은 #21 의 백업 산출물에서 나온다.

- [ ] code-point encoder, unbounded remount/restore buffer, giant join/flush, recovery direct writer, global FIFO를 제거한다.

**해설**: ⚠️ **이 다섯 항목은 조사 결과 이미 모두 제거되어 있다**(위 표 참고). 따라서 이 항목의 실제 작업은 "삭제"가 아니라 **"이미 없음을 증거로 확정"** 이 된다. 다만 `global FIFO` 는 벤치마크 비교군으로 의도적으로 남아 있으므로, 그것이 삭제 대상이 아니라는 점을 리뷰에서 명확히 해야 한다.

- [ ] inert queue/write-lag/telemetry 설정, literal frontend scrollback, context-menu direct sendInput, 불필요 hidden workaround를 제거한다.

**해설**: ⚠️ 이 항목도 부분적으로만 유효하다. `literal frontend scrollback` 과 `context-menu direct sendInput` 은 이미 없다. `inert 설정`으로 확정된 것은 `writeLagWarnMs` / `writeBatchMaxBytes` / `telemetry.sampleIntervalMs` 셋뿐이다. `telemetry.recentEventLimit` 은 **살아 있는 설정이므로 삭제 대상이 아니다.** `headlessQueueMode` 는 플럼은 돼 있으나 런타임에 `'observe'`/`'bounded'` 분기가 없어 **inert 여부가 아직 미확정**이며, 0단계에서 재판정한 뒤에야 이 항목의 범위에 들어가는지 결정된다.

- [ ] parity·soak 완료 후 legacy snapshot/replay path를 제거한다.

**해설**: `parity` = 새 경로와 옛 경로가 같은 결과를 낸다는 확인. 이게 먼저다.

- [ ] `terminal_snapshot_*` localStorage, parser, quota/tombstone, local-restore success authority를 제거하고 cache absent/poisoned hard-reload suite가 계속 통과한다.

**해설**: **이 이슈의 실질적 본체다.** 네 조각(저장소 키, 파서, quota/tombstone, 로컬 복원 authority)을 모두 지워야 하고, 지운 뒤에도 캐시가 없거나 오염된 상태에서의 강제 새로고침이 통과해야 한다.

- [ ] Server viewport-only serialize/scope, oversized empty fallback, viewport-only reveal/overflow repair와 bounded tail을 정상 연속 출력처럼 재생하는 경로를 제거한다.

**해설**: `viewport-only` = 화면에 보이는 영역만 다루는 방식. 새 모델은 보이는 영역이 아니라 **계약된 retained state 전체**를 다루므로 viewport-only 전제는 더 이상 맞지 않는다. `bounded tail을 정상 연속 출력처럼 재생하는 경로` 는 "잘린 꼬리 조각을 마치 끊김 없는 출력인 양 화면에 흘려보내는" 코드를 말한다. 실제로는 중간이 비어 있는데 안 비어 있는 것처럼 보이므로 위험하다.

- [ ] Browser literal scrollback와 server retention을 중복 정의하는 설정/consumer를 제거하고 하나의 effective retained-history policy만 남긴다.

**해설**: 같은 개념을 두 곳에서 정의하지 말라는 것. 값이 갈리면 아무도 모르게 어긋난다.

- [ ] support 기간에는 facade/schema adapter를 별도 compatibility package로 보존하고 signed-build+config backup rollback이 가능하다.

**해설**: 지우는 것과 보존하는 것을 구분한다. 옛 **동작**은 지우되, 옛 **데이터를 읽는 번역기**는 남긴다.

- [ ] Legacy producer 제거 후 새 build에서 normal/alternate/Unicode retained-state를 생성한 session을 이전 supported signed release 또는 versioned compatibility reader/down-converter로 되돌려 같은 contracted retained-state와 승인된 server-restart/offline 범위를 복구하는 post-deletion downgrade drill이 통과한다.

**해설**: `normal/alternate` 는 터미널의 두 버퍼다. normal 은 평소 스크롤되는 화면, alternate 는 `vim` / `less` 같은 전체 화면 프로그램이 쓰는 별도 화면이다. 둘 다, 그리고 Unicode(한글·이모지·결합 문자)까지 포함해서 훈련해야 한다. 셋 중 하나만 통과하는 것은 통과가 아니다.

- [ ] Checkpoint/state/protocol down-converter와 schema adapter는 physical deletion 후 최소 두 supported release 동안 보존한다. Drill이 불가능하면 physical deletion은 blocked다.

**해설**: 마지막 문장이 결정적이다. **훈련이 불가능하면 삭제 자체를 시작하지 않는다.** "일단 지우고 나중에 방법을 찾자"가 금지된다.

- [ ] emergency fallback도 unbounded buffer, giant flush, recovery direct writer를 되살리지 않는다.

**해설**: 비상시에도 위험한 옛 동작으로 돌아가지 않는다. 되돌아갈 곳은 **안전한 축소 경로**이지 옛 경로가 아니다.

- [ ] 삭제 diff에 대한 Tier 3 수준 blast-radius/rollback review와 최종 `No findings`를 받는다.

**해설**: `Tier 3` 의 정의는 `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md:427` 에 있다 — **큰 삭제에는 blast-radius 분석과 두 명의 독립 리뷰어의 `No findings` 가 필요하다.**

### 공통 완료 조건

> - Parent: #2
> - Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
> - Refresh research: `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md`
> - #23에서 SpecKiwi로 할당한 신규·superseding refresh authority Requirement exact ID를 이 body에 기록하고 `Stability=stable`을 확인하기 전에는 관련 behavior 구현을 시작하지 않는다.
> - 구현 전 Requirement/Stability gate를 SpecKiwi로 확인하며 missing/draft/deprecated 계약에서는 blocked다.
> - behavior change는 failing regression test부터 TDD로 진행한다. evidence-only skip/documentation 분기는 적용 가능한 SpecKiwi·benchmark·review evidence로 검증한다.
> - 관련 test/typecheck/build와 적용 가능한 `https://localhost:2222` 검증을 수행하고 `node.exe`와 TCP 2001/2002 process를 중단하지 않는다.
> - rollout metric과 bounded convergence rollback을 남기며 unsafe legacy 경로는 복원하지 않는다.
> - Phase reviewer finding을 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.

**해설**:

네 번째 항목(`#23에서 …`)이 이 이슈에서 **가장 강한 출발 게이트**다. 말 그대로: **#23 이 확정한 refresh authority 요구사항의 정확한 ID 를 이 이슈 본문에 적어 넣고, 그 요구사항의 `Stability` 가 `stable` 인지 확인하기 전까지는 관련 동작 구현을 시작할 수 없다.**

**배경 — `Stability` 가 무엇인가**

`SpecKiwi` 는 이 저장소의 요구사항(SRS) 관리 도구다. 요구사항 원본은 `docs/spec/` 아래 마크다운으로 들어 있고, `speckiwi` CLI 와 동명의 MCP 도구가 그것을 읽고 안전하게 고친다.

`Stability` 는 **요구사항이 얼마나 확정됐는지**를 나타내는 값이며 `draft` → `evolving` → `stable` 순으로 올라간다(그 밖에 `frozen`, `deprecated` 가 있다). **`draft` 요구사항을 보고 짠 코드는 요구사항이 움직이면 버려진다.** 그래서 `missing` / `draft` / `deprecated` 는 전부 blocked 다. 이 이슈는 한 단계 더 엄격해서 **`evolving` 으로도 부족하고 `stable` 이어야** 한다. 되돌릴 수 없는 삭제를 하는 이슈이므로 당연하다.

**실제로 어떻게 하는가**

1. **ID 를 찾는다.** `docs/spec/00.index.md` §2 `SRS Documents` 표에서 scope 별 문서와 접두사를 본다 — 접두사 `BGSTAB` 는 `docs/spec/30.buildergate-stability.srs.md` 에 산다. #23 이 만드는 refresh authority 요구사항도 이 목록 안의 어느 문서에 들어간다.
   도구를 쓰는 편이 빠르다.
   - `speckiwi list --json` 으로 전체를 열거한다. **`--target wave-5` 로 좁히지 말 것** — wave-5 에는 0건이고 #23 이 만드는 신규·superseding 요구사항은 다른 target 에 배정될 수 있다.
   - 단건 조회는 **`speckiwi show <ID> --json`**, 읽을 필드는 **`metadata.Stability`**. MCP 사용 시 `get_requirement`.
   - 현재 후보는 **`REL-BGSTAB-007`** (`docs/spec/30.buildergate-stability.srs.md:2811`, Target `wave-3`, Stability `stable`).
   - ⚠️ `speckiwi list` 실행 시 `SRS-E002 Duplicate requirement ID: REL-BGSTAB-015` 진단이 함께 출력될 수 있다. 명령 실패가 아니다.
2. **`Stability` 를 읽는다.** 그 scope 문서에서 `### <요구사항 ID> — <제목>` 제목을 찾으면 바로 아래에 메타데이터 표가 있고, 거기에 `| Stability | stable |` 같은 행이 있다. 그 값이 답이다. 도구로는 `speckiwi show <ID> --json` / MCP `get_requirement` 로 같은 값을 얻는다.
3. **판정한다.**
   - 그런 요구사항이 **아예 없다** → `missing`. **blocked.** #23 이 먼저 끝나야 한다.
   - 있는데 `Stability` 가 `draft` 또는 `evolving` → **blocked.** `stable` 로 승급되기 전에는 삭제를 시작하지 않는다.
   - 있는데 `deprecated` → **blocked.**
   - `stable` → 통과.
4. **ID 를 적는다.** 여기서 "이 body" 란 **GitHub 이슈 #22 의 본문**을 말한다. 찾은 요구사항 ID 를 그 본문에 그대로 적어 넣는다. 이 문서에 적는 것으로 갈음되지 않는다 — 게이트가 지목하는 곳은 이슈 본문이다.

한 줄로 줄이면: **코드보다 요구사항 확정이 먼저이고, 확정됐다는 사실을 이슈 본문에 ID 로 남겨야 시작할 수 있다.**

나머지 항목 중 `No findings` 는 리뷰어가 지적사항 0건을 판정했다는 뜻이며, 지적을 고친 뒤 **다시 리뷰를 받아** 0건이 나와야 한다. 이 이슈는 여기에 더해 **두 명의 독립 리뷰어**를 요구한다.

## 의존성과 순서

이 이슈는 **wave-5 의 마지막이자 프로젝트 전체의 마지막**이다. 선행 조건을 성격별로 묶으면 네 종류다.

**1) 코드가 준비되어야 한다**

- **#21 완료** — 새 경로가 기본값이고, 롤백 훈련이 자동화되어 통과 중이어야 한다. #21 은 다시 #3~#18 전부와 #20 전부, #19 결론, #23 계약을 선행으로 갖는다. 즉 **#22 는 사실상 프로젝트의 모든 이슈를 선행으로 갖는다.**

**2) 시간이 지나야 한다 (앞당길 수 없음)**

- **#21 이후 최소 두 릴리스의 soak.** 개발 속도와 무관하다. 이것이 `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:24` 가 말하는 **"외부 시간"** 이다.

**3) 데이터 안전이 증명되어야 한다**

- **비기본 legacy 키 사용자의 식별과 마이그레이션 완료** (#21 백업 산출물 기반)
- **자동 롤백 증거**
- **#23 의 retained-state 계약 및 G9 recovery-equivalence 증거**
- **post-deletion downgrade drill 이 가능하고 통과할 것** — 불가능하면 삭제 자체가 blocked

**4) 사람의 판정을 받아야 한다**

- **Tier 3 blast-radius / rollback 리뷰**
- **두 명의 독립 리뷰어가 각각 `No findings`**

### 이 순서를 바꿀 수 없는 이유

| 만약 이렇게 하면 | 무슨 일이 벌어지나 |
| --- | --- |
| soak 없이 지운다 | 오래 켜 둬야 나오는 버그를 발견하지 못한 채 되돌릴 코드가 사라진다 |
| downgrade drill 없이 지운다 | 롤백해도 새 형식으로 저장된 사용자 데이터를 옛 빌드가 못 읽는다 = 데이터 손실 |
| 변환기까지 같이 지운다 | 이후 두 릴리스 동안의 긴급 롤백 경로가 통째로 없어진다 |
| 리뷰어 한 명만 받는다 | 큰 삭제 diff 에서 한 사람이 놓치는 항목이 그대로 배포된다 |

## 참고

- 원본 이슈: `Snoworca/BuilderGate#22` (`gh issue view 22`)
- 연구 문서 Phase 10 / 10A / 10B (제거 조건·제거 대상 후보·Rollback): `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:686-726`
- refresh 연구 Phase 10-B 및 Tier 3 정의: `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md:418-427`
- 한 Tier 3 급 작업의 검증 범위 **예시**(일반 정의 아님): `docs/research/mcp/06.security-ops-test-plan.md:131`
- **외부 시간·Tier 3 브레이크**: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:24`
- wave-5 범위와 완료 gate: 같은 파일 `:83-94`
- wave-5 target 등록 위치: `docs/spec/00.index.md:37,45` (Target Map 행과 목표 헤딩. 요구사항 0건이라는 사실 자체는 `speckiwi list --target wave-5 --json` 결과에서 온다)
- 관련 SRS: 변경·supersede 승인이 끝난 전체 BGSTAB/ARCH terminal 계약. 현재 refresh authority 후보는 `REL-BGSTAB-007` (`docs/spec/30.buildergate-stability.srs.md:2811`, Target `wave-3`, Stability `stable`).
- 코드 위치는 문서 앞부분의 **이미 사라진 것** 표와 **아직 남아 있는 것** 목록에 항목별 판정과 함께 정리되어 있다. 그 두 곳이 유일한 출처이며, 여기에 중복해서 적지 않는다.
