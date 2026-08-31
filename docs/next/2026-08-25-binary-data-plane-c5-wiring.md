# 바이너리 데이터 평면 S4-C5 배선 3건 — 세션 핸드오프

| Field | Value |
| --- | --- |
| 작성일 | 2026-08-25 |
| 저장소 / 브랜치 | `C:/Work/git/_Snoworca/ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| HEAD | `dfca40cf506dcbc60a170a7f3ca4fbe9f426b9d9` — **이 작업은 전부 미커밋** |
| 최종 작업 목표 | S4-C5 의 남은 **배선 3건**(C5-b 수신 분기 · C5-c 채널 등록부 · C5-d 토큰 ref)을 TDD 로 구현 |
| 현재 상태 | **2026-08-26 갱신** — C5-a·C5-e 에 더해 **배선 3건(C5-b·C5-c·C5-d)도 구현 완료**. 남은 것은 **통합**과 그 앞단(S4-a·D10) |
| SSOT | `C:/Work/git/_Snoworca/ProjectMaster/docs/next/2026-08-19-binary-data-plane-handoff.md` |
| 다음 세션 첫 행동 | 아래 §0 |

> 이 문서는 **배선 3건에 한정한** 실행 지시서다. 프로젝트 전체 맥락·결정 이력·함정 27종은 위 SSOT 에 있고 이번 세션까지 최신 상태로 갱신돼 있다. 둘 다 읽어야 한다.

---

## 0. 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. SSOT `C:/Work/git/_Snoworca/ProjectMaster/docs/next/2026-08-19-binary-data-plane-handoff.md` 를 정독한다. 특히 「C5 착수 실측」 절(§7.1)과 「C5 잔여 — 배선」 절(§7.2), 그리고 「신뢰할 수 없는 green」 절(§5.2, 27항목).
3. `git status --porcelain | wc -l` 로 워킹트리가 아래 §3 과 일치하는지 확인한다. **375 근처가 아니면 그 사이에 누가 커밋했거나 되돌린 것이니 §3 을 믿지 말고 실제를 믿어라.**
4. **배선 3건은 끝났다.** 다음은 「C5-b~d 통합」이고, 그 유일한 미해결 설계 문제는 §6 의 *"토큰 소유자와 어댑터 호출자가 다른 컴포넌트"* 다. 상세 절차는 §8.

---

## 1. 최종 작업 목표

터미널 데이터 평면을 JSON → versioned binary frame 으로 전환하는 작업의 **클라이언트 배선 단계(S4-C5)** 를 끝낸다. control 평면은 JSON 을 유지하고 output/snapshot 평면만 바꾼다.

C5 의 완료 조건(5개 중 **5개 완료**, 통합은 별도 항목):

- [x] C5-a 프론트 코덱 (디코드 전용)
- [x] C5-e IR 어댑터 `fromBinaryOutputFrame`
- [x] **C5-b** 두 소켓에 `binaryType='arraybuffer'` + `handleMessage` 에 text/binary 2단 분기 — 2026-08-26
- [x] **C5-c** 채널 등록부 — 2026-08-26. ⚠️ **인덱스가 아니라 `channelId` 로 키잉했다.** 사유는 §5-10
- [x] **C5-d** `replayToken`/`repairToken` 세션 스코프 저장소 — 2026-08-26. ⚠️ **채우기만 하고 소비부는 손대지 않았다.** 사유는 §5-11

⚠️ **C5 를 다 해도 end-to-end 로는 아무것도 흐르지 않는다.** 서버가 바이너리를 보내려면 S4-a(서버 인코드 표면) + D10 협상 메시지 5종 + `realtime.terminalWireFormat` 설정키가 필요하고 **셋 다 미착수**다. `08-client-wiring-design.md` 가 S4-a 를 명시적으로 범위 밖에 뒀다. 그때까지 C5 의 검증 수단은 **골든 벡터와 단위 테스트뿐**이다. 브라우저에서 눈으로 확인하려 하지 마라 — 확인할 것이 없다.

## 2. 현재까지 완료한 작업

### 이번 세션(2026-08-21~25)에 완료

- [x] **C5-a 프론트 코덱 신설** — `C:/Work/git/_Snoworca/ProjectMaster/frontend/src/utils/binaryFrameCodec.ts` (디코드 전용, 서버 코덱 미import) + `C:/Work/git/_Snoworca/ProjectMaster/frontend/tests/unit/binaryFrameCodec.test.ts`
  - `cd frontend && node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts` (2026-08-25 실행) → **tests 66 / pass 66 / fail 0 / todo 0**
  - 뮤테이션 28종 전부 KILLED, 복원 sha256 바이트 동일. 하네스: `<SCRATCH>/mutate-front.mjs`
- [x] **서버 코덱과 교차 차분** — `<SCRATCH>/differential.mts`, `cd server && npx tsx <SCRATCH>/differential.mts` (2026-08-22 실행) → **compared 9074 inputs / NO DIVERGENCE**
  - 구성: 골든 벡터 11 + fault/control 44 + 모든 벡터의 전 바이트를 9개 값(`00 01 02 08 09 0b 7f 80 ff`)으로 치환 + 각 벡터 0~64바이트 절단
  - 비교 대상: `fatal`·`scoped`(코드·등급·channelId)·`diagnostics`·프레임 헤더 6필드·payload 바이트 전체·프롤로그 값과 **키 집합**·세그먼트·본문
- [x] **C5-e IR 어댑터** — `C:/Work/git/_Snoworca/ProjectMaster/frontend/src/utils/terminalOutputDelivery.ts` 에 `fromBinaryOutputFrame` + `BinaryOutputIdentity` 추가 (파일 자체는 C4 가 만든 것, untracked)
  - `cd frontend && node --experimental-strip-types --test tests/unit/terminalOutputDeliveryBinary.test.ts` (2026-08-25 실행) → **tests 15 / pass 15 / fail 0 / todo 0**
  - 뮤테이션 15종 중 14 KILLED. 생존 1건(`A14`)은 **등가 뮤턴트로 확인** — `getOutputUtf8ByteLength(Uint8Array)` 가 `.byteLength` 와 동일함을 4개 입력 + subarray 뷰로 실행 확인
- [x] **`0x04` 프롤로그 독립 검증 REJECT 전건 수정** — 검증자가 뮤턴트 20종 중 6종 생존 + CRITICAL 1(SSOT 모순) 판정. `server/src/ws/binaryFrameCodec.ts` 에 `07 §2.11` 도메인 검사 8절 + presence 교차검사 구현
  - `cd server && npx tsx --test src/ws/binaryFrameCodec.test.ts` (2026-08-25 실행) → **tests 89 / pass 89 / fail 0 / todo 0**
  - 재뮤테이션 10종 전부 KILLED
- [x] **골든 벡터 2개 수정** — `checkpoint-start-rollback-228`(flags2 `0x0014`→`0x0015`) / `checkpoint-start-promotion-228`(off 128 을 32×0x00 으로). 둘 다 bit0 clear 인데 `retainedStateDigest` 가 비영이라 `07 §2.9:415` 위반이었다. `hexFrame` 은 layout 행에서 재조립(인코더 덤프 아님)
- [x] **문서 정정** — 인용 정정 후 기계 대조 스크립트로 **49/49 통과**(`<SCRATCH>/verify-session-anchors.mjs`), `08` 코덱 앵커 **16/16 통과**(`<SCRATCH>/verify-08-codec.mjs`)
- [x] **`01 §1.8` 개정조항 R1·R2 추가** — §5 참조

### 회귀 (2026-08-25 실행)

| 명령 | 결과 |
| --- | --- |
| `cd frontend && npx tsc -p tsconfig.app.json --noEmit` | exit 0 |
| `cd frontend && npm run typecheck:tests` | exit 0 |
| 프론트 단위 전수(`tests/unit/*.test.ts` 67개 파일별 실행) | **tests 760 / pass 754 / fail 6 / todo 0** |
| `cd server && npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `cd server && npx tsx --test src/ws/wsTransportSidecar.test.ts` | tests 13 / pass 13 / fail 0 |
| `cd server && npx tsx src/test-runner.ts` | 마지막 줄 `21 test(s) failed` = 기준선 |

프론트 실패 6건의 **테스트명 집합이 기준선과 일치**한다(회귀 0). 명단: `terminalCheckpointRuntime.test.ts` 3건 · `terminalContainerRecoveryContract.test.ts` 1건 · `terminalHiddenOutput.test.ts` 1건 · `wsCheckpointProtocol.test.ts` 1건.

### 2026-08-26 에 완료 (배선 3건)

전부 test-first. 각 단계마다 뮤테이션을 걸었고, 하네스는 매번 **뮤턴트를 걸기 전에 baseline 을 파싱해 자가검증**한다(`<SCRATCH>/mutate-{dispatch,registry,tokens}.mjs`).

| 단계 | 산출물 | 테스트 | 뮤테이션 |
| --- | --- | --- | --- |
| **C5-b** | `frontend/src/utils/wsFrameDispatch.ts` (신규) + `WebSocketContext.tsx` 3곳 | `tests/unit/wsFrameDispatch.test.ts` **16/16** | **14/14 KILLED**, 복원 바이트 동일 |
| **C5-c** | `frontend/src/utils/terminalChannelRegistry.ts` (신규) + `ws-protocol.ts` 3필드 + `WebSocketContext.tsx` 5곳 | `tests/unit/terminalChannelRegistry.test.ts` **36/36** | **39/39 KILLED**, 복원 바이트 동일 |
| **C5-d** | `frontend/src/utils/liveOutputTokens.ts` (신규) + `TerminalContainer.tsx` 6곳 | `tests/unit/liveOutputTokens.test.ts` **22/22** | **16/16 KILLED**, 복원 바이트 동일 |
| (부수) | `tsconfig.test.json` 허용목록 +5 · `binaryFrameCodec.test.ts` 타입 수정 | — | 검증이 드러낸 공백 (§9) |

**뮤테이션이 실제 생존자를 잡았다**: C5-d 1회차에서 `M2`(repairToken 병합)·`M3`(부재 키 vs `undefined` 키) 2종이 살아남았다 — `repairToken` 쪽 절반이 통째로 미검증이었다. 대칭 테스트 6개를 추가해 죽였다.

**독립 검증 (2026-08-26)** — C5-b: **CONFIRMED**, 6개 축 전건. 검증자가 자체 뮤턴트 13종을 따로 돌려 전건 KILLED 를 확인했고, `grep -c "JSON.parse" frontend/src/contexts/WebSocketContext.tsx` → **0**(인라인 파스 완전 제거)과 `new WebSocket(` 이 저장소 전체에 **2곳뿐**(세 번째 소켓 없음)임을 확인했다. 지적 1건(LOW)은 반영 완료 — `wsFrameDispatch.test.ts` 의 arm 순서 테스트가 음성 단언(`notEqual`) 뿐이라 arm 삭제·순서 교체 뮤턴트가 **둘 다 `'unsupported'` 를 내며 빠져나갔다.** 양성 단언(`assert.equal(kind, 'binary')`)으로 교체했고, 그 결과 `O1`·`O2` 뮤턴트의 실패 수가 각각 6→**7** 로 올랐다. C5-c·C5-d 검증은 발주됨.

**독립 검증 (2026-08-26)** — C5-c: **PARTIAL**, findings 7건. 반영·미반영을 갈라 적는다.

| # | 심각도 | 내용 | 처리 |
| --- | --- | --- | --- |
| 4 | MEDIUM | **retired 채널을 다른 세션으로 조용히 재바인딩**. `01:392` 규칙 2 위반이고 `01:396-400` 이 그 사고를 명시한다 | ✅ **수정.** `register` 가 retired + 다른 `sessionId` 면 fail-closed 로 무시한다. 같은 세션 재구독은 허용, `clear()` 후는 허용(codecEpoch 가 움직였으므로) |
| 5 | MEDIUM | **새 테스트 파일이 타입체크를 아예 안 받는다.** 실제 타입 에러 4건이 숨어 있었다 | ✅ **수정.** §9 함정에 등재 |
| 2 | HIGH | 테스트 제목이 `capability.channels[]` 커버리지를 주장하나 그 메시지 타입이 프론트에 없다 | ✅ **제목·주석 수정** — 커버하지 않는다고 명시. 근본 원인(D10 미착수)은 미해결 |
| 1 | **CRITICAL** | **스펙이 정의한 wire 로는 등록부가 항상 비게 된다.** `01:384`·`01:735` 는 u16 인덱스만 싣는데 `08:192` 는 UUID 를 요구한다. `08` 자체가 내부 모순(`08:171` vs `08:192` vs `08:70`) | ❌ **미해결.** `01 §1.8` 개정 필요 — §6 참조. 임시로 `SubscribedSessionInfo.authorityEpoch?: string` 를 추가해 뒀으나 **스펙 근거가 없다** |
| 3 | MEDIUM | `08:196` 폐기 트리거 4종 중 2종 미배선 | ❌ **배선 불가.** `terminal-binary:channel-retired` 와 `codecEpoch` 는 **메시지 타입 자체가 프론트에 없다**(D10). `session:exited` 추가는 하지 않았다 — `08:196` 이 열거한 4종에 없다 |
| 6 | LOW | `01:411-427` 의 RETIRED →(30초 유예)→ FREE 전이 미구현 | ❌ 미구현. 규칙 2 를 지키는 서버 아래에서는 관측 불가 |
| 7 | LOW | 등록부가 현재 **write-only** — `lookup`/`channelState` 프로덕션 호출부 0건 | ❌ 통합 단계 몫. **"미지 조회가 `undefined`" 는 유닛 레벨에서만 증명됐고 end-to-end 로는 증명되지 않았다** |

**인용 정정**: 채널↔세션 1:1 의 근거는 `01:338-341` 이 아니다(그 줄은 UUID equality 모델 얘기다). 참값은 **`01:369-371`**(subscribe 시 할당 / unsubscribe 시 해제) + **`01:393`**(재사용 금지). 이 오인용은 `08:184` 에서 옮겨온 것이다.

검증자가 독립 확인해 준 것: `.authorityEpoch =` 재배정 server 프로덕션 **0건**, `TerminalAuthorityProductionAdapter.ts:2204` 의 authority promotion 도 새 UUID 를 발급하지 않음 → **세션 상수 주장 성립**. `registerAll` 은 throw 할 수 없음(추출기와 `assertValid` 가 같은 `registrationError` 를 씀).

**독립 재감사 (2026-08-26)** — C5-c 2차: **PARTIAL**. 검증자가 실행 가능한 프로브로 **가드의 구멍 3개를 재현**했다. 근본 원인 하나:

> 가드가 `state === 'retired'` 를 봤다. **봐야 할 것은 `sessionId` 가 바뀌었는가**다.

- **A (HIGH)** 같은 세션 재구독이 retirement 기억을 지워, 바로 다음 메시지가 자유롭게 rebind 한다
- **B (MEDIUM)** active 채널은 애초에 가드가 없었다. **그리고 `terminal-binary:channel-retired` 가 미배선이라 서버 주도 retirement 는 클라이언트에 보이지 않는다** → 서버가 재할당할 때 채널은 **보통 아직 active** 다. 즉 가드가 정확히 서버가 움직이는 경로에서만 눈이 멀어 있었다
- **C (MEDIUM)** 한 `registerAll` 안의 중복 `channelId` 가 last-wins

✅ **전건 수정.** 가드를 `existing !== undefined && existing.record.sessionId !== record.sessionId` 로 바꿨다. 정당한 재등록은 전부 같은 세션이고, 소유자가 바뀌는 유일한 정당 경로는 `clear()` — 그것이 곧 codecEpoch 경계다.

🔴 **뮤테이션에 대한 교훈 (다음 세션이 반드시 알아야 한다).** 그때 등록부 뮤테이션은 **32/32 KILLED** 였고 그건 이 구멍들과 **모순되지 않는다**. *뮤테이션은 깨진 가드를 잡지, 빠진 케이스를 잡지 못한다.* 더 나쁜 것은 — 뮤턴트 `Y3`("가드가 active 에도 발화")가 **바로 그 수정**이었는데 KILLED 로 기록돼 있었다. **내 테스트가 버그를 붙잡고 있었다.** 그 테스트(`an active channel can still be re-registered to a different session`)는 뒤집었고, 좁은 가드로 되돌리는 회귀 뮤턴트 `Y2` 를 추가했다.

✅ **거부의 무관측성(MEDIUM)도 수정.** `register` 가 `boolean` 을, `registerAll` 이 거부된 행(`{channelId, incumbentSessionId, incomingSessionId}`)을 반환하고 `WebSocketContext` 가 경고한다. 이전에는 "서버가 `01:392` 를 어겼다"는 사건이 흔적 없이 사라졌고, 이후의 드롭은 평범한 retired-channel 트래픽과 구별되지 않았다.

⚠️ **`retired` 는 "fail-closed, 완료" 가 아니다 — 옛 소유자에게 fail-closed 이고 새 소유자에게 fail-SILENT 다.** 거부 후 서버는 그 채널이 세션 B 의 것이라 믿는데 B 는 살아 있고 구독돼 있다. B 의 모든 프레임이 소켓 수명 내내 드롭되며 복구를 요청하는 것이 없다 — `01:425` 가 금지한 "화면에 구멍이 나는데 아무도 모르는" 상태다. 그런데 `undefined` 는 더 나쁘다: `scoped` 에 dedup 도 rate limit 도 없어(`binaryFrameCodec.ts:429`, `01:433`) **프레임마다 무한히** unknown-channel + fresh-snapshot 을 쏜다. 한 채널 상태로는 A 의 잔여 프레임과 B 의 라이브 프레임을 가를 수 없다(같은 id 로 온다). 정답은 `08:197` 이 이미 처방한 것 — 거부 지점에서 **채널이 아니라 세션 단위로** B 를 복구시키는 `06` D5 단일 롤백 함수인데, **미구현**이다. 그때까지는 `retired` 가 덜 나쁜 쪽이다.

**독립 검증 (2026-08-26)** — C5-d: **PARTIAL**, findings 12건. 반영·미반영:

| # | 심각도 | 내용 | 처리 |
| --- | --- | --- | --- |
| F3 | HIGH | **`screen-repair` 갱신원이 통째로 누락.** `08:222` 가 명시하고 `08:214` 가 v1 에서 JSON 에 남는다고 확정한 영구 갱신원이다 | ✅ `handleScreenRepair` 의 ACK 성공 지점에 추가 |
| F9 | HIGH | **"이 토큰은 죽었다"를 표현할 방법이 없다.** 복구 수렴 시 클라이언트가 `key(P1,R1)` 을 superseded 로 기록하는데 저장소는 `P1` 을 계속 들고 있고, 다음 스냅샷의 `R2` 와 병합돼 **서버에 존재한 적 없는 쌍 `{R2,P1}`** 이 된다 | ✅ 수렴 지점에서 `forget(sessionId)` |
| F6 | MEDIUM | 갱신 지점들이 **서로 모순되는 두 정책**(도착 시 vs 수락 시)을 쓴다 | ✅ **전 지점을 "적용/수락 지점"으로 통일.** 🔴 **1차 수정은 틀렸다** — 아래 참조 |
| F5 | MEDIUM | restore-needed 지점의 내 주석이 **틀렸다** — `:1811` 은 거부가 아니라 클라이언트 능력 한계이고, 거기 도달했을 땐 이미 이전 트랜잭션을 superseded 처리한 뒤다 | ✅ 주석 정정 + split 모드 영향 명시 |
| F1 | HIGH | 완료 조건의 **두 번째 연언(`identity` 인자 전달)이 미충족** | ❌ §6 소유권 이음매에 막혀 있다. 검증자도 정당한 블록으로 인정 |
| F2 | MEDIUM | 🔴 **`08:226` 경계 대조군은 읽는 곳이 0 이므로 공허하게 통과했다.** "뮤턴트로 통과 확인"은 문자적으로만 참이고 아무것도 증명하지 않는다 | ✅ **기록 정정.** 그리고 프레이밍이 거꾸로였다 — `08:224` 의 약속("JSON 관측 동작이 비트 단위로 보존된다")이 **실제로 거짓**이다(`TerminalOutputMessage.replayToken` 이 optional 이고 `wsSendPolicy.ts:105` 가 조건부로 싣는다). 즉 우리는 `08:224` 를 따른 게 아니라 **`08` 의 결함을 발견하고 이탈한 것**이다 |
| F4 | HIGH | restore-needed 갱신 지점이 `wsTransportMode !== 'unified'` 에서 **도달 불가** | ⚠️ F3 로 완화(`handleScreenRepair` 는 transport 게이트가 없다). split 모드 자체는 config 게이트 |
| F7 | MEDIUM | 세대 키가 epoch 롤백을 안 덮는다 | ❌ 이미 🔴 로 등재(§10). 검증자가 **오늘 도달 가능한 시퀀스를 만들 수 없다**고 정직하게 보고했다 — `06` D5 가 미결이라 롤백 함수 자체가 없다. 위험한 것은 **누락이 보이지 않는다**는 점: `liveOutputTokens.ts` 와 그 테스트에 "epoch" 이 0회 등장한다 |
| F8·F10·F11·F12 | MEDIUM/LOW | resync epoch 미커버 · `forget`/`clear`/`size` 미사용 · 렌더마다 store 생성 · 옛 세션 누수 | ❌ 기록만. F10 은 F9 수정으로 `forget` 에 프로덕션 호출부가 생겨 부분 해소 |

**독립 재감사 (2026-08-26)** — C5-d 2차: **PARTIAL. 내 F6 수정은 틀렸고 그 근거로 내세운 "하나의 원칙"은 반박됐다.**

내가 주장한 원칙은 *"그 값이 클라이언트의 현재 신원이 되는 지점에 기록한다"* 였고, 스냅샷은 도착이 곧 신원이라며 `handleScreenSnapshot` 과 `session:ready` 의 무복구 분기를 도착 시점에 뒀다. **둘 다 그 뒤에 거부 게이트가 있다.**

- 🔴 **HIGH — `session:ready` 무복구 분기.** `activeResync`·`compatibilityPostAck` 분기가 **둘 다 무조건 반환**하므로 꼬리는 그 기록 뒤에만 도달한다. 그리고 그 꼬리에 **세 번째 거부**가 있다(`terminal_session_ready_snapshot_identity_ignored`) — 즉 **그 게이트가 거부할 때마다 저장소는 이미 덮여 있었다.** 내가 단 주석 "복구가 없으니 이 토큰을 stale 이라 부를 것이 없다" 는 **이 함수의 제어흐름에 대해 거짓**이었다. 내 자체 추적도 출구를 전수하고서 *꼬리 자체에 거부가 있는지*를 묻지 않아 놓쳤다.
- 🔴 **MEDIUM — `handleScreenSnapshot`.** stale·duplicate·checkpoint-authority 세 게이트가 전부 기록 **뒤**에 있어, 명시적으로 stale 인 스냅샷의 토큰이 현재값으로 먼저 쓰였다. 게다가 기록 대상이 인자 `snapshot` 이었는데 **실제 적용되는 것은 큐에서 꺼낸 `nextSnapshot`** 이다.
- **`latestReceivedSnapshotReadyIdentityRef` 선례 논거도 기각.** 그 ref 는 이름·용도가 "latest **received**"(나중 `session:ready` 와 대조할 상관 상태)이고, 내가 하려던 것은 "current **identity**" 다. **두 개념을 뒤섞은 것**이다.

✅ **전건 수정.** `session:ready` 는 스냅샷 신원 게이트 **아래**로, 스냅샷은 `lastAppliedSnapshotRef` 가 세팅되는 **적용 지점**으로(그리고 `nextSnapshot` 을 기록). 이제 여섯 지점이 전부 적용/수락 지점이다.

> **결론: 1차의 "하나의 원칙" 은 판별력이 없었다.** 두 지점에서 코드가 곧이어 "이 값은 현재 신원이 아니다" 라고 판정하고 있었으므로, 그 원칙은 불일치를 **해소한 게 아니라 이름만 바꾼 것**이었다.

- 🔴 **HIGH — 수렴 시 `forget` 이 살아 있는 `replayToken` 을 버렸다.** 권위 증명(`visibleOutputRecovery.ts:367`)이 `replayToken` 등가를 **요구**하므로, resync 를 수렴시킨 스냅샷은 반드시 `runtime.replayToken` 을 싣는다 — 즉 그 토큰은 **화면에 떠 있는 스냅샷의 것**이고 `lastAppliedSnapshotRef` 가 살아 있는 대조 피연산자로 들고 있다. `rememberSupersededVisibleResyncKey` 가 표시하는 것은 *복구 트랜잭션*이 끝났다는 뜻이지 재생 위치가 죽었다는 뜻이 아니다. 게다가 **수렴 후에는 다음 스냅샷이 예정되지 않으므로** 공백이 다음 복구까지 이어진다 — `08:209` 기준 저장소가 존재하는 이유가 바로 그 구간이다. "낡은 값 대 없음" 이 아니라 **"신선한 값 대 없음"** 이었다. ✅ `forget` 직후 `replayToken` 재기록.
- **MEDIUM — split 모드의 `:1842`** 는 여전히 기록하지 않는다(F4). 검증자는 이것을 *"단일 원칙 주장에 대한 가장 명백한 반증"* 으로 들었다 — 그 배치는 원칙이 아니라 **조기 반환이 어디 있느냐**가 정한 것이다.
- **Q1(b) 답**: `:3033`(screen-repair)만 도착보다 실질적으로 늦다(`await runSpeculative` 뒤). 그 await 중의 읽기는 이전 `repairToken` 을 받는다. `08:207` 상 `repairToken` 은 대조용이고 하류로 전달되는 것은 `replayToken` 이라 피해는 낮지만, **원칙이 신선도를 대가로 치르는 유일한 지점**이다.
- **Q3: nothing found.** `:3033` 은 진짜 수락점이다 — 검증자가 `runSpeculative` 의 fence 까지 확인했다(`accepted` 는 `await` **전에** 결정되므로 동시 `invalidateSpeculative()` 가 수락을 철회하지 못하고, `:2986-2993` 의 재검사가 그 경우도 잡는다).
- **UNPROVEN (검증자가 finding 으로 올리지 않음)**: `handleScreenRepairRejected` 의 비-resync 분기가 저장된 `repairToken` 을 지우지 않는다. 서버가 `screen-repair:ready` 수신 **후에** `rejected` 를 보낼 수 있어야 도달하는데, 클라이언트 코드만으로는 판정 불가.

**3차 패스 (2026-08-26)** — 여섯 지점 전부 **적용 지점으로 확인**, 늦게 옮긴 곳 없음. 새 LOW 2건은 검증자가 benign 으로 판정했으나 둘 다 닫았다.

- **두 번째 apply 지점(`handleVisibleResyncSnapshotBeforeApply`)에 기록이 없었다.** 검증자가 "저장소가 이미 같은 값을 갖고 있다"를 세 갈래로 증명했지만 — 권위 증명이 토큰 등가를 핀 + `activeResync` 대입과 기록 사이에 return 없음 + 세대 불변 — **그 셋 중 하나만 바뀌어도 조용히 깨진다.** 한 줄 기록으로 그 증명을 은퇴시켰다.
- **세션 재부착 리셋의 `forget` 이 새 키를 지우고 있었다.** `sessionId` 가 실제로 바뀌면 무효화 대상은 **옛 키** 아래 있으므로 no-op 이었다. 옛 키를 지우도록 고쳤고, 이것이 1차 감사 F12(옛 세션 항목이 컴포넌트 수명 내내 잔존)도 닫는다.
- ⚠️ **Q2 의 반대 논거를 이 리셋에 전이하지 마라.** Q2 는 *세션 중간의 수렴*이 살아 있는 상태를 지운 것이고, 이쪽은 *전체 세션 재부착*이다 — 같은 블록이 `lastAppliedSnapshotRef` 를 null 하고 resync epoch 를 올리고 `invalidateSpeculative()` 를 부르고 superseded 키 집합을 비운다. 저장소를 비우는 것이 그 맥락에 맞다.
- 검증자가 `snapshot` / `nextSnapshot` 분기의 **실제 인터리빙**을 구성해 줬다: 동시 호출이 `snapshotApplyInProgressRef` 조기 반환에 걸리기 **전에** `pendingSnapshotRef` 를 갱신하므로, 2회차가 snapshot2 를 적용하는 동안 바깥 호출의 인자는 여전히 snapshot1 이다. 이론이 아니라 도달 가능하다.

1차 검증자가 axis 5 에서 **뮤턴트 12종을 독립적으로 돌려 전건 KILLED** 를 확인했고, `assert.deepEqual({x:undefined},{})` 가 실제로 throw 한다는 것도 직접 실행해 확인했다. 다만 그 캐비엇이 중요하다 — **`TerminalContainer` 의 갱신 지점을 건드리는 테스트는 어디에도 없어서 F3·F4·F5·F6 이 스위트에 전혀 보이지 않았다.** 저장소 스위트가 green 인 것은 배선에 대한 증거가 아니다.

**전수 회귀 (2026-08-26, 모든 수정 후)**: `tests/unit/*.test.ts` **70개 파일 / pass 827 / fail 6 / todo 0**. 기준선 754 + 신규 63 = 817 이고 **실패 6건의 테스트명 집합이 기준선과 동일**하다 → 회귀 0. `npx tsc -p tsconfig.app.json --noEmit` 과 `npm run typecheck:tests` 둘 다 exit 0.

**`08:226` 경계 대조군 통과 (뮤턴트로 확인, 추론 아님)**: `liveOutputTokens.ts` 의 `update` 를 no-op 으로 만들고 전수를 다시 돌렸더니 **`liveOutputTokens.test.ts` 만 0→14 실패**하고 나머지 69개 파일의 실패 수는 전부 동일했다. JSON 경로가 새 상태에 의존하지 않는다는 증거다. 뮤턴트가 죽었으므로 대조군 자체도 공허하지 않다.

### 2.1 기억과 실제가 달랐던 항목

이번 세션에 **기록이 틀렸음을 실측으로 확인한 것들**이다. 다음 세션은 "그럼 나머지 기록은 믿어도 되나"를 알아야 하므로 남긴다.

| 기록된 진술 | 실제 (확인 명령) |
| --- | --- |
| `08` §5.3 의 코덱 export 줄번호 21개(6행에 분산) | **전부 stale.** 하루에 두 번 무효화됐다(`0x04` 구현 +203, 도메인 검사 +5/+42). → 그 표에서 **줄번호를 제거**했다. `grep -n "^export" server/src/ws/binaryFrameCodec.ts` |
| `08` 의 `WebSocketContext.tsx` 앵커 5개(`:687`·`:1007`·`:1009`·`:1201`·`:1206`) | **전부 오류, 일관되게 +6.** 참값은 §5 표. `sed -n '687p;1007p;1009p;1201p;1206p' frontend/src/contexts/WebSocketContext.tsx` |
| `08` 이 C2·C3·C4 를 미래 작업으로 서술 | **셋 다 이미 구현돼 있다.** `enqueueBytes`(`terminalOutputScheduler.ts:280`/`:295`/`:1403`/`:1503`) · restore 게이트(`:488`) · IR(`terminalOutputDelivery.ts`) |
| `03:98` "split 활성 시 output 프레임은 output 소켓으로 온다" | **틀렸다.** `type:'output'` 은 split 모드에서도 **control 소켓**으로 온다. 구독 등록이 control 로만 가서(`WebSocketContext.tsx:1235`·`:1530`) output 소켓은 `sessionSubscribers` 에 안 들어간다(`WsRouter.ts:4969`·`:4975`·`:2578`) |
| `06` §1.4 "`JSON.parse(message.payload)` 로 라우팅 결정하는 지점 5곳" | **0곳.** `grep -c 'JSON\.parse' server/src/ws/wsSendPolicy.ts` → 0, `grep -n 'JSON\.parse' server/src/ws/WsRouter.ts` → `:1746`·`:2554` 2곳뿐이고 둘 다 인바운드 |
| `01:544` "`segmentCount === 0` 이면 `chunkIdBase` 를 chunkId 로 해석하지 않는다" | **틀렸고 위험하다.** 그 조건이 정상 경로 전부다 → 개정 R2 로 교체 (§5) |
| SSOT 문서가 기록한 인용 위치 `07`:507/848/991 · `06`:2237/2587 · `01:748` | **전부 stale 또는 오인용.** `01:748` 은 거부코드 리터럴이고 참값은 `01:823` |
| 뮤테이션 하네스 1회차 "9개 뮤턴트 전부 SURVIVED" | **하네스 고장.** Windows 에서 `execFileSync('npx', [...])` 가 셸 없이 못 떠 카운트가 `undefined` → `Number(undefined) > 0` 이 false. 고친 뒤 같은 9개가 전부 KILLED |

**2026-08-26 독립 사실검증이 이 문서 자체에서 추가로 잡아낸 오류 (전부 아래에 반영 완료):**

| 이 문서가 썼던 것 | 실제 (확인 명령) |
| --- | --- |
| `npx tsx src/test-runner.ts` 가 **exit 0** 을 낸다 | **exit 1 이다.** `src/test-runner.ts:672` 가 `process.exitCode = 1`. exit code 를 못 믿는 예로는 `WsRouterSplitHandshake.test.ts`(fail 0 / todo 14 / exit 0) 만 유효하다 |
| `grep -rn authorityEpochIndex frontend/src` 기준선 **0건** | **6건**(전부 이 세션이 만든 `frontend/src/utils/binaryFrameCodec.ts`). 0 은 그 파일이 생기기 전 수치였다 |
| `assertContiguousSegments` = `visibleOutputRecovery.ts:418-441` | **`:418-446`.** `:441` 은 내부 가드의 `return false` 로 함수 중간이다 |
| `08:598` 의 "S3 에서 신설된 파일 확장" | 그 문장은 **`08:601`** 에 있다. `:598` 은 `| 골든 벡터 | §5.4 전건 |` |
| `08` §5.3 의 stale 앵커 **11개** | **21개** (`git show HEAD:…08-…md \| sed -n '436,447p'` 기준). 표는 6행이다 |
| 폐기 게이트를 언급하는 이슈 **4건**(`#19`~`#22`) | **5건.** `#2`(Epic)가 본문 2곳에서 `#19` 를 참조한다 |
| C5 완료 조건 "6개 중 3개" | 체크리스트는 **5항목**이고 당시 완료는 2개였다 |

## 3. 현재 워킹트리·저장소 상태

- 브랜치 `work/mcp-session-orchestration-20260709` — `origin/main` 대비 **ahead 137 / behind 0** (`git rev-list --count --left-right origin/main...HEAD` → `0	137`)
- **`git status --porcelain` 총 376 엔트리** (2026-08-26 최종 측정). 이 저장소는 **공유 워킹트리**이고 대부분이 이 작업과 무관한 남의 미커밋 작업이다. 스테이징된 변경은 **0건**.
- 이 작업이 만지거나 만든 파일 **23개** (본 문서 · `LATEST.md` · 작업 로그 JSONL 포함) + 아래 표 하단의 남의 파일 5개:

| 상태 | 경로 (`C:/Work/git/_Snoworca/ProjectMaster/` 기준) |
| --- | --- |
| `??` | `frontend/src/utils/binaryFrameCodec.ts` (이번 세션 신규) |
| `??` | `frontend/tests/unit/binaryFrameCodec.test.ts` (이번 세션 신규) |
| `??` | `frontend/tests/unit/terminalOutputDeliveryBinary.test.ts` (이번 세션 신규) |
| `??` | `frontend/src/utils/terminalOutputDelivery.ts` (C4 가 생성, `fromBinaryOutputFrame` 추가) |
| `??` | **C5-b/c/d 신규 6개** — `frontend/src/utils/{wsFrameDispatch,terminalChannelRegistry,liveOutputTokens}.ts` · `frontend/tests/unit/{wsFrameDispatch,terminalChannelRegistry,liveOutputTokens}.test.ts` |
| ` M` | **C5-b/c/d 가 만진 추적 파일 3개** — `frontend/src/contexts/WebSocketContext.tsx` · `frontend/src/components/Terminal/TerminalContainer.tsx` · `frontend/src/types/ws-protocol.ts`. ⚠️ 셋 다 남의 대규모 미커밋 델타를 이미 안고 있다 (§10) |
| ` M` | `server/src/ws/binaryFrameCodec.ts` · `server/src/ws/binaryFrameCodec.test.ts` · `server/src/ws/__fixtures__/binary-frame-vectors.json` |
| ` M` | `docs/research/binary-comms/01-frame-format-and-negotiation.md` · `06-work-plan.md` · `07-prologue-spec-remaining-opcodes.md` · `08-client-wiring-design.md` |
| ` M` | `docs/next/2026-08-19-binary-data-plane-handoff.md` |
| `??` | `docs/next/2026-08-25-binary-data-plane-c5-wiring.md` (본 문서) · `docs/next/LATEST.md` |
| ` M` (남의 것) | `server/src/ws/WsRouterSendPriority.test.ts` · `WsRouterSplitHandshake.test.ts` |
| `??` (남의 것) | `server/src/ws/WsRouterCheckpointProtocol.test.ts` · `WsRouterRestoreMetadata.test.ts` · `wsSendPolicyRestoreMetadata.test.ts` |

- **커밋 여부**: 🔴 **커밋하지 마라.** 사용자 결정 대기 항목이다. C5-b~d 가 만질 추적 파일들은 남의 미커밋 작업을 **1,094~2,868줄씩** 담고 있어 `git commit -- <경로>` 로도 분리되지 않는다. 수치는 §10.

## 4. 관련 문서·코드 (절대경로)

`<REPO>` = `C:/Work/git/_Snoworca/ProjectMaster`

| 문서 | 절대경로 | 역할 |
| --- | --- | --- |
| **SSOT (작업)** | `<REPO>/docs/next/2026-08-19-binary-data-plane-handoff.md` | 프로젝트 전체 맥락·결정·함정 27종. 이번 세션까지 갱신됨 |
| **SSOT (프레임 사양)** | `<REPO>/docs/research/binary-comms/01-frame-format-and-negotiation.md` | §1.8 이 프롤로그의 유일한 정본. 개정 R1·R2 포함 |
| 부속서 (동결) | `<REPO>/docs/research/binary-comms/07-prologue-spec-remaining-opcodes.md` | `0x03`/`0x04`/`0x06`/`0x07` 레이아웃. **in-place 개정 금지** — `01 §1.8` 에 개정조항을 적는다 |
| 실행 설계 | `<REPO>/docs/research/binary-comms/08-client-wiring-design.md` | C5 설계. ⚠️ **줄번호 앵커와 상태 서술이 낡았다** (§2.1) |
| 계획 SSOT | `<REPO>/docs/research/binary-comms/06-work-plan.md` | D1~D15 결정 |
| 클라이언트 사실 지도 | `<REPO>/docs/research/binary-comms/03-client-decode-path.md` | ⚠️ `:98` 의 두-소켓 서사가 틀렸다 (§2.1) |
| 회귀 기준선 | `<REPO>/docs/research/binary-comms/baseline/frontend-baseline.md` | ⚠️ HEAD `eb2f4f8` 기준. 현재 HEAD 는 1커밋 앞 |

**수정 대상 코드**

- `<REPO>/frontend/src/contexts/WebSocketContext.tsx` — C5-b(두 소켓 + `handleMessage`), C5-c(등록부 ref)
- `<REPO>/frontend/src/components/Terminal/TerminalContainer.tsx` — C5-d(토큰 ref). 핸들러 범위는 **`:3191-3419`**

**신규 생성**

- ~~`<REPO>/frontend/tests/unit/wsFrameDispatch.test.ts`~~ — **2026-08-26 생성 완료.** `08:601` 의 "S3 에서 신설된 파일 확장" 은 사실이 아니었다(그 파일은 존재한 적이 없었다)

**참고 선례**

- `<REPO>/frontend/src/utils/binaryFrameCodec.ts` — 이번 세션 산출물. `decodeWsMessage` / `parseFrameMessage` / `createV1DecodeContext` / `deriveMaxBodyBytes` 를 export
- `<REPO>/frontend/src/utils/terminalOutputDelivery.ts` — `fromBinaryOutputFrame(message, identity)` 가 C5-c/d 의 산출물을 `identity` 인자로 받는다. **이 시그니처가 세 배선의 접합점이다**
- `<REPO>/frontend/src/utils/visibleOutputRecovery.ts` `:418-446` — `assertContiguousSegments`. 이미 export 돼 있고 어댑터가 쓴다. **새로 만들지 마라**

## 5. 확정된 결정 (변경 금지)

1. **`0x04` 프롤로그는 200 B** — **확정**. (근거: `01 §1.8` 개정조항 **R1**, `01:578`·`01:582`. 원안 160 B 에 `responderLeaseId` 고정폭 슬롯 40 B 추가: off 160 length uint8(0..38) + off 161 raw 39 B, `flags2` bit4 = `RESPONDER_LEASE_ID_PRESENT`, 예약 마스크 `0xFFF0`→`0xFFE0`)
2. **`chunkIdBase` 부재는 `0` 으로만 표현하고 `segmentCount` 와 무관** — **확정**. (근거: `01 §1.8` 개정조항 **R2**, `01:544`. 발급기가 `(prev ?? 0n) + 1n` 로 세어 0 을 절대 내지 않는다 — `server/src/ws/WsRouter.ts:3642-3646`)
3. **`screenSeq` Ordinal64 → number 좁히기는 어댑터에서 하고, safe-integer 밖은 반올림하지 않고 `RangeError`** — **확정**. (근거: 값의 원천이 이미 JS `number` — `server/src/services/SessionManager.ts:810`. 구현: `terminalOutputDelivery.ts` 의 `narrowOrdinal`)
4. **`segmentCount === 0` ⟹ `hasSourceSegments: false`, `chunks: [whole]`** — **확정**. (근거: JSON 생산자도 빈 배열을 안 보낸다 — `server/src/ws/wsSendPolicy.ts:122`·`:278`)
5. **프론트 코덱은 서버 코덱을 import 하지 않는다** — **확정**. (근거: `08` §5.2. 서버 타입 그래프가 브라우저 번들로 끌려오고, 골든 벡터 차분이 순환논증이 된다)
6. **클라이언트 `maxBodyBytes` 는 `visibleOutputQueueMaxBytes`(기본 4 MiB)에서 파생** — **확정**. (근거: `08` §5.5, `PERF-BGSTAB-010` AC-4 가 새 정책 상수를 금지. 구현: `binaryFrameCodec.ts` 의 `deriveMaxBodyBytes`, 값을 **인자로 받는다** — 코덱이 config 계층에 의존하지 않게)
7. **`ack` 는 바이너리 경로에서 항상 `undefined`** — **확정**. (근거: `deliverySeq` 가 프레임 헤더에 없다. `TerminalContainer.tsx:3350` 이 이미 `delivery.ack !== undefined` 로 분기)
8. **`07` 본문은 in-place 개정하지 않는다** — **확정**. (근거: `01:570`. `07` 에 남은 `160` 표기 9곳은 R1 이 stale 로 고지했고 `01:571` 이 충돌 시 `01` 을 이기게 한다)
9. **삽입 지점 참값** — **확정**. (2026-08-22 실측 + 2026-08-25 재확인, 16/16 대조 통과)

| 대상 | `08`/`03` 의 주장 | **참값** |
| --- | --- | --- |
| control 소켓 `binaryType` | `:1201` 직후 | **`:1207`(`const ws = new WebSocket(url)`) 직후.** `:1208-1211` 의 **조기 `return`** 보다 앞이어야 한다 |
| split output 소켓 `binaryType` | `:1007` 직후 | **`:1013`(`const output = new WebSocket(outputUrl)`) 직후** |
| text/binary 분기 | `:687` 앞 | **`:691`**(`let rawMessage: unknown;` 앞). `JSON.parse(event.data)` 는 **`:693`** |
| `onOutput` 시그니처 | `:118` 을 교체 | **불필요 — `:124` 에서 이미 IR** |
| `onOutput` 호출부 | `:592`·`:1140` | **`:598`(grace 재생)·`:1146`(라이브)** |

> ⚠️ 위 표의 `WebSocketContext.tsx` 줄번호는 **2026-08-26 배선으로 전부 밀렸다.** C5-b 가 import 1줄 + 분기 ~10줄 + `binaryType` 2줄을, C5-c 가 ref 5줄 + 호출 3곳을 넣었다. 지금 값을 원하면 `grep -n "binaryType\|classifyWsFrame\|onmessage" frontend/src/contexts/WebSocketContext.tsx` 로 직접 재측정하라. **표는 당시 참값의 기록이지 현재 좌표가 아니다.**

**10. 채널 등록부는 `authorityEpochIndex` 가 아니라 `channelId` 로 키잉한다** — **확정**. (근거: `08:192` 가 자료구조를 `Map<channelId, {sessionId, authorityEpoch, streamEpoch}>` 로 지정하며 인덱스 열이 없다. 그리고 채널↔세션이 1:1(`01:338-341`)이고 `authorityEpoch` 가 세션당 1회만 배정되므로(`08:170`, 서버 전수 grep 재배정 0건) 한 채널 안에서 인덱스가 가질 수 있는 값은 하나뿐이다 — 인덱스는 조회 키가 아니라 같은 사실의 재진술이다. 구현: `frontend/src/utils/terminalChannelRegistry.ts`)

> ⚠️ **여기에 사양 공백이 하나 있다.** `01:374-385` 도 `01:725-737` 도 **UUID 를 싣지 않는다** — 둘 다 u16 인덱스만 싣는다. 그런데 `08:192` 의 표는 UUID 를 요구한다. 그래서 `SubscribedSessionInfo` 에 `authorityEpoch?: string` 을 **`01` 이 규정한 것 이상으로 추가**했다. 서버(S4-a)가 그 필드를 실제로 보내게 하려면 `01 §1.8` 에 R1·R2 같은 개정조항이 필요하다. **[미해결]**

**11. C5-d 는 저장소를 채우기만 하고 소비부는 바꾸지 않았다** — **확정**. (근거: 바이너리 경로가 아직 도달 불가(S4-a·D10 미착수)라 오늘 `replayToken` 폴백을 넣으면 **이득 0 에 JSON 동작만 바뀐다**. 소비부 전환은 「C5-b~d 통합」 몫이며, 실제 블로커는 §6 의 소유권 이음매다.)

> ⚠️ **이 결정의 근거를 `08:224` 로 대지 마라 — 그 반대다.** `08:224` 는 "JSON 경로에서는 `output.replayToken` 을 우선 쓰고 **없을 때만 ref 를 본다**" 고 **읽기를 지시한다.** 그리고 그 약속("JSON 관측 동작이 비트 단위로 보존된다")은 **거짓이다**: `TerminalOutputMessage.replayToken` 은 optional 이고 `wsSendPolicy.ts:105` 가 조건부로 싣기 때문에, 폴백을 넣으면 토큰 없는 output 메시지에서 **실제로 발화하고 `submitOutput` 이 찍는 값을 바꾼다.** 즉 우리는 `08:224` 를 따른 것이 아니라 **`08` 의 결함을 찾아 이탈한 것**이다.
>
> 🔴 그리고 **`08:226` 경계 대조군은 공허하게 통과했다.** 저장소를 읽는 곳이 0 이므로 비우는 것이 애초에 no-op 이다. 이전 판이 "뮤턴트로 통과 확인"이라 쓴 것은 문자적으로만 참이고 아무것도 증명하지 않는다. **그 대조군은 소비부가 배선된 뒤에 다시 돌려야 의미가 생긴다.**

## 6. 미결정·유예 항목

- **커밋 단위** — 사용자 결정 대기. 신규 4파일만 따로 커밋하면 의존하는 프로덕션 변경 없이 테스트만 들어간다. 결정 방법: 사용자 확인
- **P2 재발행** — 보류. P2(`tools/wave3/canary-admission-evidence.test.mjs`)는 18개 파일을 동결하는데 **프론트 7개 중 6개가 이미 해시 불일치**다. 재발행하면 남의 미커밋 서버 작업까지 frozen 증거로 certify 하게 된다. 결정 방법: 사용자 확인
- **GitHub 이슈 갱신** — 승인은 받았으나 **대상 집합과 문안이 정의된 적이 없다.** 폐기된 측정 게이트를 본문에서 언급하는 이슈는 **5건**(`#2`·`#19`·`#20`·`#21`·`#22`) — `#2`(Epic)가 본문 2곳(`- [ ] #19 — adopted …` / `└──> #19 (adopt or explicit skip)`)에서 참조한다. 공개 저장소 쓰기이므로 문안 확정 후 진행. 결정 방법: 사용자 확인
- 🔴 **통합의 소유권 이음매 — 이것이 다음 세션의 본 과제다.** `08:199` 는 어댑터(`fromBinaryOutputFrame`)를 **`WebSocketContext` 의 수신 분기**에서 호출하라고 하고, `08:221` 은 토큰을 **`TerminalContainer`** 가 소유하라고 한다. 즉 `identity.replayToken`/`repairToken` 을 채우려면 **컴포넌트 경계를 건너야 한다.** `08` 은 이 이음매를 어떻게 잇는지 말하지 않는다. 기존 선례는 `sessionHandlersRef`(컨테이너가 컨텍스트에 핸들러를 등록하는 방식)이므로 같은 형태의 토큰 공급자 등록이 유력하지만 **확정된 바 없다.** 결정 방법: 설계 후 사용자 확인
- **`authorityEpoch` UUID 의 와이어 공급원** — §5-10 의 사양 공백. `01 §1.8` 개정조항이 필요하다. 결정 방법: `01` 개정 (R1·R2 선례)
- **`07:69` 의 `01:534` 인용** — `01` 에서 대응 서술을 찾지 못했다. 추측으로 숫자를 넣으면 *갓 검증한 것처럼 보이는 오답*이 되므로 그대로 뒀다. 결정 방법: `01` 전문 재조사
- **`06`·`02`·`05` 의 stale 앵커** — S5-a0 몫으로 등재. 참값: `JSON.stringify` = `server/src/ws/wsSendPolicy.ts:96`, `Buffer.byteLength(payload,'utf8')` = **`:100`**. 대상: `02`(`:230`·`:258`·`:537`), `05`(`:44`·`:61`·`:62`·`:111`·`:189`·`:774`)

## 7. 남은 작업 전체 목록

- [x] **C5-b 수신 분기** — 2026-08-26. `binaryType` 은 `:1025`<`:1027`(output) · `:1222`<`:1254`(control) 로 둘 다 `onmessage` 부착보다 앞선다
- [x] **C5-c 채널 등록부** — 2026-08-26. 단 키는 `channelId` 다 (§5-10). `capability.channels[]` 쪽 공급원은 **D10 미착수라 배선할 대상이 없다** — `subscribed` 쪽만 연결돼 있다
- [x] **C5-d 토큰 저장소** — 2026-08-26. 채우기만 했고 `identity` 인자 전달은 통합 몫이다 (§5-11)
- [ ] **C5-b~d 통합** — 완료 조건: 바이너리 프레임이 도착하면 `decodeWsMessage` → `parseFrameMessage` → `fromBinaryOutputFrame` → 기존 `onOutput` 경로로 흐른다. **유일한 미해결 설계 문제는 §6 의 소유권 이음매다**
- [ ] **C6 마이크로벤치 + 동등성** — 완료 조건: JSON arm 과 binary arm 을 같은 입력으로 돌려 출력이 동등함을 보인다 (의존성: C5 전부 + S4-a)
- [ ] **S4-a 서버 인코드 표면** — `08` 범위 밖. end-to-end 의 전제
- [ ] **D10 협상 메시지 5종** — `terminal-binary:negotiate`/`:capability`/`:rejected`/`:channel-retired`/`:unknown-channel`
  - 🔴 **전제조건 (이걸 빼면 터미널이 통째로 죽는다).** D10 을 배선하는 사람은 **`codec-epoch-bump` 과 `group-rebound`(`01:756`) 양쪽에서 `channelRegistryRef.current.clear()` 를 반드시 호출해야 한다.** `01:393` 의 재사용 금지는 **codecEpoch 하나에 한정**되므로, bump 후 서버는 정당하게 id 를 1부터 다시 배정하며 **다른 세션**에 준다. 지금 `clear()` 는 connect 시작에만 걸려 있고 codecEpoch 처리는 아예 없다. 그 상태로 bump 가 오면 등록부가 **모든 행을 거부**해 전 채널 블랙아웃이 된다(3차 감사 프로브 Q1.3 실측: `[{1,a},{2,b},{3,c}]` 후 `[{1,x},{2,y},{3,z}]` → 3건 전부 거부).
  - 이 실패 양상은 **가드 수정이 만든 것이 아니라 바꾼 것**이다. 좁은 가드였다면 같은 상황에서 그 행들을 **수락**해(incumbent 가 retired 가 아니라 active 이므로) **조용한 교차 세션 오염**이 됐다. 블랙아웃이 더 낫다 — 시끄럽고, 거부 목록이 두 세션 이름을 다 부른다. 하지만 **진단명이 다르다**는 것을 알고 있어야 한다.
- [ ] **`realtime.terminalWireFormat` 설정키** — 4값 사다리 `json | binary-shadow | binary-optin | binary`

## 8. 다음 세션 지시서

**전부 TDD. 실패 테스트를 먼저 쓰고 red 를 눈으로 확인한 뒤 구현한다.** 구현이 끝나면 반드시 뮤턴트를 걸어라 — 이번 세션에 뮤테이션으로 **실제 생존자를 4번** 잡았다(서버 6종, 프론트 코덱 1종, 어댑터 3종 중 2종).

### 배선 3건은 완료됐다 — 남은 것은 통합

세 조각은 이미 있고 서로 맞물릴 준비가 돼 있다:

| 조각 | 어디에 | 통합이 부를 것 |
| --- | --- | --- |
| 수신 분기 | `frontend/src/utils/wsFrameDispatch.ts` | `classifyWsFrame(event.data)` → `kind === 'binary'` 갈래 |
| 채널 등록부 | `frontend/src/utils/terminalChannelRegistry.ts` | `registry.channelState` 를 `createV1DecodeContext` 에 그대로 넘긴다(바인딩 불필요 — 테스트가 핀함). `registry.lookup(channelId)` 가 `{sessionId, authorityEpoch, streamEpoch}` |
| 토큰 저장소 | `frontend/src/utils/liveOutputTokens.ts` | `store.get(sessionId, generation)` 가 `{replayToken?, repairToken?}` |
| 접합점 | `frontend/src/utils/terminalOutputDelivery.ts` | `fromBinaryOutputFrame(message, identity)` — `identity` 가 위 둘의 산출물을 받는다 |

### 통합 절차

1. **먼저 §6 의 소유권 이음매를 설계한다.** 토큰은 `TerminalContainer` 가 갖고 어댑터는 `WebSocketContext` 가 부른다. 이걸 정하지 않고 코드를 쓰면 다시 뜯게 된다. 선례는 `sessionHandlersRef`.
2. 실패 테스트 먼저 — 바이너리 프레임 바이트를 넣으면 `onOutput` 이 IR 로 호출된다. 골든 벡터(`server/src/ws/__fixtures__/binary-frame-vectors.json`)의 `output` 계열을 입력으로 쓴다.
3. `WebSocketContext.tsx` 의 `frame.kind === 'binary'` 갈래(현재 `console.warn` + `return`)를 실제 디코드로 교체한다. `decodeWsMessage` 는 **`fatal` 이어도 이미 파싱한 `frames` 를 버리지 않는다** — 프레임을 먼저 배달하고 `fatal` 을 나중에 처리하라(`binaryFrameCodec.ts:398-405`).
4. `maxBodyBytes` 는 `deriveMaxBodyBytes(getCachedTerminalOutputResourceLimits())` 로 얻는다 (§5-6).
5. 뮤턴트: 디코드 결과 무시 / `fatal` 시 조기 반환 / `identity` 를 빈 객체로 → 전부 KILLED 여야 한다.

### 재측정이 필요한 검증 명령

- ⚠️ `grep -rn authorityEpochIndex frontend/src` **기준선은 0 이 아니라 7 이다** (`binaryFrameCodec.ts` 6 + `terminalChannelRegistry.ts` 1). 등록부는 인덱스로 키잉하지 않으므로 **이 grep 은 C5-c 의 검증 수단이 아니다.** 등록부를 확인하려면 `grep -n channelRegistryRef frontend/src/contexts/WebSocketContext.tsx` (현재 4건).
- `binaryType` 순서 확인: `grep -n "binaryType\|\.onmessage" frontend/src/contexts/WebSocketContext.tsx` — `binaryType` 2줄이 각각 대응하는 `onmessage` 줄보다 **작아야** 한다.

### 매 단계 후 회귀

```
cd C:/Work/git/_Snoworca/ProjectMaster/frontend && npx tsc -p tsconfig.app.json --noEmit && npm run typecheck:tests
```

프론트 전수는 파일별로 돌려 **fail 6 과 그 테스트명 집합**을 대조한다(§2 명단). `npx playwright test` 는 이 단계에서 돌리지 마라 — `frontend/tests/unit/` 를 **0건 수집**하고 프로덕션 서버를 띄운다.

## 9. 거버넌스·게이트·함정

- **`kill <pid>` / `taskkill /F /IM node.exe` 절대 금지** (CLAUDE.md). dev 서버 포트는 항상 **2222**.
- **커밋 메시지에 어떤 시그니처도 넣지 않는다** — `Co-Authored-By`, `Generated with`, `[bot]` 전부. 제목에 `Phase n`/`Step n`/`TASK-XXX` 도 금지.
- **셸에 `BUILDERGATE_*` 15개 + `NODE_ENV=production` 이 설정돼 있고 다른 런타임 루트를 가리킨다.** 테스트 명령은 전부 `env -u NODE_ENV` 를 붙여 실행했다.
- **함정: node 의 `ℹ` 는 멀티바이트다.** `grep "^. pass"` 로 파싱하면 조용히 0건이 된다. `grep -oE "pass [0-9]+"` 를 써라.
- **함정: exit code 를 단독 신호로 쓰지 마라.** 단 **`cd server && npx tsx src/test-runner.ts` 는 반례가 아니다** — 마지막 줄에 `21 test(s) failed` 를 찍고 **exit 1** 을 낸다(`src/test-runner.ts:672` 의 `process.exitCode = 1`). 유효한 반례는 `WsRouterSplitHandshake.test.ts` 하나로, `fail 0 / todo 14` 에 exit 0 인데 그 14개가 `✖` 에 찍힌다. **`todo` 카운트와 `✖` 목록을 항상 대조하라.**
- 🔴 **함정: 뮤테이션 100% KILLED 는 "빠진 케이스 없음"을 뜻하지 않는다.** 뮤테이션은 **깨진** 가드를 잡고, **좁은** 가드는 잡지 못한다 — 좁은 가드도 자기 범위 안에서는 정상 동작하므로 뮤턴트가 죽는다. 2026-08-26 에 등록부 가드가 32/32 KILLED 이면서 동시에 구멍 3개를 갖고 있었다. 더 나쁜 신호가 있었는데 놓쳤다: **수정에 해당하는 뮤턴트(`Y3` "가드가 active 에도 발화")가 KILLED 로 찍혀 있었다** — 그건 테스트가 버그를 붙잡고 있다는 뜻이다. **뮤턴트 목록을 볼 때 "이 뮤턴트가 사실은 개선 아닌가?" 를 물어라.** 그리고 수정한 뒤에는 **옛 동작으로 되돌리는 회귀 뮤턴트**를 반드시 추가하라(`Y2`).
- 🔴 **함정: source-text 계약 테스트의 고정 창.** `terminalContainerRecoveryContract.test.ts:150` 이 `source.slice(readyStart, readyStart + 1300)` 로 자른 뒤 그 안에서 순서를 단언한다. 2026-08-26 에 `setCurrentViewReady` 안에 5줄(주석 4 + 호출 1)을 넣었더니 `activeVisibleOutputResyncRef.current = null` 이 **창 밖으로 밀려 red** 가 됐다 — 제품 동작과 무관하다. **그 콜백 안에 무언가를 넣을 때는 줄 수를 아끼거나 창 뒤쪽에 넣어라.**
- 🔴 **함정: `npm run typecheck:tests` 는 새 테스트 파일을 보지 않는다.** `frontend/tsconfig.test.json` 의 `files` 는 **한 파일씩 손으로 늘리는 허용목록**이다. 여기 없는 테스트는 `tsc` 를 아예 통과하지 않으므로 `--experimental-strip-types`(타입체크 안 함)와 합쳐져 **타입 에러가 영구히 숨는다.** 2026-08-26 에 5개 파일(신규 3 + 이전 세션의 바이너리 2)이 목록에 없었고, 넣자마자 **실제 에러 4건**이 나왔다 — `terminalChannelRegistry.test.ts` TS2353×2, `binaryFrameCodec.test.ts` TS2339×2(`FaultFixture` 에 `byteLength` 선언 누락, 실제로는 44개 중 2개가 갖고 있다). **테스트 파일을 새로 만들면 그 자리에서 `files` 에 추가하라.** 안 하면 "typecheck 통과" 보고가 그 파일에 대해 공허해진다.
- **함정: 뮤테이션 하네스가 침묵 실패한다.** Windows 에서 `execFileSync('npx', [...])` 는 `shell: true` 없이 안 뜬다. 파싱 실패를 "생존"과 **다른 라벨**로 분기하고, 뮤턴트를 걸기 전에 baseline 을 먼저 파싱해 하네스를 자가검증하라.
- **함정: 널리 인용되는 문서 본문은 줄 수를 바꾸지 말고 고쳐라.** `01` §3.6 을 자연스럽게 고쳤더니 1622→1632 줄이 되며 하류 앵커 23개가 +10 밀렸다. 되돌리고 같은 줄 수로 다시 넣어 해결했다. 검증: `wc -l` 이 **1622** 유지 + `git diff -U0` 의 전 hunk 가 `-N +N` 1:1.
- **함정: 정정 작업 자체가 새 오인용을 만든다.** 이번 세션이 도입한 인용 49개를 기계 대조했더니 1건이 틀렸다(내가 방금 쓴 `wsSendPolicy.ts:91`, 참값 `:96`). **고친 인용은 스크립트로 되짚어라** — `[소스, 줄, 기대 토큰, 주장]` 배열 하나면 된다.
- **함정: 레이아웃 일치는 벡터 유효성이 아니다.** 골든 벡터 2개가 오프셋·폭·엔디안 전건 대조와 독립 검증을 통과하고도 `flags2` presence 규칙을 위반하고 있었다. 표는 *어디*를, 플래그는 *언제*를 규정한다 — 따로 검사하라.
- **함정: 서브에이전트가 유휴로 들어가고도 보고 텍스트를 반환하지 않는 일이 이번 세션에 5회 발생했다.** `run_in_background: false` 로 띄우고, 그래도 안 오면 `SendMessage` 로 "reply 의 TEXT 로 보내라"고 명시해 재요청하라. 그마저 안 되면 **기계적으로 확인 가능한 축은 직접 돌려라** — 교차 차분 9,074건이 읽기 기반 리뷰보다 강했다.

### 복붙 가능한 검증 명령

```
cd C:/Work/git/_Snoworca/ProjectMaster/server && npx tsx --test src/ws/binaryFrameCodec.test.ts
cd C:/Work/git/_Snoworca/ProjectMaster/frontend && node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts
cd C:/Work/git/_Snoworca/ProjectMaster/frontend && node --experimental-strip-types --test tests/unit/terminalOutputDeliveryBinary.test.ts
cd C:/Work/git/_Snoworca/ProjectMaster/frontend && npx tsc -p tsconfig.app.json --noEmit && npm run typecheck:tests
```

## 10. 리스크·잔존 이슈

- **깨끗한 diff 기준선이 없다** — C5-b~d 가 만질 추적 파일 6개가 대규모 미커밋 델타를 안고 있다(`git diff --numstat HEAD` 2026-08-22 실측): `TerminalView.tsx` 2,868 / `terminalOutputScheduler.ts` 2,058 / `TerminalContainer.tsx` 1,952 / `visibleOutputRecovery.ts` 1,888 / `WebSocketContext.tsx` 1,154 / `ws-protocol.ts` 1,094 — 합계 **11,014줄, 전부 미스테이징**. 영향: 자기 변경을 diff 로 분리할 수 없다 / 대응: 신규 파일에 최대한 가두고, 기존 파일 수정은 최소 줄로.
- **P2·P3 핀이 이미 stale** — P2 는 프론트 7개 중 6개 해시 불일치, P3 의 C5 관련 5개는 전부 불일치. 영향: C5 가 red 를 새로 만드는 게 아니라 **이미 red 인 상태에 들어간다** / 대응: red 를 자기 탓으로 오진하지 말 것. P3 의 red 경로는 `--expect-red` 에서만 도달한다.
- **`frontend/src/utils/binaryFrameCodec.ts` 는 현재 소비자가 0** — 번들에서 tree-shake 된다. C5-b 가 붙기 전까지는 정상이다. 영향: "왜 번들에 없나"로 혼란 가능 / 대응: C5-b 완료 시 해소.
- **기준선 문서가 낡았다** — `docs/research/binary-comms/baseline/frontend-baseline.md` 는 HEAD `eb2f4f8` 기준(파일 56개)인데 현재 disk 는 67개다. 영향: 절대 수치 비교 불가 / 대응: **fail 6 과 그 테스트명 집합**만 기준으로 쓴다.
- **⚠️ 미검증 — `fromBinaryOutputFrame`(C5-e) 은 독립 서브에이전트 검증을 받지 못했다.** 대신 뮤테이션 15종(14 KILLED, 1 등가 확인)과 프론트 전수 회귀로 대체했다. 다음 세션이 검증을 다시 발주할 가치가 있다.
- **`frontend/src/utils/wsFrameDispatch.ts` 는 `JSON.parse` 를 `handleMessage` 밖으로 옮겼다.** `03:110` 은 *"기존 JSON 경로 그대로"* 라고 했으므로 문면상 이탈이다. 옮긴 이유는 그래야 파싱 실패가 **값**이 되어 테스트할 수 있기 때문이다(그전에는 `catch { return; }` 로 흔적 없이 사라졌다). **의미는 보존했다** — 실패 시 여전히 조기 반환하고, 파싱 결과를 좁히지 않는다. 전수 회귀 fail 6 유지가 그 증거다.
  - 다만 **한 가지는 좁아졌다**: 옛 `JSON.parse(event.data)` 는 문자열이 아닌 값도 `String()` 으로 강제변환해 파싱했다. 그래서 JSON 텍스트를 담은 `Buffer` 같은 것이 오면 **파싱에 성공**했다. 지금은 `unsupported` 로 거부한다. 브라우저 `WebSocket` 의 `data` 는 `string | ArrayBuffer | Blob` 뿐이라 프로덕션에서는 도달 불가이고 전수 회귀도 영향 없었지만, **`MessageEvent` 를 가짜로 만드는 테스트를 새로 쓸 때는 반드시 `string` 을 넣어라.**
- 🔴 **C5-d 의 세대 키는 `08:223` 폐기 트리거 3종 중 2종만 덮는다.** 키는 `` `${wsConnectionGeneration}:${sessionGeneration}` `` 인데, **epoch 롤백은 어느 쪽도 올리지 않는다** — 실측: `bumpSessionGeneration` 호출부는 4곳(`:421` transport-closed · `reconnect-ttl-expired` · `ws-disconnected` · `session-id-changed`)뿐이고 롤백은 없다. 애초에 **`TerminalContainer.tsx` 에는 롤백 핸들러 자체가 없다**(롤백은 `WebSocketContext`/`terminalCheckpointRuntime` 소관). 오늘 영향은 0 이다 — 저장소에 **독자가 없기 때문이지** 키가 맞아서가 아니다. **통합에서 저장소를 읽기 시작하는 순간 이것이 실제 결함이 된다.** 대응: 롤백 신호를 `TerminalContainer` 로 끌어와 세대를 올리거나 키에 롤백 표식을 넣어야 한다. 어느 쪽이든 롤백 경로를 건드리므로 C5-d 범위 밖으로 두었다.
- **C5-b 의 바이너리 갈래는 아직 `console.warn` + `return` 이다.** 협상이 없어 도달 불가하므로 프로덕션 동작은 불변이지만, **통합 전까지는 "바이너리를 받으면 버린다" 가 실제 동작**이다. 이것을 완성된 디코드 경로로 오해하지 마라.
