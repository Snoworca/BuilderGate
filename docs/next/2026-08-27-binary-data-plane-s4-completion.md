# 바이너리 데이터 평면 — S4 완주 — 세션 핸드오프

## ⚠️ 검증 상태 — 독립 검증 없음

**사실검증 서브에이전트가 판정을 반환하지 않았다** (2026-08-27). 이 문서는 **독립 검증을 받지 않았다.** 같은 실패가 이번 세션에 총 7회 있었다(반박 2 · 검증 1 · 결정 위원회 3 · 사실검증 1).

대신 작성자가 **기계적으로 확인 가능한 축을 직접 대조했다**. 아래는 실제로 명령을 돌려 확인한 것이다.

| 축 | 결과 |
| --- | --- |
| 모듈별 테스트 수 8건 (문서 기재값 대 실행 결과) | **8/8 일치** |
| 줄번호 앵커 10건 (`config.schema.ts:60`·`config.types.ts:78`·`SessionManager.ts:1076`·`:7128`·`WsRouter.ts:1748`·`01:462`·`05:564`·`06:1529`·`06:1673`) | **9/10 일치**, 1건 거짓 → 수정 |
| 부재 주장 3건 (`WirePayload` 없음 · `WsRouter` 의 `codecEpoch` 게이트 없음 · `wsSendPolicy.ts` 에 `terminalWireFormat` 없음) | **3/3 일치** |
| 문서가 나열한 파일 14개 실존 | **14/14 존재** |
| 브랜치 · HEAD `dfca40c` · ahead 137 / behind 0 · `01` 1622줄 | 일치 |
| 「확정된 결정」 1·3·4·6 의 근거 앵커 12건 | **12/12 일치** — 결정과 근거가 반대인 항목 없음 |

**자체 대조가 거짓 2건을 잡아 고쳤다.**

1. `01:835` → 실제 **`01:910`**. 원인은 이 문서가 인용한 `06-work-plan.md` 자체가 낡은 앵커(`01:810-835`)를 갖고 있었던 것이다. 유니온 정의는 실제로 `01:888-890` 이다.
2. `porcelain` 402 → **403**. 이 핸드오프 문서 자신이 측정 후에 추가되었다.

**검증되지 않은 것**: 판단이 필요한 축 — 「확정된 결정」 2·5·7·8·9·10 의 타당성(1·3·4·6 은 근거 앵커만 대조했을 뿐 판단의 옳고 그름은 검증되지 않았다), 「남은 작업 전체 목록」의 순서가 실제로 옳은지, 「지시서」가 실행 가능한지. 작성자가 자기 문서를 판정하면 자기검증이므로 하지 않았다. **다음 세션은 이 축들을 사실로 받지 말고, 처음 부딪히는 지점에서 재확인하라.**

⚠️ **서버 전수 43파일 / pass 710 / fail 23 은 이번 대조에서 재실행하지 않았다** (2분을 넘겨 백그라운드로 돌려야 한다). 그 수치는 2026-08-27 세션 중 1회 실행 결과다.


| Field | Value |
| --- | --- |
| 작성일 | 2026-08-27 |
| 저장소 / 브랜치 | `C:/Work/git/_Snoworca/ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| HEAD | `dfca40cf506dcbc60a170a7f3ca4fbe9f426b9d9` — **이 작업은 전부 미커밋** |
| 최종 작업 목표 | 터미널 출력이 바이너리 WebSocket 프레임으로 end-to-end 흐르게 하고 `binary-shadow` 단계에 진입한다 |
| 현재 상태 | 순수 모듈 8단위 완료(테스트 159 / 뮤턴트 104 KILLED). **프로덕션 배선 0건.** `WsRouter.ts`·`SessionManager.ts`·`wsSendPolicy.ts` 미착수 |
| SSOT | `C:/Work/git/_Snoworca/ProjectMaster/docs/research/binary-comms/06-work-plan.md` (§S4) + `.../01-frame-format-and-negotiation.md` |
| 다음 세션 첫 행동 | 아래 「다음 세션의 첫 행동」 |

> 이 문서는 다음 세션이 **이 문서와 SSOT 만 읽고** 자율적으로 이어갈 수 있도록 정리한 것이다. 대화 히스토리에 의존하지 말 것.

`<REPO>` = `C:/Work/git/_Snoworca/ProjectMaster` (이하 이 약어를 쓴다).

---

## 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. `<REPO>/docs/report/2026-08-27.binary-data-plane-eight-units.md` 를 읽는다 — 이번 세션이 만든 8개 모듈의 설계 근거와 검증 한계가 거기 있다.
3. `cd <REPO> && git status --porcelain | wc -l` 이 **403 근처**인지 본다. 크게 다르면 그 사이 누가 커밋했거나 되돌린 것이니 아래 「워킹트리 상태」를 믿지 말고 실제를 믿어라.
4. **사용자에게 `streamEpoch` 승격을 물어본다.** 이것이 유일한 blocking 결정이다. 아래 「먼저 물어야 할 것」 참조.
5. 답을 기다리는 동안 「지시서」의 **작업 7**(프론트 협상 클라이언트 배선)을 한다 — 선행이 없고 프로덕션 동작을 바꾸지 않는다.

---

## 1. 최종 작업 목표

터미널 출력을 JSON 이 아닌 바이너리 프레임으로 보내고, 클라이언트가 그것을 화면에 그리게 한다.

**완료 조건 (S4-d 진입)**: `realtime.terminalWireFormat: 'binary-shadow'` 로 설정한 서버가 output 을 JSON·바이너리 양쪽으로 인코딩하고, 와이어에는 JSON 만 내보내며, 바이너리를 디코드해 JSON 과 의미 동등성을 비교해 **불일치 0건**이 나온다. 이 단계에서 사용자에게 노출되는 동작 변화는 없다.

⚠️ **오늘 만든 것만으로는 아무것도 흐르지 않는다.** 8개 모듈은 전부 순수 함수이고 프로덕션 경로에 배선되어 있지 않다. 브라우저에서 눈으로 확인하려 하지 마라.

## 2. 현재까지 완료한 작업

### 2.1 이번 세션 (2026-08-27)

전부 test-first. 각 모듈에 뮤테이션 하네스를 붙였고, 하네스는 매번 baseline 을 먼저 파싱해 자가검증하며 종료 시 대상 파일의 sha256 복원을 확인한다.

- [x] 클라이언트 수신 배선 (이슈 #30) — `<REPO>/frontend/src/utils/binaryFrameIntake.ts` · 테스트 14 · 뮤턴트 11/11 KILLED
- [x] 협상 클라이언트 + `reason` 분기 (이슈 #31) — `<REPO>/frontend/src/utils/terminalBinaryNegotiationClient.ts` · 테스트 18 · 뮤턴트 12/12
- [x] 채널 할당자 (`01 §1.5`) — `<REPO>/server/src/ws/terminalChannelAllocator.ts` · 테스트 22 · 뮤턴트 12/12
- [x] JSON 출력 → wire 어댑터 — `<REPO>/server/src/ws/terminalOutputWireAdapter.ts` · 테스트 16 · 뮤턴트 13/13
- [x] 협상 판정기 (`01 §2.2`) — `<REPO>/server/src/ws/terminalBinaryNegotiation.ts` · 테스트 21 · 뮤턴트 15/15
- [x] 와이어 포맷 정책 + 설정키 — `<REPO>/server/src/ws/terminalWireFormat.ts` · 테스트 20 · 뮤턴트 12/12
- [x] 그룹 소유 상태 — `<REPO>/server/src/ws/terminalBinaryGroupSession.ts` · 테스트 19 · 뮤턴트 12/12
- [x] 세션 소유 epoch 원장 (`01 §1.6`) — `<REPO>/server/src/ws/terminalStreamEpoch.ts` · 테스트 16 · 뮤턴트 11/11
- [x] `realtime.terminalWireFormat` 설정키 — `<REPO>/server/src/schemas/config.schema.ts:60` (기본 `json`), 타입은 `<REPO>/server/src/types/config.types.ts:78`
- [x] 컨텍스트 배선 — `<REPO>/frontend/src/contexts/WebSocketContext.tsx` 의 `frame.kind === 'binary'` 갈래를 `intakeBinaryFrames` 호출로 교체 + `SessionHandlers.getLiveOutputTokens` 추가
- [x] 컨테이너 배선 — `<REPO>/frontend/src/components/Terminal/TerminalContainer.tsx` 에 `getLiveOutputTokens` 1줄

### 2.2 검증 (전부 2026-08-27 실행)

| 명령 (cwd 명시) | 결과 |
| --- | --- |
| 프론트 단위 전수, `cd <REPO>/frontend` 에서 `tests/unit/*.test.ts` 파일별 `env -u NODE_ENV node --experimental-strip-types --test <파일>` | **73파일 / pass 865 / fail 6** — 실패 테스트명 집합이 이번 세션 시작 시점 기준선과 **동일** |
| 서버 `src/ws` 전수, `cd <REPO>/server` 에서 `env -u NODE_ENV npx tsx --test src/ws/<파일>` | **16파일 / pass 318 / fail 0** |
| 서버 전수 (`find src -name "*.test.ts"`) | **43파일 / pass 710 / fail 23** — 전부 기존 실패 (아래 참조) |
| `cd <REPO>/frontend && env -u NODE_ENV npx tsc -p tsconfig.app.json --noEmit` | exit 0 |
| `cd <REPO>/frontend && env -u NODE_ENV npm run typecheck:tests` | exit 0 |
| `cd <REPO>/server && env -u NODE_ENV npx tsc --noEmit -p tsconfig.json` | exit 0 |

서버 실패 23건의 귀속:

- **13건** `TerminalAuthorityProductionRegression.test.ts` — `CLAUDE.md` 가 문서화한 기지 실패(`dist/` 를 대상으로만 성립). 개수까지 일치.
- **10건** 4개 파일(`RetainedTerminalAuthority` 1 · `SessionManagerPartialEscapeTail` 5 · `TerminalResourcePolicy` 3 · `TerminalResourcePolicyCanary` 1) — **대조군으로 확정**. 이번 세션의 소스 편집 2건(`config.schema.ts`·`config.types.ts`)을 되돌린 뒤 같은 4파일을 재실행했고 pass·fail 수치가 한 자리도 다르지 않았다. 하네스는 `C:/Users/beom/AppData/Local/Temp/claude/C--Work-git--Snoworca-ProjectMaster/55a81fdc-c9a5-4ed0-a9c7-b20edcbbf749/scratchpad/control-preexisting.mjs` (⚠️ 스크래치패드는 세션별이라 다음 세션에는 없을 수 있다 — 없으면 같은 방식으로 다시 만들어라).

### 2.3 기억과 실제가 달랐던 항목

이번 세션에 스스로 잡아 고친 것들이다. **다음 세션은 "그럼 나머지는 믿어도 되나"를 알아야 하므로 남긴다.**

| 기록했던 진술 | 실제 (확인 명령) |
| --- | --- |
| 보고서 초안 "테스트 155건, 뮤턴트 98/98" | **테스트 159건, 뮤턴트 104/104.** 각 테스트 파일을 실행해 `pass N` 을 합산하고, 하네스의 `grep -cE "^    id: '"` 로 뮤턴트를 셈 |
| 보고서 초안 `TerminalContainer.tsx:3294` / `:3386` | **`:3299` / `:3391`.** 이번 세션이 `getLiveOutputTokens` 5줄을 삽입해 밀렸다. `grep -n 'delivery.replayToken !== compatibilityPostAckConvergence.replayToken'` 으로 재측정 |
| 보고서 초안 "porcelain 378" | **402** (이 핸드오프 문서를 쓰기 전 시점). `git status --porcelain \| wc -l` |
| 선행 핸드오프 `2026-08-26-...md` §8 "`decodeWsMessage` 는 `fatal` 이어도 `frames` 를 버리지 않는다" | **결함 부류에 따라 다르다.** `END_OF_BATCH` 뒤에 바이트가 더 오면 `batch-terminated-early` 로 `frames` 가 0이 된다. 프레임이 살아남는 경우는 골든 코퍼스 전체에서 `D14-fault-mid-batch-prologue-present-cleared` 하나뿐 |

## 3. 워킹트리 상태

- 브랜치 `work/mcp-session-orchestration-20260709` — `origin/main` 대비 **ahead 137 / behind 0**
- `git status --porcelain` 총 **403 엔트리** (2026-08-27 측정, 이 문서 포함). **공유 워킹트리**이고 대부분이 이 작업과 무관한 남의 미커밋 작업이다. 스테이징된 변경 0건.

이 작업이 만든 파일 (`??`):

```
<REPO>/frontend/src/utils/binaryFrameIntake.ts
<REPO>/frontend/src/utils/terminalBinaryNegotiationClient.ts
<REPO>/frontend/tests/unit/binaryFrameIntake.test.ts
<REPO>/frontend/tests/unit/binaryFrameIntakeWiring.test.ts
<REPO>/frontend/tests/unit/terminalBinaryNegotiationClient.test.ts
<REPO>/server/src/ws/terminalChannelAllocator.{ts,test.ts}
<REPO>/server/src/ws/terminalOutputWireAdapter.{ts,test.ts}
<REPO>/server/src/ws/terminalBinaryNegotiation.{ts,test.ts}
<REPO>/server/src/ws/terminalWireFormat.{ts,test.ts}
<REPO>/server/src/ws/terminalBinaryGroupSession.{ts,test.ts}
<REPO>/server/src/ws/terminalStreamEpoch.{ts,test.ts}
<REPO>/server/src/ws/WsRouterBinaryChannels.test.ts
<REPO>/docs/report/2026-08-27.binary-data-plane-eight-units.md
<REPO>/docs/worklog/2026-08-27.jsonl
```

이 작업이 수정한 추적 파일 (` M`):

```
<REPO>/frontend/src/contexts/WebSocketContext.tsx
<REPO>/frontend/src/components/Terminal/TerminalContainer.tsx
<REPO>/frontend/tsconfig.test.json
<REPO>/server/src/schemas/config.schema.ts
<REPO>/server/src/schemas/config.schema.test.ts
<REPO>/server/src/types/config.types.ts
<REPO>/server/src/services/RuntimeConfigStore.test.ts
```

🔴 **커밋 단위는 사용자 결정 대기 항목이다.** 부분 커밋은 CI 를 깬다 — `binaryFrameIntakeWiring.test.ts` 가 미커밋 상태인 `WebSocketContext.tsx`·`TerminalContainer.tsx` 의 소스 텍스트를 검사한다. 전부 커밋하면 남의 미커밋 델타를 쓸어간다(`TerminalContainer.tsx` 1,952줄 / `WebSocketContext.tsx` 1,154줄, 2026-08-22 실측이므로 재측정할 것).

## 4. 관련 문서·코드 (절대경로)

| 문서 | 절대경로 | 역할 |
| --- | --- | --- |
| SSOT (작업 계획) | `<REPO>/docs/research/binary-comms/06-work-plan.md` | S0~S7 단계 정의. §S4 가 이번 과제 |
| SSOT (프레임 사양) | `<REPO>/docs/research/binary-comms/01-frame-format-and-negotiation.md` | 프레임·협상·채널의 정본. **1622줄을 유지해야 한다** |
| 클라이언트 배선 설계 | `<REPO>/docs/research/binary-comms/08-client-wiring-design.md` | C0~C6. ⚠️ 낡은 앵커 있음(아래 참조) |
| 롤아웃 사다리 | `<REPO>/docs/research/binary-comms/05-test-migration-rollback.md` | §8.2 가 4단계 진입·이탈 조건 |
| 이번 세션 보고서 | `<REPO>/docs/report/2026-08-27.binary-data-plane-eight-units.md` | 8개 모듈의 설계 근거·검증 한계 |
| 선행 핸드오프 | `<REPO>/docs/next/2026-08-26-binary-data-plane-issues-29-31.md` | C5 배선 상세. §8 에 틀린 전제 1건 있음(위 표 참조) |
| 프로젝트 SSOT | `<REPO>/docs/next/2026-08-19-binary-data-plane-handoff.md` | 전체 맥락 |

**수정 대상 코드**:

- `<REPO>/server/src/ws/WsRouter.ts` — 그룹 세션 보유, 협상 메시지 핸들러, `subscribed` 장식, 해제 통지, `codecEpoch` 게이트
- `<REPO>/server/src/services/SessionManager.ts` — `streamEpoch` 세션 소유 승격 (현재 `:1076` 의 `retainedTerminalStreamEpochCounter` 는 **전역** 카운터)
- `<REPO>/server/src/ws/wsSendPolicy.ts` — `:96` `JSON.stringify` codec 분기, `:100` byteLength
- `<REPO>/frontend/src/contexts/WebSocketContext.tsx` — 협상 클라이언트 배선

**신규 생성 예정**: `WirePayload` 판별 유니온 + `encodeFor(ws, message)` — 형태는 `01:888-890`(유니온 정의)·`01:902`(`encodeFor` 시그니처)·`01:910`(불변식). ⚠️ `06-work-plan.md` 는 이것을 `01:810-835` 로 인용하는데 **그 앵커는 낡았다**(2026-08-27 실측)

**참고 선례**:

- `<REPO>/server/src/ws/WsRouterCheckpointProtocol.test.ts` — `WsRouter` 를 `FakeWebSocket` + private 필드 캐스트로 구동하는 하네스
- `<REPO>/server/src/ws/WsRouterBinaryChannels.test.ts` — 이번 세션이 그 하네스로 만든 것. 확장해서 쓰면 된다
- `<REPO>/server/src/ws/wsTransportMode.ts` — 설정 사다리 + URL 파싱의 선례

## 5. 확정된 결정 (재논의 금지)

| # | 결정 | 확정도 | 근거 |
| --- | --- | --- | --- |
| 1 | `TerminalContainer.tsx:3299` 의 `replayToken` 비교에 `!== undefined` 가드를 **추가하지 않는다** | **확정** | 수렴 상태의 `replayToken` 이 옵셔널이 아니고(`:218`·`:234`), `:3295` 의 `isCurrentCompatibilityPostAckState`(`:1404-1411`)가 토큰 저장소와 **같은 세대쌍**을 `:3299` 보다 먼저 검사한다. `forget` 3곳(`:1116`·`:1129`·`:1723`)이 각각 떠나는 id 를 쓰거나 같은 effect 의 `:1136` 이 수렴을 `null` 로 만들거나 직후 `:1724` 가 재기록한다 |
| 2 | `realtime.terminalWireFormat` 기본값은 `json` | **확정** | `<REPO>/server/src/schemas/config.schema.ts:60` 에 구현됨 |
| 3 | 바이너리는 `wsTransportMode === 'unified'` 에서만 허용 | **확정** | `05:564` 권고. `terminalWireFormat.ts` 의 `isTransportEligible` 이 구현 |
| 4 | `binary-shadow` 는 협상을 열지 않는다 | **확정** | 그 단계는 와이어에 바이너리가 나가지 않는다. `isBinaryNegotiable` 이 구현 |
| 5 | `channel-retired` 의 미지 `reason` 은 `clear()` (fail-safe) | **확정** | 미지 채널은 복구 경로가 있고(해당 채널만 fresh snapshot), 굳은 표는 복구 경로 없는 무성 블랙아웃. 이슈 #31 본문 |
| 6 | 채널 등록부는 `channelId` 로 키잉, 재바인딩은 `sessionId` 변경 기준으로 거부 | **확정** | `01:369-371`·`01:393` |
| 7 | `authorityEpochIndex` 는 프롤로그에 남기고, UUID 는 control 메시지가 싣는다 | **확정** | 개정 R3 (`01:350`) |
| 8 | `08:224` 의 JSON 폴백은 구현하지 않는다 | **확정** | 없던 토큰을 채우면 판정이 세 곳에서 뒤집히고 둘은 출력을 잃는다. 이슈 #30 본문 |
| 9 | `TerminalWireFormat` 타입은 설정 계층(`config.types.ts:78`)이 소유하고 `ws/terminalWireFormat.ts` 가 재수출 | **확정** | 코드에 구현됨 |
| 10 | 설정키 이름은 `terminalWireFormat` (`05:545` 의 `wsFrameCodec` 아님) | **확정** | 핸드오프 3건과 `06:570` 이 전자. `05` 가 소수 |

## 6. 먼저 물어야 할 것 (blocking)

🔴 **`streamEpoch` 세션 소유 승격을 진행할지.**

`subscribed` 행에 채널 정보를 실으려면 세션별 `streamEpoch` 이 필요하다. 그런데 `<REPO>/server/src/services/SessionManager.ts:1076` 의 `retainedTerminalStreamEpochCounter` 는 세션별이 아니라 **전역** 카운터다(`private retainedTerminalStreamEpochCounter = 0n;`, `:7128` 에서 `String(++this.retainedTerminalStreamEpochCounter)` 로 소비).

`01:462` 는 이것을 세션 소유로 승격하라고 요구한다. 그 승격은 §4 롤백의 전제("epoch 을 올리면 클라이언트가 구 스트림을 자동 폐기")를 건드리는 의미론적 변경이고, **`terminalWireFormat` 게이트 밖**이라 기본 배포에도 영향이 간다.

이번 세션은 승격의 대상이 될 원장을 순수 모듈(`<REPO>/server/src/ws/terminalStreamEpoch.ts`)로 먼저 만들어 두었다. `SessionManager` 쪽은 위임 몇 줄이다.

선택지:
- (a) 승격 진행 — `SessionManager` 가 `terminalStreamEpoch.ts` 원장에 위임하고 5개 증가 사건을 배선
- (b) 승격 보류 — 그러면 `subscribed` 장식과 그 이후 전부가 막힌다
- (c) 다른 것

## 7. 남은 작업 전체 목록

### A. S4 완주 (순서가 중요)

- [ ] **A1. `WirePayload` 판별 유니온 + `encodeFor(ws, message)`** — 완료 조건: `{codec:'json'; text}` / `{codec:'binary'; bytes; codecEpoch}` 두 갈래가 존재하고, `binary` 를 `ws.send(text)` 경로에 넣으면 **컴파일이 실패**한다. 신규 모듈, 단위 테스트 + 뮤테이션. (선행: 없음)
- [ ] **A2. `streamEpoch` 세션 소유 승격** — 완료 조건: `SessionManager` 가 세션별 epoch 을 `terminalStreamEpoch.ts` 원장에 위임하고, `01:476-480` 의 5개 사건에서만 증가하며, 서버 전수 fail 이 23건을 넘지 않는다. (선행: 위 「먼저 물어야 할 것」 답변)
- [ ] **A3. `WsRouter` 가 그룹 세션 보유 + `terminal-binary:capability` 수신 핸들러** — 완료 조건: 협상 offer 를 보내면 `resolveTerminalBinaryNegotiation` 결과가 그대로 응답으로 나가고, `terminalWireFormat: 'json'` 에서는 `rejected` 가 나온다. (선행: A1)
- [ ] **A4. `subscribed` 3분기에 `openChannel` 결과 spread** — 완료 조건: `json` 에서 행의 키 집합이 `['cwd','ready','sessionId','status']` 로 불변이고, 협상 완료 후에는 `channelId`·`streamEpoch`·`authorityEpoch` 가 실린다. **이것이 이슈 #29 의 서버 emit 이다.** (선행: A2·A3)
- [ ] **A5. 해제 통지** — 완료 조건: unsubscribe·disconnect 가 `closeSession` 을 부르고 그 반환 채널로 `terminal-binary:channel-retired` 를 보낸다. (선행: A3)
- [ ] **A6. 송신 경로 codec 분기 + `codecEpoch` 게이트** — 완료 조건: `wsSendPolicy.ts:96`·`:100` 이 codec 으로 갈리고, `WsRouter.ts:6249` 의 binding 검사 아래에 `payload.codecEpoch !== groupCodecEpoch(ws)` 게이트가 있어 `codec-epoch-retired` 로 종결한다(재인코딩하지 않고 버리고 정산). (선행: A1·A3)
- [ ] **A7. 프론트: 협상 클라이언트를 `WebSocketContext` 에 배선 (수신 3종)** — 완료 조건: `capability(accepted)`·`rejected`·`channel-retired` 가 `applyTerminalBinaryControlMessage` 로 흐른다. 프로덕션 동작 불변. (선행: 없음)
- [ ] **A8. 프론트: offer 송신 + `terminal-binary:unknown-channel` C→S** — 완료 조건: 연결 시 offer 를 보내고, 미지 `channelId` 수신 시 그 채널만 fresh snapshot 을 요청한다. (선행: A3·A7)
- [ ] **A9. S4-c — xterm 이중 디코더 순서 위험** — 완료 조건: `06:1673` 이 지목한 위험이 실재하는지 실측하고 결론을 기록. (선행: A6·A8)
- [ ] **A10. shadow 등가 비교기** — 완료 조건: 같은 출력을 JSON·바이너리로 인코딩해 의미 동등성을 비교하고 불일치를 카운트한다. (선행: A6)
- [ ] **A11. S4-d 진입 게이트 → `binary-shadow`** — 완료 조건: `06:1697-1698` 의 두 조건. ① 기준선에 없던 red 0건 ② S1·S2·S2.5·S3 이 신설·변경한 테스트 전건 green. (선행: A1~A10)

### B. 미완 선행 항목

- [ ] **B1. S3 silent drop 8항목** — 최소 1건 미완: `<REPO>/server/src/ws/WsRouter.ts:1746-1749` 가 `JSON.parse` 실패를 `console.warn('[WS] Invalid JSON received')` 후 폐기한다(2026-08-27 실측). ⚠️ **나머지 7항목의 상태는 미확인.** 집합 정의는 `06:1389-1400`
- [ ] **B2. S4-0b 프롤로그 사양 열린 항목 9건** — `06:1529`. S4 착수 전 확인 목록. ⚠️ **상태 미확인**

### C. 사다리 상승 (S4 이후)

- [ ] **C1. S5 회계 재벤치 + 증거 번들 재발행 → `binary-optin`** — ⚠️ 정책 키 처분이 셋으로 갈린다(`06:909`): 바이트 도메인 5개(`socketSoftGateBytes`·`bulkSliceBytes`·`smallOutputBypassBytes`·`creditWindowBytes`·`queueMaxBytes`)는 재측정, `strategy`·`visibilityWeight`·`driverWeight` 는 재귀속, `ackTimeoutMs` 는 시간 도메인이라 별도 항목. `bulkSliceBytes` 는 한 키가 두 도메인에 걸쳐 각각 재측정이 필요하다
- [ ] **C2. S6 혼합 버전 + 롤백 드릴 → `binary` 기본값 전환** — 이탈 조건에 **두 릴리스 soak**(달력 시간)이 포함되어 개발 속도로 앞당길 수 없다
- [ ] **C3. S7 legacy JSON 인코딩 경로 제거** — 이슈 #22 조건 + 달력 두 릴리스. JSON control 평면은 제거 대상이 아니다
- [ ] **C4. C6 마이크로벤치 + 동등성** — 선행: 위 전부

### D. 문서·이슈 (코드 무관)

⚠️ `<REPO>/CLAUDE.local.md` 규칙 1: 사용자가 직접 지시하지 않으면 문서를 자동으로 검증·개선하지 않는다. 아래는 **지시가 있을 때만** 한다.

- [ ] `08:145` 의 `WebSocketContext.tsx:1140`/`:592` → 실제 `:1181`/`:607` (2026-08-26 실측이므로 재측정 필요)
- [ ] `08:207-210` 의 `TerminalContainer.tsx` 앵커 5개 — 2026-08-26 실측 이후 이번 세션이 5줄을 더 삽입했으므로 재측정 필요
- [ ] `08:226` 경계 대조군을 **채우는 방향**으로 재작성 — 현재 문면("비우고 green")은 공허 통과
- [ ] `01:1308` 인덱스 `0` 의미 확정 — R3 이 닫지 않았다. 클라이언트는 `channelId` 로 표를 찾으므로 남은 문제는 서버 인코더와 벡터 해석에 한정
- [ ] `05:545` 의 `wsFrameCodec` → `terminalWireFormat` 불일치
- [ ] `06-work-plan.md` 가 `01` 을 인용한 앵커 중 최소 2건이 낡았다 — `01:810-835`(실제 `:888-890`), `01:1066-1081`(실제 그 자리는 fatal/scoped 판정 기준이고 `codec-epoch-retired` 서술은 `:1193`). 2026-08-27 실측
- [ ] GitHub 이슈 #2·#19·#20·#21·#22 가 폐기된 측정 게이트를 언급 — 문안 미정

### E. 결정 대기

- [ ] **커밋 단위** — 위 「워킹트리 상태」 참조
- [ ] **`WsTransportMode` 중복 선언 통합 여부** — `<REPO>/server/src/types/config.types.ts:73` 과 `<REPO>/server/src/ws/wsTransportMode.ts:1` 에 같은 타입이 두 번 선언되어 있다(2026-08-27 실측). 이번 세션은 기존 중복을 손대지 않았다

## 8. 다음 세션 지시서

**전부 TDD. 실패 테스트를 먼저 쓰고 red 를 눈으로 확인한 뒤 구현한다. 구현 후 반드시 뮤턴트를 건다.**

### 지금 바로 할 수 있는 것 — A7 (프론트 협상 클라이언트 배선)

1. `<REPO>/frontend/tests/unit/binaryFrameIntakeWiring.test.ts` 를 확장해, `WebSocketContext.tsx` 가 `applyTerminalBinaryControlMessage` 를 부르는지 소스 텍스트로 단언한다 → 검증: red 확인
2. `<REPO>/frontend/src/contexts/WebSocketContext.tsx` 의 JSON 메시지 처리부에 갈래를 추가한다. 등록부는 이미 `channelRegistryRef.current` 로 손에 있다 → 검증: 위 테스트 green
3. 뮤턴트: `applyTerminalBinaryControlMessage` 호출 제거 / 등록부 대신 새 인스턴스 전달 → 전부 KILLED 여야 한다
4. 프론트 전수 회귀 → 검증: **fail 6 과 그 테스트명 집합**이 아래 「검증 명령」의 기준과 일치

### 승인 후 — A1 → A2 → A3 → A4 → A5 → A6

**A1 과 A6 은 한 묶음으로 보라.** A1 만 하면 사용처 없는 타입이 남고, A6 을 먼저 하면 A1 이 그 코드를 되돌린다. `01:910` — *"이 구조에서 'JSON 전용 소켓에 바이너리 프레임을 보낸다'는 상태가 코드로 표현되지 않는다."*

각 단계의 완료 조건은 위 「남은 작업 전체 목록」의 A1~A6 에 적혀 있다.

### 검증 명령 (복붙 가능)

```bash
# 프론트 타입체크
cd C:/Work/git/_Snoworca/ProjectMaster/frontend && env -u NODE_ENV npx tsc -p tsconfig.app.json --noEmit && env -u NODE_ENV npm run typecheck:tests

# 서버 타입체크
cd C:/Work/git/_Snoworca/ProjectMaster/server && env -u NODE_ENV npx tsc --noEmit -p tsconfig.json

# 프론트 단위 전수 (파일별)
cd C:/Work/git/_Snoworca/ProjectMaster/frontend
for f in tests/unit/*.test.ts; do env -u NODE_ENV node --experimental-strip-types --test "$f" 2>&1 | grep -oE "pass [0-9]+|fail [0-9]+"; done

# 서버 ws 전수 (파일별)
cd C:/Work/git/_Snoworca/ProjectMaster/server
for f in src/ws/*.test.ts; do env -u NODE_ENV npx tsx --test "$f" 2>&1 | grep -oE "pass [0-9]+|fail [0-9]+"; done
```

**프론트 기준선 (2026-08-27)**: 73파일 / pass 865 / fail 6. 실패 테스트명 집합은 다음 4파일 — `terminalCheckpointRuntime.test.ts` 3건 · `terminalContainerRecoveryContract.test.ts` 1건 · `terminalHiddenOutput.test.ts` 1건 · `wsCheckpointProtocol.test.ts` 1건.

**서버 `src/ws` 기준선 (2026-08-27)**: 16파일 / pass 318 / fail 0.

`npx playwright test` 는 이 단계에서 돌리지 마라 — `frontend/tests/unit/` 을 0건 수집하고 프로덕션 서버를 띄운다.

## 9. 거버넌스·게이트·함정

- **`kill <pid>` / `taskkill /F /IM node.exe` 절대 금지.** dev 서버 포트는 항상 **2222**
- **커밋 메시지에 어떤 시그니처도 넣지 않는다.** 제목에 `Phase n`/`Step n`/`TASK-XXX` 도 금지
- **셸에 `BUILDERGATE_*` 15개 + `NODE_ENV=production` 이 있고 다른 런타임 루트를 가리킨다.** 테스트 명령에 전부 `env -u NODE_ENV` 를 붙인다
- **`cd` 가 Bash 호출 간에 유지된다.** 이번 세션에 두 번 밟았다 — 저장소 루트에서 하네스를 돌린 뒤 `frontend/` 명령을 상대경로로 쓰니 `No such file` 이 났다. **매 호출마다 절대경로 `cd` 를 쓸 것**
- **node 의 `ℹ` 는 멀티바이트다.** `grep "^. pass"` 로 파싱하면 조용히 0건이 된다. `grep -oE "pass [0-9]+"` 를 쓸 것
- 🔴 **`npx tsx --test` 는 타입을 검사하지 않는다.** 이번 세션에 협상 테스트 21건이 전부 green 인 상태에서 `tsc` 를 돌리자 유니온 타입 접근 오류 10건이 나왔다. **서버 테스트를 쓴 뒤 반드시 `tsc` 를 따로 돌릴 것**
- 🔴 **`npm run typecheck:tests` 는 새 테스트 파일을 보지 않는다.** `<REPO>/frontend/tsconfig.test.json` 의 `files` 는 손으로 늘리는 허용목록이다. 이번 세션에 `wsFrameDispatch.test.ts`·`terminalOutputDeliveryBinary.test.ts` 두 개가 빠져 있는 것을 발견했다 — 즉 그 두 파일은 `tsc` 를 아예 통과하지 않고 있었다. **테스트 파일을 새로 만들면 그 자리에서 `files` 에 추가할 것**
- 🔴 **뮤테이션 100% KILLED 는 "빠진 케이스 없음"을 뜻하지 않는다.** 이번 세션에 살아남은 뮤턴트가 세 번 실제 결함을 알렸고, 세 번 다 테스트가 green 인 상태였다. **뮤턴트 목록을 볼 때 "이 뮤턴트가 사실은 개선 아닌가?"를 물어라.** 수정 후에는 옛 동작으로 되돌리는 **회귀 뮤턴트**를 반드시 추가하라
- 🔴 **등가 뮤턴트를 추론으로 판정하지 마라.** 이번 세션에 `asRecord` 가드 뮤턴트가 살아남았을 때 "도달 불가"라고 넘기지 않고 두 판본을 나란히 실행해 갈리는 입력을 실제로 찾았다(`type` 속성을 가진 배열, `JSON.parse` 로는 생성 불가). 그 입력을 테스트로 고정해 KILLED 로 바꿨다
- 🔴 **무관한 spec 이 빨개지면 대조군을 만들어라.** "관련 없어 보인다"로 넘기지 말 것. 이번 세션은 소스 편집을 되돌린 뒤 같은 파일을 재실행해 10건 전부 기존 실패임을 확정했다
- 🔴 **`01-frame-format-and-negotiation.md` 는 1622줄을 유지해야 한다.** 다른 문서·테스트가 줄번호로 인용한다. **개정은 기존 줄에 인라인으로 덧붙여라**(R1·R2·R3 전부 그 형태). 검증: `wc -l` 이 1622 + `git diff -U0` 의 전 hunk 가 `-N +N`
- **python heredoc 으로 코드를 치환할 때 조심하라.** 이번 세션에 치환 패턴이 함수 본문까지 바꿔 **무한 재귀**를 만들었다. 타입체크는 통과했고 실행해서 잡았다. 치환 후에는 반드시 테스트를 돌릴 것
- **소스 텍스트 계약 테스트의 고정 창.** `<REPO>/frontend/tests/unit/terminalContainerRecoveryContract.test.ts` 가 `source.slice(readyStart, readyStart + 1300)` 로 자른 뒤 그 안에서 순서를 단언한다. 함수 안에 줄을 넣으면 단언 대상이 창 밖으로 밀려 red 가 된다 — 제품 동작과 무관하다

## 10. 리스크·잔존 이슈

- 🔴 **서브에이전트가 이번 세션에 100% 실패했다.** 6종(반박 2 · 검증 1 · 결정 위원회 3)을 띄웠고 재요청을 포함해 **모든 요청이 판정 없이 유휴로 종료**했다. 따라서 **이번 세션의 산출물은 독립 검증을 받지 않았다.** 위 검증 결과는 전부 작성자가 직접 명령을 실행해 얻은 것이며 기계적으로 확인 가능한 축에 한정된다. 검증되지 않은 것은 판단 축이다 — 각 모듈의 설계가 옳은지, 「확정된 결정」 1·3·4·5 가 타당한지. **다음 세션은 이 축들을 사실로 받지 말고 처음 부딪히는 지점에서 재확인하라.** 대응: 서브에이전트를 다시 시도하되, 유휴로 들어가면 `SendMessage` 로 "응답 TEXT 로 보내라"고 1회 재요청하고, 그래도 없으면 기권 처리하고 기계적 축은 직접 돌려라
- **깨끗한 diff 기준선이 없다.** A3~A6 이 만질 `WsRouter.ts`·`wsSendPolicy.ts` 가 남의 미커밋 델타를 안고 있을 가능성이 높다(⚠️ 재측정 필요: `git diff --stat -- server/src/ws/WsRouter.ts server/src/ws/wsSendPolicy.ts`). 대응: 판단이 들어가는 부분을 순수 모듈로 먼저 빼고 프로덕션 파일에는 위임 몇 줄만 남긴다 — 이번 세션이 8단위 내내 쓴 방식이다
- **바이너리 갈래는 현재 "협상이 없어 도달 불가"가 아니라 "게이트가 닫혀 있어 도달 불가"다.** `terminalWireFormat` 기본값 `json` 이 그 게이트다. A6 을 넣어도 기본 배포 동작은 불변이지만, 설정을 올리는 순간 도달 가능해진다
- **grace 재생에 경합이 있다.** 스냅샷 핸들러가 `void` 로 던져진 async 라(`TerminalContainer.tsx:3251-3253`, ⚠️ 이번 세션의 5줄 삽입으로 밀렸을 수 있으니 재측정할 것), 출력 재생이 그게 실행 중일 때 돈다. 재생 메시지가 버퍼링 시점에 없던 토큰을 비결정적으로 받는다. 세대 스탬프는 못 막는다 — 스냅샷이 바꾼 건 토큰이지 세대가 아니다
- **바이너리 프레임이 grace 버퍼에 들어가지 못한다.** 세션 핸들러가 붙어 있지 않은 순간 도착한 프레임은 버려진다. `GraceBufferedSessionState.output` 의 타입이 `TerminalOutputMessage[]` 라 `TerminalOutputDelivery` 를 담을 수 없기 때문이다. 담으려면 그 버퍼 타입을 바꿔야 한다
