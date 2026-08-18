# WebSocket 바이너리 전환 — 테스트 · 마이그레이션 · 롤백 전략

> 작성일: 2026-08-16
> 대상: BuilderGate output/snapshot 평면의 바이너리 프레임 전환
> 관련 이슈: `docs/issues/wave4-wave5/19-binary-data-plane.md`, `21-default-flip.md`, `22-legacy-deletion.md`
> 관련 SRS: `PERF-BGSTAB-010` (`docs/spec/30.buildergate-stability.srs.md:3648`), `FR-BGSTAB-006/007` (`:353`, `:419`), `REL-BGSTAB-006` (`:2498`)

---

## 0. 이 문서의 전제와 범위

### 0.1 상위에서 결정되어 내려온 것 (재론하지 않음)

- 바이너리 전환은 **즉시 도입**으로 결정되었다. `#19` 문서의 gate 1/gate 2 판정 절차는 이 문서의 범위가 아니다.
- **control 평면은 JSON 유지**, output/snapshot 평면만 바이너리.
- 프레임 초안: `[opcode 1B][channelId 4B][streamEpoch 4B][sourceSeq 8B][length 4B][payload]` (고정 헤더 21B).
- TDD 필수 — 동작 변경은 실패 테스트 선행.

### 0.2 이 문서가 다루는 것

기존 테스트 자산이 이 전환에서 **어떻게 깨지는가**, **어떤 순서로 실패 테스트를 쓸 수 있는가**, **어떤 단계를 거쳐 굴려야 하는가**, **롤백이 실제로 동작함을 어떻게 증명하는가**, 그리고 **CI 에 최소 무엇을 넣어야 하는가**.

### 0.3 SRS 게이트 상태 — 착수 전 반드시 해결할 것

`wave-5` target 은 `docs/spec/00.index.md:37` 에 등록되어 있으나 **배정된 요구사항이 0건**이다 (`#19` 문서 `:105` 가 `speckiwi list --target wave-5 --json` → `{"records":[]}` 로 확인). CLAUDE.md 의 SRS 워크플로에 따라 **요구사항 없이는 런타임 코드를 쓸 수 없다.**

따라서 아래 §5 TDD 단계표의 **S0 (SRS authoring) 은 선택이 아니라 첫 번째 필수 단계**다. 본 문서는 그 SRS 를 쓰기 위한 입력이지, SRS 를 대체하지 않는다.

기존 계약 중 이 작업이 직접 건드리는 것:

| 요구사항 | 관계 | 근거 |
| --- | --- | --- |
| `PERF-BGSTAB-010` AC-5 | **ACK credit 이 "실제 encodedBytes ledger" 로 정의됨.** 바이너리 전환은 이 바이트 수의 정의 자체를 바꾼다 | `docs/spec/30.buildergate-stability.srs.md:3677` |
| `PERF-BGSTAB-010` AC-3/AC-4 | fair-delivery evidence bundle 과 `sourceDigest` 고정 (§4 참조) | 같은 파일 `:3675`, `:3676` |
| `FR-BGSTAB-006/007` | split 소켓 계약. 바이너리 프레임은 output 레인에만 실림 | `:353`, `:419` |
| `REL-BGSTAB-006` AC-5 | split 런타임을 **활성화하지 말라**고 명시. `#19` 문서 `:31-32` 는 이 drift 를 `#3` 에서 닫으라고 못 박음 | `:2498` |

> ⚠️ `REL-BGSTAB-006` AC-5 때문에, split 소켓을 켜야만 성립하는 마이그레이션 설계는 **현재 계약 위반**이다. §7 의 혼합 버전 E2E 와 §8 의 단계 설계는 `unified` 모드에서도 성립하도록 구성했다.

---

## 1. 요약 — 이 조사에서 나온 다섯 개의 핵심 판정

1. **인코딩 이음매는 딱 3곳이다.** 서버 인코드 1곳(`wsSendPolicy.ts:91`), 소켓 write 1곳(`WsRouter.ts:6268`), 브라우저 디코드 1곳(`WebSocketContext.tsx:687`). 프로토콜이 넓게 퍼져 있을 거라는 우려와 달리 **좁은 seam** 이다. → §2

2. **[치명] `WsRouter.ts` 또는 `wsSendPolicy.ts` 를 1바이트라도 고치면 fair scheduler 가 런타임에서 조용히 꺼진다.** 이 두 파일은 `sourceDigest` 로 고정되어 있고, 그 digest 불일치는 capability 핸드셰이크를 `accepted: false` 로 만든다. 그리고 이를 되돌릴 **republish CLI 가 저장소에 없다.** → §4. 이것이 이 전환의 최대 리스크이며, 다른 모든 일정보다 먼저 해결해야 한다.

3. **깨지는 테스트는 "요란하게 깨지는 것"과 "조용히 사라지는 것" 두 종류이며, 후자가 훨씬 위험하다.** 서버 Mock 소켓들은 `JSON.parse` 가 throw 하며 요란하게 실패한다. 반면 브라우저·E2E 쪽은 `if (typeof data !== 'string') return;` 로 **바이너리 프레임을 조용히 버린다** — 테스트는 타임아웃하거나, 최악의 경우 control 프레임만 검사하고 있어서 **vacuous green** 이 된다. → §3.3

4. **ACK credit 도메인이 JSON 바이트 수에 못 박혀 있다.** `FairTerminalDeliveryScheduler.test.ts:213-227` 이 `createWsTransportMessage(...).byteLength` 로 기대값을 계산한다. 즉 인코딩을 바꾸면 DRR 크레딧 산수의 모든 기대값이 이동한다. `PERF-BGSTAB-010` AC-5 의 "encoded byte 단일 domain" 을 **어느 인코딩의 바이트로 정의할지**가 SRS 결정 사항이다. → §3.4

5. **CI 는 테스트를 하나도 돌리지 않는다.** `.github/workflows/release.yml` 이 유일한 워크플로이며 태그 push 에만 반응한다. PR·브랜치 push 에 도는 것이 **아무것도 없고**, 로컬 pre-commit 훅은 `process.exit(0)` 인 no-op 이다. 이 상태로 프로토콜을 바꾸면 회귀는 사람이 손으로 잡는 수밖에 없다. → §10

---

## 2. 지형 — 인코딩 이음매 3곳과 그 주변

### 2.1 서버 인코드 seam (단 하나)

```
server/src/ws/wsSendPolicy.ts:91    const payload = JSON.stringify(wireMessage);
server/src/ws/wsSendPolicy.ts:95    byteLength: Buffer.byteLength(payload, 'utf8'),
```

`createWsTransportMessage()` (`wsSendPolicy.ts:80`) 가 프로토콜 객체를 와이어 문자열로 만드는 **유일한 지점**이다. 직후 `:97-123` 에서 JSON 본문의 필드들(`type`, `sessionId`, `screenSeq`, `authorityEpoch`, `chunkId`, `outputData`, `sourceSegments` …)을 타입 있는 필드로 **끌어올린다(lift-out)**. 이 lift-out 구조가 곧 바이너리 헤더가 형식화할 대상이다 — 즉 헤더 설계는 무에서 시작하는 것이 아니라 이미 존재하는 비정규 헤더를 정규화하는 일이다.

제약: `WsTransportMessage.payload` 의 타입이 `string` 으로 못 박혀 있다 (`wsSendPolicy.ts:16`). 이것을 `string | Uint8Array` 로 넓히는 것이 전환의 첫 타입 변경이다.

### 2.2 소켓 write seam (단 하나)

```
server/src/ws/WsRouter.ts:6268    ws.send(message.payload, (error?: Error) => {...})
```

`sendRawTransportMessage()` (`WsRouter.ts:6240`) 내부. `WsRouter.ts` 전체에서 `ws.send(` 는 여기 하나뿐이다. `ws` 라이브러리는 이미 `Buffer`/`Uint8Array` 를 받으므로 **이 지점은 payload 타입 확장 외에 변경이 필요 없다.**

### 2.3 브라우저 디코드 seam (단 하나)

```
frontend/src/contexts/WebSocketContext.tsx:687    rawMessage = JSON.parse(event.data);
frontend/src/contexts/WebSocketContext.tsx:688-690  } catch { return; }   // ← 조용히 버림
```

두 소켓(control `:1201`, output `:1007`)이 같은 `handleMessage` 로 수렴한다.

> ⚠️ **`binaryType` 을 설정하는 코드가 `frontend/src` 어디에도 없다.** 즉 두 소켓 모두 기본값 `'blob'` 이다. 서버가 바이너리를 보내면 `event.data` 는 `Blob` 이 되고 `JSON.parse(Blob)` 은 `"[object Blob]"` 를 파싱하려다 throw → `:688` 의 catch 가 **조용히 return** 한다. **화면에 아무 오류 없이 출력만 사라진다.** 전환 전에 두 생성 지점 모두 `binaryType = 'arraybuffer'` 로 바꾸는 것이 선행 조건이다.

### 2.4 이미 있는 것 / 없는 것

| 프레임 초안 필드 | 현 상태 | 근거 |
| --- | --- | --- |
| `opcode` | **없음.** 현재는 JSON `type` 문자열. 전송 계층의 거친 분류 `WsTransportMessageKind = 'output' \| 'terminal-bulk' \| 'control' \| 'terminal-control'` 만 존재 | `wsSendPolicy.ts:3` |
| `channelId` | **없음.** `server/src`·`frontend/src` 전체에 이 식별자가 존재하지 않는다. 채널 개념은 `WsChannelRole = 'single'\|'control'\|'output'` + `clientGroupId`/`pairToken` 로 표현됨 | `wsTransportMode.ts:2`, `wsTransportMode.ts:76-84` |
| `streamEpoch` | **있음.** 단 checkpoint identity 안에만 있고 `output` 프레임에는 실리지 않는다 | `server/src/types/ws-protocol.ts:22`, 생성 `WsRouter.ts:5105` |
| `sourceSeq` | **있음.** checkpoint 내부 개념. `WsRouter.ts` 전체에서 2회만 사용 | `ws-protocol.ts:24` |
| `length` | JSON 이 자기서술적이라 불필요했음 | — |

**중요한 타입 사실:** 위 ordinal 들은 `Ordinal64 = string` 으로, **10진 문자열로 전송된다** (`ws-protocol.ts:17`). JS 의 53비트 한계를 피하려는 설계다. 바이너리 프레임의 `sourceSeq 8B` 는 이것을 진짜 u64 로 옮기는 것이므로, **경계에서 string ↔ BigInt 변환이 새로 생긴다.** 이 변환은 그 자체로 테스트 대상이다 (§6.2 참조).

`output` 프레임이 실제로 싣는 것 (`ws-protocol.ts:712-733`): `sessionId, data, replayToken, repairToken, screenSeq, authorityEpoch, authorityRevision, chunkId, sourceSegments[], connectionEpoch, deliverySeq, deliveryKind`. **초안 헤더 21바이트로는 이 필드들이 다 안 들어간다** — `[설계결정]` 필요: 남는 필드를 (a) 가변 헤더 확장, (b) payload 앞 서브헤더, (c) 별도 control 프레임 중 무엇으로 옮길지.

### 2.5 전환 시 함께 정리해야 할 낭비

`dataGap` 경로는 현재 **인코딩을 두 번 왕복한다**:

```
WsRouter.ts:5099   const gapPayload = JSON.stringify({...})   ← 스케줄러의 payload:string 에 맞추려고 미리 문자열화
   ↓ (fair scheduler 통과)
WsRouter.ts:5846   JSON.parse(delivery.payload)               ← 다시 객체로
   ↓
wsSendPolicy.ts:91 JSON.stringify(wireMessage)                ← 다시 문자열로
   ↓
WsRouter.ts:6268   ws.send(payload)
```

`FairTerminalDeliveryInput.payload` 가 `string` 인 것(`wsSendPolicy.ts:495`)이 원인이다. 바이너리 전환은 이 필드를 구조화 타입으로 바꿀 자연스러운 기회다. 단 §3.4 의 크레딧 산수와 함께 움직여야 한다.

---

## 3. 테스트 영향 표

### 3.0 표 읽는 법

- **스위트** = 어느 러너가 이 파일을 실제로 도는가. 이 저장소는 테스트 표면이 6개로 흩어져 있고 루트에 `test` 스크립트가 없다.
- **영향** = `깨짐`(assertion 이 실패하거나 throw) / `조용히 깨짐`(실패 없이 검증이 무력화되거나 타임아웃) / `수정`(시그니처만 넓히면 됨) / `무관`.
- `조용히 깨짐` 은 `깨짐` 보다 **더 나쁘다.** 빨간불이 안 켜지므로 "테스트 통과했다"는 거짓 보고로 이어진다.

### 3.1 깨짐 — output/snapshot 평면을 JSON 문자열로 단정하는 테스트

| 파일 | 스위트 | 영향 | 근거 |
| --- | --- | --- | --- |
| `server/src/test-runner.ts` | 모놀리식 러너 (`npx tsx src/test-runner.ts`) | **깨짐 (최대 폭발 반경)** | Mock 소켓 팩토리 `createFakeWs` `:14734`, `send(payload: string)` → `JSON.parse(payload)` `:14752-14753`. 호출 사이트 16곳 (`:13507, 13689, 14899, 15404, 15803, 15870, 15975, 16047, 16138, 16213, 16469, 17455, 18021, 18168, 18304`). `output`/`screen-snapshot`/`screen-repair` 단정이 `:13507`~`:18360` 구간에 산재. 추가로 **직렬화 문자열 부분매칭**: `:15252` `JSON.stringify(sent[0]).split(snapshotMarker)`, `:15430` |
| `server/src/ws/WsRouterSplitHandshake.test.ts` | node:test (server) | **깨짐** | Mock `:13` `send(payload: string, …)` → `JSON.parse(payload)` `:14`. `output` 단정 `:313, 323, 335, 428, 464, 505, 513, 643, 651, 715, 732, 780, 784, 833, 882, 886, 948, 963`; `screen-snapshot` `:302, 310, 326, 451, 499, 547, 589, 691, 721, 933, 952`; `screen-repair` `:629, 638, 640` |
| `server/src/ws/WsRouterSendPriority.test.ts` | node:test (server) | **깨짐 (디코더 필요)** | Mock `:45-46`. 시그니처만 넓혀선 안 되는 유일한 케이스 — **와이어 문자열 부분매칭** `:961-968` `.map(m => m.payload)` + `payload.includes('must-not-drain-after-unsubscribe')`. 인라인 `send` 재캐스트 5곳 `:1420, 1644, 1721, 1880, 1965` 도 각각 `payload: string` 재선언 |
| `server/src/ws/wsSendPolicyRestoreMetadata.test.ts` | node:test (server) | **깨짐** | `wsSendPolicy` 를 직접 단위테스트. `JSON.parse(coalesced.payload)` `:93` 후 `wire.data`/`wire.screenSeq`/`wire.chunkId`/`wire.sourceSegments` 단정 `:94-97`. output coalescing 의 **와이어 포맷 자체가 계약** |
| `server/src/ws/FairTerminalDeliveryScheduler.test.ts` | node:test (server) | **깨짐 (기대값 전부 이동)** | `DeliveryInput.payload: string` `:11`. `encodedOutputBytes()` `:213-227` 가 `createWsTransportMessage({type:'output',…}).byteLength` 로 기대값 계산 → `assert.equal(sent1.encodedBytes, firstWireBytes)` `:470-471`. `payload.startsWith('h')` `:437`, `payload === 'tiny'` `:447` 같은 문자열 단정도 있음. §3.4 참조 |
| `server/src/services/TerminalResourcePolicyCanary.test.ts` | node:test (server) | **깨짐** | Mock `:268-269`. `JSON.parse(old.payload)` `:3322`, `JSON.parse(coalesced.payload)` `:3328` 로 `type:'output'` 전송 메시지의 와이어 봉투 검사 (`policyGeneration` 부재 확인) |
| `server/src/services/TerminalAuthorityController.test.ts` | node:test (server) | **깨짐** | Mock `:581` 은 이미 `payload: string \| Buffer` 로 넓혀져 있으나 본문이 `JSON.parse(Buffer.isBuffer(p) ? p.toString('utf8') : p)` `:582` — 바이너리에서 throw. `screen-snapshot` 단정 `:788` |
| `server/src/ws/WsRouterCheckpointProtocol.test.ts` | node:test (server) | **깨짐** | Mock `:19-20` `JSON.parse(payload)`. 단정 대부분은 control(`terminal-checkpoint:*`)이나 `screen-snapshot:ready` 핸드셰이크 `:816, 916` 를 경유하며 output 게이팅을 구동. ⚠️ **이 파일은 §4.2 의 테스트 소스 해시 고정 대상이다** |
| `frontend/tests/e2e/wave3-terminal-authority-fairness.spec.ts` | Playwright | **깨짐** | `parseFrame` `:202-204`. `screen-snapshot` `:336, 344, 351, 1438`, **`output` `:1574`** |
| `frontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts` | Playwright (+ `authority-promotion-evidence.test.mjs` 가 이것을 실행) | **깨짐** | `parseFrame` `:303-305`. `screen-snapshot` `:364, 371, 401, 431` |
| `frontend/tests/e2e/wave2-screen-repair-resync.spec.ts` | Playwright | **깨짐** | `JSON.parse` `:103`. `screen-snapshot` `:111, 513, 634, 678` |
| `frontend/tests/e2e/wave2-terminal-restore.spec.ts` | Playwright | **깨짐** | `parseFrame` `:83-89`. 복원/스냅샷 메타데이터 평면 |
| `frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts` | Playwright | **깨짐** | `parseFrame` `:130-132`. `screen-snapshot` `:70` |
| `tools/wave3/authority-promotion-evidence.test.mjs` | wave3 증거 스크립트 (node:test 아님, `node tools/wave3/<파일>`) | **깨짐** | 실제 서버에 붙는 WS 클라이언트 `:934`, `socket.on('message', raw => messages.push(JSON.parse(raw.toString('utf8'))))` `:938` — **모든 프레임을 무조건 JSON 파싱**. green 모드(`mode = args.includes('--expect-red') ? 'red' : 'green'` `:2470`)에서 `validateSplitPhysicalLanes()` 로 실행됨. 이 스크립트는 Playwright E2E 까지 실행하므로 실패가 연쇄된다 |

### 3.2 수정 — 시그니처/가드만 넓히면 되는 것 (control 평면)

| 파일 | 스위트 | 영향 | 근거 |
| --- | --- | --- | --- |
| `server/src/ws/WsRouterRestoreMetadata.test.ts` | node:test (server) | **수정 → 단, 조건부 깨짐** | 실제 `ws` 클라이언트 `:136`. 송신 `:155-156` `JSON.stringify`. 수신 `:110-117` `JSON.parse(raw.toString())` 가 **try/catch 로 조용히 return** → 바이너리는 사라지고 `waitFor` `:174` 가 타임아웃. 단정 대부분 control(`screen-snapshot:ready` `:224, 278, 301, 314, 462, 479, 571`)이나 `isSessionFrame(frame,'screen-snapshot',…)` `:447, 566` 는 **스냅샷 평면** → `screen-snapshot` 을 바이너리로 옮기면 `깨짐` 으로 재분류. ⚠️ §4.2 해시 고정 대상 |
| `frontend/tests/support/perfBgstab010Ac6BrowserAckHarness.ts` | Playwright 지원 모듈 | **수정** | 파서 3곳 `:45, 129, 191` 모두 `if (typeof raw !== 'string') return null;`. 단정은 순수 control (`terminal-delivery:capability` `:77, 100`, `:ack` `:171`, `:ack-rejected` `:154`). 같은 소켓에 output 이 오면 파서가 굶으므로 방어적으로 확장 |
| `frontend/tests/unit/perfBgstab010Ac6ServerAckFaultContract.test.ts` | frontend node:test (**Playwright 미수집**) | **수정** | 전체가 위 하네스 **소스 텍스트에 대한 정규식 단정**. 하네스를 고치면 정규식이 계속 만족되는지 확인 필요 |
| `frontend/tests/e2e/wave1-split-characterization.spec.ts` | Playwright | **수정** | `framereceived` `:392-397` 가 비문자열 payload 를 버림. 단정은 `connected` `:402`/`pong` `:408` 만. ⚠️ 별도로 **소스 텍스트 고정**이 있다: `:320-325` 가 `serverIndexSource`/`browserContextSource` 에 `'const ws = new WebSocket(url);'` 등 리터럴이 있는지 검사 → `WebSocketContext.tsx` 리팩터가 이것을 깬다 |
| `frontend/tests/unit/terminalContainerRecoveryContract.test.ts` | frontend node:test | **수정** | 소스 텍스트 정규식. `"ws.send(JSON.stringify({ type: 'subscribe', sessionIds }))"` `:146`, `case 'screen-snapshot':` `:920`, `screen-snapshot:ready` `:568, 1086, 1161` |
| `frontend/tests/unit/terminalAuthorityProductionWiring.test.ts` | frontend node:test | **수정** | `context.indexOf('ws.onmessage =')` `:129` |
| `frontend/tests/unit/terminalCheckpointRuntime.test.ts` | frontend node:test | **수정** | 소스 텍스트 단정 `:2826` `output.onmessage = event => handleMessageRef.current(event)`, `:773` `/screen-snapshot:ready/` |
| `frontend/tests/e2e/terminal-clipboard.spec.ts` / `terminal-paste.spec.ts` / `terminal-keyboard-regression.spec.ts` / `grid-equal-mode.spec.ts` | Playwright | **수정(경미)** | 전부 client→server `input` 평면. `terminal-keyboard-regression.spec.ts:509` 는 이미 `string \| ArrayBufferLike \| Blob \| ArrayBufferView` 로 넓혀져 있음 |
| `frontend/tests/unit/webSocketBackpressure.test.ts` | frontend node:test | **수정(경미)** | `serializedPayload: string` 계약 + 바이트 산수. client→server 만 다루므로 **본 전환 범위 밖** (server→client 만 바이너리). 브라우저 송신도 바꾸기로 하면 재분류 |
| `tools/wave3/canary-admission-evidence.test.mjs` | wave3 증거 스크립트 | **수정** | 프로덕션 경로 목록에 `server/src/ws/wsSendPolicy.ts`, `WsRouter.ts`, `server/src/types/ws-protocol.ts`, `frontend/src/contexts/WebSocketContext.tsx` 고정 `:40-56`. 포커스 테스트 커맨드 문자열에 ws 테스트 파일명이 하드코딩 `:62-67` → **ws 테스트 파일을 추가/개명하면 깨진다** |

### 3.3 조용히 깨짐 — 실패하지 않고 검증만 사라지는 것 ⚠️ 최우선 주의

아래 파일들은 바이너리 프레임을 받으면 **early return** 한다. throw 하지 않는다. 결과적으로:
- 출력 프레임을 기다리는 단정 → **타임아웃**(원인이 프로토콜임을 알기 어려움)
- control 프레임만 검사하는 단정 → **그대로 통과 (vacuous green)**

| 파일 | 조용히 버리는 지점 | 위험 |
| --- | --- | --- |
| `frontend/src/contexts/WebSocketContext.tsx` (**프로덕션**) | `:688-690` `catch { return; }` | 제품 자체가 조용히 프레임을 버린다. `#19` AC 가 금지한 **silent drop** 그 자체 |
| `frontend/tests/e2e/wave1-retained-state-characterization.spec.ts` | `:632` `if (typeof raw !== 'string') return;` | `'output'` 필터 `:674` 가 영구히 0건 → 관련 단정이 vacuous |
| `frontend/tests/e2e/terminal-authority.spec.ts` | `:150` `if (typeof data !== 'string') return;` | `screen-snapshot` `:209, 221` 이 vacuous |
| `frontend/tests/support/perfBgstab010Ac6BrowserAckHarness.ts` | `:45, 129, 191` | 세 파서 전부 |
| `frontend/tests/e2e/wave1-split-characterization.spec.ts` | `:393` | `:411` 주석이 "Non-JSON terminal output is not production-path evidence" 라고 이미 선언 — 전환 후 이 주석의 전제가 무너짐 |
| `frontend/tests/e2e/grid-equal-mode.spec.ts` | `:470` | control 캡처만 |
| `server/src/ws/WsRouterRestoreMetadata.test.ts` | `:110-117` try/catch | 타임아웃으로 나타남 |

> **처방:** 이 목록의 모든 지점에서 "비문자열이면 return" 을 **"비문자열이면 디코드 시도, 실패하면 명시적 throw/실패 카운터 증가"** 로 바꾼다. 마이그레이션 기간 동안 *조용한 폐기 경로를 0으로 만드는 것*이 §8 shadow 단계의 진입 조건이다.
>
> 이것은 `boundary_control_for_fault_tests` 및 `check_operands_must_have_independent_origins` 교훈의 직접 적용이다: **통과한 테스트가 무엇을 실제로 관측했는지 세지 않으면, 관측이 0건이어도 초록이다.**

### 3.4 ACK credit 도메인 — 별도 항목으로 다뤄야 하는 이유

`PERF-BGSTAB-010` AC-5 는 서버가 "실제 encodedBytes ledger" 를 소유하라고 요구한다 (`docs/spec/30.buildergate-stability.srs.md:3677`). 현재 그 "실제 바이트" 의 정의는:

```
server/src/ws/wsSendPolicy.ts:598   fairDeliveryBytes()
      → createWsTransportMessage({type:'output', …}).byteLength
      → Buffer.byteLength(JSON.stringify(wireMessage), 'utf8')       (wsSendPolicy.ts:91,95)
```

즉 **DRR 크레딧이 JSON 봉투 바이트로 계산된다.** 테스트도 같은 함수로 기대값을 만든다(`FairTerminalDeliveryScheduler.test.ts:213-227`) — 두 피연산자의 출처가 같으므로 이 단정은 **인코딩이 바뀌어도 자동으로 따라간다** (구현과 기대가 동시에 이동). 여기에 함정이 있다.

> ⚠️ `check_operands_must_have_independent_origins`: `assert.equal(sent1.encodedBytes, encodedOutputBytes(...))` 는 구현과 기대가 **같은 함수**에서 나오므로 인코딩 변경을 절대 잡지 못한다. 이 단정은 바이너리 전환 후에도 초록이지만 아무것도 검증하지 않는다.

`[설계결정]` 필요:

| 선택지 | 의미 | 영향 |
| --- | --- | --- |
| A. **payload 바이트만** 세기 | 봉투(헤더) 제외, 실제 터미널 출력 바이트 | 인코딩 독립적. 기존 임계값(threshold)의 의미가 바뀜 → §4.1 의 decision artifact 임계값 재검증 필요 |
| B. **와이어 전체 바이트** | 헤더 21B 포함 | 인코딩 종속. JSON→바이너리에서 프레임당 수십~수백 바이트 감소 → 같은 크레딧으로 더 많이 흐름 = 사실상 백프레셔 완화 |
| C. **JSON 기준 고정** | 바이너리로 보내도 크레딧은 JSON 바이트로 계산 | 계약 안정. 그러나 두 인코딩을 항상 계산해야 함 (shadow 단계 이후에는 순 낭비) |

권고: **A**. 이유 — `PERF-BGSTAB-010` AC-5 가 요구하는 것은 "클라이언트가 보낸 숫자를 신뢰하지 않는 서버 소유 원장" 이지 "특정 인코딩의 바이트" 가 아니다. payload 바이트는 인코딩 전환에 불변이므로, §8 의 shadow/opt-in/기본값 단계에서 **크레딧 산수가 단계마다 흔들리지 않는다.** 다만 임계값 재검증이 필요하므로 §4.1 과 묶어서 처리한다.

그리고 위의 vacuous 단정을 대체할 **독립 출처 단정**을 반드시 추가한다:

```
// 나쁜 예 (현재): 구현과 기대가 같은 함수
assert.equal(sent.encodedBytes, encodedOutputBytes(epoch, sid, seq, payload));

// 좋은 예: 기대값을 리터럴로 고정 (독립 출처)
assert.equal(sent.encodedBytes, Buffer.byteLength('한글-alpha', 'utf8')); // == 13
```

### 3.5 무관 — 손대지 않아도 되는 것

| 그룹 | 개수 | 근거 |
| --- | --- | --- |
| `tools/daemon/*.test.js` | **19개 전부 무관** | WebSocket 사용 없음. `JSON.parse` 는 전부 파일/stdout 읽기 (`build-daemon-exe.test.js:212`, `native-daemon.integration.test.js:244` 등) |
| `tools/wave3/fair-readmission-closure-v3*.test.mjs` | **22개 전부 무관** | 재귀 게이트(`admission-gate` 가 형제 21개, `boundary-gate` 가 9개 재실행)는 그대로 유효하되 WS 프레임과 무관. `fair-readmission-closure-v3.test.mjs:7` 이 테스트 *이름* 문자열 `"…real HTTPS WebSocket"` 을 grep 하므로 **개명에만** 민감 |
| `tools/wave1/g1-decision-gate.test.mjs` | 1개 무관 | WS 참조 없음 |
| `server/tools/*.test.{cjs,mjs}` | 2개 무관 | WS 참조 없음 |
| `server/src` 나머지 | 26/37 무관 | `ws/wsTransportMode.test.ts`(URL 파서만), `types/wsCheckpointProtocol.test.ts`(순수 스키마 검증), `benchmarks/*.test.ts` 8개(디스크 아티팩트 JSON), `services/SessionManager*.test.ts` 등 |
| `frontend/tests/unit/` 대부분 | 38/56 무관 | **구조적 이유**: 디코드 seam(`WebSocketContext.tsx:687`) **아래**에서 이미 파싱된 객체를 받는다. 예: `terminalCheckpointRuntime.test.ts:1237` `runtime.handleMessage(startMessage())` 는 `MessageEvent` 가 아니라 객체를 넘긴다. `terminalSnapshot`, `terminalOutputScheduler`, `terminalWriteCoordinator`, `visibleOutputRecovery`, `terminalHiddenOutput`, `terminalReplayGuard`, `splitWebSocketLifecycle`, `wsCheckpointProtocol`, `terminalTransportQueueDecision`, `webSocketUrl` 등 |
| `frontend/tests/benchmarks/` | 2개 무관 | `terminalNoRenderFixture.ts:576` 은 이미 `string \| Uint8Array` 를 xterm write 경계에서 처리 (WS 아래 계층) |
| `frontend/tests/e2e/` 나머지 | 16개 무관 | auth-bootstrap, command-management-dialog, mcp-control-dialog, pane-*, recovery-options, settings-*, terminal-korean-ime, terminal-mobile-scroll 등 — WS 프레임 가로채기 없음 |

**구조적 결론:** 디코드 seam 이 하나이므로 프론트엔드 단위 테스트는 대부분 자동으로 보호된다. **깨지는 것은 seam 을 직접 가로채는 테스트뿐**이다. 이것이 §5 TDD 설계의 근거다 — 새 검증은 seam 에 새 파일로 붙이고, 기존 파일 수정은 최소화한다.

---

## 4. provenance 함정 — 착수 전 반드시 해결

이 저장소에는 **소스 파일 내용을 sha256 으로 고정한 게이트가 두 종류** 있고, 바이너리 전환은 **둘 다** 건드린다.

### 4.1 [치명] fair-scheduler `sourceDigest` — 편집하면 스케줄러가 런타임에서 꺼진다

**고정 대상 6개 파일** (`server/tools/write-fair-scheduler-source-provenance.mjs:7-14`):

```
src/benchmarks/terminalFairnessCharacterization.ts
src/benchmarks/fairSchedulerAuthorityLocator.ts
src/ws/wsSendPolicy.ts                        ← 반드시 편집해야 함
src/ws/WsRouter.ts                            ← 반드시 편집해야 함
src/services/TerminalResourcePolicy.ts
src/services/TerminalResourcePolicyCanary.ts
```

| 파일 | 고정 여부 | 전환에서 편집 필요? |
| --- | --- | --- |
| `server/src/ws/wsSendPolicy.ts` | **PINNED** | **예** — 인코드 seam `:91` |
| `server/src/ws/WsRouter.ts` | **PINNED** | **예** — capability 협상 `:1956`, dataGap `:5099/:5846` |
| `server/src/services/TerminalResourcePolicy.ts` | **PINNED** | 아마도 (크레딧 정책 §3.4) |
| `server/src/services/TerminalResourcePolicyCanary.ts` | **PINNED** | 아니오 |
| `server/src/benchmarks/terminalFairnessCharacterization.ts` | **PINNED** | 아니오 |
| `server/src/benchmarks/fairSchedulerAuthorityLocator.ts` | **PINNED** | 아니오 |
| `server/src/ws/wsTransportMode.ts` | NOT PINNED | 예 (새 codec 모드) |
| `server/src/services/SessionManager.ts` | NOT PINNED | 아니오 |
| `server/src/types/ws-protocol.ts` | NOT PINNED (단 §4.3 참조) | 예 |

**연쇄 경로 (직접 검증함):**

```
1. wsSendPolicy.ts 또는 WsRouter.ts 를 1바이트 수정
2. getFairSchedulerBenchmarkSourceDigest()  (terminalFairnessCharacterization.ts:280-300)
   - src/ 실행(tsx/dev): 6개 파일을 워킹트리에서 재읽어 digest 재계산 (:285)
   - dist/ 실행: 빌드가 방금 재생성한 provenance 매니페스트를 읽음 → 같은 새 digest
3. validateFairSchedulerDecisionArtifact()  (terminalFairnessCharacterization.ts:1675)
      artifact.sourceDigest !== getFairSchedulerBenchmarkSourceDigest()
      → { accepted: false, reason: 'source-digest-mismatch' }
4. 이 검증은 런타임 경로에서도 호출된다:
   TerminalResourcePolicyCanary.ts:346  validateFairSchedulerDecisionArtifact({artifact, rawArtifacts})
      ← validateFairDeliveryCandidateArtifactAtCanonicalAuthority (:279)
      ← createPublishedFairDeliveryCandidateArtifactValidator (:386, :403)
      ← validatePublishedFairDeliveryCandidateArtifact (:584)
5. WsRouter.ts:1956  const artifact = validatePublishedFairDeliveryCandidateArtifact({runtimePolicy: policy});
   WsRouter.ts:1957  if (!artifact.accepted) → capability 응답을 accepted:false 로 (:1960-1966)
6. 그 소켓은 스케줄러 없이 직접 전송 경로로 떨어진다 (WsRouter.ts:5159-5167)
```

**결과: 코드를 고치는 순간 fair scheduler 가 모든 연결에서 조용히 비활성화된다.** 서버는 오류를 내지 않는다. capability 응답의 `reason` 필드에 `decision-artifact-source-digest-mismatch` 가 들어갈 뿐이다. 이는 `#19` 문서 `:67-69` 가 경고한 "거절 경로 3번(아티팩트 거절)" 이며, 그 문서가 *"대조군에서 스케줄러가 꺼진 이유가 철회인지 아티팩트 거절인지 반드시 구분해 기록한다"* 고 못 박은 바로 그 상황이다.

동시에 깨지는 테스트:
- `server/src/benchmarks/terminalFairnessCharacterization.test.ts:203` — `getFairSchedulerBenchmarkSourceDigest() === artifact.sourceDigest`
- `server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts:77, :87-90` — `{accepted:true, reason:'decision-artifact-verified'}` 기대
- `terminalFairnessCharacterization.test.ts:157-163` — 소스에 리터럴 `'src/ws/WsRouter.ts'` 와 식별자 `createWsTransportMessage` 가 있는지 검사 → **`createWsTransportMessage` 를 개명하면 직접 깨진다**

**메모리 정정 (중요):** 저장된 메모리 `fair_scheduler_republish_procedure` 는 "provenance 는 워킹트리가 아닌 HEAD 를 읽는다 → 코드 커밋 → republish → 증거 커밋 순서 강제" 라고 기록하고 있으나, **현재 소스에서는 사실이 아니다.** `write-fair-scheduler-source-provenance.mjs:28` 은 `readFile(resolve(serverRoot, path), 'utf8')` 로 **워킹트리를 직접 읽는다.** 두 스크립트 어디에도 `node:child_process` import 나 `git show HEAD:` 가 없다 (전 저장소 grep 0건; `git` 을 쓰는 벤치마크는 `terminalCharacterization.ts` 뿐이며 fairness 쪽이 아니다). `[미확인]` — 메모리의 기술이 이전 리비전에 근거한 것인지 여부.

**실무적 함의는 오히려 더 나쁘다:** HEAD 를 읽는다면 커밋 전까지는 게이트가 초록이겠지만, 워킹트리를 읽으므로 **저장하는 즉시** 게이트가 빨개진다. 커밋 순서로 회피할 수 없다.

**republish 절차 — 저장소에 자동화가 없다** `[미확인 → 확인 결과: 부재]`:
- `write-fair-scheduler-evidence-bundle.mjs:302-304` 의 CLI 진입점은 인자를 받지 않으며, override 를 능동적으로 거부한다 (`:190-200`).
- `write-fair-scheduler-source-provenance.mjs` 에는 argv 처리가 전혀 없다.
- `--verify-existing` 같은 플래그는 **존재하지 않는다.**
- `publishFairSchedulerAuthorityGeneration()` (`terminalFairnessCharacterization.ts:2224`) 이 유일한 승격 함수이나, **명시적 `authorityRoot` 를 요구하고 현재 테스트에서 임시 디렉터리 대상으로만 호출된다.** 게다가 내부적으로 `createFairSchedulerDecisionArtifact()` (`:2237`) 를 호출하므로 **벤치마크를 실제로 재실행한다** (클라이언트 1/2/8 × 5 trial × WAN 150ms). 즉 republish 는 "해시 갱신" 이 아니라 **재측정** 이다.

**[설계결정] 권고 — 착수 전 처리할 것:**

1. **먼저 republish 절차를 만들고 한 번 리허설한다.** 바이너리 코드를 한 줄도 쓰기 전에, `wsSendPolicy.ts` 에 공백 한 칸을 넣었다 빼는 수준의 변경으로 전체 절차(재측정 → 새 generation 발행 → `current.json` 갱신 → 게이트 초록 복귀)가 성립하는지 확인한다. **이 리허설이 실패하면 바이너리 전환은 착수 불가**이며, 그 사실 자체가 가장 먼저 보고되어야 한다.
2. **pinned 6개 파일에 대한 편집을 최대한 뒤로 미루고 한 덩어리로 묶는다.** §5 의 S1~S4 (순수 코덱)는 pinned 파일을 전혀 건드리지 않도록 설계했다. republish 는 비싸므로 횟수를 줄인다.
3. **주석만 고치는 변경으로 republish 사이클을 돌리지 않는다** — CLAUDE.md Rules 의 명시 규칙이며, 여기서는 비용 이유로도 타당하다.

### 4.2 테스트 소스 해시 고정 — `retained-shadow-parity`

`tools/wave3/retained-shadow-parity.test.mjs:18-23` 이 **테스트 파일 4개**의 내용을 고정한다:

```
server/src/services/RetainedTerminalAuthority.test.ts
server/src/services/SessionManagerPartialEscapeTail.test.ts
server/src/ws/WsRouterRestoreMetadata.test.ts        ← §3.2 에서 수정 필요
server/src/ws/WsRouterCheckpointProtocol.test.ts     ← §3.1 에서 깨짐
```

추가로 `coverageRegistry` (`:170-205`)가 각 파일 안의 **리터럴 앵커 문자열**을 요구한다 (예: `:178` 의 `"['output', 'resize']"`), 그리고 `expectedFocusedTestNamesSha256 = '1e7da1ab…'` (`:161`)이 **집중 테스트 이름 목록 전체의 해시**를 고정한다.

→ **`WsRouterCheckpointProtocol.test.ts` 나 `WsRouterRestoreMetadata.test.ts` 를 수정하면 `retained-shadow-parity.test.mjs` 가 깨진다. 테스트 이름을 추가/변경하면 `expectedFocusedTestNamesSha256` 도 갱신해야 한다.**

이 파일은 어떤 npm 스크립트에도 없다: `node tools/wave3/retained-shadow-parity.test.mjs` 로 직접 돌려야 하며, `--regenerate-green` 등의 플래그를 받는다 `[미확인 — 정확한 플래그 확인 필요]`.

### 4.3 `--expect-red` 전용 해시 고정 — `authority-promotion-evidence`

`tools/wave3/authority-promotion-evidence.test.mjs:129-140` 이 프론트엔드 프로덕션 소스의 sha256 을 고정하며, 여기에 **`frontend/src/contexts/WebSocketContext.tsx`(= 디코드 seam)와 `frontend/src/types/ws-protocol.ts` 가 포함된다.** `:766-777` 의 `readProductionGitStatus()` 는 그 파일들의 `git status --porcelain` 출력까지 baseline 과 일치하도록 요구한다 (`:816-819`).

**완화 사실 (직접 확인):** 이 검증은 `verifyRedProductionUnchanged()` 안에 있고, 호출 조건은 `mode === 'red'` (`:2522`)이며 mode 는 `args.includes('--expect-red') ? 'red' : 'green'` (`:2470`)로 결정된다. **기본(green) 실행에서는 돌지 않는다.**

따라서:
- 일상 실행(green): §4.3 의 해시 고정은 **문제되지 않음**. 대신 `validateSplitPhysicalLanes()` 의 실 WS 클라이언트(`:938`)가 §3.1 대로 깨진다.
- `--expect-red` 실행: `WebSocketContext.tsx` 수정 즉시 실패. **바이너리 전환 이후 이 RED 재현 모드는 영구적으로 재현 불가**가 되므로, baseline 을 갱신하든가 해당 RED 증거를 "superseded" 로 명시 종결하든가 `[설계결정]` 이 필요하다.

### 4.4 provenance 함정 요약표

| 게이트 | 트리거 | 기본 실행에서 도는가 | 회복 방법 |
| --- | --- | --- | --- |
| fair-scheduler `sourceDigest` | `wsSendPolicy.ts`/`WsRouter.ts` 등 6개 중 하나라도 1바이트 변경 | **예 — 런타임 포함** | 벤치마크 재측정 + authority generation republish (**자동화 없음**) |
| `retained-shadow-parity` 테스트 해시 | `WsRouterCheckpointProtocol.test.ts` 등 4개 테스트 파일 수정 | 직접 실행 시 | baseline 재생성 |
| `authority-promotion-evidence` 프론트 해시 | `WebSocketContext.tsx` 등 수정 | **아니오 (`--expect-red` 전용)** | baseline 갱신 또는 RED 증거 종결 |
| `authority-promotion-evidence` 실 WS 프로브 | 서버가 바이너리 프레임 전송 | **예 (green)** | 프로브 파서에 코덱 분기 추가 |
| `canary-admission-evidence` 경로 목록 | ws 테스트 파일 추가/개명 | 직접 실행 시 | `:40-67` 목록 갱신 |
| evidence-bundle 매니페스트 (CLAUDE.md 기재) | `docs/analysis/terminal-fairness-authority/` 의 `raw/**` 변경 | **예 — build 실패 → 테스트·릴리스·CI 전부 red** | 매니페스트 재발행 |

---

## 5. TDD 단계표

### 5.1 설계 원칙

1. **순수 함수부터.** 코덱은 소켓·서버·브라우저 없이 완전히 테스트 가능하다. `§10.3 클린 아키텍처` — "테스트가 네트워크·파일시스템·시계를 필요로 하면 경계가 잘못 그어진 것".
2. **pinned 파일 편집은 최대한 뒤로, 한 덩어리로.** §4.1 의 republish 비용 때문.
3. **새 검증은 새 파일에.** §4.2 의 테스트 해시 고정을 피하려면 기존 pinned 테스트 파일에 케이스를 추가하는 대신 새 파일을 만든다.
4. **각 단계마다 어느 러너가 그 파일을 실제로 도는지 명시.** 루트에 `test` 스크립트가 없고 스위트가 6개로 흩어져 있어, 안 도는 곳에 테스트를 두면 영원히 안 돈다.

> ⚠️ **새 `*.test.ts` 를 `server/src/` 에 만들면 `server/src/test-runner.ts` 가 그것을 돌지 않는다.** 이 러너는 자기완결형이며 `*.test.ts` 를 디스커버리하지 않는다 (메모리 `buildergate_test_runner_excludes_node_test_files`). 반드시 파일별 `npx tsx --test` 로 따로 돌려야 하고, 그 명령을 §10 의 CI 에 등록해야 한다.

### 5.2 단계표

| # | 단계 | 실패 테스트 (신규/수정) | 최소 구현 | 검증 커맨드 (cwd) | pinned 영향 |
| --- | --- | --- | --- | --- | --- |
| **S0** | SRS 요구 작성 (wave-5) | — (테스트 아님) | `speckiwi` 로 wave-5 에 바이너리 data-plane 요구 신규 등록. `PERF-BGSTAB-010` AC-5 의 encoded-byte 도메인 재정의(§3.4) 포함 | `speckiwi validate --fail-on-warning --json` (루트) | 없음 |
| **S0.5** | **republish 리허설** | — (절차 검증) | pinned 파일에 no-op 변경 → 게이트 red 확인 → republish → green 복귀. **실패 시 여기서 중단하고 보고** | `npx tsx --test src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts` (`server/`) | **의도적으로 건드림** |
| **S1** | 서버 프레임 **인코더** 순수 함수 | 신규 `server/src/ws/binaryFrameCodec.test.ts` — 알려진 입력 → 알려진 바이트열 (기대값을 **리터럴 배열로** 고정, 인코더 재호출 금지) | 신규 `server/src/ws/binaryFrameCodec.ts` — `encodeBinaryFrame()` | `npx tsx --test src/ws/binaryFrameCodec.test.ts` (`server/`) | **없음** (새 파일) |
| **S2** | 서버 프레임 **디코더** + 왕복 | 같은 파일에 왕복 property test (§6.1) | `decodeBinaryFrame()` | 위와 동일 | 없음 |
| **S3** | 디코더 **fault 케이스** + 경계 대조군 | 같은 파일 — 잘린 프레임 / 잘못된 opcode / length 불일치 / 거대 payload / u64 경계. **각각 경계 대조군 동반** (§6.3) | fault 별 명시적 오류 타입 | 위와 동일 | 없음 |
| **S4** | 프론트 디코더 대칭 + **교차 골든 벡터** | 신규 `frontend/tests/unit/binaryFrameCodec.test.ts` — S1 이 생성한 golden vector 파일을 읽어 디코드 | 신규 `frontend/src/utils/binaryFrameCodec.ts` | `node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts` (`frontend/`) ⚠️ **Playwright 가 수집 안 함** | 없음 |
| **S5** | `WsTransportMessage.payload` 타입 확장 | 수정 `server/src/ws/wsSendPolicyRestoreMetadata.test.ts` — coalescing 을 바이트 경로로 | `wsSendPolicy.ts:16` `payload: string \| Uint8Array`; `:216` `tryCoalesceOutputMessage` 바이트 버전; `:91` 코덱 분기 | `npx tsx --test src/ws/wsSendPolicyRestoreMetadata.test.ts` (`server/`) | **PINNED — `wsSendPolicy.ts`** |
| **S6** | ACK credit 도메인 고정 | 신규 `server/src/ws/fairDeliveryCreditDomain.test.ts` — 기대값을 **`Buffer.byteLength(payload)` 리터럴로** (§3.4). 기존 `FairTerminalDeliveryScheduler.test.ts:470` 의 vacuous 단정도 교체 | `wsSendPolicy.ts:598` `fairDeliveryBytes()` 를 payload-바이트 기준으로 | `npx tsx --test src/ws/fairDeliveryCreditDomain.test.ts src/ws/FairTerminalDeliveryScheduler.test.ts` (`server/`) | **PINNED — `wsSendPolicy.ts`** |
| **S7** | **shadow 인코더 비교기** | 신규 `server/src/ws/binaryShadowParity.test.ts` — 같은 메시지를 JSON/바이너리 양쪽으로 인코딩 → 디코드 → **의미 동등** 단정 (바이트 동등 아님) | shadow 모드에서 두 인코딩 산출 + 불일치 카운터 | `npx tsx --test src/ws/binaryShadowParity.test.ts` (`server/`) | `wsSendPolicy.ts` |
| **S8** | capability 협상 + downgrade | 수정 `server/src/ws/WsRouterSplitHandshake.test.ts` (Mock 확장) + 신규 `server/src/ws/WsRouterBinaryNegotiation.test.ts` | `WsRouter.ts` capability 응답에 codec 필드; 미지원 클라이언트는 JSON 유지 | `npx tsx --test src/ws/WsRouterBinaryNegotiation.test.ts src/ws/WsRouterSplitHandshake.test.ts` (`server/`) | **PINNED — `WsRouter.ts`** |
| **S9** | **조용한 폐기 경로 제거** | 신규 `frontend/tests/unit/wsFrameDispatch.test.ts` — 해석 불능 프레임이 `return` 이 아니라 관측 가능한 실패를 내는지 | `WebSocketContext.tsx:687-690` 분기 + `binaryType='arraybuffer'` (`:1007`, `:1201`) | `node --experimental-strip-types --test tests/unit/wsFrameDispatch.test.ts` (`frontend/`) | §4.3 (`--expect-red` 만) |
| **S10** | 기존 Mock 소켓 일괄 확장 | 수정 §3.1 의 서버 Mock 8종 + `test-runner.ts:14752` | 코덱 인지 Mock 헬퍼 1개를 공용화 (`§10.2 중복 금지`) | `npx tsx src/test-runner.ts` + `npx tsx --test src/ws/*.test.ts` 파일별 (`server/`) | §4.2 (`WsRouterCheckpointProtocol.test.ts`) |
| **S11** | **롤백 드릴** 통합 테스트 | 신규 `server/src/ws/WsRouterBinaryRollback.test.ts` (§9) | epoch 종료 → 재협상 → JSON fresh snapshot | `npx tsx --test src/ws/WsRouterBinaryRollback.test.ts` (`server/`) | `WsRouter.ts` |
| **S12** | **혼합 버전 E2E** | 신규 `frontend/tests/e2e/binary-mixed-version.spec.ts` (§7) | — (S8/S9 검증) | `npx playwright test tests/e2e/binary-mixed-version.spec.ts --project "Desktop Chrome"` (`frontend/`) | 없음 |
| **S13** | 회귀 전수 | 기존 전부 | — | §5.3 | — |

### 5.3 회귀 전수 커맨드 (한 번에 다 도는 명령이 없음)

```bash
# 1) 모놀리식 러너 — *.test.ts 는 디스커버리하지 않음
cd server && npx tsx src/test-runner.ts

# 2) node:test (server) 37개 — 파일별
cd server && npx tsx --test src/ws/binaryFrameCodec.test.ts
cd server && npx tsx --test src/ws/WsRouterSplitHandshake.test.ts
#   … (37개, 신규 포함)

# 3) frontend 단위 56개 + benchmarks 2개 — Playwright 미수집
cd frontend && node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts
cd frontend && node --experimental-strip-types --test tests/e2e/wave1-characterization-artifacts.test.ts

# 4) E2E — 30 spec / 465 테스트(3 project). Desktop Chrome 로 고정 권장
cd frontend && npx playwright test --project "Desktop Chrome"

# 5) daemon 19개 (server 빌드 선행 — §4.1 게이트를 통과해야 함)
npm run test:daemon

# 6) wave3 closure 22개 — 재귀 게이트 주의
node --test tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs   # 형제 21개 재실행
node --test tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs    # 9개 재실행

# 7) wave3 증거 스크립트 5개 (node:test 아님)
node tools/wave3/authority-promotion-evidence.test.mjs   # ⚠️ Playwright E2E 까지 실행
node tools/wave3/retained-shadow-parity.test.mjs
node tools/wave3/canary-admission-evidence.test.mjs
node tools/wave3/fair-scheduler-decision.test.mjs        # 벤치마크 실행
node tools/wave3/terminal-resource-consumer-manifest.test.mjs

# 8) wave1 / server tools
node --test tools/wave1/g1-decision-gate.test.mjs
node --test server/tools/write-fair-scheduler-evidence-bundle.test.mjs
```

> ⚠️ `authority-promotion-evidence.test.mjs` 는 2222 에 서버가 없으면 `start.bat` 으로 **프로덕션 서버**를 띄운다. `dev.js` 가 떠 있으면 `reuseExistingServer: true` (`frontend/playwright.config.ts:36`) 때문에 dev 번들을 검사하게 된다. 어느 쪽을 검사하는지 의식하고 돌릴 것.
>
> ⚠️ 장시간 dev 인스턴스는 E2E 를 오염시킨다 (메모리 `long_lived_dev_instance_degrades_e2e`: ~90분/15회 초과 시 workspace API 500). 바이너리 전환은 E2E 반복이 많으므로 **spec 배치마다 서버를 새로 띄운다.**

---

## 6. 왕복 테스트 전략

### 6.1 인코더/디코더 property test

**불변식 (S2):**

| ID | 불변식 | 비고 |
| --- | --- | --- |
| P1 | `decode(encode(m)) ≡ m` — 임의의 유효 메시지에 대해 | 핵심 왕복 |
| P2 | `encode(m).length === 21 + payloadBytes(m)` | 헤더 크기 계약 |
| P3 | `decode` 는 입력 버퍼를 변형하지 않는다 | 큐/재전송 안전성 |
| P4 | 연접 스트림 `encode(a)+encode(b)` 를 순서대로 정확히 2개로 분해 | 프레이밍 (WS 는 메시지 경계를 보존하지만 split/coalescing 이 이를 깰 수 있음 — `wsSendPolicy.ts:216`) |
| P5 | `sourceSeq` 가 `0`, `1`, `2^53-1`, `2^53`, `2^64-1` 에서 왕복 | §2.4 의 `Ordinal64 = string` ↔ u64 변환 |
| P6 | payload 가 UTF-8 다바이트(한글/이모지/결합문자/서로게이트 페어)일 때 바이트 보존 | 기존 자산이 이미 이 코퍼스를 씀 (`FairTerminalDeliveryScheduler.test.ts:467-468` 의 `'한글-alpha'`, `'🙂-beta'`) |
| P7 | payload 가 빈 바이트열(`length=0`)일 때 왕복 | 경계 |

**입력 생성 전략:** 이 저장소에 property-test 라이브러리가 없으므로 `[설계결정]` — 외부 의존성을 추가하지 말고 **결정론적 시드 기반 생성기를 테스트 파일 안에 둔다.** 기존 벤치마크가 이미 `--seed 20260723` 패턴을 쓴다 (`tools/wave3/fair-scheduler-decision.test.mjs:16-24`). 실패 시 시드를 출력해 재현 가능하게 한다.

### 6.2 교차 언어 골든 벡터 (S4)

서버 코덱과 브라우저 코덱은 **별개 구현**이다 (`server/src/ws/` ↔ `frontend/src/utils/`). 두 파일이 각자의 테스트에서 자기 자신과 왕복하면 **둘 다 틀려도 초록**이다 (`check_operands_must_have_independent_origins`).

→ **골든 벡터 파일 1개를 SSOT 로 둔다:**

```
server/src/ws/__fixtures__/binary-frame-vectors.json    (또는 공용 위치)
  [{ "name": "...", "message": {...}, "hexFrame": "01000000..." }, ...]
```

- 서버 테스트: `encode(message) === hex2bytes(hexFrame)` **및** `decode(hex2bytes(hexFrame)) ≡ message`
- 프론트 테스트: 같은 파일을 읽어 동일 단정
- **`hexFrame` 은 사람이 손으로 쓰거나 리뷰로 승인한 값이어야 한다.** 인코더 출력을 그대로 덤프해 fixture 로 만들면 두 피연산자의 출처가 다시 같아진다.

`[설계결정]` — fixture 파일 위치. `frontend/` 에서 `server/` 를 상대경로로 읽는 선례가 이미 있다 (`tools/wave3/*` 가 양쪽을 넘나듦). 단 `§10.2 중복 금지` 에 따라 **파일을 복사하지 말고 한 곳을 참조**한다.

### 6.3 Fault 케이스 + 경계 대조군 (S3) ⚠️ 필수

**규칙 (메모리 `boundary_control_for_fault_tests`):** 통과한 fault 테스트는 **fault 를 임계값 아래로 줄여 재실행**해야 한다. 그래도 실패하면 측정하던 것이 fault 가 아니었다.

| # | Fault | 기대 | **경계 대조군 (반드시 통과해야 함)** |
| --- | --- | --- | --- |
| F1 | 헤더가 잘림 (20바이트) | `TruncatedHeaderError` | **21바이트(헤더만, payload 0)** → **성공해야 함**. 실패하면 "잘림" 이 아니라 "빈 payload 미지원" 을 측정한 것 |
| F2 | payload 가 잘림 (`length=100` 인데 90바이트) | `TruncatedPayloadError` | **정확히 100바이트** → 성공. 그리고 **101바이트**(잉여 1) → 별도 오류이지 같은 오류가 아니어야 함 |
| F3 | 미지원 opcode (`0xFF`) | `UnknownOpcodeError` — **조용히 drop 금지** | **정의된 최대 opcode** → 성공. 미정의 최소값(예 정의가 1..5면 `6`) → 실패. 이 둘이 갈리지 않으면 opcode 검사가 아니라 다른 것을 재고 있다 |
| F4 | `length` 불일치 (선언 < 실제) | `LengthMismatchError` | `length` 를 정확히 실제와 맞춘 프레임 → 성공. **그리고 `length` 를 1 늘린 것과 1 줄인 것이 서로 다른 오류인지** 확인 (둘 다 같은 오류면 길이를 안 읽고 있을 수 있음) |
| F5 | 거대 payload (정책 상한 초과) | `PayloadTooLargeError` — 메모리 폭발 없이 | **상한 정확히** → 성공. **상한 - 1** → 성공. 상한 + 1 → 실패. 세 점이 다 확인돼야 상한을 재는 것 |
| F6 | `sourceSeq` u64 상한 초과 | 인코드 시점 거부 | `2^64-1` → 성공 |
| F7 | 바이너리 프레임이 JSON 파서에 도달 | 명시적 실패 (조용한 return 아님) | **JSON 프레임이 같은 경로로 오면 정상 처리** → 성공. 이게 실패하면 분기 자체가 망가진 것 |
| F8 | JSON 프레임이 바이너리 디코더에 도달 | 명시적 실패 | F7 의 대칭 |

**F5 의 추가 주의:** "거대 페이로드" 테스트는 실제로 큰 버퍼를 할당하면 CI 시간·메모리를 먹는다. `length` 필드에 큰 값을 **선언만** 하고 실제 버퍼는 작게 주는 방식(= F4 의 변형)으로 상한 검사를 구동한다. 단 그러면 "상한 검사" 가 아니라 "length 불일치 검사" 를 재게 될 수 있으므로, **길이 일치하는 큰 프레임 1개는 반드시 실제로 만들어** 한 번은 진짜로 확인한다.

### 6.4 이 전략이 방어하는 실패 모드

| 실패 모드 | 방어 |
| --- | --- |
| 두 구현이 같이 틀림 | §6.2 골든 벡터 (손으로 승인한 기대값) |
| fault 테스트가 엉뚱한 것을 잼 | §6.3 경계 대조군 |
| 인코딩 변경을 단정이 자동 추종 | §3.4 리터럴 기대값 |
| 프레임이 조용히 사라짐 | §3.3 + F7/F8 |
| 관측 0건인데 초록 | 각 테스트에 **관측 카운트 하한 단정** 추가 (`assert.ok(observedOutputFrames > 0)`) |

> 마지막 항목을 강조한다. §3.3 의 vacuous green 을 구조적으로 막는 유일한 방법은 **"몇 개를 봤는가" 를 단정하는 것**이다. 프레임 필터를 쓰는 모든 기존 테스트(`wave1-retained-state-characterization.spec.ts:674`, `wave3-terminal-authority-fairness.spec.ts:1574` 등)에 이 하한 단정을 추가하는 것을 **S10 의 일부로 포함한다.**

---

## 7. 혼합 버전 E2E

### 7.1 요구되는 시나리오

`#19` AC (`docs/issues/wave4-wave5/19-binary-data-plane.md:186`): *"unsupported/mixed-version frame 은 silent drop 하지 않고 JSON snapshot downgrade 또는 명시적 reconnect 로 수렴한다."*

즉 증명해야 하는 것은 "신버전이 잘 돈다" 가 아니라 **"구버전이 붙어도 조용히 망가지지 않는다"** 이다.

### 7.2 구버전 클라이언트를 만드는 법 — 기존 선례가 이미 있다

새 하네스를 만들 필요가 없다. `frontend/tests/support/perfBgstab010Ac6BrowserAckHarness.ts` 가 정확히 이 패턴이다:

- `:58` 브라우저 컨텍스트 안에서 **원시 `new WebSocket(...)`** 을 열고
- `:100-105` 자기 capability 를 **직접 선언**한다:
  ```js
  socket.send(JSON.stringify({
    type: 'terminal-delivery:capability',
    protocolVersion: 1,
    supportsHiddenDataGapRecovery: true,
  }));
  ```
- `:44-52` 자기 파서를 갖는다

**핵심:** capability 선언은 서버 설정이 아니라 **클라이언트가 보내는 메시지**다 (`WsRouter.ts:1956` 근처에서 처리). 따라서 **한 브라우저 안에서 서로 다른 버전의 클라이언트를 동시에 여는 것이 자연스럽게 가능하다.** split 소켓을 켤 필요가 없다 — §0.3 의 `REL-BGSTAB-006` AC-5 제약을 우회한다.

### 7.3 매트릭스

| # | 클라이언트 A (실제 앱) | 클라이언트 B (원시 프로브) | 기대 |
| --- | --- | --- | --- |
| M1 | 바이너리 지원 선언 | **codec 필드 자체를 안 보냄** (구버전 모사) | A 는 바이너리 수신, B 는 JSON 수신. **B 가 출력을 1건 이상 관측** (하한 단정) |
| M2 | 바이너리 지원 | `codec: 'json'` 명시 거부 | 위와 동일 + 서버 응답의 거부 사유가 관측 가능 |
| M3 | 바이너리 지원 | `codec: 'binary/v99'` (미래 버전) | **조용히 통과 금지.** 서버가 명시적으로 거부하고 JSON 으로 내려앉음 |
| M4 | 바이너리 지원 | 바이너리 지원하나 **디코드 실패를 주입** | B 가 명시적 재연결/JSON fresh snapshot 으로 수렴. 화면 구멍 없음 |
| M5 | 두 클라이언트 모두 바이너리 | — | 두 세션의 출력이 서로 섞이지 않음 (`channelId` 격리) |
| M6 | 8 클라이언트 혼합 (4 바이너리 / 4 JSON) | — | fair scheduler 의 lane 공정성이 인코딩과 무관 (`PERF-BGSTAB-010` AC-2) |

M6 의 클라이언트 수 축(`1 / 2 / 8`)은 연구 문서의 검증 매트릭스에서 온 것이다 (`docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:728-740`, `#21` 문서 `:56` 경유).

### 7.4 구현 위치와 주의

- 파일: 신규 `frontend/tests/e2e/binary-mixed-version.spec.ts`
- 지원 모듈: 신규 `frontend/tests/support/legacyJsonClientProbe.ts` — `perfBgstab010Ac6BrowserAckHarness.ts` 를 **복사하지 말고** 공용 부분을 추출한다 (`§10.2`). 단 그 하네스는 `frontend/tests/unit/perfBgstab010Ac6ServerAckFaultContract.test.ts` 가 **소스 텍스트로 고정**하고 있으므로(§3.2), 리팩터 시 그 정규식이 계속 만족되는지 확인해야 한다.
- 실행: `cd frontend && npx playwright test tests/e2e/binary-mixed-version.spec.ts --project "Desktop Chrome"`
- ⚠️ 프로젝트 3종(`Desktop Chrome` / `Mobile Safari` / `Tablet`, `frontend/playwright.config.ts:19-32`)을 다 돌면 3배가 된다. 저장소의 기존 `test:e2e:*` 스크립트가 전부 `--project "Desktop Chrome"` 로 고정된 이유다.
- ⚠️ `reuseExistingServer: true` (`:36`) 가 `!process.env.CI` 로 게이팅되어 있지 **않다**. CI 에 넣을 때 이 점을 주의 (§10).

### 7.5 관측 하한 단정 (필수)

각 시나리오는 **"구버전 클라이언트가 실제로 출력을 몇 건 받았는가"** 를 세고 하한을 단정해야 한다. 이것 없이는 M1~M4 가 전부 vacuous 하게 통과한다 — 구버전 프로브가 아무것도 못 받아도 "silent drop 이 없었다" 는 참이기 때문이다.

---

## 8. 마이그레이션 단계

기존 저장소에 **3단계 사다리 선례**가 있다: `stabilityModes.wsSendMode: 'direct' | 'safe-send-observe' | 'safe-send-enforce'` (`server/src/schemas/config.schema.ts:201`). 그리고 전송 모드에는 이미 shadow 개념이 있다: `wsTransportMode: 'unified' | 'split-shadow' | 'split'` (`:56`). **새 패턴을 만들지 말고 이 사다리를 따른다** (`§10.2 — 비슷한 것이 이미 있으면 새로 만들지 말고 확장한다`).

### 8.1 플래그 설계

```ts
// server/src/schemas/config.schema.ts  realtimeSchema (:55-57) 확장
wsFrameCodec: z.enum(['json', 'binary-shadow', 'binary-optin', 'binary']).default('json'),
```

⚠️ `realtimeSchema` 는 `.strict()` 다 (`:57`). 즉 **구버전 서버 + 신 필드를 담은 `config.json5` = 하드 거부**다. 이것은 §9 의 롤백 시나리오에 직접 영향을 준다 (구 빌드로 되돌리면 설정 파일을 못 읽는다 — `#21` 문서 `:75` 가 경고한 바로 그 상황). 그러나 `defaultObject()` 헬퍼(`:52-53`)가 섹션 부재를 `{}` 로 치환하므로 **필드를 추가하는 방향**은 안전하다. 문제는 되돌리는 방향뿐이다.

값이 하나 바뀌면 네 곳이 함께 움직인다 (`#21` 문서 `:33` 확인): 스키마 `config.schema.ts:56`, 서버 타입 `server/src/types/config.types.ts:184-186` 근방, 프론트 타입 `frontend/src/types/settings.ts:125-127` 근방, `server/config.json5` (현재 `realtime` 블록 자체가 없음 — 확인함).

### 8.2 단계별 진입/이탈 조건

#### 단계 1 — `binary-shadow` (둘 다 인코딩하고 비교, JSON 만 전송)

| 항목 | 내용 |
| --- | --- |
| **동작** | 서버가 output/snapshot 을 JSON 과 바이너리 **양쪽으로 인코딩**한다. 와이어에는 **JSON 만** 나간다. 바이너리는 디코드해서 JSON 과 **의미 동등성**을 비교하고 불일치를 카운트한다 |
| **진입 조건** | S1~S7 green. §4.1 republish 리허설 성공. §3.3 의 조용한 폐기 경로가 **전부** 명시 실패로 전환됨 |
| **측정** | ① 의미 불일치 건수 ② 인코딩 CPU 오버헤드(양쪽 다 하므로 증가함 — 감내 상한 필요) ③ 프레임당 바이트 절감 예측치 ④ fair scheduler capability `accepted` 비율 |
| **이탈 조건** | 불일치 **0건**을 목표 워크로드 전수에서. 워크로드 축은 `docs/research/2026-07-15.…ko.md:728-740` 의 client `1/2/8` × session `1/8/32/54` |
| **위험** | 사용자에게 노출되는 동작 변화가 없다. **가장 안전한 단계이므로 여기서 최대한 오래 머문다** |

> `split-shadow` 라는 기존 모드명과의 혼동 주의. 두 shadow 는 직교한다 (`wsTransportMode` × `wsFrameCodec`). `[설계결정]` — 조합 매트릭스 4×2 를 전부 지원할지, 아니면 `wsTransportMode === 'unified'` 에서만 바이너리를 허용할지. §0.3 의 `REL-BGSTAB-006` AC-5 를 고려하면 **후자를 권고**한다.

#### 단계 2 — `binary-optin` (선언한 클라이언트에만 바이너리)

| 항목 | 내용 |
| --- | --- |
| **동작** | capability 로 `codec: 'binary/v1'` 을 선언한 클라이언트에만 바이너리 전송. 나머지는 JSON. 기본 클라이언트는 **선언하지 않는다** |
| **진입 조건** | 단계 1 이탈 조건 충족. S8/S9/S12 green. §7 매트릭스 M1~M4 통과 |
| **측정** | ① 바이너리 세션의 화면 정합성(구멍/깨짐 0) ② downgrade 발생 건수와 사유 분포 ③ echo p50/p95/p99 (JSON 대조군 대비) ④ CPU 프로파일 — 서버·브라우저 **분리** (`#19` 문서 `:126-130` 이 요구) ⑤ ACK credit 원장 정합성 |
| **이탈 조건** | 화면 정합성 결함 0건 + downgrade 가 전부 **의도된 사유**로 설명됨 + echo 지표가 JSON 대비 회귀 없음 |
| **위험** | opt-in 사용자만 영향. 롤백 = 선언 중단 |

#### 단계 3 — `binary` (기본값 전환)

| 항목 | 내용 |
| --- | --- |
| **동작** | 기본 클라이언트가 `codec: 'binary/v1'` 을 선언. 미지원 클라이언트는 여전히 JSON |
| **진입 조건** | 단계 2 이탈 조건. §9 롤백 드릴이 **자동 테스트로** 반복 통과. `#21`(default flip) 이슈의 절차를 따름 |
| **측정** | `#21` 문서가 요구하는 rollout metric 전부 + 되돌리기 리허설 |
| **이탈 조건** | **두 릴리스 soak** (`docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:24` — *"외부 시간"*, 개발 속도로 앞당길 수 없음) |
| **위험** | 설정 안 건드린 전 사용자. `#21` 문서 `:75` — 설정 스키마가 바뀌었으면 구 빌드로 롤백해도 설정을 못 읽는다 (§8.1 의 `.strict()`) |

#### 단계 4 — legacy JSON 경로 제거

| 항목 | 내용 |
| --- | --- |
| **진입 조건** | 단계 3 이탈(두 릴리스 soak) + `#22` 이슈의 조건 |
| **주의** | `#22` 는 **"코드가 다 준비됐다" 만으로 닫을 수 없다** (`docs/issues/wave4-wave5/22-legacy-deletion.md:79`). 달력상 두 릴리스가 실제로 지나야 함 |
| **범위 주의** | JSON control 평면은 **제거 대상이 아니다.** 제거 대상은 output/snapshot 의 JSON 인코딩 경로뿐 |

### 8.3 단계 전이 시 반드시 확인할 것

각 전이마다 **fair scheduler 가 여전히 붙어 있는지** 확인한다. §4.1 때문에 pinned 파일을 만질 때마다 스케줄러가 조용히 떨어질 수 있고, 그 상태에서 성능 측정을 하면 **바이너리 전환의 효과가 아니라 스케줄러 부재를 측정하게 된다.**

확인 방법: capability 응답의 `accepted` 와 `reason` 을 로그/테스트에서 직접 읽는다. `#19` 문서 `:69` 가 요구하는 것과 동일한 규율이다.

---

## 9. 롤백 드릴 — 자동 테스트로 증명하기

### 9.1 계약

`#19` AC (`docs/issues/wave4-wave5/19-binary-data-plane.md:190`):

> rollback 은 binary epoch 종료 → reconnect/capability renegotiation → JSON fresh snapshot 이며 **binary queue 를 JSON 으로 재해석하지 않는다.**

즉 세 개의 별개 단정이다:
1. 바이너리 epoch 이 **종료**된다 (그 epoch 의 프레임은 이후 거부)
2. capability **재협상**이 일어난다
3. 서버가 **fresh snapshot** 을 새로 보낸다 — 큐에 남은 바이너리를 재활용하지 않는다

### 9.2 최소 테스트 — 이것만으로 롤백이 동작함을 증명한다

신규 `server/src/ws/WsRouterBinaryRollback.test.ts` (node:test, `npx tsx --test`, cwd=`server/`).

| ID | 시나리오 | 단정 | 이것이 없으면 놓치는 것 |
| --- | --- | --- | --- |
| R1 | 바이너리로 N 프레임 전송 후 롤백 트리거 | 롤백 후 **새 `connectionEpoch`** 가 부여됨. 이전 epoch ≠ 새 epoch | epoch 이 재사용되면 stale 프레임이 유효해짐 |
| R2 | 롤백 직후 이전 epoch 의 바이너리 프레임 도착 | **거부**되고 관측 가능한 프로토콜 오류. 처리되지 않음 | `PERF-BGSTAB-010` AC-8 (이전 credit/backlog 재사용 금지) |
| R3 | 롤백 시점에 전송 큐에 바이너리 프레임 K개가 남아 있음 | 큐가 **버려진다.** 그 K개가 JSON 으로 재인코딩되어 나가지 **않는다** | 계약이 명시 금지한 "binary queue 를 JSON 으로 재해석" |
| R4 | 롤백 후 첫 프레임 | `screen-snapshot` (JSON) 이고 `mode`/`seq` 가 **fresh** (이전 스냅샷의 연속이 아님) | 화면 구멍 |
| R5 | 롤백 후 화면 내용 | 롤백 직전의 논리 화면과 **동등**. 마커 문자열이 전부 보임 | 롤백이 데이터를 잃는지 |
| R6 | ACK credit 원장 | 롤백 시 held bytes / timer / queue 가 **정확히 한 번** 해제 | `PERF-BGSTAB-010` AC-8 |
| R7 | **경계 대조군** — 롤백을 트리거하지 **않음** | R1~R6 의 단정이 **전부 실패해야 함** (epoch 유지, 큐 유지, fresh snapshot 없음) | R1~R6 이 롤백과 무관한 것을 재고 있었을 가능성 |

**R7 이 핵심이다.** 롤백 테스트가 통과했다는 것만으로는 롤백을 측정했다는 증거가 아니다 (`boundary_control_for_fault_tests`). 롤백을 안 걸었는데도 같은 단정이 통과하면, 그 단정은 롤백이 아니라 세션 생성이나 재연결 일반을 재고 있었던 것이다.

### 9.3 E2E 층 (선택이지만 권장)

`frontend/tests/e2e/binary-rollback-drill.spec.ts`:
- 브라우저에 마커 문자열을 출력 → 롤백 트리거 → xterm 버퍼에 마커가 **여전히** 보이는지
- 화면 구멍(빈 줄/깨진 문자) 0건

선례: `frontend/tests/e2e/wave2-screen-repair-resync.spec.ts` 가 reload 세대 전환을 이미 검사하며(`:582` "reload did not establish a new WebSocket generation"), 같은 패턴을 재사용할 수 있다.

### 9.4 롤백 트리거의 종류 — 전부 같은 경로로 수렴해야 함

| 트리거 | 출처 |
| --- | --- |
| 설정 `wsFrameCodec` 을 `json` 으로 되돌림 (핫리로드) | `RuntimeConfigStore.ts:1254` 에 핫리로드 경로 존재 |
| 클라이언트 디코드 실패 | §7.3 M4 |
| capability 재협상 실패 | §4.1 의 `sourceDigest` 불일치도 여기로 들어옴 |
| 서버 재시작 후 구 빌드 | §8.1 의 `.strict()` 함정 |

**`[설계결정]`**: 네 트리거가 **하나의 롤백 함수**로 수렴해야 한다 (`§10.2 — 같은 책임을 두 곳이 나눠 갖지 않는다`). 네 경로가 각자 롤백을 구현하면 세 개만 고쳐지고 하나는 조용히 어긋난다.

---

## 10. CI

### 10.1 사실 확인 — "CI 가 테스트를 안 돈다" 는 참이다 (그리고 더 심하다)

| 확인 항목 | 결과 | 근거 |
| --- | --- | --- |
| 워크플로 파일 | **`.github/workflows/release.yml` 단 1개** | 디렉터리 전수 |
| 트리거 | `push.tags: ['v*.*.*','*.*.*']` + `workflow_dispatch`. **`pull_request` 없음, 브랜치 `push` 없음** | `release.yml:3-8` |
| 테스트 실행 | **0건.** `npm test`/`playwright`/`node --test`/`tsx src/test-runner.ts`/`test:daemon` 어느 것도 없음 | 전수 grep — `latest`(runs-on), JS `RegExp.test`(`:170,:173`), PowerShell `Test-Path`(`:221`) 만 매칭 |
| lint / typecheck | **0건** | 동일 |
| 유일한 품질 게이트 | 빌드 산출물/설정 존재 검증 | `release.yml:147-204` |
| 로컬 훅 | `.git/hooks/pre-commit` → `docs/.kiwi/hooks/pre-commit.mjs`. **전체 내용이 `process.exit(0)` (37바이트) — no-op** | 파일 확인 |
| 기타 CI 설정 | `.gitlab-ci.yml`, `azure-pipelines.yml`, `.husky/`, `lefthook`, `.pre-commit-config.yaml`, `Jenkinsfile`, `.circleci/` — **전부 부재** | `git ls-files` |
| 루트 `test` 스크립트 | **부재.** `test:daemon`, `test:daemon:wave5`, `test:docs`, `test:integration:native-daemon` 4개뿐이며 전부 `tools/daemon/` 만 겨냥 | `package.json:51-54` |
| 빌드가 provenance 게이트를 타는가 | **예.** `release.yml:145` → `tools/build-portable-runtime.js:343` `ensureBuildArtifacts()` → `tools/build-daemon-exe.js:761,764` (frontend → server) → `server/package.json:9` (`tsc && provenance && evidence-bundle`) | 확인 |

**즉 현재 회귀 방어선은 0 이다.** 프로토콜을 바꾸면서 이 상태를 유지하는 것은 §3.3 의 vacuous green 위험과 결합해 특히 나쁘다 — 아무도 안 돌리는 테스트가 조용히 무의미해져도 발견 경로가 없다.

### 10.2 최소 제안 — 새 워크플로 1개 (`.github/workflows/test.yml`)

`release.yml` 은 건드리지 않는다 (릴리스 파이프라인을 프로토콜 작업의 리스크에 노출시키지 않는다).

**Tier 0 — 반드시 (PR + push, 빠름, ~5분 목표)**

```yaml
on: [pull_request, push]
```

| # | 실행 | 이유 |
| --- | --- | --- |
| 1 | `cd frontend && npm run typecheck` (`frontend/package.json:12`) | 이미 존재하는 스크립트. `payload: string → string \| Uint8Array` 같은 타입 확장의 파급을 즉시 잡음 |
| 2 | `cd frontend && npm run lint` (`:11`) | 이미 존재 |
| 3 | `cd server && npx tsc --noEmit` | **build 를 타지 않으므로 provenance 게이트를 우회.** 전체 build 는 §4.1 때문에 pinned 파일 편집 중 항상 빨갛다 — Tier 0 에 넣으면 안 됨 |
| 4 | `cd server && npx tsx src/test-runner.ts` | 모놀리식 러너. **build 를 타지 않는다** (`npm --prefix server test` 는 build 를 타므로 쓰면 안 됨) |
| 5 | `cd server && npx tsx --test src/ws/*.test.ts` (파일별) | **바이너리 전환의 핵심 스위트.** 현재 CI 에 없고 test-runner 도 디스커버리하지 않음 |
| 6 | `cd frontend && node --experimental-strip-types --test tests/unit/*.test.ts` | 56개. **Playwright 가 수집하지 않으므로 이것 없이는 영원히 안 돔** |

> ⚠️ 항목 3/4 가 build 를 피하는 것이 의도적이다. §4.1 때문에 pinned 파일을 고치는 동안 `server/package.json:9` 의 build 는 정상적으로 실패한다. **build 를 Tier 0 에 넣으면 전환 기간 내내 CI 가 빨갛고, 그러면 아무도 안 본다.**

**Tier 1 — 권장 (PR, ~15분)**

| # | 실행 | 이유 |
| --- | --- | --- |
| 7 | `cd frontend && npx playwright test --project "Desktop Chrome"` (선별 spec) | §3.1 의 E2E 다수가 깨진다. 단 `webServer.command: 'cd .. && start.bat --port 2222'` (`frontend/playwright.config.ts:34`)는 **Windows 전용 `.bat`** 이라 ubuntu 러너에서 실패한다 → `runs-on: windows-latest` 필요하거나 launcher 를 크로스플랫폼화 `[설계결정]` |
| 8 | `npm run test:daemon` | 19개. **단 server build 를 탄다** — §4.1 게이트가 초록일 때만 |

**Tier 2 — 릴리스/야간 (느림)**

| # | 실행 | 이유 |
| --- | --- | --- |
| 9 | wave3 closure 게이트 2개 | 재귀 재실행이라 느림 |
| 10 | `node tools/wave3/authority-promotion-evidence.test.mjs` | Playwright E2E 까지 실행. §3.1 대로 전환 중 깨짐 |
| 11 | 전체 Playwright 3 project (465 테스트) | `Mobile Safari`/`Tablet` 은 현재 **어떤 스크립트로도 안 돌고 있음** |

### 10.3 CI 도입 시 반드시 손볼 것

| 항목 | 문제 | 처방 |
| --- | --- | --- |
| `reuseExistingServer: true` | `!process.env.CI` 로 게이팅되어 있지 않음 (`frontend/playwright.config.ts:36`) | CI 에서는 `false` 가 되도록 조건화. 안 그러면 앞선 job 의 서버를 재사용해 엉뚱한 번들을 검사 |
| `webServer.command` | `start.bat` — Windows 전용 (`:34`) | 러너를 windows 로 하거나 크로스플랫폼 launcher |
| `webServer.port` | `2222` 하드코딩 (`:35`, baseURL 파생) | 병렬 job 충돌 주의 |
| `timeout: 60000` / `retries: 1` | 바이너리 협상 실패는 **타임아웃으로 나타난다**(§3.3) | 실패 원인을 구분할 수 있게 §7.5 의 관측 하한 단정을 붙일 것 |
| `NODE_ENV=production` 함정 | `npm ci` 가 devDependencies 를 조용히 누락 | `env -u NODE_ENV npm ci` (메모리 `buildergate_npm_ci_node_env_production_silent_trap`). `tail` 로 파이프 금지 (exit code 은폐) |
| pre-commit no-op | `docs/.kiwi/hooks/pre-commit.mjs` 가 `process.exit(0)` | CI 가 생기면 로컬 훅은 그대로 둬도 됨. 다만 **"훅이 있으니 검사된다" 고 오해하지 말 것** |

### 10.4 최소한의 최소 — 하나만 넣는다면

**`cd server && npx tsx --test src/ws/binaryFrameCodec.test.ts` + `cd frontend && node --experimental-strip-types --test tests/unit/binaryFrameCodec.test.ts`.**

이 두 개가 §6.2 의 골든 벡터를 양쪽에서 검증하므로, **두 구현이 갈라지는 사고**(가장 발견이 늦고 가장 비싼 사고)를 막는다. 나머지는 사람이 §5.3 을 손으로 돌려도 되지만, 이것만은 자동이어야 한다.

---

## 11. 미확인 항목과 설계 결정 목록

### 11.1 `[미확인]`

| # | 항목 | 왜 미확인인가 |
| --- | --- | --- |
| U1 | fair-scheduler authority **republish 의 정확한 실행 절차** | `publishFairSchedulerAuthorityGeneration()` (`terminalFairnessCharacterization.ts:2224`)이 유일 진입점이나 CLI 가 없고 테스트에서 임시 디렉터리로만 호출됨. 실제 `docs/analysis/terminal-fairness-authority/` 대상 호출의 성공 사례를 확인하지 못함. **S0.5 리허설로 확정할 것** |
| U2 | 메모리 `fair_scheduler_republish_procedure` 의 "HEAD 를 읽는다" 기술 | 현재 소스는 워킹트리를 읽음(`write-fair-scheduler-source-provenance.mjs:28`). 이전 리비전 기준이었는지 다른 도구 기준이었는지 확인 못 함 |
| U3 | `retained-shadow-parity.test.mjs` 의 baseline 재생성 플래그 | CLAUDE.md 가 "`--regenerate-green` 등의 플래그를 받는다" 고 하나 정확한 플래그명을 확인하지 않음 |
| U4 | `sourceSegments`/`replayToken`/`repairToken` 등 잔여 output 필드의 프레임 배치 | 초안 헤더 21B 에 안 들어감. §2.4 참조 |
| U5 | 브라우저 → 서버 방향도 바이너리로 갈지 | 본 문서는 서버 → 브라우저만 전제. `webSocketBackpressure.test.ts` 의 `serializedPayload: string` 계약이 여기 걸림 |
| U6 | `Mobile Safari` / `Tablet` project 에서 `ArrayBuffer` WS 수신 동작 | 현재 이 두 project 를 도는 스크립트가 없어 기준선 자체가 없음 |
| U7 | evidence-bundle 매니페스트(CLAUDE.md 기재의 build 실패 함정)와 §4.1 `sourceDigest` 게이트가 서로 독립인지 | evidence-bundle 은 `docs/analysis/…` 만 검증하고 `server/src` 를 읽지 않음을 확인했으나, 두 게이트가 동시에 빨개질 때의 진단 순서를 실측하지 않음 |

### 11.2 `[설계결정]` — SRS(S0)에서 확정해야 할 것

| # | 결정 사항 | 권고 | §참조 |
| --- | --- | --- | --- |
| D1 | ACK credit encoded-byte 도메인의 정의 | **payload 바이트만** (인코딩 독립) | §3.4 |
| D2 | 잔여 output 필드의 프레임 배치 | 가변 헤더 확장 vs payload 서브헤더 vs 별도 control 프레임 | §2.4, U4 |
| D3 | `wsFrameCodec` × `wsTransportMode` 조합 범위 | `unified` 에서만 바이너리 허용 (`REL-BGSTAB-006` AC-5 준수) | §8.2 |
| D4 | 골든 벡터 fixture 의 물리 위치 | 한 곳에 두고 양쪽에서 참조 (복사 금지) | §6.2 |
| D5 | 롤백 트리거 4종의 수렴 지점 | 단일 롤백 함수 | §9.4 |
| D6 | `--expect-red` 모드의 RED 증거 처분 | baseline 갱신 vs "superseded" 명시 종결 | §4.3 |
| D7 | property test 입력 생성기 | 외부 의존성 없이 시드 기반 자체 구현 | §6.1 |
| D8 | Playwright CI 러너 OS | `windows-latest` vs launcher 크로스플랫폼화 | §10.2 |
| D9 | opcode 공간 설계 | 초기 정의 집합과 예약 구간. F3 의 경계 대조군이 성립하려면 "정의된 최대값" 이 명확해야 함 | §6.3 |

---

## 12. 착수 전 체크리스트

```
[ ] S0  wave-5 SRS 요구 작성 (§0.3) — 없이는 코드 작성 불가
[ ] D1~D9 결정 (§11.2)
[ ] S0.5 provenance republish 리허설 성공 (§4.1)
        └ 실패 시: 여기서 중단하고 "착수 불가 + 사유" 보고
[ ] §3.3 조용한 폐기 경로 7곳 목록화 및 담당 지정
[ ] §5.3 회귀 전수 커맨드가 현재 상태에서 전부 green 임을 기준선으로 확보
        └ 전환 후 red 를 "우리가 깬 것" 과 "원래 깨져 있던 것" 으로 구분하기 위함
[ ] §10.2 Tier 0 CI 워크플로 도입 (build 를 타지 않는 4개)
```

---

## 부록 A — 파일별 빠른 참조

| 역할 | 경로:줄 |
| --- | --- |
| 서버 인코드 seam | `server/src/ws/wsSendPolicy.ts:91`, 바이트 `:95` |
| `payload: string` 타입 제약 | `server/src/ws/wsSendPolicy.ts:16` |
| output coalescing (문자열 연접) | `server/src/ws/wsSendPolicy.ts:216`, `:246` |
| fair delivery 바이트 산정 | `server/src/ws/wsSendPolicy.ts:598` |
| fair scheduler 본체 | `server/src/ws/wsSendPolicy.ts:625` |
| 소켓 write seam | `server/src/ws/WsRouter.ts:6268` |
| capability 아티팩트 게이트 | `server/src/ws/WsRouter.ts:1956-1966` |
| dataGap 이중 왕복 | `server/src/ws/WsRouter.ts:5099` ↔ `:5846` |
| 브라우저 디코드 seam | `frontend/src/contexts/WebSocketContext.tsx:687` |
| 브라우저 조용한 폐기 | `frontend/src/contexts/WebSocketContext.tsx:688-690` |
| 소켓 생성 (binaryType 미설정) | `frontend/src/contexts/WebSocketContext.tsx:1007`, `:1201` |
| 전송 모드 enum | `server/src/ws/wsTransportMode.ts:1-2` |
| config 플래그 자리 | `server/src/schemas/config.schema.ts:55-57` (`.strict()`) |
| 3단계 사다리 선례 | `server/src/schemas/config.schema.ts:199-203` |
| provenance 고정 6파일 | `server/tools/write-fair-scheduler-source-provenance.mjs:7-14` |
| provenance 워킹트리 읽기 | `server/tools/write-fair-scheduler-source-provenance.mjs:28` |
| sourceDigest 게이트 | `server/src/benchmarks/terminalFairnessCharacterization.ts:1675` |
| sourceDigest 계산 | `server/src/benchmarks/terminalFairnessCharacterization.ts:280-300` |
| 런타임 검증 체인 | `server/src/services/TerminalResourcePolicyCanary.ts:346` → `:279` → `:386` → `:584` |
| 테스트 소스 해시 고정 | `tools/wave3/retained-shadow-parity.test.mjs:18-23`, `:161` |
| 프론트 소스 해시 고정 (red 전용) | `tools/wave3/authority-promotion-evidence.test.mjs:129-140`, 모드 `:2470` |
| 실 WS 프로브 (green) | `tools/wave3/authority-promotion-evidence.test.mjs:938` |
| 구버전 클라이언트 선례 | `frontend/tests/support/perfBgstab010Ac6BrowserAckHarness.ts:58`, `:100-105` |
| CI (유일) | `.github/workflows/release.yml:3-8` (태그 전용, 테스트 0건) |
| Playwright 설정 | `frontend/playwright.config.ts:7`, `:19-32`, `:33-38` |
