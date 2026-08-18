# 서버 측 바이너리 전환 개입 지점 전수 조사

| 항목 | 값 |
|---|---|
| 작성일 | 2026-08-16 |
| 상위 결정 | [`00-decision-record.md`](./00-decision-record.md) — 바이너리 데이터 플레인 무조건 도입 |
| 범위 | **서버 측만**. 프론트엔드는 계약 영향만 언급하고 개입 지점은 열거하지 않는다 |
| 성격 | 조사 문서. **코드 변경 없음** |
| 전제 (재론 안 함) | control 평면 JSON 유지 · terminal output/snapshot 평면만 바이너리 · 프레임 초안 `[opcode 1B][channelId 4B][streamEpoch 4B][sourceSeq 8B][length 4B][payload]` (헤더 21B) |

표기 규약: 확인된 사실은 `file:line`, 확인하지 못한 것은 `[미확인]`, 이 문서가 내리는 판단은 `[설계결정]`, 수치 추정은 `[추정]`.

> **경로 정정**: 과제 지시문의 `config.schema.ts:56` 은 `server/src/config/config.schema.ts` 가 아니라 **`server/src/schemas/config.schema.ts:55-57`** 이다. `server/src/config/` 디렉터리는 존재하지 않는다.

---

## 0. 세 줄 요약

1. **`ws.send` 는 한 곳이지만, 그 앞의 결정 로직 4곳이 `JSON.parse(message.payload)` 로 payload 를 되읽어 라우팅을 판정한다.** 바이너리에서 이 4곳은 전부 성립하지 않는다. 이것이 이 전환의 실질적 최대 난관이며, payload 타입 변경보다 먼저 해결해야 한다.
2. **회계 단위는 이미 "와이어 바이트"로 일관돼 있다**(`bufferedAmount` 와 같은 도메인). 따라서 바이너리 프레임에서도 `byteLength = 21 + payload.byteLength` 로 두면 구조는 유지된다. 문제는 값이 아니라 **fair scheduler 정책 임계값 5개의 의미가 바뀌어 재벤치가 필요**하다는 것이다.
3. **`wsSendPolicy.ts` 와 `WsRouter.ts` 는 fair-scheduler provenance 로 핀 고정돼 있다**(`server/tools/write-fair-scheduler-source-provenance.mjs:10-11`). 이 두 파일을 건드리는 순간 provenance/evidence 재발행 절차가 강제된다. 작업 순서를 여기에 맞춰야 한다.

---

## 1. 송신 경로 전수 지도

### 1.1 PTY → 와이어 전체 흐름

```
node-pty (server/src/services/SessionManager.ts:1200 spawnPty, encoding 옵션 없음)
  │
  │  ★ 소스는 이미 JS string 이다 — SessionManager.ts:1353 `ptyProcess.onData((rawData: string) => ...)`
  │     Buffer 가 아니다. 바이너리 프레임 payload 를 만들려면 서버가 Buffer.from(data,'utf8') 로
  │     재인코딩해야 한다. (개입 지점 ①)
  ▼
SessionManager (headless 파서 / retained authority 경유)
  ├─ SessionManager.ts:7754 / :7759  정상 flush           ─┐
  ├─ SessionManager.ts:7561 / :7617  degraded / overflow  ─┤ 전부 문자열 `data` 를 넘긴다
  └─ SessionManager.ts:4466          write 실패 fallback  ─┘
  ▼
WsRouter.routeSessionOutput(sessionId, data: string, ...)   WsRouter.ts:4961
  │
  ├─[A] replay pending          WsRouter.ts:4985-5013   → 큐에 적재(전송 안 함). 바이트 회계는 utf8ByteLength
  ├─[B] screen-repair pending   WsRouter.ts:5015-5040   → 동일
  ├─[C] checkpoint active       WsRouter.ts:5042-5046   → late 카운트만 올리고 drop
  │
  ├─[D] hidden + fair scheduler WsRouter.ts:5050-5127
  │        └─ dataGap 프레임    WsRouter.ts:5099-5121   payload = JSON.stringify({...})  ← ★ 이중 인코딩
  │
  ├─[E] checkpointLedger.settled WsRouter.ts:5130-5141  → sendTo(직접)
  ├─[F] fair scheduler 등록됨    WsRouter.ts:5143-5156  → scheduler.enqueue({payload: data}) → drain()
  └─[G] 그 외(스케줄러 없음)     WsRouter.ts:5159-5167  → sendTo(직접)


[F] fair scheduler 내부                              wsSendPolicy.ts:625 createFairTerminalDeliveryScheduler
  enqueue()      :750  encodedBytes = fairDeliveryBytes(input, seq)   :598-611
                       └─ ★ createWsTransportMessage 로 JSON 을 만들어 그 byteLength 만 취한다
                          (JSON 문자열을 버리려고 만든다 — 순수 회계용 인코딩)     (개입 지점 ②)
  drain()        :774  control 우선 → deficit round-robin
  sendOne()      :720  eligible() :699 / canSpendDeficit() :714 로 credit·deficit 판정
                       → options.send(delivery)
  ▼
WsRouter.createFairDeliveryScheduler().send        WsRouter.ts:5842-5875
  ├─ kind === 'dataGap' : JSON.parse(delivery.payload)  WsRouter.ts:5846  ← ★ payload 를 JSON 문자열로 가정
  └─ 그 외              : data: delivery.payload       WsRouter.ts:5855  ← ★ payload 가 곧 wire `data` 필드
  ▼
  this.sendTo(output, message, onSettled)


[별도 평면] terminal authority / checkpoint
TerminalAuthorityProductionAdapter.ts:1563-1570  terminal-checkpoint:output 조립 (base64)
  → enqueueSettledViewFrame  Adapter.ts:1189
  → router.sendTerminalAuthorityFrameToConnection  WsRouter.ts:1079
  → WsRouter.ts:1125  this.sendTo(target, message, onSettled, {connectionId, lane, bindingId})

[별도 평면] snapshot / repair
WsRouter.ts:4920-4940  screen-snapshot   → sendTo  (data 는 raw ANSI string, base64 아님)
WsRouter.ts:3223-3230  screen-repair     → sendTo  (ansiPatch raw string)


★ 이하 4개 진입점이 합류하는 공통 하류
──────────────────────────────────────────────────────────────────────
 sendTo                        WsRouter.ts:6771   (범용 · 메타데이터 부착)
 sendPriorityControl           WsRouter.ts:6730   (kind='control' 강제)
 sendNonCoalescingOutputChunk  WsRouter.ts:6740   (outputData=undefined 로 coalesce 차단)
 routeTerminalAuthorityFrame   WsRouter.ts:341    (큐에 직접 push, sendTo 우회)
      │
      ▼
 createWsTransportMessage      wsSendPolicy.ts:80-125
      :91  payload = JSON.stringify(wireMessage)           ← ★ 유일한 payload 생산자  (개입 지점 ③)
      :95  byteLength = Buffer.byteLength(payload,'utf8')  ← ★ 유일한 byteLength 파생  (개입 지점 ④)
      │
      ▼
 sendTransportMessage          WsRouter.ts:6077
      :6098  projectedBufferedAmount = bufferedAmount + message.byteLength
      ├─ mode==='direct'            :6086 → 큐 비면 즉시 raw send
      ├─ hard-limit 초과            :6099 → close 또는 observe
      ├─ safe-send-observe          :6110
      └─ high-water/큐 존재         :6133 → enqueueTransportMessage
      │
      ▼
 enqueueTransportMessage       WsRouter.ts:6154
      :6163  getLastTerminalTransportMessage
      :6165  tryCoalesceOutputMessage(last, message, outputCoalesceWindowMs)  ← ★ (개입 지점 ⑤)
      :6168  outputBytes = outputBytes - last.byteLength + coalesced.byteLength
      :6182  output 예산 판정 / :6194 control 예산 판정
      │
      ▼
 flushTransportQueue           WsRouter.ts:6206
      :6215  peekNextTransportMessage → :6219 bufferedAmount + peeked.byteLength vs hard-limit
      :6228  dequeueNextTransportMessage
      │
      ▼
 sendRawTransportMessage       WsRouter.ts:6240
      :6249  terminalAuthorityTransportBinding 검증
      :6268  ws.send(message.payload, cb)   ← ★★ 프로덕션 유일 송신 지점  (개입 지점 ⑥)
      :6286  isCurrentCandidateTransportMessage / isWsRollbackBoundaryMessage
      :6289  isFairTerminalDeliveryTransportMessage  ← ★ JSON.parse(payload)  (개입 지점 ⑦)
```

### 1.2 경로별 개입 지점 요약

| 경로 | 진입 지점 | 바이너리화 시 개입 내용 |
|---|---|---|
| **[F] fair scheduler 경유** | `WsRouter.ts:5143-5156` | `payload: data`(string) → `payload: Buffer.from(data,'utf8')`. `fairDeliveryBytes`(`wsSendPolicy.ts:598-611`)가 JSON 을 만들어 회계하는 것을 `21 + bytes.byteLength` 로 대체 |
| [F] 스케줄러 출구 | `WsRouter.ts:5842-5875` | `data: delivery.payload`(`:5855`)가 JSON `data` 필드로 직결 → 프레임 조립기 호출로 교체. `deliverySeq`/`connectionEpoch`/`deliveryKind` 를 payload 밖으로 승격 |
| [D] dataGap | `WsRouter.ts:5099-5121` | `JSON.stringify` → scheduler → `JSON.parse`(`:5846`) 왕복. **dataGap 은 control 성격이므로 JSON 유지 대상** [설계결정]. 단 scheduler `payload` 타입이 넓어지면 이 경로가 문자열임을 타입으로 구분해야 함 |
| **[G] 직접 전송** | `WsRouter.ts:5159-5167` | 스케줄러 미등록 소켓(= capability 협상 실패). 바이너리 capability 도 협상하므로 **이 경로는 JSON 유지**가 자연스럽다 [설계결정] |
| [E] checkpoint settled 직접 | `WsRouter.ts:5130-5141` | 동일 |
| **priority control** | `WsRouter.ts:6730-6737` | control 평면 → **변경 없음** |
| **non-coalescing output** | `WsRouter.ts:6740-6769` | recovery tail(repair/replay). output 평면이지만 `repairToken`/`replayToken`/`chunkId` 를 나른다. 프레임 헤더에 자리가 없음 → **1단계 JSON 유지** [설계결정] |
| authority/checkpoint | `WsRouter.ts:1079-1136` → `sendTo` | `terminal-checkpoint:output`/`:chunk` 는 base64 를 걷어낼 최대 수혜 지점 (§5) |
| snapshot | `WsRouter.ts:4920-4940` | 큰 blob + 메타 다수. 프레임 초안에 메타 자리가 없어 **하이브리드**(control JSON 헤더 + 바이너리 body) 필요 (§5.3) |

---

## 2. `WsTransportMessage.payload: string` 타입 변경의 파급

### 2.1 결론 먼저 — 타입을 넓히는 것은 두 번째 문제다

`payload` 를 `string | Uint8Array` 로 넓히면 컴파일이 깨지는 곳은 **의외로 적다**. `Buffer.byteLength(value, encoding)` 는 TypedArray 를 받으면 `value.byteLength` 를 반환하므로 회계 지점 대부분은 그대로 컴파일된다. 진짜 문제는 **컴파일은 되는데 의미가 조용히 어긋나는 곳**과 **`JSON.parse` 4곳**이다.

### 2.2 반드시 컴파일 에러가 나는 지점 (`JSON.parse(payload)`)

`JSON.parse(text: string)` 이므로 `string | Uint8Array` 는 통과하지 못한다. **4곳 전부가 "라우팅 결정"을 위해 payload 를 되읽는다** — 즉 데이터를 보고 메타를 복원하는 안티패턴이며, 바이너리 여부와 무관하게 먼저 고쳐야 한다.

| file:line | 함수 | 현재 동작 | 실패 방향 |
|---|---|---|---|
| `wsSendPolicy.ts:288` | `hasFairDeliveryIdentity` | `connectionEpoch`/`deliverySeq`/`deliveryKind` 존재 시 coalesce 차단. **parse 실패 시 `true` 반환** | 바이너리면 항상 `true` → **coalescing 전면 무력화** |
| `WsRouter.ts:5535` | `discardCheckpointQueuedFairDeliveryTransport` | epoch+session+deliverySeq 매칭 큐 제거 | parse 실패 → `false` → **checkpoint 시 stale 프레임이 큐에 남음** |
| `WsRouter.ts:5564` | `discardQueuedFairDeliveryTransport` | epoch 단위 큐 폐기 | 동일 → **롤백/세션 종료 시 큐 정리 실패** |
| `WsRouter.ts:6396` | `isFairTerminalDeliveryTransportMessage` | send 실패 시 fair-delivery 여부 판별 | parse 실패 → `false` → **safe-send-enforce 에서 fair delivery 실패가 클라이언트 강제 종료로 격상** |

> ⚠️ 네 곳의 실패 방향이 **서로 반대**다. `hasFairDeliveryIdentity` 는 실패 시 보수적(`true`)이고 나머지 셋은 낙관적(`false`)이다. 부분 전환 상태에서 "coalescing 은 안 되는데 큐 정리도 안 되는" 최악 조합이 나온다.

**최소 변경안 (바이너리 도입 전, JSON 상태에서 선행)**
`WsTransportMessage` 에 이미 `sessionId`/`chunkId`/`screenSeq` 등이 사이드카로 올라와 있다(`wsSendPolicy.ts:19-36`). 같은 방식으로 3개 필드를 추가한다.

```
// wsSendPolicy.ts:14-43 인터페이스에 추가
connectionEpoch?: string;
deliverySeq?: number;
deliveryKind?: FairTerminalDeliveryKind;
```

`createWsTransportMessage`(`:80-125`)의 스프레드 패턴에 3줄을 추가해 채우고, 위 4곳의 `JSON.parse` 를 필드 읽기로 교체한다. **이 변경은 순수 리팩터이며 관측 동작이 동일**하므로, 기존 테스트(§2.6)가 그대로 회귀 게이트가 된다. 난이도 **M**, 위험 낮음.

### 2.3 컴파일은 되지만 의미가 바뀌는 지점 (더 위험)

| file:line | 현재 | 타입 확장 후 |
|---|---|---|
| `WsRouter.ts:1405` | `Buffer.byteLength(message.payload,'utf8') !== message.byteLength` → `tampered-queued-message-byte-length` | TypedArray 는 `byteLength` 를 반환하므로 **일치는 하지만 검사가 무의미해진다**. `'utf8'` 인자가 조용히 무시됨. 검사가 vacuous 해진 사실을 런타임 shape 단언으로 고정해야 함 |
| `WsRouter.ts:1383`, `:1413` | canary admission preview/admit 의 `computedIncomingBytes` | 동일. 두 피연산자가 같은 출처가 되어 대조 능력이 사라짐 |
| `tools/wave3/terminal-resource-policy-differential.ts:120`, `:211` | `Buffer.from(message.payload).toString('hex')` — **인코딩 인자 없음** | string 이면 utf8, Uint8Array 면 바이트 복사. **differential 증거 해시가 조용히 달라진다** |
| `WsRouter.ts:1474` | `{ ...input.incomingMessage, ... }` 스프레드 복제 | payload 참조가 그대로 복사됨. Uint8Array 는 **얕은 복사**라 원본을 나중에 재사용하면 aliasing 버그. 프레임 버퍼 재사용 금지를 명시해야 함 |
| `wsSendPolicy.ts:244-249` | `Buffer.byteLength(existing.outputData)` + `combinedOutputData` 길이 검증 | `outputData` 는 별도 필드(`string`)이므로 payload 타입과 무관하게 남는다 → §4 |

### 2.4 프로덕션 함수 시그니처 전이 (선언만 바뀌는 곳)

| file:line | 내용 |
|---|---|
| `wsSendPolicy.ts:16` | `payload: string` — SSOT |
| `wsSendPolicy.ts:17` | `byteLength: number` — payload 파생 |
| `wsSendPolicy.ts:499` | `FairTerminalDeliveryInput.payload: string` |
| `wsSendPolicy.ts:511` | `FairTerminalDelivery.encodedBytes: number` |
| `WsRouter.ts:1359`, `:1439` | canary preview/admit 의 `incomingMessage: WsTransportMessage` |
| `services/RuntimeConfigStore.ts:426`, `:438` | 위 2개의 위임 래퍼 |

### 2.5 큐 조작 함수 — payload 타입에 **무관**

`pushTransportMessage`(`:392`) / `prependTransportMessage`(`:400`) / `peek`(`:418`) / `dequeue`(`:425`) / `replaceLast`(`:380`) / `getLast`(`:372`) / `getTransportMessagesInPriorityOrder`(`:441`) / `removeTransportMessages`(`:178`) 는 전부 `kind` 와 `byteLength` 만 본다. **변경 불필요**. 호출 지점(프로덕션 기준 `WsRouter.ts:341, 1400, 5530, 5561, 5768, 5938, 5950, 5963, 6138, 6163, 6174, 6188, 6200, 6215, 6228, 6419, 6543, 6557, 6610, 6627, 6683, 6710`)도 그대로다.

### 2.6 테스트 하네스 파급 (전수)

| 파일 | 내용 | 난이도 |
|---|---|---|
| **`server/src/ws/FairTerminalDeliveryScheduler.test.ts:7-23`** | ⚠️ **`DeliveryInput`/`SentDelivery` 를 import 하지 않고 로컬 재선언**(`payload: string`). 소스 타입을 넓혀도 **컴파일 에러가 안 난다** → 조용히 어긋남. 실제 타입 import 로 교체 필수 | **S (필수)** |
| `FairTerminalDeliveryScheduler.test.ts` | `payload:` 문자열 리터럴 enqueue 47건(`:232-242, 271-277, 393-458, 485-724, 772-812`), `payload.startsWith`(`:437`), 동등 비교 11건, `encodedOutputBytes` 기대값(`:219, 226, 495, 502, 543, 554`) | **L** |
| `server/src/ws/wsSendPolicyRestoreMetadata.test.ts` | `createWsTransportMessage` 8건 + `tryCoalesceOutputMessage` 5건 + `JSON.parse(coalesced.payload)`(`:93`) | M |
| `server/src/ws/WsRouterSendPriority.test.ts` | canary admission 에 `incomingMessage` 주입 12건(`:1378-2085`), `payload.includes(...)`(`:963-967`), 로컬 타입 재선언(`:1157`, `:1327`) | M |
| `server/src/services/TerminalResourcePolicyCanary.test.ts` | `createWsTransportMessage` 4건, `byteLength` 를 `1` 로 **덮어써 tamper 시뮬레이션**(`:1711, 1722, 1877, 1878`) — §2.3 의 검사 vacuous 화와 직결, `Buffer.byteLength(incoming.payload,'utf8')`(`:1841`), `JSON.parse`(`:3322, 3328`) | **M (검사 의미 재설계 필요)** |
| `server/src/services/TerminalAuthorityController.test.ts` | `JSON.parse(message.payload)` 7건(`:1624, 1670, 1687, 7905, 7955, 8118, 8125`), mock `send(payload: string \| Buffer)`(`:581` — **유일하게 이미 Buffer 수용**) | M |
| `server/src/test-runner.ts` | `createWsTransportMessage` 16건(`:16527-16547`, `:16624-16708`), `byteLength` 6건, `removeTransportMessages`(`:16576`) | M |
| MockWebSocket `send(payload: string, ...)` 시그니처 | `WsRouterSendPriority.test.ts:45`, `WsRouterCheckpointProtocol.test.ts:19`, `TerminalResourcePolicyCanary.test.ts:268`, `WsRouterSplitHandshake.test.ts:13` | S (4곳) |
| 벤치마크 | `benchmarks/terminalCharacterization.ts:419, 425, 432`; `benchmarks/terminalFairnessCharacterization.ts:1055-1202` (`creditPayload.length` 를 **UTF-16 length 로 바이트 임계 계산** — `:1093`, 이미 잠재 결함) | **L (재벤치)** |
| `tools/wave3/terminal-resource-policy-differential.ts:109-120, 211` | 픽스처 3건 + hex digest 2곳 | M |

**소스 텍스트 어서션 주의**: `benchmarks/terminalFairnessCharacterization.test.ts:162` 의 `assert.match(source, /createWsTransportMessage/u)` 는 **문자열 매칭**이라 시그니처가 바뀌어도 통과한다. 이 축은 회귀 게이트로 신뢰할 수 없다.

### 2.7 [설계결정] 타입 확장 방식 — 별도 타입이 아니라 유니온

세 안 중 **(b) 유니온 확장 + 판별 필드**를 권고한다.

| 안 | 내용 | 평가 |
|---|---|---|
| (a) `payload: string \| Uint8Array` 만 | 최소 변경 | ❌ §2.3 의 "조용히 vacuous" 문제를 그대로 남긴다. 어느 메시지가 바이너리인지 타입으로 알 수 없음 |
| **(b) `payload: string \| Uint8Array` + `encoding: 'json' \| 'binary'` 필수 필드** | 판별 가능한 유니온 | ✅ `Buffer.byteLength` 호출부가 `encoding` 을 보고 분기하도록 강제할 수 있고, 검사가 vacuous 해졌는지 런타임에서 단언 가능 |
| (c) `WsBinaryTransportMessage` 별도 타입 | 완전 분리 | ❌ 큐 4종·coalescing·canary·백프레셔가 전부 두 벌이 된다. §10.2 중복 아키텍처 금지 위반 |

(b) 채택 시 `wsSendPolicy.ts:14-43` 에 `encoding` 을 **필수**로 추가하면, 이 인터페이스를 리터럴로 만드는 모든 테스트 픽스처가 컴파일 에러로 드러난다 — §2.6 의 목록이 컴파일러로 자동 검증된다. 이것이 (b) 의 가장 큰 이점이다.

---

## 3. 회계 단위

### 3.1 현재 상태 — 이미 "와이어 바이트"로 일관돼 있다

| 회계량 | 정의 위치 | 현재 의미 |
|---|---|---|
| `WsTransportMessage.byteLength` | `wsSendPolicy.ts:95` | JSON 직렬화 후 UTF-8 바이트 = **실제 와이어 바이트** |
| `state.outputBytes` / `controlBytes` | `wsSendPolicy.ts:50-51` | 위의 합 |
| `bufferedAmount` | `WsRouter.ts:6083`, `:6213` | `ws` 라이브러리의 소켓 버퍼 바이트 = 와이어 바이트 |
| `FairTerminalDelivery.encodedBytes` | `wsSendPolicy.ts:598-611` | JSON 인코딩 후 와이어 바이트 (회계 목적으로만 JSON 을 만들고 버린다) |
| replay/repair 큐 바이트 | `WsRouter.ts:423 utf8ByteLength`, `:3979`, `:4684` | **원본 문자열의 UTF-8 바이트** (와이어 아님) |

`WsRouter.ts:6098` 의 `bufferedAmount + message.byteLength` 가 성립하려면 두 항이 같은 도메인이어야 한다. **즉 `byteLength` 는 프레임 헤더를 포함해야 한다.**

### 3.2 [설계결정] 바이너리에서의 정의

| 회계량 | 바이너리 정의 | 근거 |
|---|---|---|
| `byteLength` | **`21 + payload.byteLength`** (헤더 **포함**) | `bufferedAmount` 와 동일 도메인 유지. `WsRouter.ts:6098, 6182, 6194, 6219` 가 무수정으로 성립 |
| `encodedBytes` (fair) | **`21 + payload.byteLength`** (헤더 **포함**) | 결정 기록 §3 "ACK credit 은 encoded byte 단일 domain". 클라이언트가 ACK 시 보고할 바이트도 수신 프레임 전체 크기여야 함 |
| `state.outputBytes` | 변경 없음(합계) | — |
| replay/repair 큐 바이트 | **변경 없음(원본 UTF-8)** | 이 큐는 전송 전 데이터 보관이며 와이어 형식과 무관. 섞으면 두 도메인이 오염된다 |
| coalescing byte limit | `outputQueueMaxBytes` 그대로 (와이어 바이트) | — |

### 3.3 관련 코드 지점 (전수)

**변경 불필요 — 정의만 지키면 그대로 동작**

`WsRouter.ts:6098`(projected) · `:6168`(coalesce 차감·가산) · `:6182, 6187`(output 예산) · `:6194, 6199`(control 예산) · `:6219`(hard-limit) · `:6233, 6235`(flush 차감) · `:6420, 6421`(재삽입 가산) · `:6617, 6619, 6634, 6636`(drain 차감) · `:5770, 5777, 5783`(grandfathering) · `wsSendPolicy.ts:202, 205`(제거 바이트 합산) · `wsSendPolicy.ts:701, 703, 717, 724, 727, 738-741, 758, 769, 840, 860`(credit/deficit/queue 예산)

**반드시 변경**

| file:line | 현재 | 필요 변경 |
|---|---|---|
| `wsSendPolicy.ts:95` | `Buffer.byteLength(payload,'utf8')` | 바이너리 분기 시 `21 + bytes.byteLength` |
| `wsSendPolicy.ts:598-611` | `createWsTransportMessage(...).byteLength` 로 회계 | 프레임 크기 계산으로 대체. **회계 목적의 JSON 생성 자체가 사라진다 — CPU 이득 항목** |
| `WsRouter.ts:1383, 1405, 1413, 1425` | canary tamper 검사 | §2.3 참조. `encoding` 별 재계산으로 분기 |
| `benchmarks/terminalFairnessCharacterization.ts:1093` | `creditPayload.length` (UTF-16) | 바이트 기준으로 정정 |

### 3.4 ⚠️ 임계값 재벤치가 필수인 이유

`resolveFairTerminalDeliveryPolicy` 가 주입하는 5개 임계값(`wsSendPolicy.ts:518-528`: `socketSoftGateBytes`, `bulkSliceBytes`, `smallOutputBypassBytes`, `creditWindowBytes`, `queueMaxBytes`)은 **JSON 오버헤드가 포함된 바이트 세계에서 튜닝됐다.**

JSON output 프레임 1개의 고정 오버헤드 [추정]:
`{"type":"output","sessionId":"<uuid 36>","data":"...","connectionEpoch":"...","deliverySeq":N,"deliveryKind":"output","screenSeq":N,"authorityEpoch":"...","authorityRevision":N,"chunkId":"<uuid 36>"}` ≈ **250~400 바이트** + ANSI 제어문자 이스케이프 팽창(`` = 6바이트/개).

바이너리 프레임 고정 오버헤드 = **21 바이트**, 이스케이프 없음.

→ 40바이트 프롬프트 재출력 청크의 경우 JSON ≈ 300B vs 바이너리 61B. **`smallOutputBypassBytes` 판정이 정반대로 뒤집힌다.** 같은 `creditWindowBytes` 에 5배 많은 청크가 들어가므로 `eligible()`(`:699`)·`canSpendDeficit()`(`:714`)의 공정성 특성이 전부 달라진다.

이는 결정 기록 §2.4 의 `PERF-BGSTAB-010 → 재벤치 필요` 와 일치한다. 재벤치 대상은 `server/src/benchmarks/terminalFairnessCharacterization.ts` 이며, 그 산출물은 `docs/analysis/terminal-fairness-authority/` 의 canonical authority 로 **재발행**되어야 한다 (§9.1).

---

## 4. Coalescing

### 4.1 현재 구현은 "프레임 병합"이 아니라 "논리 메시지 재직렬화"다

`tryCoalesceOutputMessage`(`wsSendPolicy.ts:216-279`):

1. 병합 가능성 판정 (`:221-241`) — 같은 `sessionId`, 양쪽 `outputData` 존재, 8개 메타 필드 완전 일치, recovery/fair-delivery 정체성 없음, `queuedAt` 차이 ≤ `coalesceWindowMs`
2. UTF-8 경계 검증 (`:244-249`) — `byteLength(a+b) !== byteLength(a)+byteLength(b)` 이면 거부 (서로게이트 결합 방지)
3. `sourceSegments` 오프셋 재배치 (`:251-258`, `:297-319`) — `byteStart`/`byteEnd` 를 `existingOutputBytes` 만큼 밀어준다
4. **`createWsTransportMessage` 로 JSON 을 처음부터 다시 만든다** (`:263-278`)

즉 현재도 "두 프레임을 이어붙이는" 것이 아니라 **payload(=`data` 문자열)를 병합하고 봉투를 새로 만드는** 것이다.

### 4.2 [설계결정] 바이너리에서는 **payload 병합**

| 방식 | 내용 | 판정 |
|---|---|---|
| **프레임 병합** | 두 완성 프레임을 이어붙여 1회 `ws.send` | ❌ 두 개의 21B 헤더가 남아 실제로는 2 프레임이다. 클라이언트가 한 WebSocket 메시지 안에서 프레임을 순차 파싱해야 하므로 **프레임 스트리밍 파서**가 새로 필요하고, `byteLength` 도 두 헤더를 포함해야 해서 회계가 복잡해진다 |
| **payload 병합** | 헤더 1개 + `concat(payloadA, payloadB)`, `length` = 합, `sourceSeq` = A 의 것 | ✅ 현재 의미론과 **정확히 1:1 대응**. 회계도 `21 + (a+b)` 로 단순 |

**payload 병합 시 각 단계의 변화**

| 단계 | 변화 |
|---|---|
| 1. 판정 조건 | `hasFairDeliveryIdentity`(`:288`)의 `JSON.parse` 제거 → §2.2 의 사이드카 필드 읽기로 교체. **나머지 조건은 그대로** |
| 2. UTF-8 경계 검증 | **불필요해진다.** payload 가 이미 바이트면 연결은 항상 길이를 보존한다. 오히려 서버가 `Buffer.from(data,'utf8')` 로 재인코딩하므로 완전한 시퀀스가 보장됨. 단 이 검사를 **삭제**하면 JSON 경로의 보호가 함께 사라지므로 `encoding` 분기로 남겨야 한다 |
| 3. `sourceSegments` | ⚠️ **미해결.** 프레임 초안에 자리가 없다 (§4.3) |
| 4. 재직렬화 | JSON 재생성이 사라지고 `Buffer.concat` 1회로 대체 — **coalescing 의 CPU 비용이 크게 준다** |

### 4.3 ⚠️ `sourceSegments` 가 프레임 초안에 들어가지 않는다

`WsOutputSourceSegment`(`wsSendPolicy.ts:5-12`)는 `byteStart`/`byteEnd`/`screenSeq`/`authorityEpoch`/`authorityRevision`/`chunkId` 를 담고, 병합된 출력 안에서 **어느 바이트 구간이 어느 authority 세대에서 왔는지**를 클라이언트에 알린다. 프레임 초안 `[opcode][channelId][streamEpoch][sourceSeq][length][payload]` 에는 자리가 없다.

선택지:

| 안 | 내용 | 평가 |
|---|---|---|
| **(a) `sourceSegments` 를 가진 output 은 coalesce 금지** | `materializeOutputSourceSegments`(`:297-319`)가 이미 `null` 반환 시 거부하는 경로가 있음 — 조건만 넓히면 됨 | ✅ **1단계 권고.** 최소 변경, 정확성 보존. 병합률 하락은 측정으로 확인 |
| (b) opcode variant + TLV 확장 헤더 | `opcode` 로 "segments 포함 프레임"을 구분하고 헤더 뒤에 segment 배열 | 2단계. 프레임 초안 확장이 필요하므로 계약 재합의 대상 |
| (c) control 평면 JSON 으로 segment 메타 별송 | 두 평면 간 순서 결합 발생 | ❌ HOL 분리라는 목적 자체를 훼손 |

`AC-4`(`docs/spec/30.buildergate-stability.srs.md:1341`)는 "adjacent output messages belong to the same session and remain within configured byte limits" 를 요구할 뿐 병합 **방식**을 규정하지 않는다. 따라서 payload 병합은 AC-4 를 만족한다. 다만 (a) 채택 시 **병합 가능 범위가 좁아지므로** AC-4 의 "may be coalesced" 해석 범위를 SRS 에 명시하는 편이 안전하다.

### 4.4 관련 코드 지점

| file:line | 내용 |
|---|---|
| `wsSendPolicy.ts:216-279` | `tryCoalesceOutputMessage` 본체 |
| `wsSendPolicy.ts:281-284` | `hasRecoveryIdentity` — 변경 불필요 |
| `wsSendPolicy.ts:286-295` | `hasFairDeliveryIdentity` — **JSON.parse 제거 필수** |
| `wsSendPolicy.ts:297-319` | `materializeOutputSourceSegments` — (a) 채택 시 확장 지점 |
| `wsSendPolicy.ts:321-361` | `readOutputSourceSegments` — JSON 입력 파서. 바이너리 경로에서는 호출되지 않음 |
| `WsRouter.ts:6163-6180` | 유일한 프로덕션 호출부 + `outputBytes` 재계산 |
| `WsRouter.ts:6767` | `sendNonCoalescingOutputChunk` 의 `outputData = undefined` — coalesce 차단 관용구. 바이너리에서도 동일 관용구가 필요 |
| `services/TerminalResourcePolicyInventory.ts:86` | `consumerSymbol: 'tryCoalesceOutputMessage'`, `evidenceSignature: 'incoming.queuedAt - existing.queuedAt > coalesceWindowMs'` — **문자열 카탈로그**. 구현식이 바뀌면 갱신 필요 |

---

## 5. checkpoint / snapshot base64 제거

### 5.1 현황

| file:line | 사실 |
|---|---|
| `server/src/types/ws-protocol.ts:75-79` | `TerminalCheckpointEncodedPayload { encoding:'base64'; data:string; encodedBytes:number }` — 유일한 base64 컨테이너. `encodedBytes` 는 **디코딩 후 원본 바이트 수** |
| `ws-protocol.ts:88` | `terminal-checkpoint:start.parserTail` |
| `ws-protocol.ts:96-101` | `terminal-checkpoint:chunk` — 메시지 본문이 곧 base64 |
| `ws-protocol.ts:111-114` | **`terminal-checkpoint:output` — 라이브 출력 프레임 1건 1건이 base64.** hot path |
| `ws-protocol.ts:286-302` | `fresh-checkpoint-required.fullCheckpoint.chunks[]` / `parserTail` |
| `TerminalAuthorityProductionAdapter.ts:870-881` | `encodeCheckpointPayload(data: string)` — `:875` `Buffer.from(data,'utf8')`, `:878` `.toString('base64')` |
| `TerminalAuthorityProductionAdapter.ts:883-902` | `encodeCheckpointChunks` — `:888` Buffer 화, `:893-894` 64KiB subarray, `:897` base64 |
| `TerminalAuthorityProductionAdapter.ts:298` | `TERMINAL_CHECKPOINT_CHUNK_BYTES = 64 * 1024` (디코딩 후 기준) |
| `TerminalAuthorityProductionAdapter.ts:1563-1570` | 라이브 출력 프레임 조립 — `record.data`(PTY 문자열)를 프레임마다 인코딩 |
| `TerminalAuthorityProductionAdapter.ts:1655-1657` | checkpoint 본문 = `retained.checkpoint.serializedData` |
| `utils/headlessTerminal.ts:301-308` | ⚠️ 그 `serializedData` 의 정체는 **SerializeAddon 이 뱉은 ANSI escape 포함 UTF-8 텍스트** — 바이너리가 아니다. **base64 는 순수 오버헤드** |
| `TerminalAuthorityProductionAdapter.ts:3229, 3249, 3257, 3295` | fresh-checkpoint 재조립 — `encoding === 'base64'` 검증 후 pass-through |
| `frontend/src/utils/terminalCheckpointRuntime.ts:408-418` | `atob` + **바이트당 1회 `charCodeAt` 루프**로 `Uint8Array` 생성 |
| `frontend/src/types/ws-protocol.ts:1021-1028`, `:1236-1240` | 디코딩 전 O(n) 정규식 검증 + 길이 대조 |

### 5.2 절감량 추정 [추정]

전제: base64 = 원본의 4/3 배(ASCII 이므로 JSON/UTF-8 에서 팽창 없음). 바이너리 프레임 = 원본 + 21B.

| 대상 | 현재 wire | 바이너리 wire | 절감 |
|---|---|---|---|
| checkpoint chunk (원본 64 KiB) | base64 87,384 B + JSON 봉투 ≈ 300 B ≈ **87,684 B** | 65,536 + 21 = **65,557 B** | **≈ 25.2 %** |
| 2 MiB snapshot 전체 (32 chunk) | ≈ **2.80 MiB** | ≈ **2.00 MiB** | **≈ 0.80 MiB (28.6 %)** |
| 라이브 output 청크 100 B | base64 136 B + 봉투 ≈ 300 B ≈ **436 B** | 100 + 21 = **121 B** | **≈ 72 %** |
| 라이브 output 청크 40 B (프롬프트 재출력) | ≈ **356 B** | **61 B** | **≈ 83 %** |

**핵심**: 큰 blob 에서는 base64 제거(25 %)가, 작고 잦은 라이브 프레임에서는 **JSON 봉투 제거(70~85 %)**가 지배적이다. 후자가 터미널 체감 성능의 hot path다.

CPU 측면 부수 이득:
- 서버: `bytes.toString('base64')`(`:878`, `:897`) 제거, 그리고 `wsSendPolicy.ts:598-611` 의 **회계 전용 JSON 생성** 제거
- 프론트: `atob` + 바이트당 루프(`terminalCheckpointRuntime.ts:413-417`) 제거, 디코딩 전 정규식 O(n) 스캔(`ws-protocol.ts:1021-1028`) 제거

### 5.3 손대야 할 지점과 함정

| file:line | 필요 변경 | 함정 |
|---|---|---|
| `TerminalAuthorityProductionAdapter.ts:870-881, 883-902` | base64 인코딩 제거, Buffer 를 그대로 프레임 payload 로 | `encodedBytes` 의 의미는 그대로(원본 바이트) — 프레임 `length` 와 동일해짐 |
| `TerminalAuthorityProductionAdapter.ts:1563-1570` | 라이브 프레임을 바이너리 프레임으로 | `...activeCheckpoint` 스프레드의 메타(connectionId·viewGeneration·sourceSeq 등)가 프레임 헤더에 안 들어간다 → **하이브리드 필요** |
| **`TerminalAuthorityProductionAdapter.ts:1740-1750`** | `retainedStateDigest` 가 **`parserTail.data`(= base64 문자열)** 를 digest 입력에 포함 | ⚠️ 인코딩을 바꾸면 **digest 정의가 바뀐다.** 구/신 클라이언트가 서로 다른 digest 를 계산 → 호환성 파단면. digest 입력을 원본 바이트로 재정의해야 하며 이는 계약 변경 |
| `TerminalAuthorityProductionAdapter.ts:1659` | checkpoint digest 는 **원본 문자열** 기준 (`createHash('sha256').update(data,'utf8')`) | ✅ 무관. 그대로 성립 |
| `ws-protocol.ts:75-79, 88, 96-101, 111-114, 286-302` | `encoding` 을 `'base64' \| 'binary-frame'` 유니온으로 | 프론트 미러(`frontend/src/types/ws-protocol.ts:78, 287`)와 서버 내부 미러(`WsRouter.ts:457, 462`) 3벌을 동시에 |
| `TerminalAuthorityProductionAdapter.ts:3229-3295` | `encoding === 'base64'` 하드코딩 검증 4곳 | pass-through 경로이므로 유니온 대응만 |
| `WsRouter.ts:4920-4940` (`screen-snapshot`) | ⚠️ **base64 아님 — raw ANSI string** (`ws-protocol.ts:596-616`, `data: string`, `encoding` 필드 없음) | 절감원이 base64 가 아니라 **JSON 문자열 이스케이프**다. ESC 문자가 ``(6B)로 팽창하므로 ANSI heavy snapshot 에서는 base64 보다 나쁠 수 있다 [추정]. 바이너리 body 로 옮기면 둘 다 이긴다 |
| `WsRouter.ts:3223-3230` (`screen-repair`) | `ansiPatch: string` raw | 동일 |

**[설계결정] snapshot/checkpoint 는 하이브리드 프레임으로**
`screen-snapshot` 은 `seq`/`cols`/`rows`/`mode`/`truncated`/`fallbackDataState`/`windowsPty`/`authorityEpoch`/`authorityRevision`/`coversThroughSeq`/`supersedesReplayToken`/`parserComplete`/`pendingEscapeTailAnsi` 등 **10개 이상의 메타**를 함께 나른다(`WsRouter.ts:4920-4940`). 21B 헤더에 담을 수 없다.
→ control 평면 JSON 으로 메타 헤더를 먼저 보내고(`replayToken` 으로 결속), 본문은 바이너리 프레임으로 뒤따르게 한다. **순서 보장은 `terminal-control` kind 가 이미 제공**한다(`wsSendPolicy.ts:478-486` `isTerminalOrderedControlMessage` 가 `screen-snapshot`/`screen-repair`/`session:ready`/`subscribed` 를 terminal lane 으로 분류). 단 control 평면과 output 평면이 **다른 소켓**일 수 있으므로(split 모드) 결속이 깨진다 — split 모드에서는 두 프레임을 같은 lane 으로 보내야 한다. [미확인] split 활성 시의 정확한 순서 보장 범위는 별도 검증 필요.

### 5.4 [미확인] `fullCheckpoint` 는 dead payload 일 수 있다

`frontend/src/types/ws-protocol.ts:287` 에 타입은 있으나 `frontend/src` 어디에서도 `fullCheckpoint.chunks` 를 디코딩하지 않는다. 서버는 `WsRouter.ts:5090-5093` 에서 이를 보낸다. 소비처가 없다면 **base64 전체를 헛되이 나르고 있는 것**이며, 바이너리 전환 이전에 삭제 후보 판정이 필요하다. `[미확인]` — 프론트 전수 grep 결과이므로 동적 접근 가능성은 배제하지 못했다.

---

## 6. 수신 경로

### 6.1 현황

| file:line | 내용 |
|---|---|
| `WsRouter.ts:1638-1644` (output 소켓), `:1718-1724` (control 소켓) | `ws.on('message', (raw: Buffer \| string) => ...)` — **`isBinary` 인자를 아예 선언하지 않는다** |
| `WsRouter.ts:1742-1749` | `handleMessage` — `JSON.parse(typeof raw === 'string' ? raw : raw.toString())`. 실패 시 `console.warn('[WS] Invalid JSON received')` 후 **조용히 return** |
| `WsRouter.ts:1751-1754` | shape 검증 실패도 동일하게 조용히 return |
| `WsRouter.ts:2534-2549` | `handleMessageError` — 핸들러 예외 시에만 `session:error` 회신 |
| `WsRouter.ts:2551-2557` | `tryParseRawMessage` — 동일 패턴 |

⚠️ **현재 상태는 결정 기록 §3 "해석 불가 프레임의 silent drop 금지" 를 이미 위반한다.** 클라이언트가 바이너리 프레임을 보내면 `raw.toString()` 이 UTF-8 로 해석 → `JSON.parse` 실패 → 로그 한 줄 남기고 사라진다. 클라이언트는 자기 메시지가 버려진 줄 모른다.

`[미확인]` `ws` v8 기본 `binaryType` 이 `'nodebuffer'` 이므로 **텍스트 프레임도 Buffer 로 도착**한다. 따라서 `typeof raw === 'string'` 분기(`:1745`, `:2553`)는 사실상 죽은 코드일 가능성이 높다. 실측 필요.

### 6.2 [설계결정] 입력은 바이너리화하지 않는다 (1단계)

근거:

1. **용량**: 키 입력은 청크당 1~수십 바이트, 빈도는 인간 타이핑 속도. JSON 봉투 오버헤드가 절대량으로 무의미하다.
2. **`terminal-delivery:ack` 는 예외 후보**다. `deliverySeq` 당 1회이므로 output 프레임 수에 비례한다. 그러나 ACK 는 **control 평면**이고, control 평면 JSON 유지는 결정 기록 §1 의 확정 사항이다. 바이너리 ACK 는 2단계 측정 후 별도 판단.
3. **`PERF-BGSTAB-009 AC-7`**("Production ingress 는 string 을 유지 … binary WebSocket 을 변경하지 않는다", evolving)이 이 방향과 정합한다. 개정 없이 진행 가능.
4. 입력 경로에는 `query-reply` 검증(`WsRouter.ts:346-399`)처럼 문자열 기반 정합성 검사가 촘촘하다. 바이너리화하면 그 표면 전체를 다시 만들어야 한다.

### 6.3 `isBinary` 최소 변경안

목표는 "입력을 바이너리로 받기"가 아니라 **"바이너리가 오면 조용히 버리지 않기"** 다 (결정 기록 §3 이행).

```
// WsRouter.ts:1638 / :1718  — 리스너 시그니처 확장
ws.on('message', (raw: Buffer | string, isBinary: boolean) => {
  try { this.handleMessage(ws, raw, isBinary); }
  catch (error) { this.handleMessageError(ws, raw, error); }
});

// WsRouter.ts:1742  — handleMessage 선두에 명시적 거절 분기
private handleMessage(ws: WebSocket, raw: Buffer | string, isBinary = false): void {
  if (isBinary) {
    this.sendPriorityControl(ws, {
      type: 'protocol-error',
      code: 'binary-ingress-unsupported',
      // control 평면 JSON 이므로 sendPriorityControl 로 즉시 나간다
    });
    return;
  }
  ...
}

// WsRouter.ts:1746 / :1751  — 기존 silent return 도 동일하게 명시적 회신으로 승격
```

- 난이도 **S**. 호출부는 2곳(`:1640`, `:1720`)뿐이고 `handleMessage` 는 private.
- `handleMessageError`(`:2534`) / `tryParseRawMessage`(`:2551`)도 같은 시그니처 확장이 필요하다(바이너리 raw 에 `JSON.parse` 를 다시 시도하지 않도록).
- 신규 `protocol-error` 메시지 타입은 `server/src/types/ws-protocol.ts` 와 프론트 미러에 추가해야 하며, **`ClientWsMessage`/서버 메시지 유니온 확장**이므로 SRS 요구가 선행한다.
- ⚠️ 이 변경 자체가 **동작 변경**이다. TDD 대상 — "바이너리 프레임 수신 시 `protocol-error` 를 회신한다"는 실패 테스트를 먼저 쓴다.

---

## 7. 설정 표면

### 7.1 현황

| file:line | 사실 |
|---|---|
| `server/src/schemas/config.schema.ts:55-57` | `realtimeSchema = defaultObject(z.object({ wsTransportMode: z.enum(['unified','split-shadow','split']).default('unified') }).strict())` — **`.strict()` 이므로 키 추가에 스키마 수정이 필수** |
| `config.schema.ts:52-53` | `defaultObject()` — `undefined` → `{}` preprocess. `realtime` 블록이 없어도 기본값 적용 |
| `config.schema.ts:290` | `configSchema` 에서 `realtime` 은 필수(optional 아님) |
| `server/config.json5` | **`realtime` 블록 자체가 없다** → 현재 배포는 `unified` |
| `server/config.json5.example:66-71`, `server/src/utils/configTemplate.ts:47-49` | 템플릿에는 `wsTransportMode: "unified"` 명시 |
| `services/RuntimeConfigStore.ts:249`, `:1254` | 읽기 + reload 재적용, 기본값 상수 `:158` |
| `index.ts:1529-1535` | `configuredWsTransportMode === 'split' ? 'split' : 'unified'` — **`split-shadow` 를 `unified` 로 접는다** |
| `ws/wsTransportMode.ts:44-50` | `configuredMode === 'unified'` 이면 split 요청을 400 `split-disabled` 로 거절 |
| `WsRouter.ts:606, 1542-1545, 1574, 1611, 1625, 1674, 1702` + `:701, 849, 1106, 1120, 1133, 2218` | 핸드셰이크 파싱 + lane 분기 |
| `frontend/src/utils/webSocketUrl.ts:70` | `metadata.wsTransportMode !== 'split'` 으로 output 소켓 생성 여부 분기 |
| `frontend/src/utils/inputReliabilityMode.ts:383-392` | 미지원 값은 조용히 `'unified'` 폴백 |

### 7.2 [설계결정] enum 확장이 아니라 **별도 축**

| 안 | 평가 |
|---|---|
| `wsTransportMode` enum 확장 (`unified-binary` 등) | ❌ **조합 폭발** — 토폴로지 3종 × 인코딩 2종 = 6값. 그리고 `webSocketUrl.ts:70`(`!== 'split'`), `index.ts:1535`(`=== 'split' ? ... : 'unified'`), `wsTransportMode.ts:44-50`(split-disabled), `inputReliabilityMode.ts:383-392` 의 **모든 비교식이 재작성 대상**이 된다. `FR-BGSTAB-001 AC-3`(**stable**) 개정도 필요 |
| **별도 축 `realtime.dataPlaneEncoding: 'json' \| 'binary'` (기본 `'json'`)** | ✅ 토폴로지(어느 소켓으로)와 인코딩(무슨 형식으로)은 **직교 관심사**다. `FR-BGSTAB-001 AC-3` 을 건드리지 않고, 기본값 `'json'` 이면 `realtime` 블록 없는 현행 `config.json5` 가 그대로 동작 → `FR-BGSTAB-008 AC-1` legacy-absent baseline recovery 유지 |

**⚠️ 그러나 설정만으로 켜서는 안 된다.** 클라이언트가 프레임을 못 읽으면 화면이 깨진다. 실제 활성화는 **capability 협상**이어야 하고, 설정은 서버 측 허용 상한(kill switch)으로만 쓴다. 선례가 이미 있다 — fair scheduler 는 설정 플래그가 아니라 `terminal-delivery:capability` 협상으로 켜진다(`WsRouter.ts:1931-1968`, 거절 3경로). 같은 패턴을 따르면 새 아키텍처를 만들 필요가 없다(§10.2 준수).

즉:
- `dataPlaneEncoding: 'json'` → capability 협상 자체를 제안하지 않는다 (kill switch)
- `dataPlaneEncoding: 'binary'` → 협상을 제안하고, 클라이언트가 수락한 소켓만 바이너리. 거절/미지원은 JSON 경로(`WsRouter.ts:5159-5167`)로 자연 폴백

### 7.3 `/api/runtime-config` 공개 투영 반영 지점 (FR-BGSTAB-008 AC-5)

| file:line | 필요 변경 |
|---|---|
| `server/src/index.ts:530-532` | 라우트 자체는 변경 없음 (`getPublicRuntimeConfig` 위임) |
| **`services/RuntimeConfigStore.ts:160-165`** | `PublicRuntimeConfig` 인터페이스에 `dataPlaneEncoding: DataPlaneEncoding` 추가 — **허용목록 SSOT #1** |
| **`services/RuntimeConfigStore.ts:274-288`** | `getPublicRuntimeConfig()` 객체 literal 에 필드 추가 — **허용목록 SSOT #2** (deny-by-default 방식이라 명시하지 않으면 노출되지 않는다) |
| `services/RuntimeConfigStore.ts:249`, `:1254`, `:158` | 읽기·reload·기본값 상수 |
| `types/config.types.ts:76` 인근 | 타입 선언 |
| `schemas/config.schema.ts:55-57` | `realtimeSchema` 에 키 추가 (`.strict()` 때문에 필수) |
| `utils/configTemplate.ts:47-49`, `config.json5.example:66-71` | 템플릿에 기본값 기록 |
| `frontend/src/utils/inputReliabilityMode.ts:50-62`, `:383-392` 패턴 | 대응 파서 + 미지원 값 `'json'` 폴백 |

**회귀 게이트 (자동으로 깨진다 — 이것이 안전장치)**

| file:line | 왜 깨지는가 |
|---|---|
| `services/RuntimeConfigStore.test.ts:129-131` | `assert.deepEqual` 로 **public payload 전체 형태를 고정**한다. 키를 추가하면 반드시 red |
| `services/TerminalResourcePolicy.test.ts:507` | public projection 을 **JSON 문자열 동등**으로 비교 |
| `frontend/tests/unit/runtimeConfig.test.ts:281` | 모든 public resource limit 섹션 파싱 |
| `frontend/tests/unit/runtimeConfig.test.ts:591`, `:607` | 미지원 값 폴백 / 지원 값 수용 — 같은 패턴을 `dataPlaneEncoding` 에 복제 |

**SRS 개정 필요**: `docs/spec/30.buildergate-stability.srs.md:580` 의 `FR-BGSTAB-008 AC-5` 가 노출 키를 **열거**한다("inputReliabilityMode, wsTransportMode, browser-needed resourceLimits sections, and frontendRuntimeResidency mode"). 키 추가 시 이 문장 개정이 선행해야 한다. `Stability=stable` 이므로 변경 관리 절차 대상.

`[미확인]` `/api/runtime-config` **HTTP 라우트 자체**(무인증·헤더·상태코드)를 때리는 서버측 focused 테스트가 `server/src` 전체 grep 에서 발견되지 않았다. 서버 커버리지는 `getPublicRuntimeConfig()` 단위 테스트뿐이고 라우트 결선은 E2E 만 커버한다.

---

## 8. 마스터 변경 지점 표

난이도: **S** = 단일 함수 국소 변경 · **M** = 여러 호출부 + 테스트 동반 · **L** = 계약/벤치마크/증거 재발행 동반

### 8.1 선행 리팩터 (JSON 상태에서 먼저 — 바이너리와 무관하게 정당한 개선)

| file:line | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| `wsSendPolicy.ts:14-43` | `WsTransportMessage` 에 fair-delivery 정체성 필드 없음 | `connectionEpoch`/`deliverySeq`/`deliveryKind` 사이드카 추가 | S | 낮음 |
| `wsSendPolicy.ts:80-125` | `createWsTransportMessage` 스프레드 | 위 3필드 채우기 | S | 낮음 |
| `wsSendPolicy.ts:286-295` | `JSON.parse(payload)` 로 coalesce 차단 판정. **실패 시 `true`** | 사이드카 필드 읽기 | S | **중** — 실패 방향이 바뀌면 coalesce 정책이 조용히 달라진다. 병합률을 전후 비교할 것 |
| `WsRouter.ts:5535`, `:5564` | `JSON.parse(payload)` 로 큐 폐기 대상 판정 | 사이드카 필드 읽기 | S | 중 — 큐 정리 실패는 조용하다. 폐기 건수 로그로 대조 |
| `WsRouter.ts:6396` | `JSON.parse(payload)` 로 fair-delivery 판별 | 사이드카 필드 읽기 | S | **높음** — 오판 시 `safe-send-enforce` 에서 클라이언트 강제 종료 |
| `WsRouter.ts:1638`, `:1718`, `:1742` | `isBinary` 미사용, 파싱 실패 silent drop | `isBinary` 수용 + 명시적 `protocol-error` 회신 | S | 낮음. **단 동작 변경 → TDD 대상** |
| `benchmarks/terminalFairnessCharacterization.ts:1093` | `creditPayload.length` (UTF-16) | 바이트 기준 정정 | S | **높음** — 벤치마크 수치가 바뀌어 §9.1 재발행 유발 |
| `FairTerminalDeliveryScheduler.test.ts:7-23` | 타입 로컬 재선언 | 실제 타입 import | S | 낮음. **하지 않으면 이후 모든 타입 변경이 조용히 통과** |

### 8.2 타입 확장

| file:line | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| `wsSendPolicy.ts:16-17` | `payload: string` / `byteLength: number` | `payload: string \| Uint8Array` + `encoding: 'json' \| 'binary'` **필수** | M | 중 — 필수 필드라 모든 픽스처가 컴파일 에러(의도된 게이트) |
| `wsSendPolicy.ts:91, 95` | `JSON.stringify` + `Buffer.byteLength` | `encoding` 분기, 바이너리는 `21 + bytes.byteLength` | M | 중 |
| `wsSendPolicy.ts:499, 511` | `FairTerminalDeliveryInput.payload: string` | 동일 확장 | M | 중 |
| `wsSendPolicy.ts:598-611` | 회계 위해 JSON 생성 후 폐기 | 프레임 크기 산술로 대체 | S | **높음** — `encodedBytes` 는 credit/deficit/queue 예산의 기반. 값이 바뀌면 §3.4 재벤치 |
| `WsRouter.ts:1383, 1405, 1413, 1425` | `Buffer.byteLength(payload,'utf8')` tamper 검사 | `encoding` 별 재계산. **TypedArray 는 인코딩 인자를 무시하므로 검사가 vacuous 해진 것을 런타임 shape 단언으로 고정** | M | **높음** — 조용히 무의미해지는 대표 사례 |
| `WsRouter.ts:1474` | `{...incomingMessage}` 얕은 복사 | Uint8Array aliasing 금지 명시(프레임 버퍼 재사용 금지) | S | 중 |
| `WsRouter.ts:6268` | `ws.send(message.payload, cb)` | `ws.send` 는 Buffer/TypedArray 를 그대로 수용 → **호출부 무변경**. 단 `{ binary: true }` 옵션 명시 필요 여부 확인 | S | 낮음 |
| MockWebSocket `send()` 시그니처 4곳 | `payload: string` | `string \| Buffer` (`TerminalAuthorityController.test.ts:581` 은 이미 대응) | S | 낮음 |
| `tools/wave3/terminal-resource-policy-differential.ts:109-120, 211` | `Buffer.from(payload)` 인코딩 인자 없음 | 명시적 인코딩 + 픽스처 갱신 | M | **높음** — differential 증거 해시가 조용히 달라진다 |

### 8.3 데이터 평면 프레임화

| file:line | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| (신규) 프레임 인코더/디코더 | 없음 | `[opcode][channelId][streamEpoch][sourceSeq][length][payload]` 조립·해체. **`wsSendPolicy.ts` 밖의 새 모듈**로 두어 provenance 핀 파일 변경을 최소화 | M | 중 |
| (신규) channelId 매핑 | 없음 — sessionId 는 UUID 문자열 | sessionId ↔ uint32 채널 등록부 + control 평면 통지. `WsClientMeta`(`types/ws-protocol.ts:814` 인근) 확장 | M | **높음** — 매핑 누락 시 프레임이 엉뚱한 세션으로 간다. reconnect·epoch 회전 시 재발급 규칙 필요 |
| (신규) `streamEpoch` 4B 폭 | 현재 canonical unsigned **decimal string (uint64)** — `WsRouter.ts:302-309` `isCanonicalAuthorityOrdinal` 이 `≤ 2^64-1` 검증 | ⚠️ **4B 로는 표현 불가**. 프레임 초안 재검토 또는 별도 epoch 축약 테이블 | M | **높음** — `REL-BGSTAB-007 AC-4`(**stable**)가 Ordinal64 의 JSON 표현을 고정. 개정 대상 |
| (신규) `sourceSeq` 8B | 동일하게 canonical decimal string | BigInt ↔ 8B 변환 | S | 중 — JS number 정밀도(2^53) 초과 구간 처리 |
| `SessionManager.ts:1353` | `onData((rawData: string))` | 프레임 payload 용 `Buffer.from(data,'utf8')` 재인코딩 지점 결정 | S | 중 — 어디서 인코딩할지가 곧 어디까지 문자열로 다루는지의 경계 |
| `WsRouter.ts:5143-5156` | `payload: data`(string) | 바이트로 | S | 중 |
| `WsRouter.ts:5842-5875` | `data: delivery.payload` 로 JSON 조립 | 프레임 조립기 호출. `deliverySeq`/`connectionEpoch`/`deliveryKind` 는 사이드카로 | M | **높음** — 스케줄러 출구는 fair delivery 계약의 관측 지점 |
| `WsRouter.ts:5099-5121`, `:5846` | dataGap `JSON.stringify`→`JSON.parse` 왕복 | **JSON 유지.** 단 scheduler `payload` 유니온에서 문자열 분기 보장 | S | 낮음 |
| `WsRouter.ts:5159-5167`, `:5130-5141` | 직접 전송 | **JSON 유지**(capability 미협상 폴백 경로) | — | — |
| `WsRouter.ts:6740-6769` | non-coalescing recovery tail | **1단계 JSON 유지** (repairToken/replayToken 자리 없음) | — | — |

### 8.4 coalescing

| file:line | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| `wsSendPolicy.ts:244-249` | UTF-8 경계 길이 보존 검증 | `encoding` 분기 — 바이너리는 불필요, JSON 경로는 유지 | S | 낮음 |
| `wsSendPolicy.ts:251-258, 297-319` | `sourceSegments` 오프셋 재배치 | **1단계: segments 보유 output 은 coalesce 금지** | M | 중 — 병합률 하락. 전후 `transportOutputCoalesceCount`(`WsRouter.ts:6176`) 비교 필수 |
| `wsSendPolicy.ts:263-278` | `createWsTransportMessage` 로 JSON 재생성 | `Buffer.concat` 1회 | S | 낮음 (CPU 이득) |
| `services/TerminalResourcePolicyInventory.ts:86` | `evidenceSignature` 문자열 카탈로그 | 구현식 변경 시 갱신 | S | 중 — 갱신 누락 시 consumer manifest 게이트가 red |

### 8.5 base64 제거

| file:line | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| `TerminalAuthorityProductionAdapter.ts:870-881, 883-902` | `toString('base64')` | 제거, Buffer 그대로 | S | 중 |
| `TerminalAuthorityProductionAdapter.ts:1563-1570` | 라이브 프레임 base64 | 바이너리 프레임 + 메타 하이브리드 | M | **높음** — hot path |
| **`TerminalAuthorityProductionAdapter.ts:1740-1750`** | `retainedStateDigest` 입력에 **base64 문자열** 포함 | digest 정의를 원본 바이트로 재정의 | M | **높음** — 계약 파단면. 구/신 클라이언트 digest 불일치 |
| `TerminalAuthorityProductionAdapter.ts:1659` | checkpoint digest = 원본 문자열 | 변경 없음 | — | — |
| `TerminalAuthorityProductionAdapter.ts:3229, 3249, 3257, 3295` | `encoding === 'base64'` 4곳 | 유니온 대응 | S | 낮음 |
| `types/ws-protocol.ts:75-79, 88, 96-101, 111-114, 286-302` | `encoding: 'base64'` 고정 | 유니온 확장 | M | 중 — 프론트 미러 2곳 동시 |
| `WsRouter.ts:457, 462` | 서버 내부 `fullCheckpoint` 미러 | 동일 | S | 낮음 |
| `WsRouter.ts:4920-4940`, `:3223-3230` | snapshot/repair raw string | 하이브리드 프레임 | **L** | **높음** — split 모드에서 메타·본문 결속 [미확인] |
| `TerminalAuthorityProductionAdapter.ts:298` | `TERMINAL_CHECKPOINT_CHUNK_BYTES = 65536` | 유지 (원본 기준이므로 의미 불변) | — | — |

### 8.6 설정

| file:line | 현재 동작 | 필요한 변경 | 난이도 | 위험 |
|---|---|---|---|---|
| `schemas/config.schema.ts:55-57` | `realtime` 에 `wsTransportMode` 만, `.strict()` | `dataPlaneEncoding: z.enum(['json','binary']).default('json')` 추가 | S | 낮음 |
| `services/RuntimeConfigStore.ts:160-165` | `PublicRuntimeConfig` 타입 | 키 추가 (허용목록 SSOT #1) | S | 중 |
| `services/RuntimeConfigStore.ts:274-288` | 투영 구현 | 키 추가 (허용목록 SSOT #2) | S | 중 |
| `services/RuntimeConfigStore.ts:158, 249, 1254` | 기본값·읽기·reload | 대응 추가 | S | 낮음 |
| `types/config.types.ts:76` 인근 | 타입 | 추가 | S | 낮음 |
| `utils/configTemplate.ts:47-49`, `config.json5.example:66-71` | 템플릿 | 기본값 기록 | S | 낮음 |
| (신규) capability 협상 | `terminal-delivery:capability` 패턴 (`WsRouter.ts:1931-1968`) | `terminal-encoding:capability` 신설. **새 아키텍처 만들지 말고 기존 패턴 확장** | M | 중 |
| `docs/spec/30.buildergate-stability.srs.md:580` | AC-5 가 노출 키 열거 | SRS 개정 (**Stability=stable**) | M | 중 |

---

## 9. 이 전환이 유발하는 저장소 부수효과

### 9.1 ⚠️ provenance 핀 — 작업 순서가 강제된다

`server/tools/write-fair-scheduler-source-provenance.mjs:7-14` 가 다음 6개 파일의 sha256 을 매니페스트로 굳힌다.

```
src/benchmarks/terminalFairnessCharacterization.ts
src/benchmarks/fairSchedulerAuthorityLocator.ts
src/ws/wsSendPolicy.ts          ← 이 작업의 핵심 파일
src/ws/WsRouter.ts              ← 이 작업의 핵심 파일
src/services/TerminalResourcePolicy.ts
src/services/TerminalResourcePolicyCanary.ts
```

- 이 스크립트는 **build 파이프라인의 일부**다 (`tsc` → `write-fair-scheduler-source-provenance.mjs` → `write-fair-scheduler-evidence-bundle.mjs`).
- 발행된 decision artifact 는 `sourceDigest` 를 고정값으로 담고 있다 — `docs/analysis/terminal-fairness-authority/generations/0f98a045…/fair-scheduler-decision.json` 의 `sourceDigest = d995e30c…`.
- `benchmarks/terminalFairnessCharacterization.test.ts:203` 이 `getFairSchedulerBenchmarkSourceDigest() === artifact.sourceDigest` 를 단언한다.

**따라서 `wsSendPolicy.ts` / `WsRouter.ts` 를 한 글자라도 고치면 digest 가 바뀌고 이 단언이 red 가 된다.** 저장된 절차(코드 커밋 → republish → 증거 커밋)를 따라야 하며, provenance 는 워킹트리가 아니라 커밋된 상태를 기준으로 판단하는 지점이 있으므로 **커밋 순서를 지키지 않으면 무한 루프에 빠진다.**

또한 CLAUDE.md 가 경고하듯 evidence-bundle 이 `docs/analysis/terminal-fairness-authority/` 의 sha256 매니페스트를 재검증하고 불일치 시 throw → **build 실패** → build 를 타는 명령(루트 build 스크립트 18개, `npm --prefix server test`, `npm run test:daemon`, `npx playwright test`, `start.bat`, CI)이 **전부** 깨진다. 테스트가 깨졌다고 진단하기 전에 build 로그를 먼저 볼 것.

**[설계결정] 완화책**: 프레임 인코더/디코더를 `wsSendPolicy.ts` **안이 아니라 새 모듈**(예: `server/src/ws/binaryFrame.ts`)에 두면, 핀 파일의 변경 폭을 "타입 확장 + 분기 호출" 수준으로 줄일 수 있다. 재발행 자체는 피할 수 없지만 diff 검토 비용이 크게 준다.

### 9.2 §3.4 재벤치의 실제 절차

`terminalFairnessCharacterization.ts` 는 프로덕션 파일과 같은 핀 목록에 있다. 임계값 재튜닝은 다음을 동반한다.

1. 벤치마크 실행 (`tools/wave3/fair-scheduler-decision.test.mjs` 는 테스트가 아니라 벤치마크 소스를 실행한다 — 고정 워크로드 `--clients 1,2,8 --wan-latency-ms 150 --seed 20260723 --repeats 5 --samples 30`)
2. `docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json` 및 canonical authority 재발행
3. `raw/manifest.json` 의 trial 인벤토리(15 경로 / 1650 샘플, `fair-scheduler-decision.test.mjs:61, 65`) 재생성

### 9.3 회귀 스위트 — 한 명령으로 끝나지 않는다

이 변경이 건드리는 표면은 CLAUDE.md 가 열거한 **모든** 스위트에 걸친다.

| 스위트 | 이 작업과의 관계 |
|---|---|
| `server/src/test-runner.ts` (cwd=`server/`, `npx tsx src/test-runner.ts`) | `createWsTransportMessage` 16건 등. **`*.test.ts` 를 디스커버리하지 않으므로 이것만으로는 커버리지 아님** |
| `server/src/**/*.test.ts` (37개, 파일별 `npx tsx --test`) | `FairTerminalDeliveryScheduler` · `wsSendPolicyRestoreMetadata` · `WsRouterSendPriority` · `WsRouterCheckpointProtocol` · `TerminalAuthorityController` · `TerminalResourcePolicyCanary` · `RuntimeConfigStore` · `FairSchedulerSourceProvenanceRuntime` · `terminalFairnessCharacterization` — **전부 직격** |
| `tools/wave3/*.test.mjs` | `terminal-resource-policy-differential.ts` 픽스처 · consumer manifest · admission-gate(형제 21개 재실행) |
| `frontend/tests/unit/` (56개, cwd=`frontend/`, `node --experimental-strip-types --test`) | `runtimeConfig.test.ts` (설정 축) |
| `frontend/tests/e2e/` (Playwright) | checkpoint/authority promotion spec 들 |

`server/src/services/TerminalResourcePolicy.test.ts` 가 `tools/wave3/terminal-resource-policy-differential.ts` 를 `execFileSync` 로 실행하는 **역방향 결합**도 있다 — §8.2 의 `Buffer.from(payload)` 변경이 여기로 전파된다.

---

## 10. 권고 작업 순서

각 단계는 독립적으로 커밋 가능하고 관측 동작이 보존되도록 잘랐다.

| # | 내용 | 관측 동작 변화 | provenance 재발행 |
|---|---|---|---|
| **0** | `FairTerminalDeliveryScheduler.test.ts:7-23` 로컬 타입 재선언 제거 | 없음 | 불필요 (테스트 파일) |
| **1** | fair-delivery 정체성 3필드를 `WsTransportMessage` 사이드카로 승격, `JSON.parse` 4곳 제거 (§8.1) | **없음** (순수 리팩터) | **필요** |
| **2** | `isBinary` 수용 + silent drop 제거 (§6.3) | **있음** — TDD 대상. 결정 기록 §3 이행 | **필요** |
| **3** | `payload` 유니온 + `encoding` 필수 필드 (§8.2) | 없음 (전부 `encoding:'json'`) | **필요** |
| **4** | 프레임 인코더/디코더 신규 모듈 + channelId 등록부 + capability 협상 (§8.3, §8.6) | 없음 (`dataPlaneEncoding:'json'` 기본) | 부분 |
| **5** | fair scheduler 경로만 바이너리 (§8.3) — 폴백 경로는 JSON 유지 | **있음** — 협상 수락 소켓만 | **필요** |
| **6** | 임계값 재벤치 + authority 재발행 (§9.2) | 공정성 특성 변화 | **필요** |
| **7** | coalescing payload 병합 (§8.4) | 병합률 변화 | **필요** |
| **8** | checkpoint base64 제거 (§8.5) — `retainedStateDigest` 재정의 포함 | **있음** — 계약 변경 | 불필요 (핀 파일 아님) |
| **9** | snapshot/repair 하이브리드 프레임 (§8.5) | **있음** | **필요** |

**1단계와 2단계는 바이너리와 무관하게 그 자체로 정당한 개선**이다(payload 를 되읽는 안티패턴 제거, silent drop 제거). 바이너리 전환이 취소되더라도 남길 가치가 있으므로 먼저 하는 것이 안전하다.

---

## 11. 미확인 · 후속 조사 필요

| 항목 | 내용 |
|---|---|
| `[미확인]` `ws` 텍스트 프레임 타입 | `binaryType` 기본 `'nodebuffer'` 이면 `WsRouter.ts:1745`·`:2553` 의 `typeof raw === 'string'` 분기는 죽은 코드. 실측 필요 |
| `[미확인]` `streamEpoch` 4B | 현재 uint64 canonical decimal string(`WsRouter.ts:302-309`). 프레임 초안의 4B 와 폭이 맞지 않는다. 축약 테이블인가 초안 정정인가 |
| `[미확인]` `fullCheckpoint` 소비처 | `frontend/src` 전수 grep 에서 `chunks` 디코딩 지점 없음(`frontend/src/types/ws-protocol.ts:287` 타입 선언뿐). dead payload 여부 확인 후 삭제 판정 |
| `[미확인]` split 모드 메타·본문 결속 | §5.3 하이브리드 프레임이 control/output 소켓 분리 상태에서 순서를 보장하는 범위 |
| `[미확인]` `/api/runtime-config` 서버측 라우트 테스트 | `server/src` 에 focused 테스트 부재. 허용목록 회귀는 `RuntimeConfigStore.test.ts:129` 단위 테스트 + E2E 에만 의존 |
| `[미확인]` `ws.send` 의 `{ binary: true }` 옵션 | Buffer 를 넘기면 자동으로 binary opcode 인지, 명시가 필요한지 실측 필요 (`WsRouter.ts:6268`) |
| `[미확인]` `TERMINAL_CHECKPOINT_CHUNK_BYTES` 재튜닝 | base64 제거로 wire chunk 가 87 KB → 65 KB 로 줄면 청크 수/왕복 특성이 바뀐다. 64 KiB 가 여전히 최적인지 |

---

## 12. 관련 요구사항

이 문서가 참조·영향 판정한 SRS 요구사항. 실제 구현 착수 전 각각에 대해 SpecKiwi 절차를 밟아야 한다.

| Requirement | Stability | 이 문서와의 관계 |
|---|---|---|
| `FR-BGSTAB-016` AC-3 / AC-4 | evolving | §3(회계 단위) · §4(coalescing) 의 근거 조항 |
| `PERF-BGSTAB-010` | evolving | §3.4 재벤치 · §8.3 fair scheduler 경로 |
| `FR-BGSTAB-012` | **stable** | 큐 예산이 UTF-8 byte 단위 — §3.2 재정의 대상 |
| `FR-BGSTAB-008` AC-5 | **stable** | §7.3 공개 투영 허용목록 — 키 추가 시 개정 |
| `FR-BGSTAB-001` AC-3 | **stable** | §7.2 에서 **개정 회피**(별도 축 채택 근거) |
| `REL-BGSTAB-007` AC-4 | **stable** | §8.3 `streamEpoch`/`sourceSeq` 이진 표현 — 개정 대상 |
| `PERF-BGSTAB-009` AC-7 | evolving | §6.2 입력 JSON 유지 — **개정 불필요**(현행 유지와 정합) |
| `REL-BGSTAB-006` AC-5 | evolving | §5.3 split 결속 [미확인] 과 연결 |
| `REL-BGSTAB-003` | evolving | replay 가 string-tail 기반 — §3.2 에서 원본 UTF-8 도메인 유지로 영향 회피 |

> ⚠️ `Stability=stable` 요구사항 5건이 개정 대상이다. 구현 착수 전 SRS 변경이 선행해야 하며, 결정 기록 §2.4 가 이미 이 목록을 예고했다.
