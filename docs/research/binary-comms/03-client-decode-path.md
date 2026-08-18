# 클라이언트 디코드 경로 — 바이너리 전환 시 프론트엔드 변경 지점

| 항목 | 값 |
|---|---|
| 조사일 | 2026-08-16 |
| 상위 결정 | `docs/research/binary-comms/00-decision-record.md` — 바이너리 전환 무조건 착수 |
| 범위 | **프론트엔드 수신·디코드 경로만.** 서버 송신·프레임 생성은 범위 밖 (필요한 곳만 의존성으로 표기) |
| 전제 | control 평면 JSON 유지, terminal output/snapshot 평면만 바이너리 |
| 프레임 | **`01-frame-format-and-negotiation.md` §1.1 의 28바이트 헤더 확정안을 따른다.** 이 조사 착수 시점의 21바이트 초안은 **폐기** — 아래 §0 참조 |
| 산출 | 이 문서 1개. **코드 변경 없음** |

---

## 0. 프레임 확정안과의 정합 (착수 시 초안 대비)

이 조사는 21바이트 헤더 초안 `[opcode 1B][channelId 4B][streamEpoch 4B][sourceSeq 8B][length 4B]` 을 전제로 시작했으나, 병행 작성된 `docs/research/binary-comms/01-frame-format-and-negotiation.md` 가 프레임을 확정했다. **확정안이 우선한다.** 달라진 것과 그로 인해 이 문서에서 무효가 된 서술은 다음과 같다.

| 항목 | 착수 시 초안 | 확정안 (`01` §1.1) | 이 문서에 미친 영향 |
|---|---|---|---|
| 헤더 크기 | 21B | **28B** | §3.3 오프셋 전면 교체 |
| 필드 구성 | opcode/channelId/streamEpoch(4B)/sourceSeq/length | `frameVersion`(1) `opcode`(1) `flags`(2) `channelId`(4) `streamEpoch`(**8**) `sourceSeq`(8) `payloadLength`(4) | `streamEpoch` 이 4B→8B, `frameVersion`·`flags` 신설 |
| 배칭 | 미정 | **1 WS 메시지 = N 프레임 허용 확정** (`01` §1.7), `END_OF_BATCH` 플래그 | §3.6 의 [미확인] 해소 — 배치 루프가 **필수**가 됨 |
| 메타데이터 10개 (소비 9 + 미소비 1) | 초안에 없음 (이 문서가 최대 공백으로 지목) | **payload 프롤로그로 해결** (`01` §1.8), 일부는 채널 상태 승격 / opcode 파생 (`01` §1.9) | §3.5 를 "공백"에서 "확정된 해법의 클라이언트 영향"으로 교체 |
| ACK 도메인 | 미정 | **`sourceSeq` 로 통일**, `deliverySeq` 는 서버 내부 회계로 강등 (`01` §1.9 · `01` §2.4) | §7.4 의 열린 질문 축소 |
| 엔디안 | 미표기 | **big-endian** 확정 | §3.3 의 판단과 일치 |

**이 문서에서 여전히 유효한 것**: §2 의 수신 경로 지도, §4 의 스케줄러 진입점 분석, §5·§6 의 xterm write 계약과 디코더 상태 위험, §7.2 의 수신측 청크 회계, §8 의 평면 구분, §9 의 성능 근거, §10 의 측정 설계와 벤치 RED 상태. 이것들은 **프레임 레이아웃과 독립적인 클라이언트 코드 사실**이다.

표기법: 모든 참조는 repo-relative POSIX `경로:라인`. 저장소에서 확인하지 못한 것은 **[미확인]**, 이 문서가 제안하는 판단은 **[설계결정]**, 근거 있는 추정은 **[추정]** 으로 표시한다. 실측이 없는 곳에 숫자를 만들어 넣지 않았다.

---

## 1. 요약

가장 중요한 사실 여섯 가지.

1. **가장 무거운 작업은 payload 가 아니라 메타데이터다.** `TerminalOutputMessage` 가 `data` 외에 싣는 **메타데이터 10개** 중 **9개**를 클라이언트가 소비한다(`deliveryKind` 는 소비 0건). `01` §1.8 · `01` §1.9 가 프롤로그·채널상태·opcode파생으로 전달 방안을 확정했는데, 그 결과 클라이언트에는 **새 상태 세 가지**가 생긴다 — `authorityEpochIndex`↔UUID 매핑 테이블, `replayToken`/`repairToken` 채널 상태, 그리고 `deliverySeq`→`sourceSeq` ACK 도메인 전환. 필드 매핑이 아니라 **상태 도입**이며, §11 의 두 행이 난이도 L 인 이유다 (§3.5).

2. **바이너리 파이프는 이미 절반이 깔려 있다.** `Uint8Array` 는 스케줄러 flush 출구(`frontend/src/utils/terminalOutputScheduler.ts:1308`)부터 xterm(`frontend/src/utils/terminalRawMutationAdapter.ts:82`)까지 **변환 없이 그대로 흐른다**. 이 구간은 손댈 필요가 없다.

3. **변환 장벽은 정확히 한 곳이다.** `terminalOutputScheduler.ts:1367` (`enqueue`) 과 `:1460` (`enqueueLegacy`) 의 `textEncoder.encode(data)`. 스케줄러의 **입구만 `string` 전용**이고 출구는 이미 바이트다. 바이너리 전환의 본체는 "입구에 바이트 진입점을 하나 더 내는 것"이다.

4. **기본 런타임에서 바이너리 프레임은 control 소켓으로 온다.** `wsTransportMode` 기본값이 `unified` (`server/src/schemas/config.schema.ts:56`, `server/config.json5` 에 `realtime` 블록 없음) 이므로 split output 소켓(`frontend/src/contexts/WebSocketContext.tsx:1007`)은 **생성되지 않는다**. 따라서 `binaryType` 과 string/ArrayBuffer 분기는 **control 소켓(`:1201`)에 반드시 들어가야 한다.** output 소켓만 고치면 기본 경로에서 아무 효과가 없다.

5. **xterm 의 UTF-8 디코더는 write 마다 상태를 이어간다 — 그러나 string 디코더와 별개 인스턴스다.** 번들 소스에서 확인: `this._stringDecoder=new StringToUtf32, this._utf8Decoder=new Utf8ToUtf32` 이고 `Utf8ToUtf32` 는 `this.interim=new Uint8Array(3)` 로 미완성 시퀀스 3바이트를 보류한다. **[추정]** 같은 터미널에 string write 와 Uint8Array write 를 섞으면 보류 중인 바이트를 건너뛰고 뒤 문자가 먼저 파서에 들어간다 — 구조상 그렇게 읽히나 **재현 테스트는 없다**(§12 #2). 최대 정합성 위험이며, checkpoint 평면 때문에 **이 조건은 오늘 이미 성립해 있다** — 신규 위험이 아니라 기존 조건의 일반화다 (§6.3).

6. **측정 기구가 지금 고장나 있다.** 전후 비교의 주 계측기인 `frontend/tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` 가 **현재 트리에서 이미 RED** 다 — 고정된 candidate digest 와 실제 파일이 불일치한다 (§10.1). 전환 착수 전에 재고정이 선행해야 한다.

---

## 2. 현재 수신 경로 전수

서버가 보낸 `{type:'output'}` 한 건이 브라우저에서 xterm 셀에 닿기까지의 전 구간이다. 굵게 표시한 것이 **항상** 실행되는 단계다.

| # | 위치 | 하는 일 | 조건 |
|---|---|---|---|
| 1 | `frontend/src/contexts/WebSocketContext.tsx:1201` | control 소켓 생성. **`binaryType` 미설정** → 기본 `'blob'` | 항상 |
| 2 | `frontend/src/contexts/WebSocketContext.tsx:1007` | split output 소켓 생성. 역시 `binaryType` 미설정 | split 모드일 때만 (**기본값 아님**) |
| 3 | **`frontend/src/contexts/WebSocketContext.tsx:687`** | **`JSON.parse(event.data)`. string/Blob/ArrayBuffer 분기 없음** | **항상** |
| 4 | `frontend/src/contexts/WebSocketContext.tsx:688-690` | 파싱 실패 시 **로그 없이 `return`** (silent drop) | 실패 시 |
| 5 | `frontend/src/contexts/WebSocketContext.tsx:469` | `getOutputUtf8ByteLength(msg.data)` → `frontend/src/utils/terminalOutputHotPath.ts:12` 에서 `encode(raw).length` | grace 버퍼링 중 |
| 6 | **`frontend/src/contexts/WebSocketContext.tsx:1140`** | `handlers.onOutput?.(msg.data, msg)` — **string 그대로** 전달 | **항상** (라이브) |
| 6′ | `frontend/src/contexts/WebSocketContext.tsx:592` | `handlers.onOutput?.(output.data, output)` — **grace 버퍼 재생 경로**. 같은 핸들러로 들어가지만 **메시지 객체를 보관했다 재생**한다 | 핸들러 등록 지연 후 flush 시 |
| 7 | `frontend/src/components/Terminal/TerminalContainer.tsx:3388` (동일 패턴 `:3214`, `:3302`) | `splitVisibleOutputSourceSegments(data, output.sourceSegments)` | `sourceSegments` 존재 시 |
| 8 | `frontend/src/utils/visibleOutputRecovery.ts:415` | `new TextEncoder().encode(data)` — **호출마다 인코더 인스턴스 신규 생성** | 위와 동일 |
| 9 | `frontend/src/utils/visibleOutputRecovery.ts:440,443` | `TextDecoder(...).decode(encoded.subarray(...))` — 세그먼트 수만큼 | 위와 동일 |
| 10 | `frontend/src/components/Terminal/TerminalView.tsx:1670` | `getOutputUtf8ByteLength(data)` | retry 큐 비어있지 않을 때 |
| 11 | **`frontend/src/components/Terminal/TerminalView.tsx:1673`** | **`scheduler.enqueue(data: string, ...)`** — `writeOutput` 시그니처 `:1639-1645` 가 `data: string` 으로 고정 | **항상** |
| 12 | **`frontend/src/utils/terminalOutputScheduler.ts:1367`** | **`const bytes = textEncoder.encode(data)`** ← **변환 장벽** | **항상** (비어있지 않은 ingress) |
| 13 | `frontend/src/utils/terminalOutputScheduler.ts:1460` | `enqueueLegacy` 의 동일 인코딩 | legacy 경로 |
| 14 | `frontend/src/utils/terminalOutputScheduler.ts:810` | retry 큐 `defer` 시 `textEncoder.encode(entry.data).byteLength` | canary 거절 시 |
| 15 | **`frontend/src/utils/terminalOutputScheduler.ts:1238`** | `findUtf8SliceEnd(entry.bytes, headOffset, visibleFlushBudgetBytes)` | **항상** |
| 16 | **`frontend/src/utils/terminalOutputScheduler.ts:1269`** | `entry.bytes.subarray(headOffset, sliceEnd)` — **복사 없음** | **항상** |
| 17 | **`frontend/src/utils/terminalOutputScheduler.ts:1308`** | `options.write(slice, ...)` — **여기부터 `Uint8Array`** | **항상** |
| 18 | **`frontend/src/components/Terminal/TerminalView.tsx:1589`** | `write: (chunk, onWritten, onRejected) => writeOutputDirect(term, chunk, ...)` | **항상** |
| 19 | **`frontend/src/components/Terminal/TerminalView.tsx:1495-1497`** | `writeOutputDirect(term, data: TerminalOutputWriteData, ...)` | **항상** |
| 20 | **`frontend/src/components/Terminal/TerminalView.tsx:1519`** | `coordinator.submitCompatibility({type:'write', kind:'live', data})` | **항상** |
| 21 | **`frontend/src/utils/terminalWriteCoordinator.ts:1046`** (및 `:1050`, `:1095`, `:1101`) | `options.adapter.write({kind, data}, onWritten)` — 어댑터 계약 `:25-29` 가 `string \| Uint8Array` | **항상** |
| 22 | **`frontend/src/utils/terminalRawMutationAdapter.ts:82`** | **`terminal.write(command.data, onWritten)`** — xterm 도달 | **항상** |

### 2.1 이 지도에서 바로 읽히는 것

- **17 → 22 구간(6단계)은 이미 완전한 바이너리 경로다.** 타입도 `Uint8Array` 를 허용하고, 런타임 가드도 `terminalWriteCoordinator.ts:1679`, `:1894`, `:1974` 에서 `command.data instanceof Uint8Array` 로 실제 분기한다 (`:1782` 은 같은 검사를 `command.parserTail` 에 적용).
- **3 과 12 두 개만이 항상 도는 JSON/인코딩 비용이다.** 나머지 인코딩(5, 8, 10, 14)은 전부 조건부이거나 회계용이다.
- **7~9 는 완전한 왕복이다.** `string → TextEncoder.encode → subarray → TextDecoder.decode → string`. 서버가 `sourceSegments` 를 **바이트 오프셋**(`byteStart`/`byteEnd`, `frontend/src/types/ws-protocol.ts:791-792`)으로 보내는데 wire 는 문자열이라, 오프셋을 적용하려고 바이트로 되돌렸다가 다시 문자열로 만든다. **바이너리 wire 에서는 이 왕복이 통째로 사라진다** — `payload.subarray(byteStart, byteEnd)` 한 줄이 된다.

---

## 3. 디코딩 경로 설계 (과제 1)

### 3.1 `binaryType` 설정 위치

**두 소켓 모두에 설정한다.** 생성 직후, 어떤 핸들러보다 먼저.

| 소켓 | 생성 | 설정 위치 | 이유 |
|---|---|---|---|
| control | `frontend/src/contexts/WebSocketContext.tsx:1201` | `:1201` 직후, `:1206` 의 `wsRef.current = ws` 이전 | **기본 `unified` 모드에서 output 프레임이 이 소켓으로 온다** |
| split output | `frontend/src/contexts/WebSocketContext.tsx:1007` | `:1007` 직후, `:1009` 의 `onmessage` 할당 이전 | split 활성화 시 |

**[설계결정] `'blob'` 기본값을 그대로 두면 안 된다.** Blob 은 바이트를 꺼내려면 `await blob.arrayBuffer()` 가 필요한데, 이는 프레임마다 마이크로태스크 홉을 넣는다. `onmessage` 는 동기적으로 순서대로 불리지만 **Promise 해소 순서로 출력 순서를 보장하는 근거가 명세에 없다**. 터미널 출력은 순서가 곧 정확성이므로 `'arraybuffer'` 가 유일하게 안전한 선택이다. 부수 효과로 프레임당 Blob 객체 할당도 사라진다.

### 3.2 `onmessage` 분기

수신 처리는 실질적으로 `frontend/src/contexts/WebSocketContext.tsx:684-1179` 의 `handleMessage` **한 곳**으로 수렴한다 (control 은 `:1239`, output 은 `:1010` 이 같은 함수로 위임). 따라서 분기도 한 곳이면 된다 — `:687` 의 `JSON.parse` **앞**.

```
// 개념 스케치 (구현 아님)
if (event.data instanceof ArrayBuffer) { handleBinaryFrame(event.data); return; }
if (typeof event.data !== 'string') { rejectNonArrayBufferBinary(event.data); return; }
// ...기존 JSON 경로 :686-690 그대로
```

**분기가 두 단계인 이유.** `ArrayBuffer` 만 동기적으로 파싱할 수 있다. `binaryType` 이 어떤 이유로든 `'blob'` 로 남으면 `event.data` 는 Blob 이고, Blob 은 `await blob.arrayBuffer()` 없이는 바이트를 꺼낼 수 없으므로 **동기 핸들러에서 처리 자체가 불가능**하다. 따라서 Blob 은 "처리"가 아니라 **명시적 거부 + 기록** 대상이다 — 여기서 조용히 흘려보내면 §3.1 의 오설정이 런타임에 드러나지 않는다. (초안에서 `typeof !== 'string'` 하나로 합쳤던 것은 Blob 을 동기 파서에 넘기는 오류였다.)

### 3.3 프레임 파싱 — DataView

**[설계결정] `DataView` 를 쓰고 수동 시프트 연산을 쓰지 않는다.**

헤더는 **28바이트**다 (`01` §1.1 확정안).

```
frameVersion  : getUint8(0)            // v1 = 0x01
opcode        : getUint8(1)
flags         : getUint16(2,  false)   // END_OF_BATCH / PROLOGUE_PRESENT 등
channelId     : getUint32(4,  false)
streamEpoch   : getBigUint64(8,  false)
sourceSeq     : getBigUint64(16, false)
payloadLength : getUint32(24, false)
payload       : new Uint8Array(buffer, offset + 28, payloadLength)  // 뷰, 복사 없음
```

**`frameVersion` 을 가장 먼저 읽고 화이트리스트로 거른다.** 미지의 버전은 opcode 해석을 시도하지 않고 즉시 fail-closed 로 보낸다 — 버전이 다르면 그 뒤 오프셋의 의미 자체가 보장되지 않기 때문이다.

근거:
- `getUint32` 는 부호 문제를 알아서 처리한다. 수동 시프트(`b<<24 | ...`)는 JS 비트연산이 int32 라 최상위 비트에서 음수가 되며, 이 계열 버그는 `channelId`/`length` 가 2GiB 를 넘기 전까지 드러나지 않는다.
- `streamEpoch` / `sourceSeq` **각 8바이트**는 `getBigUint64` 외에 정확한 수단이 없다. `Number` 로 읽으면 2^53 에서 조용히 정밀도를 잃는다. (초안은 `streamEpoch` 을 4B 로 뒀으나 확정안은 8B 다 — §0)
- 엔디안을 **인자로 명시**(`false` = big-endian/network order)해야 한다. `DataView` 는 기본이 big-endian이지만 `TypedArray` 는 플랫폼 의존이므로, 나중에 누가 `new Uint32Array(buffer)` 로 바꿔 쓰면 x86 에서만 통과하는 코드가 된다. 명시가 그 사고를 막는다.
- `new Uint8Array(buffer, 21, length)` 는 **뷰**이므로 payload 복사가 없다. 이것이 바이너리 전환의 실질 이득 중 하나이며, `.slice()` 를 쓰면 그 이득이 사라진다.

**뷰 retention 주의 — 배치 확정으로 실제 문제가 됐다.** 뷰가 큐에 살아 있는 동안 **원본 `ArrayBuffer` 전체가 GC 되지 않는다.** `01` §1.7 이 배칭을 확정했고 배치 상한이 `bulkSliceBytes`(DRR quantum) 이므로, **프레임 하나만 큐에 남아도 quantum 전체가 붙잡힌다.** 그러면 `visibleOutputQueueMaxBytes` 회계(payload 길이 기준)와 실제 점유 메모리가 어긋난다. **[설계결정]** 큐 보관 시점에 `.slice()` 로 분리하거나 회계를 실제 점유 기준으로 바꾼다 — 배치가 확정된 이상 둘 중 하나는 **반드시** 해야 한다. 이것이 §9.3 의 "복사 0" 이득과 정면으로 상충하는 유일한 지점이다.

### 3.4 `sourceSeq` 표현 불일치 — 반드시 결정해야 할 항목

현재 프로토콜의 ordinal 은 **두 가지 표현이 공존**한다.

| 표현 | 타입 | 예 | 정의 |
|---|---|---|---|
| canonical uint64 decimal **string** | `Ordinal64 = string` | `streamEpoch`, `sourceSeq`, `checkpointEpoch`, `snapshotSeq` | `frontend/src/types/ws-protocol.ts:18`, 파서 `frontend/src/utils/terminalWriteCoordinator.ts:343-352` |
| **number** | `number` | `screenSeq`, `deliverySeq`, `ScreenSnapshotMessage.seq` | `frontend/src/types/ws-protocol.ts:786`, `:799`, `:676` |

바이너리 프레임의 `sourceSeq 8B` 는 자연스럽게 `bigint` 로 읽힌다. 그런데 하류의 `parseCanonicalOrdinal64` 는 `{wire: string, value: bigint}` 를 돌려주며 (`terminalWriteCoordinator.ts:343-352`) 하류 비교가 `wire` 문자열에 의존하는 지점이 있다.

> **`01` §1.4 가 이 절의 전제를 확정했다** — `streamEpoch`/`sourceSeq` 는 Ordinal64(decimal string) 계열이며 wire 에서는 uint64 다. 아래 판단은 그 확정을 전제로 유효하다.

**`bigint → String()` 을 프레임마다 돌리지 말고, `ParsedOrdinal64` 를 bigint 로부터 직접 만드는 생성자를 추가한다.** 프레임마다 문자열을 만들면 바이너리로 없앤 할당을 다시 들여오는 셈이다. 다만 `wire` 필드를 소비하는 지점이 어디까지인지는 **[미확인]** — `terminalWriteCoordinator.ts` 전수 확인이 선행해야 한다.

관련 제약: `REL-BGSTAB-007` AC-4 (Stability=**stable**) 가 Ordinal64 를 "JSON wire 에서는 canonical decimal string 으로만" 고정한다. 바이너리 wire 는 문언상 그 밖이지만, `00-decision-record.md:59` 가 이미 개정 대상으로 올려두었으므로 **SRS 개정과 동기화**해야 한다.

또한 프레임 초안에는 `channelId` 가 있으나 **현행 코드에 `channelId` 개념이 없다** — `channelRole`(`server/src/types/ws-protocol.ts:813`), `lane`(`server/src/ws/wsSendPolicy.ts:37-41`), `connectionEpoch` 세 가지로 흩어져 있다. 클라이언트가 `channelId` 를 무엇에 매핑할지는 **[미확인]**, 서버 프레임 설계(01/02 문서)와 함께 정해야 한다.

### 3.5 output 메타데이터 10개 — 프롤로그로 해결됨 (`01` §1.8 · `01` §1.9)

이 조사는 초안 헤더에 메타데이터가 없다는 점을 최대 공백으로 지목했다. **`01` 이 이를 해결했으므로 공백은 닫혔다.** 남는 것은 **클라이언트가 무엇을 해야 하는가**다.

`TerminalOutputMessage` (`frontend/src/types/ws-protocol.ts:780-801`) 는 `type`/`sessionId`/`data` 외에 **메타데이터 10개**(`:784-800`)를 싣는다. 그중 **9개는 클라이언트가 실제로 소비**하고, **`deliveryKind` 하나는 선언만 있고 소비 지점이 0건**이다 (`frontend/src` 전체에서 `ws-protocol.ts:800` 선언 1건뿐). 확정안에서 각각이 어디로 갔는지와 그에 따른 클라이언트 작업:

| 필드 | 확정안에서의 위치 | 클라이언트가 할 일 |
|---|---|---|
| `screenSeq` | OUTPUT 프롤로그 off 0 (u64) | `bigint` → 기존 `number` 소비처(`TerminalContainer.tsx:3211`, `:3384`, `:3391`)와의 타입 정합 |
| `chunkId` (소비 `TerminalContainer.tsx:3212`, `:3300`, `:3312`) | 프롤로그 off 8 `chunkIdBase`(u64) + 세그먼트별 `chunkIdDelta`(u16) | **절대값 복원 필수** — `visibleOutputRecovery.ts:1360`, `:1364`, `:1403-1404` 가 문자열 `chunkId` 로 중복제거한다. `String(base+delta)` 로 되살려야 함 |
| `authorityRevision` / `authorityEpoch` (소비 `:3385-3386`, `:3393-3394`) | 프롤로그 off 16 (u32) | 그대로 |
| `authorityEpoch` | 프롤로그 off 20 `authorityEpochIndex`(u16) — **UUID 의 채널 로컬 별칭** | **인덱스→UUID 매핑 테이블을 클라이언트가 보유**해야 한다. 매핑은 JSON control 로 오므로 **두 평면 간 상태 동기화**가 새로 생긴다 |
| `sourceSegments[]` | 프롤로그 off 22 `segmentCount`(u16) + 16B 세그먼트 배열 | `splitVisibleOutputSourceSegments` 를 **바이트 오프셋 직접 적용**으로 대체 (§2.1 의 왕복 제거) |
| `replayToken` (소비 `:3199`, `:3231`, `:3392`, `:3436`) / `repairToken` (소비 **`:3305`** 단 1곳) | **채널 상태로 승격.** 발급 메시지(0x02/0x03)가 갱신, output 은 암묵 참조 | **클라이언트가 채널별 현재 토큰을 들고 있어야 한다** — 지금은 메시지마다 실려 오므로 상태 보관 로직이 신규다 |
| `deliveryKind` — **클라이언트 소비 0건** (`ws-protocol.ts:800` 선언뿐) | **opcode 에서 파생** | **작업 없음.** 소비처가 없으므로 전환 비용 0. 서버가 왜 보내는지는 `02` 범위 |
| `connectionEpoch` | 프레임에 없음. 소켓 스코프이므로 협상 시 1회 합의 | 협상 결과를 연결 수명 동안 보관 |
| `deliverySeq` | 프레임에 없음. **ACK 도메인이 `sourceSeq` 로 통일**되고 `deliverySeq` 는 서버 내부 회계로 강등 | **ACK 조립(`TerminalContainer.tsx:3398-3402`)을 `sourceSeq` 기준으로 재작성** |

**클라이언트 관점에서 가장 무거운 셋** — 전부 "필드를 옮겨 담는" 수준이 아니라 **새 상태를 갖는** 일이다.

1. **`authorityEpochIndex` ↔ UUID 매핑 테이블.** 바이너리 프레임이 인덱스만 주고 매핑은 JSON control 로 오므로, **매핑이 도착하기 전에 그 인덱스를 쓰는 프레임이 오면** 어떻게 할지 정해야 한다. `[미확인]` — `01` 이 이 순서 보장을 다루는지 확인하지 못했다.
2. **`replayToken`/`repairToken` 채널 상태.** 지금은 stateless(메시지마다 동봉)인데 stateful 로 바뀐다. 재연결·epoch 롤백 시 이 상태를 언제 버릴지가 새 계약이다.
3. **ACK 도메인 전환.** `deliverySeq` → `sourceSeq`. 기존 ACK 경로(`TerminalContainer.tsx:3377-3379`, `:3398-3402`)가 통째로 바뀐다.

**§11 의 두 행(`ws-protocol.ts:780-801`, `TerminalContainer.tsx:3192-3443`)이 난이도 L 인 이유가 이것이다** — 필드 매핑이 아니라 상태 도입이다.


### 3.6 파싱 실패·잘린 프레임 처리

**잘린 프레임은 전송 계층에서 발생하지 않는다.** WebSocket 메시지는 완결 단위로 전달되므로 TCP 세그먼트화로 반쪽 프레임이 오는 일은 없다. 따라서 **재조립 버퍼를 만들면 안 된다** — 존재하지 않는 문제에 대한 코드다.

**배치는 확정됐다.** `01` §1.7 이 **1 WS 메시지 = N 논리 프레임**을 v1 부터 허용하기로 결정했고, 마지막 프레임에 `END_OF_BATCH` 플래그를 세운다. 배치 상한은 `bulkSliceBytes`(fair scheduler 의 DRR quantum, `server/src/ws/wsSendPolicy.ts:521`)다.

따라서 디코더는 **처음부터 배치 루프여야 한다.** 1:1 을 가정한 `byteLength !== 28 + payloadLength` 검사는 **전 트래픽을 폐기**한다.

| 이상 | 검사 (배치 허용) | 처분 |
|---|---|---|
| 미지의 `frameVersion` | 화이트리스트 밖 | fail-closed (**opcode 해석 전에 검사**) |
| 헤더 미만 잔여 | 잔여 `< 28` | fail-closed |
| 길이 필드 초과 | `offset + 28 + payloadLength > byteLength` | fail-closed (`01` 부록 B 의 `length-overrun`) |
| 미지의 opcode | 화이트리스트 밖 | fail-closed |
| `END_OF_BATCH` 없이 잔여 소진 | 배치 미완결 | fail-closed |
| 잔여 바이트 없음 + `END_OF_BATCH` | 정상 종료 | — |

즉 `offset = 0` 에서 시작해 `offset += 28 + payloadLength` 로 **루프**를 돌고, 루프가 정확히 `byteLength` 에서 끝나면서 마지막 프레임에 `END_OF_BATCH` 가 서 있어야 정상이다. **배치 안의 프레임은 순서대로 처리하며 중간에 하나라도 거부되면 배치 전체를 fail-closed 로 보낸다** — 일부만 적용하면 터미널 상태가 찢어진다.

**[설계결정] 기존 JSON 경로의 실패 처리를 복사하면 안 된다.** `frontend/src/contexts/WebSocketContext.tsx:688-690` 은 파싱 실패 시 디버그 이벤트조차 남기지 않고 `return` 한다(`:963-965` 도 동일). 이는 이 파일의 다른 실패 경로가 전부 `recordTerminalDebugEvent` 를 남기는 것과 대비되는 예외다. 그런데 `00-decision-record.md:79` 는 **"해석 불가 프레임의 silent drop 금지. JSON snapshot downgrade 또는 명시적 reconnect 로 수렴"** 을 유지 조항으로 못박았다. 따라서 바이너리 분기는 반드시 (a) 디버그 이벤트 기록, (b) 명시적 재연결 또는 JSON 스냅샷 downgrade 로 수렴해야 한다.

---

## 4. 기존 `Uint8Array` staged path 재사용 범위 (과제 2)

### 4.1 어디까지 재사용되는가

`TerminalOutputWriteData = string | Uint8Array` (`frontend/src/utils/terminalOutputScheduler.ts:18`) 는 이 파일에서 **단 한 곳**, `TerminalOutputSchedulerOptions.write` 콜백(`:253`)에만 쓰인다. 즉 **출력 방향 전용**이다.

이것은 우연이 아니라 설계다. `PERF-BGSTAB-009` AC-7 (`docs/spec/30.buildergate-stability.srs.md:2939`) 이 명시적으로 울타리를 쳤다.

> AC-7: Production ingress는 string을 유지하고 scheduler-to-xterm 구간만 `string|Uint8Array` compatible staged path로 확장한다. 이 Requirement는 binary WebSocket … 을 변경하지 않는다.

**즉 "staged path" 는 정확히 §2 표의 17→22 구간이며, 그 구간은 이미 완성되어 있다.** 이번 작업이 걷어낼 울타리는 문장의 앞부분("Production ingress는 string을 유지") 하나뿐이다.

### 4.2 바이트를 직접 넣을 수 있는 진입점 — 스케줄러에는 **없다**

스케줄러의 데이터 진입점은 전부 `string` 고정이다.

| 진입점 | 위치 | 파라미터 |
|---|---|---|
| `enqueue` | 인터페이스 `:269-273` / 구현 `:1362` | `data: string` |
| `enqueueLegacy` | 인터페이스 `:274-278` / 구현 `:1456` | `data: string` |
| retry 큐 `defer` | `:803` (필드 `:146-150`, `:652`) | `entry.data: string` |
| `flushNextTerminalRestoreBufferedOutput` | `:419` | `string` 아니면 `:459-462` 에서 **명시적 거부** |

**그리고 `Uint8Array` 를 감지해 encode 를 건너뛰는 분기가 파일 전체에 없다.** `staged`/`stage`/`binary` 식별자도 0건, `TextDecoder`/`.decode(` 도 0건이다.

이것이 **조용한 손상 위험**을 만든다. `enqueue` 의 유일한 가드는 `data.length === 0` (`:1363`) 인데 `Uint8Array` 에도 `.length` 가 있어 통과하고, `TextEncoder.encode(Uint8Array)` 는 던지지 않고 **암묵적 `String()` 변환**을 거쳐 `"27,91,49"` 같은 문자열을 인코딩한다. 타입만 넓히고 가드를 안 넣으면 터미널이 깨진 채로 조용히 돌아간다.

### 4.3 [설계결정] `enqueue` 를 넓히지 말고 `enqueueBytes` 를 추가한다

```
enqueueBytes(data: Uint8Array, onWritten?, onRejected?): TerminalOutputSchedulerDecision
```

근거:

1. **틀린 사용법이 즉시 실패해야 한다.** 진입점을 분리하고 각 진입점에 런타임 타입 가드를 두면 §4.2 의 조용한 손상이 구조적으로 불가능해진다. union 으로 넓히면 가드를 빠뜨린 미래의 수정이 다시 손상을 부른다.
2. **계약이 측정 가능하게 유지된다.** `PERF-BGSTAB-009` AC-1 은 "accepted non-empty **string** ingress 당 encode ≤ 1" 을 계약으로 갖고 계측기가 이를 센다. 진입점이 분리되면 "bytes ingress 는 encode 0" 이 별도 계약으로 깔끔히 검증된다.
3. **구현이 작다.** 큐 원소 `PendingOutputSegment.bytes` 는 이미 `Uint8Array` (`:307`) 다. `enqueueBytes` 는 `:1367` 의 encode 를 건너뛰고 `:1407-1415` 의 `queue.push({bytes, ...})` 로 바로 간다. 그 뒤 `:1238` → `:1269` → `:1308` 경로는 **완전히 동일하게** 재사용된다.

함께 넓혀야 하는 것: retry 큐(`:146-150`, `:652`, `:803`)의 `data`, 그리고 `TerminalOutputIngressRetryQueueOptions.attempt`/`attemptLegacy`(`:163-164`)와 그 바인딩 `frontend/src/components/Terminal/TerminalView.tsx:1599-1608`. `writeOutput`(`:1639-1645`)의 `data: string` 도 함께 간다.

### 4.4 encode 호출 횟수 — 현재와 전환 후

출력 메시지 1건 기준. "현재" 열은 **코드 경로를 센 정적 계수**(추정 아님)이고, "전환 후" 열은 **미구현 설계의 예상치 [추정]** 다.

| 경로 | 위치 | 현재 | 전환 후 | 조건 |
|---|---|---|---|---|
| 스케줄러 ingress | `terminalOutputScheduler.ts:1367` / `:1460` | **1회 (전체 payload)** | **0회** | 항상 |
| JSON 파싱 | `WebSocketContext.tsx:687` | **1회** | **0회** | 항상 |
| sourceSegments 분할 | `visibleOutputRecovery.ts:415` | 1회 (+ 인코더 인스턴스 1개 신규 할당) | 0회 | `sourceSegments` 존재 시 |
| sourceSegments 디코드 | `visibleOutputRecovery.ts:443` | 세그먼트 수만큼 `decode` | 0회 | 위와 동일 |
| grace 버퍼 회계 | `WebSocketContext.tsx:469` | 1회 | `.byteLength` (O(1)) | grace 중 |
| retry defer 회계 | `TerminalView.tsx:1670`, `terminalOutputScheduler.ts:810` | 1회 | `.byteLength` (O(1)) | retry/거절 시 |
| held/디버그 회계 | `TerminalView.tsx:1753`, `:2902`, `:3901`, `:3923`, `:3933` | 각 1회 | `.byteLength` (O(1)) | 해당 경로 진입 시 |
| 복구 회계 | `visibleOutputRecovery.ts:1373`, `:1426`, `:1487`, `:1658` | 각 1회 | `.byteLength` (O(1)) | 복구 중 |

**항상 없어지는 것: `JSON.parse` 1회 + 전체 payload 에 대한 `TextEncoder.encode` 1회.** 회계용 encode 들은 "전체 payload 를 인코딩해서 `.length` 만 읽고 버리는" 패턴(`frontend/src/utils/terminalOutputHotPath.ts:11-13`)이므로, 바이트를 들고 있으면 전부 O(1) 상수 시간이 된다. 이쪽이 호출 **횟수**로는 더 크다.

---

## 5. xterm write 경로 (과제 3)

### 5.1 `Uint8Array` 를 직접 받는다 — 확인됨

`frontend/node_modules/@xterm/xterm/typings/xterm.d.ts:1253` (패키지 버전 **6.0.0**):

```ts
write(data: string | Uint8Array, callback?: () => void): void;
```

오버로드가 아니라 **단일 시그니처의 union** 이다. 같은 파일 `:1246-1248` 의 문서 주석이 의미를 못박는다.

> @param data The data to write to the terminal. This can either be raw bytes given as Uint8Array from the pty or a string. **Raw bytes will always be treated as UTF-8 encoded, string data as UTF-16.**

`writeln` 도 동일(`:1268`)하나 `frontend/src` 에서 호출되지 않는다.

### 5.2 UTF-8 디코딩을 건너뛸 수 있는가 — **출력 평면에서는 그렇다**

xterm 실 호출 지점은 `frontend/src/utils/terminalRawMutationAdapter.ts` 단 한 파일 3곳이다.

| 위치 | 넘기는 타입 | 비고 |
|---|---|---|
| `:82` | `string \| Uint8Array` (`command.data`) | 일반 경로 |
| `:87` | **`Uint8Array`** (`prependBytes` 결과 `:62-68`) | checkpoint + 모드 프리픽스 |
| `:89` | 빈 `string` | `probeWritePipeline`, 파이프 생존 확인 |

**바이너리 전환 후 _출력 평면에는_ UTF-8 디코딩 단계가 남지 않는다.** 소켓에서 나온 바이트가 뷰인 채로 스케줄러 큐에 들어가고, `subarray` 로 잘려, 그대로 `terminal.write()` 에 들어간다. 문자열이 한 번도 만들어지지 않는다.

xterm 내부에서는 `Utf8ToUtf32` 가 바이트를 UTF-32 코드포인트로 바꾸지만, 이는 **현재도 `StringToUtf32` 로 똑같이 일어나는 일**이다 (§6.3 번들 인용). 즉 바이너리는 디코딩을 **추가하지 않고**, JSON 문자열 물질화만 제거한다.

### 5.3 건너뛸 수 없는 지점

| 지점 | 왜 문자열이 필요한가 |
|---|---|
| control 평면 전체 | 설계상 JSON 유지 (`00-decision-record.md:17`) |
| `terminalRawMutationAdapter.ts:46-60` `encodeTerminalModeRehydrate` | 모드 복원 escape 를 문자열로 조립 후 인코딩. **checkpoint 경로 한정, 출력 hot path 아님** |
| 서버 origin | node-pty 가 **이미 string 으로 준다** (`server/src/services/SessionManager.ts:1353` `ptyProcess.onData((rawData: string) => {`). §9.4 참조 |

---

## 6. UTF-8 경계 절단 (과제 4)

### 6.1 `findUtf8SliceEnd` 가 하는 일

정의 `frontend/src/utils/terminalOutputScheduler.ts:2016-2047`, 호출은 `:1238` **단 한 곳**. 보조 헬퍼는 `isUtf8ContinuationByte`(`:2050`), `getUtf8SequenceWidth`(`:2055`), `normalizeFlushBudgetBytes`(`:2064`).

동작은 네 단계다.
1. `start + visibleFlushBudgetBytes` 를 목표로 잡되 버퍼 끝을 넘지 않는다.
2. 목표가 버퍼 끝이거나 continuation byte(`0b10xxxxxx`)가 아니면 그대로 쓴다.
3. continuation byte 면 **최대 3바이트** 역탐색한다 (UTF-8 최대 4바이트이므로 3회면 충분).
4. 역탐색이 `start` 까지 밀리면(= 예산이 코드포인트 하나보다 작음) **교착 방지**로 `getUtf8SequenceWidth(bytes[start])` 만큼 전진해 최소 1코드포인트를 반드시 소비한다.

### 6.2 서버가 경계를 맞춰 보내면 불필요해지는가 — **아니다. 여전히 필요하다**

**이 함수는 wire 프레이밍 때문에 존재하는 것이 아니라 flush 예산 때문에 존재한다.**

스케줄러는 한 프레임에서 `visibleFlushBudgetBytes` 만큼만 xterm 에 넘긴다(프레임 예산 기본 7ms, `PERF-BGSTAB-009` AC-5). 이 예산은 런타임 기본값이 **262,144 바이트**(`frontend/src/utils/inputReliabilityMode.ts:72`)이고 설정 범위는 **`[1024, 16_777_216]`**(`:281`)이며, 벤치 하네스는 64 KiB 로 돌린다(`frontend/tests/benchmarks/terminalNoRenderFixture.ts:554`).

즉 **예산은 payload 크기와 무관하게 정해지는 별개의 값**이다. 출력 폭주(`cat huge.log`)에서 큐에 쌓인 바이트는 쉽게 예산을 넘고, 예산을 1024 로 낮추면 거의 모든 청크가 잘린다. 서버가 프레임 경계를 아무리 완벽히 코드포인트에 맞춰 보내도 **스케줄러가 그 안에서 예산 단위로 다시 자르며**, 그 절단면은 코드포인트 중간일 수 있다. 따라서 §2 표의 15번 단계는 그대로 남는다.

바꿔 말하면 `findUtf8SliceEnd` 의 입력은 "wire 에서 온 것"이 아니라 "큐에 쌓인 바이트"다. wire 표현이 무엇이든 무관하다.

### 6.3 string/bytes 혼합 write — **신규 위험이 아니라 기존 조건의 일반화**

이것이 이번 전환에서 가장 놓치기 쉬운 정합성 문제다.

**먼저 바로잡을 것**: 이 조건은 바이너리 전환이 *만들어내는* 것이 아니다. §8.3 이 보이듯 checkpoint 평면은 **오늘 이미** `Uint8Array` 를 `terminalRawMutationAdapter.ts:82`/`:87` 을 통해 xterm 에 쓰고 있고(`terminalCheckpointRuntime.ts:1249`), 같은 터미널의 라이브 출력은 스케줄러를 거쳐 역시 바이트로 간다. 즉 **혼합 가능 조건은 이미 성립해 있다.** 바이너리 전환이 바꾸는 것은 빈도다 — 지금은 checkpoint 활성 뷰라는 좁은 창에서만 성립하지만, 전환 후에는 **상시**가 된다.

이 구분이 실무적으로 중요한 이유 두 가지.
- **지금 이미 버그가 있는지 조사할 의무가 생긴다.** "새로 생기는 위험"이면 예방만 하면 되지만, 기존 조건이면 현행 코드에 잠재 결함이 있는지 먼저 확인해야 한다. **[미확인]**
- **RED 테스트의 성격이 달라진다.** 신규 계약이 아니라 **회귀 테스트**로 세워야 한다.

xterm 번들(`frontend/node_modules/@xterm/xterm/lib/xterm.js`)에서 확인한 사실:

```
this._parseBuffer=new Uint32Array(4096),
this._stringDecoder=new h.StringToUtf32,
this._utf8Decoder=new h.Utf8ToUtf32,
```

```
t.Utf8ToUtf32=class{constructor(){this.interim=new Uint8Array(3)} clear(){...} decode(e,t){const i=e.length;if(!i)return 0; ... if(this.interim[0]){...}}}
t.StringToUtf32=class{constructor(){this._interim=0} clear(){...} decode(e,t){const i=e.length;if(!i)return 0; ... if(this._interim){...}}}
```

읽히는 것 세 가지.

1. **UTF-8 디코더는 상태를 이어간다.** `interim` 에 미완성 시퀀스 최대 3바이트를 보류한다. 그러므로 **바이너리 프레임 경계가 코드포인트 중간에 떨어져도 xterm 이 알아서 처리한다.** 서버에 "프레임을 코드포인트 경계에 맞춰라"를 요구할 필요가 없다 — 요구하면 서버 쪽에 불필요한 제약을 심는 것이다.
2. **두 디코더는 별개 인스턴스이고 상태를 공유하지 않는다.** `_utf8Decoder.interim` 에 2바이트가 걸려 있는 상태에서 `write(string)` 이 들어오면, 그 문자열은 `_stringDecoder` 로 처리되어 **보류 중인 바이트보다 먼저** 파서에 들어간다. 바이트가 유실되지는 않지만 **순서가 뒤집힌다.**
3. **빈 문자열 write 는 안전하다.** 두 디코더 모두 `if(!i) return 0` 로 즉시 반환하며 상태를 건드리지 않는다. 따라서 `terminalRawMutationAdapter.ts:89` 의 `terminal.write('', onWritten)` 과 `frontend/src/utils/terminalReplayGuard.ts:86` 의 `options.write('', ...)` 는 **문제 없다**.

**[설계결정] 한 xterm 인스턴스에 대해 비어있지 않은 string write 와 Uint8Array write 를 섞지 않는다.** 바이너리 epoch 가 활성인 동안 그 터미널로 가는 모든 비어있지 않은 write 는 `Uint8Array` 여야 한다. 점검이 필요한 경로는 `frontend/src/utils/terminalReplayGuard.ts:100` (`options.write(options.data, ...)`), 그리고 `terminalWriteCoordinator.ts:1974` 가 `string` 도 통과시키는 mutation 경로다.

**[미확인]** 실제로 순서가 뒤집히는지는 저장소에 재현 테스트가 없다. 검증 방법: 멀티바이트 문자를 2바이트/2바이트로 쪼갠 `Uint8Array` 두 개 사이에 비어있지 않은 ASCII string write 를 끼워 넣고 `terminal.buffer` 최종 상태를 비교한다. 이것은 §10.3 의 필수 RED 테스트다.

---

## 7. 백프레셔 회계 (과제 5)

과제는 "바이너리에서 **무엇을 세야 하는가**"다. 답은 두 갈래로 갈린다 — **송신측 백프레셔(§7.1, 변경 없음)** 와 **수신측 큐 회계(§7.2, 실질 영향 있음)**. 후자가 이번 전환에서 실제로 중요한 쪽이다.

### 7.1 송신측 — **이번 범위에서는 손대지 않는다**

`frontend/src/utils/webSocketBackpressure.ts` 는 **클라이언트 → 서버** 송신 경로다. `evaluateBrowserInputBackpressure` 는 `:80-82` 에서

```ts
if (input.messageType !== 'input') { return { action: 'send' }; }
```

로 **`input` 타입 외에는 전부 즉시 통과**시킨다. terminal output 은 서버 → 클라이언트이므로 이 파일을 지나지 않는다. `WebSocketContext.tsx` 는 이 함수를 직접 부르지 않고 래퍼 `sendOpenBrowserWebSocketMessage` 를 6곳(`:248`, `:644`, `:941`, `:989`, `:1369`, `:1487`)에서 쓰는데, 전부 negotiate / visibility / failure-ack / capability / 사용자 입력 송신이다.

**따라서 output 평면 바이너리 전환만으로는 이 파일에 변경이 필요 없다.** 상위 결정이 범위를 "control 평면 JSON 유지, output/snapshot 만 바이너리"로 못박았으므로(`docs/research/binary-comms/00-decision-record.md:17`), 이 파일까지 건드리는 것은 범위 이탈이다.

### 7.2 수신측 큐 회계 — **여기가 실제 영향 지점이다**

수신측에는 **바이트 예산과 청크 수 예산이 병렬로** 걸려 있다. `frontend/src/contexts/WebSocketContext.tsx:468-476`:

```ts
const messageBytes = getOutputUtf8ByteLength(msg.data);
const byteOverflow  = current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes;
const chunkOverflow = current.output.length + 1 > limits.visibleOutputMaxChunks;
```

기본값(`frontend/src/utils/inputReliabilityMode.ts:70-71`)은 **바이트 4,194,304 / 청크 512** 다. 스케줄러에도 같은 쌍이 있다(`terminalOutputScheduler.ts:249-250`, 정규화 `:1155`).

**핵심 위험: 두 예산의 비율이 프레이밍 입도에 의존한다.** 청크 512개로 4 MiB 를 채우려면 **청크당 평균 8,192 바이트**가 필요하다. 즉 평균 프레임이 8 KiB 보다 작아지는 순간 **바이트 예산이 아니라 청크 예산이 먼저 터진다.**

| 시나리오 | 결과 |
|---|---|
| 지금 (JSON, 서버가 coalescing) | 서버가 output 을 병합해 보내므로 청크가 굵다 (`server/src/ws/wsSendPolicy.ts:111` 의 `outputData` 보관이 coalescing 용) |
| 바이너리 + 프레임을 잘게 | 청크 수 급증 → **`chunk-cap-exceeded` 로 조기 overflow**. 바이트 여유가 남아 있어도 출력이 버려진다 |
| 바이너리 + 배치(§3.6) | 한 WS 메시지가 프레임 N개 → **N 을 청크 N 으로 셀지 1로 셀지가 회계 결정 사항** |

**[설계결정] 청크 회계 단위를 프레임이 아니라 "스케줄러 큐 원소"로 유지한다.** 배치로 도착한 프레임 N개를 큐에 N개로 넣으면 청크 예산이 실질적으로 N배 빨리 소진된다. 프레이밍 입도가 회계 의미를 바꾸지 않도록, **wire 프레임 수와 큐 청크 수를 분리**해야 한다.

**[미확인] 28바이트 헤더를 바이트 예산에 셀 것인가.** 서버측 큐 예산은 JSON 봉투를 포함한 바이트(`server/src/ws/wsSendPolicy.ts:95`)이고, 클라이언트 예산은 payload 바이트다. 바이너리에서 헤더를 포함시키면 서버와 정합되고, 제외하면 현행 클라이언트 의미와 정합된다. **둘 다 취할 수는 없다** — §7.4 의 domain 불일치와 함께 결정해야 한다.

세는 값 자체의 변화는 단순하다.

| 위치 | 현재 | 바이너리에서 |
|---|---|---|
| `WebSocketContext.tsx:469` | `getOutputUtf8ByteLength(msg.data)` — O(n) encode | `payload.byteLength` — O(1) |
| `terminalOutputScheduler.ts:810` | `textEncoder.encode(entry.data).byteLength` | `.byteLength` |
| 스케줄러 `queuedBytes`/`droppedBytes`/`rejectedBytes` | UTF-8 인코딩 후 바이트 | **동일한 의미 유지** (이미 바이트 domain) |

마지막 행이 중요하다 — 스케줄러의 바이트 회계는 **이미 UTF-8 바이트 기준**이므로 (`PERF-BGSTAB-009` AC-6) 바이너리 전환이 그 의미를 바꾸지 않는다. 바뀌는 것은 **그 값을 구하는 비용**뿐이다.

### 7.3 그럼에도 기록해 둘 것 — 입력 평면까지 갈 경우

나중에 입력까지 바이너리로 가면 세 가지가 바뀐다.

| 위치 | 현재 | 바이너리에서 |
|---|---|---|
| `webSocketBackpressure.ts:121` | `JSON.stringify(input.message)` | 프레임 조립 결과(`ArrayBuffer`) |
| `webSocketBackpressure.ts:85` → `:54-56` | `getUtf8ByteLength(serializedPayload)` = 인코딩 후 `.length` | **`frame.byteLength`** (O(1), 할당 0) |
| `webSocketBackpressure.ts:31-33` | `send(payload: string): void` | `string \| ArrayBufferView` 로 확장 |

**세어야 할 것은 그대로 "소켓에 들어가는 실제 바이트 수"다.** 판정 기준인 `bufferedAmount` 는 프레임 종류와 무관하게 **이미 바이트 단위**이므로 (`:84`, `:156-158`), 비교 대상만 바이트로 맞추면 회계 자체는 일관된다. 현재는 그 바이트 수를 알아내려고 문자열을 인코딩하는 것이고, 바이너리에서는 공짜로 알 수 있다.

### 7.4 [미확인] 별개의 domain 불일치

`00-decision-record.md:78` 은 "ACK credit 은 encoded byte 단일 domain" 을 유지 조항으로 둔다. 그런데 현재 서버 큐 예산은 `Buffer.byteLength(JSON payload,'utf8')` (`server/src/ws/wsSendPolicy.ts:95`) 로 **JSON 봉투를 포함한 바이트**이고, `TerminalCheckpointEncodedPayload.encodedBytes` (`frontend/src/types/ws-protocol.ts:80`) 는 **디코딩 후 원본 바이트**다. 두 domain 이 **이미 어긋나 있다.** 클라이언트 쪽 영향 범위는 이 조사에서 확정하지 못했다 — 서버 프레임 설계 문서에서 다뤄야 한다.

---

## 8. snapshot / checkpoint 평면 (과제 6)

### 8.0 먼저 구분할 것 — snapshot 평면은 checkpoint 평면과 다르다

전제가 말하는 "output/**snapshot** 평면"에는 **서로 다른 두 평면**이 들어 있다. 이것을 뭉뚱그리면 작업이 하나 통째로 누락된다.

| 평면 | 메시지 | payload | 클라이언트 처리 |
|---|---|---|---|
| **checkpoint** | `terminal-checkpoint:start` / `:chunk` / `:commit` / `:output` | **base64** (`TerminalCheckpointEncodedPayload`, `frontend/src/types/ws-protocol.ts:77-81`) | `atob` 디코딩 (§8.1) |
| **screen-snapshot** | `screen-snapshot` | **plain string** (`ScreenSnapshotMessage.data: string`, `frontend/src/types/ws-protocol.ts:680`) | 문자열 그대로 |

`screen-snapshot` 경로는 base64 를 전혀 쓰지 않는다. 체인은 `frontend/src/components/Terminal/TerminalContainer.tsx:3156-3158` (`onScreenSnapshot` → `void handleScreenSnapshot(snapshot)`) → 정의 **`:2385`** → 회계 **`:2394`** `getUtf8ByteLength(snapshot.data)` 다. (`:2395` 는 적용이 아니라 `:2390` 에서 시작한 `recordTerminalDebugEvent` 의 preview 인자이고, `:2357` 은 이 체인이 아니라 provisional visible-resync 적용 뒤 `lastAppliedSnapshotRef` 를 보관하는 **별개 경로**다.)

**여기서 하나 바로잡을 것** — 스케줄러의 restore 진입점(`frontend/src/utils/terminalOutputScheduler.ts:459-462`)은 **snapshot 평면이 아니라 output 평면에 속한다.**

```ts
if (typeof data !== 'string' || (typeof pending !== 'string' && !options.getData)) {
  settle(false);
  return false;
}
```

이 게이트가 지키는 큐는 `bufferedOutputRef` 이고, 그 큐를 채우는 것은 `frontend/src/components/Terminal/TerminalView.tsx:1745` 의 `bufferOutputWhileRestorePending(data, metadata)` — 호출 지점은 `:2909` 로 **restore 대기 중 보류된 live PTY 출력**이다. flush 는 `:2096`. `ScreenSnapshotMessage.data` 는 이 큐에 **들어가지 않는다.**

따라서 **`:459-462` 는 snapshot 포함 여부와 무관하게 output 평면 전환이 반드시 건드려야 하는 게이트다.** §4.2 표에서 이 거부를 "string 전용 진입점"의 근거로 인용한 것은 정확하지만, 그것을 snapshot 범위로 미루면 **필수 작업을 범위 밖으로 잘못 밀어내게 된다.** §11.1 에 필수 항목으로 올린다.

**[설계결정] snapshot 평면은 output 평면과 분리해 단계적으로 간다.** 이유:
- snapshot 은 **빈도가 낮고 크기가 크다** — output 과 성능 프로파일이 반대다. hot path 가 아니므로 이득이 작다.
- snapshot 적용 경로는 held/버퍼 재생과 얽혀 있어 위험 대비 이득이 나쁘다. (restore 게이트 `:419`, `:459-462` 는 위에서 보았듯 **output 평면 몫이므로 이 사유에 포함되지 않는다**.)
- output 평면만으로 §9.3 의 절감이 대부분 달성된다.

**[미확인]** snapshot 을 이번 전환에 포함할지는 상위 결정 사항이다. `00-decision-record.md:17` 은 "output / snapshot 평면"을 함께 적었으나 두 평면의 구분은 다루지 않았다.

### 8.1 checkpoint base64 는 어디서 도는가

클라이언트 base64 디코딩은 **`frontend/src/utils/terminalCheckpointRuntime.ts` 한 파일**에 있다. `WebSocketContext.tsx` 에는 `atob`/`base64` 가 **0건**이며, `:922` 의 `dispatchersRef.route(checkpoint)` 로 파싱된 객체를 넘길 뿐이다.

| 위치 | 대상 |
|---|---|
| `frontend/src/utils/terminalCheckpointRuntime.ts:408-418` | `decodeBase64(data, encodedBytes)` — `atob` + `charCodeAt` **바이트 단위 루프** + 길이 검증 |
| `:1179` | `terminal-checkpoint:start` 의 `parserTail` |
| `:1221` | `terminal-checkpoint:chunk` 의 `data` |
| `:1249` | **`terminal-checkpoint:output` 의 `data`** — checkpoint 권한 하의 **live PTY 출력** |

서버 대응 지점은 `server/src/services/TerminalAuthorityProductionAdapter.ts:869-881`(`encodeCheckpointPayload`), `:883-902`(`encodeCheckpointChunks`), live output 조립은 `:1563-1570`.

### 8.2 raw binary 수신 시 제거 가능한 지점

**세 호출(`:1179`, `:1221`, `:1249`)이 전부 제거 가능하며, `decodeBase64`(`:408-418`) 자체가 사라진다.**

제거 효과가 특히 큰 이유는 구현 방식이다. `:413-416` 이 디코딩된 binary string 을 **문자 하나씩 루프로** `Uint8Array` 에 옮긴다.

```
const bytes = new Uint8Array(decoded.length);
for (let index = 0; index < decoded.length; index += 1) {
  bytes[index] = decoded.charCodeAt(index);
}
```

즉 checkpoint payload 1바이트마다 `charCodeAt` 호출 1회다. 여기에 `atob` 자체의 비용과 중간 binary string 할당이 더해진다. 바이너리 wire 에서는 이 전부가 `new Uint8Array(buffer, offset, length)` 뷰 하나로 대체된다. 부수적으로 base64 의 **1.333× 전송량 팽창**(§9.1)도 사라진다.

### 8.3 매우 중요한 부산물 — 바이트 주입 진입점의 선례

`:1249` 의 live 경로는 이렇게 끝난다.

```
dispatchUnknown(currentCoordinator, { type: 'live', ..., data: decodeBase64(...) })
```

**즉 checkpoint 평면은 이미 `Uint8Array` 를 스케줄러를 우회해 write coordinator 에 직접 주입하고 있다.** §4.3 이 제안하는 `enqueueBytes` 가 새로운 발상이 아니라 **기존 패턴의 확장**임을 보여주는 선례다.

다만 그대로 베끼면 안 된다. checkpoint 경로는 스케줄러를 건너뛰므로 **bounded queue / flush 예산 / overflow 처분 / canary admission 을 받지 않는다.** 상시 output 평면은 이 보호가 필요하다 (`PERF-BGSTAB-009` AC-4/AC-6). 그래서 §4.3 이 coordinator 직접 주입이 아니라 **스케줄러 입구 추가**를 선택한 것이다.

### 8.4 협상 · downgrade · 롤백 — 클라이언트 측 설계 [설계결정]

`00-decision-record.md:79-80` 은 "해석 불가 프레임 silent drop 금지 / JSON snapshot downgrade 또는 명시적 reconnect 로 수렴 / **binary 큐를 JSON 으로 재해석하지 않는다**"를 유지 조항으로 둔다. 그런데 클라이언트가 **바이너리 수용을 어떻게 알리고 어떻게 되돌리는지**는 프레임 포맷과 별개의 문제이며, 초안 어디에도 없다.

**저장소에 그대로 쓸 수 있는 선례가 있다.** checkpoint 평면이 이미 동일한 문제를 푼다.

| 단계 | checkpoint 의 방식 | 위치 |
|---|---|---|
| 클라이언트가 능력 선언 | `terminal-checkpoint:negotiate` 를 `ws.onopen` 에서 전송 | `frontend/src/contexts/WebSocketContext.tsx:248-257`, 호출 `:1220` |
| 서버가 수용/거절 회신 | `terminal-checkpoint:capability` (`accepted: true`) / `:rejected` | 처리 `:839`, `:891` |
| 실패 시 수렴 | `terminal-checkpoint:failure-ack` → recovery-request | `:941-958` |

**바이너리 평면도 같은 3단계를 갖춰야 한다.** 즉 (a) `onopen` 에서 바이너리 수용 선언, (b) 서버 수용 회신 전까지는 **JSON 으로만 수신**, (c) 프레임 해석 실패 시 epoch 종료 → 재협상 → JSON fresh snapshot.

**(b) 가 특히 중요하다.** 협상이 끝나기 전에 서버가 바이너리를 보내면 클라이언트는 `binaryType` 조차 아직 안전하지 않을 수 있다. 반대로 클라이언트가 선언했는데 서버가 구버전이면 계속 JSON 이 오므로, **§3.2 의 string 분기가 영구적으로 살아 있어야 한다** — 바이너리 전환 후에도 JSON 경로를 제거하면 안 된다.

**[미확인]** 협상 메시지를 checkpoint negotiate 에 필드로 얹을지 별도 메시지로 둘지는 서버 설계와 합의 사항이다.

---

## 9. 성능 추정 (과제 7)

### 9.1 실측이 있는 것

**저장소에 WebSocket JSON codec 의 실측 성능 수치는 없다.** 확인 결과 존재하는 것은 (a) 정성적 병목 가설, (b) "아직 재지 않았다"는 명시, (c) 예시용 가상 숫자뿐이다.

- `docs/issues/wave4-wave5/19-binary-data-plane.md:99` 의 "`JSON.stringify가 전체의 3%`" 는 **프로파일링이라는 행위를 설명하는 예시**이지 실측치가 아니다. 인용 금지.
- 같은 문서 `:134-138` 은 측정 **절차**만 규정하며 측정 전 상태다.
- `docs/research/2026-07-02.buildergate-native-performance-54-sessions-deep-analysis.md:116` (F15) 은 "ESC 가 6바이트로 팽창" 을 정성적으로만 서술한다.

**wire 크기는 산술로 확정할 수 있어 이 조사에서 직접 계산했다** (벤치마크가 아니라 결정론적 계산이므로 실측/추정 구분 밖이다).

| 항목 | 값 | 근거 |
|---|---|---|
| ESC(0x1B) 1바이트 | JSON 에서 `\u001b` **6바이트** | JSON 은 U+0020 미만 제어문자 이스케이프 필수 |
| CR / LF 각 1바이트 | `\r` / `\n` = **2바이트** | 동일 |
| 색상 프롬프트 1줄 (42바이트 원본) | JSON 프레임 **142바이트 = 3.38×** | 아래 분해 참조 |
| checkpoint payload | base64 **1.333×** | base64 정의 |

142바이트의 분해 — 세 항목이 각각 독립적으로 기여한다.

| 구성요소 | 바이트 | 설명 |
|---|---|---|
| 봉투 리터럴 `{"type":"output","sessionId":"","data":""}` | 42 | 최소 필드만. `screenSeq`/`chunkId`/`deliverySeq`/`sourceSegments` 가 붙으면 더 커진다 |
| `sessionId` 값 | 36 | `uuidv4()` (`server/src/services/SessionManager.ts:1173`) |
| 이스케이프된 `data` | 64 | 원본 42 + ESC 4개×(+5) + CR/LF 2개×(+1) |
| **합계** | **142** | 원본 42바이트 대비 **3.38×** |

**봉투 오버헤드(78바이트)는 payload 크기와 무관한 고정비**이므로 작은 청크일수록 비율이 커지고, 큰 청크에서는 이스케이프 팽창(이 예에서 42→64, 약 1.52×)이 지배한다.

터미널 출력은 ANSI 이스케이프가 조밀하므로 이 팽창은 예외가 아니라 상시다. **[추정]** 실 워크로드의 평균 팽창률은 이스케이프 밀도와 청크 크기 분포에 의존하며 저장소에 분포 데이터가 없다.

### 9.2 스케줄러 벤치가 말해주는 것과 말해주지 않는 것

`docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave2-hotpath/scheduler-benchmark.json` 은 실측 아티팩트다.

> ⚠️ **먼저 §10.1 을 읽을 것.** 이 아티팩트의 candidate 구현은 **HEAD 에도 워킹트리에도 존재하지 않는다.** 아래 수치는 "아티팩트에 기록된 값"으로만 유효하며 **현재 코드의 성능이 아니다.**

| 지표 | 값 |
|---|---|
| baseline p95 | **264.601 ms** |
| candidate p95 | **2.610 ms** |
| 워크로드 | 13 ops/trial, op 당 2 ingress = 110 B + 65,542 B = **65,652 B** |
| baseline encoder 할당 | **65,640회** (prefix loop 65,638 포함) |
| candidate encoder 할당 | **2회** (ingress 당 1회) |
| manifest | seed 7008, warmup 1, trial 3, bootstrap 512, CI 95% |

**말해주는 것**: wave-2 는 **인코더 결과 할당**을 65,640 → 2 로 줄였고(그중 prefix loop 분이 65,638), 그와 함께 p95 가 264.6 ms → 2.61 ms 가 됐다. 남은 2회가 **바로 이번 전환이 없앨 대상**이다.

> 지표명 주의: 아티팩트 필드는 `encoderResultAllocationCount`(**할당** 수)이고 호출 수는 별개 필드(`prefixLoopEncodeCount`, `candidateAcceptedIngressMaxEncodeCount`)다. 이 구현에서는 호출 1회당 결과 1개라 수가 같지만, **두 지표를 같은 말로 섞어 쓰지 않는다.**

**통계적으로 조심할 것**: `trialCount` 는 **3** 이다. 표본 3개의 p95 는 사실상 **최댓값**이며 백분위수로서의 의미가 약하다. 이 수치는 "동일 manifest 에서 재현되는 비교값"으로는 쓸 수 있으나 **절대 성능 특성으로 일반화할 수 없다.**

**말해주지 않는 것 (중요)**: 이 벤치는 `TextEncoder.encode` 의 비용을 **따로 분리하지 않는다.** candidate 의 2.61 ms 안에는 encode 2회 외에 큐 관리, `findUtf8SliceEnd`, `subarray`, write 콜백 루프가 전부 섞여 있다. 그리고 **`JSON.parse` 는 이 벤치의 측정 범위에 아예 없다** — 하네스는 문자열 ingress 에서 시작한다.

따라서 정직하게 말할 수 있는 것은 상한뿐이다.

> candidate p95 2.610 ms 는 **13 ops 를 묶은 한 trial 전체의 시간**이다. 스케줄러 encode 제거로 줄어드는 시간은 **이 2.610 ms 를 넘을 수 없다.** 그 안에서 encode 가 차지하는 비율은 **실측 없음**.
>
> 참고로 op 당 평균은 `2.610 ÷ 13 ≈ 201 µs / 65,652 B` 이지만, 이것은 **p95 를 op 수로 나눈 값이라 "op 당 p95"가 아니다** — 개별 op 의 분포는 아티팩트에 없다. 규모감 이상으로 쓰지 말 것.

**baseline↔candidate 차이(262 ms)로 "encode 1회당 비용"을 역산해서는 안 된다.** baseline 이 없앤 것은 encode 호출만이 아니라 prefix 재스캔과 full-queue join 할당(`PERF-BGSTAB-009` AC-4)까지이므로, 나눗셈 결과는 per-call 비용이 아니다. 이 역산은 사실처럼 보이는 오류이므로 명시적으로 배제한다.

### 9.3 근거 있게 말할 수 있는 절감

숫자를 만들지 않고 말할 수 있는 것은 **횟수와 복잡도**다.

| 항목 | 현재 | 전환 후 |
|---|---|---|
| output 메시지당 `JSON.parse` | 1회 (payload 전체 스캔 + 이스케이프 해제) | **0회** |
| output 메시지당 전체 payload `TextEncoder.encode` | 1회 | **0회** |
| payload 문자열 물질화 | `JSON.parse` 가 JS 문자열 생성 (payload 크기만큼 할당) | **0** (ArrayBuffer 뷰) |
| 바이트 길이 조회 | `encode(raw).length` — O(n) + 버리는 배열 할당 | **`.byteLength`** — O(1), 할당 0 |
| `sourceSegments` 처리 | encode 1 + decode N + 인코더 인스턴스 신규 할당 | **`subarray` N회** (복사 0) |
| checkpoint payload | `atob` + 바이트당 `charCodeAt` 루프 | **뷰 1개** |
| wire 크기 (ANSI 조밀 구간) | §9.1 의 팽창 | 원본 바이트 |

**[추정]** 절감이 가장 클 것으로 보이는 항목은 큰 단일 지표 하나가 아니라 **payload 크기에 비례하는 O(n) 작업이 메시지당 최소 3회(parse, encode, 문자열 할당) 사라지는 것**이다. 다만 그 절대량은 측정 전에는 알 수 없다.

### 9.4 반드시 알아야 할 제약 — 서버 origin 이 이미 문자열이다

`server/src/services/SessionManager.ts:1353` 은 `ptyProcess.onData((rawData: string) => {` 이다. node-pty 가 `setEncoding('utf8')` 로 **이미 문자열로 디코딩해서** 넘긴다 (`spawnPty` 호출 `:1200-1208` 이 `encoding` 옵션을 넘기지 않아 기본 utf8).

이것의 함의:

- **클라이언트 이득은 온전하다.** 브라우저의 `JSON.parse` + `encode` 는 확실히 사라진다.
- **그러나 시스템 전체의 "복사 없음"은 자동으로 오지 않는다.** node-pty 를 Buffer 모드로 바꾸지 않으면 서버가 문자열을 다시 바이트로 인코딩해 프레임을 만들게 되고, 그 비용은 서버에 남는다.
- 부수 효과: node-pty 의 `setEncoding` 이 내부 `StringDecoder` 로 UTF-8 경계를 처리해 왔다 (`server/src` 에 `StringDecoder` 사용 0건). Buffer 모드로 바꾸면 **그 경계 처리 책임이 서버 코드로 넘어온다.**

**이는 클라이언트 범위 밖이지만, 클라이언트 측 이득을 서버 측 이득으로 오독하지 않기 위해 기록한다.** 결정은 서버 프레임 설계 문서의 몫이다.

---

## 10. 측정 방법 (과제 8)

### 10.1 먼저 고쳐야 할 것 — 주 계측기가 이미 RED

이 조사에서 실제로 실행해 확인했다.

```
cd frontend && node --experimental-strip-types --test tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts
→ pass 0 / fail 1
AssertionError at assertFrozenImplementationSources (…:79:10)
  actual   'sha256:eb5a13be6fc3e16d371ee652be622643f19688b16b4402c776b110973d225ebd'
  expected 'sha256:75716d66fa60885eb90d602c6473fdcd2ceb4d34d30aae113c3ccf04f6452a76'
```

원인: `frontend/tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts:79` 가 **현재 워킹트리의** `terminalOutputScheduler.ts` digest 가 `frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts:34` 에 하드코딩된 wave-2 candidate digest 와 같아야 한다고 단언한다.

그런데 digest 를 세 개 다 떠 보면 상황이 단순한 "파일이 좀 바뀌었다"가 아니다.

| 대상 | normalized sha256 |
|---|---|
| 워킹트리 | `eb5a13be6fc3e16d371ee652be622643f19688b16b4402c776b110973d225ebd` |
| **HEAD** | `dc1edf2acaf16f57b6e517fb1499cd67e579508d12238b3a561aaada647ac1c3` |
| 고정된 candidate (`…Evidence.ts:34`) | `75716d66fa60885eb90d602c6473fdcd2ceb4d34d30aae113c3ccf04f6452a76` |

**HEAD 의 digest 는 고정된 wave-1 _baseline_ digest(`…Evidence.ts:25`)와 정확히 일치한다.** 그리고 baseline 이 `git show` 로 읽는 리비전 `ca111fef` 는 HEAD 의 조상임을 확인했다(`git merge-base --is-ancestor` → YES).

즉 **고정된 candidate 구현은 HEAD 에도 워킹트리에도 존재하지 않는다.** HEAD 는 baseline 과 같고, 워킹트리는 그 어느 쪽도 아닌 제3의 (커밋되지 않은) 변형이다.

**함의 세 가지.**
1. 이 게이트는 **스케줄러를 건드리는 모든 작업을 RED 로 만든다.** `enqueueBytes` 추가도 예외가 아니다.
2. **이 RED 는 이번 작업이 만든 것이 아니다.** 착수 시 "내가 깼다"고 오진하지 않도록 기록한다.
3. **더 중요한 것**: 재고정은 단순 장부 정리가 아니다. 벤치의 provenance 가 저장소의 **어떤 상태와도 대응하지 않으므로**, `scheduler-benchmark.json` 의 264.6 ms → 2.61 ms 수치가 지금 트리의 어느 코드에 귀속되는지 확정할 수 없다. §9.2 의 인용은 "아티팩트에 기록된 값"으로만 유효하며 **현재 코드의 성능으로 읽어서는 안 된다.** [미확인] 워킹트리 변형이 wave-2 candidate 의 상위 집합인지 여부.

**고장 범위는 딱 거기까지다.** 같이 돌려본 결과:

| 스위트 | 결과 |
|---|---|
| `frontend/tests/benchmarks/terminalNoRenderFixture.test.ts` | **2/2 PASS** |
| `frontend/tests/unit/terminalOutputScheduler.test.ts` + `frontend/tests/unit/webSocketBackpressure.test.ts` | **73/73 PASS** |
| `frontend/tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` | **0 pass / 1 fail** |

즉 하네스 본체와 회귀 스위트는 멀쩡하고, 고장난 것은 **paired 벤치의 digest 고정 하나**뿐이다. 회귀 baseline 이 green 이므로 TDD RED 를 새로 세우는 데 지장은 없다.

(실행: `cd frontend && node --experimental-strip-types --test <파일>`)

**[설계결정] 전환 전에 baseline 을 새로 고정한다.** 지금의 스케줄러(문자열 ingress)를 새 baseline 으로 삼아 `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1` 로 아티팩트를 재기록하고, 바이너리 스케줄러를 candidate 로 둔다. 그래야 이번 전환의 전후 비교가 성립한다.

### 10.2 재사용할 자산

새 하네스를 만들지 않는다. 필요한 것이 이미 있다.

| 자산 | 위치 | 용도 |
|---|---|---|
| paired 벤치 러너 | `frontend/tests/benchmarks/terminalNoRenderFixture.ts:318` `runPairedTerminalOutputSchedulerBenchmark` | baseline/candidate 교대 실행, calibration→warmup→measurement |
| 무렌더 픽스처 | 같은 파일 `:258` `runNoRenderFixture` | digest·consumedBytes·invocation 패리티 |
| **encode 계수기 심(seam)** | `frontend/src/utils/terminalOutputScheduler.ts:254` (`textEncoder?: Pick<TextEncoder,'encode'>`), 해석 `:1014`, 계측 구현 `frontend/tests/benchmarks/terminalNoRenderFixture.ts:556-571` | **핵심.** 주입형 인코더로 호출 수를 정확히 센다 |
| manifest 상수 | `frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts:8-18` | seed 7008 / warmup 1 / trial 3 / bootstrap 512 |
| 코퍼스 | 같은 파일 `:38-43`(110 B), `:45-50`(65,542 B = 64KiB-1 ASCII + `한` + 🙂) | UTF-8 경계 포함 |
| 통계 헬퍼 | `terminalOutputSchedulerBenchmark.test.ts:97`, `:103`, `:114` | p95, mulberry32, paired bootstrap. **export 안 됨** — 재사용하려면 추출 필요 |

`terminalOutputScheduler.ts:254` 의 인코더 주입 심이 이번 측정의 열쇠다. **`enqueueBytes` 로 들어온 ingress 는 이 심을 한 번도 건드리지 않아야 한다** — 즉 `encoderResultAllocationCount === 0` 이 그대로 정확 게이트가 된다. 지어낸 임계값이 아니라 **0 이라는 확정값**으로 검증되는 것이 이 설계의 장점이다.

### 10.3 측정 설계

**정확 게이트 (숫자가 확정적이므로 tolerance 불필요)**

| 게이트 | 기대값 |
|---|---|
| bytes ingress 당 `TextEncoder.encode` 호출 | **0** |
| bytes ingress 당 인코더 결과 할당 | **0** |
| output digest parity (baseline vs candidate) | 동일 |
| consumed bytes | 동일 |

**통계 게이트**: 기존 방식 그대로 — paired bootstrap p95 delta 의 95% CI 상한이 baseline p95 의 5% 이하. `PERF-BGSTAB-009` AC-9 이 명시하듯 이 5% 는 **measurement-noise tolerance 이지 product SLO 가 아니다.**

**[설계결정] 새로 추가해야 할 마이크로벤치 — 소켓 ingress 구간**

기존 하네스는 **문자열 ingress 에서 시작**하므로 `JSON.parse` 를 측정 범위에 포함하지 않는다. 이번 전환의 이득 절반이 거기 있으므로 계측기를 하나 넓혀야 한다.

- 대상 구간: `WebSocketContext.tsx:687` 의 파싱부터 `TerminalView.tsx:1673` 의 enqueue 직전까지.
- baseline arm: 실제 wire 형태의 JSON 문자열 → `JSON.parse` → `msg.data` → (sourceSegments 있으면 `splitVisibleOutputSourceSegments`) → enqueue.
- candidate arm: 동일 payload 의 바이너리 프레임(ArrayBuffer) → DataView 파싱 → `subarray` → `enqueueBytes`.
- 두 arm 의 **payload 바이트가 동일**해야 하며 digest 로 확인한다.
- **경계 대조군 필수**: ANSI 이스케이프가 없는 순수 ASCII 코퍼스로도 돌린다. 이스케이프 팽창이 없는 조건에서도 차이가 나오는지 봐야, 측정하고 있는 것이 정말 codec 비용인지 알 수 있다.
- 배치 위치: `frontend/tests/benchmarks/` (Playwright 는 이 디렉터리를 수집하지 않는다). 실행은 `cd frontend && node --experimental-strip-types --test tests/benchmarks/<파일>`.

**[설계결정] 정합성 RED 테스트 (성능과 별개, 필수)**

| 테스트 | 검증 대상 |
|---|---|
| `Uint8Array` 를 `enqueue`(string 진입점)에 넣으면 **거부** | §4.2 의 조용한 손상 방지 |
| 멀티바이트 문자를 프레임 2개로 쪼개 전달 → 최종 버퍼 정상 | xterm `interim` 상태 이월 (§6.3-1) |
| bytes write 사이에 **비어있지 않은** string write 삽입 → 순서 뒤집힘 감지 | §6.3-2, 최대 위험 |
| 빈 string write 삽입 → 영향 없음 | §6.3-3 |
| 길이 필드가 잔여 바이트를 넘는 프레임 → silent drop 이 아니라 명시적 수렴 | `00-decision-record.md:79` |
| 한 WS 메시지에 프레임 2개(배치) → 둘 다 순서대로 처리 | §3.6 배치 허용 루프 |
| Blob 이 도착 → 동기 파서에 넘기지 않고 명시적 거부 + 기록 | §3.2 |
| **grace 버퍼** 계층: 잘게 쪼갠 프레임 N개로 `visibleOutputMaxChunks`(512) 도달 → `chunk-cap-exceeded` (`WebSocketContext.tsx:477`) | §7.2 — green 이면 회계 단위 결정이 필요하다는 증거 |
| **스케줄러** 계층: 같은 조건 → 사유는 `visible-output-overflow` 뿐이다 (`terminalOutputScheduler.ts:15`). 두 계층의 사유 문자열을 섞지 말 것 | §7.2 |
| 협상 회신 전 도착한 바이너리 프레임 → 수용하지 않음 | §8.4 |
| `visibleFlushBudgetBytes` 를 코드포인트 폭보다 작게 → 교착 없이 전진 | `findUtf8SliceEnd:2040-2046` |

### 10.4 프로파일은 서버와 브라우저를 반드시 분리

`JSON.stringify` 는 Node 에서, `JSON.parse` 는 브라우저에서 일어난다. 한 프로파일에 섞으면 귀속이 불가능하다 (`docs/issues/wave4-wave5/19-binary-data-plane.md:128-132`). 브라우저는 DevTools Performance, 서버는 `node --cpu-prof`. 같은 워크로드·같은 구간, **파일은 분리 보관.**

---

## 11. 변경 지점 표

난이도 S(간단)/M(보통)/L(큼). 위험은 실패 시 증상 기준.

> **표 전체에 적용되는 표기 [설계결정] [추정]**: "필요한 변경" 열은 전부 이 문서의 **설계 판단[설계결정]** 이며 합의된 사양이 아니다. "난이도"와 "위험" 열은 전부 **[추정]** 이다 — 실제 구현 없이 매긴 값이므로 셀마다 마커를 반복하지 않고 여기서 일괄 선언한다. "파일:라인"과 "현재 동작" 열만이 코드에서 확인된 사실이다.
>
> **§3.5 의 메타데이터 전달 방안이 미정인 동안 아래 난이도는 하한이다.** 특히 `ws-protocol.ts` 와 `TerminalContainer.tsx` 행은 방안 A/B/C 중 무엇을 고르냐에 따라 크게 달라진다.

### 11.1 필수

| 파일:라인 | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| `frontend/src/contexts/WebSocketContext.tsx:1201` | control 소켓 생성, `binaryType` 미설정(`'blob'`) | `binaryType='arraybuffer'` 를 `:1206` 이전에 설정 | **S** | **높음** — 누락 시 기본 unified 모드에서 전체 output 유실 |
| `frontend/src/contexts/WebSocketContext.tsx:1007` | split output 소켓 생성, 동일 | `:1009` 의 `onmessage` 할당 이전에 동일 설정 | S | 중간 — split 모드에서만 발현 |
| `frontend/src/contexts/WebSocketContext.tsx:687` | `JSON.parse(event.data)`, 분기 없음 | 앞에 2단 분기 추가 — `instanceof ArrayBuffer` → 바이너리, 그 외 비-string → Blob 거부, string → 기존 JSON (§3.2) | **M** | **높음** — 두 소켓의 유일한 수신 관문. JSON 경로는 downgrade 용으로 **영구 존치** |
| `frontend/src/contexts/WebSocketContext.tsx:688-690` | 파싱 실패 시 **무기록 return** | 바이너리 분기는 디버그 이벤트 + 명시적 수렴 (silent drop 금지) | S | 중간 — 위반 시 장애가 보이지 않음 |
| (신규) 프레임 파서 | 없음 | `DataView` 기반 **28B** 헤더 파서 + `frameVersion` 화이트리스트 + **배치 루프**(확정) + payload **뷰** + 큐 보관 시 `.slice()` 분리 | **L** | **높음** — 배치 retention 처리 누락 시 quantum 전체가 GC 되지 않음 |
| `frontend/src/contexts/WebSocketContext.tsx` (신규 분기) | Blob 수신 경로 없음 | Blob 은 동기 파싱 불가 → **명시적 거부 + 기록** (§3.2) | S | 중간 — 없으면 `binaryType` 오설정이 런타임에 안 드러남 |
| `frontend/src/utils/terminalOutputScheduler.ts:1362`, `:1456` | `enqueue`/`enqueueLegacy` 가 `data: string` | `enqueueBytes(data: Uint8Array, ...)` 신설. 기존 진입점에 `instanceof` 거부 가드 | **M** | **높음** — 가드 없으면 §4.2 조용한 손상 |
| `frontend/src/utils/terminalOutputScheduler.ts:1367`, `:1460` | `textEncoder.encode(data)` 무조건 | bytes 경로는 우회, `:1407-1415` 큐 push 로 직행 | S | 중간 |
| `frontend/src/utils/terminalOutputScheduler.ts:146-150`, `:652`, `:803`, `:810` | retry 큐가 `data: string` | `Uint8Array` 수용, `:810` 의 encode 를 `.byteLength` 로 | M | 중간 — canary 거절 경로에서만 발현 |
| `frontend/src/utils/terminalOutputScheduler.ts:163-164` | `attempt`/`attemptLegacy` 가 `string` | 시그니처 확장 | S | 낮음 |
| `frontend/src/utils/terminalOutputScheduler.ts:419`, `:459-462` | `flushNextTerminalRestoreBufferedOutput` 이 **비-string 을 명시적으로 거부** | `Uint8Array` 수용. 큐 소유자는 `TerminalView.tsx:1745` `bufferOutputWhileRestorePending`(채움 `:2909`, flush `:2096`) | M | **높음** — **output 평면 몫이다.** snapshot 범위로 오인해 미루면 restore 대기 중 보류된 live 출력이 전부 거부된다 (§8.0) |
| `frontend/src/components/Terminal/TerminalView.tsx:1639-1645` | `writeOutput(data: string)` | bytes 오버로드 또는 별도 진입점 | M | 중간 |
| `frontend/src/components/Terminal/TerminalView.tsx:1599-1608` | retry 큐 바인딩이 string 전제 | `enqueueBytes` 연결 | S | 낮음 |
| `frontend/src/components/Terminal/TerminalView.tsx:1670` | `getOutputUtf8ByteLength(data)` | `.byteLength` | S | 낮음 |
| `frontend/src/components/Terminal/TerminalContainer.tsx:3192-3443` (분할 호출 `:3388`, `:3214`, `:3302`) | `onOutput` 핸들러 전체 — `splitVisibleOutputSourceSegments` + 메타데이터 9개 소비 + ACK 조립 | bytes 기반으로 전환 | **L** | **높음** — 시그니처 교체가 아니라 핸들러 재작성. **§3.5 방안 확정 전 착수 불가** |
| `frontend/src/contexts/WebSocketContext.tsx:592` | grace 버퍼 재생 시 `onOutput` 재호출 | 보관 대상이 뷰가 되므로 **뷰 수명·retention** 동반 처리 | M | 중간 — 누락 시 재생 경로만 조용히 깨짐 |
| (신규) 바이너리 capability 협상 | 없음 | `onopen` 선언 + 회신 전 JSON 고정 + 실패 시 재협상 (§8.4) | **L** | **높음** — 없으면 구/신 버전 조합에서 조용한 유실 |
| `frontend/src/utils/visibleOutputRecovery.ts:415`, `:440-443` | `encode` → `subarray` → `decode` 왕복 | `payload.subarray(byteStart, byteEnd)` 만 남김 | **M** | 중간 — **왕복 제거 = 최대 단일 절감** |
| `frontend/src/types/ws-protocol.ts:780-801` | `TerminalOutputMessage.data: string` + 메타데이터 10개 | 바이너리 프레임 타입 신설. 기존 타입은 downgrade 용으로 **존치 필수** | **L** | **높음** — 메타데이터 전달 방안 미정(§3.5). **`server/src/types/ws-protocol.ts:712-733` 과 수동 동기화, 자동 동기화 없음** |
| `frontend/tests/e2e/wave2-screen-repair-resync.spec.ts`, `wave2-terminal-restore.spec.ts`, `wave3-terminal-authority-fairness.spec.ts`, `wave3-terminal-authority-promotion.spec.ts`, `perf-bgstab-010-ac9-isolated.spec.ts` | `type:'output'` JSON 메시지를 주입하는 E2E 스펙 5개 | 바이너리 주입 헬퍼 추가 또는 JSON downgrade 경로로 고정 | M | 중간 — 방치 시 전환 후 **스펙이 downgrade 경로만 검증**하게 되어 바이너리 회귀를 못 잡음 |

### 11.2 조건부 / 후속

| 파일:라인 | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| `frontend/src/utils/terminalCheckpointRuntime.ts:408-418` | `decodeBase64` (`atob` + 바이트당 루프) | 프레임 뷰로 대체, 함수 제거 | M | 중간 — 길이 검증(`:410-412`)의 대체 수단 필요 |
| `frontend/src/utils/terminalCheckpointRuntime.ts:1179`, `:1221`, `:1249` | base64 디코딩 3곳 | 뷰 직접 전달 | S | 중간 |
| `frontend/src/utils/terminalReplayGuard.ts:100` | `options.write(options.data, ...)` — string 가능 | 바이너리 epoch 중 string write 금지 (§6.3) | M | **높음** — 위반 시 **출력 순서 뒤집힘** |
| `frontend/src/utils/terminalWriteCoordinator.ts:1974` | mutation 이 `string` 통과 | 동일 | M | 높음 |
| `frontend/src/utils/terminalWriteCoordinator.ts:343-352` | `parseCanonicalOrdinal64` 가 string 입력 | bigint 직접 생성자 추가 (§3.4) | M | 중간 — `wire` 소비처 **[미확인]** |
| `frontend/src/contexts/WebSocketContext.tsx:469` | grace 버퍼 `getOutputUtf8ByteLength` | `.byteLength` | S | 낮음 |
| `frontend/src/components/Terminal/TerminalView.tsx:1753`,`:2902`,`:3901`,`:3923`,`:3933` | 회계용 encode | `.byteLength` | S | 낮음 |
| `frontend/src/utils/visibleOutputRecovery.ts:1373`,`:1426`,`:1487`,`:1658` | 복구 회계 encode | `.byteLength` | S | 낮음 |
| `frontend/tests/benchmarks/terminalNoRenderFixtureEvidence.ts:34` | candidate digest 고정 (**현재 불일치**) | baseline 재고정 (§10.1) | S | **높음** — **미조치 시 관련 작업 전부 RED** |
| `frontend/src/utils/webSocketBackpressure.ts:31-33`, `:85`, `:121` | **송신측** 백프레셔가 JSON 문자열 길이 기준 | **이번 범위 변경 없음** (§7.1). 입력 평면까지 확장할 때만 착수 (§7.3) | M | 낮음 (현 범위) |
| `frontend/src/contexts/WebSocketContext.tsx:468-476` | **수신측** grace 큐가 바이트·청크 이중 예산 (`visibleOutputMaxChunks` 512) | 청크 회계 단위를 프레임이 아닌 큐 원소로 고정 (§7.2) | M | **높음** — 방치 시 잘게 쪼갠 프레임에서 `chunk-cap-exceeded` 조기 발생 |

### 11.3 변경하지 않는 것 (명시)

| 대상 | 이유 |
|---|---|
| `frontend/src/utils/terminalOutputScheduler.ts:1238`, `:1269`, `:1308` | 이미 바이트 경로. `findUtf8SliceEnd` 는 flush 예산 때문에 계속 필요 (§6.2) |
| `frontend/src/utils/terminalWriteCoordinator.ts:1046`, `:1050`, `:1095`, `:1101` | 어댑터 계약이 이미 `string \| Uint8Array` |
| `frontend/src/utils/terminalRawMutationAdapter.ts:82`, `:87` | 이미 바이트를 그대로 xterm 에 전달 |
| `frontend/src/utils/terminalRawMutationAdapter.ts:89`, `terminalReplayGuard.ts:86` | 빈 문자열 write 는 디코더 상태 무영향 (§6.3-3) |
| control 평면 메시지 전체 | 설계상 JSON 유지 |
| `screen-snapshot` 평면 (`frontend/src/types/ws-protocol.ts:680`, 핸들러 `TerminalContainer.tsx:3157` → 정의 `:2385`, 회계 `:2394`) | **[설계결정]** output 평면과 분리해 후속 단계로. hot path 아니며 위험 대비 이득이 나쁨 (§8.0). **의도적 제외이지 누락이 아니다** — 포함 여부는 §12 #8. ⚠️ restore 게이트 `terminalOutputScheduler.ts:459-462` 는 **여기 포함되지 않는다** — output 평면 몫이라 §11.1 에 있다 |

---

## 12. 미확인 항목과 열린 질문

`01` 이 프레임·협상·롤백을 확정하면서 초안 단계의 열린 질문 상당수(메타데이터 전달, 배칭, `channelId` 매핑, `sourceSeq` 표현, 엔디안)가 닫혔다(§0). **아래는 그 이후에도 남는 것들이며 대부분 클라이언트 고유 사안이다.**

| # | 항목 | 왜 중요한가 | 확인 방법 |
|---|---|---|---|
| 1 | **[미확인]** 현행 코드에 이미 string/bytes 혼합 write 결함이 있는가 | checkpoint 평면이 이미 bytes 를 쓰므로 조건은 **오늘 이미 성립** (§6.3) | 회귀 테스트로 현행 동작 먼저 특성화 |
| 2 | **[미확인]** string/bytes 혼합 write 시 순서 뒤집힘 재현 | §6.3 의 최대 위험. 번들 소스로 구조는 확인했으나 재현 테스트 없음 | 멀티바이트를 2/2 로 쪼갠 bytes write 사이에 비어있지 않은 ASCII string write 삽입 후 `terminal.buffer` 비교 (§10.3) |
| 3 | **[미확인]** 배치 뷰 retention 을 `.slice()` 로 끊을지 회계를 바꿀지 | 배치 상한이 DRR quantum 이라 프레임 1개가 quantum 전체를 붙잡는다 (§3.3). **§9.3 의 복사-0 이득과 상충하는 유일한 지점** | 클라이언트 사안 — 구현 시 결정 |
| 4 | **[미확인]** 청크 예산(`visibleOutputMaxChunks` 512)을 프레임 단위로 셀지 큐 원소 단위로 셀지 | 배치 확정으로 한 메시지가 프레임 N개다. 프레임 단위로 세면 **바이트 여유가 남아도 청크 예산이 먼저 터진다** (§7.2) | 순수 클라이언트 사안 — 이 문서 범위에서 결정 가능 |
| 5 | **[미확인]** `authorityEpochIndex` 매핑 도착 전에 그 인덱스를 쓰는 프레임이 오면 | 바이너리는 인덱스만 주고 매핑은 JSON control 로 온다 — **두 평면 간 순서 보장 필요** (§3.5) | `01` 이 이 순서를 규정하는지 확인 후, 없으면 합의 |
| 6 | **[미확인]** `replayToken`/`repairToken` 채널 상태의 폐기 시점 | stateless → stateful 전환. 재연결·epoch 롤백 시 언제 버릴지가 새 계약 (§3.5) | `01` §4 롤백 상태전이도와 대조 |
| 7 | **[미확인]** ACK 도메인 전환(`deliverySeq`→`sourceSeq`)의 클라이언트 영향 범위 | 기존 ACK 조립 경로(`TerminalContainer.tsx:3377-3379`, `:3398-3402`)가 통째로 바뀐다 (§3.5, §7.4) | `01` §2.4 와 대조 |
| 8 | **[미확인]** snapshot 평면(`screen-snapshot`)을 이번 전환에 포함할지 | `01` §1.8 이 `0x02 SCREEN_SNAPSHOT` 프롤로그를 이미 정의했으므로 포함이 유력하다. **restore 게이트(`:459-462`)는 이 질문과 무관하다** — output 평면 몫이라 이미 §11.1 필수다 (§8.0) | 상위 결정 + `01` §1.8 확인 |
| 9 | **[설계결정 필요]** node-pty Buffer 모드 전환 여부 | 서버 origin 이 문자열이라 시스템 전체 이득이 자동으로 오지 않음 (§9.4) | 서버 범위 — `02-server-integration-sites.md` 참조 |
| 10 | **[설계결정 필요]** `PERF-BGSTAB-009` AC-7 개정 방식 | Status=implemented / Stability=evolving. AC 를 고칠지 신규 REQ 로 대체할지 | `04-srs-amendment-plan.md` |

---

## 13. 참조

| 문서 | 관계 |
|---|---|
| `docs/research/binary-comms/00-decision-record.md` | 상위 결정. **그 문서의 §3** 유지 조항(silent drop 금지·롤백 계약·TDD)이 이 문서의 설계 제약 |
| `docs/issues/wave4-wave5/19-binary-data-plane.md` | 원본 이슈. 게이트는 폐기됐으나 3단계 구현 항목은 유효 |
| `docs/spec/30.buildergate-stability.srs.md:2908-2986` | `PERF-BGSTAB-009`. AC-7(`:2939`)이 걷어낼 울타리, AC-1/AC-9 는 측정 계약으로 유지 |
| `docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave2-hotpath/scheduler-benchmark.json` | 유일한 관련 실측 아티팩트 (§9.2) |
| `docs/research/2026-07-02.buildergate-native-performance-54-sessions-deep-analysis.md:116` | F15 JSON 텍스트 프레이밍 — 정성적 서술, 수치 없음 |
