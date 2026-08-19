# 바이너리 데이터 플레인 — 프레임 포맷과 버전 협상

| 항목 | 값 |
|---|---|
| 문서 지위 | 구현 가능 사양 (implementable spec). 상위 결정은 `docs/research/binary-comms/00-decision-record.md` |
| 선행 문서 | `00-decision-record.md`, `docs/issues/wave4-wave5/19-binary-data-plane.md` |
| 작성일 | 2026-08-16 |
| 범위 | 프레임 포맷 확정안 / 버전 협상 / 혼합 버전 안전성 / 롤백 / split 소켓 상호작용 |
| 범위 밖 | 성능 측정 계획, SRS 개정 조문(`04-srs-amendment-plan.md` 소관), 구현 일정 |

라벨 규약: `[설계결정]` = 이 문서가 내린 판단. `[미확인]` = 코드로 확인하지 못했거나 실측이 필요한 것. `[추측]` = 코드에서 읽히지만 런타임으로 재현하지 못한 추론. 그 외 서술은 전부 `file:line` 근거를 가진 관측 사실이다.

---

## 0. 요약 — 초안 대비 무엇이 바뀌었나

이슈 원문의 초안 프레임은 다음과 같았다 (`docs/issues/wave4-wave5/19-binary-data-plane.md:77`).

```
[opcode 1B][channelId 4B][streamEpoch 4B][sourceSeq 8B][length 4B][payload]   (= 21B)
```

조사 결과 이 초안은 **세 곳에서 저장소의 기존 계약과 충돌하거나 요구를 충족하지 못한다.**

| # | 초안 | 문제 | 확정안 |
|---|---|---|---|
| 1 | `streamEpoch 4B` | `streamEpoch` 는 Ordinal64 = **unsigned 64-bit** 이다 (`server/src/types/ws-protocol.ts:22`, `:961`). 구현 `advanceRetainedTerminalOrdinal` 은 streamEpoch 를 `ORDINAL64_MAX`(2^64-1) 까지 증가시키고 그 지점에서 exhaustion 을 throw 한다 (`server/src/types/ws-protocol.ts:999-1002`). 4B 는 계약 위반이며 `:1000` 의 exhaustion 검사를 무의미하게 만든다 | **`streamEpoch 8B`** |
| 2 | 버전 필드 없음 | 결정 기록과 이슈 AC 가 요구하는 것은 "**versioned** binary frame" 이고 "해석 불가 프레임의 silent drop 금지" 다 (`00-decision-record.md:15`, `:79`). 프레임에 버전이 없으면 **버전 불일치 프레임과 손상 바이트를 구별할 수 없다** — 즉 "명시적 거부"를 구현할 수 없다 | **`frameVersion 1B` 를 프레임 선두에** |
| 3 | 확장 여지 없음 | 배칭·플래그를 넣으려면 매번 버전을 올려야 하고, 버전을 올리면 §2 의 재협상+fresh snapshot 전체 절차가 돌아간다 | **`flags 2B`** 추가 |

확정 헤더는 **28바이트**다 (프롤로그 별도, §1.8). 초안 대비 +7B 이지만, 현행 JSON 봉투는 `sessionId`(36자 UUID) + `authorityEpoch`(36자 UUID) + `connectionEpoch` + `chunkId` + `screenSeq` + `deliverySeq` + 키 이름만으로도 이를 크게 넘는다. `[미확인]` — 정확한 평균 봉투 크기는 실측하지 않았다. §1.10 의 "~200 B" 는 필드 구성에서 추정한 값이며 **도입 전후 비교 측정에서 확정해야 한다.**

추가로, 조사 과정에서 **초안이 전제한 식별 모델 자체가 현재 라이브 경로와 다르다**는 점이 드러났다. 이것이 이 문서에서 가장 중요한 발견이며 §1.4 에서 다룬다.

---

## 1. 프레임 포맷 확정안

### 1.1 바이트 오프셋 표

모든 정수는 **big-endian (network byte order)**. 헤더 28바이트 고정.

| off | size | 필드 | 타입 | 의미 |
|---:|---:|---|---|---|
| 0 | 1 | `frameVersion` | uint8 | 프레임 레이아웃 버전. v1 = `0x01`. `0x00`/`0xFF` 는 영구 예약 |
| 1 | 1 | `opcode` | uint8 | §1.3 분류표 |
| 2 | 2 | `flags` | uint16 | 비트필드. §1.2 |
| 4 | 4 | `channelId` | uint32 | 연결그룹 스코프 세션 핸들. `0` 은 영구 예약이며 **v1 에서는 수신 시 무조건 거부**. §1.5 |
| 8 | 8 | `streamEpoch` | uint64 | Ordinal64. §1.4 |
| 16 | 8 | `sourceSeq` | uint64 | Ordinal64. §1.4 |
| 24 | 4 | `payloadLength` | uint32 | payload 바이트 수. §1.7 |
| 28 | N | `payload` | bytes | opcode 별 프롤로그 + 본문. §1.8 |

**정렬 근거** `[설계결정]`: 두 uint64 가 offset 8 / 16 에 놓여 **8바이트 자연 정렬**이 된다. JS `DataView` 는 정렬을 요구하지 않으므로 현재 구현에는 무관하지만, 패딩을 넣지 않고도 정렬이 성립하므로 포기할 이유가 없다. `payloadLength`(24) 는 4정렬, payload 시작(28) 도 4정렬이다.

**엔디안 근거** `[설계결정]`: `DataView.getBigUint64(offset)` 는 `littleEndian` 인자를 생략하면 **big-endian** 으로 동작한다. 즉 big-endian 은 "인자를 잊어도 맞는" 기본값이고, little-endian 을 고르면 모든 호출부에 `true` 를 빠짐없이 전달해야 하는 규율이 생긴다. 인코더/디코더가 서버·프론트 두 벌로 존재하는 상황(§4.4)에서 이 규율은 반드시 한 번은 깨진다. big-endian 채택.

**패딩 없음** `[설계결정]`: 헤더를 32B 로 올려 payload 를 8정렬하는 안을 검토했으나 기각. payload 는 대부분 UTF-8 바이트열이라 typed-array 로 재해석하지 않으며, 8정렬이 사는 이득이 없다. 프레임당 4B 순손실.

#### 나머지 필드 폭의 근거와 기각안

| 필드 | 채택 | 기각안과 사유 |
|---|---|---|
| `opcode` 1B | 1B | **2B 기각** — v1 사용 7개, 예약까지 합쳐도 256 공간의 3% 미만이다. `frameVersion` 이 별도로 있어 opcode 공간 소진 시 버전을 올려 재배치할 수 있으므로 선제 확장이 불필요하다 |
| `flags` 2B | 2B | **1B 기각** — v1 이 3비트(bit0/1/3)를 쓰므로 1B 면 여유가 5비트뿐이다. `acceptedFlagMask` 협상(§1.2)을 도입한 이상 플래그는 버전 범프 없이 늘어나는 유일한 확장 축이 되므로 여유가 필요하다. 그리고 1B 로 줄여도 헤더가 4정렬을 유지하려면 어차피 1B 패딩이 붙어 실이득이 0 이다 |
| `channelId` 4B | 4B | **2B 기각** — uint16 은 65,535 개다. 동시 세션 수로는 충분하지만 §1.5 규칙 2 가 **codecEpoch 안에서 재사용을 금지**하므로 소비되는 것은 동시 세션 수가 아니라 **누적 subscribe 횟수**다. 장수명 연결에서 재구독이 반복되면 uint16 은 도달 가능하고, 소진은 codecEpoch 범프 + 전 채널 fresh snapshot 을 유발한다. 4B 는 이 경로를 사실상 제거한다 |
| `payloadLength` 4B | 4B | §1.7. `screen-snapshot` 상한이 2 MiB(`config.schema.ts:77`)이므로 uint16(64 KiB)은 부족하고 uint24 는 정렬을 깬다 |

### 1.2 `flags` 비트 배치

| bit | 이름 | 의미 |
|---:|---|---|
| bit | 이름 | 협상 | 의미 |
|---:|---|---|---|
| 0 | `END_OF_BATCH` | **필수(협상 불가)** | 이 프레임이 현재 WS 메시지의 마지막 논리 프레임. **마지막 프레임은 반드시 세운다** — 없으면 `batch-not-terminated` 로 거부. §1.7 |
| 1 | `PAYLOAD_UTF8_TEXT` | 선택 | payload 본문이 검증된 UTF-8 텍스트(터미널 출력) |
| 2 | 예약 (미사용) | — | `CONTINUATION` 후보였으나 **v1 에서 사용하지 않는다** |
| 3 | `PROLOGUE_PRESENT` | **필수(협상 불가)** | payload 선두에 opcode 별 프롤로그가 있음. §1.8 |
| 4-15 | 예약 | — | 송신 시 0 |

**필수 비트와 선택 비트를 구분한다** `[설계결정]`. `END_OF_BATCH`(bit0)와 `PROLOGUE_PRESENT`(bit3)는 **프레임 구조 자체를 서술**하므로 협상 대상이 될 수 없다 — 클라이언트가 bit3 를 뺐다고 서버가 프롤로그를 안 실을 수는 없고, 실은 채로 비트만 지우면 디코더가 프롤로그를 본문으로 오독한다. 따라서:

```
MANDATORY_FLAGS = bit0 | bit3           = 0x0009
NEGOTIABLE_FLAGS(v1) = bit1              = 0x0002
v1 acceptedFlagMask / activeFlagMask     = 0x000B   (= MANDATORY | NEGOTIABLE)
```

`0x000B` 이므로 **bit2 는 마스크 밖**이고, 예약 비트 거부 규칙이 bit2 와 bit4-15 를 함께 잡는다.

#### ⚠️ 정정 (D14, 2026-08-19) — `MANDATORY_FLAGS` 는 **협상 불변식**이며 프레임별 술어가 아니다

위 문단은 **서로 다른 두 불변식을 한 상수에 담았다.** 확정 처분은 `06` §3.5 D14 이며, 아래가 그 반영이다.

| 불변식 | 대상 | v1 값 | 위반 시 |
|---|---|---|---|
| **협상 불변식** | 클라이언트 `acceptedFlagMask` 가 포함해야 하는 비트 집합 | `MANDATORY_FLAGS = bit0 \| bit3 = 0x0009` | 협상 실패 — `terminal-binary:rejected(reason='mandatory-flag-not-accepted')` (아래 송신 규칙) |
| **프레임별 불변식** | 개별 프레임의 `flags` 가 세워야 하는 비트 | **`PROLOGUE_PRESENT`(bit3) 뿐** | 프레임 거부 — `mandatory-flag-cleared` (§3.4) |

**bit0 은 프레임별 불변식이 아니다.** §1.2 표 자신이 `END_OF_BATCH` 를 "현재 WS 메시지의 **마지막** 논리 프레임" 에만 세우도록 규정하므로(위 bit0 행), **마지막이 아닌 프레임의 bit0 = 0 은 정상**이다. 따라서 디코더 술어를 `(flags & MANDATORY_FLAGS) === MANDATORY_FLAGS` 로 두면 **모든 배치 중간 프레임을 거부**한다.

이것은 추론이 아니라 **측정된 사실**이다 `[설계결정]` — 잘못된 술어를 실제로 넣고 코덱 스위트를 돌린 결과 **78건 중 14건이 red** 였고, 그중 **11건은 D14 를 위해 신설한 대조군이 아니라 기존 테스트**였다(배치·채널·등급 테스트 포함). 실측 기록은 `06` §5 S2-g "D14 구현 결과" 에 있다.

**확정 술어**: `prologueBytes(opcode) > 0 && (flags & PROLOGUE_PRESENT) === 0` → `mandatory-flag-cleared`(fatal). `MANDATORY_FLAGS` 를 마스크로 쓰지 않는다.

**프롤로그가 없는 opcode 에서 bit3 = 0 은 정상이다.** 술어의 정의역을 `prologueBytes(opcode) > 0` 으로 좁힌 이유가 이것이다 — 프롤로그 스키마가 없는 opcode 의 프레임은 **실제로 프롤로그를 싣지 않으므로**, 그 프레임에서 거짓말은 bit3 를 끈 것이 아니라 **켠 것**이다. §1.8 이 7종 전부에 프롤로그를 정의한 뒤에는 이 정의역이 자동으로 전체로 넓어지며 술어는 한 글자도 바뀌지 않는다.

⚠️ **디코더는 bit3 로 레이아웃을 결정하지 않는다.** 프롤로그 크기는 **opcode 만의 함수**다(§1.8, `prologueBytes()`). 따라서 위 문단이 경고한 "비트만 지우면 디코더가 프롤로그를 본문으로 오독한다" 는 이 설계에서는 **성립하지 않는다** — bit3 검사의 목적은 정확성 방어가 아니라 **비정합 피어의 조기 검출**이고, 그래서 등급이 fatal(연결 단위 재협상)이다.

**수신 거부 규칙 (단일 정의)**: `(flags & ~activeFlagMask) !== 0` 이면 `reserved-flag-set` 으로 프레임 거부. 협상 전 기본 마스크는 `0x000B` 다. 이 동적 규칙이 정본이며, "bit4-15 고정 거부" 는 그 특수 사례다 — 두 규칙을 병기하지 않는다.

**송신 규칙**: 서버는 `flags & ~activeFlagMask` 를 세우지 않는다. 단 `MANDATORY_FLAGS` 는 마스크에서 제외될 수 없으므로 — 클라이언트가 `acceptedFlagMask` 에 `MANDATORY_FLAGS` 를 포함하지 않으면 서버는 `terminal-binary:rejected(reason='mandatory-flag-not-accepted')` 로 협상을 실패시킨다.

예약 비트를 "무시"가 아니라 "거부"로 정한 것은 `[설계결정]` 이다. 무시하면 신규 플래그를 붙인 서버가 구버전 클라이언트에게 **의미가 절반만 전달된 프레임**을 보내게 되고, 이것이 바로 이슈 AC 가 금지한 silent drop 의 변종이다.

#### flags 가 버전 범프를 실제로 절약하려면 — `acceptedFlagMask` 필요

위 거부 규칙만 두면 `flags` 는 §0 표 #3 이 주장한 이득을 내지 못한다. 신규 플래그를 세우는 순간 구버전 디코더가 프레임을 **거부**하고 §3.4 의 fresh-snapshot 복구가 돌기 때문에, 결국 버전을 올린 것과 같은 비용이 든다.

`[설계결정]` — **플래그도 협상 대상으로 만든다.** §2.2 층2 의 제안/수락에 마스크를 추가한다.

```ts
// C→S 제안에 추가
acceptedFlagMask: number;   // 해석 가능한 flags 비트 마스크. v1 = 0x000B (MANDATORY 포함 필수)

// S→C 수락에 추가
activeFlagMask: number;     // 서버가 실제로 세울 비트. 항상 client mask 의 부분집합
```

서버는 `activeFlagMask` 밖의 비트를 **절대 세우지 않는다.** 따라서 구버전 클라이언트는 자기가 아는 비트만 받고, 신규 비트를 아는 클라이언트만 그 기능을 쓴다. 이것이 있어야 "플래그 추가 = 버전 범프 회피" 가 성립한다. 마스크는 단조 확장이므로 서버가 신규 비트를 추가해도 구 클라이언트의 협상 결과는 변하지 않는다.

위 §1.2 의 수신 거부 규칙  은 **그대로 유지**한다 — 협상을 지키지 않는 버그 있는 서버나 손상 프레임에 대한 최후 방어선이기 때문이다. 정상 동작에서는 발동하지 않는다.

#### bit2 `CONTINUATION` 을 v1 에서 쓰지 않는 이유 `[설계결정]`

초안 검토 중 "논리 페이로드가 여러 프레임에 걸침" 용도로 넣었으나 **기각**한다. 조각 인덱스·총 개수·유실 처리·재조립 버퍼 상한·타임아웃을 전부 새로 정의해야 하는데, **같은 문제를 이미 푸는 메커니즘이 프롤로그에 있다** — `0x05 CHECKPOINT_CHUNK` 의 `chunkIndex`/`chunkCount` (`ws-protocol.ts:96-101`)와 `commit` 의 digest 검증이다. 두 메커니즘을 공존시키면 어느 쪽이 정본인지 모호해지고, 디코더가 같은 실패를 두 경로로 처리하게 된다.

**v1 의 분할은 opcode 별 프롤로그가 담당한다.** 분할이 필요한 것은 체크포인트 계열(0x04~0x07)뿐이고 거기에는 이미 인덱스가 있다. `output`(0x01)은 분할하지 않는다 — 분할이 필요할 만큼 크면 서버가 애초에 여러 output 메시지로 나눈다(현행 동작과 동일).

#### bit1 `PAYLOAD_UTF8_TEXT` 의 비용 `[설계결정]`

이 비트는 **서버가 이미 아는 사실을 전달할 뿐 새로 검사하지 않는다.** `output.data` 는 서버 내부에서 이미 JS 문자열이므로(`ws-protocol.ts:714`) UTF-8 인코딩 결과가 정의상 유효하다. 즉 인코더가 `Buffer.from(str, 'utf8')` 을 쓰는 경로에서는 무조건 세우고, 체크포인트처럼 원시 바이트를 싣는 경로에서는 세우지 않는다. **검증 스캔 비용은 발생하지 않는다.**

이득은 클라이언트 쪽이다: 이 비트가 서면 디코더가 `TextDecoder` 를 건너뛰고 `Uint8Array` 를 그대로 xterm 에 넘길 수 있다(§3.5). 비트가 없으면 xterm 이 바이트를 받아도 상관없지만, 디코더가 문자열이 필요한 경로(디버그 캡처 등)에서 안전하게 변환할지 판단할 근거가 사라진다.

### 1.3 opcode 분류표 — 서버→클라이언트 메시지 전수

아래는 `server/src/types/ws-protocol.ts` 의 `ServerWsMessage` union (`:704-796`) 과 `TerminalCheckpointServerMessage` (`:265-303`) **전수**에, union 에 선언되어 있지 않으나 실제로 wire 를 건너는 `terminal-authority:*` 12종을 더한 것이다.

> ⚠️ **`ServerWsMessage` union 은 wire 의 완전한 목록이 아니다.** `terminal-authority:*` 계열이 통째로 빠져 있다. 이들은 `WsRouter.sendTerminalAuthorityFrameToConnection` (`server/src/ws/WsRouter.ts:1079`) → `sendTo` (`:1125`) 로 실제 소켓에 나간다.
>
> **서버→클라이언트로 나가는 `terminal-authority:*` 전수 (12종):**
>
> | 타입 | 송신 지점 |
> |---|---|
> | `responder-disable-boundary` | `server/src/services/TerminalAuthorityController.ts:1111` |
> | `rollback-start` | `TerminalAuthorityController.ts:1566`, `TerminalAuthorityDebugService.ts:366` |
> | `legacy-responder-enabled` | `TerminalAuthorityController.ts:1801`, `TerminalAuthorityProductionAdapter.ts:2926` |
> | `view-stale` | `TerminalAuthorityProductionAdapter.ts:2383` |
> | `parser-reset` | `TerminalAuthorityProductionAdapter.ts:2390` |
> | `view-attributes-accepted` | `TerminalAuthorityProductionAdapter.ts:3471`, `:3673` |
> | `responder-disable-accepted` | `TerminalAuthorityProductionAdapter.ts:3729`, `:2309` |
> | `compatibility-drain-accepted` | `TerminalAuthorityProductionAdapter.ts:3991` |
> | `promotion-aborted` | `TerminalAuthorityProductionAdapter.ts:4288`, `:4731`, `TerminalAuthorityDebugService.ts:339` |
> | `canary-decision` | `TerminalAuthorityProductionAdapter.ts:2733`, `:2785` |
> | `query-reply-accepted` | `server/src/ws/WsRouter.ts:2990-2993` (`sendPriorityControl` 경로) |
> | `query-reply-rejected` | 같음 |
>
> 이 중 프론트 복제본(`frontend/src/types/ws-protocol.ts`)에 선언된 것은 **3종뿐**이고(`responder-disable-boundary`/`rollback-start`/`legacy-responder-enabled`, 수신 처리는 `frontend/src/contexts/WebSocketContext.tsx:695-697`), 서버 `ServerWsMessage` 에는 **0종**이다. 클라이언트→서버 방향으로는 `responder-disabled` / `compatibility-drained` / `view-attributes` 가 더 있다 (`frontend/src/utils/terminalCheckpointRuntime.ts:2106`, `:2169`, `frontend/src/utils/terminalViewAttributes.ts:93`).
>
> **opcode 표를 `ServerWsMessage` union 으로부터 기계 생성하면 이 12종이 전부 누락된다.** 그리고 이것이 §3.2 / §5.6 에 직접 영향을 준다 — `sendTerminalAuthorityFrameToConnection` 의 lane 인자는 대부분 `'terminal'` 이므로(예: `:2382-2386` 의 `markAffectedViewStale`), split 모드에서 **이 JSON control 프레임들이 output 소켓으로 간다.** 즉 output 소켓은 "데이터 평면 전용"이 아니며, 바이너리 그룹의 output 소켓에도 JSON 텍스트 프레임이 섞여 흐른다. WS 는 텍스트/바이너리 프레임 순서를 보장하므로 정확성 문제는 없으나, **"output 소켓 = 바이너리" 라는 단순화는 성립하지 않는다.**
>
> lane 은 종별로 다르다 — `responder-disable-accepted` 는 `'control'` 로 나가고(`TerminalAuthorityProductionAdapter.ts:2317`), `query-reply-accepted`/`rejected` 는 `sendTerminalAuthorityFrameToConnection` 이 아니라 **`sendPriorityControl`** 경로다(`WsRouter.ts:2990`). 따라서 "authority 프레임 = terminal lane" 도 일반화할 수 없다. `[미확인]` — 12종 각각의 lane 을 전수 확인하지는 않았다. 바이너리 그룹의 소켓별 codec 배선을 확정하기 전에 전수 확인이 필요하다.

#### 바이너리 평면 (data plane)

| opcode | 메시지 타입 | 선언 | 채택 근거 |
|---:|---|---|---|
| `0x01` | `output` | `ws-protocol.ts:713` | 핫패스. 유일하게 빈도가 높은 메시지 |
| `0x02` | `screen-snapshot` | `:597` | `data` 가 원시 ANSI UTF-8 문자열. 상한 2 MiB(`config.schema.ts:77`) |
| `0x03` | `screen-repair` (S→C 패치) | `:648` | `ansiPatch` + `viewportRows[]` 대량 문자열. **아래 방향 충돌 주의** |
| `0x04` | `terminal-checkpoint:start` | `:81` | `parserTail` 이 base64 |
| `0x05` | `terminal-checkpoint:chunk` | `:96` | **base64 64 KiB 청크**(`TerminalAuthorityProductionAdapter.ts:298`). 바이너리화로 base64 33% 오버헤드 소멸 |
| `0x06` | `terminal-checkpoint:commit` | `:103` | 순서상 chunk 와 같은 평면에 있어야 함 |
| `0x07` | `terminal-checkpoint:output` | `:111` | base64 |
| `0x08`~`0x3F` | — | | 예약 (데이터 평면 확장) |
| `0x40`~`0x7F` | — | | 예약 (벤더/실험) |
| `0x80` | `JSON_ENVELOPE` | — | 예약. §1.7 의 배칭에서 control 메시지를 같은 WS 메시지에 실을 필요가 생길 때만 사용. **v1 에서는 송신하지 않는다** |
| `0x81`~`0xFE` | — | | 예약 (미할당) |
| `0x00`, `0xFF` | — | | **영구 예약.** 수신 시 항상 `unknown-opcode`. 0 으로 채워진 버퍼와 0xFF 로 채워진 버퍼를 유효 프레임으로 오독하지 않기 위한 canary |

> ⚠️ **`screen-repair` 는 같은 `type` 문자열이 양방향에 존재한다.** C→S 요청은 `ScreenRepairRequestMessage` (`ws-protocol.ts:618-626`, `{cols, rows, reason, clientAtBottom, clientBufferType}`), S→C 패치는 `ScreenRepairMessage` (`:648-660`, `{seq, cols, rows, bufferType, cursor, viewportRows, ansiPatch}`) 로 **구조가 전혀 다른데 판별자가 같다.** 현행 JSON 에서는 방향이 곧 판별자라 문제가 없다. 바이너리에서도 opcode `0x03` 은 **S→C 방향에만 할당**되며, C→S 요청은 JSON 평면에 남으므로 충돌하지 않는다. 다만 opcode 표를 방향 구분 없이 기계 생성하면 두 타입이 하나의 opcode 로 접히므로 `[설계결정]` — **opcode 네임스페이스는 방향별로 분리**한다(S→C 표와 C→S 표를 따로 둔다). v1 의 C→S 는 전부 JSON 이므로 C→S opcode 표는 비어 있다.

`terminal-checkpoint:commit`(0x06) 을 데이터 평면에 둔 것은 `[설계결정]` 이다. **근거 서술은 2026-08-19 에 정정되었다 — 아래가 정본이며, 이전 판의 두 근거는 둘 다 틀렸다.**

| 이전 판의 근거 | 판정 | 정정 |
|---|---|---|
| "commit 은 페이로드가 작아 바이너리 이득이 거의 없다" | **틀렸다** | commit 은 sha256 hex 문자열 **2개**(각 71자)와 Ordinal64 decimal **6개**를 싣는다. JSON **약 730 B** `[추정]` → 바이너리 **116 B**(헤더 28 + 프롤로그 88). **대역폭만으로 독립적으로 정당화된다.** 셈법은 `07` §8.3 |
| "start → chunk×N → commit 이 하나의 `sourceSeq` 연속열을 이룬다" | **틀렸다** | checkpoint 평면의 `sourceSeq` 는 세 메시지에서 **연속열이 아니라 상수**다. 서버는 셋 다 같은 `identity` 에서 만들고(`TerminalAuthorityProductionAdapter.ts:1677` `identity.sourceSeq = snapshotSeq`), 클라이언트는 output 이 아닌 모든 checkpoint 메시지에 대해 `activeIdentity.sourceSeq !== message.sourceSeq` 이면 `checkpoint-identity-mismatch` 로 실패시킨다(`frontend/src/utils/terminalCheckpointRuntime.ts:1209`). 즉 **같아야만 한다** — 전진하면 오히려 오류다 |

**정정된 근거** `[설계결정]`: 지키려는 실질은 **한 체크포인트 트랜잭션이 두 인코딩에 걸쳐 쪼개지지 않는 것**이고, 그것은 `0x04`~`0x07` 을 전부 바이너리 평면에 두면 성립한다. 헤더의 **전송 계층** `sourceSeq`(§1.4 의 2계층 식별)는 바이너리 프레임마다 1 증가하므로 트랜잭션이 하나의 연속 구간(예: start 12 → chunk 13/14/15 → commit 16 → output 17)을 차지하고, checkpoint 평면 ordinal 은 start·commit 이 같은 값으로 유지되어 `:1209` 의 등식 검사가 그대로 성립한다.

> ⚠️ **JSON control 메시지는 전송 계층 ordinal 을 소비하지 않는다** — 헤더가 없기 때문이다. 따라서 "commit 만 JSON 으로 나가면 남은 바이너리 프레임의 `sourceSeq` 연속성이 깨진다" 도 성립하지 않았다. 이전 판의 문언이 가리킨 불변식은 **애초에 존재하지 않았다.** 전수 논증은 `07` §6.
>
> `[미확인]` — 전송 계층 ordinal 은 **아직 배선되어 있지 않다**(§1.4 의 최대 리스크 절). 위 연속 구간은 S4 가 프레임마다 세션 ordinal 을 1 증가시키는 배선을 실제로 넣어야 성립한다.

#### JSON 평면 (control plane) — 전수

`ServerWsMessage` 의 나머지 **전부**가 여기 남는다.

| 메시지 | 선언 | JSON 유지 근거 |
|---|---|---|
| `screen-repair:rejected` | `:662` | 저빈도, 필드 가변 |
| `screen-repair:restore-needed` | `:681` | 저빈도. 복구 협상 |
| `screen-repair:reconnect-required` | `:696` | 저빈도 |
| `terminal-checkpoint:capability` | `:227` | **협상 자체**. 바이너리화하면 부트스트랩 순환(§2.2 층1) |
| `terminal-checkpoint:rejected` | `:255` | 협상 실패 통지. 반드시 JSON |
| `terminal-checkpoint:continuity-rebound` | `:272` | 저빈도 |
| `terminal-checkpoint:fresh-checkpoint-required` | `:281` | 저빈도. 단 내부 `fullCheckpoint.chunks[]` 는 base64 유지 `[설계결정]` — 이 메시지 자체가 복구 경로이므로 인코딩을 단순하게 둔다 |
| `status` | `:734` | 2필드 |
| `session:ready` | `:735` | 저빈도 |
| `terminal-delivery:capability` | `:743` | 협상 |
| `terminal-delivery:data-gap` | `:458` | 순수 메타데이터 14필드, payload 없음 |
| `terminal-delivery:checkpoint-ledger-settled` | `:750` | 메타데이터 |
| `terminal-delivery:ack-rejected` | `:760` | 메타데이터 |
| `input:rejected` | `:767` | 저빈도 |
| `cwd` / `session:error` / `session:exited` | `:774`-`:776` | 저빈도 |
| `subscribed` | `:778` | 연결당 소수회. **단 §1.5 에서 `channelId` 를 실어 확장한다** |
| `workspace:*` 5종 | `:780`-`:784` | `data: unknown` — 구조 미정 |
| `tab:*` 6종 | `:786`-`:791` | `data: unknown` |
| `grid:updated` | `:793` | `data: unknown` |
| `connected` | `:795` | **부트스트랩. 반드시 JSON** |
| `pong` | `:796` | 하트비트 |
| `terminal-authority:responder-disable-boundary` | 프론트 `:695` | union 미선언(위 경고). 저빈도 제어 |
| `terminal-authority:rollback-start` | 프론트 `:696` | 저빈도 제어 |
| `terminal-authority:legacy-responder-enabled` | 프론트 `:697` | 저빈도 제어 |

> `connected` 의 실제 wire 필드는 선언(`ws-protocol.ts:795` = `{type, clientId}`)보다 넓다. 실제로는 `connectionId`/`clientGroupId`/`wsTransportMode`/`channel`/`pairToken`/`pairTokenExpiresAt` 를 함께 보낸다 (`WsRouter.ts:1697-1710`, `:1620-1627`). 즉 **union 선언과 실제 wire 가 이미 어긋나 있다.** §2.3 의 negotiation 필드를 여기에 얹을 때 선언도 함께 교정해야 한다.

### 1.4 `sourceSeq` / `streamEpoch` — Ordinal64 ↔ 바이너리 매핑

#### 계약

`REL-BGSTAB-007` AC-4 (`docs/spec/30.buildergate-stability.srs.md:2839`, Stability=**stable**):

> sourceSeq, snapshotSeq, oldestRetainedSeq 및 checkpoint/apply/drain/delivery ACK가 운반하는 모든 sequence ordinal은 공통 Ordinal64 wire type을 사용한다. **Ordinal64는 streamEpoch 안의 unsigned 64-bit ordinal이며 JSON wire에서는 canonical unsigned decimal string으로만 표현하고** 내부 비교는 정밀도를 잃지 않는 정수 연산을 사용해야 한다.

구현: `server/src/types/ws-protocol.ts:16` (`type Ordinal64 = string`), `:961` (`ORDINAL64_MAX = 2^64-1`), `:962` (canonical 패턴, leading zero 금지), `:969-974` (`isCanonicalOrdinal64`), `:982-1009` (`advanceRetainedTerminalOrdinal`).

#### AC-4 와의 관계 `[설계결정]`

AC-4 는 "**JSON wire 에서는**" 이라고 한정하고 있으므로, 바이너리 평면의 uint64 표현은 문언상 충돌이 아니다. 다만 `00-decision-record.md:59` 가 AC-4 를 개정 대상으로 명시했으므로, 필요한 개정은 **삭제가 아니라 절 추가**이며 최소 형태는 다음과 같다.

> Ordinal64 는 binary wire 에서 big-endian unsigned 64-bit 정수로 표현하며, JSON wire 에서는 canonical unsigned decimal string 으로만 표현한다. 두 표현은 동일 값에 대해 상호 무손실이어야 하고, API 경계에서 노출되는 표현은 canonical decimal string 으로 통일한다.

마지막 문장이 중요하다. 근거는 아래.

#### BigInt ↔ 바이너리 변환

```
encode(v: Ordinal64, dv: DataView, off: number): void
  // v 는 이미 isCanonicalOrdinal64 를 통과한 문자열
  dv.setBigUint64(off, BigInt(v))        // big-endian

decode(dv: DataView, off: number): ParsedOrdinal64
  const value = dv.getBigUint64(off)     // big-endian, bigint
  return { value, wire: value.toString(10) }
```

`wire` 를 반드시 **함께** 만들어야 하는 이유는 클라이언트 검증기가 문자열 동일성으로 비교하기 때문이다. `frontend/src/utils/terminalWriteCoordinator.ts:662-667` 는 `streamEpoch?.wire === transaction.streamEpoch.wire` 형태로 5개 ordinal 을 **`.wire` 문자열끼리** 대조한다. `value` 만 만들고 `wire` 를 비우면 이 비교가 조용히 전부 false 가 되고, 결과는 `stale-server-rejection` 무한 루프다.

`ParsedOrdinal64` 는 이미 존재하는 타입이다 (`frontend/src/utils/terminalWriteCoordinator.ts:343-352` `parseCanonicalOrdinal64`, `{wire, value}` 를 `Object.freeze` 로 반환). **바이너리 디코더는 이 타입을 그대로 만들어 내야 하며, 새 타입을 도입해서는 안 된다** `[설계결정]`. 그래야 아래 기존 상태기계에 그대로 물린다.

#### 기존 클라이언트 상태기계에 물리는 지점

`frontend/src/utils/terminalWriteCoordinator.ts:1118-1151` 이 이미 완성된 `(streamEpoch, sourceSeq)` 검증기다. 바이너리 프레임은 이 함수의 **입력만 바꾸는** 것이지 새 검증을 만드는 것이 아니다.

| 조건 | 결과 | line |
|---|---|---|
| 파싱 실패 | `invalid-ordinal64` + `requestRecovery` | `:1122-1125` |
| `streamEpoch < current` | `stale-stream-epoch` | `:1127-1130` |
| `streamEpoch > current` | `fresh-checkpoint-required` | `:1131-1134` |
| `latest === ORDINAL64_MAX && seq === 0n` | `ordinal64-rollover` | `:1136-1139` |
| `sourceSeq <= latest` | `non-monotonic-source-seq` | `:1140-1143` |

여기서 **`streamEpoch` 가 올라가면 클라이언트는 프레임을 수용하지 않고 fresh checkpoint 를 요구한다**(`:1131-1134`). 이 성질이 §4 롤백 설계의 토대가 된다 — 새 epoch 을 발급하는 것만으로 클라이언트는 구 스트림을 자동으로 버린다.

#### 핫패스 비용과 완화 `[설계결정]`

`BigInt` 연산과 `toString(10)` 은 output 프레임마다 2회씩 발생하며 이는 JSON 을 없애 얻은 이득을 잠식한다. 완화:

1. **지연 materialization**: 디코더는 `value: bigint` 만 즉시 만들고 `wire` 는 getter 로 지연 계산한다. `.wire` 는 identity 비교(`:662-667`)와 재전송 시에만 필요하고, 정상 output 경로는 `.value` 비교(`:1127-1143`)만 쓴다.
2. **hi-word 단축**: `getUint32(off)` 가 0 이면 값이 2^32 미만이므로 `getUint32(off+4)` 를 Number 로 다루고 BigInt 를 아예 만들지 않는다. `sourceSeq` 가 2^32 에 도달하려면 세션당 43억 프레임이 필요하므로 사실상 항상 이 경로다 `[미확인]` — 실 세션의 `sourceSeq` 분포는 측정하지 않았다.

**이 완화는 공짜가 아니다.** 두 완화를 적용하면 `ParsedOrdinal64` 가 다음으로 넓어진다.

```ts
// 현행 (frontend/src/utils/terminalWriteCoordinator.ts:343-352)
{ wire: string; value: bigint }

// 확장안
{ get wire(): string; value: number | bigint; isBig: boolean }
```

`wire` 를 getter 로 바꾸는 것은 비파괴다(읽기 인터페이스 동일, `Object.freeze` 유지 가능). 그러나 **`value` 를 `number | bigint` 로 넓히는 것은 파괴적이다** — `value` 를 직접 비교하는 모든 지점이 영향을 받는다. 확인된 영향 지점:

| 지점 | 현재 비교 | 조치 |
|---|---|---|
| `terminalWriteCoordinator.ts:1128` | `streamEpoch.value < currentStreamEpoch.value` | `compareOrdinal(...) < 0` |
| `:1132` | `streamEpoch.value > currentStreamEpoch.value` | `compareOrdinal(...) > 0` |
| `:1136` | `latestSourceSeq.value === ORDINAL64_MAX && sourceSeq.value === 0n` | `equalsOrdinal` / `isZero` 헬퍼 |
| `:1141` | `sourceSeq.value <= latestSourceSeq.value` | `compareOrdinal(...) <= 0` |
| `:662-667` | `.wire` 문자열 비교 5개 | **변경 불필요** |

관계 연산자(`<`, `>`, `<=`)는 JS 에서 number/bigint 혼합 피연산자를 허용하므로 실제로는 그대로 두어도 동작한다. 그러나 `===` 는 `1 === 1n` 이 **false** 이므로 안전하지 않다 — `:1136` 의 `=== 0n` 이 정확히 그 함정이다. 따라서 **비교를 `compareOrdinal`/`equalsOrdinal` 헬퍼로 일괄 치환**하고(부록 B), 직접 `.value` 비교를 lint 로 금지한다.

`[설계결정]` — 완화 2 는 **선택적 최적화**로 분류한다. 먼저 완화 1(지연 `wire`)만 적용해 `value: bigint` 를 유지한 채 착수하고, 측정에서 BigInt 생성이 실제 병목으로 확인될 때 완화 2 를 적용한다. 위 치환은 완화 2 의 전제 조건이다.

#### `(streamEpoch, sourceSeq)` 는 쌍으로만 단조다

`advanceRetainedTerminalOrdinal` (`ws-protocol.ts:990-1008`) 은 `sourceSeq === ORDINAL64_MAX` 에서 `streamEpoch += 1`, `sourceSeq = '0'` 으로 되돌린다. 따라서 `sourceSeq` 단독은 단조가 아니다. **프레임에 두 필드를 함께 실어야 하는 이유가 이것이며, 초안이 두 필드를 모두 넣은 판단은 옳다.**

#### ⚠️ 초안이 전제한 식별 모델과 라이브 경로의 불일치 — 최대 리스크

조사에서 드러난 가장 중요한 사실이다. **현재 서비스 중인 `output` 메시지는 `streamEpoch`/`sourceSeq` 를 싣지 않는다.**

`output` 의 실제 식별 필드는 (`ws-protocol.ts:713-733`):

| 필드 | 타입 | 생성 |
|---|---|---|
| `screenSeq` | `number` | `SessionManager.ts:810` 선언, `:1251` 0 초기화, `:3474`/`:3504`/`:7696` 에서 `+= 1` |
| `authorityEpoch` | `string` = **UUID v4** | `SessionManager.ts:1252` `uuidv4()`. 카운터가 아니라 세션 생성 시 1회 발급 |
| `authorityRevision` | `number` | `:1253` 0 초기화, screenSeq 와 항상 쌍으로 증가 |
| `chunkId` | `string` = bigint decimal | `WsRouter.ts:3641-3645` 세션별 카운터 |
| `connectionEpoch` | `string` = `<uuid>` 또는 `<uuid>:delivery-N` | `WsRouter.ts:5916-5920` |
| `deliverySeq` | `number` | `wsSendPolicy.ts:764`, lane(`connectionEpoch/sessionId`) 스코프 |

즉 라이브 output 평면은 **UUID 기반 equality 모델**이고, `streamEpoch`/`sourceSeq` 는 **retained/checkpoint 평면**의 모델이다. 그리고 checkpoint 평면은 아직 켜져 있지 않다 — `WsRouter.ts:2396-2399` 가 모든 checkpoint ACK 를 무조건 `checkpoint-not-active` 로 거절한다.

`authorityEpoch` 는 UUID(16바이트)이므로 8바이트 필드에 들어가지 않는다. `connectionEpoch` 는 가변 길이 문자열이라 고정 필드에 아예 들어가지 않는다.

**해결안 (채택)** `[설계결정]` — **2계층 식별**:

- **헤더의 `(streamEpoch, sourceSeq)` 는 전송 계층 ordinal 이다.** 둘 다 **세션이 소유하고 서버가 관리한다** (§1.6 — 채널이 아니다). 채널은 그 값을 참조할 뿐이며, 프레임마다 세션의 `sourceSeq` 가 1 증가한다. 이것이 §4 롤백과 §3 갭 검출의 단일 기준이 된다.
- **애플리케이션 식별자는 opcode 별 payload 프롤로그에 둔다** (§1.8). `output` 프롤로그는 `screenSeq`/`chunkIdBase`/`authorityRevision`/`authorityEpochIndex` 를 담는다.
- retained/checkpoint 평면이 승격되면 그 평면의 `sourceSeq` 는 **전송 계층 ordinal 과 같은 값으로 수렴**시킨다. 그때 프롤로그의 legacy 필드가 사라진다.

**기각안**: 헤더의 `streamEpoch`/`sourceSeq` 를 retained 평면 값으로 직결. **기각 사유** — retained 평면이 비활성(`WsRouter.ts:2396-2399`)이므로 지금 그 값을 실으면 프레임이 항상 초기값이 되어 갭 검출과 롤백이 무력화된다. 그리고 이 방식은 바이너리 전환을 checkpoint 승격 완료 뒤로 미루게 만드는데, 승격은 `allRespondersCapable` 게이트(`TerminalAuthorityProductionAdapter.ts:2228`, `WsRouter.ts:874-876`) 때문에 **협상 안 된 클라이언트가 하나만 붙어 있어도 차단**된다. 즉 무기한 대기다.

`authorityEpoch` UUID 는 `authorityEpochIndex: uint16` 으로 압축한다. 매핑은 채널 개설 시와 변경 시 JSON control 로 전달한다 (§1.5).

### 1.5 `channelId` — sessionId 매핑과 할당 프로토콜

#### 왜 필요한가

`sessionId` 는 **UUID v4 36자 ASCII** 다 (`server/src/services/SessionManager.ts:1173` `options.sessionId || uuidv4()`). 프레임마다 36바이트를 싣는 것은 28바이트 헤더 전체보다 비싸다. uint32 핸들로 압축한다.

> 주의: `options.sessionId` 로 외부 주입이 가능하므로(restore 경로) **sessionId 가 항상 UUID 형식이라는 보장은 없다.** 길이 가정을 코드에 넣지 말 것.

#### 스코프 — 소켓이 아니라 연결그룹 `[설계결정]`

`channelId` 는 **`clientGroupId` 스코프**다. 소켓 스코프가 아니다.

근거는 `FR-BGSTAB-007` AC-3/AC-4 (`docs/spec/30.buildergate-stability.srs.md:446-447`): output 소켓이 없거나 닫히거나 백프레셔/큐 한도를 넘으면 **terminal payload 가 control 소켓으로 폴백**한다. 코드에서도 `WsRouter.ts:1111-1113` 이 `target = (lane==='terminal' && group.output OPEN) ? group.output : control` 로 갈린다. 소켓 스코프 채널 테이블이면 폴백된 프레임의 `channelId` 가 control 소켓에서 해석 불능이 된다.

#### 할당 프로토콜

```
할당:   handleSubscribe 성공 시 (WsRouter.ts:2559-2634)
        → subscribed 응답(:2633)의 SubscribedSessionInfo 에 channelId 를 실어 보낸다
해제:   handleUnsubscribe (:2636-2676) / handleDisconnect (:3341-3394)
```

`SubscribedSessionInfo` (`ws-protocol.ts:798-803`) 를 확장한다:

```ts
export interface SubscribedSessionInfo {
  sessionId: string;
  status: string;
  cwd?: string;
  ready: boolean;
  channelId?: number;          // uint32. 바이너리 협상된 그룹에서만 존재
  streamEpoch?: Ordinal64;     // 그 세션의 현재 streamEpoch (스냅샷이 아니라 참조값)
  authorityEpochIndex?: number; // uint16. authorityEpoch UUID 의 채널 로컬 별칭
}
```

`channelId` 를 optional 로 둔 것은 JSON 전용 그룹과 스키마를 공유하기 위함이다 `[설계결정]`.

#### 할당 규칙

1. `channelId = 0` 은 **영구 예약**. "세션 없음 / 연결 스코프" 를 뜻한다. v1 의 데이터 평면 opcode 7종은 전부 세션 스코프이므로 **v1 에서 `channelId = 0` 인 프레임은 발생하지 않는다** — 디코더는 이를 `unknown-channel` 이 아니라 `reserved-channel` 로 명시 거부한다. 0 을 예약해 두는 이유는 §1.3 의 `0x00`/`0xFF` opcode 예약과 같다: **0 으로 채워진 버퍼가 유효 프레임처럼 보이지 않게** 하기 위함이다.
2. 할당자는 그룹별 **단조 증가 uint32** 카운터다. 해제된 값을 **같은 codecEpoch 안에서 재사용하지 않는다**.
3. `0xFFFFFFFF` 도달 시 → codecEpoch 를 올리고 재협상(§4). 세션당 1개 소비이므로 실질 도달 불가.

규칙 2 가 핵심이다 `[설계결정]`. 재사용하면 다음 사고가 성립한다.

```
t0  channel 7 = sessionA,  프레임 F(ch=7, seq=100) 가 소켓 버퍼에 적재됨
t1  클라이언트가 sessionA unsubscribe → channel 7 해제
t2  sessionB subscribe → channel 7 재할당
t3  F 가 이제 도착 → 클라이언트는 sessionB 의 화면에 sessionA 의 출력을 쓴다
```

`sourceSeq` 단조 검사(`terminalWriteCoordinator.ts:1140-1143`)는 이것을 막지 못한다. 새 채널의 `latestSourceSeq` 가 아직 없어 검사 자체가 건너뛰어지기 때문이다(`:1135` `latestSourceSeq` truthy 가드). **재사용 금지가 유일한 구조적 방어다.**

#### 해제 통지와 retired 유예 — 복구 폭풍 방지

해제를 함수 두 개로만 규정하면 정상 unsubscribe 마다 복구 폭풍이 난다. 클라이언트가 채널을 지운 뒤에도 **소켓 버퍼와 서버 큐에는 그 채널의 프레임이 남아 있고**, 그것이 아래 "미지 channelId" 규칙에 걸려 이미 죽은 세션에 대해 fresh snapshot 을 요구하기 때문이다. 재사용 금지(규칙 2)는 이 케이스를 막지 못한다 — 재사용 금지는 *다른 세션 오염*을 막을 뿐이다.

`[설계결정]` — 채널에 **3-상태 수명**을 준다.

```
   ACTIVE ──(unsubscribe / session 종료 / 그룹 재편)──▶ RETIRED ──(유예 만료)──▶ FREE
     ▲                                                    │
     └──────────── 재할당 없음 (codecEpoch 내) ◀───────────┘
```

| 상태 | 의미 | 프레임 수신 시 |
|---|---|---|
| `ACTIVE` | 정상 | 처리 |
| `RETIRED` | 해제됐으나 잔여 프레임이 도착할 수 있음 | **조용히 폐기하되 진단 이벤트를 남긴다.** 복구 요청 안 함 |
| `FREE` | 유예 만료 | 미지 channelId 로 취급 → 아래 규칙 |

RETIRED 에서의 폐기는 silent drop 이 아니다 `[설계결정]` — 이슈 AC 가 금지한 것은 "화면에 구멍이 나는데 아무도 모르는" 상황이고, 여기서는 **클라이언트가 그 세션을 이미 버렸으므로 그릴 화면이 없다.** 진단 이벤트(`terminal_binary_retired_channel_frame`)로 관측 가능성은 유지한다.

유예 기간은 새 상수를 만들지 않고 **`pairTokenExpiresAt` 과 같은 30초**를 쓴다 (`WsRouter.ts:1690`). `[설계결정]` — 새 정책 숫자를 도입하면 `PERF-BGSTAB-010` AC-4 의 "정책값은 `TerminalResourcePolicy` 에서 파생" 요구에 걸린다.

**서버 주도 해제는 반드시 통지한다.** 세션 종료·그룹 재편으로 서버가 채널을 닫으면 클라이언트는 추론할 방법이 없으므로, JSON control 로 `terminal-binary:channel-retired { channelId[], reason }` 을 보낸다. 클라이언트 주도 해제(`unsubscribe`)는 클라이언트가 이미 알므로 통지하지 않는다.

#### 미지 channelId 수신 시 (= `FREE` 이거나 처음 보는 값)

클라이언트가 모르는 `channelId` 를 받으면 **버리지 않고** `terminal-binary:unknown-channel` 을 서버에 보낸 뒤 해당 채널만 fresh snapshot 을 요청한다. 전 연결을 끊지 않는다. 이슈 AC "silent drop 금지" 의 직접 이행이다.

### 1.6 `streamEpoch` 와 기존 epoch 들의 관계

저장소에는 epoch 계열 필드가 다수 있고 스코프가 전부 다르다. 혼동이 실제 버그로 이어질 수 있어 정리한다.

| 필드 | 타입 | 스코프 | 단조? | 프레임과의 관계 |
|---|---|---|---|---|
| **`streamEpoch`** (헤더) | uint64 / Ordinal64 | **세션** (서버 소유, 연결/그룹보다 오래 산다) | 예 | **프레임 필드** |
| `authorityEpoch` | UUID v4 문자열 | 세션 (`SessionManager.ts:1252`) | **아니오** — 순서 비교 불가, equality 전용 | 프롤로그의 `authorityEpochIndex` 로 압축. 매핑은 JSON |
| `authorityRevision` | number | 세션 (`:1253`, `:3475` 등) | 예 | `output` 프롤로그 |
| `screenSeq` | number | 세션 (`:810`, `:1251`) | 예. **리셋 없음** | `output` 프롤로그 |
| `connectionEpoch` | `<uuid>` 또는 `<uuid>:delivery-N` (`WsRouter.ts:5916-5920`) | 소켓 | 세대 접미사만 | **프레임에 넣지 않음** — 가변 길이. JSON 협상 평면 유지 |
| `deliverySeq` | number ≥ 1 | lane = `connectionEpoch/sessionId` (`wsSendPolicy.ts:578`) | 예. lane 재생성 시 1 리셋 | ACK 도메인. 프레임에 넣지 않음 (§1.9) |
| `viewGeneration` | number | attach | 예 | JSON |
| `checkpointEpoch` | Ordinal64 | 세션 | 예 | checkpoint 프롤로그 |
| `visibilityGeneration` | Ordinal64 | 소켓 | 서버가 강제 (`WsRouter.ts:2011-2017`) | JSON |
| `policyGeneration` | number | 프로세스 | 예 | wire 에서 제거됨 (`wsSendPolicy.ts:90` `delete`) |
| `recoveryGeneration` | number | — | **서버는 항상 0 하드코딩** (`WsRouter.ts:6785`) | 무관 |

관계 요약 `[설계결정]`:

- `streamEpoch` 는 `authorityEpoch` 를 **대체하지 않는다.** `authorityEpoch` 는 "어느 서버측 authority 인스턴스인가"(equality), `streamEpoch` 는 "이 채널의 몇 번째 연속 스트림인가"(ordering)다. 둘은 직교한다.
- `streamEpoch` 는 `connectionEpoch` 와도 다르다. `connectionEpoch` 는 소켓 스코프고 재연결마다 바뀌지만, `streamEpoch` 는 **재연결로 바뀌지 않는다** — 재연결 후에도 같은 세션의 스트림 연속성을 주장할 수 있어야 continuity rebind (`ws-protocol.ts:193-206`)가 성립하기 때문이다.

#### ⚠️ `streamEpoch` 의 소유자는 채널이 아니라 세션이다

`channelId` 는 그룹 스코프인데(§1.5), 그룹은 **재연결을 견디지 못한다.** control 소켓이 붙을 때마다 `connectionId = uuidv4()` 이고 `clientGroupId` 도 split 이면 새 `uuidv4()` 다 (`WsRouter.ts:1666-1667`). 즉 재연결하면 그룹과 채널 테이블이 통째로 새로 만들어진다. `streamEpoch` 을 채널에 소유시키면 **재연결마다 0으로 되돌아가고**, §4 롤백의 전제("epoch 을 올리면 클라이언트가 구 스트림을 자동 폐기")가 무너진다.

`[설계결정]` — **`streamEpoch` 은 세션이 소유한다.**

| 항목 | 규정 |
|---|---|
| 저장 위치 | `SessionData` — 이미 `retainedTerminalStreamEpochCounter` 가 `SessionManager.ts:1076` 에 존재하므로 **새 저장소를 만들지 않고 이것을 정본으로 승격**한다 |
| 수명 | PTY 세션과 동일. 재연결·그룹 재생성·소켓 교체로 리셋되지 않는다 |
| 채널의 역할 | 채널은 "현재 이 그룹에서 그 세션을 가리키는 핸들" 일 뿐이다. 채널 개설 시 세션의 **현재** `streamEpoch` 을 읽어 `subscribed` 로 전달한다 (§1.5) |
| 증가 주체 | 서버. §1.6 의 5개 사건에서만 |
| 재연결 시 | 값 유지. 클라이언트는 새 채널 테이블을 받되 `streamEpoch` 은 이전과 같은 값을 본다 → `terminalWriteCoordinator.ts:1127-1134` 가 `stale` 도 `fresh-checkpoint-required` 도 발생시키지 않고 연속으로 취급 |

따라서 §1.6 의 "채널 개설" 은 `streamEpoch` **증가 사건이 아니다** — 아래 목록에서 1번을 정정한다: 세션 최초 생성 시에만 발급하고, 이후 채널 개설은 기존 값을 읽어 전달할 뿐이다.
- `screenSeq` 를 `sourceSeq` 로 승격하는 안은 기각. `screenSeq` 는 `number` 이고 세션 수명 동안 리셋되지 않아 2^53 를 넘길 이론적 경로가 있으며, 무엇보다 `sourceSeq` 는 **전송 계층** 값이어야 폴백/재전송 시 재계산할 수 있다.

`streamEpoch` 를 올리는 사건 (전수):

1. **세션 최초 생성** (채널 개설이 아니다 — 위 정정 참조)
2. codec 전환 — JSON→binary, binary→JSON (§4)
3. Ordinal64 rollover — `sourceSeq` 가 `ORDINAL64_MAX` 도달 (`ws-protocol.ts:999-1008`)
4. 서버 authority 롤백 — `MIG-BGSTAB-002` AC-5 (`docs/spec/30.buildergate-stability.srs.md:3601`) 가 "새 streamEpoch 의 fresh compatibility checkpoint" 를 요구
5. channelId 공간 소진

1~5 모두 클라이언트 측에서 `fresh-checkpoint-required` (`terminalWriteCoordinator.ts:1131-1134`) 로 귀결된다. **즉 epoch 을 올리는 행위 하나가 "구 스트림 폐기 + 새 스냅샷 요구" 를 자동으로 유발한다.** 이것이 §4 의 구조적 보장이다.

### 1.7 `payloadLength` 는 필요한가 — 배칭 결정

WebSocket 프레임이 이미 길이를 갖는데 4바이트를 더 쓰는 것이 중복인지가 초안의 열린 질문이었다.

**결론: 필요하다. 1 WS 메시지 = N 논리 프레임을 v1 부터 허용한다** `[설계결정]`.

#### 채택 근거

1. **배칭이 CPU 이득의 실제 소재다.** 현재 송신 경로는 소켓당 **in-flight 1개**로 직렬화된다 — `sendRawTransportMessage` 가 `state.sending = true` 로 잠그고(`WsRouter.ts:6260-6262`), `flushTransportQueue` 는 루프가 아니라 **한 건만 dequeue 후 send 콜백에서 재귀 구동**된다(`:6206-6238` → `:6328`). 즉 메시지 하나마다 이벤트 루프를 한 바퀴 돈다. JSON.stringify 를 없애도 이 왕복은 그대로 남는다. 배칭은 DRR quantum 하나를 `ws.send` 한 번으로 내보내 이 왕복을 N분의 1로 줄인다.
2. **길이 없이는 배칭을 나중에 추가할 수 없다.** 추가하려면 frameVersion 을 올려야 하고, 그러면 §4 의 재협상+fresh snapshot 전체가 돌아간다. 4바이트로 그 비용을 산다.
3. **손상·경계 오류를 자기서술적으로 검출한다.** `payloadLength` 가 버퍼 잔량과 어긋나면 `length-overrun` 으로 즉시 거부된다(부록 B). WS 프레임 길이만 믿으면 이 검사가 불가능하고, 배치 안에서 오프셋이 어긋난 채 다음 프레임을 헤더로 오독하게 된다.

#### 배칭과 ACK/settlement 정합성

배칭이 기존 회계를 깨지 않는지 확인했다.

- **ACK 는 이미 누적(cumulative)이다.** `wsSendPolicy.ts:839` 가 `lane.sent.filter(d => d.deliverySeq > lane.lastAcknowledgedSeq && d.deliverySeq <= input.deliverySeq)` 로 구간을 한 번에 정산한다. 배치의 마지막 `deliverySeq` 하나만 ACK 하면 배치 전체가 정산된다. **변경 불필요.**
- **`onSettled` 는 배치 단위로 한 번 호출**하고 구성 delivery 전부를 settle 한다. `settleTransportMessage` (`WsRouter.ts:6387-6391`) 가 `message.onSettled = undefined` 로 소거 후 호출하는 idempotent 구조라 배치 래퍼를 얹기 쉽다.
- **`END_OF_BATCH` 플래그**로 디코더가 배치 경계를 안다. 마지막 프레임에만 세운다.

#### 배칭 상한 `[설계결정]`

한 WS 메시지의 총 바이트는 `bulkSliceBytes` 정책값(`wsSendPolicy.ts:521`)을 넘지 않는다. 이 값은 이미 fair scheduler 의 DRR quantum 이므로, 배치 = quantum 으로 두면 공정성 회계와 배칭 경계가 일치한다. 새 상수를 도입하지 않는다 — `PERF-BGSTAB-010` AC-4 (`docs/spec/30.buildergate-stability.srs.md:3676`)가 정책값을 `TerminalResourcePolicy` 에서 파생하도록 요구하므로 새 숫자를 만들면 계약 위반이다.

#### 기각안

- **길이 필드 제거, WS 프레임 길이 의존.** 기각: 위 1~3.
- **길이를 varint 로.** 기각: 고정 오프셋 파싱이 이 설계의 존재 이유다. varint 는 헤더를 가변 길이로 만들어 payload 시작 오프셋을 계산 의존으로 바꾼다. 절약되는 것은 프레임당 최대 3바이트다.

### 1.8 payload 프롤로그

opcode 별로 고정 레이아웃이며, 프롤로그 뒤부터 본문이다.

⚠️ **프롤로그의 존재와 크기를 정하는 것은 `opcode` 이지 `PROLOGUE_PRESENT`(bit3)가 아니다** (D14 정정). bit3 는 그 사실을 **선언**하는 비트이고, 프롤로그를 싣는 opcode 가 bit3 를 끄면 `mandatory-flag-cleared`(fatal)로 거부된다(§1.2, §3.4). 디코더가 bit3 를 레이아웃 결정에 쓰지 않는다는 성질이 이 절의 안전성 근거다.

#### `0x01 OUTPUT` (프롤로그 24B)

| off | size | 필드 | 대응 JSON |
|---:|---:|---|---|
| 0 | 8 | `screenSeq` (uint64) | `output.screenSeq` (`ws-protocol.ts:718`) |
| 8 | 8 | `chunkIdBase` (uint64) | `output.chunkId` (`:721`) |
| 16 | 4 | `authorityRevision` (uint32) | `:720` |
| 20 | 2 | `authorityEpochIndex` (uint16) | `:719` UUID 의 채널 로컬 별칭 |
| 22 | 2 | `segmentCount` (uint16) | `sourceSegments[]` 길이. 0 = 없음 |

`segmentCount > 0` 이면 프롤로그 뒤에 세그먼트 배열이 온다. 세그먼트 1개 = **16B**:

| off | size | 필드 | 기준 |
|---:|---:|---|---|
| 0 | 4 | `byteStart` (uint32) | 본문 절대 오프셋 |
| 4 | 4 | `byteEnd` (uint32) | 본문 절대 오프셋 |
| 8 | 4 | `screenSeqDelta` (uint32) | **프롤로그 `screenSeq` 로부터의 상대값** |
| 12 | 2 | `authorityRevisionDelta` (uint16) | **프롤로그 `authorityRevision` 으로부터의 상대값** |
| 14 | 2 | `chunkIdDelta` (uint16) | **프롤로그 `chunkIdBase` 로부터의 상대값** |

그 뒤가 본문 UTF-8 바이트열이다. **세 delta 는 전부 상대값이다** — 절대값을 u16/u32 로 자르면 장수명 세션에서 조용히 wrap 한다(원본 `sourceSegments[].authorityRevision` 은 절대 `number` 다, `ws-protocol.ts:727`). 인코더는 어느 delta 든 표현 범위를 넘으면 **세그먼트를 새 프레임으로 넘긴다**(부록 B2 `encodeFrame` 의 분할 규칙).

**`chunkIdBase` 는 생략할 수 없다** `[설계결정]`. `chunkId` 는 클라이언트의 **중복제거 키**다 — `frontend/src/utils/visibleOutputRecovery.ts` 가 `record.writtenChunkIds.has(chunk.chunkId)` (`:1360`), `.add(...)` (`:1364`), `expectedDrainChunkIds.add(...)` (`:1351`), 그리고 `typeof chunk.chunkId !== 'string' || chunk.chunkId.length === 0` 이면 청크를 거부(`:1403-1404`)한다. 값은 세션별 bigint 카운터(`WsRouter.ts:3641-3645`)이므로 uint64 로 무손실 표현되고, 디코더는 부록 B 의 `readOrdinal64` 와 동일하게 `String(v)` 로 원래의 decimal 문자열을 복원한다. 세그먼트의 `chunkIdDelta` 는 이 base 로부터의 상대값이다 — base 없이 delta 만 두면 **절대 `chunkId` 복원이 불가능**하고 중복제거가 통째로 무력화된다.

`output.chunkId` 는 optional 이다 (`ws-protocol.ts:721`). 부재 시 `chunkIdBase = 0` + `segmentCount = 0` 을 싣고, 디코더는 **`segmentCount === 0` 이면 `chunkIdBase` 를 chunkId 로 해석하지 않는다** — 0 이 유효한 chunkId 와 구별되지 않는 문제를 이렇게 회피한다. 현행 서버는 output 마다 chunkId 를 발급하므로(`WsRouter.ts:3641-3645`) 이 경로는 legacy 호환용이다.

프롤로그의 `screenSeq` 를 8바이트로 잡은 것은 `[설계결정]` 이다. 현재 타입은 `number`(`SessionManager.ts:810`)이고 통상 범위는 uint32 로 충분하지만, 세션 수명 동안 리셋되지 않으므로(§1.6) 4바이트로 자르면 장수명 세션에서 조용히 wrap 한다. 세그먼트 쪽이 더 좁은 폭을 쓰는 것은 **전부 상대값이기 때문**이며, 절대값을 좁게 자른 것이 아니다.

#### `0x02 SCREEN_SNAPSHOT` (프롤로그 24B)

`seq`(u64) / `cols`(u16) / `rows`(u16) / `mode`(u8: 0=authoritative, 1=fallback) / `truncated`(u8) / `flags2`(u16) / `authorityRevision`(u32) / `authorityEpochIndex`(u16) / `replayTokenIndex`(u16). 본문은 원시 ANSI UTF-8.

`replayToken` 은 UUID(`WsRouter.ts:3438`)라 인덱스로 압축하고 매핑은 JSON control 로 보낸다. `[미확인]` — replayToken 이 매 snapshot 트랜잭션마다 새로 발급되므로(`:5269`) 인덱스 테이블의 회전 속도가 실측상 얼마나 되는지는 확인하지 못했다. 회전이 빠르면 인덱스화 이득이 없고 16바이트 원시 UUID 를 싣는 편이 단순하다. **구현 전 실측 필요.**

#### `0x05 CHECKPOINT_CHUNK` (프롤로그 12B)

`chunkIndex`(u32) / `chunkCount`(u32) / `viewGeneration`(u32). 본문은 **base64 디코딩된 원시 바이트**. 현행은 base64 문자열(`ws-protocol.ts:75-79`, 64 KiB 청크 `TerminalAuthorityProductionAdapter.ts:298`)이므로 여기서 33% 가 즉시 절약된다.

`digest` 는 sha256 hex 32바이트 — `commit`(0x06) 프롤로그에 원시 32바이트로 싣는다(hex 64자 → 32B, 50% 절약).

#### 나머지 4종 `0x03` · `0x04` · `0x06` · `0x07` (D15, 2026-08-19 편입)

이전 판은 프롤로그를 `0x01`/`0x02`/`0x05` 세 opcode 에만 정의했다. 그 결과 배정된 opcode 7종 중 **4종이 인코딩 불가**였고(`prologueBytes()` 가 0 을 반환 → 인코더가 입구에서 거부), 그것이 `06` §3.5 **D15 = S4 착수 차단 항목**으로 등재되었다. **D15 안 (a)(나머지 4종 레이아웃 추가)를 채택해 여기서 닫는다.**

##### 정본 관계 `[설계결정]` — 어느 쪽이 SSOT 인가

| | 규정 |
|---|---|
| **SSOT** | **`01 §1.8` 이 프롤로그 사양의 유일한 정본이다.** 아래 요약 표와 §1.8 의 불변식이 계약이다 |
| **참조편입** | 4종의 **바이트 오프셋 표 · 필드 분류 근거 · 거부 조건 · 손계산 골든 벡터**는 `docs/research/binary-comms/07-prologue-spec-remaining-opcodes.md` §1.6 / §2.9 / §3.4 / §4.3 을 **참조편입**한다. 여기에 복제하지 않는다 (중복 금지) |
| **`07` 의 지위** | **2026-08-19 내용으로 동결된 부속서**다. 개정은 `07` 을 고치는 것이 아니라 `01 §1.8` 에 개정 조항을 적는 방식으로 한다 |
| **충돌 시** | **`01 §1.8` 이 이긴다.** 두 문서가 어긋나면 `07` 이 stale 인 것이다 |

##### 요약 표 (계약 — 상세는 `07`)

| opcode | 메시지 (S→C) | 프롤로그 | 본문 | flags | 상세 |
|---:|---|---:|---|---|---|
| `0x03` | `ScreenRepairMessage` (`ws-protocol.ts:648-660`) | **24 B** | `ansiPatch` UTF-8 | `0x0009` | `07` §1.6 |
| `0x04` | `TerminalCheckpointStartMessage` (`:81-94`) | **160 B** | `parserTail` 원시 바이트 (**0 B 가 통상**) | `0x0009` | `07` §2.9 |
| `0x06` | `TerminalCheckpointCommitMessage` (`:103-109`) | **88 B** | **없음.** `payloadLength === 88` 이어야 한다 | `0x0009` | `07` §3.4 |
| `0x07` | `TerminalCheckpointOutputMessage` (`:111-114`) | **12 B** | 원시 바이트 (0 B 가능) | `0x0009` | `07` §4.3 |

`prologueBytes()` 확정값: `0x01` 24 / `0x02` 24 / `0x03` 24 / `0x04` 160 / `0x05` 12 / `0x06` 88 / `0x07` 12. **배정 7종 전부가 0 이 아니게 되므로 D15 가 닫힌다.**

##### 7종 전체에 걸리는 불변식 (여기가 소유자)

아래는 `07` 이 아니라 **이 절이 소유한다** — `0x01`/`0x02`/`0x05` 에도 함께 걸리기 때문이다.

1. **프롤로그 길이는 `opcode` 만의 함수다.** `flags` 에 의존시키지 않는다. 이것이 §1.2 D14 정정의 전제 — bit3 가 잘못 서거나 꺼져도 디코더가 프롤로그를 본문으로 오독하지 않는 이유다.
2. **checkpoint 계열(`0x04`/`0x05`/`0x06`/`0x07`)의 프롤로그 오프셋 8..11 은 항상 `viewGeneration` uint32** 다.
3. **`0x04` 와 `0x06` 의 프롤로그 오프셋 0..15 는 동일**하다 (`checkpointSourceSeq` u64 / `viewGeneration` u32 / `chunkCount` u32).
4. **checkpoint 평면 ordinal 은 헤더 값과 다른 값이며 프롤로그가 명시적으로 싣는다.** 이름은 `checkpointSourceSeq` / `checkpointStreamEpoch` 로 헤더 필드명과 구분한다 — §1.4 의 "수렴시킨다" 는 **미래형**이고, 현재 두 값의 출처가 다르다(checkpoint 쪽 `TerminalAuthorityProductionAdapter.ts:1667`, 전송 계층 쪽 §1.6 이 정본으로 지정한 `SessionManager.ts:1076`).
5. **`flags2` 는 "opcode 별 확장 비트필드" 이지 고정 오프셋 필드가 아니다.** `0x02`/`0x03` 은 프롤로그+14, `0x04` 는 +74, `0x06` 은 +20 이다. checkpoint 계열은 ordinal 블록이 앞에 와야 8정렬이 성립해 고정이 불가능하다.
6. **v1 에서 `PAYLOAD_UTF8_TEXT`(bit1)를 세우는 opcode 는 `0x01` 뿐이다.** §1.2 의 "인코더가 `Buffer.from(str,'utf8')` 를 쓰는 경로에서는 무조건 세운다" 는 기준을 문자 그대로 적용하면 `0x03`/`0x04`/`0x05`/`0x07` 도 해당하는데, 그렇게 하면 기존 골든 벡터 2개가 바뀐다. bit1 은 **힌트**이고 이득은 핫패스뿐이므로 **기준을 "opcode 기준, v1 은 `0x01` 만" 으로 재서술**한다 `[설계결정]`.

##### ⚠️ `[미확인]` — 인덱스 `0` 의 의미가 정의되어 있지 않다

§1.8 은 `authorityEpochIndex` / `replayTokenIndex`(그리고 D15 가 추가한 `repairTokenIndex`)를 uint16 으로 정했으나 **`0` 의 의미를 정의한 적이 없다.** `authorityEpoch` 는 optional 이므로(`ws-protocol.ts:30`) 부재를 표현할 수단이 필요하다.

`07` §8.2 는 **1-based · `0` = absent** 를 제안했고(`channelId = 0` 예약과 같은 논리), 그 규칙 자체는 타당하다. **그러나 소급 적용에 걸리는 것이 있다** — 기존 골든 벡터 **`output-minimal-52` 가 `authorityEpochIndex = 0`** 을 쓰고 있어, 규칙을 채택하면 그 벡터의 의미가 "authorityEpoch 부재" 로 **바뀐다.** 그것이 원 의도였는지 확인하지 못했다.

⇒ **`[미확인]` 으로 등재하고 §6 확인 목록에 남긴다.** 확정 전까지 인코더/디코더는 이 슬롯에 의미를 부여하지 않는다. 규칙을 채택하지 않기로 결정할 경우의 대안은 `0x04` `flags2` bit4(현재 예약)를 `AUTHORITY_EPOCH_PRESENT` 로 쓰는 것이다.

### 1.9 프레임에 넣지 **않는** 것과 그 이유

| 필드 | 왜 안 넣나 |
|---|---|
| `sessionId` | 36자 UUID. `channelId` 로 대체 (§1.5) |
| `connectionEpoch` | 가변 길이(`<uuid>` / `<uuid>:delivery-N`, `WsRouter.ts:5916-5920`). 고정 필드 불가. 소켓 스코프이므로 협상 시 1회 합의로 충분 |
| `deliverySeq` | ACK 도메인 값. 채널 헤더의 `sourceSeq` 와 **의미가 다르다** — `deliverySeq` 는 lane(`connectionEpoch/sessionId`) 스코프이고 lane 재생성 시 1로 리셋된다(`wsSendPolicy.ts:644`). 두 개를 프레임에 다 넣으면 16바이트를 쓰면서 클라이언트가 어느 쪽으로 갭을 판정할지 모호해진다. `[설계결정]` — **ACK 는 `sourceSeq` 를 도메인으로 통일**하고 `deliverySeq` 는 서버 내부 회계로 강등한다. §2.4 참조 |
| `type` 문자열 | `opcode` 로 대체 |
| `policyGeneration` | 이미 wire 에서 제거됨 (`wsSendPolicy.ts:90` `delete wireMessage.policyGeneration`) |
| `output.replayToken` (`ws-protocol.ts:716`) | **채널 상태로 승격.** 한 채널에서 동시에 유효한 replay 트랜잭션은 하나이므로, 프레임마다 싣지 않고 `screen-snapshot`(0x02) 의 `replayTokenIndex` 가 갱신한 값을 채널이 들고 있는다. 프레임은 "현재 채널의 replayToken" 을 암묵 참조한다 |
| `output.repairToken` (`:717`) | 같은 이유. `screen-repair`(0x03) 가 갱신 |
| `output.deliveryKind` (`:732`) | **`opcode` 에서 파생.** `'output'`/`'checkpoint'` 는 opcode 와 1:1 이고, `'dataGap'`/`'readyBarrier'`/`'control'` 은 전부 JSON 평면 메시지다 (§1.3) |
| `sourceSegments[].authorityEpoch` (`:726`) | 세그먼트는 `authorityEpochIndex` 를 따로 갖지 않고 **프롤로그 값을 상속**한다. 한 output 메시지 안에서 authorityEpoch 이 바뀌는 경우는 `[미확인]` — 발생 가능하다면 세그먼트에 `authorityEpochIndex`(u16)를 추가하고 세그먼트 크기를 16B→18B 로 늘려야 한다. **구현 전 확인 필요** |

> `replayToken` / `repairToken` 을 채널 상태로 올린 것은 `[설계결정]` 이며, 위 §1.8 의 `SCREEN_SNAPSHOT` 프롤로그가 `replayTokenIndex` 를 갖는 이유이기도 하다. `output` 프롤로그에 두 토큰이 없는 비대칭은 여기서 나온다 — **토큰을 발급하는 메시지가 싣고, 참조하는 메시지는 싣지 않는다.**

### 1.10 크기 비교

`server/src/ws/wsSendPolicy.ts:91` 은 `JSON.stringify(wireMessage)` 하나로 전 메시지를 직렬화하고, `:95` 가 `Buffer.byteLength(payload, 'utf8')` 로 길이를 잰다. `perMessageDeflate` 는 어디에도 설정되어 있지 않다 — ws 서버 생성은 `WsRouter.ts:612` `new WebSocketServer({ noServer: true })` 단 한 곳이고 옵션은 `noServer` 뿐이다. ws v8 기본값이 `false` 이므로 **현재 JSON 은 무압축으로 나간다.**

전형적 `output` 메시지 (sessionId UUID + authorityEpoch UUID + chunkId + connectionEpoch + deliverySeq + screenSeq):

| 구성 | JSON | binary v1 |
|---|---:|---:|
| 봉투/헤더 | ~200 B `[미확인]` | 28 B (헤더) + 24 B (프롤로그) = 52 B (+ 세그먼트 16 B × N) |
| ANSI ESC (U+001B) | JSON 은 `\u001b` 로 이스케이프 = **6 B/개** | **1 B/개** |
| 본문 | UTF-8 + 이스케이프 | 원시 UTF-8 |

ANSI 이스케이프 항이 특히 크다. JSON 은 U+001F 이하 제어문자를 `\uXXXX` 로 강제 이스케이프하므로 **ESC 한 글자가 6바이트**가 된다. 터미널 출력은 SGR·커서이동 시퀀스가 조밀하므로 이 비율이 그대로 대역폭에 반영된다.

> ⚠️ **압축과의 공정 비교**: 현재 수치는 "무압축 JSON" 기준이다. `perMessageDeflate` 를 켠 JSON 은 반복적인 SGR 시퀀스를 잘 압축하므로 훨씬 싼 대안일 수 있다. 도입 후 측정에서 **binary vs deflate-JSON** 대조군을 반드시 포함해야 한다. 다만 deflate 는 CPU 를 쓰므로 "JSON.stringify CPU 를 줄인다"는 원 동기와는 반대 방향이다.
>
> 그리고 deflate 를 켜면 백프레셔 계산이 깨진다: `getServerBufferedAmount`(`WsRouter.ts:6572-6576`)의 `ws.bufferedAmount` 는 **압축 후** 바이트인데 `message.byteLength`(`wsSendPolicy.ts:95`)는 **압축 전** 바이트다. `:6098` `projectedBufferedAmount = bufferedAmount + message.byteLength` 가 과대평가된다.

---

## 2. 버전 협상

### 2.1 기존 기계장치 재사용 — 무엇을 쓰고 무엇을 안 쓰나

저장소에는 이미 두 개의 capability 협상이 있다.

| 협상 | C→S | S→C 수락 | S→C 거절 | 버전 되돌림 |
|---|---|---|---|---|
| checkpoint | `terminal-checkpoint:negotiate` (`ws-protocol.ts:129`) | `terminal-checkpoint:capability` (`:227`) | `terminal-checkpoint:rejected` (`:255`) | ✅ **`supportedProtocolVersion`** (`:257`) |
| delivery | `terminal-delivery:capability` (`:443`) | `terminal-delivery:capability` (`:743`) | 같은 타입 `accepted:false` | ❌ 없음 |

**checkpoint 쪽 관용구를 본뜨고, delivery 쪽 형태는 본뜨지 않는다** `[설계결정]`.

`terminal-delivery:capability` 는 **요청과 응답이 같은 `type` 문자열을 공유**하고 필드로만 구분된다(`:443-448` vs `:743-748`). 그리고 서버가 자기 지원 버전을 돌려줄 자리가 없다. 버전 협상에는 부적합하다.

`terminal-checkpoint:rejected.supportedProtocolVersion` (`:257`) 은 정확히 필요한 seam 이다. `phase: 'negotiate' | 'ack'` (`:258`) 로 실패 단계까지 구분한다.

또 하나 재사용할 것은 **연결별 협상 버전 저장소**다. `WsRouter.ts:2151` 이 negotiate 성공 시 `meta.terminalCheckpointProtocolVersion` 을 기록하고 `:2391-2394` 가 이후 ACK 에서 이를 검증해 `capability-not-negotiated` 로 거절한다. `WsClientMeta` (`ws-protocol.ts:809-824`) 에 같은 패턴으로 필드를 추가한다.

**기존 메시지에 필드를 얹지 않고 새 메시지 쌍을 만드는 이유** `[설계결정]`: `terminal-delivery:capability` 는 fair scheduler 등록을 관장한다(`WsRouter.ts:1969-1990`). 여기에 wire 인코딩 협상을 합치면 **직교한 두 관심사가 하나의 accepted/rejected 로 묶인다** — fair-delivery 아티팩트 검증이 실패했을 뿐인데(`:1955-1968`) 바이너리까지 못 쓰게 되거나 그 반대가 된다. 분리한다.

#### `MIG-BGSTAB-002` 의 promotion 게이트와의 관계

`MIG-BGSTAB-002` AC-1 (`docs/spec/30.buildergate-stability.srs.md:3597`)은 promotion 이 "**capability 가 확인된** 제한 session 에서만 새 `streamEpoch` 로 시작" 하도록 요구한다. codec 협상이 이 게이트에 들어가는지 답해 둔다.

**들어가지 않는다** `[설계결정]`. 근거는 게이트의 실제 입력이다. `readPromotionGates` (`server/src/services/TerminalAuthorityController.ts:109-118`)의 `allRespondersCapable` 은 `sessionContext?.allAttachedViewsCapable` (`TerminalAuthorityProductionAdapter.ts:2228`)에서 오고, 그 값은 `WsRouter.ts:874-876` 이 **attached view 의 checkpoint capability** 로 계산한다. 즉 AC-1 의 "capability" 는 **terminal authority capability** 이지 wire 인코딩이 아니다.

두 축을 섞으면 안 되는 이유가 하나 더 있다: `allAttachedViewsCapable` 은 attached view 가 **하나라도** 미협상이면 false 가 되어 세션 전체의 promotion 을 막는다(`:874-876`). codec 을 여기 넣으면 **JSON 클라이언트 한 명이 붙어 있다는 이유로 authority promotion 이 차단**된다 — 바이너리 도입이 무관한 기능을 퇴행시키는 결과다.

역방향 의존도 없다. §1.4 의 2계층 식별 덕분에 바이너리 프레임은 retained 평면 승격을 기다리지 않는다. **codec 협상과 authority promotion 은 독립적으로 진행된다.**

### 2.2 2단 협상 — subprotocol + in-band

`[설계결정]` — **디코더 능력은 WebSocket subprotocol 로, 데이터 평면 활성화는 in-band 메시지로** 나눈다.

두 층이 필요한 이유는 스코프가 다르기 때문이다.

- **디코더 능력은 소켓 스코프**여야 한다. §1.5 에서 본 대로 terminal payload 가 output 소켓에서 control 소켓으로 폴백하므로(`FR-BGSTAB-007` AC-3, `WsRouter.ts:1111-1113`), **control 소켓도 바이너리를 해독할 수 있어야** 한다. 소켓마다 독립적으로 확인되어야 한다.
- **데이터 평면 활성화는 연결그룹 스코프**여야 한다. `channelId` 테이블이 그룹 스코프이기 때문이다.

#### 층 1 — subprotocol (소켓 스코프)

```js
// frontend/src/contexts/WebSocketContext.tsx:1201, :1007
new WebSocket(url, ['buildergate.v1.binary', 'buildergate.v1.json'])
```

서버는 `WebSocketServer` 생성 시(`WsRouter.ts:612`) `handleProtocols` 를 준다. 선택 결과는 `ws.protocol` 로 양쪽이 읽는다.

이 층의 장점:

1. **HTTP 업그레이드 시점에 끝난다.** 첫 프레임이 오가기 전에 확정되므로 §2.5 의 부트스트랩 순환이 원천 봉쇄된다.
2. **RFC 6455 가 안전한 다운그레이드를 보장한다.** 서버가 subprotocol 헤더를 아예 응답하지 않으면 클라이언트의 `ws.protocol` 은 `''` 이 되고 연결은 정상 수립된다. 즉 **구버전 서버 + 신버전 클라이언트가 자동으로 JSON 으로 수렴**한다. 반대로 서버가 클라이언트가 제시하지 않은 값을 고르면 클라이언트가 연결을 실패시킨다 — 잘못된 조합이 조용히 성립할 수 없다.
3. 브라우저 `WebSocket` 생성자가 표준으로 지원한다. 커스텀 코드가 없다.

현재 두 소켓 생성 지점 모두 subprotocol 인자를 쓰지 않는다 (`WebSocketContext.tsx:1201`, `:1007`). 인자 추가가 전부다.

#### 버전 차원이 셋인데 왜 셋 다 필요한가

subprotocol 문자열(`buildergate.v1.binary`), in-band `frameVersion`, 프레임 헤더 `frameVersion` — 세 곳에 버전이 있다. 중복처럼 보이므로 각각의 역할과 불일치 시 처리를 명시한다 `[설계결정]`.

| 차원 | 역할 | 없으면 |
|---|---|---|
| subprotocol | **소켓이 바이너리를 해독할 수 있는가.** 업그레이드 시점, RFC 다운그레이드 보장 | 부트스트랩 순환(§2.2 층1). 그리고 폴백 소켓의 해독 능력을 알 수 없다 |
| in-band `frameVersion` | **그룹이 실제로 쓸 버전 확정 + 채널 테이블 시드.** subprotocol 은 문자열이라 다중 버전 교집합 협상을 표현하기 나쁘다 | 채널 테이블 전달 경로가 없다 |
| 헤더 `frameVersion` | **프레임 단위 fail-fast.** 손상 바이트 / 협상을 어긴 구현 / codecEpoch 경합으로 들어온 구세대 프레임을 "버전 불일치"로 **구별해서** 거부 | 손상과 버전 불일치를 구별할 수 없고, 이슈 AC 의 "명시적 거부" 를 구현할 수 없다 |

**불일치 처리**: 세 값 중 하나라도 어긋나면 프레임을 거부하고 §2.5 의 JSON 수렴 경로를 탄다. 구체적으로 헤더 `frameVersion !== group.frameVersion` → `bad-frame-version`(부록 B). subprotocol 과 in-band 가 어긋나는 경우는 서버 버그이므로 `terminal-binary:rejected(phase='offer')` 로 협상 자체를 실패시킨다.

**기각안**: 헤더 버전 바이트 제거(28B→27B). 기각 사유 — 27B 는 정렬을 깨고(uint64 가 7/15 오프셋), 절약은 프레임당 1바이트인데 얻는 손실은 위 표의 세 번째 행 전체다. 정렬 유지를 위해 패딩 1B 를 넣으면 절약이 0 이 된다.

#### 층 2 — in-band (그룹 스코프)

신규 메시지 5종. 전부 JSON 평면 고정.

```ts
// C→S : 제안
interface TerminalBinaryCapabilityOffer {
  type: 'terminal-binary:capability';
  supportedFrameVersions: readonly number[];   // 예: [1]
  acceptedFlagMask: number;                     // 해석 가능한 flags 비트. v1 = 0x000B (§1.2)
                                                // MANDATORY_FLAGS(0x0009) 미포함 시 협상 실패
  maxBatchBytes?: number;                       // 클라이언트 디코더 상한
}

// S→C : 수락
interface TerminalBinaryCapabilityAccepted {
  type: 'terminal-binary:capability';
  accepted: true;
  frameVersion: number;          // 서버가 고른 단일 값
  activeFlagMask: number;        // 서버가 실제로 세울 비트. client mask 의 부분집합 (§1.2)
  codecEpoch: number;            // §4. 이 값이 바뀌면 큐 전량 폐기
  channels: readonly {           // 이미 subscribe 된 세션의 초기 테이블
    sessionId: string;
    channelId: number;
    streamEpoch: Ordinal64;
    authorityEpochIndex: number;
  }[];
}

// S→C : 거절
interface TerminalBinaryRejected {
  type: 'terminal-binary:rejected';
  supportedFrameVersions: readonly number[];   // ← checkpoint 관용구
  phase: 'offer' | 'frame';
  reason:
    | 'unsupported-version'      // 교집합 공집합
    | 'invalid-message'
    | 'socket-not-binary-capable' // 그룹 내 어떤 소켓이 subprotocol 미협상 (§3.2)
    | 'mandatory-flag-not-accepted' // acceptedFlagMask 가 MANDATORY_FLAGS 를 뺐다 (§1.2)
    | 'group-not-eligible';
}

// S→C : 서버 주도 채널 해제 통지 (§1.5)
interface TerminalBinaryChannelRetired {
  type: 'terminal-binary:channel-retired';
  channelIds: readonly number[];
  reason: 'session-exited' | 'session-deleted' | 'group-rebound' | 'codec-epoch-bump';
}

// C→S : 미지 channelId 를 받았음을 알리고 그 채널만 복구 요청 (§1.5, §3.4)
interface TerminalBinaryUnknownChannel {
  type: 'terminal-binary:unknown-channel';
  channelIds: readonly number[];
}
```

수락 응답에 `channels` 를 실는 것이 중요하다 `[설계결정]`. 협상은 `connected` 수신 뒤에 일어나는데(§2.3), 그 시점에 이미 `subscribe` 가 나가 있을 수 있다 — 실제로 `WebSocketContext.tsx:1227-1230` 이 `onopen` 에서 기존 구독을 일괄 재전송한다. 초기 테이블이 없으면 그 세션들의 첫 바이너리 프레임이 미지 channelId 가 된다.

### 2.3 협상 시점과 순서

현재 핸드셰이크 순서를 코드로 확인한 결과는 다음과 같다.

```
[HTTP 업그레이드]
  WsRouter.ts:1527-1539   ?token= 쿼리에서 JWT 추출 → verifyToken → 실패 시 401 + destroy
  :1541                   wss.handleUpgrade
  :1542-1545              wsTransportMode 쿼리 파싱
  :1546-1547              channel 쿼리 → channelRole

[서버 첫 프레임 — 유일한 무조건 프레임]
  :1697-1710 (control)    {type:'connected', clientId, connectionId, clientGroupId,
                           wsTransportMode, channel:'control' [, pairToken, pairTokenExpiresAt]}
  :1620-1627 (output)     {type:'connected', ..., channel:'output'}

[이후는 전부 클라이언트 주도]
  WebSocketContext.tsx:1220-1223   onopen → terminal-checkpoint:negotiate
  :1227-1230                        onopen → subscribe (기존 구독)
  :989-998                          'connected' 수신 → terminal-delivery:capability
  :1000-1019                        'connected' 수신 → split output 소켓 생성
```

> ⚠️ 이미 존재하는 순서 위험: `terminal-checkpoint:negotiate` 는 `onopen` 에서, `terminal-delivery:capability` 는 `connected` 수신 후에 나간다. 즉 **negotiate 가 `connected` 보다 먼저 서버에 도착할 수 있다.**

`[설계결정]` — 바이너리 제안은 **`connected` 수신 후, `subscribe` 전**에 보낸다. subprotocol 층이 이미 업그레이드 시점에 확정되어 있으므로 이 in-band 단계는 순수하게 "그룹 활성화 + 채널 테이블 시드"만 담당하고, 순서 위험을 새로 만들지 않는다.

`connected` 에 서버의 subprotocol 선택 결과를 에코한다 (`negotiatedSubprotocol: string`). 클라이언트가 `ws.protocol` 로 이미 알 수 있지만, split 환경에서 **control 소켓이 output 소켓의 협상 결과를 알아야** 하기 때문이다 (§3.2). 이때 `connected` 의 union 선언(`ws-protocol.ts:795`)이 실제 wire 보다 좁다는 기존 문제(§1.3 각주)도 함께 교정한다.

### 2.4 ACK credit 도메인

이슈 AC (`docs/issues/wave4-wave5/19-binary-data-plane.md:173`) 와 결정 기록(`00-decision-record.md:78`)이 "ACK credit 은 encoded byte 단일 domain" 을 요구한다.

현재 `encodedBytes` 는 **JSON 인코딩 후 바이트**다 — `wsSendPolicy.ts:598-611` `fairDeliveryBytes()` 가 `createWsTransportMessage(...).byteLength` 를 쓰고, 그 `byteLength` 는 `:95` `Buffer.byteLength(JSON.stringify(...), 'utf8')` 다.

`[설계결정]` — 바이너리 그룹에서 `encodedBytes` 는 **바이너리 프레임 전체 길이(28 + 프롤로그 + 본문)** 로 재정의한다. 배치면 배치 전체 길이다.

이 변경의 파급이 크므로 명시한다:

1. `PERF-BGSTAB-010` 의 정책값 — `socketSoftGateBytes` / `bulkSliceBytes` / `smallOutputBypassBytes` / `creditWindowBytes` / `queueMaxBytes` (`wsSendPolicy.ts:519-527`) — 는 전부 **JSON 바이트 기준으로 튜닝**되어 있다. 바이너리는 같은 내용을 훨씬 적은 바이트로 표현하므로, 숫자를 그대로 두면 **실효 창이 내용 기준으로 몇 배 커진다.** 백프레셔가 늦게 걸리고 슬로우 클라이언트 격리가 약해진다.
2. `AC-3` (`docs/spec/30.buildergate-stability.srs.md:3675`)이 decision artifact 에 `workload schema/config hash` 와 각 metric 의 threshold 를 고정하도록 요구하고, `AC-4` (`:3676`)가 정책값을 `TerminalResourcePolicy` 와 evidence bundle 의 digest 에서 파생하도록 요구한다. 즉 **숫자를 바꾸려면 재벤치와 아티팩트 재발행이 필요하다.** 결정 기록도 `PERF-BGSTAB-010` 을 "재벤치 필요" 로 등재했다 (`00-decision-record.md:66`).
3. 서버측 `bufferedAmount` 회계(`WsRouter.ts:6098`, `:6219`)도 같은 도메인이 되어야 한다. `message.byteLength` 를 바이너리 프레임 길이로 채우면 자동으로 일치한다 — `Buffer.byteLength(json)` 대신 `frame.byteLength` 를 넣는 한 줄이다.

#### 시퀀스 도메인 통일 — 그리고 그것이 쉽지 않은 이유

§1.9 대로 **ACK 의 시퀀스 도메인은 `sourceSeq` 로 통일**한다. `terminal-delivery:ack` (`ws-protocol.ts:436-441`)는 현재 `deliverySeq: number` 를 쓰는데, 바이너리 그룹에서는 `sourceSeq: Ordinal64` 를 쓰는 변형을 추가한다.

누적 ACK 시맨틱 자체는 그대로 쓸 수 있다 — `wsSendPolicy.ts:839` 가 `lane.sent.filter(d => d.deliverySeq > lastAck && d.deliverySeq <= input.deliverySeq)` 로 구간 정산을 하므로 비교 대상만 바꾸면 된다. **그러나 세 가지가 자명하지 않다.**

**(a) 스코프 불일치.** `deliverySeq` 는 lane(`connectionEpoch/sessionId`, `wsSendPolicy.ts:578`) 스코프이고 **lane 재생성 시 1 로 리셋**된다(`:644`). `sourceSeq` 는 세션 스코프이고 리셋되지 않는다(§1.6). 따라서 lane 을 새로 만들면 `lane.lastAcknowledgedSeq` 의 초기값을 0 이 아니라 **그 세션의 현재 `sourceSeq`** 로 세워야 한다. 그러지 않으면 새 lane 의 첫 ACK 가 과거 전체를 정산해 버린다.

**(b) 한 채널이 두 lane 에 걸친다.** `FR-BGSTAB-007` AC-3 폴백(`WsRouter.ts:1111-1113`)으로 같은 채널의 프레임이 output lane 과 control lane 양쪽에서 나갈 수 있다 — §1.5 가 채널을 그룹 스코프로 만든 바로 그 이유다. 그런데 `lane.sent` 는 lane 별 자료구조이므로, 단일 `sourceSeq` 누적 ACK 하나가 **두 lane 의 미정산분을 동시에 정산**해야 한다.

`[설계결정]` — 정산 함수를 lane 단위에서 **채널 단위**로 올린다. `acknowledge({channelId, sourceSeq})` 가 그 채널에 연결된 모든 lane 의 `sent` 를 순회해 `sourceSeq` 이하를 정산한다. lane 이 하나뿐인 `unified` 에서는 현행과 동일하게 동작하므로, **`unified` 우선 착수(§5.4)에서는 이 변경이 필요 없고 split 단계에서 도입한다.**

**(c) 배치의 ACK 기준.** 배치 프레임 하나가 여러 delivery 에 대응할 때, 클라이언트는 **배치의 마지막 프레임 `sourceSeq`** 를 ACK 한다. 누적 시맨틱이므로 이것으로 배치 전체가 정산된다. `lane.sent` 엔트리에는 각 delivery 의 `sourceSeq` 를 부착해 두어야 하며, 이는 `WsTransportMessage` 에 `sourceSeq` 필드를 1급으로 추가하는 것과 같다 — §3.6 의 필드 승격 작업에 함께 포함시킨다.

### 2.5 협상 실패 / 미지원 downgrade 경로

```
                  ┌──────────────────────────┐
                  │ HTTP Upgrade + JWT verify│  WsRouter.ts:1527-1541
                  └────────────┬─────────────┘
                               │
                    subprotocol 교집합?
                    ┌──────────┴──────────┐
                 없음                    있음
                    │                      │
                    ▼                      ▼
        ws.protocol = ''         ws.protocol='buildergate.v1.binary'
                    │                      │
                    ▼                      ▼
              [JSON 그룹]           terminal-binary:capability 제안
              영구 JSON.                    │
              프레임 1개도            supportedFrameVersions 교집합?
              바이너리로 안 감    ┌──────────┴──────────┐
                              공집합                  있음
                                 │                      │
                                 ▼                      ▼
                    terminal-binary:rejected      그룹 전 소켓이
                    reason='unsupported-version'  binary-capable? (§3.2)
                    supportedFrameVersions=[...]   ┌────┴────┐
                                 │                아니오    예
                                 ▼                  │        │
                           [JSON 그룹]              ▼        ▼
                                          rejected      accepted
                                    'socket-not-        + codecEpoch
                                     binary-capable'    + channels[]
                                          │                 │
                                          ▼                 ▼
                                     [JSON 그룹]      [BINARY 그룹]
```

**모든 실패는 JSON 그룹으로 수렴하며, 어느 경로에서도 프레임이 버려지지 않는다.**

지금 고쳐야 할 기존 결함이 하나 있다. `handleTerminalDeliveryCapability` (`WsRouter.ts:1924-1991`)의 선행 가드(`:1927-1929`)는 파싱 실패 시 **아무 응답도 보내지 않고 return 한다.** 클라이언트는 `accepted:false` 조차 못 받고 무한 대기한다. 바이너리 협상에서 같은 구조를 복제하면 안 된다 — **모든 실패 경로가 반드시 `terminal-binary:rejected` 를 보낸다** `[설계결정]`.

또 하나: `terminal-delivery:capability` 응답의 `reason` 을 프론트가 **읽지도 로깅하지도 않는다** (`WebSocketContext.tsx:1023-1031` 이 `accepted` 와 `connectionEpoch` 만 저장). 거절 사유가 관측 불가다. `terminal-binary:rejected` 는 반드시 `reason` 과 `supportedFrameVersions` 를 진단 이벤트로 기록한다.

---

## 3. 혼합 버전 안전성

### 3.1 구조적 보장 — 단일 인코딩 깔때기

silent drop 을 "안 하도록 주의한다"로 막을 수 없다. **표현 불가능하게** 만든다.

다행히 저장소 구조가 이를 쉽게 해준다. 서버의 전 송신은 하나의 깔때기로 수렴한다.

```
sendTo (WsRouter.ts:6771)  ← 프로덕션 호출부 39곳
  → createWsTransportMessage (wsSendPolicy.ts:80)  ← JSON.stringify 단일 지점 (:91)
    → sendTransportMessage (:6077)
      → enqueueTransportMessage (:6154) / sendRawTransportMessage (:6240)
        → ws.send (:6268)   ← 프로덕션 유일 송신 지점
```

`[설계결정]` — `WsTransportMessage.payload` 를 판별 유니온으로 바꾼다.

```ts
type WirePayload =
  | { codec: 'json';   text: string }
  | { codec: 'binary'; bytes: Uint8Array; codecEpoch: number };

interface WsTransportMessage {
  payload: WirePayload;
  byteLength: number;   // codec 에 따라 text 의 utf8 길이 또는 bytes.byteLength
  // ... 나머지 동일
}
```

그리고 `createWsTransportMessage` 를 codec 파라미터화한다. codec 은 소켓에서 조회한다.

```
encodeFor(ws, message):
  codec = socketCodec.get(ws)              // subprotocol 협상 결과
  if codec is undefined:        codec = JSON        // 안전한 기본값
  if codec is BINARY and opcodeOf(message) is undefined:
      codec = JSON                                  // control 평면은 항상 JSON
  return codec.encode(message)
```

이 구조에서 **"JSON 전용 소켓에 바이너리 프레임을 보낸다"는 상태가 코드로 표현되지 않는다.** 소켓에서 codec 을 얻는 것 외에 다른 경로가 없기 때문이다.

`sendRawTransportMessage` 의 `ws.send` 호출은 이렇게 갈린다.

```ts
// WsRouter.ts:6268 자리
if (message.payload.codec === 'binary') {
  ws.send(message.payload.bytes, { binary: true }, callback);
} else {
  ws.send(message.payload.text, callback);
}
```

### 3.2 그룹 전체 동의 규칙

`[설계결정]` — **그룹의 모든 소켓이 binary subprotocol 을 협상했을 때만 그룹이 BINARY 가 된다.**

근거는 §1.5 와 같다. `FR-BGSTAB-007` AC-3/AC-4 폴백(`WsRouter.ts:1111-1113`)이 terminal payload 를 control 소켓으로 옮기므로, control 소켓이 JSON 전용이면 폴백 순간 해독 불능 프레임이 발생한다.

구현: output 소켓이 붙을 때(`WsRouter.ts:1578-1663`) 그룹의 codec 을 재평가한다. output 이 binary 를 협상하지 못했는데 그룹이 이미 BINARY 면 **그룹을 JSON 으로 강등**하고 §4 의 codecEpoch 전환을 수행한다. 반대로 그룹이 JSON 인데 output 이 binary 를 협상했다면 그대로 JSON 을 유지한다(승격은 재협상으로만).

#### 활성화 타이밍 — 즉시 vs 짝 완성 대기

위 강등은 비싸다. codecEpoch 전환 + 전 채널 fresh snapshot 이 돌기 때문이다(§4.2). 대안을 검토했다.

- **채택: split 그룹은 짝(output attach)이 완성될 때까지 BINARY 활성화를 유예한다** `[설계결정]`. control 만 붙은 상태에서는 JSON 으로 동작하고, output 이 붙어 그룹 전체 동의가 확인된 뒤에 한 번만 BINARY 로 전환한다. 강등 경로가 아예 발생하지 않으므로 비싼 전환이 사라진다. 유예 중 손해는 output 소켓이 붙기까지의 짧은 구간뿐이고, 그 구간은 `pairTokenExpiresAt` 30초 이내다 (`WsRouter.ts:1690`).
- **기각: 즉시 활성화 후 필요 시 강등.** 기각 사유 — control 이 먼저 BINARY 로 켜진 뒤 output 이 non-binary 로 붙는 경합이 **정상 접속 순서에서 항상 발생**한다(output 은 `connected` 수신 후에야 만들어진다, `frontend/src/contexts/WebSocketContext.tsx:1000-1019`). 즉 강등이 예외가 아니라 기본 경로가 된다.
- `unified` 는 소켓이 하나이므로 이 문제가 없고 즉시 활성화한다.

#### output 소켓 교체 시 (`FR-BGSTAB-006` AC-4)

중복 output 접속은 기존 소켓을 `close(1012,'output-replaced')` 로 끊는다 (`WsRouter.ts:1592-1603`). 바이너리 그룹에서 이때 처리할 것 `[설계결정]`:

| 대상 | 처리 |
|---|---|
| 새 output 소켓의 subprotocol | 재평가. non-binary 면 그룹 강등(위 규칙) |
| 구 소켓 in-flight 프레임 | `clearTransportQueueState` 가 이미 settle 한다 (`:1660`). **재인코딩·재전송하지 않는다** — §4.4 보장 2 와 동일 원칙 |
| `channelId` 테이블 | **유지.** 그룹이 살아 있으므로 채널도 산다. 재발급하면 클라이언트가 미지 channelId 폭풍을 맞는다 |
| `codecEpoch` | codec 이 그대로면 **유지**, 강등이면 범프 |
| `streamEpoch` | **유지** — 세션 소유이므로 소켓 교체와 무관하다 (§1.6) |

### 3.3 서버 수신측 — `isBinary` 도입

현재 서버는 바이너리 프레임을 **조용히 버린다.**

```ts
// WsRouter.ts:1718 (control) / :1638 (output)
ws.on('message', (raw: Buffer | string) => { ... })   // isBinary 인자 미선언

// WsRouter.ts:1742-1749
private handleMessage(ws: WebSocket, raw: Buffer | string): void {
  let msg: unknown;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    console.warn('[WS] Invalid JSON received');
    return;                      // ← 바이너리 프레임이 여기로 떨어진다
  }
```

`@types/ws/index.d.ts:135` 의 실제 시그니처는 `(data: WebSocket.RawData, isBinary: boolean)` 이다. 두 등록 지점 모두 두 번째 인자를 받고 `handleMessage` 로 전파한다.

부수적으로 현재 타입 `Buffer | string` 은 부정확하다. ws v8 은 `RawData = Buffer | ArrayBuffer | Buffer[]` 만 준다 — string 을 절대 주지 않는다. `Buffer[]` 케이스에서 `raw.toString()` 은 `,` 로 join 되어 조용히 깨진다.

### 3.4 클라이언트 수신측 — `binaryType` 과 실패 처리

```ts
// frontend/src/contexts/WebSocketContext.tsx:684-690
const handleMessage = useCallback((event: MessageEvent) => {
  let rawMessage: unknown;
  try {
    rawMessage = JSON.parse(event.data);
  } catch {
    return;                       // ← silent drop. 로그조차 없다
  }
```

두 가지를 고친다.

1. **`ws.binaryType = 'arraybuffer'` 를 명시**한다. `frontend/src` 전체에 `binaryType` 설정이 한 건도 없어 기본값 `'blob'` 이다. Blob 은 읽기가 **비동기**라서 `await blob.arrayBuffer()` 를 거치는 순간 **프레임 순서가 깨질 수 있다.** 터미널 출력에서 순서 붕괴는 곧 화면 붕괴다. `arraybuffer` 는 동기 접근이다.
2. **`catch { return; }` 를 제거**한다. 디코드 실패는 §2.5 의 명시적 수렴 경로로 보낸다.

```
onmessage(event):
  if event.data is ArrayBuffer:
      if group.codec !== BINARY:  →  requestFreshSnapshot('binary-frame-on-json-group')
      decoded = decodeFrame(event.data)
      if decoded.error:           →  requestFreshSnapshot(decoded.error)
      dispatch(decoded)
  else:
      try   parsed = JSON.parse(event.data)
      catch →  recordDiagnostic('json-parse-failed'); requestReconnect(...)
      dispatch(parsed)
```

#### 거부 사유 — **두 계열**이다 (D13 정정, 2026-08-19)

이전 판은 아래 10종을 **"전수"** 라고 불렀다. 정정한다: **10종은 *wire 어휘*이고, 그와 별도로 *디코더 정책 코드* 계열이 존재한다.**

| 시점 | wire | policy | 합 |
|---|---:|---:|---:|
| 현행 구현 (`binaryFrameCodec.ts`, 2026-08-19) | **10** | 3 (`payload-underrun` · `payload-limit-exceeded` · `mandatory-flag-cleared`) | **13** |
| D15(§1.8) 반영 후 | **10** | 4 (+ `prologue-domain-violation`) | **14** |

**wire 10종은 어느 판본에서도 불변이다** — 그것이 이 분리의 요지다.

**왜 두 계열로 나누는가** `[설계결정]` — 아래 10종 목록은 **이 문서 문면의 축자 사본**이고, 구현의 인벤토리 테스트가 그 10종을 리터럴로 적어 대조한다. 즉 기대값의 출처가 `01` 이라서 성립하는 검사다. 여기에 구현이 발명한 코드를 끼워 넣는 순간 그 리스트는 축자 사본이 아니게 되고, **인벤토리 테스트는 구현을 구현 자신과 대조**하게 되어 공허해진다. 그래서 **wire 어휘는 동결하고, "`01` 에 코드가 없는데 거부해야 하는" 조건은 별도 계열에 담는다.**

##### 계열 1 — wire 어휘 **10종 (동결)**

`server/src/ws/binaryFrameCodec.ts:125-136` `WIRE_REJECTION_CODES` 가 이 표의 축자 사본이다. **이 목록은 늘리지 않는다.**

| 코드 | 조건 |
|---|---|
| `binary-frame-on-json-group` | 그룹 codec 이 BINARY 가 아닌데 바이너리 프레임 도착 |
| `truncated-header` | 잔여 바이트 < 28 |
| `bad-frame-version` | 헤더 `frameVersion` ≠ 협상 값 |
| `unknown-opcode` | 미할당 opcode. `0x00`/`0xFF` 포함 (§1.3) |
| `reserved-flag-set` | 협상된 `activeFlagMask` 밖의 비트가 섬 |
| `reserved-channel` | `channelId === 0` (§1.5 규칙 1) |
| `unknown-channel` | `FREE` 이거나 처음 보는 `channelId` → 해당 채널만 fresh snapshot 요청 |
| `length-overrun` | `off + 28 + payloadLength > buf.byteLength` |
| `batch-terminated-early` | `END_OF_BATCH` 인데 버퍼 끝이 아님 |
| `batch-not-terminated` | 버퍼 끝인데 `END_OF_BATCH` 가 없음 |

전부 진단 이벤트로 기록한다. `RETIRED` 채널의 프레임은 이 목록에 없다 — 폐기하되 복구를 요청하지 않는다 (§1.5).

##### 계열 2 — 디코더 정책 코드 (wire 어휘 밖)

`binaryFrameCodec.ts:168-172` `DECODER_POLICY_CODES`. **소속이 등급을 정하지 않는다** — 등급은 아래 성질 규칙으로 갈린다.

| 코드 | 조건 | 등급 | 근거 |
|---|---|---|---|
| `payload-underrun` | `payloadLength` 가 필수 프롤로그(+ 세그먼트 배열)를 담을 수 없다 | **fatal** | `PROLOGUE_PRESENT` 는 프레임별 필수(§1.2 D14)이므로 `payloadLength = 0` 인 OUTPUT 은 "빈 본문" 이 아니라 "프롤로그 없음" 이다. 선언 길이 자체를 못 믿으므로 그것이 함의하는 `frameEnd` 도 못 믿는다. `length-overrun`(`28 + 0 ≤ 28`)으로도 `truncated-header`(헤더 28B 는 온전)로도 표현되지 않는다 |
| `payload-limit-exceeded` | 본문 바이트가 정책 상한 초과 | **scoped** | 아래 |
| `mandatory-flag-cleared` | 프롤로그를 싣는 opcode 인데 bit3 = 0 (§1.2 D14) | **fatal** | `reserved-flag-set` 에 합치지 않는다 — 그 코드는 마스크 *밖* 비트가 **선** 것을 뜻하고 이것은 마스크 *안* 비트가 **꺼진** 것이라, 합치면 진단이 정반대로 읽힌다 |
| `prologue-domain-violation` | 프레이밍은 건전한데 **프롤로그 필드 값이 정의된 도메인 밖** (D15 신설) | **scoped** | 아래 |

**`payload-limit-exceeded` 를 `length-overrun` 에 합치지 않는 이유**: 두 조건을 한 코드로 묶으면 상한 초과 fault 테스트가 실제로는 **길이 불일치 fault** 를 측정하게 된다. 분리해야 어느 쪽이 발동했는지 구별된다.

**`prologue-domain-violation` (D15 신설)** — 신설 4종이 도입하는 fault 는 전부 같은 성격이다: 프레이밍은 건전한데 프롤로그 필드 값이 도메인 밖이다(`0x03` `bufferType > 1`·`cursorHidden > 2`·예약 슬롯 ≠ 0 / `0x04` `chunkCount == 0`·`cols|rows == 0`·`modesValueMask & ~modesPresentMask` / `0x06` `payloadLength > 88` 등 — 전수는 `07` §1.8 / §2.11 / §3.6). 기존 12종 중 어느 것으로도 표현되지 않는다 — `reserved-flag-set` 은 **헤더의 `flags`** 전용이고 `payload-underrun` 은 길이 전용이다. **위반 종류마다 코드를 신설하지 않는다** — 그러면 어휘가 opcode 수에 비례해 늘어난다.

> **이 코드는 기존 `0x05` 의 공백도 함께 닫는다.** `0x05` 의 클라이언트 계약은 `chunkIndex < chunkCount` 이고 `chunkCount` 는 양수여야 하는데(`frontend/src/types/ws-protocol.ts:1233-1235`), 현행 디코더는 둘 다 검사하지 않고 값을 그대로 넘긴다.
>
> `0x07` 은 프롤로그가 uint64 + uint32 뿐이고 둘 다 전 범위가 유효하므로, **배정 7종 중 유일하게 이 코드를 유발할 수 없다.**

> **`stale-codec-epoch` 는 클라이언트 측 코드가 아니다.** `codecEpoch` 는 헤더 28B 에 없고 서버측 `WirePayload` 에만 있으므로(§3.1), 클라이언트는 프레임 바이트만으로 구세대 여부를 판정할 수 없다. 구세대 프레임 차단은 **서버가 전송 직전에** 수행하며 그 에러 문자열은 `codec-epoch-retired` 다 (§4.4). 클라이언트 쪽 최후 방어선은 `codecEpoch` 가 아니라 **`streamEpoch`** 다 — 롤백은 항상 `streamEpoch` 을 올리므로 구세대 프레임은 `stale-stream-epoch` 로 걸린다 (`terminalWriteCoordinator.ts:1127-1130`). `codecEpoch` 를 헤더에 넣지 않는 이유가 이것이다 `[설계결정]` — `streamEpoch` 이 이미 그 일을 하고 있어 4바이트가 중복이다.

#### 배치 안의 부분 실패 — 유효 프레임을 버리지 않는다

디코더가 오류마다 즉시 `return err(...)` 하면 **이미 파싱한 앞쪽 프레임들이 통째로 사라진다.** 1 WS 메시지 = N 프레임이고 배치는 여러 채널을 섞을 수 있으므로(§1.7), 한 채널의 미지 ID 때문에 다른 채널의 유효 출력이 사라진다 — 이슈 AC 의 silent drop 금지에 정면으로 걸린다.

`[설계결정]` — 오류를 **치명(fatal)** 과 **국소(scoped)** 로 나눈다.

> ⚠️ **등급은 목록이 아니라 성질로 정한다** (D13 정정, 2026-08-19). 아래 표의 코드 나열은 **성질을 적용한 결과의 예시**이지 정의가 아니다. 목록으로 읽으면 새 코드마다 같은 오분류가 반복된다 — 실제로 `payload-limit-exceeded` 가 처음에 fatal 로 분류됐다가 성질 기준으로 scoped 로 정정되었고, 국소 등급이 `unknown-channel` 하나뿐이라는 전제도 그때 무너졌다.
>
> **성질 (정의)**: *"프레이밍 자체를 신뢰할 수 없어 이후 오프셋이 무의미한가."* 그렇다면 fatal, 아니면 scoped.
>
> 이 기준의 적용 사례:
> - `payload-limit-exceeded` → **scoped.** 프레이밍이 건전하다 — `payloadLength` 가 버퍼와 일치하며(그게 `length-overrun` 과 구분되는 지점이다) `frameEnd` 를 알 수 있으므로 그 프레임만 건너뛰고 배치를 이어간다. fatal 로 두면 같은 WS 메시지의 이후 프레임을 전부 버리는데, 그것이 바로 아래 문단이 반대하는 손실 패턴이다.
> - `prologue-domain-violation` → **scoped.** 같은 이유 — `opcode` 가 레이아웃을 주고 `payloadLength` 가 버퍼와 일치한다.
> - `mandatory-flag-cleared` → **fatal.** `frameEnd` 는 알 수 있지만(레이아웃은 opcode 가 준다), 여기서 신뢰할 수 없는 것은 **한 오프셋이 아니라 피어의 인코더 전체**이고 처분은 연결 단위 재협상이다. 배치를 이어갈 실익이 없다.

| 등급 | 코드 (성질 적용 결과) | 처리 |
|---|---|---|
| **치명** — 프레이밍 자체를 신뢰할 수 없어 이후 오프셋이 무의미 | `truncated-header`, `bad-frame-version`, `unknown-opcode`, `reserved-flag-set`, `length-overrun`, `batch-terminated-early`, `batch-not-terminated`, `reserved-channel`, `binary-frame-on-json-group`, `payload-underrun`, `mandatory-flag-cleared` | **이미 파싱된 프레임을 먼저 디스패치**한 뒤 연결 단위 복구(재협상/reconnect)로 수렴 |
| **국소** — 프레이밍은 건전하고 그 프레임/채널만 문제 | `unknown-channel`, `payload-limit-exceeded`, `prologue-domain-violation` | 그 프레임만 건너뛰고 **파싱을 계속**한다. `unknown-channel` 은 해당 채널에만 fresh snapshot 요청 |

치명 등급에서도 "먼저 디스패치"가 핵심이다 — 앞쪽 프레임들은 정상적으로 검증을 통과했으므로 버릴 이유가 없다. 디코더는 `{ frames, fatal? }` 를 반환하고, 호출자가 `frames` 를 디스패치한 뒤 `fatal` 을 처리한다.

`requestReconnect` 는 이미 존재한다 — `WebSocketContext.tsx:1629-1647`, `socket.close(4001, reason.slice(0,123))`.

### 3.5 하위 계층은 이미 바이너리를 받는다

전환 비용을 낮추는 유리한 사실이다. 최종 write 어댑터가 이미 `Uint8Array` 를 받는다.

`frontend/src/utils/terminalRawMutationAdapter.ts:77-88` 의 시그니처가 `data: string | Uint8Array` 이고 xterm 의 `terminal.write()` 도 `Uint8Array` 를 받는다. 즉 **디코딩된 payload 바이트를 문자열로 되돌리지 않고 그대로 xterm 에 넘길 수 있다.**

반면 중간 계층은 string 전제다: `TerminalContainer.tsx:3350` `getUtf8ByteLength(data)`, `TerminalView.tsx:2902` `getOutputUtf8ByteLength(data)`, `frontend/src/utils/visibleOutputRecovery.ts:415` `new TextEncoder().encode(data)`, `frontend/src/utils/terminalOutputHotPath.ts:12` `outputTextEncoder.encode(raw).length`. 이들은 **바이트 길이를 구하려고 UTF-8 로 재인코딩**하는데, 바이너리에서는 길이가 이미 `payloadLength` 로 주어지므로 이 왕복이 통째로 사라진다. 이슈 원문(`19-binary-data-plane.md:14`)이 지목한 비용이 바로 이것이다.

`visibleOutputRecovery.ts:408-450` `splitVisibleOutputSourceSegments` 는 `byteStart`/`byteEnd` 로 UTF-8 오프셋 분할을 하는데, 바이너리에서는 payload 가 이미 바이트열이라 **슬라이싱이 `subarray` 한 번**이 된다.

### 3.6 서버측 JSON 역파싱 지점 — 전환 시 깨지는 곳

`wsSendPolicy` 와 `WsRouter` 에는 **큐에 든 payload 를 다시 `JSON.parse` 하는** 코드가 여럿 있다. 바이너리에서는 전부 오작동한다.

| 위치 | 하는 일 | 바이너리에서의 증상 |
|---|---|---|
| `wsSendPolicy.ts:286-295` `hasFairDeliveryIdentity` | `JSON.parse(message.payload)` 로 `connectionEpoch`/`deliverySeq`/`deliveryKind` 유무 확인 | `catch` 에서 **`true` 반환**(`:293`) → **모든 바이너리 메시지의 coalesce 가 무조건 차단** |
| `WsRouter.ts:6394-6406` `isFairTerminalDeliveryTransportMessage` | 실패 분류 | `catch` → `false` 오분류 → `safe-send-enforce` 에서 연결을 끊을 수 있음 |
| `WsRouter.ts:5534-5544`, `:5563-5571` | `discard*FairDeliveryTransport` 필터링 | 폐기 대상 식별 실패 |
| `WsRouter.ts:2551-2557` `tryParseRawMessage` | 에러 응답용 sessionId 추출 | sessionId 미검출 |

`[설계결정]` — **payload 역파싱을 전부 제거**하고, 필요한 값을 `WsTransportMessage` 의 **1급 필드로 승격**한다. `createWsTransportMessage` (`wsSendPolicy.ts:80-125`)는 이미 원본 객체(`record`)에서 10개 필드(`type`/`sessionId`/`repairToken`/`replayToken`/`screenSeq`/`authorityEpoch`/`authorityRevision`/`chunkId`/`outputData`/`sourceSegments`)를 뽑아 올려두는 구조이므로, `connectionEpoch`/`deliverySeq`/`deliveryKind` 3개를 같은 방식으로 추가하면 된다. **이 리팩터는 바이너리와 무관하게 지금도 옳다** — 직렬화된 payload 를 되읽는 것은 계층 위반이고, `hasFairDeliveryIdentity` 는 이미 파싱 실패를 `true` 로 처리하는 방어적 코드를 달고 있다.

### 3.7 lane 분류

`wsSendPolicy.ts:462-486` 이 메시지의 `type` 문자열과 `sessionId` 유무로 lane(`output` / `terminal-bulk` / `terminal-control` / `control`)을 정한다. 바이너리에서는 `type` 문자열이 없다.

`[설계결정]` — lane 은 **`opcode` 에서 직접 파생**한다. §1.3 의 opcode 표에 lane 열을 1:1 로 대응시킨다: `0x01` → `output`, `0x04`~`0x07` → `terminal-bulk`, `0x02`/`0x03` → `terminal-control`. `getControlMessageKind` (`:462-472`) 를 opcode 분기로 확장하되 **JSON 경로의 기존 문자열 분기는 그대로 둔다** — 혼합 그룹이 존재하므로 양쪽이 다 살아 있어야 한다.

두 개의 escape hatch 도 보존해야 한다: `sendPriorityControl` (`WsRouter.ts:6730-6737`, `kind='control'` 강제 덮어쓰기) 와 `sendNonCoalescingOutputChunk` (`:6740-6769`, `outputData=undefined` 로 coalesce 무력화). `REL-BGSTAB-008` 의 supersede 계약(`wsSendPolicy.ts:133-169`)이 이들에 의존한다.

---

## 4. 롤백

### 4.1 계약

두 곳이 순서를 못 박고 있다.

`00-decision-record.md:80`:
> binary epoch 종료 → 재협상 → JSON fresh snapshot. **binary 큐를 JSON 으로 재해석하지 않는다.**

`MIG-BGSTAB-002` AC-5 (`docs/spec/30.buildergate-stability.srs.md:3601`) — 이미 구현된 authority 롤백의 순서이며, 그대로 본뜬다:
> Rollback은 new admission 중지, new responder와 lease revoke, affected view stale, parser reset, 기존 ACK/backlog 폐기, **새 streamEpoch의 fresh compatibility checkpoint**와 post-snapshot output, legacy responder enable 순서로 수행해야 한다.

`REL-BGSTAB-007` AC-12 (`:2847`) 도 같은 골격이다: "Rollback은 new admission 중지, view stale, 기존 ACK/backlog 폐기, 새 stream epoch, fresh compatibility snapshot, post-snapshot output 순서로 수행하며 **byte tail을 임의 연결하지 않는다.**"

### 4.2 상태 전이도

```
        ┌─────────────────────────────────────────────────────┐
        │                    JSON (초기)                       │
        │  groupCodec = JSON,  codecEpoch = E                  │
        └────────────────────────┬────────────────────────────┘
                                 │ terminal-binary:capability accepted
                                 │ (§2.2 층2)
                                 ▼
        ┌─────────────────────────────────────────────────────┐
        │                     BINARY                           │
        │  groupCodec = BINARY, codecEpoch = E+1               │
        │  각 세션 streamEpoch += 1  (§1.6 — 채널 아님)         │
        └────────────────────────┬────────────────────────────┘
                                 │ 롤백 트리거 (§4.3)
                                 ▼
        ┌─────────────────────────────────────────────────────┐
        │                  DRAINING  (과도)                    │
        │  ① new admission 중지                                │
        │  ② codecEpoch = E+2   ← 이 대입 하나가 큐를 무효화     │
        │  ③ 그룹 전 소켓 큐 폐기 (재인코딩 아님)                │
        │  ④ in-flight settle(error='codec-epoch-retired')     │
        │  ⑤ ACK ledger / credit 폐기                          │
        │  ⑥ 영향 세션의 streamEpoch += 1 (§1.6)               │
        └────────────────────────┬────────────────────────────┘
                                 │ terminal-binary:rejected (phase='frame')
                                 │ 또는 재협상 요구
                                 ▼
        ┌─────────────────────────────────────────────────────┐
        │              JSON (fresh snapshot 대기)              │
        │  ⑦ 채널별 screen-snapshot (JSON, 새 streamEpoch)      │
        │  ⑧ snapshot 이후 output 만 전송                       │
        └─────────────────────────────────────────────────────┘
```

②가 ③보다 **먼저** 와야 한다. 순서가 바뀌면 폐기와 재개 사이에 새 프레임이 구 epoch 으로 들어온다.

### 4.3 롤백 트리거

| 트리거 | 검출 | 자동? |
|---|---|---|
| 디코드 실패 반복 | 클라이언트 `terminal-binary:rejected(phase='frame')` | 예 |
| 미지 channelId 반복 | 같음 | 예 |
| output 소켓이 non-binary 로 재접속 | `WsRouter.ts:1578-1663` 재평가 (§3.2) | 예 |
| 운영자 kill switch | 런타임 설정 | 아니오 |
| frameVersion 불일치 | subprotocol 층에서 사전 차단, in-band 는 `phase='offer'` | 예 |

### 4.4 "binary 큐를 JSON 으로 재해석하지 않는다" 의 구조적 보장

이것이 롤백 요건 중 가장 어려운 부분이다. 규율이 아니라 타입과 런타임 게이트로 막는다.

**보장 1 — 타입으로 재해석을 표현 불가능하게.**
§3.1 의 `WirePayload` 판별 유니온에서 `{codec:'binary', bytes}` 는 `text: string` 필드를 갖지 않는다. `ws.send(text)` 경로에 바이너리 메시지를 넣으려면 **없는 필드를 읽어야** 하므로 컴파일되지 않는다.

**보장 2 — `codecEpoch` 게이트를 기존 패턴으로.**
저장소에는 이미 똑같은 문제를 푼 코드가 있다. `sendRawTransportMessage` (`WsRouter.ts:6249-6258`)가 전송 **직전**에 `terminalAuthorityTransportBinding` 이 여전히 유효한지 확인하고, 아니면 보내지 않고 `settleTransportMessage(msg, Error('terminal-authority-transport-binding-replaced'))` 로 정산한다. 그리고 `:6276-6284` 는 **send 가 성공한 뒤에도** binding 이 교체됐으면 성공을 실패로 승격한다.

`codecEpoch` 에 같은 패턴을 적용한다.

```ts
// WsRouter.ts:6249 의 binding 검사 바로 아래
if (message.payload.codec === 'binary'
    && message.payload.codecEpoch !== this.groupCodecEpoch(ws)) {
  this.settleTransportMessage(message, new Error('codec-epoch-retired'));
  if (state) this.flushTransportQueue(ws);
  return;                          // 재인코딩하지 않는다. 버리고 정산한다
}
```

재인코딩 유혹을 막는 것이 핵심이다 `[설계결정]`. 바이너리 프레임을 JSON 으로 되돌리는 것은 **기술적으로는 가능하다** — 프롤로그에 필드가 다 있으니까. 그래서 금지가 필요하다. 금지 사유는 계약 문구가 아니라 정확성이다: 큐에 든 프레임들은 **구 `streamEpoch` 의 `sourceSeq` 연속열**이고, 롤백은 정의상 새 `streamEpoch` 를 발급한다(§4.2 ⑥). 구 epoch 의 조각을 새 epoch 의 스트림에 이어 붙이면 `REL-BGSTAB-007` AC-12 가 금지한 "byte tail 임의 연결"(`docs/spec/30.buildergate-stability.srs.md:2847`)이 된다.

**보장 3 — 클라이언트가 자동으로 거부한다.**
설령 위 둘을 뚫고 구 epoch 프레임이 도착해도, 클라이언트의 `terminalWriteCoordinator.ts:1127-1130` 이 `streamEpoch < current` 를 `stale-stream-epoch` 로 거부하고 `requestRecovery` 를 부른다. **3중 방어이며 가장 바깥이 이미 구현되어 있다.**

### 4.5 fresh snapshot 발행

⑦은 기존 경로를 그대로 쓴다. `startScreenRepairSnapshotRecovery(..., 'delivery-recovery', [])` 가 이미 fair delivery fallback 에서 같은 일을 한다 (`WsRouter.ts:5879-5893`). 롤백 사유만 새 값으로 추가한다.

`ScreenRepairRecoveryReason` (`ws-protocol.ts:671-679`)에 `'binary-codec-rollback'` 을 추가한다.

---

## 5. split 소켓과의 상호작용

### 5.1 계약

`FR-BGSTAB-006` (`docs/spec/30.buildergate-stability.srs.md:353`, Status=implemented, **Stability=stable**):

> The WebSocket transport shall support unified, split-shadow, and split modes. Split control connections shall receive logical group metadata and a short-lived pair token, while output connections shall be accepted only when the pair token **and authenticated identity** match the live control group.

AC-3 (`:380`): 잘못된 pair token / **잘못된 authenticated identity** / 누락된 pair field / 만료 token 이면 output 연결을 거부.

### 5.2 현재 구현

```
control 소켓 (WsRouter.ts:1666-1710)
  :1666  connectionId  = uuidv4()
  :1667  clientGroupId = (unified ? connectionId : uuidv4())
  :1689  pairToken     = uuidv4()
  :1690  pairTokenExpiresAt = Date.now() + 30_000        (30초 TTL)
  :1697  → connected {..., pairToken, pairTokenExpiresAt}

output 소켓 (WsRouter.ts:1578-1663)
  :1579  group = splitClientGroups.get(context.clientGroupId)
  :1580-1591  거부: group 없음 / mode==='unified' / pairToken 불일치 / 만료
              → close(1008, 'invalid-output-pair')
  :1592-1603  중복 output → 기존 소켓 close(1012,'output-replaced')   ← AC-4
  :1604-1605  group.output = ws
```

`SplitClientGroup` 타입 (`WsRouter.ts:292-300`): `{clientGroupId, connectionId, pairToken, pairTokenExpiresAt, mode, control, output?}`.

### 5.3 ⚠️ 발견 1 — authenticated identity 가 검증되지 않는다

`FR-BGSTAB-006` AC-3 이 요구하는 "wrong authenticated identity" 거부는 **구현되어 있지 않다.**

- 업그레이드에서 검증된 JWT payload 는 `wss.emit('connection', ws, req, result.payload, ctx)` (`WsRouter.ts:1559`)로 전달되지만, `setupConnectionHandler` 가 이를 **`_authPayload?: unknown` 으로 받고 전혀 쓰지 않는다** (`:1567`).
- `SplitClientGroup` (`:292-300`)에 identity 필드가 없다.

결과: **유효한 아무 JWT + 유출된 `clientGroupId`/`pairToken` 조합이면 타인의 output lane 에 붙을 수 있다.** 실 위험은 pairToken 이 uuidv4 이고 30초 TTL 이라 낮다 `[추측]`.

**바이너리가 이 위험을 키운다** `[설계결정]`. 바이너리 그룹에서 output 소켓은 `channelId → sessionId` 매핑이 실린 `terminal-binary:capability` 수락 응답을 받는다(§2.2). 즉 탈취자가 세션 토폴로지를 한 번에 얻는다. **`FR-BGSTAB-006` AC-3 의 identity 검증 구현을 바이너리 split 활성화의 선행 조건으로 둔다.**

### 5.4 ⚠️ 발견 2 — split 은 프로덕션에서 도달 불가하다

이것이 §6 순서 결정을 지배한다.

1. **`realtime` 이 프로덕션 WsRouter 에 주입되지 않는다.** `server/src/index.ts:1523-1527` 의 `new WsRouter(...)` 는 `resourceLimits` / `stabilityModes` / `terminalResourcePolicyAuthority` 만 넘기고 `realtime` 을 넘기지 않는다. 따라서 `WsRouter.ts:606` `this.wsTransportMode = options.realtime?.wsTransportMode ?? 'unified'` → **프로덕션은 항상 `unified`**. `realtime` 을 넘기는 곳은 테스트와 `TerminalAuthorityProductionAdapter.ts:945` 뿐이다.
2. **쿼리 파라미터 이름이 어긋난다.** 프론트는 `mode=split&channel=control` 을 보내는데(`frontend/src/utils/webSocketUrl.ts:58-59`), 서버 `handleUpgrade` 는 **`wsTransportMode`** 를 읽는다(`WsRouter.ts:1542`). 서버의 정식 파서 `wsTransportMode.ts:27 parseWsTransportRequest`(`mode` 를 읽음)는 **프로덕션에서 호출되지 않는다** — 참조는 `wsTransportMode.test.ts` 뿐이다.
3. 스키마 기본값도 `unified` (`server/src/schemas/config.schema.ts:56`), `server/config.json5` 에 `realtime` 블록 없음.

이 drift 는 `REL-BGSTAB-006` 으로 특성화되어 있고 disposition 은 **`unresolved`** 다. AC-5 (`docs/spec/30.buildergate-stability.srs.md:2527`)가 split runtime 활성화를 명시적으로 금지한다. 그리고 이 drift 를 닫는 것은 **#19 가 아니라 #3 의 몫**이라고 못 박혀 있다 (`19-binary-data-plane.md:34`, `00-decision-record.md:91`).

**결론** `[설계결정]`: **바이너리는 `unified` 에서 먼저 완성한다.** split 짝 인증 위의 바이너리는 #3 이 끝난 뒤의 별도 단계다. §2.2 의 subprotocol 층은 `unified` 에서도 그대로 동작하므로 이 순서에 구조적 장애가 없다.

### 5.5 ⚠️ 발견 3 — split-shadow 에서 payload 가 새는 경로

`WsRouter.ts:5843` 의 fair delivery 전송 대상 선택이 **mode 를 보지 않고 `group.output` 존재만 본다**:

```
splitSocketGroups.get(control)?.output ?? control
```

`FR-BGSTAB-006` AC-5 (`:382`)는 split-shadow 에서 "terminal payload 트래픽을 control 경로에서 옮기지 않은 채 output 소켓 lifecycle 만 행사" 하도록 요구한다. shadow 모드에서 fair scheduler 가 활성화되면 payload 가 output 으로 새어나간다 `[추측 — 런타임 재현은 하지 못했다]`.

바이너리 관점에서 이것이 문제인 이유: shadow 는 정의상 "output 소켓을 만들되 쓰지 않는" 모드인데, 실제로 쓰이면 §3.2 의 그룹 전체 동의 규칙이 shadow 에서도 강제되어야 한다. 즉 **바이너리 도입 전에 `:5843` 이 mode 를 보도록 고쳐야** 계약과 런타임이 일치한다.

### 5.6 바이너리 평면에서 달라지는 것

| 항목 | JSON | binary |
|---|---|---|
| pair token 검증 | 변화 없음 (`WsRouter.ts:1580-1591`) | 동일. **단 identity 검증 추가가 선행 조건** (§5.3) |
| codec 결정 | 없음 | **그룹 전체 동의** (§3.2). output 이 non-binary 면 그룹 강등 |
| `channelId` 스코프 | 없음 | **그룹 스코프** — 폴백 대비 (§1.5) |
| 폴백 (`FR-BGSTAB-007` AC-3) | control 로 재라우팅 | 동일. control 도 binary 디코더여야 성립 |
| 독립 reconnect | output `onclose` 가 ref 정리만 (`WebSocketContext.tsx:1012-1014`) — **재연결 로직 없음** | output 재연결 시 subprotocol 재협상 → 결과가 다르면 §4 codecEpoch 전환 |
| `terminalAuthorityTransportBinding` | `{connectionId, lane, bindingId}` (`wsSendPolicy.ts:37-41`) | 변화 없음. codecEpoch 검사를 **같은 자리에** 추가 (§4.4) |

`splitWebSocketLifecycle.ts` 는 **사장 코드**임을 확인했다 — `shouldFlushControlSubscriptions()` (`:15-27`) 와 `resolveSplitOutputCloseAction()` (`:29-34`) 둘 다 프로덕션 호출자가 0건이고, 참조는 `frontend/tests/unit/splitWebSocketLifecycle.test.ts` 와 문서뿐이다. 실제 output 소켓 lifecycle 은 `WebSocketContext.tsx:1000-1019` 에 인라인으로 다시 구현되어 있고 재연결·폴백이 없다. **바이너리를 output 채널에 얹으려면 이 lifecycle 완성이 선행한다.**

---

## 6. 선행 조건과 순서

결정 기록 §4 (`00-decision-record.md:89-93`)의 선행 작업에, 이 조사에서 추가로 확인된 것을 더한다.

| # | 항목 | 근거 | 왜 선행인가 |
|---|---|---|---|
| 1 | wave-5 SRS 신규 저작 | `00-decision-record.md:82` | wave-5 요구사항 0건. `REL-BGSTAB-007` AC-11 (`:2846`)이 별도 Requirement 를 면제하지 않는다 |
| 2 | `REL-BGSTAB-007` AC-4 개정 | `00-decision-record.md:59` | 바이너리 ordinal 표현. 최소 개정안은 §1.4 |
| 3 | payload 역파싱 제거 | §3.6 | `hasFairDeliveryIdentity` 가 바이너리에서 **모든 coalesce 를 차단**. 바이너리와 무관하게 지금도 옳은 리팩터 |
| 4 | `PERF-BGSTAB-010` 재벤치 | §2.4 | 정책값이 JSON 바이트 기준. `AC-3`/`AC-4`가 아티팩트 재발행을 요구 |
| 5 | `isBinary` 인자 도입 | §3.3 | 없으면 서버가 바이너리를 조용히 버린다 |
| 6 | `binaryType='arraybuffer'` | §3.4 | Blob 기본값은 비동기 → 순서 붕괴 |
| 7 | `#3` split drift 종결 | `00-decision-record.md:91`, §5.4 | **단 `unified` 바이너리의 선행은 아니다** — split 단계의 선행이다 |
| 8 | `FR-BGSTAB-006` AC-3 identity 검증 | §5.3 | split 단계 선행 |
| 9 | `WsRouter.ts:5843` mode 검사 | §5.5 | split 단계 선행 |
| 10 | `FR-BGSTAB-017` recovery write gate | `00-decision-record.md:93` | snapshot/repair write 일부가 live scheduler 를 우회 |
| 11 | **인덱스 `0` 의 의미 확정** `[미확인]` | §1.8 (D15) | `07` §8.2 의 "1-based, `0` = absent" 규칙을 채택할지. **기존 골든 벡터 `output-minimal-52` 가 `authorityEpochIndex = 0`** 이라 소급 적용 시 그 벡터의 의미가 바뀐다. 확정 전까지 인코더/디코더는 이 슬롯에 의미를 부여하지 않는다. 미채택 시 대안은 `0x04` `flags2` bit4 를 `AUTHORITY_EPOCH_PRESENT` 로 쓰는 것 |

`[설계결정]` — 1~6 과 11 은 `unified` 바이너리의 선행이고, 7~9 는 split 바이너리의 선행이다. **두 묶음을 분리하면 #3 완료를 기다리지 않고 착수할 수 있다.**

### 검증 불가 사항 — TDD 관점

결정 기록 `:77` 이 "모든 동작 변경은 실패 테스트 선행" 을 못 박았다. 프레임 포맷은 순수 함수(인코더/디코더)이므로 테스트가 쉽다. 다만 다음 두 가지는 주의한다.

- **인코더/디코더는 서버·프론트 두 벌이 된다.** `server/src/types/ws-protocol.ts:4` 주석대로 프론트에 복제본이 있고, 실제로 두 복제본은 이미 어긋나 있다(§1.3 의 `terminal-authority:*` 12종). **차분 테스트(서버 인코딩 → 프론트 디코딩 → 원본 대조)를 라운드트립으로 강제**하지 않으면 같은 종류의 drift 가 반복된다.
- **`Ordinal64 = string` 은 브랜디드 타입이 아니다** (`ws-protocol.ts:16`). 생성 지점이 전부 `as Ordinal64` 단순 캐스트다 (`SessionManager.ts:4390-4391`, `:7879-7880`, `:8115-8116`). 컴파일러가 잘못된 대입을 막지 못하므로 **런타임 단언을 인코더 입구에 둔다** — `isCanonicalOrdinal64` (`:969`) 를 그대로 쓴다.

---

## 부록 A — 확정 프레임 요약 (구현용)

```
frame v1 (big-endian, header 28B)

 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  frameVersion |    opcode     |             flags             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                          channelId                            |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                      streamEpoch (uint64)                     +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
+                       sourceSeq (uint64)                      +
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        payloadLength                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     payload (payloadLength B)                 |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

flags: bit0 END_OF_BATCH      (마지막 프레임에 필수)
       bit1 PAYLOAD_UTF8_TEXT
       bit2 reserved          (CONTINUATION 후보 — v1 미사용, §1.2)
       bit3 PROLOGUE_PRESENT
       bit2, bit4-15 reserved
       서버는 협상된 activeFlagMask 밖의 비트를 세우지 않는다 (§1.2)
       ⚠️ 프레임별 필수 비트는 bit3 뿐이다. MANDATORY_FLAGS(bit0|bit3)는 협상 불변식이며
          디코더 술어로 쓰지 않는다 — 쓰면 배치 중간 프레임이 전부 거부된다 (§1.2 D14)

한 WS 메시지 = 1..N 프레임. 마지막 프레임은 반드시 END_OF_BATCH.
  EOB 인데 마지막이 아님  → batch-terminated-early
  마지막인데 EOB 없음     → batch-not-terminated
배치 총 바이트 <= policy.bulkSliceBytes (wsSendPolicy.ts:521)
배치는 단일 lane 으로 제한 (부록 B2)

프롤로그 (PROLOGUE_PRESENT 시):
  0x01 OUTPUT           24B  screenSeq u64 | chunkIdBase u64 |
                             authorityRevision u32 | authorityEpochIndex u16 |
                             segmentCount u16
        + segment × N   16B  byteStart u32 | byteEnd u32 | screenSeqDelta u32 |
                             authorityRevisionDelta u16 | chunkIdDelta u16
  0x02 SCREEN_SNAPSHOT  24B  seq u64 | cols u16 | rows u16 | mode u8 |
                             truncated u8 | flags2 u16 | authorityRevision u32 |
                             authorityEpochIndex u16 | replayTokenIndex u16
  0x05 CHECKPOINT_CHUNK 12B  chunkIndex u32 | chunkCount u32 | viewGeneration u32

  0x03 SCREEN_REPAIR     24B  ─┐
  0x04 CHECKPOINT_START 160B   │ 필드 배치는 07 §1.6 / §2.9 / §3.4 / §4.3 을 참조편입한다
  0x06 CHECKPOINT_COMMIT 88B   │ (§1.8 — 여기에 복제하지 않는다. 충돌 시 §1.8 이 이긴다)
  0x07 CHECKPOINT_OUTPUT 12B  ─┘

프롤로그 불변식 (7종 전체, §1.8 소유):
  - 프롤로그 길이는 opcode 만의 함수다. flags 에 의존시키지 않는다
  - checkpoint 계열(0x04/0x05/0x06/0x07) 프롤로그 오프셋 8..11 = viewGeneration u32
  - 0x04 와 0x06 의 프롤로그 오프셋 0..15 는 동일
  - checkpoint 평면 ordinal 은 헤더 값과 다르며 checkpointSourceSeq/checkpointStreamEpoch 로 구분
  - flags2 는 opcode 별 확장 비트필드다. 고정 오프셋이 아니다
  - PAYLOAD_UTF8_TEXT(bit1)를 세우는 opcode 는 v1 에서 0x01 뿐이다
  - 인덱스 필드(authorityEpochIndex/replayTokenIndex/repairTokenIndex)의 0 은 [미확인] — §1.8
```

## 부록 B — 디코더 의사코드

```
// 반환: { frames, fatal? }. 호출자는 fatal 이 있어도 frames 를 먼저 디스패치한다 (§3.4)
decodeWsMessage(buf: ArrayBuffer, group: GroupState): { frames: Frame[], fatal?: string }
  if group.codec !== BINARY:            return { frames: [], fatal: 'binary-frame-on-json-group' }
  const dv = new DataView(buf)
  const frames = []
  let off = 0

  while off < buf.byteLength:
    if buf.byteLength - off < 28:       return fatal(frames, 'truncated-header')

    const version = dv.getUint8(off)
    if version !== group.frameVersion:  return fatal(frames, 'bad-frame-version')

    const opcode = dv.getUint8(off + 1)
    if not isKnownOpcode(opcode):       return fatal(frames, 'unknown-opcode')

    const flags = dv.getUint16(off + 2)          // big-endian 기본
    // 협상된 마스크 밖의 비트는 전부 거부 (§1.2). v1 activeFlagMask = 0x000B 이므로
    // bit2(미사용 예약)와 bit4-15 가 함께 걸린다.
    if (flags & ~group.activeFlagMask) !== 0:
                                        return fatal(frames, 'reserved-flag-set')

    const channelId = dv.getUint32(off + 4)
    if channelId === 0:                 return fatal(frames, 'reserved-channel')

    // 길이·배치 경계는 채널 상태와 무관하게 항상 먼저 검증한다.
    // (RETIRED 를 먼저 처리하면 검증 없이 payloadLength 로 점프하게 된다)
    const payloadLength = dv.getUint32(off + 24)
    if off + 28 + payloadLength > buf.byteLength:
                                        return fatal(frames, 'length-overrun')

    const isLast = (off + 28 + payloadLength) === buf.byteLength
    const hasEob = (flags & END_OF_BATCH) !== 0
    if hasEob and not isLast:           return fatal(frames, 'batch-terminated-early')
    if isLast  and not hasEob:          return fatal(frames, 'batch-not-terminated')

    const channel = group.channels.get(channelId)
    if channel === undefined:                       // FREE 또는 처음 보는 값 — 국소 오류
        requestChannelRecovery(channelId, 'unknown-channel')
        off += 28 + payloadLength                   // 이 프레임만 건너뛰고 계속 (§3.4)
        continue
    if channel.state === RETIRED:
        // 조용히 건너뛰되 관측은 남긴다. 복구를 요청하지 않는다 (§1.5)
        recordDiagnostic('terminal_binary_retired_channel_frame', channelId)
        off += 28 + payloadLength
        continue

    // hi-word 단축 (§1.4 완화 2 — 선택적 최적화).
    // 완화 1 만 적용하는 1단계에서는 readOrdinal64 가 항상 bigint value 를 만들고,
    // compareOrdinal/equalsOrdinal 은 그대로 쓴다 (헬퍼 경유는 두 단계 모두 강제)
    const streamEpoch = readOrdinal64(dv, off + 8)
    const sourceSeq   = readOrdinal64(dv, off + 16)

    frames.push({
      opcode, flags, channelId, streamEpoch, sourceSeq,
      payload: new Uint8Array(buf, off + 28, payloadLength),   // 복사 없음
    })

    off += 28 + payloadLength

  return { frames }


// §1.4 완화 2 — 2^32 미만이면 BigInt 를 만들지 않는다.
// value 는 number | bigint 이며, 비교는 반드시 compareOrdinal 을 거친다.
readOrdinal64(dv, off): ParsedOrdinal64
  const hi = dv.getUint32(off)
  const lo = dv.getUint32(off + 4)
  if hi === 0:
    return Object.freeze({ value: lo, isBig: false, get wire() { return String(lo) } })
  const v = (BigInt(hi) << 32n) | BigInt(lo)
  return Object.freeze({ value: v, isBig: true, get wire() { return v.toString(10) } })

// 혼합 표현 비교 — number/bigint 를 직접 <,> 로 비교해도 JS 에서는 안전하지만
// (관계 연산자는 혼합 피연산자를 허용) === 는 안전하지 않으므로 명시 함수를 쓴다.
compareOrdinal(a: ParsedOrdinal64, b: ParsedOrdinal64): -1 | 0 | 1
  if a.isBig === b.isBig:  return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  return a.isBig ? 1 : -1        // big 쪽이 2^32 이상이므로 항상 크다

equalsOrdinal(a, b): boolean
  return a.wire === b.wire       // identity 비교는 항상 wire 문자열로
                                 // (terminalWriteCoordinator.ts:662-667 과 동일 규약)

isZero(a): boolean          return a.isBig ? a.value === 0n : a.value === 0
isOrdinalMax(a): boolean    return a.isBig and a.value === ORDINAL64_MAX
// terminalWriteCoordinator.ts:1136 의 rollover 판정은
//   isOrdinalMax(latestSourceSeq) and isZero(sourceSeq)
// 로 치환한다 — 1 === 1n 이 false 인 함정을 피한다 (§1.4)
```

디스패치는 기존 상태기계에 그대로 물린다.

```
dispatch(frame, group):
  const channel = group.channels.get(frame.channelId)

  // frontend/src/utils/terminalWriteCoordinator.ts:1118-1151 를 그대로 재사용
  const verdict = channel.coordinator.verifyOrdinals(frame.streamEpoch, frame.sourceSeq)
  if verdict.rejected:
    // stale-stream-epoch / fresh-checkpoint-required /
    // ordinal64-rollover / non-monotonic-source-seq
    return channel.requestRecovery(verdict.reason)

  switch frame.opcode:
    case OUTPUT:            // 프롤로그 24B 파싱 후
                            // terminalRawMutationAdapter.ts:82 로 Uint8Array 직행
                            // (TextDecoder 불필요 — §3.5)
    case SCREEN_SNAPSHOT:   // 기존 handleScreenSnapshot (TerminalContainer.tsx:2385)
    case CHECKPOINT_CHUNK:  // base64 디코딩 단계를 건너뛰고 바로 청크 조립
    ...
```

## 부록 B2 — 인코더 · 배치 조립기 · 채널 할당기 의사코드

```
encodeFrame(msg, channel, out: GrowableBuffer): Ordinal64   // 사용한 sourceSeq 반환
  const opcode = OPCODE_BY_TYPE[msg.type]
  assert(opcode !== undefined)                  // control 평면이면 여기 오지 않는다

  // Ordinal64 단언은 인코더 입구에서 1회. Ordinal64 는 브랜디드 타입이 아니므로
  // 컴파일러가 막아주지 않는다 (ws-protocol.ts:16, §6 참조)
  assert(isCanonicalOrdinal64(sessionManager.streamEpochOf(channel.sessionId)))
  const sourceSeq = channel.nextSourceSeq()     // advanceRetainedTerminalOrdinal 규약
  assert(isCanonicalOrdinal64(sourceSeq))

  const prologue = buildPrologue(opcode, msg, channel)   // §1.8
  const body     = bodyBytes(opcode, msg)                // output: Buffer.from(data,'utf8')
                                                         // checkpoint: base64 decode
  let flags = PROLOGUE_PRESENT
  if opcode === OUTPUT: flags |= PAYLOAD_UTF8_TEXT
  flags &= channel.group.activeFlagMask            // §1.2 — 협상 밖 비트는 절대 세우지 않는다

  const head = out.reserve(28)
  head.setUint8 (0,  FRAME_VERSION)
  head.setUint8 (1,  opcode)
  head.setUint16(2,  flags)
  head.setUint32(4,  channel.channelId)
  writeOrdinal64(head, 8,  sessionManager.streamEpochOf(channel.sessionId))  // 세션에서 매번 읽는다
  writeOrdinal64(head, 16, sourceSeq)
  head.setUint32(24, prologue.length + body.length)
  out.append(prologue); out.append(body)
  return sourceSeq


// 배치 = fair scheduler 의 DRR quantum 하나. 새 상수를 만들지 않는다 (§1.7)
flushBatch(ws, group, scheduler): void
  const limit = policy.bulkSliceBytes.value              // wsSendPolicy.ts:521
  const out = new GrowableBuffer()
  const settled = []                                    // 이 배치가 대표하는 delivery 들
  let lastFrameStart = -1

  // 배치는 단일 lane 으로 제한한다 — 한 배치에 output 과 terminal-bulk 가 섞이면
  // WsTransportMessage.kind 를 하나로 정할 수 없어 예산 회계가 깨진다 (§3.7)
  const batchLane = laneOf(OPCODE_BY_TYPE[scheduler.peekNext()?.message.type])
  if batchLane === undefined: return

  while out.length < limit:
    const delivery = scheduler.peekNext()
    if delivery === undefined: break
    if laneOf(OPCODE_BY_TYPE[delivery.message.type]) !== batchLane: break   // lane 경계에서 끊는다
    if out.length + estimateSize(delivery) > limit and out.length > 0: break
    scheduler.take()
    lastFrameStart = out.length
    const channel = group.channelOf(delivery.sessionId)
    const sourceSeq = encodeFrame(delivery.message, channel, out)   // 사용한 sourceSeq 를 반환
    delivery.sourceSeq = sourceSeq                      // §2.4(c) — lane.sent 정산 키
    settled.push(delivery)

  if settled.length === 0: return
  out.setFlagBit(lastFrameStart + 2, END_OF_BATCH)      // 마지막 프레임에만. 필수 (§1.2)
                                                        // bit0 은 MANDATORY 라 마스크 대상 아님

  const message = {
    payload: { codec: 'binary', bytes: out.bytes(), codecEpoch: group.codecEpoch },
    byteLength: out.length,                             // ACK/백프레셔 도메인 (§2.4)
    kind: batchLane,                                    // §3.7
    sourceSeq: settled[settled.length - 1].sourceSeq,   // 누적 ACK 기준 (§2.4(c))
    sessionId: settled[0].sessionId,                    // 배치는 단일 채널로 제한되지 않으므로
                                                        // 정산은 sourceSeq 로 한다
    onSettled: (err) => { for (const d of settled) scheduler.settleTransport({...d, error: err}) },
  }
  sendTransportMessage(ws, message)                     // WsRouter.ts:6077 로 합류


// 채널 할당 — 그룹 스코프, codecEpoch 안에서 재사용 금지 (§1.5 규칙 2)
// group.bySession: Map<sessionId, channelId>   (number 를 담는다)
// group.channels:  Map<channelId, { channelId, sessionId, state, retiredAt? }>
allocateChannel(group, sessionId): number
  const existingId = group.bySession.get(sessionId)
  if existingId !== undefined:
      const existing = group.channels.get(existingId)
      if existing?.state === ACTIVE: return existingId

  if group.nextChannelId > 0xFFFFFFFF:                  // 마지막 유효값은 0xFFFFFFFF
      bumpCodecEpoch(group, 'channel-space-exhausted')  // §4 — 전 채널 fresh snapshot.
                                                        // nextChannelId 를 1 로 리셋하고
                                                        // channels/bySession 을 비운다
      // 리셋 후에는 반드시 성공하므로 재귀는 최대 1회다

  const channelId = group.nextChannelId++               // 단조. FREE 를 재사용하지 않는다
  group.channels.set(channelId, { channelId, sessionId, state: ACTIVE })
  group.bySession.set(sessionId, channelId)
  return channelId

// RETIRED → FREE 스윕. 유예가 지난 엔트리를 실제로 제거해야
// 이후 프레임이 unknown-channel 복구 경로로 넘어간다 (§1.5)
sweepRetiredChannels(group, now): void
  for (const ch of group.channels.values()):
      if ch.state === RETIRED and now - ch.retiredAt >= RETIRE_GRACE_MS:   // 30s
          group.channels.delete(ch.channelId)           // 이제 FREE. id 는 재사용 안 함

retireChannel(group, channelId, reason): void
  const ch = group.channels.get(channelId)
  if ch === undefined: return
  ch.state = RETIRED
  ch.retiredAt = now()                                  // 30s 유예 후 FREE (§1.5)
  group.bySession.delete(ch.sessionId)
  if reason !== 'client-unsubscribe':
      sendJson(group.control, { type: 'terminal-binary:channel-retired',
                                channelId: [channelId], reason })
```

## 부록 C — 이슈 AC 대응표

`docs/issues/wave4-wave5/19-binary-data-plane.md:169-187` 의 완료 조건 대응.

| AC | 이 문서의 대응 |
|---|---|
| control 은 JSON, output/snapshot 만 versioned binary | §1.3 분류표 (전수 열거). `frameVersion` §1.1 |
| frame 에 channelId / streamEpoch / sourceSeq / payload length / opcode, ACK credit 은 encoded byte 단일 domain | §1.1 오프셋 표, §1.5 channelId, §1.4 ordinal, §1.7 length, §2.4 ACK 도메인 |
| capability handshake / old-new downgrade / split pair auth / 독립 reconnect | §2 (2단 협상), §2.5 (downgrade 경로), §5 (split — **identity 검증 미구현 발견**), §5.6 (독립 reconnect — **현재 미구현 발견**) |
| unsupported/mixed-version frame 은 silent drop 없이 JSON snapshot downgrade 또는 명시적 reconnect 로 수렴 | §3.1 (구조적 보장), §3.3/§3.4 (양측 silent drop 지점 제거), §3.2 (그룹 전체 동의) |
| rollback 은 binary epoch 종료 → 재협상 → JSON fresh snapshot, binary 큐를 JSON 으로 재해석 금지 | §4.2 전이도, §4.4 3중 방어 |
