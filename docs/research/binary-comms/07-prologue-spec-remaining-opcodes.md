# 바이너리 프레임 프롤로그 — 미정의 4종 사양 (`0x03` · `0x04` · `0x06` · `0x07`)

> **입력 문서**: `01-frame-format-and-negotiation.md` (프레임 포맷 정본), `06-work-plan.md` §5 D15 (차단 항목 등재)
> **대상 코드**: `server/src/ws/binaryFrameCodec.ts` (S2 산출물), `server/src/types/ws-protocol.ts`, `frontend/src/types/ws-protocol.ts`
> **거버넌스**: `REL-BGSTAB-007` AC-4 (Ordinal64 wire type), `PERF-BGSTAB-010` AC-4 (새 정책 상수 금지) — 두 요구를 제약으로 준수한다. 이 문서는 코드·테스트를 변경하지 않는다.
> **이 문서는 `01`~`06` 을 수정하지 않는다.** `01 §1.8` 에 대한 증분 사양이며, 채택 시 `01 §1.8` 로 병합하는 것이 정본화 경로다.

---

## 0. 요약

`01 §1.8`(`01:484-526`)이 프롤로그를 `0x01`/`0x02`/`0x05` 세 개에만 정의했다. 그 결과 `binaryFrameCodec.ts:108-118` 의 `prologueBytes()` 가 나머지 넷에 `0` 을 반환하고 `assertEncodableHead` (`binaryFrameCodec.ts:411-416`)가 인코딩을 거부한다. `06:1265-1276` 이 이것을 **S4 착수 차단 항목 D15** 로 등재했고, 제시된 두 안 중 **(a) 나머지 4개 프롤로그 레이아웃 추가** 를 이 문서가 수행한다.

| opcode | 메시지 (S→C) | 선언 | 프롤로그 | 본문 | flags |
|---:|---|---|---:|---|---|
| `0x03` | `ScreenRepairMessage` | `server/src/types/ws-protocol.ts:648-660` | **24 B** | `ansiPatch` UTF-8 | `0x0009` |
| `0x04` | `TerminalCheckpointStartMessage` | `:81-94` | **160 B** | `parserTail` 원시 바이트 | `0x0009` |
| `0x06` | `TerminalCheckpointCommitMessage` | `:103-109` | **88 B** | **없음 (0 B)** | `0x0009` |
| `0x07` | `TerminalCheckpointOutputMessage` | `:111-114` | **12 B** | payload 원시 바이트 | `0x0009` |

주요 판정:

1. **`viewportRows[]` 는 wire 에서 완전히 제거된다** (§1.4). 클라이언트가 읽는 것은 `.length` 뿐이고, 그 길이는 항상 `rows` 와 같다. 이것이 `0x03` 바이너리화의 최대 이득이며 대역폭 이득의 대부분이다.
2. **`0x06` commit 은 바이너리 이득이 "거의 없다"는 `01:175` 의 전제가 틀렸다** (§8.3). commit 은 sha256 hex 문자열 **두 개**(각 71자)와 Ordinal64 decimal 5개를 싣는다. 116 B 로 줄어든다.
3. **`01:175` 가 말한 "한 `sourceSeq` 연속열" 은 두 해석 모두에서 성립하지 않는 서술이었다** (§6). 다만 **요구 자체는 이 설계로 충족된다** — 근거가 `01:175` 가 든 것과 다르다.
4. **거부 코드는 1개만 신설하면 된다** (§5.5). `01:933-943` 의 wire 어휘 10종은 손대지 않는다. 신설분은 S2 가 이미 만든 **decoder-policy 코드** 계열(`binaryFrameCodec.ts:140-158`)에 들어간다.
5. **4종 모두 바이너리 평면으로 옮긴다. 다만 세 가지가 control 평면에 남아야 한다** (§7) — 토큰 인덱스 매핑, `retentionPolicyId`, `screen-repair` 의 C→S 절반.
6. **인덱스 `0` 은 "absent" 로 예약한다** (§8.2). `01 §1.8` 이 `authorityEpochIndex`/`replayTokenIndex` 의 `0` 을 정의하지 않아 생긴 공백이며, 기존 `0x01`/`0x02` 에도 소급 적용해야 한다.

---

## 1. `0x03` SCREEN_REPAIR

### 1.1 메시지 shape 근거

**대상은 S→C 패치 전용이다.** `screen-repair` 라는 `type` 문자열은 양방향에 존재하고 구조가 전혀 다르다 — C→S 요청은 `ScreenRepairRequestMessage` (`server/src/types/ws-protocol.ts:618-626`), S→C 패치는 `ScreenRepairMessage` (`:648-660`). `01:173` 이 opcode 네임스페이스를 방향별로 분리했고 `binaryFrameCodec.ts:63-70` 이 그 결정을 주석으로 못 박았다. **`0x03` 은 `:648-660` 만을 가리킨다.**

```ts
// server/src/types/ws-protocol.ts:648-660
export interface ScreenRepairMessage {
  type: 'screen-repair';
  sessionId: string;
  repairToken: string;
  seq: number;
  cols: number;
  rows: number;
  bufferType: ScreenRepairBufferType;
  cursor: { x: number; y: number; hidden?: boolean };
  viewportRows: ScreenRepairRowPatch[];
  ansiPatch: string;
  source: 'headless';
}
```

`ScreenRepairRowPatch` = `{ y, ansi, text, wrapped }` (`:641-646`). `ScreenRepairBufferType = 'normal' | 'alternate'` (`:567`).

**유일한 송신 지점**: `server/src/ws/WsRouter.ts:3224-3236`. 필드값의 출처는 `repair.payload` (`server/src/utils/headlessTerminal.ts:100-108` `HeadlessScreenRepairPayload`)이고, `repairToken` 만 `pending.repairToken` 에서 온다.

### 1.2 front/server drift

**없음.** `server/src/types/ws-protocol.ts:641-660` 과 `frontend/src/types/ws-protocol.ts:717-736` 을 `diff` 한 결과 **0 diff**(exit 0). `ScreenRepairBufferType` 도 양측 동일(`server:567` / `frontend:643`).

`01:1197` 이 지적한 drift 는 `terminal-authority:*` 계열에 국한되며 `screen-repair` 에는 해당하지 않는다.

### 1.3 필드 분류표

| 필드 | 타입 | 배치 | 사유 |
|---|---|---|---|
| `type` | `'screen-repair'` | **opcode** | `01:534`. `opcode` 로 대체 |
| `sessionId` | `string` (UUID 아닐 수 있음) | **channelId** | `01:324-334`. 36 B → uint32 |
| `repairToken` | `string` (uuidv4, `WsRouter.ts:3869`) | **프롤로그 (인덱스)** | UUID 16 B → uint16 별칭. `01:550-552` 의 `replayTokenIndex` 와 동일 기법. 매핑은 JSON control (§7.1) |
| `seq` | `number` | **프롤로그 uint64** | 값은 세션 `screenSeq` (`SessionManager.ts:6231` `seq: data.screenSeq`). `01:546` 와 같은 이유로 8 B — 세션 수명 동안 리셋되지 않으므로 4 B 는 조용히 wrap 한다 |
| `cols` | `number` | **프롤로그 uint16** | `0x02` 와 동일 폭 (`01:550`) |
| `rows` | `number` | **프롤로그 uint16** | 같음 |
| `bufferType` | `'normal' \| 'alternate'` | **프롤로그 uint8** | 2값 enum. `0x02` 의 `mode` u8 (`01:550`)과 같은 슬롯(프롤로그+12) |
| `cursor.x` | `number` | **프롤로그 uint16** | `buffer.cursorX` (`headlessTerminal.ts:491`) — 뷰포트 상대값이라 `cols` 범위 |
| `cursor.y` | `number` | **프롤로그 uint16** | `buffer.cursorY` (`:492`) — `rows` 범위 |
| `cursor.hidden` | `boolean?` | **프롤로그 uint8** | `state.cursorHidden` (`:493`). 선언은 optional 이므로 3상태(0/1/2=absent) |
| `viewportRows[]` | `ScreenRepairRowPatch[]` | **제거** | §1.4 |
| `ansiPatch` | `string` | **본문** | UTF-8 바이트열. 실제로 xterm 에 쓰이는 유일한 데이터 (`TerminalView.tsx:2673` `writeReplayDataWithProbe(term, repair.ansiPatch)`) |
| `source` | `'headless'` | **제거** | 타입이 단일값 리터럴(`:659`)이고 유일 송신 지점도 리터럴(`WsRouter.ts:3235`). 디코더가 상수로 재구성 |

### 1.4 `viewportRows[]` 제거 — 근거

세 가지 사실이 겹친다.

1. **클라이언트는 `.length` 만 읽는다.** `frontend/src` 전수 grep 결과 `viewportRows` 참조는 두 곳뿐이고 둘 다 `.length` 이며 둘 다 진단 이벤트 필드다 — `TerminalContainer.tsx:2894` (`rowCount: repair.viewportRows.length`), `TerminalView.tsx:2669` (동일).
2. **`ansiPatch` 가 `viewportRows` 에서 파생된다.** `headlessTerminal.ts:495` — `const ansiPatch = buildViewportAnsiPatch(viewportRows, cursor, terminal.cols);`. 즉 wire 는 같은 정보를 두 형태로 싣고, 클라이언트는 그중 하나만 쓴다.
3. **`viewportRows.length === rows` 가 항상 성립한다.** `headlessTerminal.ts:479` 의 루프가 `for (let y = 0; y < terminal.rows; y += 1)` 이고 매 반복 정확히 1회 `push` 한다(`:482-487`). 따라서 진단용 `rowCount` 도 `rows` 로 복원된다.

⇒ **`viewportRows[]` 는 wire 상에서 100 % 중복**이며, 프롤로그의 `rows` 가 그 전부를 대체한다. 뷰포트 전체를 행별 ANSI + plain text 로 한 번 더 싣던 것이 사라진다.

> ⚠️ **S4 라운드트립 테스트에 직접 영향** `[설계결정]`. `01:1197-1199` 는 "서버 인코딩 → 프론트 디코딩 → 원본 대조" 차분 테스트를 요구한다. `0x03` 은 **원본 JSON 객체와 무손실 왕복하지 않는다.** 왕복 계약을 **클라이언트 관측 가능 투영**(`seq`/`cols`/`rows`/`bufferType`/`cursor`/`repairToken`/`ansiPatch`)에 대해 정의해야 하며, 이것을 명시하지 않으면 차분 테스트가 구조적으로 실패한다.

### 1.5 `cursor` 를 남기는 이유 `[설계결정]`

`repair.cursor` 도 클라이언트가 읽지 않는다(`frontend/src` 전수 grep 0건 — `repair.cursor` 참조 없음). `ansiPatch` 가 이미 커서 이동 시퀀스를 포함한다(`headlessTerminal.ts:495` 가 `cursor` 를 인자로 받아 패치를 만든다).

그럼에도 프롤로그에 남긴다. 근거:

- 비용이 **5 B** 다(x/y/hidden). `viewportRows` 제거로 얻은 것에 비하면 무시할 수 있다.
- `cursor` 까지 빼면 `0x03` 의 관측 투영이 `ansiPatch` 문자열 하나로 붕괴한다. 그러면 **패치 적용 실패 시 진단할 구조화된 근거가 사라진다** — 현재 실패 경로(`TerminalView.tsx:2639-2660`)는 `cols`/`rows`/`bufferType` 불일치를 구분해 보고하는데, 커서만 어긋나는 사례를 구별할 수단이 없어진다.
- **대안**: `cursor` 도 제거하면 프롤로그는 24 B → 16 B 가 된다. 채택하지 않았으나 기각 사유는 "미래 진단 가치" 이므로 강한 기각은 아니다. 재검토 시 `flags2` 예약 비트로 선택적 탑재를 협상할 수 있다.

### 1.6 프롤로그 바이트 레이아웃 — **24 B**

| off | size | 필드 | 인코딩 | 비고 |
|---:|---:|---|---|---|
| 0 | 8 | `seq` | uint64 BE | `ScreenRepairMessage.seq` (`:652`). Ordinal64 가 아니라 세션 `screenSeq` 이므로 canonical 문자열 계약(`REL-BGSTAB-007` AC-4)의 대상이 아니다 — `number` 로 복원한다 |
| 8 | 2 | `cols` | uint16 BE | `:653` |
| 10 | 2 | `rows` | uint16 BE | `:654`. `viewportRows.length` 를 겸한다 (§1.4) |
| 12 | 1 | `bufferType` | uint8 | `0` = `normal`, `1` = `alternate` (`:655`, `:567`). `0x02` 의 `mode` u8 과 같은 슬롯 |
| 13 | 1 | `cursorHidden` | uint8 | `0` = `false`, `1` = `true`, `2` = 필드 부재 (`:656` `hidden?`). `0x02` 의 `truncated` u8 과 같은 슬롯 |
| 14 | 2 | `flags2` | uint16 BE | **전부 예약, 0 고정.** `0x02` 의 `flags2` 와 같은 슬롯·같은 상태(`01:550`) |
| 16 | 2 | `cursorX` | uint16 BE | `:656` |
| 18 | 2 | `cursorY` | uint16 BE | `:656` |
| 20 | 2 | (예약) | uint16 BE | **0 고정.** `0x02` 는 이 슬롯에 `authorityEpochIndex` 를 두지만 `ScreenRepairMessage` 에는 authority 필드가 없다 |
| 22 | 2 | `repairTokenIndex` | uint16 BE | `:651`. **`0` = absent** (§8.2). `0x02` 의 `replayTokenIndex` 와 **같은 슬롯** |
| **합계** | **24** | | | `0x01`/`0x02` 와 동일. 최소 유효 프레임 = **52 B** |

**본문**: `ansiPatch` 를 UTF-8 로 인코딩한 바이트열. 길이 = `payloadLength - 24`.

**flags**: `0x0009` (`END_OF_BATCH | PROLOGUE_PRESENT`). `PAYLOAD_UTF8_TEXT`(bit1)를 세우지 않는 것은 §8.4 참조.

### 1.7 손계산 예시 프레임 — `screen-repair-55`

값: `channelId=3`, `streamEpoch=9`, `sourceSeq=8`(전송 계층), `seq=77`, `cols=120`, `rows=40`, `bufferType=normal`, `cursorHidden=false`, `cursorX=5`, `cursorY=2`, `repairTokenIndex=4`, `ansiPatch="\x1b[H"`(3 B).
`payloadLength = 24 + 3 = 27 = 0x1B`. `byteLength = 28 + 27 = 55`.

| off | hex | 의미 |
|---:|---|---|
| 0 | `01` | `frameVersion = 1` |
| 1 | `03` | `opcode = 0x03 SCREEN_REPAIR` |
| 2 | `0009` | `flags = 0x0009 = END_OF_BATCH \| PROLOGUE_PRESENT` |
| 4 | `00000003` | `channelId = 3` |
| 8 | `0000000000000009` | `streamEpoch = 9` |
| 16 | `0000000000000008` | `sourceSeq = 8` |
| 24 | `0000001b` | `payloadLength = 27 = 24 + 3` |
| 28 | `000000000000004d` | `prologue.seq = 77 = 0x4D` |
| 36 | `0078` | `prologue.cols = 120 = 0x78` |
| 38 | `0028` | `prologue.rows = 40 = 0x28` |
| 40 | `00` | `prologue.bufferType = 0 (normal)` |
| 41 | `00` | `prologue.cursorHidden = 0 (false)` |
| 42 | `0000` | `prologue.flags2 = 0` |
| 44 | `0005` | `prologue.cursorX = 5` |
| 46 | `0002` | `prologue.cursorY = 2` |
| 48 | `0000` | `prologue` 예약 = 0 |
| 50 | `0004` | `prologue.repairTokenIndex = 4` |
| 52 | `1b5b48` | 본문 = `ESC [ H` (3 B) |

```
hexFrame (55 B / 110 hex):
0103000900000003000000000000000900000000000000080000001b000000000000004d007800280000000000050002000000041b5b48
```

> **유도 방법**: 각 바이트값은 §1.6 의 오프셋 표에서 **손으로** 정했다. `hexFrame` 은 그 표의 `hex` 열을 오프셋 순서로 이어붙인 것이며, 오프셋이 0 부터 빈틈없이 연속인지와 길이 합이 일치하는지를 기계적으로 검산했다 — 이는 `binary-frame-vectors.json` 이 `layout`↔`hexFrame` 사이에 이미 요구하는 불변식과 같다. **인코더 출력을 덤프하지 않았다.** 덤프하면 라운드트립 단언의 두 피연산자가 같은 출처를 갖게 되어 공허해진다(`05:450`, 같은 파일의 `$handComputed`). 아래 세 벡터(§2.10 / §3.5 / §4.4)도 동일한 방법이다.

### 1.8 거부 조건

| 조건 | 코드 | 등급 | 기존/신설 |
|---|---|---|---|
| `payloadLength < 24` | `payload-underrun` | fatal | 기존 (`binaryFrameCodec.ts:158`) |
| `payloadLength - 24 > maxBodyBytes` | `payload-limit-exceeded` | scoped | 기존 (`:158`) |
| `bufferType > 1` | `prologue-domain-violation` | scoped | **신설** (§5.5) |
| `cursorHidden > 2` | `prologue-domain-violation` | scoped | **신설** |
| `flags2 !== 0` 또는 off 20 예약 `!== 0` | `prologue-domain-violation` | scoped | **신설** |
| `repairTokenIndex` 가 채널이 모르는 값 | — | — | **거부하지 않는다.** 인덱스 매핑은 JSON control 로 오며 순서가 어긋날 수 있다. 미지 인덱스는 진단 이벤트만 남기고 프레임은 적용한다 — `ansiPatch` 는 토큰과 무관하게 유효하다. 다만 `screen-repair:ready` ACK 를 보낼 수 없으므로 `SCREEN_REPAIR_ACK_TIMEOUT` 경로로 수렴한다 `[미확인]` — 이 타임아웃 경로가 실제로 안전하게 수렴하는지 실측하지 않았다 |

**`maxBodyBytes` 는 새 상수를 만들지 않는다.** `deriveMaxBodyBytes(pty.maxSnapshotBytes)` (`binaryFrameCodec.ts:214-220`)를 그대로 쓴다. 서버 생산 측 상한도 정확히 같은 값이다 — `SessionManager.ts:6232` 가 `this.runtimePtyConfig.maxSnapshotBytes` 를 `serializeHeadlessScreenRepair` 에 넘기고 `headlessTerminal.ts:496` 이 그것으로 `ansiPatch` 를 자른다.

> ⚠️ **두 피연산자의 출처가 같다.** 디코더의 상한과 생산자의 상한이 동일한 config 값에서 나오므로, 이 검사는 **정상 경로에서 절대 발동하지 않는다.** 손상 프레임·비정합 피어에 대한 방어선으로서는 옳지만, 이 검사를 통과했다는 사실이 생산 경로에 대한 증거는 아니다. F5 계열 테스트가 "생산자 경로를 검증했다"고 주장하면 그것은 거짓이다.

---

## 2. `0x04` CHECKPOINT_START

### 2.1 메시지 shape 근거

```ts
// server/src/types/ws-protocol.ts:81-94
export interface TerminalCheckpointStartMessage extends TerminalCheckpointWireIdentity {
  type: 'terminal-checkpoint:start';
  sourceGeometry: { cols: number; rows: number };
  chunkCount: number;
  encodedByteTotal: number;
  digest: TerminalCheckpointDigest;
  modes: Readonly<Partial<Record<TerminalCheckpointBooleanMode, boolean>>>;
  parserTail: TerminalCheckpointEncodedPayload;
  contentDigest?: string;
  retainedStateDigest?: string;
  retainedActiveBuffer?: 'normal' | 'alternate';
  retainedCursor?: { x: number; y: number };
  retainedSavedCursor?: { buffer: 'normal'; x: number; y: number } | null;
}
```

`TerminalCheckpointWireIdentity` (`:18-33`): `protocolVersion` / `sessionId` / `viewGeneration` / `streamEpoch` / `checkpointEpoch` / `sourceSeq` / `snapshotSeq` / `oldestRetainedSeq` / `retentionPolicyId` / `connectionId?` / `transitionEpoch?` / `authorityEpoch?` / `responderLeaseId?` / `boundarySourceSeq?`.
`TerminalCheckpointDigest` (`:35-38`) = `{ algorithm: 'sha256'; hex: string }`.
`TerminalCheckpointEncodedPayload` (`:75-79`) = `{ encoding: 'base64'; data: string; encodedBytes: number }`.
`TERMINAL_CHECKPOINT_BOOLEAN_MODES` (`:40-49`) = 8종 고정 배열.

**송신 지점**: `server/src/services/TerminalAuthorityProductionAdapter.ts:1758-1785` 의 `checkpointMessages[0]`. 여기에 `:1470-1474` 가 `connectionId`/`viewGeneration` 을 뷰별로 주입한다.

**⚠️ 선언과 실제 wire 가 어긋나 있다** — `01:207` 이 `connected` 에서 이미 지적한 것과 같은 종류의 drift 다. `:1760-1766` 은 `...metadata` (`:1707-1752`)를 통째로 펼치므로 **선언에 없는 필드 13종**이 실제로 나간다:

| 실제 나가는 필드 | 위치 | 선언 |
|---|---|---|
| `localCacheUsed` | `:1709` | 없음 |
| `retentionPolicySource` | `:1710` | 없음 |
| `effectiveRetainedScrollbackLines` | `:1711` | 없음 |
| `retainedLineCount` | `:1712` | 없음 |
| `retainedActiveStateDigest` | `:1715` | 없음 |
| `retainedBuffers` (중첩 객체) | `:1719-1735` | 없음 |
| `totalEncodedBytes` | `:1738` | 없음 (`encodedByteTotal` 과 동일값) |
| `mode` / `source` / `authorityMode` / `authoritativeModelInstanceId` | `:1681-1684` (`identity` 경유) | 없음 |
| `transitionEpoch` / `authorityEpoch` | `:1673-1674` | 선언은 optional |

이 13종은 **`frontend/src/types/ws-protocol.ts:1201-1229` 의 검증기가 읽지 않고**, `terminalCheckpointRuntime.ts:463-486` 의 `identityFromStart` 도 읽지 않는다. ⇒ **바이너리 프롤로그는 이들을 싣지 않는다.** `[미확인]` — 프론트엔드 이외의 소비자(테스트·디버그 툴)가 이 필드들을 읽는지는 전수 확인하지 않았다. `01 §1.8` 병합 시 선언도 함께 교정해야 한다.

### 2.2 front/server drift

**없음.** `terminal-checkpoint-contract:start`(`server:13`) ~ `:end`(`server:308` / `frontend:310`) 블록을 `diff` 한 결과 차이는 파일 헤더 주석과 `TerminalCheckpointContinuityRecord` 위의 설명 주석 문구뿐이며, **타입 선언은 완전 일치**한다.

### 2.3 필수 필드의 정본 — 클라이언트 검증기

프롤로그 설계의 근거는 "타입에 있으니까"가 아니라 **클라이언트가 무엇을 요구하는가**다.

`frontend/src/types/ws-protocol.ts:977-989` `isCheckpointIdentity` — 다음이 없으면 메시지가 `invalid-message` 로 거절된다:
`protocolVersion === 1` · `sessionId` 비어있지 않음 · `viewGeneration` 비음수 정수 · `streamEpoch`/`checkpointEpoch`/`sourceSeq`/`snapshotSeq`/`oldestRetainedSeq` 가 canonical Ordinal64 · **`sourceSeq >= snapshotSeq`** · **`oldestRetainedSeq <= snapshotSeq`** · `retentionPolicyId` 비어있지 않음.

`:1202-1229` `start` 분기 — `sourceGeometry.cols/rows` 양수 · `chunkCount` **양수** · `encodedByteTotal` 비음수 · `digest` 가 sha256+64 hex · `modes` · `parserTail` 가 유효 base64 이고 `decodedBase64ByteLength(data) === encodedBytes` · `retainedStateDigest` 가 있으면 `contentDigest`/`retainedActiveBuffer`/`retainedCursor`/`retainedSavedCursor` 가 **묶음으로** 있어야 함.

`terminalCheckpointRuntime.ts:430-460` `terminalCheckpointRetainedStateDigestMatches` — `retainedStateDigest` 가 있으면 클라이언트가 digest 를 **재계산**한다:
```ts
// :449-459
const canonical = JSON.stringify({
  version: 1,
  dataDigest: message.contentDigest,     // :451
  parserTail: message.parserTail.data,   // :452  ← base64 문자열 그 자체
  cols, rows, modes, activeBuffer, cursor, savedCursor,
});
return digestTerminalBytes(retainedStateEncoder.encode(canonical)) === message.retainedStateDigest;
```

이 재계산이 프롤로그 설계에 두 개의 하드 제약을 건다:

- **(C1) `parserTail` 의 base64 문자열이 정확히 복원돼야 한다.** 바이너리는 원시 바이트를 싣고 base64 를 없애므로, **디코더가 본문을 표준 base64(패딩 포함)로 다시 인코딩**해야 이 검증이 성립한다. Node 의 `Buffer.toString('base64')`(`TerminalAuthorityProductionAdapter.ts:877`, `:897`)와 브라우저 `btoa` 는 같은 표준 알파벳·패딩을 쓰므로 왕복이 성립한다. **이것이 `0x04` 바이너리화의 유일한 비자명 비용이다.**
- **(C2) `modes` 객체의 키 순서가 보존돼야 한다.** `JSON.stringify` 결과가 digest 입력이므로 키 순서가 값이다. 서버는 `:1693-1706` 의 리터럴 배열 순서로, 클라이언트는 `RETAINED_STATE_MODE_NAMES` (`terminalCheckpointRuntime.ts:236-245`) 순서로 `Object.fromEntries` 한다. 두 배열은 `TERMINAL_CHECKPOINT_BOOLEAN_MODES` (`server/src/types/ws-protocol.ts:40-49`)와 **원소·순서가 모두 같다**(전수 대조 완료). ⇒ 비트맵 → 객체 재구성 시 **반드시 그 배열 순서로 삽입**해야 한다.

`terminalCheckpointRuntime.ts:507-524` `matchesTransactionIdentity` — 이후 chunk/commit/output 이 start 와 대조되는 필드 13종. **`sourceSeq` 는 여기 없다** — `:1207-1210` 에서 별도로 비교된다.

### 2.4 필드 분류표

| 필드 | 타입 | 배치 | 사유 |
|---|---|---|---|
| `type` | 리터럴 | **opcode** | |
| `protocolVersion` | `1` | **제거 (상수 복원)** | `TERMINAL_CHECKPOINT_PROTOCOL_VERSION = 1 as const` (`:14`). 단일값 |
| `sessionId` | `string` | **channelId** | `01:324-334` |
| `viewGeneration` | `number` | **프롤로그 uint32** | `0x05` 프롤로그의 선례(`01:556`)를 그대로 따른다. `channelId` 는 세션 핸들이라 뷰를 구분하지 못한다 |
| `streamEpoch` | Ordinal64 | **프롤로그 uint64** | §2.5 — 헤더의 `streamEpoch` 과 **같은 값이 아니다** |
| `checkpointEpoch` | Ordinal64 | **프롤로그 uint64** | `01:419` 이 "checkpoint 프롤로그" 로 이미 분류 |
| `sourceSeq` | Ordinal64 | **프롤로그 uint64** | §2.5 |
| `snapshotSeq` | Ordinal64 | **프롤로그 uint64** | `isCheckpointIdentity` 필수 + 교차 불변식 검사 대상 |
| `oldestRetainedSeq` | Ordinal64 | **프롤로그 uint64** | 같음 |
| `retentionPolicyId` | `string` (가변) | **control 잔류 (채널 상태)** | §7.2 |
| `connectionId?` | `string` (UUID) | **연결 상태 (제거)** | 서버가 `view.connectionId` 를 주입(`:1472`)하는데 그 값은 **수신 클라이언트 자신의 connectionId** 다. 클라이언트는 `connected` 프레임(`WsRouter.ts:1697-1710`, `01:207`)에서 이미 알고 있다. `[미확인]` — split 모드에서 control/output 소켓이 서로 다른 `connectionId` 를 가질 때 뷰가 어느 쪽에 묶이는지 확인하지 못했다 |
| `transitionEpoch?` | Ordinal64 | **프롤로그 uint64 + presence bit** | `:1673` 에서 항상 설정되지만 선언은 optional 이므로 presence 를 유지 |
| `authorityEpoch?` | `string` (UUID) | **프롤로그 uint16 인덱스** | `01:320` — "`authorityEpoch` UUID 는 `authorityEpochIndex: uint16` 으로 압축". 인덱스 `0` = absent (§8.2) |
| `responderLeaseId?` | `string` | **인코더가 거부** | §2.6 |
| `boundarySourceSeq?` | Ordinal64 | **프롤로그 uint64 + presence bit** | 선언(`:32`)에 있고 `matchesTransactionIdentity:523` 이 비교한다. `[미확인]` — checkpoint wire 메시지에 이 값을 대입하는 경로를 찾지 못했다(`createCheckpoint` 의 `identity` `:1670-1685` 에 없다) |
| `sourceGeometry.cols/rows` | `number` | **프롤로그 uint16 ×2** | `:1761` |
| `chunkCount` | `number` | **프롤로그 uint32** | `:1737`(metadata) — 클라이언트가 **양수**를 요구 |
| `encodedByteTotal` | `number` | **프롤로그 uint32** | `:1763`. 값은 원시 바이트 총합(`:898` `encodedBytes: chunk.byteLength`), base64 길이가 아니다 |
| `digest` | `{algorithm,hex}` | **프롤로그 32 B raw** | `:1764`. `algorithm` 은 단일값(`digestAlgorithms: readonly ['sha256']`, `:236`)이라 제거. hex 64자 → 32 B (`01:558`) |
| `modes` | `Partial<Record<8종, boolean>>` | **프롤로그 uint8 ×2** | §2.7 |
| `parserTail` | `{encoding,data,encodedBytes}` | **본문 + 상수/파생** | `encoding` 단일값, `encodedBytes` = 본문 길이. `data` = 본문 원시 바이트 |
| `contentDigest?` | `string` | **제거 (파생)** | 클라이언트가 `message.contentDigest !== digestWireValue(message.digest)` 이면 거부한다(`terminalCheckpointRuntime.ts:436`). 즉 **항상 `sha256:` + `digest.hex`** 이므로 복원 가능 |
| `retainedStateDigest?` | `string` | **프롤로그 32 B raw + presence bit** | `sha256:` + 64 hex (`isSha256WireDigest`, `frontend:1008-1012`). 접두사는 상수 |
| `retainedActiveBuffer?` | `'normal'\|'alternate'` | **프롤로그 uint8** | `:1713` |
| `retainedCursor?` | `{x,y}` | **프롤로그 uint32 ×2** | `:1714`. §2.8 |
| `retainedSavedCursor?` | `{buffer,x,y} \| null` | **프롤로그 uint32 ×2 + flags2 bit** | `:1716-1718`. `buffer` 는 항상 `'normal'`(서버 `:1717` 리터럴, 클라이언트 검증기 `frontend:1221` 도 `=== 'normal'` 요구) → 제거 |
| metadata 13종 (§2.1) | 다양 | **제거** | 선언에 없고 클라이언트가 읽지 않는다 |

### 2.5 checkpoint 평면 ordinal 은 헤더로 대체할 수 없다 `[설계결정]`

`01:311-320` 이 확정한 **2계층 식별 모델**:

> 헤더의 `(streamEpoch, sourceSeq)` 는 **전송 계층 ordinal** 이다. … 프레임마다 세션의 `sourceSeq` 가 1 증가한다.
> retained/checkpoint 평면이 승격되면 그 평면의 `sourceSeq` 는 전송 계층 ordinal 과 **같은 값으로 수렴**시킨다.

"수렴시킨다"는 **미래형**이다. 현재 checkpoint 평면은 비활성이고(`WsRouter.ts:2396-2399` 가 모든 checkpoint ACK 를 `checkpoint-not-active` 로 거절, `01:305` 인용), 두 값의 출처가 다르다 — checkpoint 쪽은 `runtime.controller.readLastCommittedSourceSeq()` (`:1667`), 전송 계층 쪽은 `01:426` 이 정본으로 지정한 `SessionManager.ts:1076` 의 `retainedTerminalStreamEpochCounter` 다.

⇒ **`0x04`/`0x06`/`0x07` 프롤로그는 checkpoint 평면 ordinal 을 명시적으로 싣는다.** 헤더 값과 같다고 가정하지 않는다. 이름도 `checkpointSourceSeq`/`checkpointStreamEpoch` 로 구분해 헤더 필드명과 충돌하지 않게 한다 (§8.1).

> ✅ **결론 확정 (2026-08-19) — §9 항목 1 판정: `DIFFERENT`.** 위 `[미확인]` 은 닫혔고 **결론은 옳다.** 다만 근거를 다음으로 대체한다: 두 값은 **별개 저장소이고 advance 트리거 집합이 서로소**다. controller 는 promotion(`TerminalAuthorityController.ts:1077`)·rollback(`:1532`)·rekey(`:606`)에서, retained 는 세션 생성(`SessionManager.ts:7128`)·Ordinal64 rollover(`:7882`/`:8120`)에서 움직인다. 같아지는 시점은 controller 생성(`SessionManager.ts:4952` → `Adapter.ts:2205`) **뿐**이고, controller 가 retained 를 따라가는 것은 `mode === 'server'` 이면서 값이 **커질 때만**이다(`Controller.ts:864-868`). `SessionManager.ts:5747-5761` 의 debug-isolation `max()` 가 존재한다는 사실 자체가 두 값이 다를 수 있다는 인정이다.
>
> ⚠️ **`retainedTerminalStreamEpochCounter` 는 세션당 epoch 이 아니다** — 매니저 스코프 **seed 할당기**이고 `:7127-7128` 이 유일한 증감이자 유일한 read 다(세션당 한 번). 이후 값은 `SessionData.retainedTerminal.streamEpoch` 에 산다. `retainedTerminalInitialOrdinal` 이 설정되면(`Adapter.ts:936-937`) 카운터는 프로세스 내내 `0n` 에 머문다.
>
> ⚠️ **headless 재초기화에서 controller epoch 이 뒤로 간다.** `SessionManager.ts:7471` 이 세대를 올리면 `:4952` 가 retained 값으로 controller 를 재시드하므로 N+1 로 승격됐던 controller 가 N 으로 교체된다 → **헤더를 controller 에서 뽑으면 단조성이 깨진다.**
>
> **인용 3건 정정**: (a) `:1667` 은 `streamEpoch` 를 공급하지 않는다 — `readLastCommittedSourceSeq()` 이고 `sourceSeq`/`snapshotSeq` 로 소비된다(`:1677-1678`). `streamEpoch` 의 실제 사슬은 `:1675` → `:1933`/`:2283`/`:3176` → `controller.getState().streamEpoch` 다. 즉 **와이어의 checkpoint `streamEpoch` 는 controller 값**이다. (b) 정본 지정은 `01:426` 이 아니라 **`01:466`**. (c) 2계층 모델 인용은 `01:311-320` 이 아니라 **`01:344`·`01:346`**. `checkpoint-not-active` 는 `WsRouter.ts:2400`.

`[미확인]` — `retainedTerminalStreamEpochCounter` 와 controller 의 `streamEpoch` 이 같은 저장소인지 확인하지 못했다. **같다면** 프롤로그의 `checkpointStreamEpoch` 8 B 는 중복이며 frameVersion 범프로 제거할 수 있다. 확인 방법: `SessionManager.ts:1076` 의 카운터와 `TerminalAuthorityController` 의 `getState().streamEpoch` 이 같은 값을 읽는지 단위 테스트로 대조.

### 2.6 `responderLeaseId` — 인코더가 거부한다 `[설계결정]` — 🔴 **폐기 (2026-08-19)**

> **이 절의 전제가 반증됐다. 아래의 채택 결정을 구현하면 안 된다.**
>
> `responderLeaseId` 와 `boundarySourceSeq` 는 **와이어에 실린다.** `TerminalAuthorityController.ts:1588-1594` 가 rollback(compatibility-recovery) 경로에서 `recovery.checkpointMessages` **전 원소**에 두 필드를 주입한다 — start 뿐 아니라 chunk·commit 까지. 아래 조사가 검사한 것은 `createCheckpoint` 의 `identity`(`:1670-1685`)이고 **그 관찰 자체는 맞다**; 필드는 controller 가 그 뒤에 주입한다. 대조군으로 promotion 경로(`Controller.ts:761-763`)는 `enqueue(message)` 맨몸이므로, 두 필드는 **promotion 에서 부재 / rollback 에서 항상 존재**다.
>
> 귀결: (1) 채택된 loud reject 는 compatibility-recovery 체크포인트마다 throw 한다. (2) `0x05` CHECKPOINT_CHUNK 의 12 B 프롤로그(`binaryFrameCodec.ts:113-114`, **이미 S2 에 구현됨**)에 자리가 없어 `01 §1.8` 까지 재검토 대상이다. (3) 조용히 드롭하면 아래 예측(클라이언트 `checkpoint-identity-mismatch`)과 달리 **서버 ACK 대조**(`Adapter.ts:790-791`, 기대값은 인코딩 이전 record `:1598-1608`)에서 실패해 `terminal-checkpoint:rejected / invalid-message` 로 apply/drain 이 정지한다.
>
> `boundarySourceSeq` 는 §2.9 레이아웃(off 56, `flags2` bit2 presence)이 **이미 올바르다** — promotion 에서 실제로 부재하므로 presence bit 설계가 맞다. 단 §3.3/§3.4 의 "commit 은 start 로부터 상속(제거)" 목록에서는 빼야 한다.
>
> 후속 설계 후보는 아래에서 기각된 **uint16 인덱스 + control 평면 매핑(§7.1)** 이며, 기각 사유("값이 나가는 경로가 없어 인덱스 수명·회전 규칙의 근거가 없다")는 **이제 성립하지 않는다 — 수명은 rollback 트랜잭션 단위다.**
>
> 전문·증거표는 `docs/next/2026-08-19-binary-data-plane-handoff.md` §4. 아래 본문은 판정 이력으로 보존한다.

선언(`:31`)에 있고 `matchesTransactionIdentity:522` 가 비교한다. 그러나 **checkpoint wire 메시지에 이 값을 대입하는 경로를 찾지 못했다** `[미확인]` — `createCheckpoint` 의 `identity` (`:1670-1685`)에 없고, `:1470-1474` 의 주입에도 없다. `TerminalAuthorityProductionAdapter.ts:2009` 의 `responderLeaseId` 는 wire 메시지가 아니라 delivery-proof 호출 인자다.

가변 길이 문자열이라 고정폭 프롤로그로 표현할 수 없다. 두 선택지:

- **(채택)** v1 프롤로그는 싣지 않고, **인코더가 `responderLeaseId !== undefined` 인 start 메시지를 `RangeError` 로 거부**한다. 조용히 떨어뜨리면 클라이언트의 `activeIdentity` 가 서버와 어긋나고, 이후 모든 chunk/commit 이 `checkpoint-identity-mismatch` (`terminalCheckpointRuntime.ts:1212`)로 실패한다 — **원인이 프레임 인코딩인데 증상이 identity 불일치로 나타나는 최악의 진단 경로**다.
- (기각) uint16 인덱스 추가. 값이 실제로 나가는 경로가 없어 인덱스 테이블의 수명·회전 규칙을 정할 근거가 없다. 근거 없이 필드를 만들지 않는다.

**원칙**: 레이아웃이 표현할 수 없는 것은 인코더가 시끄럽게 거부한다.

### 2.6.1 후속 판정 (2026-08-19) — `responderLeaseId` 는 **고정폭 슬롯으로 싣는다**

§2.6 폐기가 남긴 공백을 닫는다. 전문과 근거는 `docs/next/2026-08-19-binary-data-plane-handoff.md` §4.

**판정: `0x04` 프롤로그를 160 → 200 B 로 넓히고 고정폭 슬롯을 둔다.**

| off | size | 필드 | 도메인 |
|---:|---:|---|---|
| 160 | 1 | `responderLeaseIdLength` uint8 | `0..38` (단위 **바이트**) |
| 161 | 39 | `responderLeaseIdBytes` raw | `[0,length)` UTF-8 원시 / `[length,39)` **0 고정** |

`flags2` **bit4 = `RESPONDER_LEASE_ID_PRESENT`** 신설 → 예약 마스크 `0xFFF0` → **`0xFFE0`**.

- **상한 38 의 유도**: `Adapter.ts:4435` 가 `` `responder-browser-${nextStreamEpoch}` `` 로 만든다 — 접두사 18 B + Ordinal64 십진 최대 20자리. ASCII 이므로 바이트 수 = 문자 수. `nextOrdinal`(`Adapter.ts:918-920`)에 상한 클램프가 없어 `2^64` 를 낼 수 있으나 **그것도 20자리**라 상한이 움직이지 않는다.
- **§2.6 의 기각 사유가 여기엔 적용되지 않는다**: "가변 길이라 고정폭으로 표현할 수 없다" 는 **상한이 없을 때의 얘기**다. 상한이 38 로 유도되므로 고정폭 슬롯이 성립하고, `prologueBytes(0x04)` 는 **상수 200** 으로 남아 `01:518`·`01:108` 의 순수성 불변식(D14 안전성 논증의 근거)을 지킨다.
- **부재는 "키 부재" 여야 하며 빈 문자열이면 안 된다.** `''` 로 복원하면 `matchesTransactionIdentity:522` 는 `'' === ''` 로 통과하지만 ACK 에코가 `Adapter.ts:790` 에서 `'' === undefined` → false → `terminal-checkpoint:rejected`. presence bit 이 `bit4=1 && length===0` 모순을 디코드 시점에 거부한다.
- **uint16 인덱스안 재기각**: 클라이언트가 `wireIdentity:502` 로 **문자열을 에코**해야 하고 서버가 `Adapter.ts:790` 에서 문자열 동일성으로 받는다 → 인덱스만으로는 부족하고, 해석 실패라는 새 실패 모드만 는다.
- **`streamEpoch` 파생 금지**: 산술적으로 가능하지만 내부 명명 관례를 와이어 계약으로 승격시킨다. 전제도 이미 거짓이다 — `Adapter.ts:2152-2155` 가 같은 접두사에 `-runtime-N` 접미사를 붙인다.

⚠️ **§2.4 표 `:269` 행(`responderLeaseId?` → "인코더가 거부")은 이 판정으로 무효다.**
⚠️ **§2.4 표 `:270` 행의 `[미확인]`("checkpoint wire 에 `boundarySourceSeq` 를 대입하는 경로를 찾지 못했다")도 반증됐다** — `TerminalAuthorityController.ts:1593` 이 rollback 경로에서 대입한다. §2.9 의 off 56 + bit2 설계는 그대로 옳다.

✅ **§2.9 표에 반영 완료 (2026-08-19).** 구현·손계산 벡터 2개(`checkpoint-start-rollback-228` / `checkpoint-start-promotion-228`)와 함께 확정했다 — 레이아웃 숫자는 벡터가 맞아떨어질 때 비로소 확정되므로 그 순서를 지켰다.

### 2.6.2 `07:313` 의 `boundarySourceSeq` 지시는 **과잉 정정**이다 (2026-08-19 판정)

§2.6 폐기 노트(`:313`)는 *"`boundarySourceSeq` 를 §3.3/§3.4 의 '상속(제거)' 목록에서 빼야 한다"* 고 했다. **따르지 않는다.**

- 문자 그대로 따르면 `0x06` 이 슬롯을 얻어야 하는데 §3.4 의 88 B 레이아웃에 자리가 없어 **96 B** 가 된다.
- 그러나 `Controller.ts:1592-1593` 이 start·chunk·commit **전 원소에 같은 값**을 주입하므로, 독립 슬롯을 둬도 **두 피연산자의 출처가 여전히 같다** — 검사가 강해지지 않는다.
- §3.3 은 상속 필드의 비교가 *"구조적 항진식이 되며 이것은 **의도된 것**"* 이라고 이미 규정했다. `boundarySourceSeq` 를 그 목록에 두는 것이 그 규정과 일관된다.

⇒ **`boundarySourceSeq` 는 상속 목록에 유지하고 `0x06` 은 88 B 를 유지한다.**

### 2.7 `modes` 비트맵 — 2 B `[설계결정]`

`modes` 는 `Partial` 이고, **부재와 `false` 가 의미상 다르다** — `terminalCheckpointRuntime.ts:444` 가 `typeof message.modes[name] === 'boolean'` 인 것만 digest 입력에 넣기 때문이다. 3상태이므로 비트 하나로는 부족하다.

⇒ 마스크 두 개:

| 마스크 | 의미 |
|---|---|
| `modesPresentMask` uint8 | bit *i* = `TERMINAL_CHECKPOINT_BOOLEAN_MODES[i]` 키가 **존재**함 |
| `modesValueMask` uint8 | bit *i* = 그 키의 값이 `true` |

비트 순서 = `server/src/types/ws-protocol.ts:40-49` 의 배열 인덱스:
`0` `applicationCursorKeysMode` · `1` `applicationKeypadMode` · `2` `bracketedPasteMode` · `3` `insertMode` · `4` `originMode` · `5` `reverseWraparoundMode` · `6` `sendFocusMode` · `7` `wraparoundMode`.

- 8종이 `as const` 배열로 고정돼 있어 uint8 두 개가 정확히 들어맞는다. 9번째가 생기면 frameVersion 범프가 필요하다 — 이것은 **의도된 제약**이다. 모드 집합이 늘면 digest 정규화(C2)도 함께 바뀌므로 어차피 조용한 확장이 불가능하다.
- **재구성 시 반드시 배열 순서로 삽입**한다 (C2).
- 거부: `modesValueMask & ~modesPresentMask !== 0` → `prologue-domain-violation`.

### 2.8 `retainedCursor` 를 uint32 로 넓히는 이유 `[설계결정]`

`0x03` 의 커서는 uint16 이다 — 출처가 `buffer.cursorX/cursorY` (`headlessTerminal.ts:491-492`)라 뷰포트 상대값이고 `cols`/`rows`(둘 다 uint16) 범위임이 확인됐다.

`0x04` 의 `retainedCursor` 는 `retained.checkpoint.cursor` (`:1714`)이며 **상한을 확인하지 못했다** `[미확인]`. retained 스크롤백 전체를 기준으로 하는 절대 좌표일 가능성을 배제하지 못했다. uint16 로 자르면 digest 재계산(C1/C2)이 어긋나 `checkpoint-retained-state-digest-mismatch` 로 조용히 수렴한다 — 잘림이 아니라 **복구 루프**로 나타난다.

⇒ uint32 채택. 폭이 opcode 별로 다른 것은 **출처의 증명 수준이 다르기 때문**이며, 이 사실을 표에 남긴다.

### 2.9 프롤로그 바이트 레이아웃 — **200 B** (§2.6.1 로 160 → 200)

| off | size | 필드 | 인코딩 | 비고 |
|---:|---:|---|---|---|
| 0 | 8 | `checkpointSourceSeq` | uint64 BE | `WireIdentity.sourceSeq` (`:24`). §2.5 |
| 8 | 4 | `viewGeneration` | uint32 BE | `:21`. **`0x05`/`0x06`/`0x07` 과 같은 슬롯**(프롤로그+8), §8.1 |
| 12 | 4 | `chunkCount` | uint32 BE | `:84`. **양수여야 한다** |
| 16 | 8 | `checkpointStreamEpoch` | uint64 BE | `:22` |
| 24 | 8 | `checkpointEpoch` | uint64 BE | `:23` |
| 32 | 8 | `snapshotSeq` | uint64 BE | `:25` |
| 40 | 8 | `oldestRetainedSeq` | uint64 BE | `:26` |
| 48 | 8 | `transitionEpoch` | uint64 BE | `:29`. `flags2` bit1 = 1 일 때만 유효, 0 이면 8 B 전부 0 |
| 56 | 8 | `boundarySourceSeq` | uint64 BE | `:32`. `flags2` bit2 = 1 일 때만 유효 |
| 64 | 4 | `encodedByteTotal` | uint32 BE | `:85` |
| 68 | 2 | `cols` | uint16 BE | `sourceGeometry.cols` (`:83`) |
| 70 | 2 | `rows` | uint16 BE | `sourceGeometry.rows` (`:83`) |
| 72 | 2 | `authorityEpochIndex` | uint16 BE | `:30` UUID 의 채널 로컬 별칭. **`0` = absent** |
| 74 | 2 | `flags2` | uint16 BE | 아래 비트 정의 |
| 76 | 1 | `modesPresentMask` | uint8 | §2.7 |
| 77 | 1 | `modesValueMask` | uint8 | §2.7 |
| 78 | 1 | `retainedActiveBuffer` | uint8 | `0`=normal, `1`=alternate (`:91`). `flags2` bit0 = 0 이면 `0` 고정 |
| 79 | 1 | (예약) | uint8 | 0 고정 |
| 80 | 4 | `retainedCursorX` | uint32 BE | `:92`. §2.8 |
| 84 | 4 | `retainedCursorY` | uint32 BE | `:92` |
| 88 | 4 | `retainedSavedCursorX` | uint32 BE | `:93`. `flags2` bit3 = 1 일 때만 유효 |
| 92 | 4 | `retainedSavedCursorY` | uint32 BE | `:93` |
| 96 | 32 | `digest` | raw 32 B | `digest.hex` 64자를 바이트로 (`:86`). 디코더는 **소문자 hex** 로 복원 (`createHash(...).digest('hex')` 가 소문자, `:1659`) |
| 128 | 32 | `retainedStateDigest` | raw 32 B | `:90` 의 `sha256:` 접두사 뒤 64 hex. `flags2` bit0 = 1 일 때만 유효 |
| **160** | **1** | **`responderLeaseIdLength`** | **uint8** | §2.6.1. 도메인 `0..38`, 단위는 **바이트**이지 문자가 아니다 |
| **161** | **39** | **`responderLeaseIdBytes`** | **raw 39 B** | §2.6.1. `[0,length)` = UTF-8 원시, `[length,39)` = **0 고정**. `flags2` bit4 = 1 일 때만 유효 |
| **합계** | **200** | | | 모든 uint64 가 8정렬, 두 digest 가 32정렬, 200 = 8×25. off 199 는 영구 패딩이며 도달 가능한 값이 없다 — 상한은 38 이지 39 가 아니다 |

**`flags2` 비트 정의** (`0x04` 전용):

| bit | 이름 | 의미 |
|---:|---|---|
| 0 | `RETAINED_STATE_PRESENT` | `retainedStateDigest`/`contentDigest`/`retainedActiveBuffer`/`retainedCursor`/`retainedSavedCursor` **묶음 전체**의 존재. 클라이언트 검증기(`frontend:1212-1225`)가 이들을 all-or-nothing 으로 취급하므로 비트 하나로 충분하다 |
| 1 | `TRANSITION_EPOCH_PRESENT` | off 48 유효 |
| 2 | `BOUNDARY_SOURCE_SEQ_PRESENT` | off 56 유효 |
| 3 | `SAVED_CURSOR_NON_NULL` | `0` = `retainedSavedCursor === null`, `1` = 객체. bit0 = 0 이면 무의미하며 0 이어야 한다 |
| **4** | **`RESPONDER_LEASE_ID_PRESENT`** | **§2.6.1.** off 160/161 유효. 필드의 **유효성**만 서술하고 프롤로그 **크기**를 서술하지 않는다 — 그것이 `prologueBytes` 순수성의 근거다 |
| 5-15 | 예약 | 0 고정. 다른 값이면 `prologue-domain-violation`. 예약 마스크는 `0xFFF0` → **`0xFFE0`** 으로 좁아졌다 |

**본문**: `parserTail.data` 를 base64 디코딩한 원시 바이트. 길이 = `payloadLength - 160`. **0 이 정상이다** — `retained.checkpoint.pendingEscapeTailAnsi ?? ''` (`:1657`)이므로 빈 tail 이 통상 경로다.

**프롤로그 길이를 `flags2` 에 의존시키지 않는다** `[설계결정]`. `retainedStateDigest` 부재 시 32 B 를 절약할 수 있으나 기각한다 — `prologueBytes()` 가 **opcode 만의 순수 함수**라는 성질이 `06:1249` 가 지적한 안전성의 근거다(bit3 가 잘못 서도 프롤로그를 본문으로 오독하지 않는 이유). 길이를 flags 의존으로 만들면 그 성질이 사라지고, 한 프레임에서 두 필드를 교차 신뢰해야 한다.

### 2.10 손계산 예시 프레임 — `checkpoint-start-188`

트랜잭션: `channelId=1`, 전송 `streamEpoch=1`, 전송 `sourceSeq=12`.
checkpoint 평면: `checkpointSourceSeq=500`, `checkpointStreamEpoch=4`, `checkpointEpoch=2`, `snapshotSeq=500`, `oldestRetainedSeq=100`, `transitionEpoch=3`(present), `boundarySourceSeq` absent, `viewGeneration=11`, `chunkCount=3`, `encodedByteTotal=200`, `cols=120`, `rows=40`, `authorityEpochIndex=1`.
retained 상태: present, `retainedActiveBuffer=normal`, `retainedCursor=(5,2)`, `retainedSavedCursor=null`.
`modes`: `bracketedPasteMode`(idx 2) = `false`, `wraparoundMode`(idx 7) = `true` → present `= (1<<2)|(1<<7) = 0x84`, value `= (1<<7) = 0x80`.
`flags2 = bit0 | bit1 = 0x0003`.
`parserTail` = 빈 문자열 → 본문 0 B. `payloadLength = 160 = 0xA0`. `byteLength = 188`.

| off | hex | 의미 |
|---:|---|---|
| 0 | `01` | `frameVersion = 1` |
| 1 | `04` | `opcode = 0x04 CHECKPOINT_START` |
| 2 | `0009` | `flags = 0x0009` |
| 4 | `00000001` | `channelId = 1` |
| 8 | `0000000000000001` | `streamEpoch = 1` (전송 계층) |
| 16 | `000000000000000c` | `sourceSeq = 12` (전송 계층) |
| 24 | `000000a0` | `payloadLength = 160 = 프롤로그 160 + 본문 0` |
| 28 | `00000000000001f4` | `prologue.checkpointSourceSeq = 500 = 0x1F4` |
| 36 | `0000000b` | `prologue.viewGeneration = 11 = 0x0B` |
| 40 | `00000003` | `prologue.chunkCount = 3` |
| 44 | `0000000000000004` | `prologue.checkpointStreamEpoch = 4` |
| 52 | `0000000000000002` | `prologue.checkpointEpoch = 2` |
| 60 | `00000000000001f4` | `prologue.snapshotSeq = 500` |
| 68 | `0000000000000064` | `prologue.oldestRetainedSeq = 100 = 0x64` |
| 76 | `0000000000000003` | `prologue.transitionEpoch = 3` (flags2 bit1) |
| 84 | `0000000000000000` | `prologue.boundarySourceSeq` = absent |
| 92 | `000000c8` | `prologue.encodedByteTotal = 200 = 0xC8` |
| 96 | `0078` | `prologue.cols = 120` |
| 98 | `0028` | `prologue.rows = 40` |
| 100 | `0001` | `prologue.authorityEpochIndex = 1` |
| 102 | `0003` | `prologue.flags2 = RETAINED_STATE_PRESENT \| TRANSITION_EPOCH_PRESENT` |
| 104 | `84` | `prologue.modesPresentMask = 0x84` (bracketedPaste, wraparound) |
| 105 | `80` | `prologue.modesValueMask = 0x80` (wraparound = true) |
| 106 | `00` | `prologue.retainedActiveBuffer = 0 (normal)` |
| 107 | `00` | `prologue` 예약 = 0 |
| 108 | `00000005` | `prologue.retainedCursorX = 5` |
| 112 | `00000002` | `prologue.retainedCursorY = 2` |
| 116 | `00000000` | `prologue.retainedSavedCursorX` (savedCursor = null) |
| 120 | `00000000` | `prologue.retainedSavedCursorY` |
| 124 | `00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff` | `prologue.digest` 32 B |
| 156 | `ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100` | `prologue.retainedStateDigest` 32 B |

```
hexFrame (188 B / 376 hex):
01040009000000010000000000000001000000000000000c000000a000000000000001f40000000b000000030000000000000004000000000000000200000000000001f4000000000000006400000000000000030000000000000000000000c80078002800010003848000000000000500000002000000000000000000112233445566778899aabbccddeeff00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100
```

> 위 문자열은 표의 `hex` 열을 오프셋 순서로 이어붙인 것이다. `binary-frame-vectors.json` 의 규약대로 `layout` 배열(표의 각 행 = `[offset, hex, meaning]`)과 `hexFrame` 을 **둘 다** 실어 두 표기가 서로를 검증하게 한다. 오프셋이 0 부터 연속이고 hex 길이 합이 376(= 28 B 헤더 + 160 B 프롤로그)임을 검산했다.

### 2.11 거부 조건

| 조건 | 코드 | 등급 |
|---|---|---|
| `payloadLength < 160` | `payload-underrun` (기존) | fatal |
| `payloadLength - 160 > maxBodyBytes` | `payload-limit-exceeded` (기존) | scoped |
| `chunkCount === 0` | `prologue-domain-violation` (**신설**) | scoped — 클라이언트가 양수를 요구(`frontend:1207` `isPositiveSafeInteger`) |
| `cols === 0` 또는 `rows === 0` | `prologue-domain-violation` | scoped — `frontend:1205-1206` |
| `retainedActiveBuffer > 1` | `prologue-domain-violation` | scoped |
| `modesValueMask & ~modesPresentMask !== 0` | `prologue-domain-violation` | scoped |
| `flags2 & 0xFFF0 !== 0` (예약 비트) | `prologue-domain-violation` | scoped |
| `flags2` bit0 = 0 인데 bit3 = 1, 또는 off 78/128 이 0 이 아님 | `prologue-domain-violation` | scoped |
| off 79 예약 `!== 0` | `prologue-domain-violation` | scoped |
| `sourceSeq < snapshotSeq` 또는 `oldestRetainedSeq > snapshotSeq` | **거부하지 않는다** | 기존 클라이언트 검증기(`frontend:986-987`)가 상위 계층에서 잡는다. 디코더가 중복 검사하면 같은 실패가 두 경로로 처리된다(`01:117` 이 `CONTINUATION` 을 기각한 것과 같은 논리) |
| `parserTail` base64 재인코딩 실패 | **불가능** | 임의의 바이트열은 항상 base64 로 인코딩된다 |

---

## 3. `0x06` CHECKPOINT_COMMIT

### 3.1 메시지 shape 근거

```ts
// server/src/types/ws-protocol.ts:103-109
export interface TerminalCheckpointCommitMessage extends TerminalCheckpointWireIdentity {
  type: 'terminal-checkpoint:commit';
  chunkCount: number;
  encodedByteTotal: number;
  digest: TerminalCheckpointDigest;
  retainedStateDigest?: string;
}
```

**송신 지점**: `TerminalAuthorityProductionAdapter.ts:1776-1784`. 실제 wire 는 선언보다 넓다 — `totalEncodedBytes`(`:1781`)와 `contentDigest`(`:1782`)가 추가로 나가지만 둘 다 파생값이고 클라이언트가 읽지 않는다(`frontend:1246-1254` 의 commit 분기가 `chunkCount`/`encodedByteTotal`/`digest`/`retainedStateDigest` 만 본다).

**front/server drift 없음** (§2.2 와 같은 블록).

### 3.2 commit 의 유일한 일 — 독립 교차검증

`terminalCheckpointRuntime.ts:1229-1236`:
```ts
if (
  commit.chunkCount !== activeIdentity.chunkCount
  || commit.encodedByteTotal !== activeIdentity.encodedByteTotal
  || digestWireValue(commit.digest) !== activeIdentity.digest
  || commit.retainedStateDigest !== activeIdentity.retainedStateDigest
) return failClosed('checkpoint-commit-metadata-mismatch');
```

`activeIdentity` 는 start 에서 만들어진다(`:463-486` `identityFromStart`, `:1196` `activeIdentity = candidateIdentity`). ⇒ **이 네 값은 commit 프레임 자신의 바이트에서 나와야 한다.** start 로부터 재구성하면 검사의 두 피연산자가 같은 출처를 갖게 되어 **비교가 구조적으로 항상 참**이 된다 — 검사가 공허해진다.

이것이 commit 프롤로그가 88 B 인 이유다. 압축할 여지가 있어 보이지만, **압축의 대부분이 곧 검사의 무력화**다.

### 3.3 필드 분류표

| 필드 | 타입 | 배치 | 사유 |
|---|---|---|---|
| `type` | 리터럴 | opcode | |
| `protocolVersion` / `sessionId` / `retentionPolicyId` / `connectionId` / `authorityEpoch` / `transitionEpoch` / `boundarySourceSeq` / `streamEpoch` / `checkpointEpoch` / `snapshotSeq` / `oldestRetainedSeq` | — | **start 로부터 상속 (제거)** | `matchesTransactionIdentity` (`:507-524`)가 비교하는 필드들이며, 상속하면 비교가 구조적 항진식이 된다 — 이것은 **의도된 것**이다. §6.3 |
| **`responderLeaseId?`** | `string` | **start 로부터 상속 (제거)** | 🔴 **2026-08-19 추가 — 이 행이 없으면 rollback 이 통째로 깨진다.** §2.6 이 이 필드를 "인코더가 거부" 로 처분하면서 분류 대상에서 빠졌고, §2.6 폐기가 그 공백을 남겼다. `matchesTransactionIdentity:522` 가 이 필드를 **비교**하고 그 게이트(`:1204-1213`)는 `...activeIdentity` 상속(`:1218`)보다 **앞**이다. 따라서 디코더가 chunk·commit 에 대해 열린 트랜잭션에서 이 값을 채워 넣지 않으면, `undefined` 대 rollback start 의 비어있지 않은 문자열이 되어 **모든 rollback chunk 가 `failClosed('checkpoint-identity-mismatch')`** 된다. 값의 독립 출처는 `0x04` 프롤로그(§2.6.1)이고 그 정확성은 ACK 왕복(`Adapter.ts:790`)이 지킨다 |
| `viewGeneration` | `number` | **프롤로그 uint32** | 상속 가능하지만 남긴다 — `0x05` 가 이미 싣고 있어(`01:556`) 빼면 형제 opcode 와 어긋난다. 4 B |
| `sourceSeq` | Ordinal64 | **프롤로그 uint64** | `:1207-1210` 이 `activeIdentity.sourceSeq !== message.sourceSeq` 를 별도 검사한다. **독립 출처 필요** |
| `chunkCount` | `number` | **프롤로그 uint32** | 독립 교차검증 (§3.2) |
| `encodedByteTotal` | `number` | **프롤로그 uint32** | 같음 |
| `digest` | `{algorithm,hex}` | **프롤로그 32 B raw** | 같음. `algorithm` 단일값 제거 |
| `retainedStateDigest?` | `string` | **프롤로그 32 B raw + presence bit** | 같음. `commit.retainedStateDigest !== activeIdentity.retainedStateDigest` 는 `undefined !== undefined` 도 비교하므로 **presence 자체가 검사 대상**이다 |
| `totalEncodedBytes` / `contentDigest` | `number`/`string` | **제거** | 선언 밖 파생값 (§3.1) |

### 3.4 프롤로그 바이트 레이아웃 — **88 B**

| off | size | 필드 | 인코딩 | 비고 |
|---:|---:|---|---|---|
| 0 | 8 | `checkpointSourceSeq` | uint64 BE | `0x04` 와 **같은 슬롯** |
| 8 | 4 | `viewGeneration` | uint32 BE | `0x04`/`0x05`/`0x07` 과 같은 슬롯 |
| 12 | 4 | `chunkCount` | uint32 BE | `0x04` 와 같은 슬롯 |
| 16 | 4 | `encodedByteTotal` | uint32 BE | `:106` |
| 20 | 2 | `flags2` | uint16 BE | bit0 = `RETAINED_STATE_DIGEST_PRESENT`. bit1-15 예약 0 |
| 22 | 2 | (예약) | uint16 BE | 0 고정 |
| 24 | 32 | `digest` | raw 32 B | `:107` |
| 56 | 32 | `retainedStateDigest` | raw 32 B | `:108`. flags2 bit0 = 1 일 때만 유효 |
| **합계** | **88** | | | 오프셋 0-15 가 `0x04` 프롤로그와 **완전 일치**한다 |

**본문**: **없음.** `payloadLength` 는 정확히 `88` 이어야 한다.

### 3.5 손계산 예시 프레임 — `checkpoint-commit-116`

§2.10 과 같은 트랜잭션의 commit. 전송 `sourceSeq` 는 start(12) → chunk×3(13,14,15) → **commit(16)**.
`payloadLength = 88 = 0x58`. `byteLength = 116`.

| off | hex | 의미 |
|---:|---|---|
| 0 | `01` | `frameVersion = 1` |
| 1 | `06` | `opcode = 0x06 CHECKPOINT_COMMIT` |
| 2 | `0009` | `flags = 0x0009` |
| 4 | `00000001` | `channelId = 1` |
| 8 | `0000000000000001` | `streamEpoch = 1` |
| 16 | `0000000000000010` | `sourceSeq = 16 = 0x10` (start 로부터 연속) |
| 24 | `00000058` | `payloadLength = 88 = 프롤로그 88 + 본문 0` |
| 28 | `00000000000001f4` | `prologue.checkpointSourceSeq = 500` (start 와 동일) |
| 36 | `0000000b` | `prologue.viewGeneration = 11` |
| 40 | `00000003` | `prologue.chunkCount = 3` |
| 44 | `000000c8` | `prologue.encodedByteTotal = 200` |
| 48 | `0001` | `prologue.flags2 = RETAINED_STATE_DIGEST_PRESENT` |
| 50 | `0000` | `prologue` 예약 = 0 |
| 52 | `00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff` | `prologue.digest` (start 와 동일 — 이 일치가 commit 의 존재 이유) |
| 84 | `ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100` | `prologue.retainedStateDigest` |

```
hexFrame (116 B / 232 hex):
0106000900000001000000000000000100000000000000100000005800000000000001f40000000b00000003000000c80001000000112233445566778899aabbccddeeff00112233445566778899aabbccddeeffffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100
```

검산: 16 + 16 + 16 + 8 + 16 + 8 + 8 + 8 + 4 + 4 + 64 + 64 = **232 hex = 116 B** ✔

### 3.6 거부 조건

| 조건 | 코드 | 등급 |
|---|---|---|
| `payloadLength < 88` | `payload-underrun` (기존) | fatal |
| **`payloadLength > 88`** | `prologue-domain-violation` (**신설**) | scoped — commit 은 본문이 없다. 잔여 바이트를 조용히 무시하면 `01:88-93` 이 예약 비트에 대해 확립한 "무시가 아니라 거부" 원칙과 어긋난다 |
| `chunkCount === 0` | `prologue-domain-violation` | scoped |
| `flags2 & 0xFFFE !== 0`, off 22 예약 `!== 0` | `prologue-domain-violation` | scoped |
| `flags2` bit0 = 0 인데 off 56 이 0 이 아님 | `prologue-domain-violation` | scoped |
| `chunkCount`/`encodedByteTotal`/`digest` 가 start 와 불일치 | **거부하지 않는다** | 클라이언트 런타임(`:1235` `checkpoint-commit-metadata-mismatch`)이 정본이다. 디코더는 프레임을 그대로 넘긴다 — 그래야 §3.2 의 교차검증이 실제로 돈다 |

---

## 4. `0x07` CHECKPOINT_OUTPUT

### 4.1 메시지 shape 근거

```ts
// server/src/types/ws-protocol.ts:111-114
export interface TerminalCheckpointOutputMessage extends TerminalCheckpointWireIdentity,
  TerminalCheckpointEncodedPayload {
  type: 'terminal-checkpoint:output';
}
```

즉 WireIdentity 14필드 + `{ encoding: 'base64', data, encodedBytes }` 뿐이다. 고유 필드가 **하나도 없다**.

**송신 지점**: `TerminalAuthorityProductionAdapter.ts:1563-1570`:
```ts
outbound = {
  type: 'terminal-checkpoint:output',
  ...activeCheckpoint,                       // 활성 체크포인트 identity 통째로
  connectionId: view.connectionId,
  viewGeneration: view.viewGeneration,
  sourceSeq: record.sourceSeq,               // ← 프레임마다 바뀌는 유일한 identity 값
  ...encodeCheckpointPayload(record.data),   // ← 그리고 payload
};
```

**클라이언트 소비**: `terminalCheckpointRuntime.ts:1245-1256`:
```ts
dispatchUnknown(currentCoordinator, {
  type: 'live',
  ...activeIdentity,
  sourceSeq: message.sourceSeq,
  data: decodeBase64(message.data, message.encodedBytes),
  settlementToken: [message.sessionId, message.viewGeneration,
                    message.streamEpoch, message.sourceSeq].join(':'),
});
```

⇒ **프레임마다 변하는 것은 `sourceSeq` 와 `data` 둘뿐**이고, `settlementToken` 조립에 `viewGeneration` 이 필요하다. `sessionId`/`streamEpoch` 은 채널·활성 체크포인트에서 온다.

**front/server drift 없음** (§2.2 와 같은 블록).

### 4.2 필드 분류표

| 필드 | 타입 | 배치 | 사유 |
|---|---|---|---|
| `type` | 리터럴 | opcode | |
| `sessionId` | `string` | channelId | |
| `sourceSeq` | Ordinal64 | **프롤로그 uint64** | 프레임마다 바뀐다 (`:1567`). `matchesTransactionIdentity` 대상이 **아니다**(`:507-524` 에 없음) — output 은 이 값을 전진시키는 것이 정상이다 |
| `viewGeneration` | `number` | **프롤로그 uint32** | `settlementToken` 조립에 필요 (`:1252`) |
| `encoding` | `'base64'` | **제거 (상수)** | 단일값 (`:76`) |
| `data` | `string` (base64) | **본문 (원시 바이트)** | base64 디코딩 결과를 그대로 싣는다. 33 % 오버헤드 소멸 (`01:556` 의 `0x05` 와 같은 이득) |
| `encodedBytes` | `number` | **제거 (파생)** | `= payloadLength - 12`. 클라이언트 검증기(`frontend:1026-1027`)가 `decodedBase64ByteLength(data) === encodedBytes` 를 요구하는데, 바이너리에서는 본문 길이가 곧 그 값이므로 **검사가 구조적으로 성립**한다 |
| 나머지 WireIdentity 12종 | — | **활성 체크포인트로부터 상속** | 서버도 `...activeCheckpoint` 로 복사할 뿐이다 (`:1565`) |

### 4.3 프롤로그 바이트 레이아웃 — **12 B**

| off | size | 필드 | 인코딩 | 비고 |
|---:|---:|---|---|---|
| 0 | 8 | `checkpointSourceSeq` | uint64 BE | `WireIdentity.sourceSeq` (`:24`), `:1567` 에서 프레임마다 갱신 |
| 8 | 4 | `viewGeneration` | uint32 BE | `:21`. **`0x04`/`0x05`/`0x06` 과 같은 슬롯** |
| **합계** | **12** | | | `0x05` 와 동일 크기 |

**본문**: 원시 바이트. 길이 = `payloadLength - 12`. **0 이 정상이다** — `encodeCheckpointPayload('')` 는 `{data:'', encodedBytes:0}` 을 만든다 (`:875-879`).

### 4.4 손계산 예시 프레임 — `checkpoint-output-42`

§2.10/§3.5 의 트랜잭션 직후 첫 live output. 전송 `sourceSeq = 17`, checkpoint 평면 `sourceSeq = 501`, `viewGeneration = 11`, 본문 = `"hi"`(2 B).
`payloadLength = 12 + 2 = 14 = 0x0E`. `byteLength = 42`.

| off | hex | 의미 |
|---:|---|---|
| 0 | `01` | `frameVersion = 1` |
| 1 | `07` | `opcode = 0x07 CHECKPOINT_OUTPUT` |
| 2 | `0009` | `flags = 0x0009` |
| 4 | `00000001` | `channelId = 1` |
| 8 | `0000000000000001` | `streamEpoch = 1` |
| 16 | `0000000000000011` | `sourceSeq = 17 = 0x11` |
| 24 | `0000000e` | `payloadLength = 14 = 12 + 2` |
| 28 | `00000000000001f5` | `prologue.checkpointSourceSeq = 501 = 0x1F5` |
| 36 | `0000000b` | `prologue.viewGeneration = 11` |
| 40 | `6869` | 본문 = `h i` (2 B) |

```
hexFrame (42 B / 84 hex):
0107000900000001000000000000000100000000000000110000000e00000000000001f50000000b6869
```

검산: 16 + 16 + 16 + 8 + 16 + 8 + 4 = **84 hex = 42 B** ✔

### 4.5 거부 조건

| 조건 | 코드 | 등급 |
|---|---|---|
| `payloadLength < 12` | `payload-underrun` (기존) | fatal |
| `payloadLength - 12 > maxBodyBytes` | `payload-limit-exceeded` (기존) | scoped |
| `payloadLength === 12` (빈 본문) | **거부하지 않는다** | `encodeCheckpointPayload('')` 가 정상 경로다 (`:875-879`) |
| 프롤로그 값 도메인 위반 | **없음** | `0x07` 프롤로그는 uint64 + uint32 뿐이고 둘 다 전 범위가 유효하다. **이 opcode 만 `prologue-domain-violation` 을 유발할 수 없다** |

---

## 5. 거부 조건 총괄 — 기존 어휘로 표현 가능한가

### 5.1 `01:933-943` 의 10종 — 전부 opcode 무관

`binary-frame-on-json-group` / `truncated-header` / `bad-frame-version` / `unknown-opcode` / `reserved-flag-set` / `reserved-channel` / `unknown-channel` / `length-overrun` / `batch-terminated-early` / `batch-not-terminated`.

이 10종은 헤더 28 B 와 배치 경계만 보고 판정하므로(`binaryFrameCodec.ts:594-621`) **프롤로그 신설과 무관하게 그대로 성립**한다. 어휘 변경이 필요 없다.

### 5.2 S2 가 추가한 2종 — 그대로 확장된다

`payload-underrun` / `payload-limit-exceeded` (`binaryFrameCodec.ts:140-158`). 둘 다 `prologueBytes(opcode)` 를 매개로 동작하므로(`:624-638`), `prologueBytes()` 가 새 값 4개(`0x03`→24, `0x04`→160, `0x06`→88, `0x07`→12)를 반환하기만 하면 **자동으로 4종에 적용된다.**

`0x01` 만 갖는 `segmentCount` 추가 검사(`:626-630`)에 대응하는 것은 신설 4종에 없다 — 가변 배열이 없기 때문이다.

### 5.3 표현 불가능한 것 — 프롤로그 값 도메인

신설 프롤로그가 도입하는 fault 는 전부 같은 성격이다: **프레이밍은 건전한데 프롤로그 필드의 값이 정의된 도메인 밖**이다.

- `0x03`: `bufferType > 1`, `cursorHidden > 2`, `flags2 != 0`, off 20 예약 != 0
- `0x04`: `chunkCount == 0`, `cols/rows == 0`, `retainedActiveBuffer > 1`, `modesValueMask & ~modesPresentMask`, `flags2` 예약 비트, presence 비트와 필드값 불일치, off 79 예약 != 0
- `0x06`: `payloadLength > 88`, `chunkCount == 0`, `flags2` 예약 비트, off 22 예약 != 0
- `0x07`: 없음

기존 12종 중 어느 것으로도 표현되지 않는다. `reserved-flag-set` 은 **헤더의 `flags`** 전용이고(`:606`), `payload-underrun` 은 길이 전용이다.

### 5.4 그리고 이것은 **기존 `0x05` 에도 이미 있던 공백**이다

`0x05` 의 클라이언트 계약은 `chunkIndex < chunkCount` 이고 `chunkCount` 는 양수여야 한다(`frontend:1233-1235`). 그런데 현재 디코더는 이 둘을 검사하지 않는다(`binaryFrameCodec.ts:743-752` 이 값을 그대로 읽어 넘긴다). **신설 코드는 `0x05` 의 이 공백도 함께 닫는다.**

### 5.5 판정 — decoder-policy 코드 **1개** 신설

| 항목 | 내용 |
|---|---|
| 이름 | `prologue-domain-violation` |
| 분류 | **decoder-policy 코드** — `DECODER_POLICY_CODES` (`binaryFrameCodec.ts:158`)에 추가. `WIRE_REJECTION_CODES` (`:125-136`)는 **손대지 않는다** |
| 등급 | **scoped** |
| 근거 | `binaryFrameCodec.ts:164-186` 의 `rejectionGrade` 는 등급을 목록이 아니라 **성질**로 정한다 — "프레이밍을 신뢰할 수 없어 이후 오프셋이 무의미한가"(`01:957`). 프롤로그 값 위반에서는 `opcode` 가 레이아웃을 주고 `payloadLength` 가 버퍼와 일치하므로 `frameEnd` 를 안다. 이 프레임만 버리고 배치를 계속 파싱한다. fatal 로 매기면 같은 WS 메시지의 뒤쪽 프레임을 통째로 버리게 되는데, 그것이 `01:951` 이 반대하는 손실 패턴이다 |
| 선례 | S2 가 `payload-underrun`/`payload-limit-exceeded` 를 같은 방식으로 신설했고, 그 이유를 `:140-157` 에 남겼다 — "어휘 공백 자체는 협상 작업의 spec 항목이지 이 모듈이 wire 코드를 발명할 자리가 아니다". **`prologue-domain-violation` 도 같은 위치에 놓인다** |
| 대안 (기각) | (i) 디코드 시 검사하지 않고 인코더 단언에만 의존 → 비정합 피어의 `bufferType = 7` 이 클라이언트를 미정의 상태로 만든다. (ii) 위반 종류마다 코드 신설 → 어휘가 opcode 수에 비례해 늘어나고 `01:933-943` 의 "10종, 그 이상 없음" 규율이 무너진다 |

⇒ **`01:933-943` 의 wire 어휘는 개정할 필요가 없다.**

### 5.6 인코더 측 단언

디코더 정책과 별개로, 인코더는 `assertUint` (`binaryFrameCodec.ts:351-356`) / `assertOrdinal64` (`:363-367`) 계열로 **입구에서** 거부한다. 신설 4종에 필요한 추가 단언:

- `0x04`: `responderLeaseId !== undefined` → `RangeError` (§2.6)
- `0x04`: `connectionId` 가 수신 연결의 id 와 다름 → `RangeError` `[미확인]` (split 모드 확인 필요)
- `0x04`/`0x06`: `chunkCount` / `encodedByteTotal` 이 uint32 범위 초과 → `assertUint` 가 이미 throw. **잘라내지 않는다** — `encodedByteTotal` 의 무언의 wrap 은 digest 검증까지 통과할 수 있으므로 조용한 손상이 된다. 상한 4 GiB 는 설정된 어떤 retained 상한보다 크다(`config.schema.ts:77` 의 기본 2 MiB)
- `0x06`: `body.byteLength !== 0` → `RangeError`
- `0x03`: `viewportRows.length !== rows` → `RangeError`. §1.4 의 등가성이 깨지면 그 자리에서 알아야 한다. (현재 코드에서는 깨질 수 없다 — `headlessTerminal.ts:479` 참조)

---

## 6. `01:175` 의 요구는 충족되는가

### 6.1 `01:175` 의 주장

> `terminal-checkpoint:commit`(0x06) 은 페이로드가 작아 바이너리 이득이 거의 없다. 그럼에도 데이터 평면에 둔 것은 `[설계결정]` 이며 근거는 **순서**다: start → chunk × N → commit 이 하나의 `sourceSeq` 연속열을 이루는데, commit 만 JSON 텍스트 프레임으로 내보내면 그 연속열이 두 인코딩에 걸쳐 쪼개진다. … 디코더가 "이 스트림의 sourceSeq 는 연속이다"라는 불변식을 유지할 수 없게 된다.

### 6.2 `sourceSeq` 가 두 개다 — 두 해석 모두에서 주장이 성립하지 않는다

**해석 A — checkpoint 평면의 `sourceSeq`.** 이 값은 start/chunk/commit 에서 **연속열이 아니라 상수**다.

- 서버: 세 메시지 모두 같은 `identity` 에서 나온다 (`TerminalAuthorityProductionAdapter.ts:1758-1784` 가 `...identity` 를 셋 다에 펼친다). `identity.sourceSeq = snapshotSeq` (`:1677`).
- 클라이언트: `terminalCheckpointRuntime.ts:1207-1210` 이 output 이 아닌 모든 메시지에 대해 `activeIdentity.sourceSeq !== message.sourceSeq` 이면 `checkpoint-identity-mismatch` 로 실패시킨다. 즉 **같아야만 한다.**

⇒ "연속열"이 아니다. 상수다.

**해석 B — 헤더의 전송 계층 `sourceSeq`.** `01:311` 이 확정한 대로 이 값은 **바이너리 프레임마다 1 증가**한다. JSON control 메시지는 이 ordinal 을 소비하지 않는다 — 헤더가 없기 때문이다. 따라서 **commit 이 JSON 으로 나가도 남은 바이너리 프레임들의 `sourceSeq` 는 여전히 연속**이다. 클라이언트의 단조 검사(`terminalWriteCoordinator.ts:1140-1143`)는 갭을 보지 않는다.

⇒ 불변식이 깨지지 않는다.

**결론**: `01:175` 의 근거 서술은 §1.3 시점의 `sourceSeq` 해석과 §1.4(`01:293-320`)가 확정한 2계층 모델 사이에서 갈라진 채 남은 것이다. `06:1267` 이 D15 를 "01 자신의 설계결정을 깬다"고 표현한 것은 **`01:175` 의 문언 기준으로는 옳지만, 그 문언이 가리키는 불변식은 애초에 존재하지 않았다.**

### 6.3 그럼에도 이 설계는 요구를 충족한다 — 다른 이유로

`01:175` 가 지키려 한 실질(= 한 체크포인트 트랜잭션이 두 인코딩에 걸쳐 쪼개지지 않는 것)은 4종을 전부 바이너리에 두면 성립한다. §2.10/§3.5/§4.4 의 예시가 그것을 보인다:

| 프레임 | opcode | 전송 `sourceSeq` | checkpoint 평면 `sourceSeq` |
|---|---:|---:|---:|
| start | `0x04` | 12 | 500 |
| chunk 0 | `0x05` | 13 | (상속) |
| chunk 1 | `0x05` | 14 | (상속) |
| chunk 2 | `0x05` | 15 | (상속) |
| commit | `0x06` | 16 | 500 |
| output | `0x07` | 17 | 501 |

- 전송 계층: **12..16 연속** — 트랜잭션이 하나의 연속 구간을 차지한다.
- checkpoint 평면: start·commit 이 **500 으로 일치**하고, 이후 output 이 501 로 전진한다. `:1209` 의 등식 검사가 그대로 성립한다.

**단, 이것은 S4 배선에 대한 전제 조건이다** `[미확인]`. 전송 계층 ordinal 은 아직 존재하지 않는다 — `01:293-305` 가 확인한 대로 현행 live output 은 `streamEpoch`/`sourceSeq` 를 싣지 않는다. **S4 가 프레임마다 세션 ordinal 을 1 증가시키는 배선을 실제로 넣어야** 위 표가 성립한다. 넣지 않으면 헤더의 두 필드는 상수가 되고 갭 검출·롤백이 무력화된다(`01:319` 의 기각 사유와 같은 함정).

### 6.4 남는 위험 — 소켓 경계 — ✅ **반증 (2026-08-19)**

> **이 절의 폴백은 존재하지 않는다.** `WsRouter.ts:1106-1111` 가드가 `lane === 'terminal'` 이고 `wsTransportMode !== 'unified'` 인데 output 소켓이 OPEN 이 아니면 `onSettled(Error('terminal-authority-output-lane-unavailable'))` 후 `{sent:false}` 를 돌린다 — **거부이고 재라우팅이 아니다.** `: control` 분기(`:1112-1114`, 아래 인용은 1줄 드리프트)는 `unified` 에서만 도달하며 거기서 control 은 유일한 소켓이다. `unified` 연결은 `splitSocketGroups` 에 들어가지 않고(`:1685-1697`) output 채널을 붙일 수도 없다(`:1579-1591` → `close(1008,'invalid-output-pair')`).
>
> 아래가 근거로 든 **`01:330-334` 는 오인용**이다 — 그 범위는 live-output 식별자 표이고 lane 폴백을 언급하지 않는다. 즉 상위 근거가 없는 주장이었다.
>
> **`non-monotonic-source-seq` 인용도 틀렸다.** `terminalWriteCoordinator.ts:1140-1142` 는 `validateLiveOrder`(`:1744`)에서만 도달하고 `command.type === 'live'|'repair'` 게이트(`:1677`) 뒤이며 트랜잭션이 열려 있으면 조기 반환한다(`:1701-1743`) → **체크포인트 경로에 아예 없다.** 순서가 어긋난 체크포인트 프레임은 오늘도 이미 fail-closed 다: `terminalCheckpointRuntime.ts:1204-1213` `checkpoint-identity-mismatch`, `:1762-1763` `checkpoint-already-open`.
>
> 부수 확인: 체크포인트 평면 `sourceSeq` 는 트랜잭션 스코프 상수다(`Adapter.ts:1758-1784` 가 같은 `identity`/`metadata` 를 start·chunk·commit 에 전개) → 소켓 교체와 무관.
>
> **실재하는 `?? control` 폴백은 다른 곳이다** — `WsRouter.ts:5862` 의 `createFairDeliveryScheduler`. 그러나 fair-delivery 경로는 `message.type === 'output'` 게이트(`:6394-6399`) 뒤이므로 체크포인트 프레임이 지나가지 않는다. **이 절을 다시 쓴다면 대상은 `0x04`/`0x06`/`0x07` 이 아니라 `0x01`** 이다.
>
> 트랜잭션 핀은 batch 경로에만 있다: `pump.transportBindingId`(`Adapter.ts:1279-1283`) 불일치 시 `terminal-authority-transport-binding-replaced`(`WsRouter.ts:1116-1125`). controller 경로(`Controller.ts:761-772`)는 프레임마다 pump 가 비워져 재생성되므로 핀이 유지되지 않는다 — 다만 위의 이유로 실제 위험은 없다.
>
> 아래 본문은 판정 이력으로 보존한다.

WS 는 **소켓별로만** 순서를 보장한다. `01:330-334` 이 인용한 폴백(`WsRouter.ts:1111-1113`)은 output 소켓이 닫히거나 백프레셔에 걸리면 terminal payload 를 control 소켓으로 옮긴다. 트랜잭션 도중에 폴백이 발생하면 start 는 output 소켓, commit 은 control 소켓으로 나가고 **두 소켓 사이에는 순서 보장이 없다.**

- JSON 에서도 같은 위험이 있었으나 **증상이 달랐다** — JSON checkpoint 메시지에는 전송 `sourceSeq` 가 없어 순서 역전이 조용히 지나갈 수 있었다.
- 바이너리에서는 `terminalWriteCoordinator.ts:1140-1143` 의 `non-monotonic-source-seq` 로 **드러난다.** 관측 가능성은 개선이지만, 정상 운영 중 폴백만으로 복구 사이클이 도는 새 경로가 생긴다.

`[미확인]` — 체크포인트 트랜잭션 도중 lane 폴백이 실제로 발생 가능한지 확인하지 않았다. `enqueueSettledViewFrame(..., 'terminal')` 이 프레임 단위로 target 을 재평가한다면 가능하고, 트랜잭션 단위로 고정한다면 불가능하다. **S4 착수 전 확인 필요.**

---

## 7. control 평면에 남겨야 할 것

"4종을 전부 바이너리로 옮긴다"는 결론과 별개로, **세 가지는 반드시 JSON control 에 남는다.** 이것을 빠뜨리면 프롤로그가 참조하는 값이 wire 어디에도 없게 된다.

### 7.1 토큰 인덱스 매핑 — `repairTokenIndex` (신규) · `replayTokenIndex` (기존)

`0x03` 의 `repairTokenIndex` 는 UUID `repairToken` 의 채널 로컬 별칭이다. 클라이언트는 이 토큰을 **문자열 그대로** 서버에 되돌려 보내야 한다 — `screen-repair:ready` (`TerminalContainer.tsx:2922` `send({ type: 'screen-repair:ready', sessionId, repairToken: repair.repairToken })`)이고, 서버는 `handleScreenRepairReady` (`WsRouter.ts:3253`)에서 문자열 동일성으로 대조한다. 따라서 매핑이 JSON control 로 반드시 전달돼야 한다.

**인덱스 테이블에 새 정책 상수가 필요 없다** `[설계결정]`. 한 세션에 살아 있는 `repairToken` 은 **동시에 하나뿐**이다 — `markScreenRepairPending` (`WsRouter.ts:3863-3878`)이 `(소켓, 세션)` 당 하나의 `ScreenRepairPendingState` 를 `set` 하고 그때 `uuidv4()` 를 발급한다(`:3869`). 따라서 인덱스는 **채널별 1..65535 순환 카운터**로 충분하고 테이블도 상한도 필요 없다. `PERF-BGSTAB-010` AC-4 위반 없음.

`[미확인]` — `01:552` 이 `replayToken` 에 대해 남긴 회전 속도 실측 항목은 여전히 열려 있다. `repairToken` 은 위 근거로 닫혔으나, `replayToken` 이 매 snapshot 트랜잭션마다 새로 발급된다면(`WsRouter.ts:5269`) 같은 논증이 성립하는지 별도 확인이 필요하다.

### 7.2 `retentionPolicyId` — 채널 상태로 승격

가변 길이 문자열이며 형식은 `policyId` 또는 `` `${policyId}:debug:${isolationLeaseId}` `` 다 (`SessionManager.ts:5730-5738`). 고정폭 프롤로그에 들어가지 않는다.

**값이 정책 스코프라 체크포인트마다 바뀌지 않는다.** `compiledTerminalResourcePolicy.legacyPolicy.policyId` 에서 파생되며(`:5736`), 디버그 격리가 걸릴 때만 접미사가 붙는다(`:5738`). ⇒ **채널 상태**로 승격하고, `01:612-617` 이 `replayToken`/`repairToken` 을 채널 상태로 올린 것과 같은 취급을 한다. 전달은 채널 개설 시(`subscribed` 확장, `01:374-385`) 또는 변경 시 JSON control.

> ⚠️ 이 승격은 클라이언트의 ACK 에코(`terminalCheckpointRuntime.ts:488-504` `wireIdentity`)에서 `retentionPolicyId` 검증을 **자기비교**로 만든다 — 클라이언트가 서버에서 받은 값을 그대로 돌려주기 때문이다. 다만 JSON 에서도 이미 그러했으므로(클라이언트는 어차피 에코만 한다) **회귀는 아니다.** 이 필드로 무언가를 검증한다고 주장하는 테스트가 있다면 그것은 이미 공허했다.

### 7.3 `screen-repair` 의 C→S 절반

`ScreenRepairRequestMessage` (`server/src/types/ws-protocol.ts:618-626`)는 **JSON 에 남는다.** `01:173` 의 결정을 재확인한다 — v1 의 C→S 는 전부 JSON 이고 `CLIENT_TO_SERVER_OPCODE_BY_TYPE` 는 비어 있다(`binaryFrameCodec.ts:83`). 그리고 이 요청은 **부트스트랩**이다: 요청이 도착해야 서버가 `repairToken` 을 발급하고(`WsRouter.ts:3177`) 그래야 인덱스 매핑을 보낼 수 있다.

같은 이유로 `screen-repair:ready` / `screen-repair:failed` (`:628-639`), `screen-repair:rejected` / `:restore-needed` / `:reconnect-required` (`:662-702`)도 JSON 이다 — `01:180-182` 가 이미 그렇게 분류했다.

### 7.4 checkpoint 협상 계열 — 이미 JSON

`terminal-checkpoint:capability` (`:227-239`), `:rejected` (`:255-263`), `:continuity-rebound` / `:fresh-checkpoint-required` (`:272-303`)는 `01:183-187` 이 JSON 으로 확정했다. 변경 없음. 특히 `fresh-checkpoint-required` 의 `fullCheckpoint.chunks[]` 는 base64 를 유지한다(`01:186`) — **복구 경로 자체를 단순하게 두기 위한 의도된 비대칭**이며, `0x04`~`0x07` 이 바이너리가 되어도 이 결정은 유지된다.

### 7.5 판정 요약

| 대상 | 평면 | 근거 |
|---|---|---|
| `0x03` `ScreenRepairMessage` (S→C) | **바이너리** | 본문이 `maxSnapshotBytes` 까지 가는 ESC 조밀 ANSI. JSON 은 ESC 하나를 6 B 로 만든다(`01:628`). 게다가 `viewportRows[]` 중복 제거(§1.4). **4종 중 이득이 가장 크다** |
| `0x04` `:start` | **바이너리 (이득은 대역폭이 아니다)** | 본문(`parserTail`)은 통상 0 B 다. 이득은 metadata 압축이고 비용은 160 B 프롤로그 + base64 재인코딩(C1) + 채널 상태 의존(§7.2). **4종 중 유일하게 대역폭으로 정당화되지 않는다** — 정당화는 §6.3 의 트랜잭션 단일 인코딩이다 |
| `0x06` `:commit` | **바이너리 (이득이 있다)** | §8.3 |
| `0x07` `:output` | **바이너리** | checkpoint authority 하에서의 핫패스. `0x01 output` 의 checkpoint 모드 대응물이다(`:1563` 이 매 output record 마다 만든다). base64 33 % + ESC 이스케이프 제거 |
| `repairTokenIndex` 매핑 | **control** | §7.1 |
| `retentionPolicyId` | **control (채널 상태)** | §7.2 |
| `screen-repair` C→S 요청 + ready/failed/rejected 계열 | **control** | §7.3 |
| checkpoint 협상 계열 | **control** | §7.4 |

---

## 8. 기존 3종과의 정합성 점검

### 8.1 필드 명명

| 관례 | 기존 | 신설 | 상태 |
|---|---|---|---|
| 토큰 인덱스는 `<token>Index` | `authorityEpochIndex`, `replayTokenIndex` (`01:496`, `:518`) | `repairTokenIndex` | ✔ |
| 상대값은 `<field>Delta` | `screenSeqDelta` 등 (`01:532-538`) | 없음 (가변 배열 없음) | ✔ |
| 예약 확장 슬롯은 `flags2` | `0x02` (`01:550`) | `0x03`/`0x04`/`0x06` | ✔ — 단 §8.5 |
| 헤더 필드명과의 충돌 회피 | — | `checkpointSourceSeq` / `checkpointStreamEpoch` | **신설 관례.** 헤더에 `sourceSeq`/`streamEpoch` 이 이미 있고 값이 다르므로(§2.5) 접두사가 없으면 `parseFrameMessage` 반환 객체에서 두 값이 충돌한다 |
| `viewGeneration` 은 프롤로그+8 | `0x05` (`01:556`) | `0x04`/`0x06`/`0x07` **전부** | ✔ — **검증 가능한 불변식이 생겼다.** checkpoint 계열 4종에서 프롤로그 오프셋 8..11 은 항상 `viewGeneration` uint32 다 |
| 2값 enum 은 프롤로그+12 의 uint8 | `0x02` `mode` (`01:518`) | `0x03` `bufferType` | ✔ |

### 8.2 ⚠️ 인덱스 `0` 의 의미가 정의되지 않았다 — 소급 적용 필요

`01 §1.8` 은 `authorityEpochIndex`/`replayTokenIndex` 를 uint16 으로 정했으나 **`0` 의 의미를 정의하지 않았다.** `authorityEpoch` 는 optional 이므로(`ws-protocol.ts:30`) 부재를 표현할 수단이 필요하다.

`[설계결정]` — **인덱스는 1-based 이고 `0` 은 "absent" 로 영구 예약한다.** 근거는 `channelId = 0` 예약(`01:362`)과 같다 — 0 으로 채워진 버퍼가 유효한 참조로 보이지 않게 한다.

⚠️ **이 규칙은 `0x01`/`0x02` 에 소급 적용해야 한다.** 현재 골든 벡터 `screen-snapshot-54` 는 `authorityEpochIndex = 1`, `replayTokenIndex = 4` 를 쓰고 `output-minimal-52` 는 `authorityEpochIndex = 0` 을 쓴다 — 후자는 이 규칙 하에서 "authorityEpoch 부재"를 뜻하게 되며, 그것이 의도였는지 확인이 필요하다 `[미확인]`. 규칙을 채택하지 않으려면 대신 `0x04` 에 `AUTHORITY_EPOCH_PRESENT` flags2 비트를 추가해야 한다(bit4 를 예약해 두었다).

### 8.3 ⚠️ `01:175` 의 "commit 은 바이너리 이득이 거의 없다" 는 틀렸다

commit 이 JSON 으로 싣는 것을 세어 보면:

| 항목 | JSON 바이트 (근사) |
|---|---:|
| `type: "terminal-checkpoint:commit"` | 40 |
| `sessionId` UUID | 50 |
| `connectionId` UUID | 55 |
| `authorityEpoch` UUID | 57 |
| Ordinal64 decimal 5종 (`streamEpoch`/`checkpointEpoch`/`sourceSeq`/`snapshotSeq`/`oldestRetainedSeq`) + `transitionEpoch` | ~130 |
| `retentionPolicyId` | ~40 |
| `digest: {algorithm, hex}` — **hex 64자** | ~95 |
| `retainedStateDigest` — `"sha256:"` + **hex 64자** | ~90 |
| `contentDigest` (동일 형식) | ~85 |
| `chunkCount` / `encodedByteTotal` / `totalEncodedBytes` / `viewGeneration` / `protocolVersion` | ~90 |
| **합계** | **~730 B** `[미확인]` (실측 아님, 필드 길이 합산 추정) |

바이너리는 **116 B** (헤더 28 + 프롤로그 88). sha256 hex 두 개만으로도 128자 → 64 B 로 절반이 된다(`01:526` 이 이미 지적).

⇒ `01:175` 의 전제("페이로드가 작아 이득이 거의 없다")가 틀렸으므로, **commit 을 데이터 평면에 두는 결정은 순서 논증(§6)이 무너져도 대역폭만으로 독립적으로 정당화된다.** 이것이 D15 의 안 (b)(commit 을 JSON 예외로 등재)를 기각하는 실질적 이유다.

### 8.4 `PAYLOAD_UTF8_TEXT`(bit1) — 신설 4종은 세우지 않는다

`01:121-125` 가 든 기준은 "인코더가 `Buffer.from(str, 'utf8')` 를 쓰는 경로에서는 무조건 세운다" 이다. 그 기준을 문자 그대로 적용하면 **신설 4종 중 셋이 해당한다**:

- `0x03` 본문 = `ansiPatch` (JS 문자열, `headlessTerminal.ts:495`)
- `0x04` 본문 = `parserTail` → `encodeCheckpointPayload` → `Buffer.from(data, 'utf8')` (`:875`)
- `0x07` 본문 = `encodeCheckpointPayload(record.data)` → 동일 (`:875`)

그리고 **기존 `0x05` 도 해당한다** — `encodeCheckpointChunks` 역시 `Buffer.from(data, 'utf8')` 다(`:888`). 그런데 `defaultFlagsForOpcode` (`binaryFrameCodec.ts:394-399`)는 `0x01` 에만 세우고, 골든 벡터 `checkpoint-chunk-44`/`screen-snapshot-54` 도 `0x0009` 다. **즉 코드와 `01:123` 의 기준이 이미 어긋나 있다.**

`[설계결정]` — **기준을 "opcode 기준, v1 에서는 `0x01` 만" 으로 재서술하고 신설 4종도 `0x0009` 로 한다.** 근거:

- bit1 은 **힌트**다. 세우지 않아도 정확성 문제가 없고(`01:125`), 비용은 클라이언트의 `TextDecoder` 한 번이다.
- 이득이 있는 곳은 **핫패스뿐**이다. `0x03`/`0x04`/`0x06` 은 저빈도이고 `0x07` 은 checkpoint 평면이 승격된 뒤에야 핫해진다.
- 대안(기준대로 `0x03`/`0x04`/`0x05`/`0x07` 에 세우기)은 **기존 골든 벡터 2개를 바꾼다.** 힌트 비트 하나를 위해 확정된 벡터를 흔들 가치가 없다.
- 이 재서술은 `defaultFlagsForOpcode` 를 **한 줄도 바꾸지 않는다.**

### 8.5 `flags2` 슬롯은 opcode 간 고정이 아니다

`0x02`/`0x03` 은 프롤로그+14, `0x04` 는 +74, `0x06` 은 +20 이다. `01 §1.8` 이 슬롯 고정을 요구한 적이 없고, checkpoint 계열은 ordinal 블록이 앞에 와야 8정렬이 성립하므로 고정이 불가능하다. **`flags2` 는 "opcode 별 확장 비트필드" 이지 "고정 오프셋 필드" 가 아니다** — 이 사실을 명시해 두지 않으면 디코더가 opcode 무관하게 +14 를 읽는 실수가 나온다.

### 8.6 8정렬 유지

`01:57` 의 정렬 근거를 신설 프롤로그도 지킨다. 헤더가 28 B 이므로 프롤로그 시작은 28 (4정렬)이다. 프롤로그 **내부** 오프셋 기준으로:

| opcode | uint64 필드의 프롤로그 내 오프셋 | 8정렬 |
|---|---|---|
| `0x03` | 0 | ✔ |
| `0x04` | 0, 16, 24, 32, 40, 48, 56 | ✔ 전부 |
| `0x06` | 0 | ✔ |
| `0x07` | 0 | ✔ |

`0x04` 의 두 digest 는 96 / 128 로 **32정렬**이다.

프레임 절대 오프셋은 28 만큼 밀리므로 8정렬이 되지 않는다 — 이는 기존 `0x01`/`0x02`(프롤로그 내 `screenSeq`/`seq` 가 오프셋 0)와 **동일한 성질**이며, `01:57` 이 말한 정렬은 헤더 내부에 한정된 것이다. `DataView` 가 정렬을 요구하지 않으므로 현재 구현에 영향 없다.

### 8.7 `prologueBytes()` 확장 후의 값

| opcode | 현재 (`binaryFrameCodec.ts:108-118`) | 이 사양 적용 후 |
|---:|---:|---:|
| `0x01` | 24 | 24 (불변) |
| `0x02` | 24 | 24 (불변) |
| `0x03` | **0** | **24** |
| `0x04` | **0** | **160** |
| `0x05` | 12 | 12 (불변) |
| `0x06` | **0** | **88** |
| `0x07` | **0** | **12** |

`assertEncodableHead` (`:411-416`)의 `prologueBytes(...) === 0` 가드는 **그대로 둔다** — 미배정 opcode(`0x08`~)에 대한 방어로 계속 유효하다. 배정 7종은 모두 0 이 아니게 되므로 D15 가 닫힌다.

### 8.8 `parseFrameMessage` 의 반환 타입

`binaryFrameCodec.ts:684-686` 이 "프롤로그 스키마가 없는 알려진 opcode 는 `undefined` 를 반환한다"고 되어 있고 `:679` 주석이 `0x03/0x04/0x06/0x07` 을 명시한다. 이 사양 적용 후 **`undefined` 반환 경로는 도달 불가능해진다.** `BinaryWireMessage` union (`:345`)에 4종을 추가하고 반환 타입에서 `| undefined` 를 제거하는 것이 옳다 — 남겨 두면 호출부가 절대 성립하지 않는 분기를 계속 방어하게 된다.

---

## 9. 미해결 항목 (S4 착수 전 확인)

| # | 항목 | 마커 | 확인 방법 |
|---|---|---|---|
| 1 | `retainedTerminalStreamEpochCounter` (`SessionManager.ts:1076`)와 controller `getState().streamEpoch` 이 같은 값인가 | ✅ **판정: DIFFERENT** (2026-08-19) | 트리거 집합이 서로소. **`0x04` 160 B 유지, 벡터 재계산 불필요.** 근거·발산 시나리오 5건은 `docs/next/2026-08-19-binary-data-plane-handoff.md` §4 |
| 2 | `retained.checkpoint.cursor` 의 상한 | `[미확인]` | uint16 로 충분하면 `0x04` 프롤로그 160 → 152 B (§2.8) |
| 3 | `responderLeaseId` / `boundarySourceSeq` 가 실제로 checkpoint wire 에 실리는 경로가 있는가 | 🔴 **판정: ON-WIRE** (2026-08-19) | **§2.6 폐기.** `TerminalAuthorityController.ts:1588-1594` 가 rollback 경로의 `checkpointMessages` **전 원소**(start·chunk·commit)에 두 필드를 주입한다 → **`0x05` 12 B 도 깨진다.** 전문은 handoff §4 |
| 4 | split 모드에서 `view.connectionId` 가 어느 소켓의 id 인가 | `[미확인]` | 수신 클라이언트가 자신의 id 로 복원 가능한지가 걸려 있다 (§2.4) |
| 5 | 체크포인트 트랜잭션 도중 lane 폴백(`WsRouter.ts:1112-1114`, 인용 1줄 드리프트)이 발생 가능한가 | ✅ **판정: 반증 — 폴백이 없다** (2026-08-19) | **§6.4 폐기.** `:1106-1111` 가드가 output 소켓 사망 시 `sent:false` 로 거부한다(재라우팅 아님). 실재하는 `?? control`(`:5862`)은 `type==='output'` 게이트 뒤 → 대상은 `0x01`. 전문은 handoff §4 |
| 6 | metadata 13종(§2.1)을 프론트엔드 외의 소비자가 읽는가 | `[미확인]` | 읽는다면 제거가 회귀 |
| 7 | 골든 벡터 `output-minimal-52` 의 `authorityEpochIndex = 0` 이 "부재" 의도였는가 | `[미확인]` | §8.2 의 소급 규칙 적용 가부 |
| 8 | `replayToken` 회전 속도 (`01:520` 의 열린 항목) | `[미확인]` | 인덱스화 이득 유무. `repairToken` 은 §7.1 에서 닫힘 |
| 9 | `0x03` 의 미지 `repairTokenIndex` 수신 시 ACK 타임아웃 수렴 | `[미확인]` | §1.8 |

---

## 부록 A — 프롤로그 요약 (구현용, `01` 부록 A 형식)

```
프롤로그 (PROLOGUE_PRESENT 시). 전부 big-endian.

  0x01 OUTPUT           24B  screenSeq u64 | chunkIdBase u64 |
                             authorityRevision u32 | authorityEpochIndex u16 |
                             segmentCount u16                            [01:490-496]
        + segment × N   16B  byteStart u32 | byteEnd u32 | screenSeqDelta u32 |
                             authorityRevisionDelta u16 | chunkIdDelta u16 [01:500-507]

  0x02 SCREEN_SNAPSHOT  24B  seq u64 | cols u16 | rows u16 | mode u8 |
                             truncated u8 | flags2 u16 | authorityRevision u32 |
                             authorityEpochIndex u16 | replayTokenIndex u16 [01:518]

  0x03 SCREEN_REPAIR    24B  seq u64 | cols u16 | rows u16 | bufferType u8 |
                             cursorHidden u8 | flags2 u16 | cursorX u16 |
                             cursorY u16 | reserved u16 | repairTokenIndex u16   ← 신설
                             본문 = ansiPatch UTF-8.  viewportRows[] 는 싣지 않는다

  0x04 CHECKPOINT_START 160B checkpointSourceSeq u64 | viewGeneration u32 |
                             chunkCount u32 | checkpointStreamEpoch u64 |
                             checkpointEpoch u64 | snapshotSeq u64 |
                             oldestRetainedSeq u64 | transitionEpoch u64 |
                             boundarySourceSeq u64 | encodedByteTotal u32 |
                             cols u16 | rows u16 | authorityEpochIndex u16 |
                             flags2 u16 | modesPresentMask u8 | modesValueMask u8 |
                             retainedActiveBuffer u8 | reserved u8 |
                             retainedCursorX u32 | retainedCursorY u32 |
                             retainedSavedCursorX u32 | retainedSavedCursorY u32 |
                             digest[32] | retainedStateDigest[32]              ← 신설
                             본문 = parserTail 원시 바이트 (통상 0 B)
                             flags2: bit0 RETAINED_STATE_PRESENT
                                     bit1 TRANSITION_EPOCH_PRESENT
                                     bit2 BOUNDARY_SOURCE_SEQ_PRESENT
                                     bit3 SAVED_CURSOR_NON_NULL
                                     bit4-15 예약(0)

  0x05 CHECKPOINT_CHUNK 12B  chunkIndex u32 | chunkCount u32 | viewGeneration u32 [01:556]

  0x06 CHECKPOINT_COMMIT 88B checkpointSourceSeq u64 | viewGeneration u32 |
                             chunkCount u32 | encodedByteTotal u32 | flags2 u16 |
                             reserved u16 | digest[32] | retainedStateDigest[32]  ← 신설
                             본문 없음. payloadLength === 88 이어야 한다
                             flags2: bit0 RETAINED_STATE_DIGEST_PRESENT, bit1-15 예약(0)

  0x07 CHECKPOINT_OUTPUT 12B checkpointSourceSeq u64 | viewGeneration u32        ← 신설
                             본문 = 원시 바이트 (0 B 가능)

불변식:
  - checkpoint 계열(0x04/0x05/0x06/0x07)의 프롤로그 오프셋 8..11 = viewGeneration u32
  - 0x04 와 0x06 의 프롤로그 오프셋 0..15 는 동일 (checkpointSourceSeq/viewGeneration/chunkCount)
  - 인덱스 필드(authorityEpochIndex / replayTokenIndex / repairTokenIndex)는 1-based, 0 = absent
  - 모든 uint64 는 프롤로그 내부 8정렬
  - 프롤로그 길이는 opcode 만의 함수다. flags 에 의존시키지 않는다
  - v1 에서 PAYLOAD_UTF8_TEXT(bit1)를 세우는 opcode 는 0x01 뿐이다
```

## 부록 B — 골든 벡터 4종 요약

| 이름 | opcode | byteLength | payloadLength | 본문 | 정의 위치 |
|---|---:|---:|---:|---|---|
| `screen-repair-55` | `0x03` | 55 | 27 | `1b5b48` (ESC `[` `H`) | §1.7 |
| `checkpoint-start-188` | `0x04` | 188 | 160 | 없음 | §2.10 |
| `checkpoint-commit-116` | `0x06` | 116 | 88 | 없음 | §3.5 |
| `checkpoint-output-42` | `0x07` | 42 | 14 | `6869` (`hi`) | §4.4 |

두 벡터가 공유하는 32 B 값 (`digest` / `retainedStateDigest`) — start 와 commit 이 **같은 값**이어야 §3.2 의 교차검증이 통과한다:

```
digest              = 00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
retainedStateDigest = ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100
```

⚠️ 이 두 값은 **실제 sha256 이 아니다.** 코덱은 digest 를 검증하지 않으므로(검증은 `terminalCheckpointRuntime.ts:430-460` / `:1229-1236` 의 상위 계층) 코덱 벡터로는 임의의 32 B 로 충분하다. 상위 계층 테스트에 이 벡터를 재사용하려면 **실제 digest 를 계산해 넣어야 하며**, 그렇게 하지 않고 통과하는 테스트는 digest 를 검증하지 않고 있는 것이다.

네 벡터는 **하나의 체크포인트 트랜잭션**(§6.3 의 표)에서 나온 값을 쓰므로, `binary-frame-vectors.json` 에 배치 벡터(`batch-*`)로 묶어 전송 `sourceSeq` 연속성까지 한 번에 검증할 수 있다. 각 벡터의 `layout` 배열은 §1.7 / §2.10 / §3.5 / §4.4 의 표를 그대로 옮기면 된다 — 그 표들이 이미 `[offset, hex, meaning]` 3열이다.
