# lossy policy(손실 허용 정책)를 큐 하나하나에 따로 적용하고 따로 증명하는 추적표

> 원문 제목: `[Orca][P2-C] consumer별 lossy policy enforcement rollout tracker`
> 원본 이슈: `Snoworca/BuilderGate#20` — https://github.com/Snoworca/BuilderGate/issues/20

## 한 줄 요약

"버퍼가 꽉 차면 무엇을 버려도 되는지"를 정하는 **lossy policy**(손실 허용 정책)를 한 번의 큰 커밋으로 전부 적용해 버리지 않고, **정책을 실제로 쓰는 큐(consumer)를 하나씩 따로 적용하고 하나씩 따로 증명**하도록 강제하는 **추적용 이슈**다.

## Phase 번호 ↔ 이슈 번호 대응표

이 문서군 전체가 `P1-D`, `P7-B` 같은 **Phase 번호**로 서로를 부른다. 완료 조건에도 그대로 나오므로(`신규 P3~P9 consumer` 등) 먼저 이 표를 봐야 범위를 잡을 수 있다. 아래는 각 이슈의 실제 제목에서 확인한 대응이다.

| Phase | 이슈 | 이슈 제목 |
| --- | --- | --- |
| P0 | #3 | split 계약 drift 해소·SRS gate·benchmark 기준선 고정 |
| P0-R | #23 | 새로고침 retained-state 절단 재현·보존 계약 고정 |
| P1-A / P1-B / P1-C / P1-D | #4 / #5 / #6 / #7 | UTF-8 output scheduler / screen-repair 수렴 / bounded remount·restore / paste·copy ownership |
| P2-A / P2-B / **P2-C** | #8 / #9 / **#20 (이 이슈)** | 정책 컴파일러 observe-only / 비손실 canary / **consumer별 lossy enforcement** |
| P3 | #10 | Browser `TerminalWriteCoordinator` 와 client snapshot fence |
| P4-A / P4-B | #11 / #12 | server headless model authority shadow / single-authority promotion pilot |
| P5 | #13 | per-client·per-session fair scheduler와 ACK/credit ledger |
| P6 | #14 | hidden delivery gate와 authoritative snapshot recovery |
| P7-A / P7-B / P7-C | #15 / #16 / #17 | WebGL renderer·DOM fallback / Unicode·selection identity / renderer suspension·hidden residency |
| P8 | #18 | `TerminalInputCoordinator` exactly-once·IME·OSC52 |
| P9 | #19 | split/binary data plane 측정 gate와 조건부 도입 |
| P10-A / P10-B | #21 / #22 | reversible default flip과 rollback drill / 두 release soak 후 물리 제거 |

따라서 완료 조건의 `신규 P3~P9 consumer` 는 **#10 부터 #19 까지가 새로 만드는 큐 전부**를 가리킨다.

## 지금 무슨 문제가 있나요?

먼저 이 이슈가 **기능 이슈가 아니라 추적표(tracker)** 라는 점부터 짚어야 한다. #20 자체는 새 코드를 거의 만들지 않는다. 다른 이슈들이 만든 결과가 **빠짐없이, 그리고 각각 독립적인 증거를 갖고** 도착했는지 확인하는 체크리스트다.

배경은 이렇다. wave-3 의 Phase 2에서 `TerminalResourcePolicy`(`server/src/services/TerminalResourcePolicy.ts`)라는 **단일 정책 컴파일러**를 만들었다. 사용자가 설정한 값들(버퍼 크기 상한, 타임아웃 등)을 받아 "실제로 적용될 정책(`effectivePolicy`)"을 계산하는 물건이다. Phase 2A는 계산만 하고 적용하지 않는 관찰 모드였고, Phase 2B는 **손실이 발생하지 않는 결정만** 적용하는 canary였다. (**canary** = 전체가 아니라 **일부 대상에게만 켜 보는 시험 적용**. 탄광의 카나리아처럼, 전체를 위험에 빠뜨리기 전에 작은 표본으로 먼저 이상을 감지한다.)

남은 것이 Phase 2C, 즉 **손실이 발생할 수 있는 결정(lossy policy)** 이다. 예를 들어 "출력 큐 상한을 10MB에서 1MB로 줄인다"는 설정 변경이 들어왔는데 지금 큐에 5MB가 들어 있으면, 그 5MB를 어떻게 할 것인가?

여기서 **정답이 큐마다 다르다**는 것이 문제의 핵심이다.

- **터미널 출력 큐**: 중간을 잘라내면 화면이 깨진다. 잘라내는 대신 "새로 들어오는 것을 안 받고(admission 중단), 있는 것을 다 내보내거나(drain), 아니면 서버에서 화면 전체를 새로 받아온다(fresh snapshot)".
- **입력/outbox 큐**: 사용자가 이미 친 키를 버리면 안 된다. 기존 항목은 **원래 만료 시각을 그대로 유지**하고, 새 항목만 거절하되 그 거절을 **호출한 쪽에 알려준다**.
- **소켓/프로토콜 모드**: 연결 중간에 모드를 바꾸면 양쪽 해석이 어긋난다. **재연결 경계(reconnect epoch)에서만** 바꾼다.

이 셋을 "버퍼 넘치면 앞에서부터 버림" 같은 **하나의 선형 구현으로 뭉개면**, 셋 중 최소 둘은 조용히 망가진다. 그리고 그 망가짐은 상한을 실제로 넘길 만큼 부하가 걸린 사용자 환경에서만 나타나므로 개발 중에는 절대 발견되지 않는다.

또 하나: 각 큐는 **선행 조건이 다르다.** 출력 큐에 손실 정책을 적용하려면 브라우저 쪽 단일 writer(#10)가 먼저 있어야 하고, hidden 탭 큐는 #14 가, 입력 큐는 #18 이 먼저 끝나야 한다. 순서를 무시하면 "아직 존재하지 않는 안전장치를 전제로 한 손실 정책"을 켜는 셈이 된다.

## 왜 고쳐야 하나요?

추적표 없이 "Phase 2C 완료"라고 선언하면 다음 세 가지가 일어난다.

1. **silent coercion(조용한 강제 변환)이 남는다.** 정책이 어떤 큐에는 적용되고 어떤 큐에는 적용되지 않았는데, 아무도 그 차이를 모른다. 사용자는 설정을 바꿨는데 일부 큐만 반응하는, 재현 불가능한 상태를 만난다.
2. **새로 생긴 큐가 정책 밖에 방치된다.** wave-3~wave-5 에서 계속 새 큐가 생긴다. 등록을 강제하는 장치가 없으면 새 큐는 기본적으로 정책 밖에 있게 된다.
3. **문제가 생겼을 때 되돌릴 단위가 없다.** 전부 한 커밋이면 되돌리기도 전부다. 큐 하나 때문에 나머지 전부를 되돌려야 한다.

#20 이 요구하는 것은 **큐마다 "적용했다"가 아니라 "적용했고 이렇게 증명했다"** 를 남기는 것이다.

## 배경 지식

### consumer (소비자)

여기서 consumer 는 **정책을 실제로 소비해서 자기 행동을 바꾸는 코드 지점**이다. `TerminalResourcePolicy` 가 "출력 큐 상한 1MB"라고 계산해 주면, 그 값을 읽어서 실제로 자기 큐를 자르거나 admission 을 막는 쪽이 consumer다. **정책은 하나지만 consumer 는 여러 개**이고, #20 은 그 여러 개를 하나씩 세는 표다.

**중요: 이 목록은 이미 코드로 존재한다.** `server/src/services/TerminalResourcePolicyInventory.ts` 가 소비 지점 카탈로그이며, 항목마다 `consumerId`, `resourceKey`, `unit`, `source`, `applyBoundary`, `consumerPath`, `consumerSymbol`, `state` 를 들고 있다. (#17 도 같은 파일 `:145-146` 을 residency 소비 지점 카탈로그로 인용한다.) 이 파일에서 확인한 `consumerId` → 파일 대응은 다음과 같다.

| `consumerId` | 실제 코드 위치 |
| --- | --- |
| `browser.terminal.write-scheduler` | `frontend/src/utils/terminalOutputScheduler.ts`, `frontend/src/components/Terminal/TerminalView.tsx` |
| `browser.snapshot.persisted-storage` | `frontend/src/utils/terminalSnapshot.ts`, `frontend/src/utils/inputReliabilityMode.ts`, `frontend/src/components/Terminal/TerminalView.tsx`, `frontend/src/services/tokenStorage.ts` |
| `browser.terminal.recovery-scheduler` | `frontend/src/utils/visibleOutputRecovery.ts`, `frontend/src/utils/webSocketBackpressure.ts`, `frontend/src/contexts/WebSocketContext.tsx`, `TerminalContainer.tsx`, `TerminalView.tsx` |
| `browser.hidden-output` | `frontend/src/utils/terminalHiddenOutput.ts`, `frontend/src/components/Terminal/TerminalContainer.tsx` |
| `browser.runtime.residency` | `frontend/src/hooks/useTerminalRuntimeResidency.ts` |
| `server.pty.headless-model` | `server/src/services/SessionManager.ts`, `server/src/utils/headlessOutputQueue.ts`, `server/src/utils/headlessTerminal.ts` |
| `server.ws.router` | `server/src/ws/WsRouter.ts` |
| `server.ws.send-policy` | `server/src/ws/wsSendPolicy.ts` |
| `server.snapshot.replay-repair` | `server/src/services/SessionManager.ts` |
| `server.config.runtime-store` | `server/src/services/SessionManager.ts` |

⚠️ 이 `consumerId` 목록은 **이슈의 6개 consumer 구분과 1:1로 대응하지 않는다.** 이슈는 선행 이슈 기준으로 묶고, 인벤토리는 코드 소유자 기준으로 묶기 때문이다. 대응 관계를 확정하는 것이 0단계 작업이다.

⚠️ **정본(canonical) `consumerId` union 은 `server/src/services/TerminalResourcePolicy.ts:72-84` 의 `TERMINAL_RESOURCE_POLICY_CONSUMER_IDS` 이고 거기에는 11개가 있다.** 위 표는 인벤토리 파일에 실제 항목이 있는 것만 세어 10개다. 차이는 `server.config.schema` 하나이며, 이는 그 consumerId 로 등록된 인벤토리 항목이 **0건**이라는 뜻이다. 0단계에서 이것이 '누락'인지 '해당 없음'인지 판정해 기록한다 — union 에는 있는데 인벤토리에는 없는 consumer 야말로 "이미 있는 카탈로그의 각 항목을 대응시키는" 방식이 놓치는 지점이다.

### lossy policy (손실 허용 정책)

**데이터가 없어질 수 있는 정책 결정**을 말한다. 반대말은 Phase 2B에서 다룬 비손실(non-lossy) 결정으로, 상한을 *늘리는* 것처럼 아무것도 잃지 않는 변경이다. 상한을 *줄이는* 것은 이미 들어있는 데이터가 갈 곳을 잃으므로 lossy다. lossy 결정은 "무엇을, 언제, 누구에게 알리고 버리는가"를 큐마다 따로 정의해야 한다.

### admission (수용 / 반입 통제)

**큐에 새 항목을 받아들일지 말지를 결정하는 문지기**다. 나이트클럽 입구의 사람 수 세는 직원을 생각하면 된다. 정원이 줄었을 때 **이미 안에 있는 사람을 끌어내는 것**과 **새로 오는 사람만 막는 것**은 완전히 다른 조치다. 후자가 admission 중단이고, 대부분의 경우 이쪽이 안전하다.

### drain (배수 / 비우기)

**새로 안 받으면서 이미 있는 것을 정상 절차대로 다 내보내는 것**이다. 욕조 마개를 뽑되 수도꼭지는 잠그는 상태다. 출력 큐에서 drain 은 "쌓인 출력을 순서대로 다 화면에 쓴 다음 새 상한을 적용"을 뜻한다. 데이터를 잃지 않는다는 게 장점이고, 시간이 걸린다는 게 단점이다.

### convergence (수렴)

**여러 갈래로 흩어질 뻔한 상태가 결국 하나의 올바른 상태로 모이는 것**이다. 예를 들어 큐를 버려서 화면 일부가 사라졌다면, 그대로 두는 게 아니라 서버에서 현재 화면 전체(fresh snapshot)를 받아서 **서버와 브라우저가 같은 화면을 보게 만드는 것**이 수렴이다. AC가 "drain 또는 stale → fresh snapshot으로 수렴한다"고 말하는 이유는, **잃어버렸다는 사실보다 잃어버린 채로 방치되는 것이 더 나쁘기** 때문이다.

### stale (낡음 표시)

데이터를 버렸을 때 그 큐/화면을 **"이건 이제 못 믿는다"고 명시적으로 표시**하는 것이다. stale 표시가 붙으면 그 다음 단계에서 반드시 fresh snapshot 을 받아 수렴해야 한다. stale 표시 없이 버리는 것이 곧 silent truncate 다.

### silent truncate / silent coercion (조용한 절단 / 조용한 강제 변환)

**아무 신호 없이 데이터를 잘라내거나, 설정값을 몰래 다른 값으로 바꿔서 적용하는 것**이다. 예: 사용자가 상한을 100으로 넣었는데 내부적으로 10이 최대라서 조용히 10으로 바꿔 쓰는 것. 사용자는 100이 적용됐다고 믿는다. AC의 `silent coercion이 0` 은 **모든 값 조정이 관측 가능해야 한다**는 뜻이다.

### reconnect epoch (재연결 세대)

연결이 끊겼다 붙을 때마다 1씩 올라가는 **세대 번호**다. 프로토콜 모드처럼 "양쪽이 같은 가정을 공유해야만 하는 값"은 연결 도중에 바꾸면 위험하다. 재연결 순간에는 어차피 양쪽이 처음부터 협상하므로, 그 경계에서만 바꾸면 어긋날 여지가 없다.

### evidence (증거)

"했다"는 주장이 아니라 **다른 사람이 다시 확인할 수 있는 산출물**이다. 이 프로젝트에서는 통과한 회귀 테스트, 벤치마크 raw 데이터, 리뷰 결과, SpecKiwi 검증 기록 등이 해당한다. #20 의 요구는 이 증거가 **consumer 별로 따로** 존재해야 한다는 것이다. "전체적으로 잘 됩니다"는 증거가 아니다.

### policy registry (정책 등록부)

**정책을 적용받아야 하는 consumer 목록을 코드가 들고 있는 자료구조**다. 새 큐를 만들었는데 여기 등록하지 않으면 테스트나 telemetry가 실패하도록 만들어야 한다. 사람의 기억이나 코드 리뷰에 의존하면 반드시 누락된다. AC의 마지막에서 두 번째 항목이 이걸 요구한다.

### rollback (되돌리기)

적용한 정책을 **안전하게 원상 복구**하는 경로다. 중요한 건 "코드를 revert 한다"가 아니라 **런타임에서 되돌릴 수 있어야 한다**는 것이다. 그리고 되돌릴 때 wave-2/wave-3 에서 없앤 위험한 옛 동작(무제한 버퍼, 거대 flush 등)을 다시 살려내면 안 된다.

## 무엇을 만들어야 하나요?

이 이슈에서 "만든다"의 대부분은 **표를 채우는 일**이다. 각 consumer 마다 아래 7칸을 채운다. 칸이 하나라도 비면 그 consumer 는 완료가 아니다.

| 칸 | 무엇을 적나 | 예시 |
| --- | --- | --- |
| unit/source | 이 큐가 무엇을 단위로 세는지, 그 값이 어느 설정에서 왔는지 | `encoded byte`, source = 사용자 설정 `maxOutputQueueBytes` |
| prerequisite | 이 consumer 에 lossy 정책을 켜기 전에 끝나 있어야 하는 선행 이슈 | #10 완료 |
| admission | 상한에 걸렸을 때 새 항목을 어떻게 처리하는지 | 새 admission 거절 + 호출자에게 노출 |
| loss semantics | 무엇이 없어질 수 있고, 그때 무슨 표시가 남는지 | 없어지지 않음 / stale 표시 후 snapshot |
| metric | 실제로 적용됐는지 관측할 수 있는 지표 | 거절 건수, 전환 횟수, 수렴 소요시간 |
| convergence | 손실 후 어떻게 올바른 상태로 모이는지 | fresh snapshot 새 generation |
| rollback | 어떻게 되돌리는지 | 새 admission 중단 후 compatibility policy 로 전환 |

여기에 **한 칸을 더 채워야 표가 실제로 쓸모 있다.**

| 칸 | 무엇을 적나 | 예시 |
| --- | --- | --- |
| consumer → 파일 | 이 consumer 가 실제로 어느 파일·심볼인지 (인벤토리의 `consumerPath` / `consumerSymbol`) | `frontend/src/utils/terminalOutputScheduler.ts` (`browser.terminal.write-scheduler`) |

파일이 적혀 있지 않으면 "적용했다"는 주장을 다른 사람이 검증할 방법이 없다. 배경 지식의 `consumer` 항목에 인벤토리에서 확인한 `consumerId` → 파일 대응표가 있다.

### 진행 순서

0. **`server/src/services/TerminalResourcePolicyInventory.ts` 를 먼저 연다.** 이 파일이 소비 지점 카탈로그이자 이 이슈의 출발점이다. 새로 목록을 만드는 것이 아니라, **이미 있는 카탈로그의 각 항목을 이슈의 6개 consumer 구분에 대응시키고**, 어느 항목이 아직 lossy 정책을 안 받았는지 가려내는 것이 첫 작업이다.
1. **선행 gate 확인이 먼저다.** consumer 별로 시작 조건이 다르므로, 아직 열려 있는 선행 이슈가 있는 consumer 는 손대지 않는다.
2. `TerminalResourcePolicy` 에 **policy registry** 를 두고, 등록되지 않은 consumer 가 있으면 테스트/telemetry 가 실패하게 만든다. (이건 실제 코드 작업이다.)
3. consumer 하나를 골라 위 7칸을 채우고, 회귀 테스트를 먼저 실패시킨 뒤(TDD) 구현하고, 증거를 이슈에 링크한다.
4. 다음 consumer 로 넘어간다. **여러 consumer 를 한 번에 묶지 않는다.** 묶는 순간 이 이슈의 존재 이유가 사라진다.
5. 모든 applicable consumer 가 끝나면 그때 tracker 를 닫는다. #19 는 **채택으로 확정**됐으므로 binary/socket consumer 칸도 다른 칸과 동일한 증거를 채운다. (`skipped` 분기와 skip 증거 링크 조항은 폐기됐다.)

## 완료 조건 (원문 유지)

### 실행 gate

> - non-hidden browser consumer: #10 + #12 이후
> - fair delivery consumer: #13 이후
> - hidden/dataGap consumer: #14 이후
> - renderer/residency consumer: #15, #16, #17 이후
> - input/outbox consumer: #18 이후
> - binary/socket consumer: #19가 adopted인 경우에만

**해설**: consumer 마다 "언제부터 손대도 되는가"가 다르다는 표다. 예컨대 브라우저 화면 큐는 단일 writer(#10)와 단일 authority(#12)가 서 있어야 손실 정책을 안전하게 켤 수 있다.

### Wave ownership

> - Epic Wave 4 / kiwi-wave-master wave-5에서 닫는다.
> - #15/#16/#17/#18과 #19 adopt-or-skip 결정 전에는 tracker를 완료 처리하지 않는다.

**해설**:

첫 줄의 `Epic Wave 4 / kiwi-wave-master wave-5` 는 오타가 아니다. **번호 체계가 두 개 공존한다.**

- `Epic Wave 4` — 상위 에픽 #2 가 쓰는 `Wave 0~4` 번호.
- `kiwi-wave-master wave-5` — 계획 문서 `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md` 와 SRS target(`docs/spec/00.index.md` §3 Target Map)이 쓰는 `wave-1`~`wave-5` 번호.

계획 문서 `:17` 이 이 대응을 명시한다 — *"Epic의 명시적 Wave 0~4 구조를 `wave-1`~`wave-5`에 1:1로 매핑한다."* 즉 **둘은 정확히 하나씩 어긋나 있고**, 같은 작업을 서로 다르게 부르는 것뿐이다. **실행 순서는 계획 문서의 번호를 따른다** — 이 이슈는 계획 문서 기준 **wave-5** 에서 닫는다. `Wave 4` 라는 표기만 보고 wave-4 작업으로 착각하면 선행 조건을 통째로 건너뛰게 된다.

둘째 줄의 `adopt-or-skip 결정 전에는` 은 **해소됐다.** #19 는 2026-08-16 자로 **채택(`adopted`)** 으로 결론났다 (`docs/research/binary-comms/00-decision-record.md`). 남은 제약은 #19 의 **구현 완료** 뿐이다.

### Consumer checklist

- [ ] #10 browser write/snapshot queues

**해설**: `browser.terminal.write-scheduler` 와 `browser.snapshot.persisted-storage` 계열. 이 칸을 닫는 증거는 **그 두 consumer 각각의 7칸이 채워지고, cap 감소가 기존 항목을 silent truncate 하지 않음을 보이는 회귀 테스트가 통과한 기록**이다. 선행은 #10 + #12.

- [ ] #13 per-client/session delivery·ACK queues

**해설**: `server.ws.send-policy` / `server.ws.router` 의 fair scheduler·ACK credit 원장. 증거는 **per-client·per-session lane 별로 admission 거절과 수렴이 관측된 벤치마크/회귀 산출물**이다. 전체 합계 지표 하나로는 이 칸이 닫히지 않는다.

- [ ] #14 hidden delivery/dataGap queues

**해설**: `browser.hidden-output` 계열. 증거는 **숨은 탭에서 손실이 발생했을 때 `dataGap` 표시가 남고, reveal 시 fresh snapshot 으로 수렴함을 보이는 테스트**다. "숨은 탭도 잘 됩니다"는 증거가 아니다.

- [ ] #15 / #16 / #17 renderer·selection·residency resources

**해설**: `browser.runtime.residency` 와 렌더러·selection 자원. 세 이슈가 각각 다른 자원을 건드리므로 **증거도 세 갈래로 나뉘어야 한다.** 하나의 통합 E2E 로 셋을 한꺼번에 닫으면 `독립적으로` 요구를 어긴다.

- [ ] #18 input/outbox/dedup ledger

**해설**: 증거는 **기존 항목의 원래 expiry 가 보존되고, 새 항목 거절이 호출자에게 반환값으로 노출됨을 보이는 테스트**다. 아래 Acceptance criteria 4번과 같은 조건이며, 로그만 남기고 삼키는 구현은 통과가 아니다.

- [ ] binary/socket queues (#19 채택 확정)

**해설**: #19 가 채택으로 확정됐으므로 이 칸은 다른 칸들과 같은 **7칸 증거**를 요구한다. 조건부 시절의 두 형태(adopted 증거 / skipped 링크)와 "보류 시 tracker 를 닫지 못함" 조항은 폐기됐다.

### Acceptance criteria

- [ ] 각 consumer가 unit/source, prerequisite, admission, loss semantics, metric, convergence, rollback evidence를 독립적으로 가진다.

**해설**: `독립적으로` 가 이 이슈 전체의 요점이다. 여섯 consumer 가 하나의 공통 증거를 나눠 쓰는 것은 조건 미충족이다.

- [ ] cap 감소는 기존 entry를 silent truncate하지 않는다.

**해설**: 상한을 줄였다고 이미 큐에 있던 항목을 말없이 잘라내면 안 된다.

- [ ] reliable output/snapshot은 새 admission 중단 → drain 또는 stale → fresh snapshot/new generation으로 수렴한다.

**해설**: 신뢰성이 필요한 출력 계열은 두 경로 중 하나를 탄다. (a) 새로 안 받고 있는 것을 다 내보낸다(drain), 또는 (b) 못 믿는다고 표시하고(stale) 서버에서 화면 전체를 새 세대로 다시 받는다.

- [ ] input/outbox는 기존 entry의 원래 expiry를 보존하고 새 entry 거절을 호출자에게 노출한다.

**해설**: 사용자가 이미 친 키의 유효시간을 정책 변경으로 앞당겨 죽이면 안 된다. 그리고 새 입력을 거절했다면 그 사실을 조용히 삼키지 말고 호출한 코드에 반환해야 한다.

- [ ] socket/protocol mode는 reconnect epoch에서만 전환한다.

**해설**: 소켓/프로토콜 모드는 **양쪽이 같은 가정을 공유해야만 성립하는 값**이다. 연결이 살아 있는 도중에 서버만 모드를 바꾸면 브라우저는 여전히 옛 모드로 해석하므로 그 순간 오가던 데이터가 깨진다. 재연결 시점에는 어차피 처음부터 능력을 다시 협상하므로, **그 경계에서만 바꾸면 어긋날 구간 자체가 생기지 않는다.** "지금 바꾸고 다음 메시지부터 새 모드"는 금지다.

- [ ] 신규 P3~P9 consumer가 policy registry에서 누락되면 test/telemetry가 실패한다.

**해설**: 누락을 사람이 아니라 **자동화가 잡아야 한다**는 요구다. 이 항목은 실제 코드 작업이 필요한 몇 안 되는 항목 중 하나다. `P3~P9` 의 범위는 문서 앞부분의 Phase ↔ 이슈 대응표 기준으로 **#10 ~ #19** 다.

- [ ] silent coercion이 0이고 모든 applicable consumer evidence가 연결되기 전에는 이 tracker와 P10-A를 닫지 않는다.

**해설**: `P10-A` 는 #21(기본값 전환)이다. 즉 **#20 이 안 닫히면 #21 도 못 닫는다.**

### 공통 완료 조건

> - Parent: #2
> - Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
> - 구현 전 Requirement/Stability gate를 SpecKiwi로 확인하며 missing/draft/deprecated 계약에서는 blocked다.
> - behavior change는 failing regression test부터 TDD로 진행한다. evidence-only skip/documentation 분기는 적용 가능한 SpecKiwi·benchmark·review evidence로 검증한다.
> - 관련 test/typecheck/build와 적용 가능한 `https://localhost:2222` 검증을 수행하고 `node.exe`와 TCP 2001/2002 process를 중단하지 않는다.
> - rollout metric과 bounded convergence rollback을 남기며 unsafe legacy 경로는 복원하지 않는다.
> - Phase reviewer finding을 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.

**해설**: `SpecKiwi` 는 이 저장소의 요구사항(SRS) 관리 도구이고, 요구사항 원본은 `docs/spec/` 아래 마크다운에 있다. `Stability` 는 **요구사항이 얼마나 확정됐는지**를 나타내며 `draft` → `evolving` → `stable` 순으로 올라간다. **`draft` 요구사항을 보고 짠 코드는 요구사항이 움직이면 버려지므로**, `missing` / `draft` / `deprecated` 는 전부 blocked 다. 확인 절차는 `docs/spec/00.index.md` §2 에서 scope 문서를 찾고 → 그 문서에서 `### <요구사항 ID> — <제목>` 아래 메타데이터 표의 `| Stability | … |` 행을 읽는 것이며, `speckiwi list --json` + `speckiwi show <ID> --json` 의 `metadata.Stability` 로도 같은 것을 볼 수 있다(MCP 사용 시 `list_requirements` / `get_requirement` 가 같은 일을 한다. ⚠️ `--target wave-5` 로 좁히면 wave-5 에는 0건이라 무조건 빈 결과가 나온다. ⚠️ `speckiwi list` / `speckiwi show` 실행 시 `SRS-E002 Duplicate requirement ID: REL-BGSTAB-015` 진단이 함께 출력될 수 있다. 명령 실패가 아니며 요청한 레코드는 정상적으로 반환된다). `No findings` 는 리뷰어 지적 0건 판정이고, 고친 뒤 **다시 리뷰를 받아** 0건이 나와야 한다.

## 의존성과 순서

**전체를 한 번에 시작할 수 없다.** consumer 별로 시작 시점이 다르다.

| consumer | 무엇이 끝나야 시작하나 |
| --- | --- |
| 브라우저 write/snapshot 큐 | 브라우저 쪽 화면 쓰기가 단일 writer 로 통합되고(#10 `TerminalWriteCoordinator`), 서버가 단일 authority 로 승격되어(#12) 있어야 한다 |
| per-client/session 전달·ACK 큐 | 공정 스케줄러와 ACK/credit 원장이 있어야 한다(#13) |
| hidden 탭 전달/`dataGap` 큐 | 숨은 탭의 데이터 공백 처리와 다시 보일 때의 복구가 있어야 한다(#14) |
| renderer·selection·residency 자원 | WebGL/DOM 렌더러 전환(#15), Unicode·alternate buffer parity 와 selection identity(#16), 숨은 터미널의 렌더러 정지·잔류(#17)가 끝나야 한다 |
| input/outbox/dedup ledger | 입력 exactly-once 코디네이터(#18)가 끝나야 한다 |
| binary/socket 큐 | **적용 대상**. #19 가 채택으로 확정됐다 (2026-08-16) |

**이 이슈가 막고 있는 것**

- **#21 (기본값 전환)** — 선행 조건에 `#20 의 모든 applicable consumer 완료` 가 들어 있다. #20 이 열려 있는 동안 #21 은 시작할 수 없다.
- 결과적으로 **#22 (물리 삭제)** 도 함께 막힌다.

## 참고

- 원본 이슈: `Snoworca/BuilderGate#20` (`gh issue view 20`)
- 연구 문서 Phase 2 / 2A / 2B / 2C: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:489-522`
- wave-master 계획 wave-5 범위: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:83-94`
- 관련 SRS: `docs/spec/30.buildergate-stability.srs.md` — `FR-BGSTAB-001`(`:43`), `FR-BGSTAB-002`(`:103`), `FR-BGSTAB-003`(`:167`), `FR-BGSTAB-012`(`:788`), `FR-BGSTAB-014`(`:1106`), `FR-BGSTAB-015`(`:1206`), `FR-BGSTAB-016`(`:1313`), `FR-BGSTAB-017`(`:1447`), `FR-BGSTAB-018`(`:1586`), `REL-BGSTAB-003`(`:1380`, Byte-aware replay tail and screen repair overflow recovery), `REL-BGSTAB-004`(`:1649`, Fallback replay output preservation and degraded snapshot convergence)
- 정책 컴파일러 구현: `server/src/services/TerminalResourcePolicy.ts`, canary 테스트 `server/src/services/TerminalResourcePolicyCanary.test.ts`
- wave-5 target 등록 위치: `docs/spec/00.index.md:37,45` (Target Map 행과 목표 헤딩. 요구사항 0건이라는 사실 자체는 `speckiwi list --target wave-5 --json` 결과에서 온다)
