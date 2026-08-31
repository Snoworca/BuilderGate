# 바이너리 데이터 평면 — 이슈 #29·#30·#31 해결 — 세션 핸드오프

## ⚠️ 검증 상태 — 독립 검증 없음

**사실검증 서브에이전트가 판정을 반환하지 않았다** (2026-08-26, 3회 요청, 전부 판정 없이 유휴). 이 문서는 **독립 검증을 받지 않았다.**

대신 작성자가 **기계적으로 확인 가능한 축을 직접 대조했다**. 아래는 실제로 명령을 돌려 확인한 것이다:

| 축 | 결과 |
| --- | --- |
| 이슈 #29·#30·#31 의 존재·제목·label `bug` | 3/3 일치 (`gh issue list`) |
| `01-frame-format-and-negotiation.md` 앵커 `:350`·`:369-371`·`:374`·`:393`·`:570-571`·`:725`·`:1308` | 7/7 일치 |
| `07-prologue-spec-remaining-opcodes.md` `:117`(off 20 예약)·`:404`(off 72 고정) | 2/2 일치 |
| `TerminalContainer.tsx` `:3251-3253`·`:3294`·`:3386` | 3/3 일치 |
| `WebSocketContext.tsx` `:156`·`:748`·`:1133`·`:606-608` | 4/4 일치 |
| 골든 벡터 중 `authorityEpochIndex` 보유 | **10/11** |
| `wsFrameDispatch` 16 / `terminalChannelRegistry` 36 / `liveOutputTokens` 22 | 재실행 3/3 일치 |
| ahead 137 / behind 0 · `01` 1622줄 · `readyStart + 1300` · `process.exitCode = 1` | 일치 |

**자체 대조가 거짓 2건을 잡아 고쳤다**: `porcelain` 377→**378**, restore-needed 기록 지점 `:1842`→**`:1862`**.

**검증되지 않은 것**: 판단이 필요한 축 — 「확정된 결정」의 정합성, 후보 선택의 타당성, 「다음 세션 지시서」가 실제로 실행 가능한지. 작성자가 자기 문서를 판정하면 자기검증이므로 하지 않았다. **다음 세션은 이 축들을 사실로 받지 말고, 처음 부딪히는 지점에서 재확인하라.**

| Field | Value |
| --- | --- |
| 작성일 | 2026-08-26 |
| 저장소 / 브랜치 | `C:/Work/git/_Snoworca/ProjectMaster` / `work/mcp-session-orchestration-20260709` |
| HEAD | `dfca40cf506dcbc60a170a7f3ca4fbe9f426b9d9` — **이 작업은 전부 미커밋** |
| 최종 작업 목표 | GitHub 이슈 **#30** 을 해결해 바이너리 프레임이 실제로 터미널에 흐르게 한다 |
| 현재 상태 | S4-C5 배선 5건 완료·검증됨. 이슈 3건 등록(#29·#30·#31), **#29 는 1차 해결** |
| 다음 세션 첫 행동 | 아래 「다음 세션의 첫 행동」 |
| 선행 핸드오프 | `C:/Work/git/_Snoworca/ProjectMaster/docs/next/2026-08-25-binary-data-plane-c5-wiring.md` (C5 배선 상세·함정 다수) |
| 프로젝트 SSOT | `C:/Work/git/_Snoworca/ProjectMaster/docs/next/2026-08-19-binary-data-plane-handoff.md` |

---

## 다음 세션의 첫 행동

1. 이 문서를 끝까지 읽는다.
2. `gh issue view 30` 로 이슈 본문을 읽는다. **거기 적힌 세 개의 판정 뒤집기가 이 작업의 핵심 제약이다.**
3. `git status --porcelain | wc -l` 이 **378 근처**인지 본다. 아니면 그 사이 누가 커밋했거나 되돌린 것이니 아래 「워킹트리 상태」를 믿지 말고 실제를 믿어라.
4. **사용자에게 `:3294` 정책을 묻는다.** 이것이 #30 의 유일한 blocking 결정이고, 정하지 않으면 배선을 시작할 수 없다. 선택지는 아래 「먼저 물어야 할 것」에 있다.

---

## 1. 최종 작업 목표

터미널 출력을 JSON 대신 바이너리 프레임으로 보내는 전환에서, **클라이언트가 도착한 바이너리 프레임을 실제로 화면에 그리게 만든다.**

현재는 도착해도 `console.warn` 후 버린다. 그것을 `decodeWsMessage → parseFrameMessage → fromBinaryOutputFrame → onOutput` 으로 잇는 것이 남은 일이고, 그 앞을 막고 있는 것이 이슈 #30 이다.

⚠️ **#30 을 다 해도 end-to-end 로는 아무것도 흐르지 않는다.** 서버가 바이너리를 보내려면 S4-a(서버 인코드 표면) + D10 협상 메시지 5종 + `realtime.terminalWireFormat` 설정키가 필요하고 셋 다 미착수다. 검증 수단은 골든 벡터와 단위 테스트뿐이다. 브라우저에서 눈으로 확인하려 하지 마라.

## 2. 등록한 이슈

| 이슈 | 제목 | 상태 |
| --- | --- | --- |
| [#29](https://github.com/Snoworca/BuilderGate/issues/29) | 바이너리 프레임의 `authorityEpoch` 별칭을 UUID 로 되돌릴 매핑이 어느 메시지에도 없다 | **1차 해결** — 사양 개정 R3 + 타입 정렬 완료. 서버 emit 은 S4-a 몫 |
| [#30](https://github.com/Snoworca/BuilderGate/issues/30) | 바이너리 IR 의 identity 3개가 서로 다른 컴포넌트에 흩어져 있고, `08:224` 를 따르면 출력이 사라진다 | **다음 세션의 본 과제** |
| [#31](https://github.com/Snoworca/BuilderGate/issues/31) | `channel-retired` 배선 시 `reason` 을 안 보면 채널 표가 굳어 터미널이 조용해진다 | 등록만. D10 배선자용 전제조건이라 지금 할 일 없음 |

전부 label `bug`, 상위 이슈는 `#19 [Orca][P9]`.

## 3. 이번 세션에 완료한 작업

### S4-C5 배선 (선행 핸드오프의 과제)

| 단계 | 산출물 | 테스트 | 뮤테이션 |
| --- | --- | --- | --- |
| C5-b 수신 분기 | `frontend/src/utils/wsFrameDispatch.ts` | 16/16 | 14/14 KILLED |
| C5-c 채널 등록부 | `frontend/src/utils/terminalChannelRegistry.ts` | 36/36 | 39/39 KILLED |
| C5-d 토큰 저장소 | `frontend/src/utils/liveOutputTokens.ts` | 22/22 | 16/16 KILLED |

전부 test-first. 뮤테이션 하네스는 `<SCRATCH>/mutate-{dispatch,registry,tokens}.mjs` 이고 매번 baseline 을 먼저 파싱해 자가검증한다. `<SCRATCH>` = `C:/Users/beom/AppData/Local/Temp/claude/C--Work-git--Snoworca-ProjectMaster/55a81fdc-c9a5-4ed0-a9c7-b20edcbbf749/scratchpad`.

### 이슈 #29 의 1차 해결

- **`01 §1.8` 에 개정 조항 R3 을 적었다** (`docs/research/binary-comms/01-frame-format-and-negotiation.md:350`). R1·R2 와 같은 인라인 형태. **파일은 1622줄 그대로**이고 `git diff -U0` 의 전 hunk 가 `-N +N` 1:1 이다 (2026-08-26 확인).
- **양쪽 `SubscribedSessionInfo` 에 `channelId?` / `streamEpoch?` / `authorityEpoch?` 추가** — `server/src/types/ws-protocol.ts:798`, `frontend/src/types/ws-protocol.ts:880`.

### 회귀 (2026-08-26 실행)

| 명령 (cwd 명시) | 결과 |
| --- | --- |
| `cd C:/Work/git/_Snoworca/ProjectMaster/frontend && env -u NODE_ENV npx tsc -p tsconfig.app.json --noEmit` | exit 0 |
| `cd C:/Work/git/_Snoworca/ProjectMaster/frontend && env -u NODE_ENV npm run typecheck:tests` | exit 0 |
| `cd C:/Work/git/_Snoworca/ProjectMaster/server && env -u NODE_ENV npx tsc --noEmit -p tsconfig.json` | exit 0 |
| 프론트 단위 전수 (`tests/unit/*.test.ts` 파일별) | **70파일 / pass 828 / fail 6 / todo 0** |

실패 6건의 **테스트명 집합이 기준선과 동일**하다 → 회귀 0. 명단: `terminalCheckpointRuntime.test.ts` 3건 · `terminalContainerRecoveryContract.test.ts` 1건 · `terminalHiddenOutput.test.ts` 1건 · `wsCheckpointProtocol.test.ts` 1건.

## 4. 워킹트리 상태

- `git status --porcelain` 총 **378 엔트리** (2026-08-26 측정, 본 문서 포함). **공유 워킹트리**이고 대부분이 이 작업과 무관한 남의 미커밋 작업이다. 스테이징된 변경 **0건**.
- `origin/main` 대비 **ahead 137 / behind 0**.

이 작업이 만들거나 만진 파일:

| 상태 | 경로 (`C:/Work/git/_Snoworca/ProjectMaster/` 기준) |
| --- | --- |
| `??` | `frontend/src/utils/{wsFrameDispatch,terminalChannelRegistry,liveOutputTokens,binaryFrameCodec,terminalOutputDelivery}.ts` |
| `??` | `frontend/tests/unit/{wsFrameDispatch,terminalChannelRegistry,liveOutputTokens,binaryFrameCodec,terminalOutputDeliveryBinary}.test.ts` |
| `??` | `CLAUDE.local.md` · `docs/next/2026-08-25-binary-data-plane-c5-wiring.md` · `docs/next/LATEST.md` · `docs/worklog/2026-08-26.jsonl` · 본 문서 |
| ` M` | `frontend/src/contexts/WebSocketContext.tsx` · `frontend/src/components/Terminal/TerminalContainer.tsx` · `frontend/src/types/ws-protocol.ts` · `frontend/tsconfig.test.json` |
| ` M` | `server/src/types/ws-protocol.ts` · `server/src/ws/binaryFrameCodec.ts` · `server/src/ws/binaryFrameCodec.test.ts` |
| ` M` | `docs/research/binary-comms/{01,06,07,08}-*.md` · `docs/next/2026-08-19-binary-data-plane-handoff.md` |

🔴 **커밋하지 마라.** 커밋 단위는 사용자 결정 대기 항목이다. `WebSocketContext.tsx`·`TerminalContainer.tsx` 등은 남의 미커밋 델타를 1,000~2,900줄씩 안고 있어 `git commit -- <경로>` 로도 분리되지 않는다.

## 5. 확정된 결정 (재논의 금지)

1. **`authorityEpochIndex` 는 프롤로그에 남긴다** — **확정**. 제거안은 골든 벡터 11개 중 10개 재계산 + 동결 부속서 `07` 의 오프셋 표 전면 무효(`07:404` `0x04` off 72, `07:117` `0x03` off 20)를 부른다.
2. **UUID 는 두 control 메시지가 싣는다** — **확정**. `SubscribedSessionInfo`(`01:374-385`)와 `terminal-binary:capability.channels[]`(`01:725-737`)에 `authorityEpoch: string`. 근거는 개정 R3 (`01:350`).
3. **`08:224` 의 JSON 폴백을 구현하지 않는다** — **확정**. 없던 토큰을 채우면 판정이 세 곳에서 뒤집히고 둘은 출력을 잃는다. 상세는 #30 본문. `fromJsonOutputMessage` 는 메시지만 읽게 둔다.
4. **저장소 조회는 바이너리 경로 전용** — **확정**. (3)의 따름정리.
5. **이음매는 실재하며 `identity` 인자가 그 자리다** — **확정**. 채우기가 바이너리 전용이어야 하므로 codec 구분이 채우는 지점까지 살아야 하고, 그 답이 이미 나와 있는 유일한 곳이 컨텍스트의 어댑터 선택이다.
6. **채널 등록부는 `channelId` 로 키잉한다** — **확정**. `08:192` 가 지정한 자료구조에 인덱스 열이 없고, 채널↔세션 1:1(`01:369-371`·`01:393`)이라 인덱스는 재진술이다.
7. **채널 재바인딩은 `sessionId` 변경 기준으로 거부한다** — **확정**. `state === 'retired'` 기준이 아니다.
8. **토큰은 "그 값이 적용/수락되는 지점" 에 기록한다** — **확정**. 도착 시점이 아니다. 현재 6개 지점 전부 그렇게 돼 있다.
9. **`07` 은 in-place 개정하지 않는다** — **확정**. `01 §1.8` 에 개정 조항을 적고 `07` 은 stale 로 고지한다 (`01:570-571`).

## 6. 먼저 물어야 할 것 (blocking)

🔴 **`frontend/src/components/Terminal/TerminalContainer.tsx:3294` 의 정책.** 이것을 정하지 않으면 #30 배선을 시작할 수 없다.

```ts
if (delivery.replayToken !== compatibilityPostAckConvergence.replayToken) {
```

`replayToken` 이 `undefined` 면 이 비교가 참이 되어 `failCompatibilityPostAckConvergence('output-replay-token-mismatch')` 로 간다. 바로 아래 `:3386` 의 `repairToken` 검사에는 `!== undefined` 가드가 있는데 **여기엔 없다.** 즉 토큰을 못 구한 바이너리 프레임이 R1 복구 중에 도착하면 그 수렴이 깨진다. **어느 후보 설계도 이걸 해결하지 못한다.**

선택지:
- (a) `:3294` 에 `:3386` 과 같은 `!== undefined` 가드를 붙인다 — 토큰 없는 프레임을 관대하게 통과시킨다
- (b) 토큰을 못 구한 바이너리 프레임은 배달하지 않는다 — 안전하지만 출력이 사라진다
- (c) 다른 것

## 7. 남은 작업 전체 목록

- [ ] **#30 배선** — 완료 조건: 바이너리 프레임이 도착하면 `decodeWsMessage` → `parseFrameMessage` → `fromBinaryOutputFrame` → 기존 `onOutput` 경로로 흐르고, 프론트 전수가 fail 6(같은 테스트명)을 유지한다. 선행: 위 `:3294` 정책 결정
- [ ] **#29 서버 emit** — `subscribed` 가 `channelId`/`streamEpoch`/`authorityEpoch` 를 실제로 싣는다. 선행: 채널 할당자(S4-a)
- [ ] **#31** — D10 배선 시 `channel-retired` 의 `reason` 으로 `retire`/`clear` 를 가른다. 선행: D10 메시지 타입 신설
- [ ] **S4-a 서버 인코드 표면** — end-to-end 의 전제
- [ ] **D10 협상 메시지 5종** — `terminal-binary:negotiate`/`:capability`/`:rejected`/`:channel-retired`/`:unknown-channel`. 프론트에 **0건** 구현
- [ ] **`realtime.terminalWireFormat` 설정키** — 4값 사다리 `json | binary-shadow | binary-optin | binary`
- [ ] **C6 마이크로벤치 + 동등성** — 선행: 위 전부
- [ ] `08:226` 경계 대조군을 **채우는 방향**으로 다시 쓴다 — 현재 문면("비우고 green")은 공허 통과다
- [ ] `08` 자신의 stale 앵커 정정 — `08:145` 의 `WebSocketContext.tsx:1140`/`:592` → 실제 `:1181`/`:607`; `08:207-210` 의 `TerminalContainer.tsx:3305`/`:3199`/`:3320`/`:3392`/`:3436` → 실제 `:3386`/`:3294`/`:3401`/`:3464`/`:3508`
- [ ] `01:1308` 인덱스 `0` 의미 확정 — R3 이 닫지 않았다. 클라이언트에는 무의미해졌고 서버 인코더·벡터 해석에만 남는다
- [ ] C5-d 세대 키가 epoch 롤백을 안 덮는다 — 선행: `06` D5 롤백 함수 확정(미결)
- [ ] split 모드에서 restore-needed 의 토큰 기록 지점(`TerminalContainer.tsx:1862`, 2026-08-26 실측)에 도달하지 못한다 — `restoreAdapter.begin()` 이 `ignored` 를 반환하고 그 위에서 return 한다. ⚠️ 이 줄번호는 밀리기 쉽다. 재측정: `grep -n "recordLiveOutputTokens(" frontend/src/components/Terminal/TerminalContainer.tsx` 가 내는 8줄 중 두 번째
- [ ] GitHub 이슈 5건(`#2`·`#19`·`#20`·`#21`·`#22`)이 폐기된 측정 게이트를 언급 — 문안 미정

## 8. 다음 세션 지시서

### #30 배선 절차

**전부 TDD. 실패 테스트를 먼저 쓰고 red 를 눈으로 확인한 뒤 구현한다.** 구현 후 반드시 뮤턴트를 건다.

1. **`:3294` 정책을 사용자에게 묻는다.** 답이 나오기 전에는 코드를 쓰지 마라.
2. **어댑터 호출을 컨텍스트에 붙인다.** `frontend/src/contexts/WebSocketContext.tsx` 의 `frame.kind === 'binary'` 갈래(현재 `console.warn` + `return`)를 교체한다.
   - `maxBodyBytes` 는 `deriveMaxBodyBytes(getCachedTerminalOutputResourceLimits())` 로 얻는다
   - `channelState` 는 `channelRegistryRef.current.channelState` 를 그대로 넘긴다 (바인딩 불필요 — 테스트가 핀함)
   - `decodeWsMessage` 는 **`fatal` 이어도 이미 파싱한 `frames` 를 버리지 않는다**. 프레임을 먼저 배달하고 `fatal` 을 나중에 처리하라
3. **`authorityEpoch` 는 컨텍스트가 채운다** — `channelRegistryRef.current.lookup(channelId)?.authorityEpoch`. 컨테이너에는 `channelId` 가 없으므로 여기서만 가능하다.
4. **토큰은 `SessionHandlers` 에 조회 함수를 붙여 컨텍스트가 끌어온다** (권장안). 선례가 있다 — `getViewGeneration: () => number`(`WebSocketContext.tsx:156`)가 메시지 처리 도중 동기 호출된다(`:748`). 컨텍스트는 `:1133` 에서 이미 `handlers` 를 손에 쥐고 있다.
   - ⚠️ 이 선례의 약점: `getViewGeneration` 은 **관문**의 선례이지 **값**의 선례가 아니다. 틀리면 거절 로그가 남지만, 토큰은 복구 버퍼에 기록되어 나중에 증명으로 쓰이므로 낡은 값을 집으면 **틀린 증명**이 된다.
5. 뮤턴트: 디코드 결과 무시 / `fatal` 시 조기 반환 / `identity` 를 빈 객체로 / `authorityEpoch` 를 채우지 않음 → 전부 KILLED 여야 한다.

### 매 단계 후 회귀

```
cd C:/Work/git/_Snoworca/ProjectMaster/frontend && env -u NODE_ENV npx tsc -p tsconfig.app.json --noEmit && env -u NODE_ENV npm run typecheck:tests
```

프론트 전수는 파일별로 돌려 **fail 6 과 그 테스트명 집합**을 대조한다. `npx playwright test` 는 이 단계에서 돌리지 마라 — `frontend/tests/unit/` 를 0건 수집하고 프로덕션 서버를 띄운다.

## 9. 함정

- **`kill <pid>` / `taskkill /F /IM node.exe` 절대 금지.** dev 서버 포트는 항상 **2222**.
- **커밋 메시지에 어떤 시그니처도 넣지 않는다.** 제목에 `Phase n`/`Step n`/`TASK-XXX` 도 금지.
- **셸에 `BUILDERGATE_*` 15개 + `NODE_ENV=production` 이 있고 다른 런타임 루트를 가리킨다.** 테스트 명령은 전부 `env -u NODE_ENV` 를 붙인다.
- **`cd` 가 Bash 호출 간에 유지된다.** 스크래치패드 하네스를 저장소 루트에서 돌린 뒤 `frontend/` 명령을 상대경로로 쓰면 조용히 엉뚱한 곳에서 돈다. **매 호출마다 절대경로 `cd` 를 써라.**
- **node 의 `ℹ` 는 멀티바이트다.** `grep "^. pass"` 로 파싱하면 조용히 0건이 된다. `grep -oE "pass [0-9]+"` 를 써라.
- 🔴 **뮤테이션 100% KILLED 는 "빠진 케이스 없음"을 뜻하지 않는다.** 뮤테이션은 **깨진** 가드를 잡고 **좁은** 가드는 못 잡는다. 이번 세션에 등록부 가드가 32/32 KILLED 이면서 동시에 구멍 3개를 갖고 있었다. 더 나쁜 신호를 놓쳤다 — **수정에 해당하는 뮤턴트가 KILLED 로 찍혀 있었다**(= 테스트가 버그를 지키고 있다는 뜻). **뮤턴트 목록을 볼 때 "이 뮤턴트가 사실은 개선 아닌가?"를 물어라.** 그리고 수정 후에는 옛 동작으로 되돌리는 **회귀 뮤턴트**를 반드시 추가하라.
- 🔴 **`npm run typecheck:tests` 는 새 테스트 파일을 보지 않는다.** `frontend/tsconfig.test.json` 의 `files` 는 손으로 늘리는 허용목록이다. 여기 없는 테스트는 `tsc` 를 아예 통과하지 않고 `--experimental-strip-types` 는 타입체크를 하지 않으므로 **타입 에러가 영구히 숨는다.** 2026-08-26 에 5개 파일을 넣자마자 실제 에러 4건이 나왔다. **테스트 파일을 새로 만들면 그 자리에서 `files` 에 추가하라.**
- 🔴 **source-text 계약 테스트의 고정 창.** `frontend/tests/unit/terminalContainerRecoveryContract.test.ts` 가 `source.slice(readyStart, readyStart + 1300)` 로 자른 뒤 그 안에서 순서를 단언한다. `setCurrentViewReady` 안에 5줄을 넣었더니 단언 대상이 창 밖으로 밀려 red 가 됐다 — 제품 동작과 무관하다.
- 🔴 **`01-frame-format-and-negotiation.md` 는 1622줄을 유지해야 한다.** 다른 문서·테스트가 줄번호로 인용한다. 자연스럽게 고쳤다가 1632줄이 되며 하류 앵커 23개가 +10 밀린 전례가 있다. **개정은 기존 줄에 인라인으로 덧붙여라**(R1·R2·R3 전부 그 형태). 검증: `wc -l` 이 1622 + `git diff -U0` 의 전 hunk 가 `-N +N`.
- 🔴 **서브에이전트가 유휴로 들어가고도 보고 텍스트를 반환하는 일이 드물다** — 이번 세션에만 7회 이상. `run_in_background: false` 로 띄워도 그렇다. `SendMessage` 로 "reply 의 TEXT 로 보내라"고 **명시해 재요청**하라. 그마저 안 되면 **기계적으로 확인 가능한 축은 직접 돌려라.**
- **python heredoc 으로 하네스를 고치지 마라.** `\n` 이 실제 개행으로 바뀌어 JS 문자열 리터럴이 깨진다. `Write`/`Edit` 도구를 쓰거나 템플릿 리터럴(백틱)을 써라.
- **`cd server && npx tsx src/test-runner.ts` 는 exit 1 을 낸다** (`src/test-runner.ts:672`). exit code 를 못 믿는 반례는 `WsRouterSplitHandshake.test.ts` 하나뿐이다(`fail 0 / todo 14` 인데 exit 0, 그 14개가 `✖` 에 찍힌다).

## 10. 리스크

- **깨끗한 diff 기준선이 없다.** #30 이 만질 추적 파일들이 남의 미커밋 델타를 대규모로 안고 있다(`TerminalView.tsx` 2,868 / `terminalOutputScheduler.ts` 2,058 / `TerminalContainer.tsx` 1,952 / `visibleOutputRecovery.ts` 1,888 / `WebSocketContext.tsx` 1,154 / `frontend/src/types/ws-protocol.ts` 1,094 — 2026-08-22 실측). 대응: 신규 파일에 최대한 가두고 기존 파일 수정은 최소 줄로.
- **바이너리 갈래는 현재 "받으면 버린다" 가 실제 동작이다.** 협상이 없어 도달 불가하므로 프로덕션 동작은 불변이지만, 완성된 디코드 경로로 오해하지 마라.
- **⚠️ 미검증 — 이번 세션의 문서 편집(R3 조항, 이슈 3건 본문)은 독립 서브에이전트 검증을 받지 않았다.** 인용 앵커는 게시 전에 직접 실측 대조했다(#30 6/6, #31 5/5, #29 의 골든 벡터·`07` 오프셋·`SessionManager.ts:182`). 판단이 필요한 축(후보 선택의 타당성)은 검증되지 않았다.
- **grace 재생에 경합이 있다.** 스냅샷 핸들러가 `void` 로 던져진 async 라(`TerminalContainer.tsx:3251-3253`), 출력 재생(`WebSocketContext.tsx:606-608`)이 그게 실행 중일 때 돈다. 재생 메시지가 **버퍼링 시점에 없던 토큰**을 비결정적으로 받는다. 세대 스탬프는 못 막는다 — 스냅샷이 바꾼 건 토큰이지 세대가 아니다. #30 배선 시 이것을 다시 볼 것.
