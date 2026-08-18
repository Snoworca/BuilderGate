# 새 터미널 경로를 "기본값"으로 바꾸되 언제든 되돌릴 수 있게 하기

> 원문 제목: `[Orca][P10-A] 새 terminal path reversible default flip과 rollback drill`
> 원본 이슈: `Snoworca/BuilderGate#21` — https://github.com/Snoworca/BuilderGate/issues/21

## 한 줄 요약

wave-2~wave-4 에서 만들어 옵션 뒤에 숨겨 두었던 새 터미널 경로를 **아무 설정도 건드리지 않은 사용자에게 적용되는 기본값**으로 바꾸는 작업이며, 옛 경로를 지우지는 않고 **버튼 하나로 되돌아갈 수 있는 상태를 유지**해야 한다.

## 지금 무슨 문제가 있나요?

지금 BuilderGate 에는 터미널 경로가 사실상 **두 벌** 존재한다.

- **새 경로**: 브라우저 쪽 단일 writer(`frontend/src/utils/terminalWriteCoordinator.ts`), 서버 authority 모델, 공정 스케줄러(`server/src/ws/wsSendPolicy.ts` → `server/src/ws/WsRouter.ts:542-546`), 정책 컴파일러(`server/src/services/TerminalResourcePolicy.ts`) 등.
- **옛 경로**: 브라우저 localStorage 스냅샷 복원(`frontend/src/utils/terminalSnapshot.ts`), 그 위에 얹힌 여러 호환 설정들.

### 어느 플래그가 어느 경로를 기본값으로 쓰고 있나 (2026-08 기준, 소스 확인)

새 경로는 지금까지 대체로 canary(일부 대상에게만 켜 보는 시험 적용) 상태에 머물러 있었다. 다만 **"새 경로는 아직 기본값이 아니다"를 통째로 말하면 틀린다 — 플래그마다 다르다.** 실제로는 이미 새 경로가 기본값인 것도 있다. 아래는 소스에서 직접 확인한 현재 상태다.

| 설정 키 | 현재 기본값 | 그 기본값이 가리키는 경로 | 선언 위치 |
| --- | --- | --- | --- |
| `stabilityModes.frontendRuntimeResidency` | `bounded` | **새 경로.** `bounded` 가 아니면 모든 탭을 그대로 상주시키는 옛 동작으로 빠진다 | `server/src/schemas/config.schema.ts:202` |
| `stabilityModes.wsSendMode` | `direct` | **옛 경로.** 새 경로는 `safe-send-observe` / `safe-send-enforce` | 같은 파일 `:201` |
| `stabilityModes.headlessQueueMode` | `observe` | ⚠️ **경로를 고르지 않는다.** 서버 런타임에 `observe`/`bounded` 분기가 없어 두 값이 같은 bounded 큐를 쓴다(#22 참고) | 같은 파일 `:200` |
| `realtime.wsTransportMode` | `unified` | **옛 경로(단일 소켓).** split 소켓은 `split-shadow` / `split` | 같은 파일 `:56` |

읽는 법:

- `frontendRuntimeResidency` 의 소비 지점은 `frontend/src/hooks/useTerminalRuntimeResidency.ts:137` 이며, 값이 `'bounded'` **가 아닐 때** 실행 가능한 탭 전부를 상주 목록에 넣는 옛 동작으로 되돌아간다. 즉 이 항목은 **이미 새 경로가 기본값**이다.
- `server/config.json5` 는 `stabilityModes.wsSendMode` 를 `"safe-send-enforce"` 로 **오버라이드**해 두었다(`:90-91`). 저장소에 들어 있는 이 설정 파일을 쓰는 환경에서는 이 키만 이미 새 경로다. `realtime` 블록은 아예 없으므로 `wsTransportMode` 는 스키마 기본값 `unified` 그대로다.
- 프론트엔드 쪽 타입 선언은 `frontend/src/types/settings.ts:125-127`, 서버 타입은 `server/src/types/config.types.ts:184-186` 에 있다. 값을 하나 바꾸면 이 네 곳(스키마·서버 타입·프론트 타입·`config.json5`)이 함께 움직인다.

**그리고 플래그와 무관하게 살아 있는 옛 경로가 하나 더 있다** — 브라우저 localStorage 스냅샷 복원(`frontend/src/utils/terminalSnapshot.ts`)이다. 위 어느 값을 바꿔도 이 경로는 꺼지지 않는다. 이것을 지우는 것은 #22 의 일이다.

⚠️ **위 네 개가 "새 경로를 가로막는 키의 전부"라고 확정된 것은 아니다.** 이 목록은 `stabilityModes` / `realtime` 스키마 블록을 훑어 만든 것이지, 어딘가에 선언된 다른 게이트가 없다는 증명이 아니다. 그래서 **이 이슈의 0단계는 "새 경로를 게이트하는 키를 전부 열거하는 것"** 이다(아래 참조).

이 상태를 오래 두면 세 가지가 동시에 나빠진다.

1. **새 경로가 실전 데이터를 못 받는다.** 느린 네트워크(WAN), 8클라이언트 동시 접속, 32~54개 세션, 탭을 숨겼다 다시 보이기, 서버 재시작 같은 진짜 상황은 기본값이 되어야만 충분히 밟힌다. (이 숫자들은 임의 예시가 아니라 연구·계획 문서 `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`(이하 "연구 문서") §10.1 검증 matrix `:728-740` 에서 온 축이다 — client 수 `1 / 2 / 8`, session 수 `1 / 8 / 32 / 54`.)
2. **두 벌을 계속 같이 고쳐야 한다.** 버그 하나에 두 경로 모두 수정이 필요하고, 한쪽만 고쳐지면 조용히 어긋난다.
3. **#22(옛 코드 물리 삭제)가 시작조차 못 한다.** 삭제의 전제 조건이 "새 경로가 기본값으로 두 릴리스 이상 버텼다"이기 때문이다.

동시에, 기본값을 바꾸는 일 자체가 위험하다. 기본값을 바꾸면 **아무 설정도 안 건드린 모든 사용자가 한꺼번에 새 경로로 넘어간다.** 여기서 문제가 터지면 영향 범위가 곧 전체다. 그래서 이 이슈의 절반은 "바꾸기"가 아니라 **"안전하게 되돌아오기"** 에 관한 것이다.

## 왜 고쳐야 하나요?

- **안 바꾸면**: 두 경로를 영원히 병행 유지해야 한다. 유지비가 계속 나가고, 새 경로의 실전 검증은 영원히 미완이며, wave-5 전체가 여기서 멈춘다.
- **되돌릴 준비 없이 바꾸면**: 사고가 났을 때 되돌리는 절차를 **사고 한복판에서 처음 만들게 된다.** 그 시점에 설정 백업이 없으면 사용자가 원래 쓰던 값도 복구할 수 없다. 특히 마이그레이션 과정에서 설정 스키마가 바뀌었다면, 옛 빌드로 롤백해도 설정 파일을 못 읽는 상황이 생긴다.

그래서 이 이슈의 제목에 `reversible`(되돌릴 수 있는)과 `rollback drill`(되돌리기 훈련)이 함께 들어 있다.

## 배경 지식

### default flip (기본값 전환)

**설정을 명시적으로 지정하지 않은 사용자에게 적용되는 값**을 A에서 B로 바꾸는 것이다. 기능 플래그(feature flag)의 기본값을 뒤집는다고 생각하면 된다. 코드 변경량은 한 줄일 수도 있지만, **영향 범위는 전체 사용자**다. 그래서 코드 크기와 위험도가 전혀 비례하지 않는 대표적인 변경이다.

### facade / compatibility facade (파사드 / 호환 파사드)

**겉모습(호출 방법)은 그대로 두고 속만 바꿔 끼우기 위한 얇은 껍데기 층**이다. 건물 정면(facade)만 옛날 모습으로 남기고 내부를 다 새로 짓는 리모델링과 같다. BuilderGate 에는 이미 이 패턴이 여러 곳에 있다. 예를 들어 `frontend/src/components/Terminal/TerminalView.tsx:1495-1539` 의 `writeOutputDirect` 는 이름은 "직접 쓰기"지만 실제로는 `getTerminalWriteCoordinator(term)` 를 찾아 `coordinator.submitCompatibility(...)` 로 넘긴다. 옛 호출부는 그대로 두고 실제 동작만 새 코디네이터로 옮긴 것이다. #21 이 요구하는 것은 **기본값을 바꾸더라도 이 껍데기를 없애지 말라**는 것이다. 껍데기가 살아 있어야 되돌아올 길이 있다.

### legacy config parser (옛 설정 해석기)

**옛 형식으로 저장된 설정 파일을 계속 읽을 수 있는 코드**다. 새 설정 스키마로 넘어가도, 사용자 디스크에 남아 있는 옛 파일은 여전히 읽혀야 한다. 이걸 지우는 순간 "업데이트했더니 내 설정이 다 날아갔다"가 된다.

### capability handshake (능력 협상)

연결할 때 서버와 브라우저가 서로 **"나는 이런 것을 할 수 있다"** 를 먼저 교환하고 공통분모를 고르는 절차다. 새 브라우저 + 새 서버면 새 경로, 옛 브라우저 + 새 서버면 옛 경로로 각자 안전하게 간다. #21 의 AC는 여기에 조건을 하나 더 건다: **알 수 없는 조합은 관측 가능하게 거부(observable reject)** 하라. "모르겠으니 일단 새 경로로 해보자"는 최악이다. 어긋난 상태로 동작하다가 데이터를 깨뜨린다.

### downgrade / mixed-version downgrade (다운그레이드 / 혼합 버전 다운그레이드)

한 서버에 새 버전 클라이언트와 옛 버전 클라이언트가 **동시에** 붙어 있는 상황을 mixed-version 이라고 한다. 이때 옛 클라이언트를 위해 서버가 옛 방식으로 내려앉아 주는 것이 downgrade 다. 실전에서는 이게 예외가 아니라 정상이다. 사용자가 탭 두 개를 열어 두고 한쪽만 새로고침해도 곧바로 mixed-version 이 된다.

### connectionEpoch / reconnect epoch (연결 세대)

연결이 새로 맺어질 때마다 **1씩 올라가는 세대 번호**다. `server/src/ws/WsRouter.ts:542-546` 의 fair scheduler 등록부에도 `connectionEpoch` 가 들어 있다. 이게 필요한 이유는 **끊기기 직전에 출발한 옛 응답이 재연결 뒤에 뒤늦게 도착**할 수 있기 때문이다. epoch 가 다르면 "지난 세대 것"이라 판단해 버릴 수 있다. rollback 절차가 `connectionEpoch` 증가를 포함하는 이유도 같다. **세대를 끊어야 옛 세대의 잔여물이 새 세대를 오염시키지 않는다.**

### fresh authoritative snapshot (신뢰 가능한 최신 전체 화면)

**서버가 "지금 화면은 이렇다"고 보내 주는, 권위 있는 현재 상태 전체**다. 부분 복구는 어긋날 여지가 있지만 전체 스냅샷은 어긋날 수 없다. 그래서 되돌리기의 마지막 단계는 항상 "서버에서 화면 전체를 새로 받는다"로 끝난다.

### rollback drill (롤백 훈련)

**되돌리기를 평소에 미리, 자동으로 연습해 보는 것**이다. 소방 훈련과 같다. "되돌릴 수 있다"는 코드가 있는 것과, "되돌려 봤더니 실제로 됐다"는 실행 결과가 있는 것은 전혀 다르다. AC는 이 훈련이 **자동화**되어야 한다고 요구한다. 사람이 손으로 하는 절차는 사고 당일 밤에 아무도 못 한다. 이 이슈의 훈련 시나리오는 4단계다:

1. 기본값을 옛 경로로 되돌린다
2. 설정 백업을 복원한다
3. `connectionEpoch` 를 올리고 능력을 재협상한다
4. 서버에서 fresh authoritative snapshot 을 받아 화면을 다시 그린다

### backup artifact (백업 산출물)

마이그레이션 **전에** 남겨 두는 파일이다. AC가 요구하는 항목은 네 가지다. (1) 원본 설정 그대로, (2) 사용자가 **명시적으로 지정한 / 기본값이 아닌 키** 목록, (3) 계산된 실효 정책(`effectivePolicy`), (4) 설정 스키마 버전. (2)가 중요한 이유는, 되돌릴 때 **"이 사용자는 원래 뭘 일부러 바꿔 놨는가"** 를 알아야 하기 때문이다. 전체 설정만 백업하면 기본값과 의도적 지정을 구분할 수 없다.

### cohort (코호트)

**같은 조건을 공유하는 사용자 집단**이다. AC의 `local cache disabled cohort` 는 "브라우저 로컬 캐시를 쓰지 않는 상태의 사용자들"이다. 이 집단을 따로 봐야 하는 이유는, 이들이 **브라우저 스냅샷 복원의 도움 없이 순수하게 서버 authority 만으로** 동작하기 때문이다. 새 경로가 진짜로 서버 authority 만으로 옳게 도는지 검증할 수 있는 유일한 집단이다.

⚠️ **이 cohort 를 만드는 설정 스위치는 현재 존재하지 않는다.** 소스에서 확인한 것은 두 가지뿐이다.

- 서버가 "이 복구는 로컬 캐시 없이 이뤄졌다"를 **사후에 기록**하는 증거 필드 — `server/src/services/SessionManager.ts:2754-2760` 의 `noLocalCacheEvidence`(`localCacheUsed: false`, `serverCheckpointApplied: true`)와 그것을 판정하는 `noLocalCacheParity`(`:2823-2826`). 이건 **관측 결과이지 스위치가 아니다.**
- 테스트에서 조건을 만드는 유일한 방법으로 확인된 것은 브라우저 저장소를 비우는 것 — `frontend/tests/e2e/settings-resource-limits.spec.ts:211` 의 `localStorage.clear()`.

즉 **"로컬 캐시 비활성 cohort 를 어떻게 만들 것인가"가 이 이슈의 검증 0단계다.** 설정 키를 새로 만들지, 테스트 하네스에서 저장소를 비우는 방식으로 재현할지, 아니면 위 `noLocalCacheParity` 증거를 만족한 세션만 골라내는 방식으로 정의할지를 **먼저 정하고 SRS 로 확정한 뒤** 검증을 시작해야 한다. 정하지 않은 채로는 이 AC 를 통과시켰다고 주장할 수 없다.

### retained state (보존 상태) / hard reload (강제 새로고침)

**retained state** 는 새로고침이나 재연결을 넘어 살아남아야 하는 터미널 내용(스크롤백, 커서, alternate buffer 등)이다. **hard reload** 는 캐시를 무시하고 페이지를 완전히 다시 받는 새로고침(Ctrl+Shift+R)이다. 로컬 캐시가 꺼진 상태에서 hard reload 를 하면 브라우저에는 아무것도 안 남으므로, 화면을 복구할 근거는 서버뿐이다. 이게 새 authority 모델의 가장 혹독한 시험이다.

### G9 recovery-equivalence (G9 복구 동등성)

⚠️ **`G9` 의 정의는 이 저장소 어디에도 없다.** 연구 문서 본문에서 `G9` 가 나오는 곳은 단 한 줄, refresh 연구 문서 `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md:525` 의 위험 표 한 칸이다 — *"| local cache 조기 삭제 | 별도 G9 recovery-equivalence gate | cache deprecation 중단 |"*. 이름만 있고 정의가 없다. (`G1` 도 정의가 아니라 사용례로만 등장한다 — 같은 문서 `:357`.)

아래는 **위 한 줄의 문맥에서 추론한 뜻이지 확정된 정의가 아니다.**

> (추론) **"옛 경로로 복구한 결과와 새 경로로 복구한 결과가 같아야 한다"** 는 조건. 서버 재시작 후, 그리고 오프라인이었다가 돌아온 후에 사용자가 보는 화면이 두 경로에서 동일해야 한다. "새 경로가 더 빠르다"만으로는 부족하고 **결과가 같아야** 기본값을 바꿀 자격이 생긴다.

이 이슈의 완료 조건이 `G9 recovery-equivalence` 를 하드 게이트로 걸고 있으므로, **작업 시작 전에 #23 에서 이 게이트의 정확한 판정 기준(무엇을 무엇과 비교하고, 어디까지 같아야 통과인가)을 요구사항으로 확정해야 한다.** 추론된 정의를 근거로 통과/미통과를 판정하면 안 된다.

### SLO (Service Level Objective, 서비스 수준 목표)

"이 정도는 지킨다"고 숫자로 정한 약속이다. 예: "새로고침 후 화면 복구 p95 1초 이내". AC의 `합의된 SLO` 는 **미리 합의되어 있어야 한다**는 뜻이다. 측정한 뒤에 "이 정도면 됐네"라고 기준을 맞추면 그건 SLO가 아니다.

> ⚠️ 현재 wave-5 target 에 배정된 SRS 요구사항이 0건이므로(`speckiwi list --target wave-5 --json` → `{"records":[]}`; `docs/spec/00.index.md:37,45` 는 target 등록 위치일 뿐 건수를 말하지 않는다), **여기서 말하는 SLO 의 구체적 숫자는 아직 확정되어 있지 않다.** 작업 시작 전에 SRS 로 먼저 확정해야 한다.

## 무엇을 만들어야 하나요?

### 0. 게이트 키를 전부 열거한다 (다른 어떤 것보다 먼저)

이 이슈는 "기본값 하나를 뒤집는다"처럼 들리지만, **뒤집을 대상이 몇 개인지가 확정되어 있지 않다.** 그러므로 첫 작업은 코드 수정이 아니라 목록 만들기다.

1. `server/src/schemas/config.schema.ts` 를 열어 **새 경로를 게이트하는 키를 전부 찾는다.** 앞의 표에 있는 `stabilityModes` 3개(`:200-202`)와 `realtime.wsTransportMode`(`:56`)가 출발점이지 전부라는 보장은 아니다.
2. 키마다 네 가지를 적는다: **현재 기본값 / 그 값이 옛 경로인지 새 경로인지 / 실제 소비 지점(파일:라인) / `server/config.json5` 오버라이드 유무.**
3. 같은 키가 `server/src/types/config.types.ts` 와 `frontend/src/types/settings.ts` 양쪽에 선언돼 있는지 확인한다. 한쪽만 바꾸면 타입이 어긋난다.
4. **플래그로 끌 수 없는 옛 경로**(예: localStorage 스냅샷 복원)를 따로 분리해 적는다. 이것들은 #21 의 대상이 아니라 #22 의 대상이다.
5. 이 목록이 곧 "기본값 전환의 범위"이고, 롤백 훈련이 되돌려야 하는 대상 목록이기도 하다. **목록이 확정되기 전에는 1~4단계를 시작하지 않는다.**

### 1. 백업 먼저 (코드 변경 전)

마이그레이션 코드보다 **백업 산출물 생성기를 먼저 만든다.** 되돌릴 수 없는 변경을 만들기 전에 되돌아갈 자료를 확보한다. 남길 것: 원본 설정, 명시적/비기본 키 목록, `effectivePolicy`, 스키마 버전.

### 2. 능력 협상 경로 정리

- 새 클라이언트 ↔ 새 서버 → 새 경로
- 옛 클라이언트 ↔ 새 서버 → 옛 경로(downgrade)
- **알 수 없는 조합 → 관측 가능한 거부.** 조용히 아무 쪽으로나 붙지 않는다.

### 3. 롤백 훈련 자동화 (기본값을 바꾸기 *전에*)

기본값 전환 커밋보다 **롤백 훈련이 먼저 통과해야 한다.** 훈련이 없는 상태에서 기본값을 바꾸면 되돌릴 방법이 검증되지 않은 채 전체 사용자가 새 경로에 올라탄다. 훈련은 4단계(기본값 복귀 → 설정 백업 복원 → `connectionEpoch` 증가/재협상 → fresh snapshot)를 자동으로 수행하고 결과를 검증해야 한다.

### 4. 기본값 전환

여기서야 기본값을 바꾼다. 이때 **지우지 않는 것들**: compatibility facade, legacy config parser, mixed-version downgrade 경로.

### 5. 검증

- **local cache disabled cohort** 에서: 설정된 retained state 가 hard reload 를 넘어 유지되는가
- **WAN**(느린 원거리 네트워크)에서: SLO 를 지키는가
- **hidden reveal**(숨긴 탭을 다시 보이게 하기): 화면이 옳게 복구되는가
- **server-restart / offline** 후 G9 recovery-equivalence: 옛 경로와 같은 결과인가
- 필수 topology/correctness/performance gate 통과
- 선행 Phase 리뷰어 결과가 모두 `No findings`

### 6. 하지 말아야 할 것

일반 Settings 화면에 새 profile UI 를 추가하는 것은 **이 이슈의 범위가 아니다.** 필요하다고 판단되면 **별도로 사용자 승인을 받은 변경만** 포함한다. 기본값 전환에 UI 변경을 끼워 넣으면 문제가 생겼을 때 원인이 둘 중 무엇인지 가릴 수 없다.

## 완료 조건 (원문 유지)

### Acceptance criteria

- [ ] 새 path가 기본값이지만 compatibility facade, legacy config parser와 mixed-version downgrade를 유지한다.

**해설**: 기본값만 바꾸고 **옛 코드는 그대로 둔다.** 삭제는 #22 의 일이다. 이 순서를 지켜야 되돌릴 수 있다.

- [ ] migration 전 원본 config, explicit/non-default key, effective policy, schema version을 backup artifact로 남긴다.

**해설**: 네 가지를 다 남겨야 한다. `explicit/non-default key` 는 "사용자가 일부러 기본값과 다르게 설정한 키"다. 이걸 따로 기록해야 롤백 시 사용자의 의도를 복원할 수 있다.

- [ ] capability handshake가 new/old client에 safe bounded path를 선택하고 unknown 조합은 observable reject한다.

**해설**: `safe bounded path` = 안전하고 자원 사용에 상한이 있는 경로. `observable reject` = 거부했다는 사실이 로그/지표로 관측되어야 한다. 조용히 실패하면 안 된다.

- [ ] default 복귀 → config backup restore → `connectionEpoch` 증가/renegotiation → fresh authoritative snapshot rollback drill이 자동화된다.

**해설**: 롤백 4단계를 사람 손이 아니라 **자동화된 절차**로 만들고, 그 절차가 실제로 통과함을 보여야 한다.

- [ ] local cache disabled cohort에서 configured retained-state hard reload, WAN, hidden reveal과 server-restart/offline G9 recovery-equivalence가 합의된 SLO를 통과한다.

**해설**: 가장 가혹한 조건(로컬 캐시 없음)에서 네 가지 시나리오를 모두 통과해야 한다. `합의된 SLO` 는 사후에 정한 기준이 아니라 사전에 확정된 숫자를 뜻한다.

- [ ] required topology/correctness/performance gate가 통과하고 모든 선행 Phase reviewer 결과가 `No findings`다.

**해설**: `topology` 는 클라이언트 수 × 세션 수 × 표시 상태 × RTT × 손실률 등의 조합 매트릭스다(연구 문서 §10.1 검증 matrix 참고). **`모든 선행 Phase`** 이므로, 앞선 어느 Phase 하나라도 리뷰 지적이 미해결이면 #21 은 닫히지 않는다.

- [ ] 일반 Settings profile UI가 필요하면 별도 사용자 승인을 받은 변경만 포함한다.

**해설**: UI 변경은 자동으로 딸려오는 것이 아니라 **별도 승인 사항**이다.

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

`Stability` 는 **요구사항이 얼마나 확정됐는지**를 나타내는 값이며 `draft` → `evolving` → `stable` 순으로 올라간다(그 밖에 `frozen`, `deprecated` 가 있다). **`draft` 요구사항을 보고 짠 코드는 요구사항이 움직이면 버려진다.** 그래서 `missing` / `draft` / `deprecated` 는 전부 blocked 다. 이 이슈는 한 단계 더 엄격해서 **`evolving` 으로도 부족하고 `stable` 이어야** 한다.

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
   - 있는데 `Stability` 가 `draft` 또는 `evolving` → **blocked.** `stable` 로 승급되기 전에는 관련 동작을 구현하지 않는다.
   - 있는데 `deprecated` → **blocked.** 폐기 예정 계약을 근거로 구현하지 않는다.
   - `stable` → 통과.
4. **ID 를 적는다.** 여기서 "이 body" 란 **GitHub 이슈 #21 의 본문**을 말한다. 찾은 요구사항 ID 를 그 본문에 그대로 적어 넣는다(예: `Refresh authority Requirement: REL-BGSTAB-0NN`). 이 문서에 적는 것으로 갈음되지 않는다 — 게이트가 지목하는 곳은 이슈 본문이다.

한 줄로 줄이면: **코드보다 요구사항 확정이 먼저이고, 확정됐다는 사실을 이슈 본문에 ID 로 남겨야 시작할 수 있다.**

나머지 항목 중 `No findings` 는 리뷰어가 지적사항 0건을 판정했다는 뜻이며, 지적을 고친 뒤 **다시 리뷰를 받아** 0건이 나와야 한다.

## 의존성과 순서

선행 목록이 길지만, 요약하면 **"기본값을 바꾸려면 새 경로의 모든 조각이 완성되고, 정책이 모든 큐에 증명되고, 데이터 평면 결정이 끝나 있어야 한다"** 이다.

**A. 새 경로 자체가 완성되어야 한다 (#3~#18, 전부 필수)**

| 묶음 | 이슈 | 무엇이 끝나야 하나 |
| --- | --- | --- |
| 기준선 | #3 | split 계약 drift 해소, 벤치마크 기준선 고정 |
| hot-path 정정 | #4, #5, #6, #7 | UTF-8 스케줄러, 화면 복구 수렴, 버퍼 상한, paste/copy 소유권 |
| 정책 | #8, #9 | 정책 컴파일러 관찰 모드, 비손실 canary |
| 단일 writer·authority | #10, #11, #12 | 브라우저 단일 writer, 서버 모델 authority, 단일 authority 승격과 롤백 epoch |
| 전달·복구 | #13, #14 | 공정 스케줄러/ACK 원장, hidden `dataGap` 과 reveal 복구 |
| 렌더러·입력 | #15, #16, #17, #18 | WebGL/DOM 전환, Unicode·selection, hidden 잔류, 입력 exactly-once |

**B. 정책이 모든 큐에 증명되어야 한다**

- **#20** 의 applicable consumer 가 **전부** 완료. #20 자체 AC 에도 "#20 과 P10-A(=이 이슈)를 함께 닫지 않는다"고 명시돼 있다.

**C. 새로고침 상태 계약이 확정되어야 한다**

- **#23** 의 retained-state 계약 (요구사항 exact ID + `Stability=stable`)
- **#12** 의 no-local-cache hard-reload canary

**D. 데이터 평면 결정이 끝나 있어야 한다**

- **#19** — **채택으로 결론남** (2026-08-16, `docs/research/binary-comms/00-decision-record.md`). 미채택 분기는 폐기됐으므로 이 선행 조건은 "#19 의 구현이 완료될 것" 하나로 단순화된다.

**이 이슈가 막고 있는 것**

- **#22 (옛 코드 물리 삭제)** — #21 완료가 첫 번째 선행 조건이다. 게다가 #21 이 끝난 시점부터 **두 릴리스의 soak 시간**을 세기 시작한다.

## 참고

- 원본 이슈: `Snoworca/BuilderGate#21` (`gh issue view 21`)
- 연구 문서 Phase 10 / 10A: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:686-694`
- 검증 matrix(topology/transport 축): 같은 파일 `:728-740`
- refresh 연구 Phase 10-A: `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md:411-416`
- wave-master 계획 wave-5 범위/gate: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:83-94`
- 관련 SRS: `docs/spec/30.buildergate-stability.srs.md` — `FR-BGSTAB-001`(`:43`), `FR-BGSTAB-008`(`:551`), `FR-BGSTAB-013`(`:1026`), `FR-BGSTAB-015`(`:1206`), `REL-BGSTAB-007`(`:2811`, configured retained-state server authority and refresh equivalence)
- wave-5 target 등록 위치: `docs/spec/00.index.md:37,45` (Target Map 행과 목표 헤딩. 요구사항 0건이라는 사실 자체는 `speckiwi list --target wave-5 --json` 결과에서 온다)
- 호환 파사드 실제 예시: `frontend/src/components/Terminal/TerminalView.tsx:1495-1539` (`writeOutputDirect` → `coordinator.submitCompatibility`)
- `connectionEpoch` 사용 지점: `server/src/ws/WsRouter.ts:542-546`
