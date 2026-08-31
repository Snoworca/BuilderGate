# 붙여넣기가 두 번 들어가거나 조용히 사라지지 않게, 모든 입력 경로를 한 문지기 아래로 모으기

> 원문 제목: `[Orca][P8] TerminalInputCoordinator exactly-once·IME·OSC52 계약`
> 원본 이슈: `Snoworca/BuilderGate#18` — https://github.com/Snoworca/BuilderGate/issues/18

## 한 줄 요약

터미널에 입력이 들어가는 길이 여러 갈래인데, 서버는 "이 입력 이미 받았다"를 기억하지 못한다. 그래서 연결이 잠깐 끊겼다 붙는 순간 같은 명령이 **두 번 실행**되거나 **아예 안 들어갈** 수 있고, 원격 프로그램이 브라우저 클립보드를 읽고 쓰는 OSC52는 아무 정책 없이 방치돼 있다.

## 지금 무슨 문제가 있나요?

### 증상 1 — 서버에 중복 방지 장부가 없다

터미널 입력의 서버 진입점은 `server/src/ws/WsRouter.ts:2862`의 `handleInput`이다. 여기서 하는 검증은 이렇다.
- 메시지 형식이 맞는가 (`:2866`)
- 세션이 실제로 존재하는가 (`:2880`)
- retained view라면 mutation lease가 있는가 (`:2892-2904`)
- 리플레이 대기 중이면 큐에 넣는가 (`:2906~`)

여기 **없는 것**: "이 입력 오퍼레이션을 아까 이미 PTY에 썼는가?"라는 질문.

애초에 **wire 메시지에 오퍼레이션 ID가 없다.** `server/src/types/ws-protocol.ts:531-539`의 `type: 'input'`이 싣는 것은 `sessionId`, `data`, `inputSeqStart?`, `inputSeqEnd?`, `metadata?`, `retainedIdentity?`뿐이다. 순번(`inputSeqStart`/`inputSeqEnd`)은 있지만 서버가 이 범위를 기억해 재시도를 걸러내는 장부(ledger)는 없다.

그리고 **일반 입력에는 성공 응답도 없다**. `server/src/ws/WsRouter.ts:4596-4620`의 `rejectInput`이 `input:rejected` 메시지를 보내는 경로는 있지만(`server/src/types/ws-protocol.ts:768-773`), 일반 사용자 입력이 "정상적으로 PTY에 썼다"를 알려주는 acceptance ACK 메시지는 프로토콜에 없다.

> 예외: `inputKind: 'query-reply'` 하위 경로만은 `terminal-authority:query-reply-accepted` / `-rejected`로 긍정 응답을 받고(`WsRouter.ts:2990-2993`), 그 receipt에 `duplicatePtyReplyCount`(`:3007`)까지 있다. 즉 **좁은 한 경로에는 이미 ACK와 중복 계수가 존재한다.** 이 이슈가 할 일은 그 개념을 일반 입력으로 확장하는 것에 가깝고, 새 체계를 옆에 하나 더 만드는 것이 아니다 — 후자는 중복 아키텍처가 된다. (query-reply가 무엇인지는 아래 배경 지식 참조.)

사용자에게는 이렇게 보인다: 긴 명령을 붙여넣은 직후 네트워크가 잠깐 끊긴다. 클라이언트는 서버가 받았는지 모르니 재연결 후 다시 보낸다. 서버는 이미 PTY에 썼는데 또 쓴다. → **같은 명령이 두 번 실행된다.** `rm -rf` 같은 명령이면 결과가 심각하다. 반대로 클라이언트가 "혹시 중복될까 봐" 안 보내면 → **명령이 조용히 사라진다.**

### 증상 2 — 붙여넣기 페이로드에 대한 크기·타임아웃 상한이 없다

이 이슈가 요구하는 것은 **붙여넣기(paste) 페이로드**에 거는 UTF-8 total/direct/chunk 바이트 상한과 local/WAN 타임아웃인데, 그런 상한은 코드에서 확인되지 않는다. `server/src/services/TerminalResourcePolicy.ts:22, 61`에 `ackTimeoutMs`가 있지만 이건 **출력 전달(delivery)** 쪽 ACK이지 입력 쪽이 아니다.

⚠️ 다만 **입력 쪽에 상한이 하나도 없다는 뜻은 아니다.** 이미 등록된 것이 있으니 중복 계층을 새로 쌓지 않도록 먼저 확인해야 한다.
- `resourceLimits.terminal.inputQueueMaxBytes` / `inputQueueTtlMs` — `TerminalResourcePolicy.ts:110-111`에 등록되어 있고 적용 경계는 `recovery-generation`(복구 중 대기시키는 입력 큐)이다. 기본값은 각각 64 KiB(`65536`)와 1500 ms (`server/src/schemas/config.schema.ts:156-157`).
- `resourceLimits.clientWs.inputBackpressureBytes` — 같은 파일 `:98`에 등록되어 있고 적용 경계는 `browser-send`다. 기본값 1 MiB(`config.schema.ts:138`).

즉 "복구 큐가 무한정 부풀지 않게 하는 상한"과 "브라우저 송신 백프레셔"는 이미 있고, 없는 것은 **한 번의 붙여넣기 오퍼레이션 자체에 거는 total/direct/chunk 상한과 그 왕복에 거는 타임아웃**이다. 새 상한은 기존 항목들 옆(`TerminalResourcePolicy.ts`)에 나란히 두어야 하며, 위 두 개를 대체하거나 중복하지 않는다.

### 증상 3 — bracketed paste 처리가 "거부"뿐이다

`frontend/src/components/Terminal/TerminalView.tsx:2750`:

```ts
if (hasLineBreak(data) && !term.modes.bracketedPasteMode) {
  ... return { ok: false, reason: 'unsupported-multiline-paste', ... }
}
```

줄바꿈이 있는데 bracketed paste 모드가 꺼져 있으면 **거부**한다. 안전한 기본값이라 나쁘지 않지만 두 가지가 빠져 있다.
- bracketed paste 모드가 **켜져** 있을 때 붙여넣을 텍스트 안에 ESC(`\x1b`)가 섞여 있으면 그대로 나간다. 악의적 텍스트가 붙여넣기 경계를 탈출해 임의 제어 시퀀스를 주입할 수 있다 → **sanitize가 필요하다.**
- 사용자가 여러 줄을 붙여넣으려는 정상 상황에서 그냥 실패하고 끝난다.

그리고 더 중요한 것: **이 가드 자체가 키보드 Ctrl+V에서는 실행되지 않는다.** 아래 ⚠️ 블록의 4번 항목을 반드시 읽어야 한다.

### 증상 4 — OSC52 정책이 아예 없다

OSC52는 터미널 안에서 돌아가는 원격 프로그램이 사용자 클립보드를 읽거나 쓸 수 있게 하는 이스케이프 시퀀스다(아래 배경 지식 참조).

런타임 소스(`frontend/src` + `server/src` + 테스트)에서 OSC 52가 언급되는 곳은 **주석 딱 한 줄**이다 — `frontend/src/utils/contextMenuBuilder.ts:32-36`. (`docs/**`에는 이 로드맵 문서들을 포함해 여러 곳에서 언급되지만, 그것은 계획 문서이지 동작하는 코드가 아니다.)

```ts
/**
 * 애플리케이션 마우스 트래킹 모드(Claude Code 등 TUI)가 활성이면 true.
 * 이 경우 xterm 로컬 선택이 만들어지지 않아 '복사'가 무의미하고, TUI가 OSC 52 로
 * 자체 복사를 처리하므로 컨텍스트 메뉴에서 '복사' 항목을 숨긴다.
 */
```

즉 "TUI가 OSC 52로 알아서 복사한다"는 **가정만 있고**, 그 시퀀스를 우리가 허용할지 거부할지, 크기 상한은 얼마인지, query(클립보드 읽기)를 막을지에 대한 **정책 코드는 없다**. 처리 로직도 검증도 없다.

정의되지 않은 상태는 xterm 구현의 기본값에 운명을 맡긴 것이고, 보안 표면을 명시적으로 관리하지 않는다는 뜻이다.

### 증상 5 — 복사 시 debounce/size cap이 없다

`frontend/src/utils/terminalClipboardCoordinator.ts:152-182`의 `copySelection`은 선택 텍스트를 크기 제한 없이 `navigator.clipboard.writeText`로 넘긴다. copy-on-select(드래그하면 자동 복사) 정책을 도입한다면 드래그 중 매 픽셀마다 클립보드 쓰기가 발생하므로 debounce가 필요하다.

### ⚠️ 연구 문서 §3.3의 지적을 코드로 재확인한 결과

이슈와 연구 문서(`docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md` — 이 로드맵 전체의 원본 설계 문서) §3.3이 지목한 결함 목록을 실제 코드와 하나씩 대조했다. **이슈 본문을 그대로 믿고 착수하면 엉뚱한 곳을 고치게 된다.**

1. **"Ctrl+C가 clipboard promise 성공 전에 selection을 지운다"** → **고쳐짐.** `terminalClipboardCoordinator.ts:166`에서 `await options.writeClipboardText(...)`를 먼저 하고, 실패하면 `:168`에서 selection을 건드리지 않고 reject한다. 성공하고 컨텍스트가 그대로일 때만 `:178`에서 `clearSelection`한다.

2. **"tab/grid context-menu paste가 `pasteInput()`이 아니라 `sendInput()`을 직접 호출한다"** → **고쳐짐.** `frontend/src/App.tsx:485-490`과 `frontend/src/components/Grid/MosaicContainer.tsx:622-628`이 `copyTerminalSelection` / `pasteTerminalClipboard`를 호출하고(정의는 `App.tsx:238-256`), 이것이 `TerminalView.tsx:2985-2987`을 거쳐 `clipboardCoordinator`로 들어간다. `sendInput` 직행 경로는 없다.

3. **"xterm v6 double-paste 방지 capture `preventDefault`와 IME 방어가 있으며 보존해야 한다"** → **여전히 존재.** `TerminalView.tsx:3728-3745`(키 핸들러의 Ctrl+C/Ctrl+V 처리)와 `:4002-4006`(paste capture 리스너 — 바로 위 `:3996-4001`은 그 이유를 적은 주석이다), 그리고 `imeTransaction.ts` 전체. **지우지 말고 새 coordinator 아래로 옮겨야 한다.**

4. **"registered preset paste만 bracketed-paste 검증 경로를 쓴다"** → **부분 수정.** 프로그램적 경로는 고쳐졌지만 **키보드는 여전히 그 경로를 타지 않는다.** 이 문서에서 가장 중요한 사실이므로 기전을 그대로 적는다.

   - 고쳐진 쪽: 탭 컨텍스트 메뉴, 그리드 컨텍스트 메뉴, 커맨드 프리셋은 전부 `clipboardCoordinator`의 `pasteClipboard`(`terminalClipboardCoordinator.ts:184`) 또는 `pasteText`(`:210-223`)로 들어가고, 둘 다 `pasteCapturedText`(`:128-149`)를 거쳐 `admitPaste`(`:139` 호출, 구현은 `TerminalView.tsx:2860-2869`)를 부른다. `admitPaste`는 `submitProgrammaticPaste`(`:2735-2770`)를 호출하므로 `:2750`의 `hasLineBreak(data) && !term.modes.bracketedPasteMode` 가드를 통과한다.
   - **고쳐지지 않은 쪽: 키보드 Ctrl+V.** `TerminalView.tsx:3736-3743`의 키 핸들러는 Ctrl+V를 만나면 디버그 이벤트만 남기고 `false`를 돌려준다 — 즉 여기서는 아무 데이터도 보내지 않고 **브라우저의 네이티브 paste 이벤트에 위임**한다(그래야 이중 붙여넣기가 나지 않는다). 우리 쪽 `onPasteCapture`(`:4002-4006`)는 provenance 표시(`markUserXtermDataProvenance()`)와 `e.preventDefault()`만 하고 `clipboardData`는 읽지 않는다. 실제로 클립보드를 읽어 터미널에 넣는 것은 **xterm 내부 paste 핸들러**다.
   - 증거 하나 더: `TerminalClipboardSource`(`terminalClipboardCoordinator.ts:1-5`)의 `'keyboard'` 값은 저장소 전체에서 **복사에만** 쓰인다(`TerminalView.tsx:3729`의 `copySelection('keyboard')`). 키보드 **붙여넣기**를 coordinator로 넣는 호출자는 존재하지 않는다.
   - **결론**: `admitPaste` / `submitProgrammaticPaste`는 "모든 소스가 지나는 문"이 **아니다**. 여기에만 sanitize를 넣으면 **키보드 붙여넣기는 무방비로 남는다** — 그리고 키보드 Ctrl+V가 일반 사용자의 압도적 다수 경로다.

5. **"우클릭 직전 selection을 별도 ref에 저장하는 DOM renderer workaround가 있다"** → **여전히 존재.** `TerminalView.tsx:4089-4103`의 `savedRightClickSelRef`(`:4089`가 이유를 적은 주석, `:4092-4103`이 핸들러). (이 workaround가 WebGL 렌더러에서도 필요한지는 #15가 따로 검증한다.)

6. **"검증된 `pasteInput` safe adapter로 전환한다"(완료 조건 12번의 마지막 단계)** → **그 이름의 API는 더 이상 없다.** `frontend/src` + `server/src` 전체에서 `pasteInput` 발생 건수가 **0건**이고, 계약 테스트 `frontend/tests/unit/terminalClipboardAdapterContract.test.ts:106-111`("Terminal imperative handles expose no legacy programmatic paste bypass")가 `pasteInput:` 키의 **부재를 능동적으로 단언**한다(`:107`이 `TerminalView`, `:108`이 `TerminalContainer` 대상. `:109-110`은 `pasteText` 위임을 확인하는 별개의 단언이다). 즉 되살리는 것이 금지되어 있다. 자세한 대응은 완료 조건 12번 해설 참조.

**정리**: 이 이슈의 프론트엔드 "단일 진입점" 작업 중 **클립보드 계열(복사/프로그램적 붙여넣기)은 상당 부분 이미 되어 있다.** 남은 큰 덩어리는 (a) **키보드 입력·키보드 붙여넣기를 포함한 상위 문지기**, (b) **서버 쪽 exactly-once 장부**, (c) **OSC52·sanitize·상한 정책**이다.

## 왜 고쳐야 하나요?

**wave-4에서 유일하게 "잘못된 명령이 실제로 실행될 수 있는" 이슈다.** 나머지 셋(#15/#16/#17)은 성능이거나 화면 정확성이지만, 이건 중복 실행이다.

- 터미널 입력은 **부작용을 일으키는 쓰기**다. 화면이 잠깐 이상한 건 새로고침으로 복구되지만, `git push --force`가 두 번 나가면 되돌릴 수 없다.
- BuilderGate는 "원격에서 N개 에이전트 운용"이 목표다. 원격 = WAN = 연결이 끊겼다 붙는 것이 예외가 아니라 **일상**이다. 재연결 경계에서의 정확성이 이 제품의 핵심 신뢰성 축이다.
- OSC52는 보안 문제다. 신뢰할 수 없는 서버에 SSH로 붙었을 때 그쪽에서 사용자 클립보드를 **읽어갈** 수 있으면 그건 데이터 유출이다.
- IME는 **지금 깨져 있지 않다.** `imeTransaction.ts`가 이미 조합 중 상태 기계와 지연 처리로 방어하고 있고, 위 증상 1~5 어디에도 IME 증상은 없다. 여기서의 위험은 반대 방향이다 — **입력 경로를 새 coordinator 아래로 옮기는 과정에서 그 방어를 잃는 것.** 한국어 사용자는 매 문장마다 IME를 쓰므로, 이관 중 회귀가 나면 즉시 매일 겪는 고장이 된다. 완료 조건 10번의 IME 회귀 매트릭스는 새 기능을 요구하는 것이 아니라 **기존 방어가 이관 후에도 살아 있음을 증명하라**는 요구다.

## 배경 지식

### exactly-once (정확히 한 번)
분산 시스템에서 "이 작업이 정확히 한 번만 실행된다"를 보장하는 것. 대비되는 개념이 둘 있다.
- **at-most-once**: 중복은 없지만 유실될 수 있다 (한 번 보내고 재시도 안 함).
- **at-least-once**: 유실은 없지만 중복될 수 있다 (성공 확인까지 계속 재시도).

네트워크에서 exactly-once를 순수하게 달성하는 것은 불가능하다는 것이 알려져 있다. 실무 해법은 **at-least-once 재시도 + 수신 측 중복 제거**다. 즉 클라이언트는 "확인될 때까지 다시 보낸다"를 하고, 서버는 "이 오퍼레이션 ID는 이미 처리했다"를 기억해 두 번째 요청을 걸러낸다. 이 이슈가 요구하는 dedup ledger가 정확히 그 "기억"이다.

### idempotent (멱등)
같은 요청을 여러 번 보내도 결과가 한 번 보낸 것과 같은 성질. 서버가 "이미 처리한 오퍼레이션이면 PTY에 다시 쓰지 않고 **저장해둔 예전 결과를 그대로 돌려준다**"를 하면, 클라이언트 입장에서는 몇 번을 재시도하든 결과가 같아 안전하게 재시도할 수 있다. 이것이 완료 조건 4번의 "다시 쓰지 않고 기존 결과를 반환한다"이다.

### ACK (acknowledgment, 수신 확인)
"받았다/처리했다"고 알려주는 응답. 여기서는 "PTY에 실제로 썼다"는 **acceptance ACK**를 말한다. ACK가 없으면 클라이언트는 성공인지 실패인지 알 수 없다.

### query-reply (질의 응답 입력)
**사람이 친 것이 아니라, 터미널이 프로그램의 질문에 자동으로 대신 답해서 되돌려 보내는 입력**이다. 터미널 프로그램은 화면에 대한 정보를 알아내려고 이스케이프 시퀀스로 터미널에게 질문을 던진다. 예를 들어 프로그램이 `ESC[6n`(DSR — 커서 위치 요청)을 출력하면, 터미널은 사람의 키 입력과 똑같은 통로로 `ESC[12;40R`("커서는 12행 40열에 있다")을 **입력으로 되돌려 보낸다.** 커서 위치(CPR) 외에 장치 속성(DA, `ESC[?...c`), 색상 질의(OSC), DECRQSS 등이 같은 방식으로 오간다. BuilderGate는 이 응답들을 정규식으로 분류하고 `provenance: 'parser-generated'`(파서가 만든 것)일 때만 query-reply로 인정한다 — `frontend/src/utils/terminalQueryReply.ts`의 `isTerminalQueryReply`.

왜 이 이슈에 중요한가: **query-reply는 이미 이 이슈가 일반 입력에 만들려는 것을 축소판으로 갖고 있다.** 서버는 이 경로에만 긍정 응답(`terminal-authority:query-reply-accepted`, `WsRouter.ts:2990-2993`)을 보내고, 그 receipt에 `ptyWriteAttempted` / `ptyWriteCount` / `effectCommitted` / `duplicatePtyReplyCount`(`:3007`) 같은 중복 계수까지 실어 보낸다. 즉 "ACK가 있고, 중복을 세고 있는" 좁은 체계가 하나 이미 존재한다. 이 이슈의 설계 판단 중 가장 무거운 것은 **그 좁은 체계를 사람 입력까지 포함하도록 넓힐 것인가, 아니면 옆에 새 체계를 세울 것인가**이고, 프로젝트 규칙(§10.2 중복 아키텍처 금지)은 전자를 요구한다.

### ACK 유실 (ACK loss)
서버는 정상 처리했는데 **응답 메시지만** 도중에 사라진 상황. 클라이언트에서는 "타임아웃"과 구분되지 않는다. 재시도하면 중복, 안 하면 유실 — 이 딜레마가 exactly-once가 필요한 근본 이유다.

### unacked (미확인)
"보냈는데 ACK를 못 받은" 상태. **성공도 실패도 아닌 제3의 상태**다. 이걸 성공으로 취급하면 유실이, 실패로 취급하면 중복이 생긴다. 완료 조건 7번이 `accepted` / `rejected` / `unacked` / `expired` / `unknown`을 **구분해서** 추적하라고 요구하는 이유다.

### epoch (에포크)
연결이 새로 맺어질 때마다 발급되는 식별자. `connectionEpoch`는 이미 프로토콜에 있다(`frontend/src/types/ws-protocol.ts:508, 515`). 재연결 전 낡은 메시지가 새 연결 상태를 오염시키는 것을 막는 데 쓴다.

- **connection epoch (물리 연결 에포크)**: WebSocket 하나의 수명. 끊기면 끝.
- **client input epoch / logical client (논리 클라이언트 에포크)**: 물리 연결이 끊겼다 붙어도 **유지되는** 상위 식별자. 완료 조건 11번의 핵심이 이것이다 — 소켓이 죽었다고 dedup 기록까지 버리면, 재연결 후 재시도를 걸러낼 근거가 사라진다. 그래서 **연결에 매인 것(대기 중인 waiter, 타임아웃)은 소켓과 함께 정리하되, dedup 결과는 논리 클라이언트 장부에 TTL을 두고 남긴다.**

### operation identity (오퍼레이션 신원)
"이 입력 요청이 무엇인지"를 유일하게 식별하는 키. 이 이슈가 지정한 조합(완료 조건 2번):
`(clientInputEpoch 또는 connectionEpoch, sessionId, targetGeneration, inputOperationId/inputSeqRange)`

각 조각의 이유:
- **epoch**: 어느 연결/논리 세대의 요청인지
- **sessionId**: 어느 터미널인지
- **targetGeneration**: 그 터미널이 그 사이에 갈아끼워지지 않았는지
- **inputOperationId / inputSeqRange**: 그 안에서 몇 번째 오퍼레이션인지

이 넷이 다 같아야 "같은 요청"이다.

### target generation (타깃 세대)
입력을 보낼 대상 터미널의 세대 번호. 터미널이 재생성되면 올라간다. **stale target generation**은 "내가 입력을 보내려던 그 터미널은 이미 사라졌다"는 뜻이고, 이건 정상 거부 사유다 — 새 터미널에 옛 명령을 밀어넣으면 안 된다.

### dedup ledger / result-replay ledger (중복 제거 및 결과 재생 장부)
서버가 들고 있는 "오퍼레이션 신원 → 처리 결과" 표. 같은 신원이 다시 오면 PTY에 쓰지 않고 표에 저장된 결과를 그대로 돌려준다. 무한히 커지면 안 되므로 **TTL(보관 시간), 최대 항목 수, 최대 바이트 수** 세 가지 상한을 둔다 (완료 조건 3번).

### canonical payload / encoded length + digest (정규 페이로드 / 인코딩 길이 + 다이제스트)
장부에 오퍼레이션 ID만 저장하면 위험하다. 누군가(또는 버그가) **같은 ID로 다른 내용**을 보내면, 서버가 "아 그거 처리했지" 하고 엉뚱한 예전 결과를 돌려준다.

그래서 항목마다 페이로드의 **UTF-8 인코딩 바이트 길이**와 **해시(digest)**를 같이 저장한다. 재시도가 오면 ID뿐 아니라 길이·해시까지 대조한다. 같으면 결과 replay, 다르면 **둘 다 금지하고 프로토콜 에러로 거부**한다 (완료 조건 5번). "정규(canonical)"는 "비교 전에 항상 같은 방식으로 인코딩한다"는 뜻으로, 인코딩 차이 때문에 같은 내용이 다른 해시로 나오는 일을 막는다.

### eviction (축출)
장부가 상한(TTL 또는 개수/바이트)에 도달해 오래된 항목을 지우는 것. 축출된 오퍼레이션에 대한 재시도가 오면 서버는 **처리했는지 안 했는지 알 수 없다**. 이때 "모르니까 그냥 실행하자"가 가장 위험하다. 그래서 `expired`(TTL 지나 지워짐) 또는 `unknown`(아예 기록 없음)으로 **명시적으로 거부**하고 사용자에게 알린다 (완료 조건 6번). 조용히 재실행하는 것보다 "확인할 수 없으니 직접 확인하세요"가 낫다.

### observable protocol error (관측 가능한 프로토콜 에러)
조용히 무시하거나 로그만 남기는 게 아니라, **클라이언트에게 명시적 에러 메시지로 응답**하고 그 사건이 메트릭/디버그 이벤트로 남는 것. 코드에는 이미 `input:rejected` 메시지 타입이 있다(`server/src/ws/WsRouter.ts:4613-4619`).

### IME (Input Method Editor, 입력기)
한글·중국어·일본어처럼 키 여러 개를 조합해 한 글자를 만드는 입력 방식. `ㅎ` → `하` → `한`처럼 **조합 중(composing)** 상태를 거쳐 **확정(commit)**된다. 브라우저는 `compositionstart` / `compositionupdate` / `compositionend` 이벤트를 발생시킨다.

터미널에서 어려운 이유: 조합 중인 글자를 그때그때 PTY로 보내면 셸이 미완성 글자를 받아 화면이 깨지고, 확정 시점 처리를 잘못하면 **같은 글자가 두 번** 들어가거나 **마지막 글자가 유실**된다. OS·브라우저·입력기 조합마다 이벤트 순서가 달라서 회귀 매트릭스가 필요하다.

BuilderGate에는 이미 방어 장치가 있다 — `frontend/src/utils/imeTransaction.ts`(453줄)가 `idle` / `composing` / `committing` / `settling` 상태 기계를 돌리고, 조합 중에 스냅샷/복구 같은 작업을 **미뤄두는**(`ImeDeferredKind = 'repair' | 'snapshot' | 'capture-close'`) 구조다. 연구 문서 §3.3이 강조하듯 **이 방어를 지우면 안 되고, 새 coordinator 아래로 옮겨야 한다.**

### composition duplicate / missing (조합 중복 / 유실)
IME 조합 결과가 두 번 들어가거나 아예 안 들어가는 것. 완료 조건 10번이 요구하는 매트릭스:
- **Windows 한글 IME**: 두벌식 조합, 한/영 전환
- **Linux candidate key**: 후보 목록에서 숫자키로 고르는 방식
- **macOS composition**: 마크된 텍스트(marked text) 처리 방식이 다름
- **kitty chord**: kitty 키보드 프로토콜의 확장 키 조합 (`Ctrl+Alt+Shift+...` 등을 모호함 없이 표현하는 프로토콜)

### bracketed paste (괄호 붙여넣기)
셸이 "지금부터 오는 건 사람이 친 게 아니라 붙여넣기다"를 알 수 있게, 붙여넣을 내용을 `ESC[200~` … `ESC[201~`로 감싸 보내는 규약. 이게 있으면 여러 줄을 붙여넣어도 셸이 각 줄을 즉시 실행하지 않고 **한 덩어리로** 받아 편집할 수 있다.

프로그램이 이 모드를 켜면 터미널이 `bracketedPasteMode` 상태가 된다. BuilderGate는 이 상태를 이미 추적한다(`frontend/src/types/ws-protocol.ts:45`, `frontend/src/utils/terminalRetainedState.ts:45`, `server/src/types/ws-protocol.ts:43`).

### embedded ESC sanitize (내장 ESC 정화)
붙여넣을 텍스트 **안에** `ESC[201~`(종료 마커)가 들어 있으면, 셸은 거기서 붙여넣기가 끝났다고 믿고 **그 뒤 내용을 사용자가 직접 친 명령으로 실행**한다. 웹페이지에서 복사한 텍스트에 이런 게 숨어 있으면 원치 않는 명령이 실행된다 — 실제로 알려진 공격 기법이다. sanitize는 붙여넣기 페이로드 안의 ESC 바이트를 제거하거나 무해하게 바꾸는 것이다.

### capability (능력 협상)
"이 터미널이 bracketed paste를 지원하는가/켜져 있는가"를 확인하고 그에 맞게 동작을 바꾸는 것. 지원하면 마커로 감싸고, 아니면 여러 줄 붙여넣기를 거부하거나 다르게 처리한다.

### OSC52
OSC = Operating System Command, 터미널 이스케이프 시퀀스의 한 종류. **52번**은 클립보드를 다룬다.
- **write**: 원격 프로그램이 `ESC]52;c;<base64>BEL`을 출력하면 사용자 클립보드에 그 내용이 들어간다. SSH 접속한 원격 서버에서 `tmux`로 복사한 게 로컬 클립보드에 오는 것이 이 덕분이다.
- **query**: 원격 프로그램이 `ESC]52;c;?BEL`을 출력하면 터미널이 **현재 클립보드 내용을 돌려준다**.

query가 위험한 이유는 명백하다: 신뢰할 수 없는 서버에 붙어 있으면 그쪽이 사용자 클립보드(비밀번호, 토큰이 들어 있을 수 있다)를 읽어간다. 그래서 이 이슈의 정책은 다음과 같다.
- **write는 default deny(기본 거부), opt-in(사용자가 명시적으로 켤 때만 허용)**, 허용해도 크기 상한을 두고 base64·UTF-8 유효성을 검사한다.
- **query는 무조건 deny.** 켤 수 있는 옵션조차 두지 않는다.

### copy-on-select debounce / size cap
드래그로 선택하는 즉시 클립보드에 복사하는 정책을 쓸 경우, 드래그 중 마우스가 움직일 때마다 클립보드 쓰기가 발생한다. **debounce**는 "움직임이 멈추고 N밀리초 지난 뒤 한 번만" 실행하는 기법이다. **size cap**은 실수로 100MB짜리 로그를 전부 선택했을 때 브라우저가 멈추지 않도록 하는 상한이다.

### UTF-8 total / direct / chunk cap
붙여넣기 페이로드에 걸 세 종류의 바이트 상한.
- **total**: 이 오퍼레이션 전체 크기 상한 (넘으면 아예 거부)
- **direct**: 나누지 않고 한 번에 보낼 수 있는 크기 (이하는 그냥 보냄)
- **chunk**: direct를 넘을 때 몇 바이트씩 잘라 보낼지

UTF-8 기준인 이유: 한글 한 글자는 3바이트, 이모지는 4바이트 이상이다. 문자 개수로 상한을 걸면 실제 전송량이 3~4배가 된다. 그리고 자를 때 **멀티바이트 문자 중간에서 자르면 안 된다** — 이 저장소에는 이미 같은 문제를 다루는 코드가 있다(`frontend/src/utils/terminalOutputScheduler.ts`의 UTF-8 prefix 처리, 연구 문서 §3.2-1).

### local / WAN timeout
같은 타임아웃을 로컬(localhost, 왕복 1ms 미만)과 원격(WAN, 왕복 수백 ms)에 똑같이 쓰면, 로컬에서는 너무 느슨하고 WAN에서는 너무 빡빡하다. 환경에 따라 다른 값을 쓰라는 뜻이다. (구체적 값은 소스에 명시되지 않음.)

### rollback (롤백)
문제가 생겼을 때 되돌리는 절차. 이 이슈가 지정한 **순서**(완료 조건 12번)가 중요하다:
1. 새 붙여넣기 접수를 **먼저 중단**한다 (더 이상 애매한 상태를 만들지 않는다)
2. 이미 진행 중인 오퍼레이션을 `accepted` / `rejected` / `unacked` / `unknown` 중 하나로 **명시적으로 수렴**시킨다 (허공에 뜬 요청을 남기지 않는다)
3. 그 다음에야 검증된 safe adapter로 전환한다 (원문의 `pasteInput`이라는 이름은 현재 코드에 없다 — 완료 조건 12번 해설 참조)

그리고 **"context-menu direct `sendInput` 우회는 복원하지 않는다"** — 이미 없애서 안전해진 경로를 롤백한다고 되살리면 안 된다는 뜻이다.

## 무엇을 만들어야 하나요?

### 프론트엔드

1. **`TerminalInputCoordinator`를 만든다.**
   먼저 오해를 없애자 — 위 ⚠️ 블록의 "이미 되어 있다"는 **클립보드 계열(복사/프로그램적 붙여넣기)의 진입점이 `clipboardCoordinator` 하나로 모였다**는 뜻이지, 키보드 일반 입력과 키보드 붙여넣기까지 포함한 상위 문지기가 있다는 뜻이 **아니다.** 그 문지기는 아직 없고, 이 항목이 만들라는 것이 그것이다.

   지금 clipboard 관련 조율은 `frontend/src/utils/terminalClipboardCoordinator.ts`(241줄)가 하고, 입력 순서·라우팅은 `frontend/src/utils/terminalInputSequencer.ts`(460줄)가, IME는 `frontend/src/utils/imeTransaction.ts`(453줄)가 나눠 갖고 있다. 새 coordinator는 **이것들을 대체하는 게 아니라 그 위의 단일 진입점**이 되어야 한다 — 기존 IME 방어와 bracketed paste 검증을 지우고 새로 짜면 안 된다(연구 문서 §3.3이 명시적으로 경고).

   덮어야 할 진입 소스: 키보드(일반 타이핑), 키보드 붙여넣기(Ctrl+V — 현재 우회 중), 탭 컨텍스트 메뉴, 그리드 컨텍스트 메뉴(우클릭), 커맨드 프리셋, 프로그램적 붙여넣기.

2. **오퍼레이션 ID를 붙인다.** 클라이언트가 각 입력 오퍼레이션에 고유 ID를 부여하고, 재시도 시 **같은 ID와 같은 페이로드**를 유지한다. 다르면 새 오퍼레이션이다.

3. **UTF-8 상한과 타임아웃을 적용한다.** 자를 때 멀티바이트 경계를 지킨다. 증상 2의 ⚠️대로 기존 `inputQueueMaxBytes` / `inputBackpressureBytes`와 **역할이 겹치지 않는지** 먼저 확인하고, 새 상한은 `server/src/services/TerminalResourcePolicy.ts`의 기존 항목들 옆에 등록한다.

4. **ESC sanitize를 넣는다 — 단, 두 경로를 모두 덮는 지점이어야 한다.**
   `TerminalView.tsx:2750` 근처의 `submitProgrammaticPaste`만 고치면 **키보드 Ctrl+V는 그대로 뚫린다**(위 ⚠️ 블록 4번). sanitize는 다음 **둘 다**에서 적용되어야 한다.
   - **coordinator 경로**: `submitProgrammaticPaste`(`:2735-2770`) — 컨텍스트 메뉴·프리셋·프로그램적 붙여넣기.
   - **xterm 네이티브 붙여넣기 경로**: 브라우저 paste 이벤트(`onPasteCapture`, `:4002-4006`)와 그 결과가 흘러나오는 `term.onData` 지점. 여기에는 **두 가지 방식**이 있고, 첫 번째를 고를 때 반드시 지켜야 하는 조건이 있다.

     **방식 A — capture 핸들러에서 직접 읽어 coordinator로 넘긴다.** 지금 `onPasteCapture`는 `markUserXtermDataProvenance()`와 `e.preventDefault()`만 하고 `clipboardData`를 읽지 않는다. 여기서 읽어 sanitize한 뒤 1번의 coordinator로 넘기는 것이 구조적으로는 가장 깔끔하다. **단 `preventDefault()`만으로는 안 되고 `stopPropagation()`이 반드시 함께 필요하다.**

     ⚠️ **`preventDefault()`는 `stopPropagation()`이 아니다.** `preventDefault()`는 브라우저의 기본 동작(textarea에 텍스트 삽입)만 막고, **다른 리스너의 실행은 전혀 막지 않는다.** 코드로 확인한 사실:
     - xterm은 자기 textarea와 자기 root element에 각각 paste 리스너를 건다 — `frontend/node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:343-344`의 `addDisposableListener(this.textarea!, 'paste', pasteHandlerWrapper)` / `addDisposableListener(this.element!, 'paste', pasteHandlerWrapper)`.
     - 그 핸들러 `handlePasteEvent`(`Clipboard.ts`)는 `clipboardData`를 읽어 `paste()`를 부르고, `paste()`는 `coreService.triggerDataEvent(text, true)`로 데이터를 흘려보낸다.
     - `term.open(terminalRef.current)`(`TerminalView.tsx:3130`)이므로 xterm의 `element`는 우리 `termEl`의 **자식**이다. 즉 우리 capture 리스너가 먼저 뛰고, 그 뒤 xterm 리스너가 그대로 뛴다.

     따라서 capture 핸들러에서 `clipboardData`를 읽어 coordinator로 넘기기만 하면 **우리 경로 1회 + xterm 경로 1회 = 같은 붙여넣기가 두 번 들어간다.** capture 단계에서 `e.stopPropagation()`을 호출해 xterm 리스너까지 도달하지 못하게 막아야 한다.

     **⚠️ 이중 붙여넣기 기전이 서로 다른 두 개다. 헷갈리면 엉뚱한 것을 테스트하게 된다.**

     | 경로 | 기전 | 언제 생기나 | 막는 수단 |
     | --- | --- | --- | --- |
     | (1) 브라우저 삽입 경유 | 브라우저가 textarea에 텍스트를 삽입 → `input` 이벤트 → xterm `_inputEvent`가 **두 번째** `triggerDataEvent` 호출 | 지금도 상시. `:3996-4001` 주석이 설명하는 것이 **이것**이다 | `preventDefault()` (이미 있음, `:4004`) |
     | (2) 리스너 중복 실행 | 우리가 읽어 보낸 것 + xterm `handlePasteEvent`가 읽어 보낸 것 | **방식 A로 바꾸는 순간 새로 생긴다** | `stopPropagation()` (추가 필요) |

     `:3996-4001` 주석은 (1)만 설명한다. **주석이 설명하는 버그를 회귀 테스트로 덮는 것으로는 (2)를 잡지 못한다.** 둘은 별개의 회귀 테스트를 요구한다 — (1)은 "`preventDefault`를 제거하면 빨개지는 테스트", (2)는 "`stopPropagation`을 제거하면 빨개지는 테스트"다.

     **방식 B — `term.onData` 지점에서 sanitize한다.** capture 핸들러는 지금 그대로 두고(provenance 표시 + `preventDefault`), xterm이 `triggerDataEvent`로 흘려보낸 데이터를 `term.onData` 경계에서 붙잡아 sanitize한다. 리스너를 하나도 끊지 않으므로 (2)가 애초에 생기지 않는 대신, **그 데이터가 붙여넣기에서 온 것인지 타이핑에서 온 것인지 구분할 paste-provenance 플래그**가 필요하다(이미 있는 `markUserXtermDataProvenance()`를 그 용도로 확장하는 것이 자연스럽다). 사람이 한 글자씩 친 `\x1b`까지 무차별로 정화하면 안 되기 때문이다.

     ⚠️ **현재 상태를 "보호가 전혀 없음"으로 읽으면 안 된다.** xterm의 `paste()`는 `bracketTextForPaste`를 적용하므로, `bracketedPasteMode`가 켜져 있는 한 키보드 붙여넣기도 `ESC[200~`…`ESC[201~`로 감싸여 나간다. 실제로 뚫려 있는 것은 셋이다 — (a) 페이로드 **안에** 들어 있는 `ESC[201~`가 그 wrapping을 탈출하는 것(sanitize 부재), (b) `bracketedPasteMode`가 **꺼져 있을 때의 multiline** — 프로그램적 경로에는 `:2750`의 거부 가드가 있지만 키보드 경로에는 그 가드가 없어 여러 줄이 그대로 실행된다, (c) 거부/정화 건수를 세는 **회계가 없어** 무슨 일이 일어났는지 관측되지 않는 것.

   - 어느 방식을 고르든, 판정 기준은 **"키보드 Ctrl+V로 `ESC[201~`이 섞인 텍스트를 붙여넣었을 때 sanitize된다"를 자동 테스트로 보일 수 있는가**이다. 그것이 red 테스트의 첫 문장이 되어야 한다. 그리고 방식 A를 골랐다면 **"같은 붙여넣기가 정확히 1회만 들어간다"를 위 표의 (1)·(2) 각각에 대해 따로 assert하는 회귀 테스트 두 개**가 추가로 필요하다.

5. **copy-on-select debounce와 size cap을 넣는다.** `terminalClipboardCoordinator.ts:152-182`의 `copySelection` 경로.

### 서버

6. **일반 입력에 acceptance ACK 메시지를 추가하고, 메시지에 오퍼레이션 ID 필드를 넣는다.**
   지금 일반 입력에는 `input:rejected`만 있다(`WsRouter.ts:4613-4619`, 타입 `server/src/types/ws-protocol.ts:768-773`). 성공 응답이 없으면 클라이언트가 재시도 판단을 할 수 없다.
   **먼저 `terminal-authority:query-reply-accepted`(`WsRouter.ts:2990-2993`)의 형태를 읽어보고 그것을 일반화할 수 있는지 검토한다.** 비슷한 것이 이미 있으면 새로 만들지 말고 확장하는 것이 이 프로젝트의 규칙이다.
   그리고 `type: 'input'` 메시지(`server/src/types/ws-protocol.ts:531-539`)에 `inputOperationId`를 추가한다 — 지금은 오퍼레이션 ID 자체가 없어서 dedup을 할 키가 존재하지 않는다.

7. **dedup / result-replay ledger를 만든다.**
   `server/src/ws/WsRouter.ts:2862`의 `handleInput`에서 PTY write **직전**에 장부를 조회한다.
   - 같은 신원 + 같은 길이·해시 → PTY에 쓰지 않고 저장된 결과 반환
   - 같은 신원 + **다른** 길이·해시 → 결과 replay도 새 write도 금지, `input:rejected`로 프로토콜 에러
   - 신원 없음 + 축출 흔적 있음 → `expired`
   - 신원 없음 + 아무 정보 없음 → `unknown`
   TTL·최대 항목 수·최대 바이트 상한을 둔다. 상한 설정은 `server/src/services/TerminalResourcePolicy.ts`에 이미 유사한 정책 항목들이 모여 있으므로 그 옆이 자연스럽다.

8. **논리 클라이언트 장부를 물리 연결과 분리한다.** 소켓이 끊기면 pending waiter와 타임아웃은 정리하되, dedup 결과는 논리 클라이언트 키로 TTL 동안 남긴다. 재연결 시 그 결과를 새 에포크에 다시 묶어 replay할 수 있어야 한다. 늦게 도착한 옛 ACK는 현재 에포크에서 **아무 일도 하지 않는다**(no-op).

9. **OSC52 정책을 구현한다.** write는 default deny + opt-in + 크기 상한 + base64/UTF-8 검증, query는 무조건 deny.

### 테스트

10. **회귀 매트릭스를 만든다.** ACK-loss-after-write, 중복 재시도, 같은 ID 다른 페이로드, 재연결 경계, 장부 축출 × (Windows 한글 IME, Linux candidate key, macOS composition, kitty chord). 이 전부에서 중복 0 / 유실 0.

11. **TDD 순서**: 실패하는 테스트("ACK가 유실된 뒤 재시도하면 PTY write가 1회여야 한다")를 먼저 red로 만든다.

### 테스트를 어디서 어떻게 돌리나

- **서버 단위/통합**: `server` 디렉터리에서 `npx tsx src/test-runner.ts`. 단 이 러너는 `*.test.ts`(`node:test`) 스위트를 **돌리지 않는다** — 그쪽에 붙였다면 파일별로 따로 실행해야 한다. dedup 장부·ACK 관련 red 테스트 대부분이 여기다.
- **프론트 단위**: `frontend` 디렉터리에서 `frontend/tests/unit/` 아래에 두고 `node --experimental-strip-types --test tests/unit/<파일>.test.ts`로 실행한다 (`frontend/package.json`의 `test:unit:*` 스크립트가 이 형태다 — 명령 안의 경로가 상대경로이므로 반드시 `frontend`에서 실행해야 한다). 기존 `terminalClipboardCoordinator.test.ts`, `terminalClipboardAdapterContract.test.ts`, `imeTransaction.test.ts`가 같은 자리에 있으므로 coordinator 계약 테스트는 여기 붙인다.
- **프론트 E2E**: `frontend` 디렉터리에서 `frontend/tests/e2e/` 아래에 두고 `playwright test tests/e2e/<파일>.spec.ts --project "Desktop Chrome"`으로 실행한다 (`frontend/package.json`의 `test:e2e:*` 스크립트가 `npx` 없이 이 형태를 쓴다. `Desktop Chrome`은 `frontend/playwright.config.ts:21`에 실제로 선언된 project 이름이다). **키보드 Ctrl+V 붙여넣기와 IME 회귀 매트릭스는 실제 브라우저 이벤트가 필요하므로 반드시 여기여야 한다.** 서버가 `node dev.js --port 2222`로 떠 있어야 한다.

## 완료 조건 (원문 유지)

- [ ] keyboard/context menu/right click/preset/programmatic paste가 단일 `TerminalInputCoordinator`를 사용한다.

**해설**: 진입점 하나. 다만 이 다섯 이름과 코드의 소스 열거가 1:1이 아니므로 주의한다. `TerminalClipboardSource`(`terminalClipboardCoordinator.ts:1-5`)의 값은 **4개**(`keyboard`, `tab-context-menu`, `grid-context-menu`, `command-preset`)다 — 조건문의 "context menu"와 "right click"이 코드에서는 탭/그리드 두 컨텍스트 메뉴로 갈려 있고, "programmatic paste"는 별도 소스가 아니라 제출 함수(`submitProgrammaticPaste`)의 이름이다. 그리고 그 4개 중 `keyboard`는 **복사에만** 쓰인다(`TerminalView.tsx:3729`). 즉 클립보드 계열은 이미 `clipboardCoordinator`로 모여 있지만(위 ⚠️ 블록 참조), **키보드 일반 입력과 키보드 붙여넣기는 아직 밖에 있다.** 이 조건이 요구하는 상위 coordinator는 그 둘까지 안으로 넣어야 만족된다.

- [ ] operation identity는 `(clientInputEpoch 또는 connectionEpoch, sessionId, targetGeneration, inputOperationId/inputSeqRange)`로 고정된다.

**해설**: 위 배경 지식 "operation identity" 참조. 이 넷의 조합이 키다.

- [ ] server는 TTL·entry·byte cap이 있는 dedup/result-replay ledger를 소유하고 각 entry를 canonical payload encoded length+digest/request hash와 결합한다.

**해설**: 장부에 세 가지 상한(시간/개수/바이트)을 두고, 항목마다 페이로드 길이+해시를 붙여 신원 위조·혼선을 막는다.

- [ ] PTY write 뒤 acceptance ACK 유실로 같은 operation·동일 payload를 retry해도 다시 쓰지 않고 기존 결과를 반환한다.

**해설**: 멱등성 요구. "다시 쓰지 않고 기존 결과를 반환한다"가 핵심 문장이다.

- [ ] 같은 operation identity에 다른 payload/hash가 오면 기존 result replay와 신규 PTY write를 모두 금지하고 observable protocol error로 거절한다.

**해설**: 같은 ID로 다른 내용이 오는 것은 **버그이거나 공격**이다. 옛 결과를 돌려주는 것도(거짓 성공) 새로 쓰는 것도(중복 실행) 다 틀렸다. 명시적 에러가 유일한 정답이다.

- [ ] reconnect operation-ID 재사용 범위와 ledger eviction을 명시하며 eviction된 불확실 retry는 silent re-execute하지 않고 `expired`/`unknown`으로 거절한다.

**해설**: "silent re-execute하지 않는다"가 핵심. 모르면 실행하지 말고 모른다고 답하라.

- [ ] accepted/rejected/unacked/expired/unknown과 stale target generation이 구분되고 trace 가능하다.

**해설**: 다섯 상태를 뭉뚱그리지 말라는 요구. 특히 `unacked`(모름)를 `rejected`(실패)와 섞으면 안 된다.

- [ ] UTF-8 total/direct/chunk cap, local/WAN timeout, bracketed-paste capability와 embedded ESC sanitize가 적용된다.

**해설**: 붙여넣기 방어를 **네 겹**으로 세우라는 요구이고, 네 겹은 각각 다른 사고를 막는다.
1. **크기 상한(UTF-8 total/direct/chunk)** — 실수로 100MB 로그를 붙여넣어 브라우저·서버·PTY가 멈추는 것을 막는다. 문자 수가 아니라 **인코딩된 바이트** 기준이며, 자를 때 멀티바이트 문자 중간에서 끊으면 안 된다(배경 지식 참조).
2. **타임아웃(local/WAN)** — 응답 없는 붙여넣기를 영원히 매달아두지 않는다. localhost와 WAN에 같은 값을 쓰면 한쪽이 반드시 틀리므로 환경별로 다른 값을 쓴다.
3. **bracketed-paste capability** — 지금 이 터미널이 붙여넣기 마커를 이해하는지 먼저 확인하고, 이해하면 감싸 보내고 아니면 다르게 처리한다. 지금 코드는 "여러 줄 + 모드 꺼짐 = 거부"만 한다(`TerminalView.tsx:2750`).
4. **embedded ESC sanitize** — 페이로드 **안에** 숨어 있는 `ESC[201~`이 붙여넣기 경계를 탈출해 뒤 내용이 명령으로 실행되는 것을 막는다. 알려진 공격 기법이다.

   1~3은 "사고"를 막고 4는 "공격"을 막으므로 **4를 생략하면 나머지 셋이 있어도 보안 구멍이 남는다.** 그리고 이 넷 전부가 **키보드 Ctrl+V 경로에도 적용되어야 한다** — 위 ⚠️ 블록 4번과 "무엇을 만들어야 하나요 › 프론트엔드 4"를 반드시 함께 읽는다.

- [ ] copy-on-select debounce/size cap과 OSC52 default deny, opt-in bounded write, base64/UTF-8 validation, query deny가 적용된다.

**해설**: OSC52 query는 예외 없이 deny다. 옵션도 만들지 말라는 뜻으로 읽어야 한다.

- [ ] ACK-loss-after-write, duplicate retry, operation-ID payload mismatch, reconnect boundary, eviction과 Windows 한글/Linux candidate/macOS composition/kitty chord matrix에서 duplicate/missing input이 0이다.

**해설**: "duplicate/missing input이 0"은 전 매트릭스에서 **정확히** 0이어야 한다는 뜻이다. IME 축은 새 기능을 요구하는 것이 아니라 `imeTransaction.ts`의 기존 방어가 새 coordinator 아래로 옮겨진 뒤에도 살아 있음을 증명하는 회귀 축이다.

- [ ] physical connection disconnect에서는 connection-owned pending waiter/timeout을 settle·해제하되 accepted/unacked dedup result는 stable logical client/input epoch ledger에 bounded TTL로 보존해 reconnect result replay에 rebind한다. logical client retirement, ledger TTL/cap eviction 또는 session close 때 최종 해제하며 late ACK/result는 current epoch에 no-op이다.

**해설**: 이 조건이 가장 길고 가장 미묘하다. 요지: **소켓 수명과 dedup 기록 수명을 분리하라.** 소켓에 매인 것(응답 기다리는 promise, 타임아웃 타이머)은 소켓과 함께 정리해야 자원 누수가 없다. 하지만 "이 오퍼레이션 처리했음" 기록까지 같이 버리면 재연결 후 중복 방지가 무력화된다. 기록의 최종 해제 시점은 세 가지: 논리 클라이언트 은퇴, 장부 TTL/상한 축출, 세션 종료. 그리고 옛 에포크의 늦은 ACK가 뒤늦게 도착해도 현재 에포크 상태를 건드리면 안 된다.

- [ ] rollback은 신규 paste admission 중단 → pending operation을 accepted/rejected/unacked/unknown으로 명시 수렴 → 검증된 `pasteInput` safe adapter 전환 순서다. context-menu direct `sendInput` 우회는 복원하지 않는다.

**해설**: 롤백 **순서**가 조건이다. 순서를 바꾸면 롤백 중에 애매한 오퍼레이션이 새로 생긴다. 마지막 문장은 이미 제거된 우회 경로를 되살리지 말라는 금지다.

⚠️ **3단계는 지금 이대로는 실행 불가능하다.** 조건문이 말하는 `pasteInput`이라는 API는 **현재 코드에 존재하지 않는다** — `frontend/src` + `server/src` 전체에서 0건이고, 계약 테스트 `frontend/tests/unit/terminalClipboardAdapterContract.test.ts:106-111`이 그 이름의 재등장을 **능동적으로 금지**한다(`:107`의 `assert.doesNotMatch(terminalViewSource, /\bpasteInput\s*:/)`와 `:108`의 `TerminalContainer` 대응 단언). 조건문 문구는 그 이름이 아직 있던 시점에 쓰인 것이다.

따라서 롤백 절차를 실제로 쓰기 전에 **"검증된 safe adapter"가 지금 코드에서 무엇인지를 먼저 확정해야 한다.** 유력한 후보는 `submitProgrammaticPaste`(`TerminalView.tsx:2735-2770`)와 그 위의 `clipboardCoordinator`(`terminalClipboardCoordinator.ts`)이고, 롤백 대상이 키보드 경로까지 포함한다면 이 이슈가 새로 만드는 `TerminalInputCoordinator`의 검증된 이전 상태가 그 자리에 온다. 어느 쪽이든 **완료 조건 문구는 그대로 두고, 롤백 런북에 실제 대상 API 이름을 적어 남긴다.** `pasteInput`을 되살리는 것은 금지다 — 계약 테스트가 곧바로 빨개진다.

### 공통 완료 조건

- Parent: #2
- Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
- 구현 전 Requirement/Stability gate를 SpecKiwi로 확인하고 missing/draft/deprecated 계약에서는 blocked다.
- failing regression test부터 TDD로 진행하고 관련 test/typecheck/build 및 적용 가능한 `https://localhost:2222` 검증을 수행한다.
- `node.exe`와 TCP 2001/2002 process를 중단하지 않는다. rollout metric과 bounded convergence rollback을 남기며 unsafe legacy 경로는 복원하지 않는다.
- Phase reviewer finding을 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.

**해설**

- **"unsafe legacy 경로는 복원하지 않는다"**가 이 이슈에서 특히 중요하다. context-menu direct `sendInput` 우회는 이미 없어졌고(코드로 확인), 되살리면 안 된다. `pasteInput`도 마찬가지로 계약 테스트가 부재를 강제한다.
- **wave-4에는 SRS 요구사항이 아직 없다.** 구현 전 SpecKiwi로 요구사항을 만들고 `Stability`를 확인해야 한다. 조회·판정은 세 줄이면 끝난다.

  1. MCP가 있으면 `get_requirement`(ID 단건 조회), 없으면 CLI로 **`speckiwi show <ID> --json`**.
  2. 읽을 필드는 **`metadata.Stability`** 하나다.
  3. **`stable`만 통과.** `draft`·`evolving`·`deprecated`는 시작하지 않고, `Stability` 행이 없거나 ID를 못 찾으면 "요구사항 없음"이므로 역시 **blocked**다.

  ⚠️ target 전체를 열거할 때는 `speckiwi list --json`을 쓰고 `--target wave-4`로 좁히지 않는다(wave-4는 0건이다). `speckiwi list --status <status>`는 status를 이미 알아야 해서 이 용도로 못 쓰고, `speckiwi validate`는 진단만 낸다. 실행 시 `SRS-E002 Duplicate requirement ID: REL-BGSTAB-015` 진단이 함께 나올 수 있는데 명령 실패가 아니다. 긴 판정 근거와 예외 처리는 #16 문서의 같은 섹션에 있다.
- **테스트 실행 방법**은 위 "테스트를 어디서 어떻게 돌리나" 참조.

## 의존성과 순서

이 이슈는 wave-4에서 **선행 조건이 가장 많다.**

- **#7 (`[P1-D] pasteInput facade와 copy-promise ownership 1차 통합`)**
  1차 통합. 붙여넣기 진입점을 하나로 모으고 복사 promise 소유권을 정리하는 작업. 이 이슈는 그 위에 exactly-once를 얹는다.
  ⚠️ **이슈는 열려 있지만 코드상 이 작업의 상당 부분이 이미 되어 있다** — 위 "⚠️ 연구 문서 §3.3의 지적을 코드로 재확인한 결과" 참조. 특히 이슈 제목의 `pasteInput`이라는 이름은 현재 코드에 없다.

- **#12 (`[P4-B] single-authority promotion pilot와 authority rollback epoch`)** — 이슈 본문 표기는 "driver lease".
  누가 이 터미널에 쓸 권한을 갖는지를 정하는 계약. 입력 coordinator가 "지금 이 세션에 쓸 자격이 있는가"를 판단하려면 lease 개념이 먼저 있어야 한다. 서버 코드에 이미 `retainedTerminalMutationLeases`가 등장한다(`WsRouter.ts:2893`).

- **#13 (`[P5] per-client·per-session fair scheduler와 ACK/credit ledger`)** — "connectionEpoch/ACK foundation".
  에포크와 ACK 장부의 기반 구조. 이 이슈의 dedup ledger는 그 기반 위에 세워진다. 기반 없이 입력용 ACK만 따로 만들면 출력 쪽 ACK 체계와 **중복 아키텍처**가 된다 — 같은 개념을 두 곳이 나눠 갖는 것은 프로젝트 규칙(§10.2)이 명시적으로 금지한다.

- **#14 (`[P6] hidden delivery gate와 authoritative snapshot recovery`)** — "recovery input gate".
  복구 중에는 입력을 막아야 한다. 권위 화면이 적용되기 전에 입력이 들어가면 사용자가 보고 있는 화면과 실제 셸 상태가 어긋난 채로 명령이 실행된다. 연구 문서 §3.2-2가 지적한 "input gate가 authoritative 화면 적용 전에 열릴 수 있다"가 바로 이 문제다.

**순서 요약**: #7 → (#12, #13) → #14 → #18. #13의 ACK/에포크 기반이 특히 강한 선행이다.

wave-4의 다른 세 이슈(#15/#16/#17)와는 직접 의존이 없다. 렌더링 계열과 입력 계열은 병렬로 진행 가능하다.

## 참고

- 원본 이슈: `Snoworca/BuilderGate#18` (`gh issue view 18 --repo Snoworca/BuilderGate`)
- 관련 SRS: `FR-ARCH-004/006`, `FR-BGSTAB-002/014/017` 및 신규 input exactly-once/IME/OSC52 security 계약
- 연구 문서: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:110-119` (§3.2, input gate 문제), `:122-131` (§3.3), `:644-662` (Phase 8) — 이 로드맵 전체의 원본 설계 문서다
- wave-master 계획 wave-4 범위·게이트: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:70-81`
- `server/src/ws/WsRouter.ts:1812-1813` (`case 'input'`), `:2862-2968` (`handleInput`, dedup 없음), `:2990-2993`·`:3007` (query-reply 전용 accept ACK와 `duplicatePtyReplyCount`), `:4511-4556` (`submitWebSocketInputThroughGateway`, dedup 없음), `:4596-4620` (`rejectInput`, `input:rejected`)
- `server/src/types/ws-protocol.ts:531-539` (`type: 'input'` 필드, 오퍼레이션 ID 없음), `:768-773` (`input:rejected`)
- `frontend/src/types/ws-protocol.ts:45` (`bracketedPasteMode`), `:392-402` (query-reply input 메시지), `:508`·`:515` (`connectionEpoch`)
- `frontend/src/utils/terminalQueryReply.ts` (query-reply 분류기 `isTerminalQueryReply`)
- `frontend/src/utils/contextMenuBuilder.ts:32-36` (OSC 52 언급 주석 — 런타임 소스 내 유일한 OSC 52 언급. `docs/**`에는 계획 문서 여러 곳에 언급이 있다), `:123`·`:130` (복사/붙여넣기 메뉴 항목)
- `frontend/src/components/Terminal/TerminalView.tsx:2735-2770` (`submitProgrammaticPaste`, `:2750` multiline 거부 가드), `:2818-2848` (`captureClipboardSelection`), `:2850-2892` (clipboard coordinator 구성, `:2860-2869` `admitPaste`), `:2985-2987` (handle 노출), `:3728-3745` (Ctrl+C 복사 `:3729` / Ctrl+V 위임 `:3736-3743`), `:3130` (`term.open(terminalRef.current)` — xterm element가 `termEl`의 자식임), `:3996-4001` (xterm v6 double-paste 회귀를 설명하는 주석 — 브라우저 삽입 → `input` → `_inputEvent` 기전), `:4002-4006` (실제 paste capture 가드, `:4004`가 `preventDefault`), `:4089-4103` (우클릭 selection workaround — `:4089`가 이유 주석)
- `frontend/src/utils/terminalClipboardCoordinator.ts` — 전체 (241줄), `:1-5` (`TerminalClipboardSource` 4종), `:128-149` (`pasteCapturedText`, `:139` `admitPaste` 호출), `:152-182` (`copySelection`), `:184-208` (`pasteClipboard`), `:210-223` (`pasteText`)
- `frontend/tests/unit/terminalClipboardAdapterContract.test.ts:106-111` (`pasteInput` 부재를 강제하는 계약 테스트 — `:107`·`:108`이 `doesNotMatch` 단언)
- `frontend/node_modules/@xterm/xterm/src/browser/CoreBrowserTerminal.ts:343-344` (xterm이 textarea·element에 거는 paste 리스너 — `preventDefault`로는 막히지 않는다), 같은 패키지 `src/browser/Clipboard.ts` (`handlePasteEvent` → `paste` → `bracketTextForPaste` → `triggerDataEvent`)
- `frontend/src/utils/imeTransaction.ts:1-40` (IME 상태 기계 타입)
- `frontend/src/utils/terminalInputSequencer.ts:27-35`, `:286-404` (입력 라우팅)
- `frontend/src/App.tsx:234-236` (`sendTerminalInput` — 터미널 handle의 `sendInput`을 그대로 부르는 별개 경로), `:238-256` (clipboard 위임 정의), `:258-265` (`pasteTerminalText`, 기본 소스 `command-preset`), `:282` (커맨드 프리셋 붙여넣기 호출), `:485-490` (탭 컨텍스트 메뉴), `:651-652` (그리드로 전달)
- `frontend/src/components/Grid/MosaicContainer.tsx:622-628` (`handleCopy`/`handlePaste`), `:641` (커맨드 프리셋 붙여넣기 호출), `:715-716` (메뉴 항목 연결)
- `frontend/src/components/Terminal/TerminalContainer.tsx:2087-2104` (`copySelection`/`pasteClipboard`/`pasteText` 위임, 커맨드 프리셋 기본 소스 `:2096`·`:2102`)
- `server/src/services/TerminalResourcePolicy.ts:22`·`:61` (`ackTimeoutMs`, 출력 전달용), `:98` (`inputBackpressureBytes`), `:110-111` (`inputQueueMaxBytes`/`inputQueueTtlMs`)
- `server/src/schemas/config.schema.ts:138` (`inputBackpressureBytes` 기본 1 MiB), `:156-157` (`inputQueueMaxBytes` 기본 64 KiB, `inputQueueTtlMs` 기본 1500 ms)
