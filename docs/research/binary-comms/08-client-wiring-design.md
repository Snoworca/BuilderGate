# S4 클라이언트 배선 — 실행 설계

| 항목 | 값 |
|---|---|
| 작성일 | 2026-08-19 |
| 상위 계획 | `docs/research/binary-comms/06-work-plan.md` §5 S4 (`06:1386-1503`) |
| 선행 정본 | `03-client-decode-path.md`(클라이언트 사실 지도) · `01-frame-format-and-negotiation.md`(프레임·협상) · `06` §3.5(결정 SSOT) · §4(확정 설계 결정) |
| 전제 | S1(사이드카 승격) 완료 · S2(코덱 모듈 + 골든 벡터) 완료 |
| 범위 | **S4 의 클라이언트 측 배선 실행 설계.** 서버 인코드 표면(S4-a)은 범위 밖 — 접점만 명시 |
| 산출 | 이 문서 1개. **코드 변경 0 · 테스트 실행 0 · 빌드 실행 0** |

표기: 모든 참조는 repo-relative `경로:라인`. 저장소에서 확인하지 못한 것은 **[미확인]**, 이 문서의 판단은 **[설계결정]**, 근거 있는 추정은 **[추정]**, 근거가 약한 것은 **[추측]**.

---

## 0. 요약 — 이 연구가 확정한 것

1. **`onOutput` 은 "재작성" 이 아니라 "IR 도입 + 어댑터 2개" 로 푼다.** `TerminalContainer.tsx:3192-3443` 을 정독한 결과 **책임 6개 중 codec 에 실제로 의존하는 것은 1개**(세그먼트 분할, `:3214`/`:3302`/`:3388`)뿐이다. 나머지 5개는 `data:string` 대신 `{data, byteLength}` 를 받으면 그대로 공유된다. JSON/바이너리 공유율은 코드 라인 기준 **[추정] 90% 이상**이다 (§1).

2. **`authorityEpochIndex ↔ UUID` 매핑의 교차평면 순서 위험(`03:181` `[미확인]`)은 도달 불가다 — 판정 완료.** `authorityEpoch` 는 `server/src/services/SessionManager.ts:1252` 에서 세션 생성 시 `uuidv4()` 로 **딱 한 번** 배정되며 서버 프로덕션 소스 전체에 재배정이 **0건**이다(전수 grep). 매핑은 `channelId` 와 **같은 JSON 메시지**(`01:374-385` `SubscribedSessionInfo`, `01:725-737` `terminal-binary:capability.channels[]`)로 오고, 미지 `channelId` 프레임은 프롤로그를 읽기 **전에** `unknown-channel` 로 scoped 거부된다(`server/src/ws/binaryFrameCodec.ts:956-962`). 따라서 "매핑 없이 인덱스를 쓰는 프레임" 은 구조적으로 존재할 수 없다 (§2.1).

3. **ACK 도메인 전환은 S4 에 넣으면 안 된다 — S4 가 `binary-shadow`(관측 동작 불변)이기 때문이다.** 그리고 전환 자체가 클라이언트 작업이 아니다: `sourceSeq` 는 `server/src/ws/wsSendPolicy.ts` 에 **0회** 등장하고(전수 grep), `TerminalOutputMessage`(`frontend/src/types/ws-protocol.ts:780-801`)에도 **없다**. 서버 원장은 `deliverySeq` 키 전용이다(`wsSendPolicy.ts:838-853`). `01:762` 가 요구한 `WsTransportMessage.sourceSeq` 1급 승격은 **S1 에서 이뤄지지 않았다**(`wsSendPolicy.ts:85-131` 의 승격 필드는 `connectionEpoch`/`deliverySeq`/`deliveryKind` 3개뿐) (§3).

4. **xterm 혼류 순서 뒤집힘은 번들 수준에서 확인됐다.** `@xterm/headless@6.0.0` 번들에 `"string"==typeof e ? this._stringDecoder.decode(...) : this._utf8Decoder.decode(...)` 삼항이 **write 청크마다** 있고 그 직후 `this._parser.parse(...)` 가 즉시 돈다. 즉 `interim` 보류 바이트는 뒤이은 string write **뒤로** 밀린다. 그러나 **현행 프로덕션에서 이 조건은 도달하지 않는다** — 라이브 경로의 모든 바이트 write 는 `findUtf8SliceEnd`(`frontend/src/utils/terminalOutputScheduler.ts:2016-2047`)로 코드포인트 정렬되고, 정렬되지 않은 유일한 바이트 write(체크포인트 body 슬라이스 `frontend/src/utils/terminalWriteCoordinator.ts:1093-1097`)는 코디네이터가 **연속 실행을 보장**해 사이에 다른 write 가 끼지 못한다 (§4).

5. **프론트 코덱은 서버 코덱을 import 하지 않는다. 공유하는 것은 골든 벡터 파일 1개뿐이다.** 저장소에 **정확한 선례**가 있다 — `frontend/tests/unit/wsCheckpointProtocol.test.ts:184` 의 `readFileSync(new URL('../../../server/src/types/ws-protocol.ts', import.meta.url), 'utf8')`. 같은 상대경로 형태로 `server/src/ws/__fixtures__/binary-frame-vectors.json` 을 읽는다 (§5).

6. **S4 클라이언트 작업은 하위 6단계(S4-C1~C6)로 쪼갤 수 있고, 그중 4개는 프로덕션 동작 변화가 0이다.** `binary-shadow` 는 와이어에 JSON 만 내보내므로(`06:1457`) 클라이언트 바이너리 경로는 **S5 opt-in 까지 프로덕션에서 한 번도 실행되지 않는다.** 이것이 난이도 L 을 착수 가능하게 만드는 핵심 지렛대다 (§6).

7. **핀: `canary-admission-evidence.test.mjs:52`/`:53` 이 `TerminalView.tsx`/`TerminalContainer.tsx` 를 고정한다는 것은 사실이며, S4 클라이언트 작업은 P2 `productionSourcePaths` **18개 중 6개**를 건드린다 → **재발행 필수**. 그러나 워킹트리가 이미 그 6개 전부를 dirty 상태로 갖고 있어(`git status --porcelain`) P2 는 **S4 착수 이전에 이미 stale** 이다 — `06` §S1 잔여처분 M-1 이 예고한 상태다 (§7).

---

## 1. 과제 1 — `onOutput` 재작성 방안 확정

### 1.1 현행 핸들러의 책임 분해 (`TerminalContainer.tsx:3192-3443`, 252줄)

핸들러는 **하나의 함수 안에 상호배타적인 3개 모드 + 공통 후반부**로 되어 있다. 정독 결과:

| # | 책임 | 라인 | 모드 | codec 의존 |
|---|---|---|---|---|
| **R1** | compatibility post-ack 수렴 게이트 — 런타임 신원 검사(`:3195`), replayToken 대조(`:3199`), 청크별 `advanceTerminalCompatibilityPostAckConvergence`(`:3228`), `writeRecoveryTailAndWait`(`:3247`), drain 후속(`:3249-3278`) | `:3193-3281` | 배타 (진입 시 `return`) | **간접** — `getUtf8ByteLength(chunk.data)` `:3238`, `writeRecoveryTailAndWait(chunk.data)` `:3247` |
| **R2** | visible-output resync 게이트 — 세대 검사(`:3284-3293`), repairToken 대조(`:3305`), `classifyVisibleResyncOutputBatch`(`:3318`), `restoreAdapter.handle({data})`(`:3334-3342`) | `:3282-3349` | 배타 (진입 시 `return`) | **간접** — `chunk.data` 를 `restoreAdapter` 에 전달 `:3340` |
| **R3** | hidden-output 정책 + 바이트 회계 + 디버그 이벤트 | `:3350-3375` | 공통 | **간접** — `getUtf8ByteLength(data)` `:3350`, `resolveHiddenOutput({data})` `:3355`, 디버그 preview `:3366` |
| **R4** | delivery identity 추출 (`connectionEpoch`+`deliverySeq`) | `:3377-3379` | 공통 | **없음** |
| **R5** | **세그먼트 분할** | `:3214` · `:3302` · `:3381-3388` | 3모드 전부 | **직접** — 유일 |
| **R6** | dispatch + ACK refcount — 무세그먼트 fallback(`:3390-3412`), 청크별 `submitOutput`(`:3433-3441`), `remainingAcceptedChunks` 감산 ACK(`:3414-3432`) | `:3389-3442` | 공통 | **간접** — `submitOutput(chunk.data, …)` |

**"간접" 의 의미**: 그 코드가 `string` 이라는 표현을 필요로 하는 게 아니라, **바이트 길이**(R1 `:3238`, R3 `:3350`) 또는 **하류 write 계약**(R1 `:3247`, R2 `:3340`, R6 `:3434`)을 필요로 할 뿐이다. 하류는 이미 `string | Uint8Array` 를 받을 수 있는 곳까지 뚫려 있다(`frontend/src/utils/terminalOutputScheduler.ts:18` `TerminalOutputWriteData`, 어댑터 계약 `frontend/src/utils/terminalWriteCoordinator.ts:1045-1051`).

**진짜로 `string` 이어야 하는 곳은 두 군데뿐이다.**

| 위치 | 왜 | 처분 |
|---|---|---|
| `resolveHiddenOutput` 의 `data` (`frontend/src/utils/terminalHiddenOutput.ts:44`, 소비 `:70-74`) | `appendDebugTail` 이 문자 단위로 tail 을 자른다(`:131-152`) | **`hiddenOutputPolicy === 'debug-tail'` 일 때만 필요.** `:73` 이 다른 정책에서 `maxBytes = 0` 을 넘기고 `:131-133` 이 즉시 `''` 을 반환한다 → 기본값 `snapshot-restore`(`:49`)에서는 **문자열이 아예 쓰이지 않는다.** 콜드 경로 지연 디코드 |
| 디버그 preview 인자 (`TerminalContainer.tsx:3366`, `:3373`) | `formatPreview`(`frontend/src/utils/terminalDebugCapture.ts:441-448`)가 문자열 슬라이스 | `isTerminalDebugCaptureEnabled(sessionId)`(`terminalDebugCapture.ts:390`)가 이미 export 되어 있다 → **활성일 때만** 앞 N 바이트를 디코드 |

### 1.2 [설계결정] IR(중립 표현) 1개 + 어댑터 2개

`§10.2 중복 금지`와 `§10.3 의존 방향`을 동시에 만족하는 구조는 하나다 — **codec 이 만든 값을 codec-중립 타입으로 올린 뒤, 그 아래로는 분기가 존재하지 않게 한다.**

```ts
// frontend/src/utils/terminalOutputDelivery.ts  (신규)

/** 한 개의 논리 출력 조각. data 의 표현은 codec 이 정하고 그 아래는 모른다. */
export interface TerminalOutputDeliveryChunk {
  readonly data: TerminalOutputWriteData;        // scheduler.ts:18 재사용 (새 타입 만들지 않음)
  readonly byteLength: number;                   // 이미 알고 있는 값. 재인코딩 금지
  readonly screenSeq?: number;
  readonly authorityEpoch?: string;              // 바이너리에서는 index→UUID 복원 결과 (§2.1)
  readonly authorityRevision?: number;
  readonly chunkId?: string;                     // 바이너리에서는 String(base+delta) (01:506, 01:510)
}

export interface TerminalOutputDelivery {
  readonly codec: 'json' | 'binary';
  readonly whole: TerminalOutputDeliveryChunk;   // 세그먼트 미적용 전체
  readonly chunks: readonly TerminalOutputDeliveryChunk[] | null;  // null = 세그먼트 불성립
  readonly hasSourceSegments: boolean;           // `sourceSegments === undefined` 분기 보존용
  readonly replayToken?: string;
  readonly repairToken?: string;
  readonly ack?: { readonly connectionEpoch: string; readonly deliverySeq: number };
  /** debug-tail 정책·디버그 캡처 활성 시에만 호출된다. 그 외에는 절대 호출하지 않는다. */
  readonly previewText: () => string;
}
```

어댑터 2개:

| 어댑터 | 위치 | 하는 일 |
|---|---|---|
| `fromJsonOutputMessage(data: string, msg: TerminalOutputMessage)` | 같은 파일 | `chunks` = `msg.sourceSegments === undefined ? [whole] : splitVisibleOutputSourceSegments(data, msg.sourceSegments)` (`frontend/src/utils/visibleOutputRecovery.ts:408-452` 그대로 재사용). `byteLength` = `getOutputUtf8ByteLength(data)`(`frontend/src/utils/terminalOutputHotPath.ts:11-13`). `previewText = () => data` |
| `fromBinaryOutputFrame(msg: OutputWireMessage, epochs: AuthorityEpochTable)` | 같은 파일 | `chunks` = `msg.segments.map(s => ({ data: msg.body.subarray(s.byteStart, s.byteEnd), byteLength: s.byteEnd - s.byteStart, … }))`. `byteLength` = `msg.body.byteLength`. `previewText = () => new TextDecoder().decode(msg.body.subarray(0, PREVIEW_BYTES))` |

**이로써 R1~R4, R6 은 한 줄도 분기하지 않는다.** R5 는 어댑터 안으로 사라진다.

### 1.3 세그먼트 분할이 왜 유일한 codec 의존인가 — 그리고 바이너리 쪽이 왜 더 단순한가

`splitVisibleOutputSourceSegments`(`visibleOutputRecovery.ts:408-452`)는 두 가지를 한다.

1. **검증** — `:417-438`: 세그먼트가 `byteStart=0` 부터 **빈틈없이 연접**하고 마지막이 정확히 `encoded.byteLength` 여야 한다(`:421`, `:434`, `:436`). 위반 시 `null`.
2. **왕복** — `:415` `new TextEncoder().encode(data)` (호출마다 인코더 신규 할당) → `:443` `decoder.decode(encoded.subarray(...))`.

바이너리에서는 **2가 통째로 사라지고 1만 남는다.** 그리고 1의 일부는 이미 코덱이 했다 — `binaryFrameCodec.ts:922-929` 이 `payloadLength` 대비 `24 + 16*segmentCount` 하한을 강제하고, `parseFrameMessage`(`:1000-1037`)가 `body` 를 세그먼트 배열 뒤부터 잘라낸다. 남는 검증은 **연접성과 `byteEnd === body.byteLength`** 뿐이다.

> ⚠️ **연접성 검증을 바이너리에서 생략하면 안 된다.** `binaryFrameCodec.ts:1013-1025` 의 세그먼트 파싱은 `byteStart`/`byteEnd` 를 **읽기만** 하고 관계를 검사하지 않는다. JSON 경로가 `visibleOutputRecovery.ts:421`/`:434`/`:436` 으로 지키던 불변식이 바이너리에서 조용히 사라진다. **[설계결정] 검증 로직은 두 어댑터가 공유하는 순수 함수로 추출한다** — `assertContiguousSegments(segments, totalBytes): boolean`. 이 함수 하나가 JSON 의 `:417-438` 과 바이너리 어댑터 양쪽에서 호출되어야 §10.2 를 만족한다.

### 1.4 하류로 내려보내야 하는 시그니처 확장 (`string` → `TerminalOutputWriteData`)

R1/R2/R6 이 IR 을 그대로 흘려보내려면 아래 6개 진입점이 바이트를 받아야 한다. **전부 이미 `Uint8Array` 를 받는 구간의 바로 위층이다.**

| # | 진입점 | 현재 | 필요한 변경 | 난이도 |
|---|---|---|---|---|
| 1 | `TerminalView.tsx:246` `submitOutput(data: string, …)` | string | `TerminalOutputWriteData` | S |
| 2 | `TerminalView.tsx:248` `writeRecoveryTailAndWait(data: string)` | string | 동상 | S |
| 3 | `TerminalView.tsx:1639-1645` `writeOutput(term, data: string, …)` | string | 동상. `:1670` `getOutputUtf8ByteLength(data)` → IR 의 `byteLength` 를 인자로 받는다 | **M** |
| 4 | `TerminalView.tsx:1745-1748` `bufferOutputWhileRestorePending(data: string, …)` | string. `:1749` `data.length === 0`, `:1753` `getOutputUtf8ByteLength(data)`, `:1783` 큐 push | ⚠️ `:1749` 의 `.length` 가드는 `Uint8Array` 에도 있어 **조용히 통과**한다 — `byteLength` 기준으로 바꿔야 한다 | **M** |
| 5 | `terminalOutputScheduler.ts:419` `flushNextTerminalRestoreBufferedOutput` — 게이트 **`:454-462`** | `typeof data !== 'string'` → `settle(false)` | **필수.** `03:460`/`:752`/`:788` 이 3회 경고한 그 게이트. `TerminalView.tsx:2098` 이 `getData` 를 주므로 `:459` 의 두 번째 절은 이미 무력이고, **막는 것은 첫 번째 절 하나**다 | **M** |
| 6 | `terminalOutputScheduler.ts:268-278` `enqueue`/`enqueueLegacy` | `data: string` | **`enqueueBytes` 신설** (`06` §4.4, D-확정). 기존 2개에 `instanceof Uint8Array` 거부 가드 추가 | **M** |

> ⚠️ **`:1749` 와 `:1363` 은 같은 함정의 두 사례다.** `terminalOutputScheduler.ts:1363` 의 `data.length === 0` 도 `Uint8Array` 를 통과시킨다. `06` §4.4 가 `03:236` 을 근거로 지적한 `TextEncoder.encode(Uint8Array)` 의 조용한 손상은 **이 두 가드가 무력하다는 사실**과 짝을 이룬다. **[설계결정] 두 곳 모두 `typeof data === 'string' ? data.length === 0 : data.byteLength === 0` 이 아니라, 진입점 자체를 분리해 타입이 섞이지 않게 한다.**

### 1.5 codec 선택 지점 — 딱 한 곳

IR 을 도입해도 "지금 이 세션은 JSON 인가 바이너리인가" 를 아는 지점이 필요하다. **[설계결정] 그 지점은 `WebSocketContext` 의 수신 분기 하나이고, 그 아래로는 codec 이라는 개념이 존재하지 않는다.**

```
WebSocketContext.handleMessage (:684)
  ├ event.data instanceof ArrayBuffer  → decodeWsMessage → parseFrameMessage
  │                                     → fromBinaryOutputFrame → onOutputDelivery(IR)
  ├ typeof event.data !== 'string'     → Blob 명시 거부 + 기록 (03:113, 03:747)
  └ string                             → JSON.parse (기존 :687)
                                        → fromJsonOutputMessage → onOutputDelivery(IR)
```

즉 **`onOutput` 핸들러의 시그니처를 바꾸는 것이 이 설계의 전부**다:

```ts
// frontend/src/contexts/WebSocketContext.tsx:118 대체
onOutput?: (delivery: TerminalOutputDelivery) => void;
```

기존 `(data: string, message: TerminalOutputMessage)` 를 **없애고** IR 하나로 통일한다. 두 진입점을 남기면 "같은 책임을 두 곳이 나눠 갖는" 상태가 되어 §10.2 위반이다.

호출부는 2곳뿐이다 — `WebSocketContext.tsx:1140`(라이브) 와 `:592`(grace 버퍼 재생). grace 버퍼는 `TerminalOutputMessage` 객체를 보관했다 재생하므로(`:486` `current.output.push(msg)`), **IR 을 보관하도록 바꾸면 뷰 수명 문제가 재생 경로로 번진다** — §6 의 S4-C4 가 이것을 별도 단계로 잡는 이유다.

### 1.6 공유율 [추정]

| 구간 | 라인 수(현행) | 바이너리에서 재사용 |
|---|---:|---|
| R1 compatibility post-ack | 89 (`:3193-3281`) | 전량 (세그먼트 호출 `:3214` 만 IR 로 대체) |
| R2 visible resync | 68 (`:3282-3349`) | 전량 (`:3302` 만 대체) |
| R3 hidden/회계/디버그 | 26 (`:3350-3375`) | 전량 (2개 인자만 IR 로) |
| R4 delivery identity | 3 (`:3377-3379`) | 전량 |
| R5 세그먼트 분할 | 8 (`:3381-3388`) | **어댑터로 이동 — 유일한 비공유** |
| R6 dispatch + ACK | 54 (`:3389-3442`) | 전량 |

**[추정] 비공유 라인은 252줄 중 8줄 + 어댑터 신규분이다.** `03:756` 이 "핸들러 재작성" 이라 부른 것은 정확히 **인자 형태 교체가 전파되는 범위**를 가리킨 것이고, 재작성해야 하는 **로직**은 R5 뿐이다. 난이도 L 은 유지되지만(6개 하류 시그니처 + P2/P5 핀), **위험은 "L/높음" 에서 "M/중간" 으로 낮출 수 있다** — 아래 §6 의 단계 분해가 그 방법이다.

---

## 2. 과제 2 — 신규 상태 3종의 소유자와 수명

`03:179-185` 가 지목한 3종을 각각 판정한다.

### 2.1 `authorityEpochIndex ↔ UUID` 매핑 테이블 — **[미확인] 해소, 위험 없음**

#### 코드로 확인한 사실 3가지

1. **`authorityEpoch` 는 세션당 1회만 배정된다.** `server/src/services/SessionManager.ts:1252` `authorityEpoch: uuidv4()` 가 유일한 생성 지점이고, `server/src` 프로덕션 소스 전체에서 `.authorityEpoch = ` 재배정이 **0건**이다(전수 grep, `*.test.ts` 제외).
2. **매핑은 `channelId` 와 동일한 메시지에 실린다.** `01:374-385` 이 `SubscribedSessionInfo` 에 `channelId`·`streamEpoch`·`authorityEpochIndex` 를 **한 객체로** 확장하고(`:354` 가 그 인덱스 줄), `01:725-737` 의 `terminal-binary:capability.channels[]` 도 4개 필드를 **한 객체로** 싣는다(`:656`).
3. **미지 `channelId` 프레임은 프롤로그를 읽기 전에 걸러진다.** `server/src/ws/binaryFrameCodec.ts:956-962` — `context.channelState(channelId) === undefined` → `scoped('unknown-channel')` 후 `offset = frameEnd; continue`. `parseFrameMessage`(`:1000`)는 그 프레임에 **도달하지 않는다**.

#### 판정

> **`03:181` 의 `[미확인]`("매핑이 도착하기 전에 그 인덱스를 쓰는 프레임이 오면") 은 도달 불가능한 시나리오다.**
>
> 인덱스는 채널 프롤로그에만 존재하고, 채널을 모르면 프롤로그를 파싱하지 않으며, 채널을 아는 순간 인덱스도 이미 알고 있다(같은 메시지). 그리고 세션 수명 동안 인덱스는 변하지 않는다.

**따라서 "두 평면 간 상태 동기화" 라는 신규 계약은 발생하지 않는다.** 필요한 것은 동기화가 아니라 **채널 등록부의 부속 필드 하나**다.

#### 부수 판정 — `01:540` 의 `[미확인]` 도 함께 닫힌다

`01:540` 은 *"한 output 메시지 안에서 authorityEpoch 이 바뀌는 경우는 `[미확인]` — 발생 가능하다면 세그먼트에 `authorityEpochIndex`(u16)를 추가하고 세그먼트 크기를 16B→18B 로 늘려야 한다"* 고 했다. **`authorityEpoch` 가 세션 상수이고 채널이 세션 1:1(`01:338-341`)이므로 한 프레임 안에서 바뀔 수 없다. 세그먼트는 16B 로 확정이다.**

⚠️ 단, JSON 경로의 `VisibleOutputSourceSegment.authorityEpoch`(`frontend/src/utils/visibleOutputRecovery.ts:402`)는 optional 필드로 남아 있고 `:426` 이 빈 문자열만 거른다. **바이너리 어댑터가 프롤로그 값을 전 세그먼트에 상속시켜도 JSON 경로와 값이 같다** — 두 경로의 관측 동등성(§6 S4-C6 parity)이 여기서 성립한다.

#### 소유자와 수명 [설계결정]

| 항목 | 결정 |
|---|---|
| 자료구조 | `Map<number /*channelId*/, { sessionId: string; authorityEpoch: string; streamEpoch: string }>` |
| 소유자 | **`WebSocketContext` 의 `useRef`** — 소켓 수명과 정확히 같다. React state 로 두면 프레임마다 리렌더가 걸린다 |
| 생성 | `subscribed` 처리 시(`SubscribedSessionInfo`) 및 `terminal-binary:capability` 수락 시 일괄 |
| 갱신 | **없음** (세션 상수) |
| 폐기 | `terminal-binary:channel-retired`(`01:678-682`) 수신 · `unsubscribe` · 소켓 close · `codecEpoch` 변경 |
| 미등록 조회 | 발생 불가. 그럼에도 도달하면 **fail-closed** — `06` D5 의 단일 롤백 함수 호출 |

> **왜 `TerminalContainer` 가 아니라 `WebSocketContext` 인가**: 매핑은 **연결·채널 스코프**이고 `TerminalContainer` 는 **세션·뷰 스코프**다. 컨테이너에 두면 채널 등록부가 뷰 마운트/언마운트에 종속되어 재연결 없이 매핑이 사라진다. 그리고 어댑터(`fromBinaryOutputFrame`)가 이 테이블을 필요로 하는데, 어댑터는 `WebSocketContext` 의 수신 분기에서 호출된다(§1.5). **테이블은 그 호출자가 갖는다.**

### 2.2 `replayToken` / `repairToken` 채널 상태 — **절반은 이미 존재한다**

`03:182` 는 "stateless → stateful 전환" 이라 했으나, 코드를 보면 **클라이언트는 이미 두 토큰의 현재값을 들고 있다.**

| 토큰 | 이미 존재하는 보관처 | 소비 |
|---|---|---|
| `repairToken` | `activeVisibleOutputResyncRef.current.repairToken` | `TerminalContainer.tsx:3305` 이 `output.repairToken !== activeResync.repairToken` 로 **대조**한다 — 즉 클라이언트 로컬 상태가 이미 권위다 |
| `replayToken` | `compatibilityPostAckConvergenceRef.current.replayToken` / `activeVisibleOutputResyncRef.current.replayToken` | `:3199` `output.replayToken !== …replayToken`, `:3320` `outputReplayToken` 대조 |

**진짜로 새로 필요한 것은 "라이브 경로에서 하류로 넘기는 값" 하나다.** `:3392` 와 `:3436` 이 `replayToken: output.replayToken` 을 `submitOutput` 메타데이터로 그대로 전달하고, 그것이 `TerminalView.tsx:1786` 을 거쳐 restore 버퍼 엔트리에 박힌다. R1/R2 모드가 아닐 때는 대조 대상이 없으므로 **현재 값을 알 곳이 없다.**

#### [설계결정] 갱신원(source of update)은 이미 JSON 으로 온다

`01:537-538` 은 `screen-snapshot`(0x02) 의 `replayTokenIndex` 와 `screen-repair`(0x03) 가 토큰을 갱신한다고 했다. 그런데 **`06` D15 가 `0x03` 을 "인코딩 불가" 로 확정**했다(`06:1263-1276`) — v1 에서 `screen-repair` 는 JSON 에 남는다. 그리고 `screen-snapshot` 도 §6 의 단계 분해에서 **S4 범위 밖**이다(`03:462-467` 의 평면 분리).

> **따라서 S4 시점에 두 토큰의 갱신원은 전부 JSON control 이다.** `handleScreenSnapshot`(`TerminalContainer.tsx:2385`), `handleScreenRepair`, `session:ready` 가 그대로 갱신원이 된다. **바이너리 프레임은 토큰을 읽지도 쓰지도 않는다.**

| 항목 | 결정 |
|---|---|
| 자료구조 | `Map<sessionId, { replayToken?: string; repairToken?: string }>` — 또는 기존 ref 3개(`compatibilityPostAckConvergenceRef` · `activeVisibleOutputResyncRef` · 신규 `liveTokenRef`)의 **통합** |
| 소유자 | **`TerminalContainer`(세션 스코프 ref)** — §2.1 과 반대다. 토큰은 세션·복구 트랜잭션 스코프이고, 이미 그 안에 두 개가 살고 있다 |
| 갱신 | `screen-snapshot` · `screen-repair` · `session:ready` · `screen-repair:restore-needed` 수신 시 |
| 폐기 | `wsConnectionGenerationRef` 변경 · `sessionGenerationRef` 변경 (`:3285-3286` 이 이미 쓰는 두 세대값) · epoch 롤백 |
| ⚠️ 위험 | **기존 ref 3개를 통합하면 §3 Surgical Changes 위반이자 회귀 위험이다.** [설계결정] **통합하지 않는다.** 라이브 경로용 `liveOutputTokenRef` **하나만 추가**하고, JSON 경로에서는 지금처럼 `output.replayToken` 을 우선 사용하며 없을 때만 ref 를 본다 — 그러면 JSON 관측 동작이 비트 단위로 보존된다 |

> **경계 대조군**: JSON 경로에서 `liveOutputTokenRef` 를 **의도적으로 비웠을 때 기존 테스트가 전부 green 이어야 한다.** green 이 아니면 JSON 경로가 새 상태에 의존하기 시작한 것이고, 그것은 `binary-shadow` 의 "관측 동작 불변" 계약 위반이다.

### 2.3 ACK 도메인 — §3 으로 분리

`03:183` 의 세 번째 항목은 상태 도입이 아니라 **프로토콜 변경**이며, 판정 결과 S4 범위 밖이다. §3 참조.

---

## 3. 과제 3 — ACK 도메인 전환 (`deliverySeq → sourceSeq`)

### 3.1 코드로 확인한 사실

| # | 사실 | 근거 |
|---|---|---|
| 1 | **서버 fair-delivery 원장은 전적으로 `deliverySeq` 키다.** lane 조회·중복/과잉/순서 검사·구간 정산이 전부 `deliverySeq` 비교다 | `server/src/ws/wsSendPolicy.ts:838`(시그니처) · `:844-846`(3개 거부 검사) · `:847`(`lane.sent.filter(d => d.deliverySeq > lane.lastAcknowledgedSeq && d.deliverySeq <= input.deliverySeq)`) · `:848`(reduce) · `:849-852` |
| 2 | **`sourceSeq` 는 `wsSendPolicy.ts` 에 0회 등장한다.** | 전수 grep |
| 3 | **`FairTerminalDelivery` 에 `sourceSeq` 필드가 없다.** 있는 것은 `deliverySeq`·`encodedBytes` 2개뿐 | `wsSendPolicy.ts:516-519` |
| 4 | **S1 이 승격한 사이드카는 3개이고 `sourceSeq` 는 그중에 없다.** | `wsSendPolicy.ts:85-131` — `connectionEpoch`(`:118`) · `deliverySeq`(`:119-121`) · `deliveryKind`(`:122`) |
| 5 | **클라이언트 `TerminalOutputMessage` 에 `sourceSeq` 가 없다.** | `frontend/src/types/ws-protocol.ts:780-801` — 10개 필드 전수 확인 |
| 6 | **클라이언트의 `sourceSeq` 는 checkpoint/authority 평면 전용이다.** | `frontend/src/utils/terminalWriteCoordinator.ts:16`(`Ordinal64` 필드) · `:233` · `:276` — 전부 checkpoint 트랜잭션 신원 |
| 7 | **ACK 메시지 스키마는 `deliverySeq: number` 고정이다.** | `server/src/types/ws-protocol.ts:436-441`, 라우터 처리 `server/src/ws/WsRouter.ts:1863-1920` (거부 응답 5종이 전부 `deliverySeq` 를 에코) |
| 8 | **`sourceSeq` 는 서버 세션 상태로는 존재한다** — 단 terminal-authority(checkpoint) 계열이다 | `server/src/services/SessionManager.ts:4391`(`nextTerminalAuthoritySourceSeq.toString()`) · `:4393` · `:4398` |

### 3.2 판정 — **S4 에서 전환하지 않는다** [설계결정]

세 가지 이유가 각각 독립적으로 충분하다.

1. **`binary-shadow` 계약 위반.** `06:1457` — *"와이어에는 **JSON 만** 나간다."* S4 종료 시점에 클라이언트가 받는 것은 여전히 JSON `{type:'output', …, deliverySeq}` 이다. ACK 도메인을 바꾸면 클라이언트가 **서버가 보내지도 않은 값**으로 ACK 하게 된다. 즉 S4 에서의 전환은 구현 불가가 아니라 **의미가 없다.**
2. **선행 서버 작업이 안 되어 있다.** `01:748` — *"`lane.sent` 엔트리에는 각 delivery 의 `sourceSeq` 를 부착해 두어야 하며, 이는 `WsTransportMessage` 에 `sourceSeq` 필드를 1급으로 추가하는 것과 같다 — §3.6 의 필드 승격 작업에 함께 포함시킨다."* 사실 4가 보이듯 **그 승격은 S1 에서 일어나지 않았다.**
3. **`01:742` 가 스코프 불일치를 미해결로 남겼다.** `deliverySeq` 는 lane 스코프이고 lane 재생성 시 1로 리셋되는데, `sourceSeq` 는 세션 스코프이고 리셋되지 않는다. `01:742` 는 *"lane 을 새로 만들면 `lane.lastAcknowledgedSeq` 의 초기값을 0 이 아니라 그 세션의 현재 `sourceSeq` 로 세워야 한다"* 고 규정만 하고, 그 초기값을 클라이언트/서버 어느 쪽에서 어떤 경로로 읽을지는 정하지 않았다 **[미확인]**.

### 3.3 `deliverySeq` 사이드카와의 관계 — S1 이 남긴 것이 무엇인가

S1 이 한 일은 **도메인 전환이 아니라 계층 정리**다.

```
S1 이전:  hasFairDeliveryIdentity(message)  →  JSON.parse(message.payload)  →  deliverySeq 유무 확인
                                              (파싱 실패 시 true 반환 = 결함)
S1 이후:  WsTransportMessage.deliverySeq     →  사이드카 직접 읽기        (wsSendPolicy.ts:119-121)
```

즉 **`deliverySeq` 는 강등된 것이 아니라 오히려 1급이 되었다.** `03:177` 의 *"`deliverySeq` 는 서버 내부 회계로 강등"* 은 `01` §1.9 의 **와이어 설계**를 말한 것이고(프레임 헤더에 넣지 않는다), **전송 계층 사이드카로서의 지위**와는 다른 축이다. 두 진술은 모순이 아니다.

**S4 에 대한 직접 귀결:**

| 항목 | S4 에서 |
|---|---|
| IR 의 `ack` 필드 | `{ connectionEpoch, deliverySeq }` — **JSON 경로에서만 채워진다** |
| 바이너리 어댑터의 `ack` | **`undefined`.** 프레임 헤더에 `deliverySeq` 가 없고(`01:416`) `sourceSeq` 기반 ACK 는 서버가 아직 받지 못한다 |
| `TerminalContainer.tsx:3414-3432` refcount ACK | **그대로 유지.** `deliveryIdentity === undefined` 면 `acknowledgeAcceptedOutput` 도 `undefined` 가 되는 기존 분기(`:3415`)가 바이너리 경로를 자동으로 커버한다 — **새 코드가 필요 없다** |

> ⚠️ **그래서 S5 에서 반드시 확인할 것**: opt-in 으로 바이너리가 실제 와이어에 나가는 순간, ACK 가 오지 않으면 `wsSendPolicy.ts` 의 credit window 가 닫히고 `advanceTo`(`:829-836`)의 `ackTimeoutMs` 가 fallback 을 건다. **즉 "ACK 없이 바이너리를 켜는" 상태는 존재할 수 없다.** ACK 도메인 전환은 **S5-c(binary-optin) 진입의 하드 선행조건**이다. `06` §5 S5 는 이것을 단계 항목으로 갖고 있지 않다 → **`06` 개정 필요 [설계결정]**.

### 3.4 전환 시점의 설계 (S5-c 이후, 참고용)

`unified` 전용이므로 `01:746` 의 채널 단위 정산 승격은 **필요 없다** — `01:746` 자신이 *"`unified` 우선 착수에서는 이 변경이 필요 없고 split 단계에서 도입한다"* 고 적었고 `06` D3 가 "바이너리는 `unified` 에서만" 을 확정했다. 남는 작업은 4개다.

| # | 작업 | 위치 |
|---|---|---|
| 1 | `WsTransportMessage` 에 `sourceSeq?: Ordinal64` 사이드카 승격 | `wsSendPolicy.ts:85-131` (S1 과 같은 패턴) |
| 2 | `FairTerminalDeliveryInput`/`FairTerminalDelivery` 에 `sourceSeq` 부착 | `wsSendPolicy.ts:500-519` |
| 3 | `acknowledge` 를 `deliverySeq | sourceSeq` 판별 유니온으로 | `wsSendPolicy.ts:838-853` |
| 4 | `TerminalDeliveryAckMessage` 변형 추가 | `server/src/types/ws-protocol.ts:436-441` + 프론트 사본 |

**경계 대조군**: 새 lane 의 **첫 ACK** 와 **두 번째 ACK** 를 둘 다 단정한다. `06:626` 이 지적한 대로 `FairTerminalDeliveryScheduler.test.ts:472-479` 는 첫 ACK 만 보므로 델타와 누적 총액이 우연히 일치해 **오류를 못 잡는다**. 도메인 전환 테스트에서 같은 사각지대를 반복하면 안 된다.

---

## 4. 과제 4 — xterm 혼류 순서

### 4.1 메커니즘 — 번들에서 직접 확인

`server/node_modules/@xterm/headless/lib-headless/xterm-headless.js` 에서 확인 (버전 **6.0.0**, `frontend/node_modules/@xterm/xterm` 과 동일 버전):

```
this._parseBuffer=new Uint32Array(4096),
this._stringDecoder=new c.StringToUtf32,
this._utf8Decoder=new c.Utf8ToUtf32,
```

그리고 **write 청크마다** 도는 분기 (같은 파일, 두 곳 — 청크 분할 루프용과 단발용):

```
o = "string"==typeof e ? this._stringDecoder.decode(e.substring(t,n), this._parseBuffer)
                       : this._utf8Decoder.decode(e.subarray(t,n), this._parseBuffer);
if (s = this._parser.parse(this._parseBuffer, o)) …
```

`Utf8ToUtf32` 는 `this.interim=new Uint8Array(3)` 로 미완성 시퀀스를 보류한다(번들에서 직접 확인).

**읽히는 것**: 디코더 선택이 **청크 타입별**이고, 선택 직후 **즉시 `parse`** 한다. 따라서

```
write(bytes A)  → A 의 꼬리가 미완성 → interim 보류, 그 코드포인트는 parse 되지 않음
write(string S) → _stringDecoder 가 S 전량 디코드 → parse(S)          ← 먼저 화면에 나감
write(bytes B)  → _utf8Decoder 가 interim+B 로 코드포인트 완성 → parse ← 나중에 나감
```

**순서가 뒤집힌다.** 이것은 `03:359` 의 `[추정]` 을 **번들 구조 수준에서 확정**한 것이다. (실행 확인은 아니다 — 이 문서는 테스트를 실행하지 않는다. §4.4 의 테스트가 실측으로 승격시킨다.)

### 4.2 현행 결함 여부 판정 — **[추정] 도달 불가**

`03:340` 이 요구한 "지금 이미 버그가 있는지" 조사를 코드로 수행했다. 조건이 성립하려면 **(a) interim 을 남기는 바이트 write** 와 **(b) 그 뒤의 비어있지 않은 string write** 가 필요하다.

#### (a) — interim 을 남기는 바이트 write 가 오늘 존재하는가

| 바이트 write 경로 | 코드포인트 정렬? | 근거 |
|---|---|---|
| 스케줄러 flush 슬라이스 (`terminalOutputScheduler.ts:1269` → `:1308`) | **예** | `:1238` 이 `findUtf8SliceEnd` 를 거친다. `:2025` 목표가 버퍼 끝이거나 continuation 이 아니면 그대로, `:2029-2036` continuation 이면 최대 3바이트 역탐색, `:2041-2044` 교착 시 `getUtf8SequenceWidth(bytes[start])` 만큼 전진. **입력이 well-formed UTF-8 이면 출력 슬라이스는 항상 코드포인트 경계에서 끝난다.** 그리고 오늘 큐에 들어가는 바이트는 전부 `textEncoder.encode(string)` 결과(`:1367`, `:1460`)라 well-formed 다 |
| checkpoint body 슬라이스 (`terminalWriteCoordinator.ts:1091-1097`) | **아니오** | `mutation.body.subarray(mutation.bodyOffset, checkpointBodySliceEnd)` — `checkpointWriteSliceBytes` 단위 고정 절단. UTF-8 인식 없음. **서버 쪽도 마찬가지다**: `server/src/services/TerminalAuthorityProductionAdapter.ts:892-899` 이 `TERMINAL_CHECKPOINT_CHUNK_BYTES` 단위로 `bytes.subarray()` 한다 |
| checkpoint parser-tail (`terminalWriteCoordinator.ts:1100`) | 서버가 문자열 전체를 인코딩(`TerminalAuthorityProductionAdapter.ts:870-880`) | 정렬됨 |
| checkpoint live output (`frontend/src/utils/terminalCheckpointRuntime.ts:1249`) | 서버 문자열 유래 | 정렬됨 |

→ **오늘 interim 을 남길 수 있는 것은 checkpoint body 슬라이스 하나뿐이다.**

#### (b) — 그 사이에 비어있지 않은 string write 가 낄 수 있는가

**아니다.** checkpoint body 는 코디네이터의 **단일 mutation** 이고, `terminalWriteCoordinator.ts:1091-1097` 이 `onWritten` 콜백으로 `bodyOffset` 을 전진시키며 **같은 mutation 을 계속 active 로 유지**한다. 다른 mutation 은 `activeMutation` 가드에 막혀 그 사이에 끼지 못한다.

#### 판정

> **[추정] 현행 코드에 string/bytes 혼류 순서 뒤집힘 결함은 없다.** 메커니즘은 실재하나 도달 경로가 없다.
>
> **[미확인]** — 이 판정은 정적 분석이다. §4.4 의 특성화 테스트가 이를 실측으로 확인해야 한다. 특히 `terminalReplayGuard.ts:100` 의 `options.write(options.data, …)` 와 `terminalWriteCoordinator.ts:1974-1981` 의 compatibility-write(문자열 통과 검사 `:1974`, 바이트 복사 `:1981`)가 checkpoint body 사이에 낄 수 있는지는 코디네이터 큐 구현 전수를 보지 않았다.

### 4.3 S4 후에는 어떻게 달라지는가 — **[설계결정] 새 위험이 생기지 않는다**

바이너리 전환 후 `enqueueBytes` 로 들어오는 바이트는 **서버 프레임 payload 를 그대로 자른 뷰**이므로 코드포인트 정렬이 보장되지 않는다. 그러나:

1. **큐 원소 경계를 넘는 미완성 시퀀스는 xterm 이 알아서 처리한다** — 스케줄러가 원소 N 의 꼬리(미완성)를 쓰고 이어서 원소 N+1 의 머리(continuation)를 쓰면 `interim` 이 정확히 이어 붙인다. `03:358` 이 서버에 코드포인트 정렬을 요구하지 말라고 한 이유다.
2. **`findUtf8SliceEnd` 는 미완성 꼬리에서도 교착하지 않는다.** `:2025` 의 `target === bytes.byteLength` 분기가 원소 끝을 그대로 통과시키고, 원소 머리가 continuation 바이트여도 `:2041-2044` 가 `getUtf8SequenceWidth(0b10xxxxxx)` = **1**(`:2055-2061` 의 4개 조건 전부 불일치 → `return 1`)로 최소 1바이트 전진한다.
3. **혼류 조건 자체는 늘어나지 않는다** — 라이브 경로가 string 을 쓰지 않게 되므로 오히려 **줄어든다.**

> ⚠️ **그래도 남는 것 하나**: 원소 머리가 continuation 바이트인데 `visibleFlushBudgetBytes` 가 작으면 **1바이트씩 write** 하게 된다(`:2041-2044`). 정확성 문제는 아니나 write 횟수가 폭증한다. `visibleFlushBudgetBytes` 기본값은 262,144(`frontend/src/utils/inputReliabilityMode.ts:72`)라 실무에서는 발생하지 않는다 **[추정]**. 설정 하한 1024(`:281`)에서도 안전하다.

### 4.4 회귀 테스트 설계 — **2-arm 특성화**

`03:341` 이 요구한 대로 **신규 계약이 아니라 회귀(특성화) 테스트**로 세운다.

#### Arm A — 메커니즘 (라이브러리 수준, 결정적)

| 항목 | 내용 |
|---|---|
| 파일 | `frontend/tests/unit/xtermDecoderInterleaving.test.ts` (신규) |
| 스위트 | C (frontend node:test, Playwright 미수집) |
| 커맨드 | `node --experimental-strip-types --test tests/unit/xtermDecoderInterleaving.test.ts` (cwd=`frontend/`) |
| 케이스 1 (RED 예상) | `'한'`(EF/ED… 3바이트)을 2/1 로 쪼갠 `Uint8Array` 두 개 사이에 **비어있지 않은 ASCII string** `'X'` 를 끼워 write → `terminal.buffer` 최종 문자열이 `'X한'` 이면 **순서 뒤집힘 확정**, `'한X'` 이면 이 문서의 §4.1 이 틀린 것 |
| 케이스 2 (경계 대조군) | 같은 3바이트를 **끊지 않고** 한 번에 write 한 뒤 `'X'` → 반드시 `'한X'`. 이게 실패하면 재고 있던 게 interim 이 아니다 |
| 케이스 3 (경계 대조군) | 두 바이트 write 사이에 **빈 문자열** write → `'한'` 만 나와야 한다. `03:360` 의 `if(!i) return 0` 을 실측으로 승격 |
| 케이스 4 (경계 대조군) | 두 바이트 write 사이에 **아무것도 끼우지 않음** → `'한'`. 뒤집힘이 string write 때문임을 확정 |
| ⚠️ 의존성 | **`@xterm/headless@^6.0.0` 을 `frontend/devDependencies` 에 추가해야 한다** — `frontend/node_modules/@xterm` 에는 `addon-fit`/`addon-serialize`/`xterm` 만 있고 `headless` 는 `server/node_modules` 에만 있다. 저장소는 npm workspace 가 아니다(루트 `package.json` 에 `workspaces` 없음, 루트 `node_modules/@xterm` 부재) |
| ⚠️ 치환 위험 | Arm A 는 `@xterm/headless` 를, 프로덕션은 `@xterm/xterm` 을 쓴다. **테스트 첫 단정으로 두 패키지의 `version` 이 같은지 확인**한다(현재 둘 다 `6.0.0` 확인). 버전이 갈리면 즉시 red — 치환이 조용히 낡는 것을 막는 유일한 방법이다 |

> **[설계결정] 새 devDependency 추가는 사용자 승인 사항이다.** 승인이 없으면 대안은 (i) `frontend/tests/` 에서 `../../server/node_modules/@xterm/headless/lib-headless/xterm-headless.js` 를 상대경로 import (저장소에 `../../../server/src/...` 참조 선례 있음 — `frontend/tests/unit/wsCheckpointProtocol.test.ts:184`, `terminalCheckpointRuntime.test.ts:31`) 또는 (ii) Arm B 단독. **(i) 은 `npm ci` 재현성이 깨지므로 권장하지 않는다.**
> ⚠️ devDependency 로 갈 경우 메모리 `buildergate_npm_ci_node_env_production_silent_trap` — `NODE_ENV=production` 하의 `npm ci` 는 devDependencies 를 조용히 누락시킨다. **모듈 해석 실패는 skip 이 아니라 즉시 실패**여야 한다.

#### Arm B — 프로덕션 아티팩트 (E2E)

| 항목 | 내용 |
|---|---|
| 파일 | `frontend/tests/e2e/s4-xterm-decoder-interleaving.spec.ts` (신규) |
| 스위트 | D (Playwright) |
| 커맨드 | `npx playwright test tests/e2e/s4-xterm-decoder-interleaving.spec.ts --project "Desktop Chrome"` (cwd=`frontend/`) |
| 내용 | 페이지 컨텍스트에서 **실제 번들된 `@xterm/xterm`** 인스턴스에 Arm A 와 동일한 4케이스를 적용 |
| 왜 필요한가 | Arm A 는 `@xterm/headless` 라는 **다른 아티팩트**를 잰다. 두 arm 이 같은 결론을 내야 치환이 정당화된다 (메모리 `check_operands_must_have_independent_origins`) |
| ⚠️ | `frontend/playwright.config.ts` 의 `reuseExistingServer: true` — 2222 에 프로덕션 서버가 살아 있으므로 그것을 쓴다. **본 연구는 서버를 건드리지 않는다** |

#### Arm C — 프로덕션 경로 도달성 대조군 (§4.2 판정의 red 조건)

| 항목 | 내용 |
|---|---|
| 파일 | `frontend/tests/unit/terminalOutputSliceAlignment.test.ts` (신규) |
| 단정 1 | 임의의 well-formed UTF-8 바이트열과 임의 예산에 대해 `findUtf8SliceEnd` 가 반환한 경계가 **항상 코드포인트 시작 오프셋**이다 (property, 시드 고정 — `06` D7 의 "외부 의존성 없이 시드 기반") |
| 단정 2 | **경계 대조군** — 의도적으로 잘린(ill-formed) 바이트열을 넣으면 단정 1이 **실패해야 한다.** 실패하지 않으면 검사가 무의미하다 |
| 의미 | 단정 1이 green 이면 §4.2 의 "(a) 도달 불가" 가 실측으로 뒷받침된다. red 로 바뀌는 날이 **오늘의 결함이 생긴 날**이다 |

#### S4 의 대응이 이 결과에 어떻게 달라지는가

| Arm A/B 결과 | Arm C 결과 | S4 대응 |
|---|---|---|
| 뒤집힘 확인 | 정렬 확인 | **현행 무결함 확정.** S4 는 `enqueueBytes` 도입 시 라이브 경로에서 string write 를 제거하는 것만 하면 된다. `03:362` 의 `[설계결정]`("비어있지 않은 string write 와 Uint8Array write 를 섞지 않는다")을 **린트 가능한 불변식**으로 격상: 라이브 경로 진입점 타입 분리(§1.4 #6)가 그 자체로 강제한다 |
| 뒤집힘 확인 | **정렬 실패** | **오늘 결함이다.** S4 이전에 hot-fix 로 분리 처리한다. `06` §7 "먼저 고쳐야 할 것" 에 항목 추가 필요 |
| 뒤집힘 **미확인** | — | §4.1 의 번들 독해가 틀린 것. `03:359` · `03:714` · `06:1448` 을 전부 개정해야 한다. **이 경우 S4-C 의 위험 등급이 한 단계 내려간다** |

---

## 5. 과제 5 — 프론트 코덱의 위치와 골든 벡터 공유

### 5.1 파일 배치

| 파일 | 성격 | 근거 |
|---|---|---|
| `frontend/src/utils/binaryFrameCodec.ts` | **신규, 디코드 전용** | `06:1470` 이 지정. 현재 부재 확인 |
| `frontend/tests/unit/binaryFrameCodec.test.ts` | 신규, S2 골든 벡터 소비 | `06:1470-1471` |
| `server/src/ws/__fixtures__/binary-frame-vectors.json` | **기존, 유일 SSOT. 복사 금지** | `06` D4 · `05:452`. 파일 자체가 `$schemaNote` 에 *"SSOT - do NOT copy this file. The frontend codec test (S4) must read THIS path"* 를 박아 두었다 |

### 5.2 [설계결정] 프론트 코덱은 서버 코덱을 import 하지 않는다 — 그리고 그게 §10.2 위반이 아니다

**할 수 없는 이유(기술적):**
- `frontend/src` 는 Vite 빌드 대상이고 `frontend/tsconfig.app.json:27` 의 `include` 는 `["src"]` 뿐이다. `frontend/src/**` 에서 `../../server/src/...` 를 import 하면 `tsc -b` 대상 밖의 파일이 앱 그래프에 들어온다.
- `server/src/ws/binaryFrameCodec.ts` 는 `server/src/types/ws-protocol.js` 의 `Ordinal64`/`isCanonicalOrdinal64` 에 의존한다(`binaryFrameCodec.ts:468-471` 의 `assertOrdinal64`). 그 파일은 서버 전용 타입 그래프 전체를 끌고 온다.
- 실제로 `frontend/src` 어디에도 `../../server` 참조가 **0건**이다(전수 grep).

**해서는 안 되는 이유(설계):**
- `05:439` — *"서버 코덱과 브라우저 코덱은 **별개 구현**이다. 두 파일이 각자의 테스트에서 자기 자신과 왕복하면 **둘 다 틀려도 초록**이다."* **공유하면 차분 테스트가 성립하지 않는다.** 즉 여기서의 중복은 §10.2 가 금지하는 중복이 아니라 **검사의 두 피연산자를 독립시키기 위한 의도된 이중 구현**이다 (메모리 `check_operands_must_have_independent_origins`).
- 저장소가 이미 같은 판단을 내린 선례가 있다 — `server/src/types/ws-protocol.ts` ↔ `frontend/src/types/ws-protocol.ts` 는 수동 동기화 쌍이다(`06:760`).

> **중복이 아닌 것과 중복인 것의 경계**: **골든 벡터는 단 하나여야 하고, 코덱은 둘이어야 한다.** 벡터를 복사하면 두 코덱이 각자의 벡터에 맞춰 각자 틀릴 수 있다. 코덱을 공유하면 벡터가 두 구현을 검사하지 못한다.

### 5.3 프론트 코덱의 범위 — 디코드 전용

⚠️ **이 표는 줄번호를 싣지 않는다 (2026-08-21 개정).** 원판은 `binaryFrameCodec.ts` 의 줄번호를 병기했는데 **하루 만에 두 번 무효화됐다** — `0x04` 프롤로그 구현이 +203, 그 뒤 도메인 검사 추가가 다시 +5/+42 를 밀었다. 전부 `export` 심볼이라 **이름으로 grep 하면 즉시 찾을 수 있고**, 줄번호는 탐색에 기여하지 않으면서 틀릴 자유만 갖는다. 코덱을 만지는 작업(=C5 자신)이 반드시 이 숫자를 다시 깨뜨린다.

| 서버 export | 프론트에 필요? |
|---|---|
| `decodeWsMessage` · `parseFrameMessage` | **필수** |
| `FRAME_HEADER_BYTES` · `FRAME_VERSION_V1` · `SEGMENT_BYTES` · `FLAG_*` · `MANDATORY_FLAGS` · `ACTIVE_FLAG_MASK_V1` · `DATA_PLANE_OPCODE` · `prologueBytes` · `isKnownOpcode` | **필수** (상수는 동일 값을 손으로 재선언 — 골든 벡터 `$rules` 블록이 그 값을 명시하고 있어 벡터가 대조군이 된다) |
| `rejectionGrade` · `WIRE_REJECTION_CODES` · `DECODER_POLICY_CODES` | **필수** (fail-closed 등급 판정) |
| `encodeFrame` · `encodeBatch` · `frameByteLength` · `defaultFlagsForOpcode` | **불필요.** v1 의 C→S 는 전부 JSON (`06` §5 S2-d: *"C→S opcode 표는 비어 있다"*). ⚠️ **단 골든 벡터 소비 테스트에는 필요**하다 — hexFrame → 바이트 변환은 순수 hex 파싱이므로 인코더 없이 가능하다 |
| `SERVER_TO_CLIENT_OPCODE_BY_TYPE` · `CLIENT_TO_SERVER_OPCODE_BY_TYPE` | 불필요 |
| `deriveMaxBodyBytes` | **재정의 필요** — §5.5 |
| **`FLAGS2_RESPONDER_LEASE_ID_PRESENT`** (2026-08-21 신설) | **필수** — `0x04` 프롤로그의 lease 슬롯 유효성 비트 |

### 5.4 골든 벡터 소비 — 구체 경로와 방식

**경로 (저장소 선례와 동일한 형태):**

```ts
// frontend/tests/unit/binaryFrameCodec.test.ts
const FIXTURE_URL = new URL(
  '../../../server/src/ws/__fixtures__/binary-frame-vectors.json',
  import.meta.url,
);
const fixture = JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));
```

**선례 (직접 확인):**
- `frontend/tests/unit/wsCheckpointProtocol.test.ts:184` — `readFileSync(new URL('../../../server/src/types/ws-protocol.ts', import.meta.url), 'utf8')`
- `frontend/tests/unit/wsCheckpointProtocol.test.ts:427` — `../../../server/src/ws/WsRouter.ts`
- `frontend/tests/unit/terminalCheckpointRuntime.test.ts:31` — `import { parseTerminalCheckpointClientMessage } from '../../../server/src/types/ws-protocol.ts';` (테스트에서는 **직접 import 까지** 한다)

서버 쪽 대응 지점은 `server/src/ws/binaryFrameCodec.test.ts:47` 의 `new URL('./__fixtures__/binary-frame-vectors.json', import.meta.url)` 이다. **두 테스트가 같은 파일을 서로 다른 상대경로로 읽는 구조가 되고, 파일이 옮겨지면 양쪽이 동시에 red 가 된다** — 이게 원하는 성질이다.

**소비 방식 — 서버 테스트를 베끼지 않는다** [설계결정]:

| 단정 | 프론트에서 |
|---|---|
| `layout` 자가검증 (행이 0부터 연접 + 연결 결과 = `hexFrame`) | **다시 한다.** 픽스처가 손상되면 프론트에서도 red 여야 한다. 서버 테스트가 이미 한다고 생략하면 프론트 스위트만 돌렸을 때 픽스처 무결성이 검사되지 않는다 |
| `decode(hex2bytes(hexFrame)) ≡ messages` | **한다.** 이것이 차분 테스트의 본체 — 서버가 손으로 계산한 바이트를 **프론트 구현**이 푼다 |
| `encode(message) === hex2bytes(hexFrame)` | **하지 않는다.** 프론트에 인코더가 없다 (§5.3) |
| fault 벡터 (`derivedFrom` 패치) 전건 | **한다.** rejection code 와 **등급(fatal/scoped)** 까지 대조. `06` D13 이 `payload-limit-exceeded` 를 scoped 로 확정했으므로 등급 불일치는 프론트에서 배치 손실로 직결된다 |
| `defaultContext.channels` (5=retired 등) | **한다.** `binaryFrameCodec.ts:963-973` 의 retired 진단 경로가 프론트에도 있어야 한다 |
| 수용 케이스의 `expect.decoded` 필드 단정 | **한다.** `06` §S2-g 가 *"4 KiB 초과 payload 를 조용히 잘라내는 디코더가 기존 단정을 전부 통과했다"* 고 기록한 vacuity 를 프론트에서 재발시키지 않는다 |

⚠️ **픽스처 스키마 드리프트 가드**: 프론트 테스트는 `fixture.vectors.length` 와 `fixture.$rules` 의 9개 값을 **리터럴로** 단정한다. 서버가 벡터를 추가했는데 프론트가 안 읽으면 조용히 커버리지가 줄어든다.

### 5.5 `maxBodyBytes` — 클라이언트 쪽 파생원 [설계결정]

서버는 `deriveMaxBodyBytes(pty.maxSnapshotBytes)`(`binaryFrameCodec.ts:271-277`, 기본 2 MiB — `server/src/schemas/config.schema.ts:77`)를 쓴다. 클라이언트에는 그 값이 없다.

`PERF-BGSTAB-010` AC-4(`01:397`, `01:477`)가 **새 정책 상수 도입을 금지**하므로 기존 값에서 파생해야 한다.

> **[설계결정] 클라이언트 `maxBodyBytes` = `getTerminalResourceLimits().visibleOutputQueueMaxBytes`** (`frontend/src/utils/inputReliabilityMode.ts:70`, 기본 **4,194,304**, 설정 범위 `[1024, 268_435_456]` — `:279`).
>
> 근거: 클라이언트가 한 프레임 본문으로 감당해야 하는 최대치는 곧 가시 출력 큐 상한이다. 그리고 **클라이언트 한도(4 MiB)가 서버 한도(2 MiB)보다 느슨하다** — 서버가 자기 한도를 지키는 한 클라이언트 한도는 절대 트립되지 않는다. **한쪽만 조이면 다른 쪽이 침묵하는 상황을 만들지 않는다는 점이 이 방향의 이점이다.**
>
> ⚠️ **그러나 `visibleOutputQueueMaxBytes` 를 1024 로 설정하면 클라이언트 한도가 서버보다 훨씬 빡빡해진다.** 그 구성에서 정상 프레임이 `payload-limit-exceeded`(scoped)로 버려질 수 있다. **[설계결정] 그것이 옳은 동작이다** — 큐에 들어갈 수 없는 프레임을 디코드하는 것은 무의미하다. 단 **테스트로 고정**한다: `visibleOutputQueueMaxBytes = 1024` 에서 2 KiB 본문 프레임이 scoped 거부되고 **같은 배치의 다음 프레임은 살아남는지**(`06` D13 의 scoped 등급)를 단정한다.

`terminal-binary:negotiate` 의 `maxBatchBytes`(`01:646`)도 같은 값을 선언한다 — 값이 둘이면 어긋난다.

---

## 6. 과제 6 — S4 클라이언트 단계 분해

### 6.1 분해의 지렛대

**`binary-shadow` 는 와이어에 JSON 만 내보낸다**(`06:1457`). 따라서 S4 종료 시점의 클라이언트는:

- 바이너리 디코드 경로를 **갖고는 있으나 프로덕션에서 한 번도 실행하지 않는다** (협상 미체결 → `binaryType` 은 설정하되 ArrayBuffer 가 도착하지 않음).
- 그러므로 **바이너리 경로의 모든 검증은 단위 테스트로 충분하고, E2E 는 "JSON 동작이 안 변했다" 만 보면 된다.**

이것이 난이도 L 을 6개의 작은 단계로 쪼갤 수 있게 하는 유일한 성질이다.

### 6.2 단계표

각 단계는 **실패 테스트 선행**이다 (`06:729`).

---

#### S4-C0 — P5 재고정 (하드 선행, 코드 변경 0)

| 항목 | 내용 |
|---|---|
| 왜 먼저 | `frontend/tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts:79` 가 워킹트리 `terminalOutputScheduler.ts` digest 를 `terminalNoRenderFixtureEvidence.ts:34` 의 고정값과 대조한다. **현재 이미 RED**(`03:626-653`, `06` §1.5 P5). 이 상태로 `enqueueBytes` 를 넣으면 "우리가 깼는지" 를 알 수 없다 |
| 작업 | `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1` 로 현행 스케줄러를 새 baseline 으로 재기록 (`03:667` `[설계결정]`) |
| ⚠️ | P5 의 baseline 피연산자는 `git show <rev>:<path>`(`terminalOutputSchedulerBenchmark.test.ts:66-73`)로 오므로 **커밋 상태에 의존**한다. 워킹트리가 dirty 한 지금(§7.3) 재고정하면 남의 미커밋 변경이 baseline 에 박힌다 → **워킹트리 정리가 이 단계의 선행이다** |
| 실패 테스트 | 없음 (기준선 작업). **게이트는 "재고정 후 해당 벤치가 green" 이다** |
| 검증 커맨드 | `node --experimental-strip-types --test tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` (cwd=`frontend/`) |
| 핀 영향 | **P5**(재고정 주체) |

---

#### S4-C1 — xterm 혼류 특성화 (프로덕션 코드 변경 0)

| 항목 | 내용 |
|---|---|
| 목적 | §4.4 의 Arm A/B/C. **결과에 따라 이후 단계의 설계가 달라지므로 가장 먼저 한다** |
| 실패 테스트 | Arm A 케이스 1이 "뒤집힘" 을 단정하며 **처음부터 green 일 것으로 예상**된다. `[설계결정]` — 이 경우 RED 를 만들기 위해 **먼저 "뒤집히지 않는다" 로 단정해 red 를 본 뒤 뒤집어 green** 으로 만든다. 그래야 테스트가 실제로 무언가를 관측함이 증명된다 |
| 경계 대조군 | Arm A 케이스 2·3·4, Arm C 단정 2 (§4.4) |
| 파일 | `frontend/tests/unit/xtermDecoderInterleaving.test.ts`(신규) · `frontend/tests/unit/terminalOutputSliceAlignment.test.ts`(신규) · `frontend/tests/e2e/s4-xterm-decoder-interleaving.spec.ts`(신규) |
| 검증 커맨드 | `node --experimental-strip-types --test tests/unit/xtermDecoderInterleaving.test.ts` (cwd=`frontend/`)<br>`node --experimental-strip-types --test tests/unit/terminalOutputSliceAlignment.test.ts` (cwd=`frontend/`)<br>`npx playwright test tests/e2e/s4-xterm-decoder-interleaving.spec.ts --project "Desktop Chrome"` (cwd=`frontend/`) |
| 회귀 커맨드 | 없음 (신규 파일만) |
| 핀 영향 | **0** — 신규 테스트 파일뿐. ⚠️ **P2 `focusedCommands`(`tools/wave3/canary-admission-evidence.test.mjs:66-79`) 목록에 넣지 않는다**. `frontend/package.json` 에 devDependency 를 추가하면 그 파일은 어느 핀에도 없다(전수 확인) |

---

#### S4-C2 — 스케줄러 바이트 진입점 (`enqueueBytes`)

| 항목 | 내용 |
|---|---|
| 작업 | `terminalOutputScheduler.ts:268-278` 인터페이스에 `enqueueBytes` 추가 + 구현(`:1362` `enqueue` 옆). 큐 push 는 `:1407-1415` 를 그대로 재사용하고 `:1367` 의 encode 만 건너뛴다. `enqueueLegacy` 대응분도 함께 (`06` §4.4 — *"단일 `enqueueBytes` 만 신설하면 `enqueueLegacy` 가 방치된다"*) |
| 함께 | `:1363`/`:1457` 의 `data.length === 0` 가드 앞에 `instanceof Uint8Array` **거부** 가드 추가 · retry 큐 `:146-150`/`:163-164`/`:802-833` 확장 · `:810` 의 `textEncoder.encode(entry.data).byteLength` → `.byteLength` 치환(**`06` §4.4 표: `:810` 만 처방이 다르다**) |
| 실패 테스트 | ① `enqueue(new Uint8Array([27,91,49]))` → **거부**되어야 한다 (현재는 통과 후 `"27,91,49"` 를 인코딩 — `03:236` 의 `[추정]` 을 실측으로 승격) ② `enqueueBytes` 로 넣은 ingress 에서 주입 인코더(`:254` `textEncoder?: Pick<TextEncoder,'encode'>`) 호출 횟수 **0** |
| 경계 대조군 | ① 같은 바이트를 문자열로 만들어 `enqueue` 에 넣으면 **통과**해야 한다 — 거부가 타입 때문임을 확정 ② `enqueue`(string) ingress 에서 인코더 호출은 **1**(`PERF-BGSTAB-009` AC-1) — 0 이면 계측기가 죽은 것 |
| 파일 | `frontend/src/utils/terminalOutputScheduler.ts` · `frontend/tests/unit/terminalOutputSchedulerBytesIngress.test.ts`(**신규 파일** — `05:351` "새 검증은 새 파일에", P2 focused 목록 회피) |
| 검증 커맨드 | `node --experimental-strip-types --test tests/unit/terminalOutputSchedulerBytesIngress.test.ts` (cwd=`frontend/`) |
| 회귀 커맨드 | `node --experimental-strip-types --test tests/unit/terminalOutputScheduler.test.ts` (cwd=`frontend/`)<br>`node --experimental-strip-types --test tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts tests/benchmarks/terminalNoRenderFixture.test.ts` (cwd=`frontend/`) |
| 핀 영향 | **P2**(`terminalOutputScheduler.ts` = `canary-admission-evidence.test.mjs:54`) · **P5**(digest) |
| 핀 처리 | S4-C0 이후이므로 P5 는 **다시** 재고정해야 한다. `node tools/wave3/canary-admission-evidence.test.mjs --regenerate-green` (루트) |

---

#### S4-C3 — 하류 시그니처 확장 + restore 게이트 (프로덕션 동작 불변)

| 항목 | 내용 |
|---|---|
| 작업 | §1.4 의 #1~#5. 특히 **`terminalOutputScheduler.ts:454-462` 의 restore 게이트** — `03:460`/`:752`/`:788` 이 3회 경고한 그 지점 |
| 실패 테스트 | ① `flushNextTerminalRestoreBufferedOutput` 에 `getData` 가 `Uint8Array` 를 반환하는 엔트리 → 현재 `settle(false)`(`:460`), 변경 후 write 로 전달 ② `bufferOutputWhileRestorePending(new Uint8Array(0))` 이 빈 입력으로 인식되어야 한다 (현재 `:1749` 의 `data.length === 0` 가 `Uint8Array` 에서 **byteLength 가 아니라 length** 를 보므로 우연히 맞지만, 타입이 섞이면 의미가 흐려진다) |
| 경계 대조군 | ① 같은 흐름에 `string` 을 넣으면 **기존과 동일한 경로**로 통과해야 한다 ② `getData` 가 `number` 등 제3의 타입을 반환하면 여전히 `settle(false)` — 게이트를 없앤 게 아니라 넓힌 것임을 확정 |
| ⚠️ 함정 | `:459` 의 조건은 두 절이다. `TerminalView.tsx:2098` 이 `getData` 를 주므로 **두 번째 절은 이미 항상 false** 다. 첫 절만 고치면 되고, 두 번째 절을 건드리면 `getData` 없는 호출자의 계약이 바뀐다 |
| 파일 | `frontend/src/utils/terminalOutputScheduler.ts` · `frontend/src/components/Terminal/TerminalView.tsx` · `frontend/tests/unit/terminalRestoreBufferBytes.test.ts`(신규) |
| 검증 커맨드 | `node --experimental-strip-types --test tests/unit/terminalRestoreBufferBytes.test.ts` (cwd=`frontend/`) |
| 회귀 커맨드 | `node --experimental-strip-types --test tests/unit/terminalViewRecoveryContract.test.ts tests/unit/terminalRestoreCoordinator.test.ts tests/unit/terminalOutputScheduler.test.ts` (cwd=`frontend/`)<br>`npx playwright test tests/e2e/wave2-terminal-restore.spec.ts --project "Desktop Chrome"` (cwd=`frontend/`) |
| 핀 영향 | **P2**(`TerminalView.tsx` = `:52`, `terminalOutputScheduler.ts` = `:54`) · **P3**(`TerminalView.tsx` 가 `authority-promotion-evidence.test.mjs:136` 의 red baseline 에 있음 — §7.2) · **P5** |

---

#### S4-C4 — IR 도입 (`onOutput` 재작성, JSON 전용, 프로덕션 동작 불변)

**S4 클라이언트의 본체이자 가장 위험한 단계.** 그러나 이 단계에서 **바이너리는 한 줄도 다루지 않는다** — 순수 리팩터다.

| 항목 | 내용 |
|---|---|
| 작업 | `frontend/src/utils/terminalOutputDelivery.ts`(신규, §1.2 IR + `fromJsonOutputMessage` + `assertContiguousSegments`) · `WebSocketContext.tsx:118` 시그니처 교체 · `:592`/`:1140` 호출부 · `TerminalContainer.tsx:3192-3443` 을 IR 소비로 |
| **불변 계약** | **관측 동작이 비트 단위로 같아야 한다.** 새 분기·새 상태·새 로그 0건 |
| 실패 테스트 | IR 어댑터의 순수 함수 계약 — `fromJsonOutputMessage` 가 `sourceSegments === undefined` 일 때 `chunks.length === 1 && hasSourceSegments === false`, 세그먼트 불성립 시 `chunks === null`. `assertContiguousSegments` 가 `visibleOutputRecovery.ts:421`/`:434`/`:436` 과 **동일한 판정**을 내린다 |
| 경계 대조군 | **차분 대조군** — 기존 `splitVisibleOutputSourceSegments` 와 새 어댑터에 **같은 입력**을 주고 결과가 같은지 단정한다. ⚠️ 두 피연산자가 같은 출처가 되지 않도록, 기대값은 **픽스처 리터럴**이고 두 구현이 각각 그것과 대조한다 (메모리 `check_operands_must_have_independent_origins`) |
| ⚠️ 최대 위험 | R1(`:3193-3281`)과 R2(`:3282-3349`)는 각각 **배타 모드 + 조기 return 8개**를 갖는다. IR 전환 중 return 하나를 놓치면 두 복구 모드가 라이브 경로로 새어 나간다. **[설계결정] R1/R2 는 함수로 추출하지 말고 IR 인자만 바꾼다** — §3 Surgical Changes. 추출은 별도 작업으로 분리 |
| 파일 | 위 4개 + `frontend/tests/unit/terminalOutputDelivery.test.ts`(신규) |
| 검증 커맨드 | `node --experimental-strip-types --test tests/unit/terminalOutputDelivery.test.ts` (cwd=`frontend/`) |
| 회귀 커맨드 | `node --experimental-strip-types --test tests/unit/terminalContainerRecoveryContract.test.ts tests/unit/visibleOutputRecovery.test.ts tests/unit/terminalViewRecoveryContract.test.ts` (cwd=`frontend/`)<br>`npx playwright test tests/e2e/wave2-screen-repair-resync.spec.ts tests/e2e/wave2-terminal-restore.spec.ts tests/e2e/terminal-authority.spec.ts --project "Desktop Chrome"` (cwd=`frontend/`) |
| 핀 영향 | **P2**(`WebSocketContext.tsx` `:49` · `TerminalContainer.tsx` `:53` · `TerminalView.tsx` `:52` · `visibleOutputRecovery.ts` `:55`) · **P3**(같은 4개가 `authority-promotion-evidence.test.mjs:129-140` 에도 있음) |

---

#### S4-C5 — 수신 분기 + 프론트 코덱 (바이너리 경로 신설, 프로덕션 미도달)

| 항목 | 내용 |
|---|---|
| 작업 | `frontend/src/utils/binaryFrameCodec.ts`(신규, §5.3 범위) · `WebSocketContext.tsx:687` 앞 2단 분기(`03:113`) · `binaryType='arraybuffer'` 를 **`:1201` 직후 `:1206` 이전**(control, `03:97`) 과 **`:1007` 직후 `:1009` 이전**(split output, `03:98`) · 채널/authorityEpoch 등록부 ref(§2.1) · `fromBinaryOutputFrame` 어댑터 |
| **불변 계약** | 협상 미체결이므로 ArrayBuffer 가 도착하지 않는다 → **프로덕션 동작 불변** |
| 실패 테스트 | `06:1501-1503` 의 **정합성 RED 11건 전건**. 그중 이 단계 소관: Blob 명시 거부 · length 초과 프레임 명시 수렴 · 배치 2프레임 순서 처리 · 협상 회신 전 바이너리 프레임 비수용 · grace 버퍼 `chunk-cap-exceeded`(`WebSocketContext.tsx:477`) · 스케줄러 `visible-output-overflow`(`terminalOutputScheduler.ts:15`) — ⚠️ *"두 계층의 사유 문자열을 섞지 말 것"*(`03:720`) |
| 골든 벡터 | §5.4 전건 |
| 경계 대조군 | ① **string 프레임이 같은 경로로 오면 정상 JSON 처리** (`06` F7 대칭) — 실패하면 분기 자체가 망가진 것 ② `binaryType` 미설정 상태를 강제해 Blob 을 만들면 **거부 + 기록**, 설정 상태면 ArrayBuffer 로 성공 ③ `visibleOutputQueueMaxBytes` 를 낮춰 `payload-limit-exceeded`(scoped) 를 트립시키고 **같은 배치의 다음 프레임이 살아남는지**(`06` D13) |
| ⚠️ 뷰 retention | `03:140`/`:800` #3 — 배치 상한이 DRR quantum 이라 프레임 1개가 quantum 전체를 붙잡는다. **[설계결정] `enqueueBytes` 로 큐에 넣는 시점에 `.slice()` 로 분리한다.** 근거: 회계를 실제 점유 기준으로 바꾸면 `visibleOutputQueueMaxBytes`(`inputReliabilityMode.ts:70`)의 의미가 codec 마다 달라져 `binary-shadow` 의 동등성 비교(S4-C6)가 성립하지 않는다. **복사 1회는 `JSON.parse` + `TextEncoder.encode` 2회를 없앤 대가로 감내 가능하다 [추정].** ⚠️ 선례: `terminalWriteCoordinator.ts:1981` 이 이미 compatibility-write 경로에서 `command.data.slice()` 를 한다 |
| 파일 | 위 + `frontend/tests/unit/binaryFrameCodec.test.ts`(신규) · `frontend/tests/unit/wsFrameDispatch.test.ts`(S3 에서 신설된 파일 확장 — `06:1378`) |
| 검증 커맨드 | `node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts` (cwd=`frontend/`)<br>`node --experimental-strip-types --test tests/unit/wsFrameDispatch.test.ts` (cwd=`frontend/`) |
| 회귀 커맨드 | `node --experimental-strip-types --test tests/unit/webSocketBackpressure.test.ts tests/unit/splitWebSocketLifecycle.test.ts tests/unit/wsCheckpointProtocol.test.ts` (cwd=`frontend/`)<br>`npx playwright test tests/e2e/grid-equal-mode.spec.ts tests/e2e/terminal-authority.spec.ts --project "Desktop Chrome"` (cwd=`frontend/`) |
| 핀 영향 | **P2**(`WebSocketContext.tsx` `:49`) · **P3**(`WebSocketContext.tsx` = `authority-promotion-evidence.test.mjs:135`). ⚠️ **P3 는 `:934`/`:938` 의 실 WS 프로브가 모든 프레임을 무조건 `JSON.parse` 하므로**(`05:145`) `binaryType='arraybuffer'` 설정만으로도 green 실행이 깨질 수 있다 **[추정]** — S3 에서 이미 손댔어야 하는 항목이나 §7.4 에 재확인 항목으로 올린다 |

---

#### S4-C6 — 소켓 ingress 마이크로벤치 + 의미 동등성

| 항목 | 내용 |
|---|---|
| 작업 | `03:697-706` 의 신규 마이크로벤치. baseline arm = JSON 문자열 → `JSON.parse` → `fromJsonOutputMessage` → `enqueue`; candidate arm = 동일 payload 의 바이너리 프레임 → `decodeWsMessage` → `fromBinaryOutputFrame` → `enqueueBytes` |
| 정확 게이트 | bytes ingress 당 `TextEncoder.encode` 호출 **0** · 인코더 결과 할당(`encoderResultAllocationCount`) **0** · output digest parity 동일 · consumed bytes 동일 (`06:1482-1487`) |
| 통계 게이트 | paired bootstrap p95 delta 의 95% CI 상한 ≤ baseline p95 의 5%. ⚠️ **measurement-noise tolerance 이지 product SLO 가 아니다**(`03:695`) |
| **경계 대조군 (필수)** | ANSI 이스케이프가 **없는 순수 ASCII 코퍼스**로도 돌린다 (`03:705`) — 팽창이 없는 조건에서도 차이가 나야 재고 있는 것이 codec 비용임이 확정된다 |
| 의미 동등성 | 같은 논리 output 에 대해 두 arm 의 IR 이 **필드 단위로 동일**해야 한다 (`chunks[i].byteLength`·`screenSeq`·`authorityEpoch`·`chunkId`). ⚠️ `chunkId` 는 바이너리에서 `String(chunkIdBase + chunkIdDelta)` 로 복원되므로(`01:506` 세그먼트 필드, `01:510` 복원 규칙) **문자열 형태까지** 같아야 한다 — `frontend/src/utils/visibleOutputRecovery.ts:1360`·`:1364`·`:1403-1404` 가 문자열 `chunkId` 로 중복제거하기 때문 (`03:170`) |
| 파일 | `frontend/tests/benchmarks/wsIngressCodecBenchmark.test.ts`(신규) · `frontend/tests/unit/terminalOutputDeliveryParity.test.ts`(신규) |
| 검증 커맨드 | `node --experimental-strip-types --test tests/benchmarks/wsIngressCodecBenchmark.test.ts` (cwd=`frontend/`)<br>`node --experimental-strip-types --test tests/unit/terminalOutputDeliveryParity.test.ts` (cwd=`frontend/`) |
| 회귀 커맨드 | `node --experimental-strip-types --test tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts tests/benchmarks/terminalNoRenderFixture.test.ts` (cwd=`frontend/`) |
| 핀 영향 | **0**(신규 테스트 파일만). ⚠️ `tests/benchmarks/` 는 Playwright 미수집이며 이것을 도는 npm 스크립트가 **없다** — §12 CI 등록 필요 |

---

### 6.3 단계 순서와 의존

```
S4-C0 (P5 재고정, 워킹트리 정리 선행)
  └→ S4-C1 (xterm 특성화, 코드 0)          ← 결과가 C3·C5 의 설계를 확정
        └→ S4-C2 (enqueueBytes)
              └→ S4-C3 (하류 시그니처 + restore 게이트)
                    └→ S4-C4 (IR 도입, JSON 전용)   ← 최대 위험, 그러나 바이너리 무관
                          └→ S4-C5 (수신 분기 + 프론트 코덱)
                                └→ S4-C6 (벤치 + 동등성)
```

**C1 은 C2 와 병렬 가능**하다(코드 접점 0). 나머지는 직렬이다 — C3 가 C2 의 진입점을 쓰고, C4 가 C3 의 확장된 시그니처를 쓰고, C5 가 C4 의 IR 을 쓴다.

### 6.4 S4 착수 차단 항목 (클라이언트 관점)

| # | 차단 | 근거 | 해소 주체 |
|---|---|---|---|
| 1 | **D15 — 배정 opcode 7개 중 4개 인코딩 불가** | `06:1263-1276`. `0x03`/`0x04`/`0x06`/`0x07` 송신 경로 없음 | 서버(S4-a). ⚠️ **클라이언트 영향**: `repairToken` 갱신원이 `0x03` 이므로(`01:538`) (b)안 채택 시 §2.2 의 "갱신원은 전부 JSON" 판정이 확정되고, (a)안이면 프론트 코덱이 `0x03` 프롤로그를 알아야 한다 |
| 2 | **P5 가 이미 RED** | `03:626-653` | S4-C0 |
| 3 | **워킹트리가 P2/P3 핀 파일 전부 dirty** | §7.3 | 커밋/정리 후 착수 |
| 4 | **§S3 의 조용한 폐기 8항목 전건 해소** | `06:1463` (진입 조건) | S3 |
| 5 | ACK 도메인 전환의 서버 선행 (`WsTransportMessage.sourceSeq` 승격) | §3.2 | **S4 차단 아님 — S5-c 차단** |

---

## 7. 과제 7 — 핀 영향 판정

### 7.1 P2 `canary-admission-evidence` — 확인 완료, **재발행 필수**

`tools/wave3/canary-admission-evidence.test.mjs:37-56` 의 `productionSourcePaths` **18개** 중 S4 클라이언트가 건드리는 것:

| 라인 | 파일 | S4 단계 |
|---|---|---|
| `:49` | `frontend/src/contexts/WebSocketContext.tsx` | C4 · C5 |
| `:50` | `frontend/src/types/ws-protocol.ts` | C4 (IR 타입 · 협상 메시지 5종 선언) |
| **`:52`** | **`frontend/src/components/Terminal/TerminalView.tsx`** | C3 · C4 |
| **`:53`** | **`frontend/src/components/Terminal/TerminalContainer.tsx`** | C4 |
| `:54` | `frontend/src/utils/terminalOutputScheduler.ts` | C2 · C3 |
| `:55` | `frontend/src/utils/visibleOutputRecovery.ts` | C4 (`assertContiguousSegments` 추출) |

> **문제의 두 줄은 사실이다.** `:52` = `TerminalView.tsx`, `:53` = `TerminalContainer.tsx` — `06` §1.5 P2 행의 5차 검증 L-4 정정과 일치한다.

**게이트 메커니즘**: `:473` `hashesFor(productionSourcePaths)` → `:519` `implementationInputs` → `:638-642` `--regenerate-green` 이 아니면 `assert.deepEqual(recordedArtifact, artifact, …)` 로 **대조**한다. 즉 **파일 내용이 1바이트만 바뀌어도 red.**

**판정**: **재발행 필요. 6개 파일 전부.** 재발행 커맨드는 `node tools/wave3/canary-admission-evidence.test.mjs --regenerate-green` (루트, node:test 아님, 플래그는 `:16` 에 정의).

**추가 핀 — `focusedCommands`(`:58-79`, 프론트 블록은 `:67-79`)**: 프론트 4개 파일명이 하드코딩되어 있다(`tests/unit/terminalOutputScheduler.test.ts`, `terminalViewRecoveryContract.test.ts`, `terminalContainerRecoveryContract.test.ts`, `visibleOutputRecovery.test.ts`). **[설계결정] S4 의 신규 테스트를 이 4개 파일에 추가하지 않는다** — 새 파일에 쓰면 실행 테스트 이름 집합이 안 바뀌어 재발행 폭이 최소화된다(`05:351`). 위 §6 의 파일 배치가 전부 신규 파일인 이유다.

### 7.2 P3 `authority-promotion-evidence` — **06 의 서술이 좁다** (정정)

`06` §1.5 P3 는 *"`frontend/src/contexts/WebSocketContext.tsx` 와 `frontend/src/types/ws-protocol.ts` 의 sha256 포함"* 이라 적었다. 직접 확인한 `redFrontendSourceBaseline`(`tools/wave3/authority-promotion-evidence.test.mjs:129-140`)은 **11개 파일**이고 그중 S4 대상이 5개다:

| 라인 | 파일 | S4 |
|---|---|---|
| `:130` | `frontend/src/utils/terminalCheckpointRuntime.ts` | (S4 범위 밖 — 조건부/후속) |
| `:135` | `frontend/src/contexts/WebSocketContext.tsx` | **C4 · C5** |
| `:136` | `frontend/src/components/Terminal/TerminalView.tsx` | **C3 · C4** |
| `:137` | `frontend/src/components/Terminal/TerminalContainer.tsx` | **C4** |
| `:138` | `frontend/src/types/ws-protocol.ts` | **C4** |
| `:139` | `frontend/src/utils/visibleOutputRecovery.ts` | **C4** |

**발동 조건은 여전히 `--expect-red` 전용이다** — `readProductionGitStatus()`(`:766-777`)의 유일한 호출부는 `:816`, 그것을 감싼 `verifyRedProductionUnchanged()`(`:779`)는 `:2522` 의 `mode === 'red'` 삼항에서만 불린다. 프론트 sha256 대조(`:804-805`)도 같은 함수 안이다.

**판정**: **기본(green) 실행에서는 영향 없음. `--expect-red` 증거는 무효화된다.** `06` D6 이 *"baseline 갱신, P3 재핀 주체는 S3 담당자"* 로 확정했으므로 **S4 는 D6 의 결과를 그대로 이어받되, 06 이 열거하지 않은 4개 파일(`:136`~`:139`)도 baseline 갱신 대상임을 S3 담당자에게 전달해야 한다.**

⚠️ **별도 위험**: `:934`/`:938` 의 실 WS 프로브가 **모든 프레임을 무조건 `JSON.parse`** 한다(`05:145`). S4-C5 가 `binaryType='arraybuffer'` 를 설정하면 이 프로브가 받는 것이 바뀔 수 있다 — 협상 미체결이므로 서버는 바이너리를 보내지 않아 **[추정] 실제로는 안 바뀐다.** 그러나 `--expect-red` 로 확인해야 한다 **[미확인]**.

### 7.3 P1 / P4 / P5

| 핀 | S4 클라이언트 영향 | 판정 |
|---|---|---|
| **P1** fair-scheduler `sourceDigest` | 정의 6개(`server/tools/write-fair-scheduler-source-provenance.mjs:7-14`)가 **전부 `server/src`** | **클라이언트 작업만으로는 0.** S4-a(서버)가 `wsSendPolicy.ts`/`WsRouter.ts` 를 건드리므로 S4 전체로는 ● |
| **P4** `retained-shadow-parity` | `productionSourcePaths`(`:40-45`)가 전부 서버. 진짜 핀은 `expectedFocusedTestNamesSha256`(`:161`, 대조 `:583`)이고 `focusedCommand`(`:47-61`)는 **서버 테스트 4개만** spawn | **클라이언트 작업만으로는 0.** 프론트 테스트 추가는 P4 에 걸리지 않는다 |
| **P5** 스케줄러 벤치 digest | `terminalNoRenderFixtureEvidence.ts:34` vs 워킹트리 `terminalOutputScheduler.ts` | **● S4-C2/C3.** S4-C0 에서 선재고정하고, C2·C3 후 다시 재고정 |

### 7.4 ⚠️ 착수 전 반드시 알아야 할 상태 — 워킹트리가 이미 dirty 하다

`git status --porcelain -- frontend/src server/src tools/wave3` 결과, **P2 `productionSourcePaths` 18개 중 최소 12개**가 이미 `M` 상태다 — `WebSocketContext.tsx` · `TerminalContainer.tsx` · `TerminalView.tsx` · `terminalOutputScheduler.ts` · `visibleOutputRecovery.ts` · `frontend/src/types/ws-protocol.ts` · `server/src/ws/WsRouter.ts` · `server/src/types/ws-protocol.ts` · `SessionManager.ts` 등.

**귀결 3가지:**

1. **P2 는 S4 가 시작되기 전부터 red 다.** `06` §S1 잔여처분 M-1 이 예고한 그대로다 — *"이 아티팩트는 S1 이전부터 이미 stale 이었다 … 지금 재발행하면 완료되지 않은 남의 미커밋 작업(추적 수정 121)이 동결 아티팩트에 박힌다."*
2. **P5 재고정(S4-C0)은 워킹트리 정리 뒤에 해야 한다.** P5 baseline 은 `git show <rev>:<path>`(`terminalOutputSchedulerBenchmark.test.ts:66-73`)로 오지만 candidate 은 `readFileSync(워킹트리)`(`:74-76`)다. dirty 상태에서 재고정하면 남의 변경이 candidate digest 에 들어간다.
3. **S-1 회귀 기준선(`06:755-829`)이 S4 착수 전에 다시 필요하다.** S1/S2 시점의 기준선은 그 사이 워킹트리 변화로 무효다 — 무엇이 "우리가 깬 것" 인지 구분할 수 없다.

---

## 8. 미확인 · 열린 질문

| # | 항목 | 왜 중요한가 | 확인 방법 |
|---|---|---|---|
| 1 | **[미확인]** `terminalReplayGuard.ts:100` 과 `terminalWriteCoordinator.ts:1977-1981` 의 문자열 write 가 checkpoint body 슬라이스 사이에 낄 수 있는가 | §4.2 의 "도달 불가" 판정이 이것에 의존한다 | 코디네이터 큐 전수 + S4-C1 Arm C |
| 2 | **[미확인]** P3 의 `--expect-red` 실행이 `binaryType='arraybuffer'` 설정만으로 깨지는가 | §7.2 | S4-C5 후 `node tools/wave3/authority-promotion-evidence.test.mjs --expect-red` (루트) |
| 3 | **[설계결정 필요]** `@xterm/headless` 를 `frontend/devDependencies` 에 추가할 것인가 | S4-C1 Arm A 의 실행 가능성 | 사용자 승인 |
| 4 | **[미확인]** `06` §4.2 의 `wsSendPolicy.ts` 줄번호 5개(`:839`/`:840`/`:843`/`:844`/`:845`)가 **현재 트리에서 8줄 어긋나 있다** — 실제는 `:847`/`:848`/`:851`/`:852`/`:853`. `fairDeliveryBytes` 도 `:598-611` → **`:606-618`** | S1 이 사이드카 3필드를 추가하며 밀린 것으로 보인다 **[추정]**. S5-a0 담당자가 옛 줄번호로 찾으면 엉뚱한 코드를 고친다 | `06` 개정 |
| 5 | **[설계결정 필요]** ACK 도메인 전환을 S5 의 어느 하위 단계에 넣을 것인가 | §3.2 — `06` §5 S5 에 해당 항목이 **없다**. opt-in 진입의 하드 선행조건인데 계획에 자리가 없다 | `06` 개정 |
| 6 | **[미확인]** `01:320` 의 *"매핑은 … **변경 시** JSON control 로 전달한다"* 가 상정한 변경 메시지가 D10 의 5종에 없다 | §2.1 의 판정(세션 상수)이 맞다면 이 조항 자체가 불필요하다 → `01` 개정 대상 | `01` 개정 시 함께 |
| 7 | **[미확인]** `01:540` 의 세그먼트별 `authorityEpochIndex` 필요성 — §2.1 이 "불필요" 로 판정했으나 `01` 문면은 열려 있다 | 세그먼트 16B ↔ 18B 를 가른다. **S2 골든 벡터가 이미 16B 로 확정되어 있으므로 18B 로 가면 벡터 전건 재계산** | `01` 개정 |
| 8 | **[추측]** `.slice()` 로 뷰를 끊는 비용이 `JSON.parse`+`encode` 제거 이득보다 클 가능성 | §6 S4-C5 의 `[설계결정]` 근거가 `[추정]` 이다 | S4-C6 마이크로벤치가 실측으로 판정 |
| 9 | **[미확인]** `06` §5 S4-d 의 진입 조건이 "S1~S3 green" 인데, **S-1 기준선이 이미 red 항목을 다수 포함**한다(`06:829` — *"green 일 필요는 없다"*). 두 문장의 정합 | S4 착수 판정 자체가 모호하다 | `06` 개정 |

---

## 9. 참조

| 문서 · 파일 | 관계 |
|---|---|
| `docs/research/binary-comms/06-work-plan.md` §5 S4 (`:1386-1503`) | 상위 계획. 이 문서는 그 S4-b/S4-c/S4-e 를 실행 가능한 하위 단계로 분해한다 |
| `docs/research/binary-comms/06-work-plan.md` §3.5(`:505-541`) · §4(`:544-724`) | 결정 SSOT. D3(unified 전용) · D4(벡터 1곳) · D13(12종·성질 등급) · D15(opcode 4개 인코딩 불가)가 이 문서의 전제 |
| `docs/research/binary-comms/03-client-decode-path.md` | 클라이언트 사실 지도. §2 수신 경로 22단계, §11 변경 지점 표, §12 열린 질문. 이 문서는 그중 **#1(현행 결함)·#5(매핑 순서)·#7(ACK 영향)** 을 판정했다 |
| `docs/research/binary-comms/01-frame-format-and-negotiation.md` | 프레임 28B · 프롤로그 · 협상 5종 · ACK 도메인(§2.4 `:736-764`) |
| `server/src/ws/binaryFrameCodec.ts` | S2 산출물. 프론트 코덱이 **모방하되 import 하지 않는** 대상 |
| `server/src/ws/__fixtures__/binary-frame-vectors.json` | 골든 벡터 SSOT. 프론트가 `../../../server/src/ws/__fixtures__/…` 로 읽는다 |
| `tools/wave3/canary-admission-evidence.test.mjs:37-56` | P2 핀. `:52`/`:53` = `TerminalView.tsx`/`TerminalContainer.tsx` 확인됨 |
| `tools/wave3/authority-promotion-evidence.test.mjs:129-140` | P3 핀. **11개 파일** (06 의 서술보다 넓다) |
| `frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts:25`,`:34` | P5 핀. 현재 RED |
| 메모리 `check_operands_must_have_independent_origins` | §5.2 이중 구현 · §6 S4-C4 차분 대조군의 근거 |
| 메모리 `boundary_control_for_fault_tests` | 모든 단계의 경계 대조군 의무 |
| 메모리 `unchecked_private_field_casts_go_vacuous` | §5.4 픽스처 스키마 드리프트 가드 |
| 메모리 `buildergate_npm_ci_node_env_production_silent_trap` | §4.4 devDependency 위험 |
