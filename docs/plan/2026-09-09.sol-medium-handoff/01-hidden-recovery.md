# Hidden recovery: sol medium 인계 실행 계획

## 0. 현재 위치와 절대 보존할 완료 작업

작성 시 실제 HEAD는 `b3add4d31ac986803fb23eb6548386f434443585`다. runtime/registry admission은 `9f1c68e`에서 구현됐으며 독립177/177, frontend app/test/node typechecks와 No findings가 있다. [runtime 보고서](../../report/2026-09-09.hidden-gap-runtime-admission.md), [상위 설계](../2026-09-09.hidden-recovery-barrier.md)를 읽는다. 이177은 다음 UI 연결의 증거가 아니다. 완료된 admission을 재구현하거나 이름을 바꾸지 않는다. 상위 설계에는 이전 조사 당시의 미래형/API 부재 표현도 남아 있으므로 현재 구현 여부는 위 커밋과 실제 소스로 판단한다.

이 문서는 **구현 인계 계획**이다. 새 제품 코드·테스트 작성/실행을 포함하지 않는다. 아래 결정 작업 D1이 완료되기 전에는 아직 미정인 start/drain callback API를 구현 준비 완료로 취급하지 않는다.

REQ SSOT: `docs/spec/30.buildergate-stability.srs.md:3752` REL-BGSTAB-012, planned/evolving, target wave-3. 현재 작업 모드 sdd, active target wave-5이지만 명시된 기존 wave-3 prerequisite를 다룬다. 재개 시 MCP로 재확인하고 target을 임의 변경하지 않는다. AC-6(복구 apply/drain 전 stale·input 차단)가 직접 목표다. AC-5(시퀀스/ledger), AC-4(full server retained-state)는 연결 경계이며 이 작업만으로 서버 전체 충족을 주장하지 않는다. AC-7 affected-view isolation, AC-8 AI idle, AC-9 renderer residency 불변을 회귀 조건으로 유지한다. AC-1..3 visibility/continuity 서버 전수 검증과 전체 REL012 완료는 별도다.

원래 실패는 `terminalHiddenOutput.test.ts`의 `REL-BGSTAB-012 settles ledger and holds stale view through drain`. 기존 재현 HEAD8263bbd, 11 collected/10pass/1fail, `%TEMP%/buildergate-hidden-existing-red-227936c3d3a14af78e1a1e6992a8bfc5`, stdout SHA256 `0bfcbe3f790dbfe4465cbf94588eaba458ec2c50a207e877e8afc68996ab2c99`. 최초 absent dataGapPending 단언에서 실패하여 뒤 drain 단언은 실행되지 않았다. 이를 현행 재실행 결과로 다시 표기하지 않는다.

## 1. 먼저 읽을 실제 코드 지도

줄 번호는 작성 시 기준이다. 수정 후에는 rg로 symbol을 다시 찾는다.

| 파일/현재 줄 | 실제 symbol 및 읽을 내용 |
|---|---|
| `frontend/src/utils/terminalCheckpointRuntime.ts:66,146,178` | onHiddenDataGapAdmitted 옵션, runtime/registry admitHiddenDataGap, TerminalHiddenGapContext/Result 타입 |
| 같은 파일`:892-947` | admission 검증→immutable notification→failClosed, lastNotifiedGap; cold/visibility/floor/throw 처리 |
| 같은 파일`:950` 부근 | installFreshGeneration: requested view와 strictly advancing stream/checkpoint floor; installed/requested view 구분 |
| 같은 파일`:1328-1333` | accepted start의 activeIdentity 설치, apply/drain flags 초기화, checkpoint-pending 통지 |
| 같은 파일`:1396-1450` | sendLifecycleAck: 실제 identity 매칭, apply 선행, send, duplicate, drain ready 통지 |
| 같은 파일`:1861` | registry admission의 실제 runtime 선택·위임 |
| `frontend/src/contexts/WebSocketContext.tsx:338,686-729,1229` | handoff view Map, visibility publication, 현재 raw gap handler→failSession 순서 |
| `frontend/src/components/Terminal/TerminalView.tsx:3235,3272,3498,3571` | runtime 생성 옵션, input barrier, coordinator drain callback, installed xterm getter 등록 |
| `frontend/src/components/Terminal/TerminalContainer.tsx:1268,1693,3108,3713,3817` | hidden finish, legacy resync ready, raw gap handler, reveal/local restore, 무인자 grid callback |
| `frontend/src/utils/terminalHiddenOutput.ts:24,83,103` | local skip state와 replay-owned barrier; checkpoint identity를 소유하지 않음 |
| `frontend/src/utils/terminalWriteCoordinator.ts:12` | TerminalCheckpointLifecycleMetadata 전체 필드; session/connection은 포함하지 않음 |

현재 admission은 cold capability(active=true지만 activeIdentity=null/recoveryPending=false)를 authority-unavailable로 거절한다. installed view7에서 recovery 요청 후 registrationViewGeneration8이어도 아직 gap의 대상은 installed7이다. equal/older visibility는 epoch floor 검사로 진행한다. reveal publication이 로컬 generation을 먼저 증가시키므로 older hidden gap을 버리면 안 된다. future/absent visibility는 supplied boundary로 floor를 오염시키지 않고 기존 identity로 fail-closed 한다. 이 동작은 이미 검증됐으므로 downstream은 단순 위임해야 한다.

## 2. 적용 순서와 완료 단위

`D1 결정 → T1 routing RED와 T2 lifecycle/owner RED → 독립 RED 리뷰 → RED 커밋 → I1 최소 완결 연결 → V1 회귀/독립 리뷰` 순서다. T1은 T2보다 먼저 작성 가능하지만 Context 활성화는 T2의 matching completion까지 함께 구현한 뒤다. 중간 제품에 no-op owner를 달아 accepted를 얻거나 stale만 latch한 채 영구 차단을 남기지 않는다. runtime-only 완료와 전체 hidden 완료를 섞지 않는다.

모든 artifact는 한 작성자와 다른 검증자를 둔다. 테스트 작성자가 자신의 RED를 판단하지 않는다. 독립 reviewer에게 원본 REQ·계획·diff·raw를 직접 전달하고, 수정은 작성자 또는 별도 fixer가 맡는다. 새 동작은 RED 관찰·커밋 전 구현 금지다.

## D1. Accepted start/drain 및 owner correlation 계약 확정

### 인계용 단일 권고 계약 (아래 후보 표현보다 우선)

후속 모델이 callback 형태를 다시 고르지 않도록 다음 한 가지 계약을 선택한다. D1은 이 계약의 현재 소스 재대조와 독립 승인 작업이다. union callback 하나를 사용하고 두 개의 경쟁 API를 만들지 않는다.

```typescript
type CheckpointRecoverySnapshot = Readonly<{
  runtimeIdentity: object; // runtime 생성 시 한 번 만든 frozen opaque object
  sessionId: string;
  state: Readonly<TerminalCheckpointRuntimeState>;
}>;
type CheckpointRecoveryLifecycleEvent = Readonly<{
  phase: 'started' | 'drained';
  runtimeIdentity: object;
  sessionId: string;
  checkpointIdentity: object; // accepted start별 frozen opaque object, wire ID 아님
  metadata: Readonly<TerminalCheckpointLifecycleMetadata>;
}>;
// Runtime options와 View→Container prop에 같은 이벤트 타입을 사용한다.
onCheckpointRecoveryLifecycle?: (event: CheckpointRecoveryLifecycleEvent) => void;
// runtime과 View handle은 같은 snapshot을 위임한다. View는 없거나 disposed면 null.
getCheckpointRecoverySnapshot(): CheckpointRecoverySnapshot | null;
```

runtimeIdentity는 runtime이 소유한다. View에서 별도로 생성한 identity와 혼합하지 않는다. runtime은 읽기 전용 snapshot getter를 제공하고 View handle은 그대로 위임한다. checkpointIdentity는 accepted start를 설치할 때 한 번 생성해 해당 activeIdentity와 함께 보관한다. public mutation API나 private activeIdentity 자체는 노출하지 않는다. metadata는 기존 scalar 필드만 복사해 freeze한다. optional callback은 기존 사용자의 비hidden 동작을 보존하기 위한 타입이며, 실제 hidden wiring에는 필수로 설치한다. 없는데 hidden owner가 존재하는 활성 경로를 만들지 않는다.

Container pending owner는 `{runtimeIdentity, sessionId, sessionGeneration, connectionGeneration, admittedGap, binding:null|{checkpointIdentity,metadata}, released:false}` 한 개의 참조로 소유한다. gap 통지에서 View snapshot의 runtimeIdentity를 읽어 현재 session/connection과 함께 캡처하고 owner를 설치한다. 기존 owner의 늦은 완료는 이 참조와 맞지 않으므로 폐기한다. 별도 owner counter/history는 없다. accepted start의 viewGeneration은 gap 당시7에서 fresh8로 바뀔 수 있으므로 gap view와 동일 강제하지 않는다. runtime이 승인한 fresh generation을 binding에 저장한다.

**정확한 순서:**

1. gap callback은 owner를 먼저 교체·stale 표시한 뒤 반환한다. existing admit가 이후 failClosed/요청을 수행한다. getter null/runtime불일치면 throw하여 admit의기존failclosed/error보존경로로간다. local 완료는 pending owner가 있는 한 불허한다.
2. start 처리에서 coordinator begin dispatch **직전** 고유 in-process attempt object를 만들어 currentStartAttempt에 설치하고 당시 activeIdentity/checkpointIdentity 참조를 캡처한다. nested start는 자신의 attempt로 교체하며, admitted gap·failure invalidation·dispose도 기존 attempt를 무효화한다. dispatch 반환 후 result.accepted=true뿐 아니라 currentStartAttempt===capturedAttempt, activeIdentity/checkpointIdentity가 dispatch 전 캡처와 동일, runtime/session/view가 현재이며 disposed=false인지를 먼저 검사한다. 하나라도 다르면 outer start는 stale rejection만 반환하고 activeIdentity/flags/started notification에 **쓰기0**이다. 다른 transaction을 failClosed하거나 이미승인된 nested start를 되돌리지 않는다. 모두유효할때만 activeIdentity와새checkpointIdentity를함께설치하고 apply/drain flags를초기화한뒤 started 통지를보낸다. Container는현재owner참조를캡처하고runtime/session/현재connectiongeneration이일치할때만binding을저장한다. 통지중재진입으로owner가교체되면옛처리에서추가쓰기/ready변경을하지않는다. attempt는단일현재참조이며새wirecounter/epoch/history가아니다.
3. drain은함수진입시 activeIdentity참조/checkpointIdentity/runtimeIdentity/viewGeneration을캡처한다. 기존matchesDrainedLifecycle/applyAcked/duplicate조건을먼저적용한다. `options.send` 직전에도캡처한identity가현재인지확인한다. send후에는같은activeIdentity/checkpointIdentity/viewGeneration이며disposed=false/recoveryPending=false인지 **다시 확인한뒤에만** drainAcked/lastDrainAckedSourceSeq를기록한다. 재진입으로새gap/start가생겼으면ACK전송자체는역사로남기고현재ready를변경하지않으며stale completion rejection을반환한다.
4. drained이벤트는위flags기록후기존checkpoint-drained readiness통지보다먼저전달한다. Container는현재owner와binding의checkpointIdentity/runtimeIdentity/session및capturedsession/connectiongeneration을비교한다. metadata의view/stream/checkpoint/snapshot/oldest/retention/chunkCount/encodedByteTotal/digest가start와일치하고sourceSeq는start이상이여야한다. 일치하면그owner만released로표시하고hiddenprojection/자기barrier를한번정리한다. callback반환후runtime도캡처identity/recovery상태를재검사하고일치할때만기존ready통지를보낸다. 새로운owner의barrier는절대지우지않는다.
5. started/drained 통지throw는현재transaction이여전히동일할때만기존failClosed로보호하고원오류를다시던진다. 이미교체된transaction에는oldboundary를다시적용하지않는다. 보호자체throw는기존AggregateError패턴으로원오류와함께보존한다. send성공이이미발생했다면미전송이라고기록하지않는다. duplicate drain에서release이벤트를재발행하지않되기존sourceSeq증가ACK정책은유지한다.
6. local restore 전후는같은getter로runtimeIdentity/session과Containerattempt/sessionGeneration/connectionGeneration을비교한다. 앞뒤모두runtime가존재하고active/recoveryPending/legacyRecoveryPending/checkpointDeliveryPreparationPending/orderedRollbackPending=false,disposed=false,hiddenowner없음이어야한다. runtime교체/null/새gap이면local완료를무시하고기존복구를유지한다. 기존grid용onRestorePendingSettled는이이벤트와독립유지한다.

추가 판단이 필요한 경우는 이 순서를 실제 coordinator 재진입 모델에서 구현할 수 없거나, gap callback의 runtime identity 조회 시 등록보다 앞선 notification이 실제로 가능함이 입증될 때다. 그때에는 원시 호출 순서와 최소 대안을 root에 반환하고 wire/rollback 소유권을 임의 변경하지 않는다. 단순 naming 선택은 재질문하지 않는다. 아래 후보 설명은 조사 배경이며 위 단일 계약으로 대체된다.

**REQ/범위:** REL012 AC-6, AC-5 interface support. 문서만 결정한다. 새로운 wire message, binary rollback owner, server epoch allocation을 만들지 않는다.

**현재 확정:** 기존 `onHiddenDataGapAdmitted(message, context)`는 View가 Container의 실제 owner 등록을 동기 호출해야 한다. 등록은 failClosed의 outbound recovery 요청보다 앞선다. `onRestorePendingSettled?: () => void`는 legacy와 checkpoint 양쪽에서 쓰며 Container에서 grid repair flush로 연결되므로 identity-bearing 완료 통지로 재사용할 수 없다. 그대로 보존한다.

**결정해야 할 API 후보:** runtime options에 하나의 typed checkpoint lifecycle callback을 추가하는 방안과 start/drain 둘로 나누는 방안을 비교하고 작은 쪽을 선택한다. 예시 이름 `onCheckpointLifecycle({phase:'started'|'drained', metadata})`는 **후보**이며 아직 구현 계약이 아니다. metadata는 기존 TerminalCheckpointLifecycleMetadata를 재사용한다. runtime instance/session과 Container의 captured connection/session generation을 어디에서 불변 바인딩할지 타입까지 명시한다. 이미 runtime이 소유한 identity를 Container가 다시 생성하지 않는다.

결정표에 반드시 다음을 답한다:

1. accepted start는 coordinator begin 성공 및 activeIdentity 설치 이후 통지한다. 실패 start는 binding을 만들지 않는다. accepted start와 동기 callback 사이 reentrant gap/connection change가 생기면 기존 start가 새 owner를 덮어쓰지 않도록 어떤 captured reference를 확인하는가?
2. drain은 matching identity·apply-before-drain·ACK send 성공 뒤 통지한다. send가 동기 재진입하여 새 gap/start를 설치할 때 옛 함수가 drainAcked/ready를 새 transaction에 기록하지 않도록 기존 identity 참조를 어떻게 재확인하는가? 현재 sendLifecycleAck를 직접 읽고 RED로 결정한다. 단순 최신 ref 읽기는 금지다.
3. 통지 throw 시 기존 오류를 보존하고 fail-closed 하는 경로와 secondary failure 집계는 무엇인가? ACK는 이미 전송됐을 수 있으므로 send success를 취소됐다고 보고하지 않는다. callback 실패가 ready 성공으로 흘러가지 않게 한다.
4. duplicate 또는 sourceSeq가 증가한 drain ACK에서 owner release는 한 번만 하되 기존 ACK 정책을 유지하는가?
5. 새 gap이 기존 checkpoint start와 drain 사이에 도착하면 기존 start binding을 무효화한다. 새 accepted start만 새 owner에 바인딩한다. runtime recreation/disconnect/session replacement는 옛 owner만 retire하고 새 owner를 release하지 않는다.

6. local-only 완료 조건을 Container가 읽을 read-only View handle도 D1에서 확정한다. 후보는 `getCheckpointRecoverySnapshot(): Readonly<{ runtimeIdentity: object; state: Readonly<TerminalCheckpointRuntimeState> }> | null`이다. View가 private runtime의 실제 `getState()`에 위임하며 boolean을 재계산·복제하지 않는다. runtimeIdentity는 해당 runtime 생성 시 한 번 만든 opaque in-process object 참조다. 실제 runtime의 mutation API는 외부에 노출하지 않는다. runtime이 없거나 dispose됐으면 null이며 local 완료 허가가 아니다. 기존 handle (`TerminalView.tsx:251-253,2956-2964`)의 active/legacyPending/view getter만으로는 pending 전체 조건을 알 수 없다. 이 getter는 완료된177에 없는 새 연결이다.

   Container는 local restore 전 snapshot의 runtimeIdentity, 자기 session/connection generation, 현재 local attempt 및 pending hidden owner 참조를 캡처한다. 비동기 완료 후 getter를 다시 호출해 동일 runtimeIdentity·session/connection·attempt인지, 새 hidden owner가 없는지, active/recoveryPending/legacyRecoveryPending/checkpointDeliveryPreparationPending/orderedRollbackPending 모두false와disposedfalse인지 재확인한다. 시작 시 부적격, null, runtime교체 또는 새 pending이면 local 완료·barrier 해제를 하지 않는다. 나중의 false flags만으로 시작 시 부적격을 정당화하지 않는다. getter의 정확한 이름·opaque identity 보관 위치와 수명·null 처리를 독립 reviewer가 확정해야 한다. runtime recreation/acquire-during-restore를 실제 getter/callback RED로 검증하며, I1에서 임의 getter 또는 별도boolean을 추가하지 않는다.

**pseudocode(동작 순서용, 미정 API를 복붙하지 말 것):**

```text
on admitted gap:
  capture current session/connection/runtime ownership
  replace pending owner; invalidate prior checkpoint binding
  mark affected view stale; preserve input barrier
on accepted start:
  capture pending owner reference + installed checkpoint identity
  bind only if both still current
on accepted drain:
  check captured owner/runtime/session/connection and matching start identity
  if retired/replaced: ignore without clearing anything
  finish that owner's hidden projection once; leave other barriers alone
```

**완료 증거:** 다른 reviewer가 위6항목·정확한 타입/호출 순서에 No findings. **중단 조건:** owner correlation을 새 wire ID/epoch로 해결해야 하거나 shared-session codec rollback 선택이 필요하면 이 작업에서 선택하지 않고 root에 구체 충돌을 반환한다. 결정 미완 상태를 구현 ready로 표현하지 않는다.

## T1. Context → registry/runtime → View owner 통지 RED

**REQ:** AC-6/7, AC-1 visibility generation 경계. **변경 허용:** 새 또는 기존 frontend unit test와 실제 callback extraction용 최소 fixture. 제품 코드 금지.

Context의 정확한 trusted 인자는 다음 기존 값을 즉시 snapshot한다:

```text
context.sessionId = receiving sessionId
context.connectionId = controlConnectionIdRef.current
context.viewGeneration = terminalResponderHandoffViewsRef.current
                         .get(sessionId)?.getViewGeneration() ?? null
context.visibility = visibilityMap.get(sessionId)의 generation/isVisible/interest 값 복사 또는 null
registry.admitHiddenDataGap(msg, context)
```

`SessionHandlers`에는 getViewGeneration이 없다. handoff getter는 실제 xtermGenerationRef를 반환한다. msg.viewGeneration이나 requested registration generation을 trusted 인자로 쓰지 않는다. result.accepted를 확인하되 복구 성공으로 해석하지 않는다. raw session onTerminalDeliveryDataGap와 generic failSession을 추가 호출하지 않는다. runtime observer가 View→Container의 유일한 admitted-gap 통지 경로다.

**실제 harness:** `terminalCheckpointRuntime.test.ts`의 createHarness/gapHarness와 `terminalContainerRecoveryContract.test.ts` 및 `terminalOutputAckCompletion.test.ts`의 AST actual callback 패턴을 먼저 읽는다. Context 실제 switch case를 inert refs로 실행하되 registry/runtime admission은 실제 모듈을 사용한다. 새 parser/가짜 admission 복제 금지. View runtime options의 실제 callback을 추출해 Container callback 포트에 연결한다. source regex만으로 최종 행동 검증을 대체하지 않는다.

**RED matrix:** 정상 현재/older visibility; missing handoff와다른 세션 getter; forged message connection/view; mutable visibility 원본이 callback 중 바뀌어도 전달 snapshot 불변; duplicate 통지1회; future/absent reject가 success handler를 호출하지 않음; cold reject; 실제 registry의 rejected 결과 보존; notification 먼저/첫 recovery send 나중; Container owner가 없음/throw면 성공으로 위장하지 않음; peer session 알림0. 기존177 admission controls는 유지한다.

**증거/중단:** 테스트 이름·정확한 RED 이유·hash·HEAD를 저장하고 independent reviewer에게 전달. 실패가 추출 free binding 누락이면 oracle를 고친 뒤 다시 RED, 제품을 수정해 fixture를 만족시키지 않는다. RED가 실제 owner 부재 때문에 실패하는지 확인해야 한다.

## T2. Container owner와 matching completion RED

**REQ:** AC-6 직접, AC-7/8/9 회귀. **전제:** D1의 lifecycle 타입/오류 정책 확정. **허용:** 실제 runtime/coordinator/Container callback 테스트. 제품 코드 금지.

기존 drain 검증은 `terminalCheckpointRuntime.test.ts`의 `blocks ready and input until matching checkpoint drain ACK`를 재사용한다. 실제 coordinator adapter의 checkpointApplied/checkpointDrained를 통해 지연 callback을 제어한다. input queue/ready와 Container hidden 상태를 함께 관측한다. 이벤트를 가짜로 즉시 성공시키는 observer로 연결 완료를 주장하지 않는다.

필수 cases:

- active legacy resync 없이 gap 수신→pending owner→fresh start/apply→drain ACK 전 stale/input blocked→matching drain 후1회 release.
- legacy resync 있음: 기존 scope/token fence와 provisional local restore 유지; 해당 ready token만으로 full checkpoint owner를 release하지 않음.
- local snapshot 성공 전후 runtime authority 획득 또는 새 gap 발생: local result가 새 owner를 지우지 않음.
- local-only 정상 완료: 현재 runtime 상태가 active/recoveryPending/legacyRecoveryPending/preparationPending/orderedRollbackPending 모두false이며disposedfalse이고 현재attempt일 때 자기 barrier만 release.
- apply만 완료, drain send 실패, mismatched digest/epoch/view, old session/connection/runtime callback, duplicate drain: 새 owner release0/입력 불허. 정상 duplicate는 이미끝난owner를다시release하지 않음.
- gapA→startA→gapB→late drainA→startB/drainB: A의callback은B를지우지않고B만완료. freshcheckpoint epoch를oldgap epoch와단순동일시하지 않음.
- D1에서 정한 send/notification reentrancy와 throw/error aggregation을 실제 함수 호출로 재현.
- 실제 coordinator checkpoint-begin dispatch가동일runtime/session/view 안에서 nested newer start를성공시키는경우, 또는새gap/dispose를재진입시키는경우를각각실행한다. outer dispatch가accepted를반환해도outer identity설치/flags초기화/started통지0이고 nested transaction 또는현재failure/disposed상태가보존되는지단언한다. 단순runtime/session동일성검사만으로통과할수없는counterexample이어야한다.
- renderer suspend/dispose/WebGL 정책 및 semantic session running 전환 호출이 추가되지 않음; affected view 외상태불변.

**기존 모순 테스트 처리:** terminalHiddenOutput.test.ts의 local owned replay 테스트는 동일 start/finish 입력에서 false를 기대하고 REL012 placeholder는 true를 기대한다. 둘을boolean플래그로억지분리하거나placeholder삭제만으로GREEN 만들지 않는다. 실제 authoritative pending owner/drain harness로후자계약을이전하는구체diff와원래AC-6보존근거를먼저리뷰한다. 기존local-helper10개행동과새실제authoritativecases를모두보존한다. dataGapPending필드존재는serverledger정산증거가아니다. 테스트명에서ledger완료를주장하려면실제server ledger검증이별도로필요하다.

## I1. 최소 완결 연결

**시작 조건:** T1/T2 RED를 독립 검토하고 커밋한 뒤다. **범위:** Context gap case, View runtime options/typed props, Container owner/완료callback, D1에서승인한runtime lifecycle통지지점 및필요한좁은타입만. 기존gapadmission검증을복사하지않는다.

1. D1 identity-bearing notifications를runtime에추가하고완료전후fence/오류보존을구현한다.
2. View의기존runtime생성closure에서현재instance에묶어Container로전달한다. onRestorePendingSettled/gridflush기능그대로둔다. checkpointInputBarrierRef와runtime readiness를재사용한다.
3. Container owner를admittedgap/start/drain에연결한다. 기존sessionGenerationRef/wsConnectionGenerationRef, mountedruntimeidentity와pendingownerreference를사용한다. 새protocol counter나unboundedMap을추가하지않는다.
4. no-active-resync case가완결되는지확인한뒤Context를actualadmission으로전환한다. rawhandler→failSession중복경로를이case에서만제거한다. 다른failSession caller/route결과형태는그대로다.
5. local finish 호출5경로(local-snapshot/screen-snapshot/screen-repair/authoritative-resync/compatibility-post-ack-tail)를읽어authoritativeowner를우회해clear할수없게한다. 단legacy정상복구를무조건막지않는다.

**금지:** UI모양변경,서버ledger/retention정책변경,binaryACK자동연결,codec rollbackowner결정,기존localcache/legacy물리삭제,Orca수정. 이런변경이필요하면범위를늘리지말고근거와별도REQ결정task를보고한다.

## V1. 명령·안전·완료 증거

cwd는 `C:/Work/git/_Snoworca/ProjectMaster/frontend`. 새test파일을최종선택에명시적으로추가한다. 아래는기존관련회귀명령이며아직실행하지않았다:

```powershell
node --require ../server/tools/require-owned-http-test-pipe.cjs --experimental-strip-types --test tests/unit/terminalCheckpointRuntime.test.ts tests/unit/terminalCheckpointCapabilityScoping.test.ts tests/unit/terminalContainerRecoveryContract.test.ts tests/unit/terminalHiddenOutput.test.ts tests/unit/terminalOutputAckCompletion.test.ts
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
```

선택파일과그import에새listener/process/Worker가없는지실행전읽는다. 기존 admission-process-observer를재사용해자연close까지UTF-8stdout/stderr와code/signal/elapsed/오류를저장한다. deadline notice는kill허가가아니다. NODE_OPTIONS가있으면값의영향을검토하고silent제거하지않는다. NODE_TEST_*만기존정책으로child env에서필터한다. 새uniqueTemp결과경로와no-listen log를사용하고기존증거를덮어쓰지않는다. no-listen preload경로는실제cwd기준검증한다. plain frontend root tsc는appcoverage아님. 새test파일이tsconfig.test에포함되는지확인한다.

독립reviewer는마지막제품변경후focusedGREEN+실제counts+typechecks+sourcehash를확인한다. 문서수정만후에는동일테스트를반복하지않는다. baseline177은보존된회귀기준이며신규전체counts는실측한다. 일반frontend전체baseline에는다른미해결test가있을수있으므로부분green을전체green으로표기하지않는다.

최종증거에는before/afterHEAD및source/testhash,명령/환경정책,cwd,rawUTF8hash,code/signal,테스트총수/실패/skip/TODO/cancel,명시typecoverage,독립No findings,원래placeholder의대체coverage근거를기록한다. 완료범위는browser hidden-owner 연결이며fullserverretainedrange·REL0129AC전체·binaryrollback·E2E완료가아니다.

실제E2E는이unit단계명령에포함하지않는다. 필요시B2workspaceownership/canonicalinput/2222전용start.bat·stop.bat·정확listenerPID계약을다시읽고별도사전검토한다. 보호2001/2002및다른node.exe종료금지. 독립리뷰가Medium이상을반환하면다른작성자fix→재리뷰,원래목표를줄여완료처리하지않는다.
