# SDS: 터미널 데이터 평면 바이너리 opt-in — shadow 배선에서 negotiated 송신까지

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-09-21.binary-data-plane-optin |
| Target | wave-5 |
| Status | agreed |
| Date | 2026-09-21 |

## 1. Context & Scope

`realtime.terminalWireFormat` 사다리(`json`→`binary-shadow`→`binary-optin`→`binary`)와 코덱·협상·채널 부품은 이미 있으나 송신 경로에 연결되어 있지 않다: `WsRouter` 의 `createWsTransportMessage` 호출 4곳이 `codec` 을 넘기지 않아 설정값과 무관하게 항상 JSON 이 나간다(2026-09-21 실측). 이 SDS 는 그 배선을 `binary-shadow` 와 `binary-optin` 두 단계로 끝내는 것까지를 범위로 한다. 기본값 전환(`MIG-BGSTAB-004`)과 evidence bundle 재발행(`PERF-BGSTAB-011` AC-4~AC-8)은 범위 밖이다.

## 2. Goals / Non-goals

- Goal: `binary-shadow` 에서 서버가 output/snapshot/checkpoint 페이로드를 양쪽 코덱으로 인코딩하고 자기 프레임을 디코드해 JSON 본문과 대조하되 와이어는 JSON 을 유지한다(`IR-BGSTAB-001` AC-3 의 shadow 허용).
- Goal: `binary-optin` 에서 협상된 그룹에게 데이터 평면을 바이너리 프레임으로 송신하고, 브라우저가 기존 `onOutput(delivery)` 단일 경로로 배달한다(`FR-BGSTAB-024` AC-1·AC-2).
- Goal: 롤백 트리거 4종(핫리로드·클라 디코드 실패·재협상 실패·구빌드 재시작)을 단일 함수로 수렴하고 정적 caller-contract 로 우회 0 을 증명한다(`IR-BGSTAB-001` AC-4).
- Goal: coalescing 이 codec epoch 를 보존한다 — 병합 결과가 epoch 중간에 JSON 으로 강등되지 않는다(`IR-BGSTAB-001` AC-3, `PERF-BGSTAB-011` AC-2).
- Non-goal: 한 WS 메시지에 프레임 여러 개를 싣는 batching(`PERF-BGSTAB-011` AC-10). v1 은 프레임 1개/메시지, `END_OF_BATCH` 상시 set.
- Non-goal: `sourceSegments` 를 가진 output 의 바이너리 coalesce(AC-2 배제 조항 그대로 유지 — JSON 과 동일하게 병합하지 않음).
- Non-goal: control 평면 인코딩 변경, `wsTransportMode` 변경, 기본값 전환, legacy JSON 경로 삭제, UI 변경.

## 3. Architecture Decisions

- **Decision**: 단일 인코더 진입점은 `createWsTransportMessage(..., codec)` 의 기존 4번째 인자다. `WsRouter` 에 `transportCodecFor(ws, message)` 하나를 두고 터미널 페이로드 송신 4곳이 그것만 거친다. / basis: `wirePayload.encodeFor` 가 이미 "binding 없음·opcode 없음·인코더 거절 → JSON" 의 3중 fallback 을 구현하고 있어 새 seam 을 만들 이유가 없다. / trade-off: 4곳 모두 손대야 한다. / rejected: `sendTransportMessage` 안에서 재인코딩 — payload 가 이미 확정된 뒤라 byteLength 도메인(AC-10)이 두 번 계산된다.
- **Decision**: `encodeBinary(message, opcode)` 는 `TerminalBinaryGroupSession` 에 새로 두는 `lookupChannel(sessionId)` 로 `channelId·streamEpoch` 를 얻고, 그룹의 `codecEpoch` 를 스탬프해 `binaryFrameCodec.encodeFrame` 을 부른다. 채널이 없으면 `undefined` 를 돌려 JSON 으로 내려간다. / basis: 인터페이스에 `openChannel/closeSession` 만 있고 역조회가 없다 — 송신 시 필요한 것이 정확히 역조회다. / trade-off: 그룹 세션에 Map 하나 추가. / rejected: `subscribed` 응답에 실린 channelId 를 클라이언트가 되돌려주게 하기 — 서버가 자기 권위 상태를 클라이언트에 물어보는 꼴이다.
- **Decision**: coalescing(`wsSendPolicy.coalesceOutput`)은 병합 결과를 `existing.payload.codec` 과 같은 codec 으로 재인코딩한다. 두 입력의 codec 이 다르면 병합하지 않는다. / basis: 지금 구현은 codec 없이 재구성해 binary 그룹의 병합 결과가 JSON 이 된다 — 같은 epoch 에 두 인코딩을 섞는 AC-3 위반이 조용히 발생한다. / trade-off: coalesce 함수가 codec 팩토리를 받아야 한다. / rejected: binary 그룹에서 coalescing 을 끄기 — 대역폭 이득의 상당 부분을 버린다.
- **Decision**: shadow 대조는 `decodeWsMessage(우리 프레임)` 의 body 를 UTF-8 디코드해 JSON `data` 와 문자열 동일성으로 비교하고, 불일치는 그룹 단위 카운터 `shadowMismatch` 에 기록하고 그 그룹의 shadow 인코딩을 멈춘다(와이어는 원래 JSON 이므로 롤백 불필요). / basis: AC-3 이 shadow 를 명시 허용하고, 실제 디코더로 대조해야 인코더-디코더 쌍을 검증한다. / trade-off: shadow 구간에서 인코딩 CPU 2배(실측 프레임당 +5.8us). / rejected: 바이트 동일성 비교 — JSON 본문과 프레임 바이트는 애초에 같을 수 없다.
- **Decision**: 롤백 단일 함수 `rollbackTerminalBinaryGroup(groupKey, trigger)` 는 그룹의 admission 을 닫고 `codecEpoch` 를 올린 뒤 채널 전부를 `terminal-binary:channel-retired` 로 회수하고 `MIG-BGSTAB-002` AC-5 순서의 기존 fresh-checkpoint 경로를 세션마다 호출한다. 4 트리거는 이 함수만 부른다. / basis: `sendTransportMessage` 가 이미 stale `codecEpoch` 프레임을 드롭하므로 epoch bump 만으로 in-flight 프레임이 안전해진다. / trade-off: 트리거 사이트 4곳에 caller-contract 테스트. / rejected: 트리거별 개별 처리 — AC-4 가 금지.
- **Decision**: `terminalWireFormat` 핫리로드는 `RuntimeConfigStore` 가 `WsRouter.applyTerminalWireFormat(next)` 를 부르고, 그 함수는 값이 좁아질 때(`optin/binary`→`shadow/json`)만 모든 협상 그룹에 롤백 함수를 호출한다. 넓어질 때는 다음 협상부터 적용. / basis: 지금 `WsRouter.terminalWireFormat` 이 `readonly` 라 트리거 #1 이 존재하지 않는다. / trade-off: `readonly` 해제. / rejected: 재시작 요구 — AC-4 가 핫리로드를 롤백 트리거로 명시.
- **Decision**: 브라우저 배달은 기존 `intakeBinaryFrames.deliverOutput → sessionHandlers.get(id).onOutput(delivery)` 를 그대로 쓰고 새 코드를 만들지 않는다. / basis: JSON `case 'output'` 도 같은 `onOutput` 으로 끝난다 — 이미 단일 진입점이다(FR-024 AC-2). / trade-off: 없음. / rejected: 별도 바이너리 스케줄러 — AC-2 가 금지.

## 4. Interfaces

- `TerminalBinaryGroupSession.lookupChannel(sessionId: string): { channelId: number; streamEpoch: string } | undefined` — 열린 채널의 역조회. 회수된 채널은 `undefined`.
- `TerminalBinaryGroupSession.shadowMismatch: number` · `haltShadow(): void` — shadow 대조 실패 카운터와 그룹 단위 중지.
- `WsRouter.transportCodecFor(ws: WebSocket, message: object): WsTransportCodec | undefined` — 그룹 `wireDecision()` 이 `encodeBinary=false` 이거나 채널이 없으면 `undefined`(=JSON). 터미널 페이로드 송신의 유일한 codec 공급원.
- `WsRouter.rollbackTerminalBinaryGroup(groupKey: string, trigger: 'hot-reload' | 'client-decode-failure' | 'renegotiation-failed' | 'server-restart'): void` — 유일한 롤백 진입점.
- `WsRouter.applyTerminalWireFormat(next: TerminalWireFormat): void` — 핫리로드 수신. 좁아질 때만 롤백.
- `coalesceOutput(existing, incoming, codecFor: (sessionId) => WsTransportCodec | undefined)` — 기존 시그니처에 codec 팩토리 추가. `existing.payload.codec !== incoming.payload.codec` 이면 `null`.
- 클라이언트 `terminal-binary:decode-failure` 보고 — `intakeBinaryFrames` 의 `report.fatal` 발생 시 서버로 보내는 control 메시지(JSON). 서버는 이것을 트리거 #2 로 롤백 함수에 연결한다. (`IR-BGSTAB-001` AC-11 의 5개 type 집합에 추가하는 것이 아니라, 기존 `terminal-binary:unknown-channel` 과 나란한 클라→서버 보고다 — AC-11 확장 여부는 §7.)

## 5. Acceptance Contracts

- SDS-AC-1: WHEN `terminalWireFormat=json` THE SYSTEM SHALL 4개 송신 지점 모두에서 `codec=undefined` 로 `createWsTransportMessage` 를 호출하고 바이너리 인코더를 한 번도 실행하지 않는다.
- SDS-AC-2: WHEN `terminalWireFormat=binary-shadow` 이고 그룹이 협상되지 않았어도 THE SYSTEM SHALL output/snapshot/checkpoint 페이로드를 바이너리로도 인코딩하고 자기 디코더로 복원한 본문이 JSON `data` 와 문자열 동일함을 확인하되, 와이어에는 JSON 텍스트 프레임만 보낸다.
- SDS-AC-3: WHEN shadow 대조가 한 번 실패하면 THE SYSTEM SHALL 그 그룹의 `shadowMismatch` 를 증가시키고 이후 그 그룹의 shadow 인코딩을 멈추며, 와이어 송신과 다른 그룹에는 영향을 주지 않는다.
- SDS-AC-4: WHEN `terminalWireFormat=binary-optin` 이고 그룹이 협상되었으면 THE SYSTEM SHALL `SERVER_TO_CLIENT_OPCODE_BY_TYPE` 에 있는 type 의 페이로드를 `ws.send(bytes, {binary:true})` 로 보내고, 같은 소켓의 control 메시지는 JSON 텍스트 프레임으로 보낸다.
- SDS-AC-5: WHEN 협상된 그룹에서 채널이 없는 세션의 output 이 송신되면 THE SYSTEM SHALL 그 메시지만 JSON 으로 보내고, 이를 `codec-fallback` 카운터에 기록한다.
- SDS-AC-6: WHEN 협상된 그룹의 인접 output 두 개가 coalesce 조건을 만족하면 THE SYSTEM SHALL 병합 결과를 원래와 같은 codec·codecEpoch 로 재인코딩하고, 두 입력의 codec 이 다르면 병합하지 않는다.
- SDS-AC-7: WHEN 롤백 트리거 4종 중 어느 것이 발생하면 THE SYSTEM SHALL `rollbackTerminalBinaryGroup` 하나를 통해 admission 중지 → `codecEpoch` 증가 → 채널 전부 `channel-retired` → 세션별 fresh checkpoint 순서로 처리하고, 이후 그 그룹의 송신은 JSON 이다.
- SDS-AC-8: WHEN production 소스를 정적으로 스캔하면 THE SYSTEM SHALL 터미널 페이로드를 `createWsTransportMessage` 로 만드는 호출이 `transportCodecFor` 를 거치지 않는 경우 0개, 롤백을 `rollbackTerminalBinaryGroup` 밖에서 수행하는 경로 0개임을 보인다.
- SDS-AC-9: WHEN 브라우저가 바이너리 output 프레임을 받으면 THE SYSTEM SHALL JSON `output` 과 동일한 `sessionHandlers.get(id).onOutput(delivery)` 로 배달하고, ASCII·CJK wide·combining·ZWJ emoji·split ANSI 코퍼스에서 두 경로의 terminal state hash 가 같다.
- SDS-AC-10: WHEN 브라우저 디코드가 `fatal` 로 실패하면 THE SYSTEM SHALL `terminal-binary:decode-failure` 를 보내고 서버는 그것을 트리거 #2 로 롤백 함수에 넘기며, 해당 view 는 stale 로 표시되고 PTY producer 와 다른 클라이언트는 계속 동작한다.
- SDS-AC-11: WHEN `terminalWireFormat` 이 런타임에 `binary-optin`→`json` 으로 바뀌면 THE SYSTEM SHALL 모든 협상 그룹에 트리거 #1 로 롤백 함수를 호출하고, `json`→`binary-optin` 으로 바뀌면 기존 그룹을 건드리지 않고 다음 협상부터 허용한다.
- SDS-AC-12: WHEN 어떤 codec 으로든 output 이 송신되면 THE SYSTEM SHALL 공정 전달 `encodedBytes` 는 본문 UTF-8 바이트로, 큐·고수위 판정은 와이어 `byteLength` 로 계상하며 두 도메인을 혼용하지 않는다.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | `server/src/ws/WsRouterWireCodec.test.ts` | json 설정에서 인코더 spy 호출 0, 4 지점 codec undefined |
| SDS-AC-2 | 같은 파일 | shadow: 인코더 호출·디코더 대조 통과·`ws.send` 인자는 string |
| SDS-AC-3 | 같은 파일 | 디코더 stub 이 불일치 반환 → 카운터 1, 이후 인코더 미호출, 다른 그룹 정상 |
| SDS-AC-4 | 같은 파일 | optin+협상: output 은 `{binary:true}`, `ping/pong` 은 text |
| SDS-AC-5 | 같은 파일 | 채널 미개설 세션 → JSON + `codec-fallback` 1 |
| SDS-AC-6 | `server/src/ws/wsSendPolicyCoalesceCodec.test.ts` | binary 두 개 → binary 하나(같은 epoch); binary+json → null |
| SDS-AC-7 | `server/src/ws/terminalBinaryRollback.test.ts` | 4 트리거 각각 → 순서 단언(admission→epoch→retired→checkpoint), 이후 JSON |
| SDS-AC-8 | `server/src/ws/terminalBinaryCallerContract.test.ts` | 소스 정적 스캔(주석 제거 후): 우회 호출 0 — `no-broad-kill` 의 comment-blanking 재사용 |
| SDS-AC-9 | `frontend/tests/unit/binaryOutputParity.test.ts` | 코퍼스 5종 × (JSON 경로, 바이너리 경로) state hash 동일; `onOutput` 단일 호출 |
| SDS-AC-10 | `frontend/tests/unit/binaryDecodeFailure.test.ts` + 서버 롤백 테스트 | fatal → `decode-failure` 송신; 서버 수신 → 트리거 #2 |
| SDS-AC-11 | `server/src/ws/WsRouterWireFormatReload.test.ts` | 좁아짐 → 전 그룹 롤백; 넓어짐 → 무변화 |
| SDS-AC-12 | `server/src/ws/FairTerminalDeliveryScheduler.test.ts`(확장) | 같은 본문의 json/binary delivery 크레딧 동일, byteLength 는 상이 |

## 7. Open Questions

- **차단(사업 결정)**: `IR-BGSTAB-001` AC-12 는 `FR-BGSTAB-017`(recovery write gate, 현재 `planned`) 충족 뒤에만 바이너리 협상을 활성화하라고 한다. 선택지: (a) FR-017 을 먼저 구현, (b) AC-12 를 승계해 shadow/optin 을 gate 앞에 두고 `binary`(기본값) 승급만 gate 뒤로 미룸. shadow 는 와이어 불변이므로 (b) 의 위험은 optin 구간에 한정된다. **결정 전에는 SDS-AC-4 이후의 red 테스트를 쓰지 않는다.**
- `PERF-BGSTAB-011` AC-9: 크레딧 도메인 전환(코드에는 이미 반영, AC 미체크)의 단독 효과 측정이 optin 활성화 앞에 요구된다. 측정만 하고 AC 를 체크하는 것으로 충족되는지, 별도 evidence 가 필요한지.
- `terminal-binary:decode-failure` 를 `IR-BGSTAB-001` AC-11 의 닫힌 5-type 집합에 6번째로 추가할지(AC-11 승계 필요), 아니면 기존 `terminal-binary:unknown-channel` 에 `reason` 필드로 실을지.
- shadow 대조 실패 시 로그 레벨과 노출 위치(`/api/runtime-config`? 텔레메트리?).
