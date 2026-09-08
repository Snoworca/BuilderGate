# 남은 작업 전체 실행 계획 — S5-c0, 회귀 스위트, 설정 정리

- **작성일**: 2026-09-07 (검증·개정 2026-09-08)
- **작성 시점 저장소**: `HEAD = 8d3991d`, 브랜치 `work/mcp-session-orchestration-20260709`, 추적 파일 변경 0건, origin 과 동일
- **근거 조사**: `C:\Work\git\_Snoworca\ProjectMaster\docs\research\2026-09-05.remaining-work-and-dead-settings-survey.md`
- **SSOT 작업표**: `C:\Work\git\_Snoworca\ProjectMaster\docs\research\binary-comms\06-work-plan.md` 의 `#### S5-c0.` 절. 이 문서가 말하는 "작업 #1~#4" 는 그 절의 번호다. 줄 번호 인용은 드리프트되어 있으므로 `grep -n "#### S5-c0\."` 로 찾을 것
- **선행 핸드오프**: `C:\Work\git\_Snoworca\ProjectMaster\docs\next\2026-09-05-s5-c0-ack-domain.md` (작업 #1 은 커밋 `808d3fb` 로 완료)
- **GitHub 저장소**: `Snoworca/BuilderGate`
- **읽는 대상**: 다른 세션의 코딩 에이전트. 이 문서만으로 착수 가능해야 한다

---

## §0. 다음 세션의 첫 행동

### 0.1 상태 확인

```
cd C:\Work\git\_Snoworca\ProjectMaster
git status --porcelain
git log --oneline -3
```

`HEAD` 가 `8d3991d` 가 아니면 이 문서의 줄 번호가 밀렸을 수 있다. 그 경우 **§9.0 의 grep 8개**로 앵커를 재측정한 뒤 착수한다.

### 0.2 선행 세션의 잔여물 확인

```
git status --porcelain docs/analysis | cat
```

`terminal-resource-consumer-manifest.*.json` 두 파일이 modified 로 보이면 **그것은 이 계획의 산출물이 아니라 선행 세션이 남긴 것**이다. 손대지 말고(§8.5 대로 커밋 범위에서 제외) 사용자에게 보고한다. §9.9 는 재봉인이 필요하다고 판단됐을 때만 쓰는 참고 절이며, 이 계획의 어느 작업도 그것을 요구하지 않는다.

작성 시점(`HEAD=8d3991d`)에는 추적 파일 변경이 0건이었다.

### 0.3 SRS 확인

`CLAUDE.md` 는 코드·테스트·문서를 바꾸기 전에 `docs/spec/00.index.md` 를 읽고 관련 Requirement ID 를 찾아 작업 요약에 명시하도록 규정한다. 없으면 **중단하고 물어야 한다.**

| 작업 | REQ-ID | 비고 |
|---|---|---|
| A-1~A-5 | `PERF-BGSTAB-011` AC-10 | 근거는 `docs/spec/30.buildergate-stability.srs.md:5144` |
| B-1~B-3 | 미배정 | 착수 전 사용자에게 SRS 신설 여부를 묻는다 |
| C-1~C-4 | 미배정 | 〃 |

MCP `get_active_target` → `get_requirement` 로 Stability 를 확인하고, `draft` 또는 `deprecated` 면 착수하지 말고 보고한다.

⚠️ **`IR-BGSTAB-001` 과 `PERF-BGSTAB-011` 은 둘 다 AC-10 을 갖는다.** 위 표가 가리키는 것은 `PERF-BGSTAB-011` 의 것(`:5144`)이고, `IR-BGSTAB-001` 의 AC-10 은 `:5007` 로 내용이 다르다. 인용할 때 블록을 확인할 것.

### 0.4 착수

**작업 A-0**(§3.1)부터 시작한다. A-0 는 코드를 쓰지 않는 결정 단계이고, 그것 없이 A-1 에 들어가면 타입과 호출부가 어긋난 채로 멈추게 된다.

---

## §1. 목표

세 갈래를 끝낸다. 서로 독립이므로 순서를 바꿔도 되지만, **A 는 시점 제약이 있다.**

| 갈래 | 내용 | 시점 제약 |
|---|---|---|
| **A** | S5-c0 ACK 도메인 전환 (작업 #2·#3·#3b·#4) | S5-c(`binary-optin`) 진입 **전**에 끝나야 한다. 진입 여부의 판별식은 `terminalWireFormat` 의 기본값이다 — `json` 이면 아직 진입 전이다 (`grep -n "terminalWireFormat" server/src/schemas/config.schema.ts`). D 그룹 라벨(S6·S7·C6)의 출처는 `docs/next/2026-09-02-long-red-suite-cleanup.md` §D |
| **B** | 회귀 스위트 복구 (C2·C4·B4) | 없음 |
| **C** | 설정 정리 (GitHub 이슈 #32~#36) | 없음 |

**A 를 먼저 권한다.** B·C 는 언제 해도 같은 비용이지만 A 는 아니다.

---

## §2. 현재 상태 — 실측

### 2.1 green 인 것

| 스위트 | 명령 | 결과 |
|---|---|---|
| 서버 모놀리식 러너 | §9.1 | **532 passed, exit 0** (2026-09-08 실측) |
| `FairTerminalDeliveryScheduler.test.ts` | §9.2 | tests 18 / pass 18 / fail 0, exit 0 (2026-09-08 실측) |
| `config.schema.test.ts` | §9.6 | tests 14 / pass 14 / fail 0, exit 0 (2026-09-08 실측) |
| `TerminalAuthorityProductionRegression.test.ts` | §9.5 | tests 38 / pass 38 / fail 0 (2026-09-08 실측) |

### 2.2 green 으로 보이지만 red 인 것 — exit 0 이 거짓말을 한다

| 스위트 | 명령 | 결과 |
|---|---|---|
| `WsRouterSplitHandshake.test.ts` | §9.3 | tests 28 / pass 14 / fail 0 / **todo 14**, exit 0 — 실제로는 13건이 깨진 단언이다 (§4.1) |

### 2.3 낡은 기록 — 믿지 말 것

`docs/plan/2026-09-01.remaining-work-backlog.plan.md` 는 생성된 뒤 한 번도 갱신되지 않았다. 아래 항목은 그 문서가 남았다고 적지만 **실제로는 해소되었다.**

| 문서가 적은 것 | 실제 |
|---|---|
| A1~A4 | 그 문서를 만든 커밋 `80b523c` 가 같은 커밋에서 전부 고쳤다 |
| C1 (boundary-gate 공허 통과) | 해당 파일이 저장소에 없다. 커밋 `2a20b4f`(2026-09-03)가 제거 |
| C3 (`dist/` 전용 회귀 테스트) | 커밋 `2208d3b`(2026-09-02)가 `src/` 전용으로 바꿨다. 38건 전부 통과 |
| **B1 (서버 러너 21건 red)** | **지금 532건 전부 통과한다.** 언제 고쳐졌는지는 추적하지 않았다 |

`CLAUDE.md` 의 낡은 수치 둘(frontend unit 파일 수, `✖` 목록 대조 지시)은 §9.7·§9.3 이 올바른 값을 갖는다. **`CLAUDE.md` 는 고치지 말 것** — 사용자 결정 사항이다.

---

## §3. 갈래 A — S5-c0 ACK 도메인 전환

### 3.1 A-0. 결정 두 개 — 코드를 쓰기 전에

**이 단계를 건너뛰면 A-1 에서 반드시 막힌다.** `sourceSeq` 를 필수로 만들면 모든 enqueue 호출부가 값을 대야 하는데, 저하 경로 둘은 지금 그 값을 **가질 방법이 없다.**

#### 결정 1 — `PendingHeadlessOutput` 의 ordinal 필드

현재 인터페이스는 `SessionManager.ts:399-414` 이고 필드 14개를 갖지만 **ordinal 계열이 하나도 없다.**

```
id, data, byteLength, queuedAt, queued, policyGeneration?, exactlyOnceKey?,
expiresAt?, ready?, recoveryGeneration?, policyAdmissionMode?,
retainedSemanticData?, terminalAuthorityRecordId?, ingestOwnerToken?
```

`SessionManager.ts:7883` 이 flush 된 출력을 `wsRouter.routeSessionOutput` 으로 넘길 때 넘기는 것은 `screenSeq` 와 `OutputAuthorityMetadata`(`WsRouter.ts:244`, 필드는 `authorityEpoch?`·`authorityRevision?` 둘뿐)다. 세션 스코프 ordinal 은 그 경로 어디에도 없다.

**결정할 것**: 예약 ordinal 을 어느 시점에 발급해 어느 필드에 담을 것인가.

**권장안**: `PendingHeadlessOutput` 에 `reservedSourceSeq?: string` 을 추가하고, **큐에 넣는 시점**에 발급한다. flush 시점에 발급하면 큐 순서와 ordinal 순서가 어긋나기 때문이다.

#### 결정 2 — dataGap 의 ordinal

`WsRouter.ts:5280` 의 dataGap enqueue 는 **대응하는 세션 출력이 없다.** 유실을 알리는 통지이므로 "그 출력의 ordinal" 이라는 것이 존재하지 않는다.

| 안 | 내용 | 문제 |
|---|---|---|
| (a) | 직전 출력의 ordinal 을 재사용 | ordinal 이 중복된다. ACK 판별이 깨진다 |
| (b) | 다음 출력의 ordinal 을 미리 소비 | gap 통지가 아직 안 온 출력의 자리를 차지한다 |
| (c) | dataGap 에는 `sourceSeq` 를 주지 않는다 | `sourceSeq` 를 필수로 만들 수 없다 |

**권장안은 (c) 다.** 그 결과 `sourceSeq` 는 필수가 아니라 판별 유니온의 한 갈래가 된다. 즉 **A-1(§3.2)의 범위가 "모든 enqueue 에 `sourceSeq` 를 요구"에서 "`sourceSeq` 를 선택 필드로 싣고 다니는 것"으로 축소되고**, 판별의 책임은 A-2(§3.3)의 `acknowledge` 유니온으로 넘어간다. 착수 전 §3.3 을 함께 읽을 것.

#### 결정 기록

A-0 를 마치면 아래 두 줄을 이 문서 또는 작업 브랜치의 커밋 메시지에 **값으로** 적는다. 문장이 아니라 값이어야 A-1 이 그것과 일치하는지 대조할 수 있다.

```
결정 1: PendingHeadlessOutput 에 추가할 필드명 = ____________, 발급 시점 = 큐 삽입 / flush
결정 2: 선택지 = (a) / (b) / (c)
```

**When/Then**

| When | Then |
|---|---|
| A-0 를 마쳤을 때 | 위 "결정 기록" 두 줄이 값으로 채워져 있고, A-1 의 타입 변경이 그 값과 일치한다 |
| 결정 2 에서 (c) 를 골랐을 때 | `sourceSeq` 는 **선택 필드**가 되고, 판별은 "값이 있는가"가 아니라 **`kind` 로** 한다 |
| 결정 없이 A-1 에 들어갔을 때 | §9.12 의 `tsc --noEmit` 가 실패한다. **그 상태를 커밋하지 말 것** |

### 3.2 A-1. `sourceSeq` 를 delivery 에 부착 (작업 #2)

**대상**: `server/src/ws/wsSendPolicy.ts` 의 `FairTerminalDeliveryInput`(`:541`) / `FairTerminalDelivery`(`:557`)

**선행**: A-0 결정 둘

**TDD 순서**

1. `server/src/ws/FairTerminalDeliveryScheduler.test.ts` 에 실패 테스트를 먼저 쓴다
2. red 를 확인한다 (§9.2)
3. 최소 구현으로 green 을 만든다
4. §9.1·§9.2 를 다시 돌려 회귀를 본다

⚠️ **A-1 시작 직전에 §9.1·§9.2 의 실패 테스트 이름 집합을 기준선으로 기록해 둔다.** A-1~A-4 구간에는 핀이 깨져 있어(§8.1) 무관한 red 가 섞인다. 그 구간의 회귀 판정은 **"실패 이름 집합이 기준선보다 늘지 않았는가"로만** 하고, 절대 건수로 판정하지 않는다. 절대 green 은 A-5(핀 재발행) 이후에 다시 확인한다.

**When/Then**

| When | Then |
|---|---|
| `sourceSeq` 를 담은 delivery 를 enqueue 하면 | enqueue 에 넣은 문자열과 전송 메시지에서 읽은 값이 `assert.strictEqual` 로 같다. 값이 같아도 재생성이 있으면 통과하므로, **그 값이 대입되는 지점이 하나뿐임을 grep 으로 함께 확인**한다 |
| lane 이 재생성되어 `deliverySeq` 가 1 로 리셋되면 | `sourceSeq` 는 **리셋되지 않는다**. 세션 스코프이기 때문이다 |
| 저하 경로 출력(dataGap 등)을 enqueue 하면 | A-0 결정 2 의 선택에 따라 동작한다. (c) 를 골랐다면 `sourceSeq` 없이 통과해야 하고, 그때 오류가 나면 안 된다 |
| 정규가 아닌 ordinal 문자열(`"01"`·`"-1"`·`"1.0"`·`""`)을 주면 | 사이드카에 실리지 않는다. `wsSendPolicy.ts:103` 의 `CANONICAL_ORDINAL64`(`/^(0\|[1-9][0-9]*)$/u`)와 `:113` 의 판정 함수가 이미 그 계약을 갖고 있으니 **같은 판정을 재사용**한다 |

### 3.3 A-2. `acknowledge` 판별 유니온 (작업 #3)

**대상**: `server/src/ws/wsSendPolicy.ts:871-887`

현재 시그니처(`:871`, 실제로는 한 줄):

```ts
acknowledge(input: {
  connectionEpoch: string;
  sessionId: string;
  deliverySeq: number;
  clientBytes?: number;
})
```

가드 순서. **이 순서를 바꾸지 말 것** — 오류 코드가 달라진다.

| 줄 | 가드 |
|---|---|
| 874 | `ACK_UNKNOWN_LANE` / `ACK_STALE_EPOCH` |
| 876 | 해제된 lane → `ACK_STALE_EPOCH` |
| 877 | `ACK_DUPLICATE` |
| **878** | **`ACK_OVER_ACK`** — 천장 `lane.nextDeliverySeq - 1` |
| 879 | `ACK_OUT_OF_ORDER` |
| 880-881 | 크레딧 계산 (`delivery.encodedBytes`) |

**주의**: `clientBytes` 는 시그니처에 있지만 **파일 전체에서 `:871` 단 한 번만 등장한다.** 본문에서 읽히지 않는다. 크레딧은 오직 `encodedBytes` 에서 온다. 이 작업에서 `clientBytes` 를 근거로 무엇을 계산하면 안 된다.

**When/Then**

| When | Then |
|---|---|
| `deliverySeq` 갈래로 ACK 하면 | 기존과 완전히 같게 동작한다. 오류 코드도 크레딧도 변하지 않는다 |
| `sourceSeq` 갈래로 ACK 하면 | 그 ordinal 이 가리키는 delivery 를 찾아 크레딧을 반환한다 |
| 두 갈래를 동시에 담아 보내면 | 타입 수준에서 막힌다(판별 유니온). 런타임 입력(파서 경유)이라면 `recordError('ACK_DOMAIN_CONFLICT', …)` 를 반환하고, 이 검사는 기존 가드보다 **앞**에 둔다(874~881 의 순서는 그대로) |
| 어느 갈래도 없이 보내면 | `recordError('ACK_DOMAIN_MISSING', …)` 를 반환한다. 위와 같은 위치 |
| 두 신규 코드를 추가할 때 | 오류 코드 유니온에 더하되 **기존 5개 코드의 문자열과 순서는 바꾸지 않는다** |

### 3.4 A-3. `ACK_OVER_ACK` 천장 전환 (작업 #3b)

**이것이 이 갈래에서 가장 조용히 깨지는 자리다.** SSOT 작업표에 없다.

**대상**: `server/src/ws/wsSendPolicy.ts:878`

```ts
if (input.deliverySeq > lane.nextDeliverySeq - 1) return recordError('ACK_OVER_ACK', ...);
```

천장 `lane.nextDeliverySeq - 1` 은 **lane 도메인**의 값이다. ACK 가 `sourceSeq` 갈래로 들어오는데 천장만 lane 도메인에 남으면, 두 수를 비교하는 것 자체가 무의미해진다.

**증상**: 모든 정상 ACK 가 `ACK_OVER_ACK` 으로 거절된다 → 크레딧이 반환되지 않는다 → `ackTimeoutMs` fallback 이 상시 발동한다. **테스트가 없으면 이 상태가 green 으로 보인다.**

**When/Then**

| When | Then |
|---|---|
| `sourceSeq` 갈래로 정상 범위의 ACK 를 보내면 | 통과한다. `ACK_OVER_ACK` 이 나오면 **실패**다 |
| `sourceSeq` 갈래로 아직 보내지 않은 ordinal 을 ACK 하면 | `ACK_OVER_ACK` 이 난다 |
| `deliverySeq` 갈래로 아직 보내지 않은 seq 를 ACK 하면 | 기존과 같이 `ACK_OVER_ACK` 이 난다 |
| A-3 을 건너뛰고 A-2 만 했을 때 | 위 첫 행이 실패해야 한다. **그 실패를 재현하는 테스트를 A-3 착수 전에 먼저 쓴다** |

#### 경계 대조군 (필수) — 순서를 지킬 것

핀 파일을 건드리면 capability 게이트가 닫혀 무관한 red 가 섞인다(§8.2). 그래서 **무해 뮤턴트(대조군)를 먼저 넣어 기준 red 집합을 확보한 뒤** 진짜 뮤턴트를 넣는다. 이 순서를 지키지 않으면 판정이 그 자체로 폐기 대상이 된다.

1. **기준선** — 아무것도 고치지 않은 상태에서 §9.2 를 돌려 실패 테스트 **이름 집합** `S0` 를 기록한다
2. **대조 뮤턴트** — `wsSendPolicy.ts` 에 동작과 무관한 변경(주석 한 줄)을 넣고 §9.2 → 실패 이름 집합 `S1`. **`S1 \ S0` 가 "핀이 깨져서 나는 red"** 이며, 이 집합은 뮤턴트 판정에서 제외한다
3. **원복** — 스크래치 백업본을 복사해 되돌리고(§8.6) sha256 으로 대조한다
4. **진짜 뮤턴트** — `:878` 의 천장을 lane 도메인으로 되돌리고 §9.2 → `S2`
   - **판정**: `S2 \ S1` 에 A-3 에서 새로 쓴 테스트 이름이 들어 있어야 **KILLED** 다
   - `S2 == S1` 이면 그 테스트는 천장을 검사하지 않는 것이다. 테스트를 고친다
5. **원복 + sha256 대조**

### 3.5 A-4. 와이어 메시지 변형 (작업 #4)

**대상**: 두 파일을 **함께** 고친다. 한쪽만 고치면 조용히 어긋난다.

| 위치 | 현재 |
|---|---|
| `server/src/types/ws-protocol.ts:437-442` | `TerminalDeliveryAckMessage` |
| `server/src/types/ws-protocol.ts:494-505` | `parseTerminalDeliveryAckMessage` (닫는 `}` 는 506) |
| `server/src/types/ws-protocol.ts:555` | 유니온 멤버 |
| `frontend/src/types/ws-protocol.ts:507-512` | 서버와 **바이트 단위로 같은 형태** |
| `frontend/src/types/ws-protocol.ts:555-566` | 파서 (닫는 `}` 는 567) |
| `frontend/src/types/ws-protocol.ts:632` | 유니온 멤버 |

**거절 메시지의 비대칭**: 프론트엔드는 `:514-520` 에 named interface `TerminalDeliveryAckRejectedMessage` 를 갖는다. 서버에도 같은 개념이 있으나 **named interface 가 아니라 인라인 유니온 멤버**다 — `server/src/types/ws-protocol.ts:762` 의 `'terminal-delivery:ack-rejected'` 이고, `WsRouter.ts:2037`·`:2049`·`:2059`·`:2070` 에서 방출된다. 구조는 같고 이름만 없다. A-4 에서 거절 경로를 건드린다면 이 비대칭을 함께 정리할지 정한다.

**When/Then**

| When | Then |
|---|---|
| 새 형태의 ACK 메시지를 파서에 넣으면 | 두 갈래를 모두 파싱한다 |
| 옛 형태(`deliverySeq` 만)의 ACK 를 넣으면 | 그대로 파싱된다. **하위 호환이 깨지면 실패**다 |
| 서버 파서와 프론트 파서에 같은 입력을 넣으면 | 같은 결과가 나온다 |
| 양쪽 파일의 형태가 어긋나면 | 이것을 잡는 테스트가 없다. **A-4 에서 `server/src/types/wsProtocolParityAck.test.ts` 를 새로 쓴다.** import 대신 `fs.readFileSync` 로 `../../../frontend/src/types/ws-protocol.ts` 를 읽어 대상 인터페이스 블록을 정규화 비교한다(§8.3 의 소스 텍스트 계약 테스트와 같은 방식). **앵커를 못 찾으면 `assert.fail` 로 즉시 red** — 창을 못 찾아 공허해지지 않게 한다. 실행은 cwd=`server` 에서 `npx tsx --test src/types/wsProtocolParityAck.test.ts` |

### 3.6 A-5. 핀 재발행과 커밋

`wsSendPolicy.ts` 와 `WsRouter.ts` 는 **둘 다 fair-scheduler provenance 핀 파일**이다. 저장하는 순간 스케줄러가 조용히 꺼진다.

핀 파일 6개 (`server/tools/write-fair-scheduler-source-provenance.mjs:7-14`, 전부 `server/` 기준 상대경로):

1. `src/benchmarks/terminalFairnessCharacterization.ts`
2. `src/benchmarks/fairSchedulerAuthorityLocator.ts`
3. **`src/ws/wsSendPolicy.ts`**
4. **`src/ws/WsRouter.ts`**
5. `src/services/TerminalResourcePolicy.ts`
6. `src/services/TerminalResourcePolicyCanary.ts`

**갈래 A 가 수정하는 것은 3·4 뿐이다.** 나머지 넷을 건드리면 A-5 의 범위가 커진다.

**재발행 절차는 §9.8 이다. 순서를 지킬 것** — provenance writer 만 단독으로 돌리면 실패가 1건에서 2건으로 늘어난다.

**When/Then**

| When | Then |
|---|---|
| 핀 파일을 고치고 재발행하지 않으면 | capability 게이트가 닫혀 무관한 스펙이 빨개진다 |
| 재발행 후 새 generation 디렉터리를 커밋하지 않으면 | `write-fair-scheduler-evidence-bundle.mjs` 가 대상을 못 찾아 **server build 가 깨진다**. 그러면 테스트 명령·로컬 빌드·릴리스 빌드·CI 가 전부 깨진다 |
| 재발행 후 `npm run build` 가 통과하면 | 핀이 맞춰진 것이다 |

---

## §4. 갈래 B — 회귀 스위트 복구

### 4.1 B-1. `WsRouterSplitHandshake.test.ts` (백로그 C2)

**현재**: tests 28 / pass 14 / fail 0 / **todo 14**, exit 0.

todo 로 표시된 14건 중 **13건이 실제로 assertion 이 깨진 채** `✖ failing tests:` 절에 찍힌다. **exit code 가 0 이므로 CI 도 사람도 이것을 red 로 보지 못한다.** 나중에 진짜 green 이 되어도 exit code 는 그대로 0 이다.

실패 표본: `0 !== 1` (`:887`, `assert.equal(rerouted.length, 1)`), `undefined !== 'fallback'` (`:934`, `assert.equal(initialSnapshot?.mode, 'fallback')`).

성격 분해:

| 유형 | 건수 |
|---|---|
| 깨진 단언 (`ERR_ASSERTION`) | 11 |
| `TypeError` — `router.isValidSplitOutputPair is not a function` | 1 |
| `ZodError` — 생성자 구성 거부 | 1 |
| **실패 계** | **13** |

나머지 1건은 `WsRouter split control connection returns group metadata and pair token` 으로, **todo 로 표시되어 있으나 실제로는 통과한다.**

**When/Then**

| When | Then |
|---|---|
| 14건을 todo 로 두는 한 | exit code 는 영원히 0 이다. **먼저 이 성질을 없앤다** |
| todo 를 걷어내고 스위트를 돌리면 | exit code 가 0 이 아니어야 한다. 그것이 이 작업의 첫 green 이다 |
| `TypeError` 1건을 고치려면 | `router.isValidSplitOutputPair` 를 구현해야 한다. 그것을 부르는 실패 테스트가 이미 있으므로 TDD 의 red 는 확보되어 있다 |
| `ZodError` 1건 | 생성자 구성 자체가 거부된다. 구성이 유효해야 하는지, 거부가 맞는지부터 판정한다 |
| 깨진 단언 11건 | 11건 중 10건이 `Wave-1 production unified limitation characterization` 태그이고, `split reroutes queued output to control when output socket closes` 1건만 `Wave-3 split client-group routing (REL-BGSTAB-008 AC-10)` 태그다. **제품이 틀린 것인지 단언이 낡은 것인지 먼저 판정**하고, 후자면 단언을 고치되 근거를 커밋 메시지에 남긴다 |

### 4.2 B-2. `busy-agent-workspace-bounce.spec.ts` (백로그 C4)

`frontend/tests/e2e/busy-agent-workspace-bounce.spec.ts` 가 타이밍에 취약해 10회 중 1회 배너 미출력으로 실패한다 (`docs/plan/2026-09-01.remaining-work-backlog.plan.md:84` 기재, ⚠️ 미검증 — 재현하지 않았다).

**실행은 §9.11 이다.**

**When/Then**

| When | Then |
|---|---|
| §9.11 로 10회 반복하면 | 10회 전부 통과해야 한다 |
| 고치기 전에 10회를 돌리면 | 최소 1회 실패해야 한다. 실패하지 않으면 **재현 조건부터 찾는다.** 재현 없이 "고쳤다"고 하지 말 것 |
| 대기를 고정 시간(`waitForTimeout`)으로 늘려 통과시키면 | 그것은 수정이 아니다. **조건 대기**(`expect(...).toPass()` 또는 상태 폴링)로 바꾼다 |

⚠️ E2E 를 돌리기 전에 §8.4 를 읽을 것 — 장시간 dev 인스턴스가 무관한 spec 을 빨갛게 만든다.

### 4.3 B-3. 광역 `node:test` (백로그 B4)

백로그(`:73`)는 25건 red 라고 적지만 ⚠️ **미검증**이다. 서버 모놀리식 러너가 이미 전부 green 이 된 것처럼, 이것도 이미 줄었을 수 있다.

**When/Then**

| When | Then |
|---|---|
| 착수 전에 §9.4 를 한 번 돌리면 | 지금의 실제 red 목록이 나온다. **백로그의 25 라는 수를 출발점으로 삼지 말 것** |
| 실행 후 출력의 `# tests` 합계가 0 이면 | glob 이 확장되지 않은 것이다(§9 머리말). 결과가 공허하다 |
| 실패가 부하성 flake 인지 판정하려면 | 그 파일만 단독으로 다시 돌린다. 단독으로 green 이면 flake 다 |
| flake 를 고치려면 | 병렬 실행에서 프로세스를 띄우는 테스트가 서로를 밀어낸다. 그 파일을 순차 실행 대상으로 분리하거나 타임아웃 예산을 늘린다 |

---

## §5. 갈래 C — 설정 정리 (GitHub 이슈)

이슈 본문 확인: `gh issue view <번호> -R Snoworca/BuilderGate`. 이 절과 이슈 본문이 어긋나면 **이 문서를 우선**하고, 어긋난 사실을 사용자에게 보고한다.

### 5.1 C-1. 죽은 설정 13개 제거 (이슈 #32)

| 필드 | 정의 |
|---|---|
| `logging.level`·`audit`·`directory`·`maxSize`·`maxFiles` | `config.schema.ts:36-42` |
| `bruteForce.rateLimit.windowMs`·`maxRequests` | `:246`·`:247` (조립은 `:256-259`) |
| `bruteForce.lockout.maxAttempts`·`lockoutDurationMs`·`progressiveDelay` | `:251`·`:252`·`:253` |
| `auth.maxDurationMs` | `:236` |
| `fileManager.maxCodeFileSize` | `:267` |
| `resourceLimits.telemetry.sampleIntervalMs` | `:189` |

**함께 지워야 하는 자리**

| 파일 | 줄 | 내용 |
|---|---|---|
| `server/src/schemas/config.schema.ts` | 36-42, 256-259, 299, 303 | 스키마 정의와 조립 (`logging`·`bruteForce` 는 각각 `.optional()`) |
| `server/src/types/config.types.ts` | 52-63, 237-240, 268, 272 | 타입 정의와 `Config` 멤버 |
| `server/src/utils/configTemplate.ts` | 119-125 | 신규 config 에 기록되는 logging 블록 |
| `server/src/services/RuntimeConfigStore.ts` | 62-70 | `EXCLUDED_SECTIONS` 의 대응 항목 |

`EXCLUDED_SECTIONS` 전문:

```ts
const EXCLUDED_SECTIONS = [
  'server.port',
  'ssl.*',
  'logging.*',
  'auth.maxDurationMs',
  'auth.jwtSecret',
  'fileManager.maxCodeFileSize',
  'bruteForce.*',
] as const;
```

**제거 대상은 `logging.*`·`auth.maxDurationMs`·`fileManager.maxCodeFileSize`·`bruteForce.*` 넷**이다. `server.port`·`ssl.*`·`auth.jwtSecret` 은 살아 있으므로 남긴다.

**기존 테스트**: `server/src/schemas/config.schema.test.ts` (14건, 전부 green). `grep -ci "logging\|bruteforce"` 가 **0** 이다 — 그 둘을 건드리는 테스트가 하나도 없으므로 이 작업의 red 는 새로 써야 한다.

**When/Then**

| When | Then |
|---|---|
| 제거 전에 `logging` 키를 담은 config 를 파싱하면 | 파싱된다 (`.optional()` 이므로 통과) |
| 제거 **후**에 같은 config 를 파싱하면 | zod 가 unknown key 를 strip 하므로 **여전히 파싱된다.** 오류가 나면 안 된다 — 기존 사용자의 `config.json5` 가 깨지기 때문이다. 이것을 단언하는 테스트를 쓴다 |
| 제거 후 `configTemplate` 으로 새 config 를 만들면 | logging 블록이 없다 |
| 제거 후 `RuntimeConfigStore` 를 초기화하면 | 제거한 네 항목이 `EXCLUDED_SECTIONS` 에 없다. 남은 셋은 그대로 있다 |
| 제거 후 §9.1·§9.6 을 돌리면 | 전부 green |

**주의**: `fileManager.maxCodeFileSize` 를 지울 때 형제 `maxFileSize` 를 건드리지 말 것. 그쪽은 `FileService.ts:230` 에서 `if (stat.size > this.config.maxFileSize)` 로 실제 분기한다.

### 5.2 C-2. `workspace` 두 필드 (이슈 #33)

`WorkspaceService.ts:120`(`?? 250`)·`:122`(`?? 600`)가 `wsConfig?.` 로 읽지만 `workspaceSchema`(`config.schema.ts:278-284`)에 없다. 그 스키마의 다섯 필드는 `dataPath`·`maxWorkspaces`·`maxTabsPerWorkspace`·`maxTotalSessions`·`flushDebounceMs` 다. zod 가 strip 하므로 값이 도달할 수 없다.

| 안 | 내용 |
|---|---|
| (a) | 스키마에 두 필드를 추가한다. 설정 가능해진다 |
| (b) | 읽는 코드에서 `wsConfig?.` 갈래를 지운다. `options.` 경로만 남는다 |

**권장은 (a)** 다. 읽는 코드가 있다는 것은 설정하려던 의도가 있었다는 뜻이고, (b) 는 그 의도를 소리 없이 없앤다.

**When/Then — (a) 를 골랐을 때**

| When | Then |
|---|---|
| `config.json5` 의 `workspace` 에 `terminalTitleDebounceMs: 400` 을 넣으면 | `WorkspaceService` 가 400 을 쓴다. 250 이 나오면 실패 |
| 그 키를 넣지 않으면 | 기본값 250 을 쓴다 |
| `restoreInputDelayMs` 도 같은 방식으로 | 기본값 600 |
| 범위를 벗어난 값을 넣으면 | 스키마가 거절한다. **범위는 `terminalTitleDebounceMs: z.number().int().min(0).max(5000).default(250)`, `restoreInputDelayMs: z.number().int().min(0).max(10000).default(600)` 으로 고정한다.** 다른 범위를 쓰려면 사용자에게 먼저 묻는다 |

### 5.3 C-3. `App.tsx` 하드코딩 한도 (이슈 #34)

| 위치 | 코드 | 대상 컴포넌트 |
|---|---|---|
| `frontend/src/App.tsx:561` | `maxWorkspaces={10}` | `<WorkspaceSidebar>` (JSX 시작 `:557`) |
| `frontend/src/App.tsx:746` | `maxTabsPerWorkspace={8}` | `<WorkspaceMoveDialog>` (JSX 시작 `:741`) |

서버는 `WorkspaceService.ts:446`·`:552`·`:698` 에서 실제로 강제한다(세 줄 모두 `>= this.config.max…` 후 `AppError` throw). 스키마 범위는 `maxWorkspaces` 1~50(`:280`), `maxTabsPerWorkspace` 1~16(`:281`)이므로 **드리프트 폭이 실재한다.**

⚠️ **중요**: 서버의 공개 설정 스냅샷에 이 두 값이 **없다.** `getPublicRuntimeConfig`(`RuntimeConfigStore.ts:279-294`)가 내려주는 것은 `inputReliabilityMode`·`wsTransportMode`·`terminalWireFormat`·`stabilityModes.frontendRuntimeResidency`·`resourceLimits.{clientWs, terminal, snapshots, workspaceRuntime}` 뿐이다. 어느 라우트도 노출하지 않는다(`grep -rn "maxWorkspaces\|maxTabsPerWorkspace" server/src/routes/` 무출력).

가장 가까운 `resourceLimits.workspaceRuntime` 은 **다른 축**이다. 그것은 live/hydrated 런타임 거주 한도이고, 여기서 필요한 것은 영속 워크스페이스·탭 상한이다. **혼동하지 말 것.**

즉 이 작업은 UI 만 고치는 것이 아니라 **값을 내려보내는 경로를 새로 만드는 것**이다.

**When/Then**

| When | Then |
|---|---|
| `config.json5` 에서 `maxWorkspaces` 를 3 으로 낮추면 | UI 가 3에서 막는다. 10 까지 허용하면 실패 |
| `maxWorkspaces` 를 20 으로 올리면 | UI 가 20 까지 허용한다 |
| 서버가 값을 아직 안 내려준 시점(초기 로딩)이면 | **기본값(`maxWorkspaces=10`·`maxTabsPerWorkspace=8`)으로 동작하고, 값이 도착하면 즉시 반영한다. 조작을 잠그지 않는다.** 이것을 권장안으로 확정하며, 다른 선택을 하려면 사용자에게 묻는다 |
| 두 한도를 공개 스냅샷에 추가했다면 | 이미 공개되는 `resourceLimits.*` 와 같은 등급(비밀 아님)임을 근거로 기록한다 |

### 5.4 C-4. `recentEventLimit` capability 사유 (이슈 #35)

`RuntimeConfigStore.ts:135-140` 의 `UNAVAILABLE_SETTING_PREFIX_REASONS` 가 `resourceLimits.telemetry.` 접두사 전체에 "not applied by the current runtime" 을 붙이지만, `recentEventLimit` 은 `:250`·`:409` 에서 `capacity: this.values.resourceLimits.telemetry.recentEventLimit` 로 **실제 적용된다.**

**C-1 을 먼저 하면 이 작업이 간단해진다.**

**When/Then**

| When | Then |
|---|---|
| C-1 에서 `sampleIntervalMs` 를 지웠다면 | `resourceLimits.telemetry.` 접두사가 덮는 필드가 `recentEventLimit` 하나만 남는다. 그 하나는 실제로 적용되므로 **접두사 항목을 삭제**하는 것이 올바른 처리이고, 필드 단위로 쪼갤 필요가 없어진다 |
| 삭제 후 확인하면 | `grep -n "resourceLimits\.telemetry\." server/src/services/RuntimeConfigStore.ts` 의 결과에 `UNAVAILABLE_SETTING_PREFIX_REASONS` 안의 항목이 0건이다 |
| UI 에서 `recentEventLimit` 을 바꾸면 | observer capacity 가 실제로 바뀐다 |

### 5.5 C-5. 백로그 문서 (이슈 #36)

**이 작업은 사용자 지시가 있을 때만 한다** (`CLAUDE.local.md` 규칙 1). 이슈 #36 은 낡았다는 사실의 기록이며, 자동으로 고치지 않는다.

---

## §6. 차단된 것 — 손대지 말 것

| 항목 | 선행 |
|---|---|
| `IR-BGSTAB-002` AC-2 | 데이터 평면 binary 경로의 와이어 배선. 사유가 `docs/spec/30.buildergate-stability.srs.md:5299` 에 기록 |
| `IR-BGSTAB-002` AC-4 | digest 버전을 고르는 capability 협상. `:5300`. `MIG-BGSTAB-002` 의 capability 표면 확장을 요구 |
| `MIG-BGSTAB-004` | `PERF-BGSTAB-011` 의 evidence bundle 채택 |
| D 그룹 S6·S7·C6 | S5 완료 |

---

## §7. 사용자 확인 대기 — 임의로 결정하지 말 것

| 항목 | 왜 물어야 하는가 |
|---|---|
| `admission-gate` 시간 예산 | closure 집합 게이트가 그 하나뿐이다. 예산을 바꾸는 것은 게이트의 의미를 바꾸는 일이다. ⚠️ 지금도 red 인지는 미검증 |
| `lexical.test.mjs:95` 합계 단언 | `tools/wave3/fair-readmission-closure-v3.lexical.test.mjs:95` 의 `assert.equal(dynamicEdges, 17, …)` 를 실질화할지 |
| 숨김 탭 스크롤백 유실 | ⚠️ 미검증 — frontend unit red 가 여기 묶여 있다고 알려져 있으나, 몇 건인지는 확인하지 못했다. 백로그(`plan.md:52`)는 frontend unit red 를 6건으로 적는다. 대응 관계를 확정하려면 §9.7 전량 실행이 필요하다 |
| SRS 진단 6건 — 당시 기록 | 이 수치는 역사적 관측이며 현재 잔여 진단 수가 아니다. 2026-09-09 MCP 3.0.0 재관측은 errors 0 / warnings 0 / `byCode={}`, links 671개 검사·broken 0이다. [현재 기준선](../report/2026-09-09.srs-diagnostic-baseline.md)과 `docs/research/binary-comms/04-srs-amendment-plan.md` §6의 현재 수동 증가 감시 기준을 사용한다. |

---

## §8. 함정 — 겪은 것만 적는다

### 8.1 핀 파일을 저장하는 순간 스케줄러가 꺼진다

provenance 는 `HEAD` 가 아니라 **워킹트리**를 읽는다(git 호출 0건). 커밋 순서를 바꿔서 피할 수 없다. §9.8 로 재발행한다.

### 8.2 핀 파일에서 뮤테이션 판정은 공허해진다

핀 소스를 건드리면 capability 게이트가 닫혀 **스펙이 뮤턴트와 무관하게 빨개진다.** 그 red 를 "뮤턴트를 죽였다"로 읽으면 안 된다. 대조 뮤턴트 없이 내린 판정은 폐기할 것 — 절차는 §3.4 의 5단계다.

### 8.3 소스 텍스트 계약 테스트가 식별자를 핀한다

`TerminalAuthorityController.test.ts`·`TerminalResourcePolicyCanary.test.ts`·`benchmarks/terminalFairnessCharacterization.test.ts`·`TerminalAuthorityProductionRegression.test.ts` 넷은 형제 `.ts` 원본을 읽어 계약을 단언한다. **이름·시그니처만 바꿔도 red 가 된다.** 그리고 `dist/` 로 돌리면 `.ts` 가 없어 `ENOENT` 로 깨진다 — 반드시 `src/` 로 돌린다.

### 8.4 장시간 dev 인스턴스가 E2E 를 오염시킨다

한 인스턴스로 ~90분 또는 15회를 넘기면 workspace API 가 500 을 낸다. **무관한 spec 이 제품 버그처럼 빨개지고**, 고아 워크스페이스가 다음 spec 까지 깨뜨린다. E2E 를 여러 번 돌 계획이면 중간에 인스턴스를 새로 띄운다.

### 8.5 `git commit` 범위는 `git add` 범위가 아니다

저장소를 여러 세션이 공유한다. `git add <경로>` 를 해도 `git commit` 은 인덱스 전체를 커밋해 **남의 스테이징을 쓸어간다.** 반드시 `git commit -- <경로>` 로 쓴다. `--` 뒤에는 경로만 오므로 메시지는 `-F <파일>` 로 준다.

### 8.6 워킹트리에 `git stash`·`git checkout`·`git reset` 금지

같은 이유다. 뮤턴트를 넣고 되돌릴 때는 **스크래치 백업 + sha256 대조**로 한다.

### 8.7 `npm install` 이 frontend 빌드를 깬다

`react-mosaic` 패치가 조용히 날아가 `tsc` 가 깨진다. 복구는 `npx patch-package`. prebuild 가드는 create 모드라 이것을 못 고친다.

### 8.8 `NODE_ENV=production` 이 devDependencies 를 조용히 누락시킨다

`env -u NODE_ENV npm ci` 로 실행한다. `| tail` 로 파이프하면 exit code 가 숨는다.

---

## §9. 테스트 실행 레퍼런스

모든 명령은 **Git Bash(POSIX sh)** 에서 실행한다. PowerShell 은 native 명령에 대해 와일드카드를 확장하지 않으므로 §9.4·§9.7 의 glob 이 **조용히 0건 수집으로 끝난다.** PowerShell 을 써야 하면 이렇게 바꾼다.

```powershell
# §9.4
npx tsx --test (Get-ChildItem src/services/*.test.ts,src/ws/*.test.ts,src/utils/*.test.ts | % FullName)
# §9.7
node --experimental-strip-types --test (Get-ChildItem tests/unit/*.test.ts | % FullName)
```

어느 쪽이든 실행 후 출력의 `# tests` 합계가 0 이 아님을 먼저 확인한다. 0 이면 glob 이 확장되지 않은 것이다.

**cwd 를 지킬 것.**

### 9.0 앵커 재측정 — `HEAD` 가 `8d3991d` 가 아닐 때

```
cd C:\Work\git\_Snoworca\ProjectMaster
grep -n "interface PendingHeadlessOutput" server/src/services/SessionManager.ts
grep -n "routeSessionOutput" server/src/services/SessionManager.ts
grep -n "acknowledge(input" server/src/ws/wsSendPolicy.ts
grep -n "ACK_OVER_ACK\|ACK_OUT_OF_ORDER\|ACK_DUPLICATE\|ACK_STALE_EPOCH\|isCanonicalOrdinal64" server/src/ws/wsSendPolicy.ts
grep -n "TerminalDeliveryAckMessage\|parseTerminalDeliveryAckMessage" server/src/types/ws-protocol.ts frontend/src/types/ws-protocol.ts
grep -n "EXCLUDED_SECTIONS\|UNAVAILABLE_SETTING_PREFIX_REASONS\|getPublicRuntimeConfig" server/src/services/RuntimeConfigStore.ts
grep -n "logging:\|bruteForce:\|maxCodeFileSize\|maxDurationMs\|sampleIntervalMs\|workspaceSchema" server/src/schemas/config.schema.ts
grep -n "maxWorkspaces=\|maxTabsPerWorkspace=" frontend/src/App.tsx
```

이 8개 grep 의 출력으로 §3·§5 의 줄 번호를 갱신한 뒤 착수한다. **심볼 자체가 사라졌다면 그 절의 전제가 무너진 것이므로 착수하지 말고 사용자에게 보고한다.**

### 9.1 서버 모놀리식 러너 — 532건

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npx tsx src/test-runner.ts
```

빌드를 타지 않는다. **단, `*.test.ts` 를 디스커버리하지 않으므로 이것만으로는 회귀 커버리지가 되지 않는다.**

현재: `532 test(s) passed`, exit 0 (2026-09-08 실측).

### 9.2 fair delivery 스케줄러 — 18건

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npx tsx --test src/ws/FairTerminalDeliveryScheduler.test.ts
```

현재: tests 18 / pass 18 / fail 0 / todo 0, exit 0 (2026-09-08 실측).

### 9.3 split handshake — 28건 중 14 todo

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npx tsx --test src/ws/WsRouterSplitHandshake.test.ts
```

현재: tests 28 / pass 14 / fail 0 / todo 14, **exit 0** (2026-09-08 실측).

**exit code 를 믿지 말 것.** 실패 항목을 세려면 출력에서 `⚠` 로 시작하는 줄을 센다(13항목이 2회 출력되어 26줄). `✖` 는 절 제목 하나뿐이다.

### 9.4 서버 광역 `node:test`

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npx tsx --test src/services/*.test.ts src/ws/*.test.ts src/utils/*.test.ts
```

⚠️ 미검증 — 이 문서 작성 시 돌리지 않았다. 부하에서 흔들린다(프로세스를 띄우는 10~24초 테스트가 병렬 실행 시 타임아웃).

### 9.5 소스 텍스트 계약 테스트 넷 — `src/` 전용

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npx tsx --test src/services/TerminalAuthorityController.test.ts
npx tsx --test src/services/TerminalResourcePolicyCanary.test.ts
npx tsx --test src/benchmarks/terminalFairnessCharacterization.test.ts
npx tsx --test src/services/TerminalAuthorityProductionRegression.test.ts
```

`dist/` 로 돌리면 `ENOENT` 로 깨진다 (§8.3).

### 9.6 설정 스키마 — 14건

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npx tsx --test src/schemas/config.schema.test.ts
```

현재: tests 14 / pass 14 / fail 0, exit 0 (2026-09-08 실측).

`logging`·`bruteForce` 를 건드리는 테스트가 하나도 없다. C-1 의 red 는 새로 써야 한다.

### 9.7 frontend

**unit 76개** (Playwright 가 수집하지 않는다):

```
cd C:\Work\git\_Snoworca\ProjectMaster\frontend
node --experimental-strip-types --test tests/unit/*.test.ts
```

전부 도는 npm 스크립트가 **없다.** `test:unit:command-management`(10개)·`test:unit:terminal-shortcuts`(2개)는 부분집합이다.

**E2E**:

```
cd C:\Work\git\_Snoworca\ProjectMaster\frontend
npx playwright test --project "Desktop Chrome"
```

project 를 지정하지 않으면 3종(`Desktop Chrome`·`Mobile Safari`·`Tablet`)을 전부 돌아 **31파일 468테스트**가 된다 (2026-09-08 `npx playwright test --list` 실측).

⚠️ `reuseExistingServer: true` 이므로 2222 에 서버가 떠 있으면 그것을 쓴다. `webServer` 는 `start.bat` 으로 **프로덕션 빌드**를 띄우므로, `dev.js` 가 떠 있는 상태로 돌리면 dev 번들을 검사하게 된다.

### 9.8 핀 재발행 — 순서를 지킬 것

**1단계. authority generation 재발행.** 프로덕션 CLI 가 없으므로 일회용 스크립트를 만든다.

⛔ **저장소 안에 두지 말 것.** `.scratch` 는 `.gitignore` 에 없다(`git check-ignore` 로 확인, 2026-09-08). 저장소 안에 만들면 §0.1 의 `git status` 에 `?? ` 로 뜨고, §8.5 의 "인덱스 전체 커밋" 함정과 겹쳐 스크래치 파일이 커밋에 섞인다. **세션 스크래치 디렉터리**(시스템 프롬프트가 알려주는 scratchpad 경로)에 만들고, import 는 아래처럼 **절대경로**로 쓴다.

```js
import { publishFairSchedulerAuthorityGeneration }
  from 'file:///C:/Work/git/_Snoworca/ProjectMaster/server/src/benchmarks/terminalFairnessCharacterization.ts';

await publishFairSchedulerAuthorityGeneration({
  authorityRoot: 'C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority',
  clients: [1, 2, 8],
  wanLatencyMs: 150,
  wanJitterMs: 20,
  wanLossPercent: 0,
  seed: 20260723,
  repeats: 5,
  samples: 30,
});
```

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
node node_modules/tsx/dist/cli.mjs <세션 스크래치>/republish.mjs
```

`<세션 스크래치>` 는 이 문서가 채울 수 없는 유일한 값이다 — 세션마다 다르기 때문이다. 시스템 프롬프트의 scratchpad 경로를 그대로 넣는다.

함수는 `server/src/benchmarks/terminalFairnessCharacterization.ts:2224` 에 `export async function` 으로 있고, 입력 타입은 `FairSchedulerAuthorityPublicationInput`(`:2141`) = `FairSchedulerBenchmarkInput`(`:21-29`) + `authorityRoot` 다. 위 인자 값은 현행 권위 생성의 workload 와 일치한다. **현행 generation 은 재발행마다 바뀌므로** 착수 직전에 `head -c 200 docs/analysis/terminal-fairness-authority/current.json` 으로 `generation_id` 를 다시 확인한다 (2026-09-08 기준 `2c8814a3…`).

⚠️ 위 호출 형태(단일 객체 인자·`await` 여부)는 미검증이다. 실행 전 `grep -n "export async function publishFairSchedulerAuthorityGeneration" -A 20 server/src/benchmarks/terminalFairnessCharacterization.ts` 로 시그니처를 확인하고 어긋나면 그것에 맞춘다.

**2단계. server build.** 이것이 provenance writer 와 evidence-bundle writer 를 순서대로 다시 돌린다.

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npm run build
```

⚠️ **1단계만 돌리면 실패가 1건에서 2건으로 는다** (`decision-artifact-source-digest-mismatch` 가 추가된다). 반드시 2단계까지 간다.

⚠️ **새 generation 디렉터리를 커밋해야 한다.** 디렉터리 이름은 sha256 이라 미리 알 수 없다. 재발행 직후 이렇게 확인한다.

```
cd C:\Work\git\_Snoworca\ProjectMaster
git status --porcelain docs/analysis/terminal-fairness-authority | cat
```

새로 생긴 `generations/<sha>/` 아래 경로들을 `git add` 한 뒤 §8.5 대로 `git commit -- docs/analysis/terminal-fairness-authority` 로 커밋한다. 작성 시점 실측은 디렉터리당 18개 파일이었으나 **그 수를 게이트로 쓰지 말고, `git status` 가 그 디렉터리에 대해 clean 해지는 것을 게이트로 쓴다.**

### 9.9 terminal resource consumer manifest 재봉인

**이 계획의 어느 작업도 이것을 요구하지 않는다.** 재봉인이 필요하다고 판단됐을 때만 쓰는 참고 절이다.

```
cd C:\Work\git\_Snoworca\ProjectMaster
node server/node_modules/tsx/dist/cli.mjs tools/wave3/terminal-resource-consumer-manifest-reseal.ts
```

플래그 없이 돌리면 **dry-run** 이다(바뀔 내용을 출력하고 아무것도 쓰지 않는다, exit 0). 실제로 쓰려면 `--reseal` 을 붙인다.

| 플래그 | 언제 |
|---|---|
| `--reseal` (`:342`) | 실제로 쓴다 |
| `--accept-decision-change` (`:280`) | 결정의 **집합**이 바뀌었을 때 (위치만 바뀐 것이 아닐 때) |
| `--rerun-differential` (`:363`) | `tools/wave3/terminal-resource-policy-differential.ts` 를 다시 실행해 그 증거 항목을 재해시 |

검증자는 **별도 파일**(`tools/wave3/terminal-resource-consumer-manifest.test.mjs`)이며 이 도구와 코드를 공유하지 않는다.

작성 시점(`HEAD=8d3991d`)에는 추적 파일 변경이 0건이었다 — 재봉인 잔여물이 없다.

### 9.10 dev 서버

```
cd C:\Work\git\_Snoworca\ProjectMaster
node dev.js --port 2222
```

**포트는 항상 2222** (프론트는 2223). health 는 `curl -k https://localhost:2222/health`. 비밀번호 1234.

⛔ **`kill {pid}` 와 `taskkill /F /IM node.exe` 절대 금지** — dev.js 가 hot reload 로 자동 재시작한다.

### 9.11 단일 E2E spec 10회 반복 (B-2)

```
cd C:\Work\git\_Snoworca\ProjectMaster\frontend
npx playwright test tests/e2e/busy-agent-workspace-bounce.spec.ts \
  --project "Desktop Chrome" --repeat-each=10 --workers=1 --reporter=list
```

⚠️ 10회를 한 인스턴스로 도는 것은 §8.4 의 오염 구간(15회 · ~90분)에 근접한다. 실패가 나오면 서버를 새로 띄우고 5회씩 두 번으로 나눠 재현성을 확인한다.

### 9.12 타입체크만

```
cd C:\Work\git\_Snoworca\ProjectMaster\server
npx tsc --noEmit
```

```
cd C:\Work\git\_Snoworca\ProjectMaster\frontend
npx tsc --noEmit
```

빌드를 타지 않으므로 핀 재발행이 필요 없다. A-0~A-4 구간에서 타입만 빠르게 보고 싶을 때 쓴다.

---

## §10. 완료 조건

각 갈래는 아래를 전부 만족할 때 끝난 것이다.

### 갈래 A

- [ ] §3.1 "결정 기록" 두 줄이 **값으로** 채워졌고, A-1 의 타입 변경이 그 값과 일치한다
- [ ] 새로 쓴 테스트 이름과 §3.2~§3.5 의 When/Then 행을 1:1 로 매핑한 표를 커밋 메시지 본문 또는 보고서에 적었고, **매핑되지 않은 When 행이 0** 이다
- [ ] §3.4 의 경계 대조군 5단계를 실제로 돌렸고, `S2 \ S1` 에 A-3 의 새 테스트 이름이 들어 있다
- [ ] `server/src/types/wsProtocolParityAck.test.ts` 가 있고 green 이며, 앵커 미발견 시 `assert.fail` 로 red 가 된다
- [ ] §9.8 재발행 후 `npm run build` 가 통과하고, `git status --porcelain docs/analysis/terminal-fairness-authority` 가 **빈 출력**이다
- [ ] §9.1·§9.2 가 green 이다 (핀 재발행 이후의 절대 green)
- [ ] `cd frontend && npx tsc --noEmit` 가 통과한다
- [ ] §9.7 unit 76개의 실패 이름 집합이 기준선보다 늘지 않았다

### 갈래 B

- [ ] `WsRouterSplitHandshake.test.ts` 의 todo 가 0 이고, 스위트가 **exit 0 으로 전건 통과**한다 (`tests 28 / pass 28 / fail 0 / todo 0`). 통과시킬 수 없는 항목이 남으면 완료로 보지 말고, 그 항목의 이름·실패 메시지·"제품이 틀림 / 단언이 낡음" 판정 근거를 사용자에게 보고한다. **단언을 약화시켜 green 을 만들지 않는다**
- [ ] §9.11 을 돌려 10회 전부 통과한다. 고정 시간 대기로 통과시키지 않았다
- [ ] §9.4 를 돌려 실제 red 목록을 확보했고(`# tests` 합계가 0 이 아님을 확인), 각 항목을 고쳤거나 flake 로 분류했다

### 갈래 C

- [ ] 13개 필드가 스키마·타입·템플릿·`EXCLUDED_SECTIONS` 네 곳에서 모두 사라졌고, 남은 셋(`server.port`·`ssl.*`·`auth.jwtSecret`)은 그대로다
- [ ] 옛 키가 남은 `config.json5` 가 여전히 파싱된다는 것을 단언하는 테스트가 있다
- [ ] `workspace` 두 필드가 (a) 또는 (b) 중 하나로 정리되었고, 그 동작을 단언하는 테스트가 있다
- [ ] `maxWorkspaces`·`maxTabsPerWorkspace` 가 서버에서 UI 로 흐르고, config 를 바꾸면 UI 한도가 따라간다
- [ ] `grep -n "resourceLimits\.telemetry\." server/src/services/RuntimeConfigStore.ts` 의 결과에 `UNAVAILABLE_SETTING_PREFIX_REASONS` 안의 항목이 0건이고, `recentEventLimit` 이 UI 설정 목록에 나타나는 것을 단언하는 테스트가 있다
- [ ] §9.1·§9.6 이 green 이다
- [ ] C-3 를 했다면 `cd frontend && npx tsc --noEmit` 통과 + §9.7 unit green, 그리고 그 동작을 확인하는 E2E 또는 unit 테스트가 있다

### 공통

- [ ] 각 갈래를 커밋하기 전에 **독립 서브에이전트**로 검증을 위임했다. 입력은 원본 요구(이 문서의 해당 절)와 `git diff` 뿐이며, 자신의 결론·정당화는 전달하지 않는다. 최소 2축 — (1) 의도 일치·회귀 "이 diff 가 §X 의 When/Then 을 전부 만족하는가", (2) 테스트 강도 "새 테스트가 공허하지 않은가(뮤턴트로 확인)"
- [ ] 서브에이전트가 사실 오류를 지적하면 자체 판단보다 재확인을 우선했다
- [ ] 커밋 단위는 **작업 1개(A-1, A-2, … C-4)당 1커밋**이다. 핀 재발행(A-5)은 별도 커밋으로 분리하되 A-4 커밋 직후에 둔다
- [ ] 브랜치는 `work/mcp-session-orchestration-20260709` 그대로다. 새 브랜치를 만들지 않고, 사용자가 지시하지 않는 한 push 하지 않는다
- [ ] 메시지는 **세션 스크래치 디렉터리**(시스템 프롬프트의 scratchpad 경로)의 `commit-msg.txt` 에 쓰고 `git commit -F <세션 스크래치>/commit-msg.txt -- <경로들>` 로 커밋한다. 저장소 안에 메시지 파일을 만들지 않는다 — `.gitignore` 가 그것을 막아주지 않는다
- [ ] 커밋 메시지에 시그니처가 0건이다 (`git log -1 --format="%B"` 로 확인)
- [ ] 커밋 제목에 `Phase {n}`·`Step {n}`·`TASK-XXX` 가 없다
- [ ] 작업 로그를 남겼다 — `node tools/worklog.mjs add --request "…" --analysis "…" --solution "…" --files "a.ts,b.ts" --commit "<sha> <제목>"`
- [ ] 갈래별 수정 완료 보고서를 `docs/report/2026-09-XX.{갈래}-{제목}.md` 에 작성했다 (스킬이 자체 보고서를 생성하는 경우는 제외)
- [ ] 보고서와 로그를 서브에이전트가 검증했다
