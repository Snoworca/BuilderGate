# 이모지·한글 폭을 서버와 브라우저가 똑같이 세게 하고, 드래그한 선택 영역이 엉뚱한 글자를 복사하지 않게 만들기

> 원문 제목: `[Orca][P7-B] Unicode·alternate-buffer parity와 stable selection identity`
> 원본 이슈: `Snoworca/BuilderGate#16` — https://github.com/Snoworca/BuilderGate/issues/16

## 한 줄 요약

같은 이모지·한글을 서버 쪽 가상 터미널과 브라우저 쪽 터미널이 서로 다른 "칸 수"로 셀 수 있고, 사용자가 드래그해둔 선택 영역이 화면 좌표에만 매달려 있어서 화면이 갱신되면 **엉뚱한 글자를 복사**할 수 있다.

## 지금 무슨 문제가 있나요?

### 증상 1 (잠재 결함 · 현재는 재현되지 않음) — 서버와 브라우저의 글자 폭 계산이 어긋날 수 있다

BuilderGate는 터미널 화면을 **두 군데**에서 유지한다.
- 서버: `server/src/utils/headlessTerminal.ts` — 화면 없이 돌아가는 xterm 인스턴스. 스냅샷/복구의 권위(authority) 역할.
- 브라우저: `frontend/src/components/Terminal/TerminalView.tsx` — 사용자가 실제로 보는 xterm 인스턴스.

두 인스턴스가 같은 바이트 스트림을 받아 **같은 화면**을 만들어야 스냅샷 복구가 정확해진다. 그런데 생성 옵션이 다르다.

- `server/src/utils/headlessTerminal.ts:206-208, 219-225` — `allowProposedApi: true`, `reflowCursorLine: true` 지정, `scrollback: options.scrollbackLines`.
- `frontend/src/components/Terminal/TerminalView.tsx:3116-3124` + `frontend/src/utils/terminalViewAttributes.ts:75-79` — 브라우저 쪽은 `scrollback`만 정책에서 가져오고 `allowProposedApi`를 **설정하지 않는다**.

`allowProposedApi`는 xterm의 유니코드 버전 교체 API(`term.unicode.activeVersion`, `@xterm/addon-unicode11`)를 쓰기 위한 전제 조건이다. 지금은 양쪽 다 유니코드 addon을 로드하지 않으므로 **둘 다 xterm 기본 폭 테이블을 쓴다** — 즉 현재 실측상 폭 불일치가 반드시 발생한다고 단정할 수는 없다. 하지만 옵션이 비대칭이라 한쪽만 addon을 붙이는 순간 조용히 어긋난다. 이 이슈가 요구하는 것은 "**두 쪽의 폭 정책을 하나의 계약으로 못박고, 골든 테스트로 계속 확인한다**"이다.

한쪽에만 유니코드 addon을 붙이는 순간 사용자에게는 이렇게 보이게 된다: 이모지가 섞인 로그를 출력한 뒤 새로고침하면, 복구된 화면에서 그 줄부터 글자가 한 칸씩 밀려 있다.

서버 쪽에는 이미 비교 축(axis)이 준비돼 있다 — `server/src/utils/headlessTerminal.ts:54-63`의 `RetainedHeadlessComparisonAxes`에 `unicodeWidth`, `activeBuffer`, `cursor`, `modes`, `parserTail`이 열거돼 있고, `:359-362`에서 셀 해시(코드포인트 + grapheme 문자 + xterm 셀 폭)로 비교한다. 즉 **비교 인프라는 있는데 골든 코퍼스가 없다.**

### 증상 2 (현재 재현됨) — 선택 영역이 화면 좌표에 매달려 있다

사용자가 스크롤백을 위로 올려 어떤 줄을 드래그로 선택한 뒤, 그 사이에 새 출력이 들어오거나 새로고침이 일어나면, 복사되는 텍스트가 **선택했던 그 줄이 아닐 수 있다**.

원인 코드: `frontend/src/components/Terminal/TerminalView.tsx:2818-2848`의 `captureClipboardSelection`.

```ts
const position = term.getSelectionPosition();
return {
  text: liveText,
  rangeKey: position
    ? `${position.start.x}:${position.start.y}-${position.end.x}:${position.end.y}`
    : `live:${liveText.length}`,
};
```

> **이슈 본문 표현 교정**: 원본 이슈는 이 `rangeKey`를 "뷰포트 좌표"에 가깝게 서술하지만, 코드를 열어보면 xterm의 `getSelectionPosition()`이 돌려주는 값은 **버퍼 행/열 인덱스**(뷰포트 상대가 아닌 버퍼 절대 행)다. 아래 설명은 코드 기준으로 고쳐 쓴 것이다.

그래도 문제는 남는다 — 이건 "지금 이 버퍼 배열의 몇 번째 칸"일 뿐, "출력 스트림에서 12,431번째 논리 줄"이라는 정보가 아니다. 스크롤백이 상한에 도달해 오래된 줄이 잘려나가거나(trim), 창 크기가 바뀌어 reflow가 일어나면 **같은 내용이 다른 행 번호로 이동한다.** 그러면 이 키는 조용히 다른 줄을 가리킨다.

fallback 경로는 더 약하다. 같은 코드의 `else` 가지는 `live:${liveText.length}` — **선택한 글자 수만** 담는다. 그리고 우클릭으로 저장해둔 선택은 `saved:${generation}`(`:2843-2846`)이라 위치 정보가 아예 없다.

지금은 `frontend/src/utils/terminalClipboardCoordinator.ts:171-176`에서 복사 직전에 "선택이 아직 같은가"를 `isSelectionCurrent`(`TerminalView.tsx:2854-2857`)로 다시 확인하므로 **완전히 무방비는 아니다**. 하지만 확인 기준이 `text` 문자열과 이 `rangeKey`뿐이라, trim/reflow 후 우연히 같은 텍스트가 같은 행 번호에 있으면 통과해버린다. 그리고 새로고침으로 화면 전체가 갈아끼워지는 경우는 아예 다루지 못한다.

### 증상 3 (현재 재현됨) — 새로고침하면 오래된 스크롤백이 사라진다

연구 문서(`docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md` — 이 로드맵 전체의 원본 설계 문서) §3.4가 확인한 계약 절단이다. 코드로 재확인한 결과는 다음과 같다.

- 스크롤백 보존 줄 수 설정은 **두 개**다. `pty.scrollbackLines`(기본 **1000**, `server/src/schemas/config.schema.ts:69`)와 `resourceLimits.terminal.scrollbackLines`(기본 **10000**, 같은 파일 `:160`). headless 인스턴스를 만들 때 어느 쪽을 쓰는지는 retained 모드가 가른다 — `server/src/services/SessionManager.ts:7466-7468`의 삼항 연산자는 **retained 모드가 `shadow`일 때만** `resourceLimits.terminal.scrollbackLines`(10,000)를 쓰고, 그 외에는 `pty.scrollbackLines`(1,000)를 쓴다. (코드를 열면 설정 키 이름 그대로가 아니라 컴파일된 정책 접근자로 보인다 — `shadow` 가지는 `this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines.value`, else 가지는 `this.runtimePtyConfig.scrollbackLines`다. 각각 위 두 설정 키가 컴파일된 결과다.) 같은 10,000 값을 `:7909`의 ledger 상한 산정과 `:5713`의 디버그 증거가 그대로 참조한다.

  ⚠️ **여기서 "shadow 모드"가 기본값이 아니라는 점이 중요하다.** 생성자 기본값은 `retainedTerminalShadowEnabled ?? false`(`SessionManager.ts:1167`)이고, 그러면 `createRetainedTerminalSessionState()`가 `mode: 'disabled'`로 초기화한다(`:7131`). 즉 위 삼항의 **else 가지가 평소 경로**이고 headless는 **1,000줄**로 만들어진다. `shadow`가 켜지는 곳은 `server/src/services/TerminalAuthorityProductionAdapter.ts:981`의 `setRetainedTerminalShadowEnabled(true)` 한 곳뿐이며, 이는 production authority adapter가 attach될 때만 실행된다. 따라서 정확한 문장은 "retained 모델은 10,000줄을 쓴다"가 아니라 "**production authority adapter가 붙어 shadow 모드가 된 세션에서만 10,000줄이고, 그 외에는 1,000줄이다**"이다.

  이 점은 SpecKiwi 요구사항과도 맞춰서 읽어야 한다. `REL-BGSTAB-007`(`docs/spec/30.buildergate-stability.srs.md:2811`)의 `#### Rationale`은 "현재 server headless는 `pty.scrollbackLines`=1,000, browser xterm은 `resourceLimits.terminal.scrollbackLines` 기본 10,000을 사용"한다고 쓰고 있다 — **그 서술이 기본(shadow 꺼짐) 경로 기준으로 맞다.** 두 문서가 어긋난 것이 아니라, 코드가 모드에 따라 두 값을 쓰는 것이다. 그리고 같은 요구사항의 AC-1은 이 불일치를 없애는 방향(`effectiveRetainedScrollbackLines`를 하나의 사용자 설정에서 계산해 서버·브라우저에 동일 적용)을 이미 지정하고 있으므로, 5번 작업의 보존 범위 결정은 **그 AC-1을 따르는 것이지 이 문서의 숫자를 따르는 것이 아니다.**
- 그런데 **refresh 스냅샷은 보존량과 무관하게 `{ scrollback: 0 }`** 이다 — 즉 **현재 화면만** 담는다. `server/src/utils/headlessTerminal.ts:211`의 `VIEWPORT_ONLY_SERIALIZE_OPTIONS`가 그 상수이고 `:260`에서 기본값으로 쓰인다.
- 브라우저 로컬 스냅샷도 `{ scrollback: 0 }`이다 — `frontend/src/components/Terminal/TerminalView.tsx:1440`의 `serializeAddon.serialize({ scrollback: 0 })`.
- 기존 E2E 테스트 `TC-7004`(`frontend/tests/e2e/header-context-menu-regression.spec.ts:581`)는 700줄을 출력해놓고(`:612`), 첫 줄 마커가 스냅샷에 **없어야** 통과하고(`:619`, `:632`) 새로고침 후 화면에도 **없어야** 통과한다(`:627`). 즉 잘림이 "정상 동작"으로 테스트에 굳어져 있다. 이 이슈의 완료 조건 6번은 이 테스트의 전제를 뒤집는다.
- 다만 서버에 **전체 스크롤백을 직렬화하는 경로는 이미 존재한다** — `headlessTerminal.ts:301`의 retained-checkpoint 경로는 옵션 없이 `serializeAddon.serialize()`를 호출한다. 즉 능력이 없어서가 아니라 refresh 스냅샷 경로가 viewport-only를 **선택**하고 있는 것이다.

사용자에게는 이렇게 보인다: 긴 빌드 로그를 보다가 F5를 누르면, 방금 화면에 있던 몇십 줄만 남고 위쪽 스크롤백이 전부 사라진다. 그러니 "오래된 줄을 선택해서 복사"는 애초에 불가능하다. 완료 조건 6번이 이걸 뒤집는다.

## 왜 고쳐야 하나요?

이건 **성능이 아니라 정확성 문제**이고, 셋 중 하나는 **조용한 데이터 오염**이다.

- 증상 2(선택 영역)는 사용자가 복사 버튼을 눌렀는데 **다른 내용이 클립보드에 들어가는** 것이다. 사용자는 그걸 알아챌 방법이 없다. 복사한 명령어를 다른 터미널에 붙여넣고 실행하면 의도하지 않은 명령이 돌아갈 수 있다. 그래서 이 이슈의 설계 원칙은 "틀릴 바에는 **선택을 명시적으로 지우고 복사를 거부한다**"이다 — 완료 조건 4·7번이 그 얘기다.
- 증상 1(유니코드 폭)은 지금 당장 깨져 보이지는 않지만, 화면이 어긋나면 서버-브라우저 권위 승급(authority promotion) 판정에도 영향을 준다. 폭이 다르면 스냅샷 대조가 실패해 복구가 계속 거부될 수 있다.
- 증상 3(스크롤백 절단)은 기능 손실이다. 데이터가 틀리진 않지만 없다.

## 배경 지식

### allowProposedApi
xterm.js가 아직 "제안(proposed) 단계"로 표시해둔 API를 쓰겠다고 명시하는 생성 옵션이다. 켜지 않으면 `term.unicode.activeVersion` 같은 유니코드 폭 테이블 교체 API를 호출할 때 xterm이 예외를 던진다. 서버 headless는 이미 `true`(`headlessTerminal.ts:206-208`)이고 브라우저는 설정하지 않으므로, **유니코드 폭 정책을 바꾸려면 브라우저 쪽에도 이 옵션이 필요하다.** 이 비대칭이 증상 1의 뿌리다.

### normal buffer / alternate buffer (일반 버퍼 / 대체 버퍼)
터미널에는 화면 버퍼가 **두 개** 있다. **normal buffer**는 평소 쓰는 것으로 위로 밀려난 줄이 스크롤백에 쌓인다. **alternate buffer**는 `vim`, `less`, `htop` 같은 전체 화면 프로그램이 진입할 때 갈아끼우는 별도 화면으로, **스크롤백이 없고** 프로그램을 종료하면 통째로 버려지면서 원래 normal buffer가 그대로 돌아온다. `vim`을 열었다 `:q`로 나왔을 때 이전 명령 출력이 그대로 보이는 게 이 덕분이다.

BuilderGate 코드에서는 `frontend/src/utils/terminalRetainedState.ts:1`의 `TerminalBufferType = 'normal' | 'alternate'`로 표현된다. 스냅샷 복구가 **어느 버퍼가 활성인지**를 같이 저장·복원하지 않으면, `vim` 안에서 새로고침했을 때 엉뚱한 화면이 뜬다.

### saved cursor (저장된 커서)
터미널에는 커서 위치를 잠깐 저장했다 되돌리는 이스케이프 시퀀스(`ESC 7` / `ESC 8`, 또는 `CSI s` / `CSI u`)가 있다. 프로그램이 커서를 저장해둔 상태에서 스냅샷을 뜨면, **현재 커서와 저장된 커서 둘 다** 복원해야 복구 후 화면이 어긋나지 않는다.

### wrap-pending (줄바꿈 대기 상태)
80칸 터미널에서 정확히 80번째 칸에 글자를 찍으면, 커서는 아직 줄을 넘기지 않고 "**다음 글자가 오면 그때 줄을 넘기겠다**"는 애매한 상태로 남는다. 이걸 wrap-pending이라 한다. 스냅샷이 이 상태를 저장하지 않으면 복구 후 한 글자가 잘못된 줄에 찍힌다. 정확히 화면 폭에 딱 맞는 로그를 출력할 때 재현된다.

### partial escape (잘린 이스케이프 시퀀스)
터미널 제어 명령은 `\x1b[31m`(빨강) 같은 여러 바이트 시퀀스다. PTY 출력은 임의 지점에서 잘려 도착하므로 `\x1b[3`까지만 오고 `1m`은 다음 청크에 올 수 있다. 파서는 이 **미완성 꼬리(parser tail)**를 들고 있다가 이어붙인다. 스냅샷이 이 꼬리를 저장하지 않으면 복구 후 남은 `1m`이 화면에 글자로 찍힌다. 서버 비교 축에 `parserTail`(`headlessTerminal.ts:61`)이 있는 이유다.

### wide CJK (전각 문자)
한글·한자·일본어 문자는 터미널에서 **두 칸**을 차지한다. `가`는 셀 하나에 글자가 들어가고 그 다음 셀은 "앞 글자가 차지한 자리"로 비워둔다. 폭을 1로 세면 화면이 오른쪽으로 밀린다.

### combining mark (결합 문자)
`e` + U+0301(´)로 `é`를 만드는 것처럼, 앞 글자에 붙어서 하나의 시각적 글자를 이루는 코드포인트. 코드포인트는 2개지만 **화면 칸은 1개**다. 이걸 2칸으로 세면 어긋난다.

### ZWJ (Zero Width Joiner, U+200D)
"이 앞뒤 이모지를 하나로 합쳐서 그려라"라는 보이지 않는 접착제 문자다. 예: 👨 + ZWJ + 👩 + ZWJ + 👧 = 👨‍👩‍👧(가족 이모지 하나). 코드포인트는 5개, 화면 칸은 2개(전각 이모지 하나)다. 폰트가 못 그리면 3개 이모지가 따로 보이는데, 이때 **셀 폭을 몇으로 셀 것인지**가 서버와 브라우저에서 갈리면 화면이 어긋난다. "ZWJ 정책"이란 이 경계 케이스를 어느 쪽으로 통일할지 정해두는 것이다.

### golden corpus / golden test (골든 코퍼스 / 골든 테스트)
"이 입력에 대한 정답 출력은 이것"이라고 미리 확정해 파일로 박아두고, 코드가 바뀔 때마다 그 정답과 대조하는 테스트. 여기서는 "이모지 X를 이 순서로 넣으면 셀 배열이 정확히 이렇게 나온다"를 서버와 브라우저 양쪽에서 돌려 **둘이 같은지** 확인하는 데 쓴다.

### selection anchor (선택 앵커)
드래그 선택의 시작점과 끝점. 지금은 버퍼 행/열 인덱스로만 표현돼 있고(위 증상 2), 그 행 번호는 스크롤백 trim과 reflow에서 재배치된다. 필요한 것은 **버퍼 줄/셀 좌표 + 그 줄이 무엇인지 알려주는 안정적 식별자**의 조합이다.

### selection anchor remap (선택 앵커 재매핑)
화면이 한 번 갈아끼워진 뒤(새로고침·복구·파킹 복귀), **예전 앵커가 지금 화면의 어느 줄/칸에 해당하는지 다시 계산하는 것**. 이 이슈가 정의하고 소유하는 개념이다.

구체적인 예: 사용자가 "출력 스트림의 12,431번째 논리 줄, 3칸째부터 40칸째까지"를 선택해뒀다. 새로고침이 일어나 서버 권위 히스토리로 화면이 재구성되면, 그 논리 줄은 이제 버퍼의 **207행**에 놓여 있을 수 있다. 재매핑은 "논리 줄 12,431 → 지금 버퍼 207행"을 찾아내 앵커를 207행 3~40칸으로 바꿔 다는 일이다. 논리 줄 12,431이 복구된 히스토리에 없거나 내용이 달라졌으면 **재매핑 실패**이고, 그때는 선택을 되살리지 말고 지운다(완료 조건 7번).

재매핑이 **검증 가능**해야 한다는 것은, "아마 이 줄일 것"이 아니라 식별자 대조로 참/거짓이 나와야 한다는 뜻이다. #17은 이 규칙을 새로 만들지 않고 **그대로 소비해서 파킹 경로에서 검증**한다(완료 조건 8번).

### stable source-line identity (안정적 소스 줄 식별자)
"화면 위에서 3번째 줄"이 아니라 "이 세션의 출력 스트림에서 12,431번째 논리 줄"처럼 **화면이 스크롤되어도 변하지 않는** 줄 식별자. 이게 있으면 새로고침 후 스크롤백이 복구됐을 때 "그때 선택했던 그 줄"을 다시 찾아 선택을 되살릴 수 있다.

### logical line (논리 줄)
줄바꿈 문자 하나로 끝나는 진짜 한 줄. 화면 폭이 좁으면 논리 줄 하나가 물리적으로 여러 줄에 걸쳐 표시된다(wrap). 창 크기를 바꾸면 물리 줄 번호는 전부 바뀌지만 논리 줄은 그대로다. 그래서 앵커는 논리 줄 기준이어야 한다.

### snapshot generation / buffer generation (스냅샷 세대 / 버퍼 세대)
화면 내용이 통째로 갈아끼워질 때마다 1씩 올라가는 정수 카운터. 선택 앵커에 이 값을 같이 기록해두면, 복사 시점에 "지금 세대가 그때 세대와 같은가"를 O(1)로 확인할 수 있다. 코드에 이미 비슷한 게 있다 — `TerminalView.tsx:373-374`의 `xtermGenerationRef`와 `clipboardViewGenerationRef`, 그리고 별도로 선언된 `sessionGenerationRef`(`:407`, 판정에 쓰이는 곳은 `:2814`).

### epoch (에포크)
연결이 끊어졌다 다시 붙을 때마다 새로 발급되는 식별자. "이 메시지는 3번째 연결에서 온 것"을 구분해, 재연결 직전의 낡은 메시지가 새 연결의 상태를 오염시키는 것을 막는다. 완료 조건 4번의 "**같은 epoch+geometry만으로 보존하지 않고**"는, "연결 세대가 같고 화면 크기도 같으니 선택도 유효하겠지" 하는 추측을 금지한다는 뜻이다. 그 사이 화면 내용은 얼마든지 바뀔 수 있기 때문이다.

### geometry (지오메트리)
터미널의 `cols` × `rows` 크기.

### reflow (리플로우)
창 크기 변경 시 wrap된 줄들이 새 폭에 맞춰 다시 접히는 것. 물리 줄 번호가 전부 재배치되므로 좌표 기반 앵커는 여기서 반드시 깨진다.

### authoritative retained history (권위 보존 히스토리)
"복구할 때 믿을 기준"이 되는, 서버가 들고 있는 보존된 화면·스크롤백 상태. 브라우저가 들고 있는 것은 프리뷰이고 서버 것이 정답이다. 완료 조건 6번이 요구하는 것은 새로고침 뒤에도 이 히스토리에서 **오래된 줄을 스크롤·선택·복사**할 수 있어야 한다는 것이다.

### stale copy / stale text (낡은 복사)
화면이 이미 바뀌었는데 갱신 전 내용을 복사해버리는 것. 이 이슈는 이걸 "**거부한다**"고 명시한다 — 애매하면 복사를 실패시키고 선택을 지우는 쪽이 조용히 틀린 것을 복사하는 것보다 낫다는 판단이다.

### parking (파킹)
숨겨진 터미널의 브라우저 런타임을 통째로 내려놓아 자원을 회수하는 것. 이 이슈는 파킹 자체를 다루지 않고, **파킹 전후에 선택 앵커를 어떻게 다룰지에 대한 계약만 제공**한다. 실제 검증은 #17이 이 계약을 소비해서 수행한다(완료 조건 8번).

### provider rollback (프로바이더 롤백)
유니코드 폭 계산 구현체를 이전 버전으로 되돌리는 것. 서버와 브라우저를 **따로** 되돌리면 그 사이 두 쪽 폭 정책이 달라지므로, 완료 조건 9번은 "같은 reconnect epoch에서 함께 되돌리고, 기존 셀 상태를 재해석하지 말고 새 권위 스냅샷으로 재동기화하라"고 요구한다.

### Status와 Stability (요구사항의 두 축)
`docs/spec/` 아래 요구사항 블록에는 **서로 다른 두 개의 수명 필드**가 있다.
- `Status`는 **구현·검증 진행도**다 (`planned` → `in_progress` → `implemented` → `verified` 등).
- `Stability`는 **요구사항 문구 자체가 얼마나 굳었는지**다. `draft`(초안 — 아직 바뀔 수 있음) → `evolving`(다듬는 중) → `stable`(확정) 순으로 굳고, 별도로 `frozen`·`deprecated`가 있다.

`draft` 요구사항을 보고 코드를 쓰면 안 되는 이유는 단순하다: **문구가 바뀌면 그 코드와 테스트가 통째로 버려진다.** 특히 이 이슈의 5번 작업(새로고침 보존 범위 변경)은 프로토콜·스냅샷 계약을 건드리므로, 확정 전에 손대면 재작업 비용이 가장 큰 축에 속한다. 그래서 프로젝트 규칙이 `draft`/`deprecated`에서는 **blocked**로 세워두라고 못박고 있다.

## 무엇을 만들어야 하나요?

1. **유니코드 폭 계약을 한 곳에 못박는다.**
   서버 `server/src/utils/headlessTerminal.ts`와 브라우저 `frontend/src/utils/terminalViewAttributes.ts`의 `resolveTerminalXtermOptions`가 **같은 유니코드 버전 / 같은 `allowProposedApi` 설정**을 쓰도록 한다. 두 곳이 각자 옵션을 만들고 있는 지금 구조가 문제의 뿌리이므로, 공유 계약(둘 다 참조하는 상수/함수)으로 올리는 것이 맞다.

2. **골든 코퍼스를 만든다.**
   이모지(단일/ZWJ 시퀀스/피부톤 modifier), combining mark, 전각 CJK, 그리고 alternate buffer 진입/이탈, 커서·saved cursor, wrap-pending, 잘린 이스케이프 시퀀스를 담은 입력 코퍼스와 기대 셀 배열. 서버 쪽은 `headlessTerminal.ts:359-362`의 `unicodeWidth` 비교 축과 셀 해시를 그대로 재사용할 수 있다.

3. **선택 앵커 타입을 새로 정의한다.**
   `frontend/src/components/Terminal/TerminalView.tsx:2818-2848`의 `captureClipboardSelection`이 만드는 `TerminalClipboardSelection`(`frontend/src/utils/terminalClipboardCoordinator.ts:14-17`)을 확장해서, `rangeKey` 문자열 대신 다음을 담는다.
   - 버퍼 종류(`normal` / `alternate`)
   - 버퍼 줄·셀 좌표
   - 논리 줄 식별자 **또는** 스냅샷/버퍼 세대
   `terminalRetainedState.ts`에 이미 `activeBuffer`와 논리 줄 개념이 있으므로 거기서 식별자를 끌어오는 것이 자연스럽다.

4. **검증 실패 시 clear로 수렴시킨다.**
   `terminalClipboardCoordinator.ts:171-176`의 `isSelectionCurrent` 판정을 새 앵커 기준으로 바꾸고, 재매핑 불가 시 선택을 **지우고** 복사를 거부한다. 지금도 `reject('copy', ..., 'context-changed', ...)`로 거부는 하지만 선택을 지우지는 않는다.

5. **스냅샷에 스크롤백을 담는다.**
   `VIEWPORT_ONLY_SERIALIZE_OPTIONS`(`headlessTerminal.ts:211`, 사용처 `:260`)와 `TerminalView.tsx:1440`의 `serialize({ scrollback: 0 })`를 설정된 보존 범위로 바꾼다. 서버 retained-checkpoint 경로(`headlessTerminal.ts:301`)가 이미 전체 스크롤백을 직렬화하므로, 새 능력을 만드는 것이 아니라 **어느 경로가 어떤 범위를 쓰는지를 통일**하는 작업에 가깝다. 연구 문서 §3.4가 명시하듯 **전송 프레임 크기 상한은 청킹의 기준이지 히스토리를 비우는 근거가 아니다** — 크면 나눠 보내야지 버리면 안 된다.
   ⚠️ 이 항목은 **#23이 SpecKiwi로 할당한 신규/대체 refresh authority Requirement ID를 이 이슈(#16) 본문에 기록하고 그 요구사항의 `Stability=stable`을 확인하기 전에는 시작하면 안 된다.** 절차는 아래 공통 완료 조건 해설에 있다.

6. **회귀 테스트를 붙인다.** reset/reflow, 출력 중 사용자 스크롤, WebGL context loss, DOM fallback, hide/reveal, 그리고 새로고침 후 오래된 줄 선택·복사.

### 테스트를 어디서 어떻게 돌리나

- **서버 단위/통합**: `server` 디렉터리에서 `npx tsx src/test-runner.ts`. 단 이 러너는 `*.test.ts`(`node:test`) 스위트를 **돌리지 않는다** — 그쪽에 붙였다면 파일별로 따로 실행해야 한다.
- **프론트 단위**: `frontend` 디렉터리에서 `frontend/tests/unit/` 아래에 두고 `node --experimental-strip-types --test tests/unit/<파일>.test.ts`로 실행한다 (`frontend/package.json`의 `test:unit:*` 스크립트가 이 형태다 — 명령 안의 경로가 상대경로이므로 반드시 `frontend`에서 실행해야 한다). 골든 코퍼스 대조는 브라우저 없이 돌 수 있으므로 여기가 자연스럽다.
- **프론트 E2E**: `frontend` 디렉터리에서 `frontend/tests/e2e/` 아래에 두고 `playwright test tests/e2e/<파일>.spec.ts --project "Desktop Chrome"`으로 실행한다 (`frontend/package.json`의 `test:e2e:*` 스크립트가 `npx` 없이 이 형태를 쓴다. `Desktop Chrome`은 `frontend/playwright.config.ts:21`에 실제로 선언된 project 이름이다). 새로고침 후 선택·복사 회귀는 여기여야 한다. 서버가 `node dev.js --port 2222`로 떠 있어야 한다.

## 완료 조건 (원문 유지)

- [ ] server/browser Unicode width와 ZWJ 정책이 emoji, combining mark, wide CJK golden corpus에서 일치한다.

**해설**: 서버와 브라우저 각각에서 같은 코퍼스를 돌려 셀 폭 배열이 **동일**한지 대조한다. "각자 그럴듯하게 나온다"가 아니라 "둘이 같다"가 조건이다.

- [ ] normal/alternate screen, cursor/saved cursor, wrap-pending, partial escape snapshot/recovery golden test가 통과한다.

**해설**: 위 배경 지식의 alternate buffer / saved cursor / wrap-pending / partial escape 항목 참조. 각각을 스냅샷 뜨고 복구했을 때 원본과 같아야 한다.

- [ ] selection anchor는 terminal buffer line/cell + stable source-line identity 또는 snapshot/buffer generation을 가진다.

**해설**: "또는"에 주의. 논리 줄 식별자를 붙이거나, 세대 카운터를 붙이거나 **둘 중 하나**면 조건을 만족한다. 좌표만 있는 지금 상태는 어느 쪽도 아니다.

- [ ] 같은 epoch+geometry만으로 보존하지 않고 anchor identity 검증이 불가능하면 selection을 명시적으로 clear하며 stale copy를 거부한다.

**해설**: "epoch가 같고 화면 크기도 같으니 선택도 유효하다"고 추측하지 말라는 금지 조항이다. 확인 못 하면 지운다.

- [ ] reset/reflow, output 중 user-scroll, WebGL context loss, DOM fallback, hide/reveal 회귀가 통과한다.

**해설**: 선택 앵커가 깨질 수 있는 다섯 가지 상황을 전부 회귀 테스트로 덮으라는 요구다. 이 중 `WebGL context loss`와 `DOM fallback`은 **#15가 WebGL 렌더러를 들여온 뒤에야 쓸 수 있는 시나리오**다(아래 의존성 참조). 나머지 셋(reset/reflow, 출력 중 사용자 스크롤, hide/reveal)은 지금도 작성 가능하므로 먼저 붙여두면 된다.

- [ ] hard reload 뒤 authoritative retained history의 오래된 logical line을 scroll·select·copy할 수 있고 내용/Unicode cell identity가 pre-refresh와 일치한다.

**해설**: "hard reload"는 F5/Ctrl+Shift+R로 페이지를 완전히 새로 띄우는 것. "Unicode cell identity가 일치한다"는 복구된 줄의 **셀 단위 폭·내용이 새로고침 이전과 같다**는 뜻이다(단순 문자열 비교보다 강하다). 이 조건이 위 증상 3(`{ scrollback: 0 }`)과 기존 E2E `TC-7004`의 전제를 뒤집는 항목이며, **#23 게이트가 걸리는 지점**이다.

- [ ] refresh 사이 selection anchor를 검증 가능하게 재매핑하지 못하면 selection을 clear하며 stale pre-refresh text를 복사하지 않는다.

**해설**: 배경 지식의 "selection anchor remap" 참조. 새로고침 전에 잡아둔 앵커를 복구된 화면의 줄/칸으로 **식별자 대조로** 다시 찾을 수 있을 때만 선택을 되살린다. 못 찾으면 "대충 비슷한 줄"에 갖다 붙이지 말고 선택을 지우고, 새로고침 이전 텍스트를 클립보드에 넣지 않는다. 4번이 "복사 시점"의 금지라면 7번은 "새로고침 경계"의 금지다.

- [ ] parking-specific remap/clear 검증은 P7-C가 이 계약을 소비해 소유한다.

**해설**: 이 이슈는 계약(어떤 앵커를 쓰고 언제 지우는가)만 만들고, **파킹 상황에서의 실제 검증은 #17(P7-C)이 한다**는 역할 분담 선언이다. 여기서 파킹 테스트를 쓰지 말라는 뜻이기도 하다.

- [ ] server/browser provider rollback은 같은 reconnect epoch에서 함께 수행하고 fresh authoritative snapshot으로 재동기화한다.

**해설**: 폭 계산 구현체를 롤백할 때 한쪽만 되돌리면 그 순간부터 두 쪽이 어긋난다. 반드시 같은 재연결 경계에서 동시에 되돌리고, 이미 그려진 셀을 재해석하려 들지 말고 서버에서 새 스냅샷을 받아 다시 맞추라는 뜻이다.

### 공통 완료 조건

- Parent: #2
- Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
- Refresh research: `docs/research/2026-07-15.orca-refresh-retained-state-refactor-research-and-plan.ko.md`
- #23에서 SpecKiwi로 할당한 신규·superseding refresh authority Requirement exact ID를 이 body에 기록하고 `Stability=stable`을 확인하기 전에는 관련 behavior 구현을 시작하지 않는다.
- 구현 전 Requirement/Stability gate를 SpecKiwi로 확인하고 missing/draft/deprecated 계약에서는 blocked다.
- failing regression test부터 TDD로 진행하고 관련 test/typecheck/build 및 적용 가능한 `https://localhost:2222` 검증을 수행한다.
- `node.exe`와 TCP 2001/2002 process를 중단하지 않는다. rollout metric과 bounded convergence rollback을 남기며 unsafe legacy 경로는 복원하지 않는다.
- Phase reviewer finding을 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.

**해설 — #23 게이트를 실제로 통과하는 방법**

이 게이트가 이 이슈에서 **가장 강한 제약**이다. 문장이 짧아서 넘기기 쉬운데, 용어를 하나씩 풀면 이렇다.

- **SpecKiwi**란: 이 저장소의 요구사항(SRS)을 읽고 고치는 도구다. 요구사항 본문은 `docs/spec/` 아래 마크다운 파일들에 있고, SpecKiwi는 그 파일들을 안전하게 조회·수정하는 MCP 도구 세트 겸 `speckiwi` CLI다. 요구사항의 원본(SSOT)은 어디까지나 `docs/spec/`의 파일이다.
- **"이 body"란**: 이 GitHub 이슈(#16)의 본문, 구체적으로 본문의 `## 관련 SRS` 섹션이다. 확정된 Requirement ID를 거기에 적어 넣으라는 뜻이다.

**절차**

1. **요구사항이 이미 있는지 본다.** `docs/spec/00.index.md`를 연다. §2 `SRS Documents` 표가 scope별 문서와 그 Prefix를 알려준다 — 예를 들어 `BGSTAB` 접두사를 쓰는 요구사항은 `docs/spec/30.buildergate-stability.srs.md`에 있다. #23이 새로 만든 refresh authority 요구사항의 ID를 #23에서 받아, 해당 Prefix의 문서를 연다.
2. **그 문서에서 `### <Requirement ID> — <제목>` 헤딩을 찾는다.** 헤딩 바로 아래에 `| Field | Value |` 표가 있고, 그 안에 `Status` 행과 `Stability` 행이 각각 있다. 읽어야 할 것은 **`Stability` 행의 값**이다. 예:

   ```
   ### FR-BGSTAB-005 — Terminal runtime residency limits

   | Field | Value |
   | --- | --- |
   | Type | functional |
   | Target | 0.5.5-buildergate-stability |
   | Status | implemented |
   | Priority | high |
   | ... | ... |
   | Stability | stable |
   ```

3. **손으로 읽지 말고 도구로 읽는 것이 원칙이다.** 파일을 직접 읽는 것은 도구가 없을 때의 확인용이다.

   - **MCP 사용 시**: `get_requirement`(ID 단건 조회).
   - **CLI 사용 시**: `speckiwi show <ID> --json`. 읽을 필드는 **`metadata.Stability`**다.

     ```bash
     speckiwi show REL-BGSTAB-007 --json
     # → {"id":"REL-BGSTAB-007", ..., "metadata":{..., "Stability":"stable", ...}}
     ```

   - **target 전체를 열거**하려면 `speckiwi list --json`을 쓴다. **`--target wave-4`로 좁히지 말 것** — wave-4에는 요구사항이 **0건**이고(`speckiwi list --target wave-4 --json` → `{"records":[]}`), #23이 만드는 신규·superseding 요구사항은 다른 target에 배정될 수 있다. target으로 먼저 좁히면 존재하는 요구사항을 "없다"고 오판하게 된다.
   - 현재 refresh authority 후보는 **`REL-BGSTAB-007`**(`docs/spec/30.buildergate-stability.srs.md:2811`, Target `wave-3`, Stability `stable`)이다. #23이 이것을 그대로 쓸지 superseding 요구사항을 새로 낼지는 #23이 정한다.
   - ⚠️ `speckiwi list` / `speckiwi show` 실행 시 `SRS-E002 Duplicate requirement ID: REL-BGSTAB-015` 진단이 출력에 함께 실려 나올 수 있다. **명령 실패가 아니다** — 요청한 레코드는 정상적으로 반환되며, 이 진단은 저장소의 별개 이슈다. 진단이 보인다는 이유로 게이트 판정을 중단하지 않는다.

   ❌ `speckiwi list --status <status> --json`은 이 단계에 쓸 수 없다. 지금 하려는 일은 "특정 Requirement ID의 `Stability`를 읽는 것"인데 이 명령은 **`status`를 이미 알고 있어야** 쓸 수 있어서 순환이다. `speckiwi validate --json`도 아니다 — 그건 진단(diagnostics)을 뱉지 요구사항 메타데이터를 뱉지 않는다.

4. **판정.**
   - `Stability`가 **`stable`이면 통과** — 5번 작업을 시작해도 된다.
   - `Stability`가 `draft` 또는 `evolving`이면 **시작하지 않는다.** 아직 문구가 바뀔 수 있어서, 지금 쓴 코드와 테스트가 버려질 수 있다. #23에 "stable 승급이 필요하다"고 알리고 기다린다.
   - `Stability`가 `deprecated`면 **시작하지 않는다.** 폐기 예정 계약이므로 대체 요구사항이 무엇인지 #23에 물어야 한다.
   - `Stability` 행 자체가 **없거나** 요구사항 ID를 어느 문서에서도 못 찾으면, 그것은 "요구사항 없음"이므로 **역시 blocked**다. 값을 추측해서 채우지 말고, 요구사항이 아직 만들어지지 않았다는 사실을 그대로 보고한다.
5. **기록.** 통과한 경우, 확정된 Requirement exact ID(예: `FR-BGSTAB-0NN`)를 이 이슈 본문의 `## 관련 SRS` 섹션에 그대로 적는다. "관련 요구사항 있음" 같은 요약이 아니라 **ID 문자열 그대로**여야 한다 — 나중에 검증 증거를 이 ID로 되짚기 때문이다.

**해설 — 나머지 공통 항목**

- **TDD 선행**: 동작을 바꾸기 전에 그 동작이 없어서 **실패하는** 테스트를 먼저 쓰고 red를 눈으로 확인한다. 그 다음 최소 구현으로 green을 만든다. 테스트를 나중에 쓰면 구현에 맞춰 테스트가 오염되므로, 순서 자체가 조건이다.
- **`https://localhost:2222` 검증**: dev 서버는 항상 `node dev.js --port 2222`로 띄우고 브라우저·health 체크 모두 `https://localhost:2222` 기준이다. 다른 포트로 접속하지 않는다. E2E와 수동 확인이 여기에 해당하며, 순수 단위 테스트만으로 끝나는 변경에는 "적용 가능한"이 걸리지 않는다.
- **`node.exe` 중단 금지**: dev 서버는 hot reload로 자동 재시작하므로 `kill {pid}`나 `taskkill /F /IM node.exe`로 프로세스를 죽이면 안 된다. TCP 2001/2002 프로세스도 마찬가지다. `CLAUDE.md`의 프로젝트 규칙이다.
- **reviewer `No findings`**: Phase 리뷰어가 낸 finding을 전부 해결한 뒤 **다시 리뷰를 받아** `No findings`가 나와야 이슈를 닫을 수 있다. 최초 리뷰에서 finding이 나온 것 자체는 문제가 아니고, 재리뷰 없이 닫는 것이 위반이다.
- 위 4번의 `Stability` 판정 절차는 `#23` 게이트뿐 아니라 그 아래 줄의 일반 "Requirement/Stability gate" 항목에도 그대로 적용된다. wave-4에는 아직 SRS 요구사항이 하나도 없으므로, 이 이슈의 **모든** 동작 변경은 요구사항을 먼저 만드는 것에서 시작한다.

## 의존성과 순서

- **선행: #14 (`[P6] hidden delivery gate와 authoritative snapshot recovery`)**
  숨겨진 터미널의 출력을 무엇으로 복구할지가 여기서 정해진다. 선택 앵커를 새로고침·복구 너머로 유지하려면 복구 계약이 먼저 있어야 한다.

- **선행: #12 (`[P4-B] single-authority promotion pilot와 authority rollback epoch`)**
  이슈 본문 표현은 "model-backed refresh promotion". 서버 모델이 권위가 되어야 "권위 보존 히스토리에서 오래된 논리 줄을 되찾는다"(완료 조건 6번)가 성립한다.

- **선행: #15 (`[P7-A] WebGL renderer/DOM fallback`)**
  완료 조건 5번이 "WebGL context loss, DOM fallback에서 선택 회귀가 통과한다"를 요구하는데, WebGL 렌더러가 아직 존재하지 않으므로 그 회귀 테스트를 지금은 **쓸 수 없다**. #15가 먼저 들어와야 한다.

- **사실상 선행: #23 (`[P0-R] 새로고침 retained-state 절단 재현·보존 계약 고정`)**
  의존성 목록에는 없지만 공통 완료 조건이 명시적 차단 게이트로 걸어놨다.

- **이 이슈에 의존하는 것**: #17. 파킹 전후 선택 재매핑/clear 검증이 이 이슈의 앵커 계약을 소비한다(완료 조건 8번).

## 참고

- 원본 이슈: `Snoworca/BuilderGate#16` (`gh issue view 16 --repo Snoworca/BuilderGate`)
- 관련 SRS: `FR-BGSTAB-003/005/014` 및 신규 Unicode/selection identity 계약
- 연구 문서: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:122-131` (§3.3), `:133-146` (§3.4), `:626-632` (Phase 7 PR 7B), `:643` (Phase 7 Rollback)
- wave-master 계획 wave-4 범위·게이트: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:70-81`
- `server/src/utils/headlessTerminal.ts:54-63` (비교 축 정의), `:206-208` (`allowProposedApi: true`, `reflowCursorLine: true`), `:211`·`:260` (`VIEWPORT_ONLY_SERIALIZE_OPTIONS`와 그 사용처), `:219-225` (Terminal 생성), `:301` (전체 스크롤백 직렬화 경로), `:359-362` (`unicodeWidth` 셀 해시 비교)
- `server/src/schemas/config.schema.ts:69` (`pty.scrollbackLines`, 기본 1000), `:160` (`resourceLimits.terminal.scrollbackLines`, 기본 10000)
- `server/src/services/SessionManager.ts:7466-7468` (headless 생성 시 두 설정 중 선택), `:7909` (retained ledger 상한 산정), `:5713` (디버그 증거)
- `frontend/src/components/Terminal/TerminalView.tsx:1440` (`serialize({ scrollback: 0 })`), `:2818-2848` (`captureClipboardSelection`, 버퍼 행/열 기반 `rangeKey` + `live:`/`saved:` fallback), `:2854-2857` (`isSelectionCurrent`), `:3116-3124` (Terminal 생성), `:373-374`·`:407` (세대 카운터 ref들)
- `frontend/tests/e2e/header-context-menu-regression.spec.ts:581` (TC-7004), `:612` (700줄 생성), `:619`·`:627`·`:632` (첫 마커 부재를 성공으로 단언)
- `frontend/src/utils/terminalViewAttributes.ts:75-79` (`resolveTerminalXtermOptions`)
- `frontend/src/utils/terminalClipboardCoordinator.ts:14-17` (`TerminalClipboardSelection`), `:152-182` (`copySelection`, `isSelectionCurrent` 재확인)
- `frontend/src/utils/terminalRetainedState.ts:1` (`TerminalBufferType`), `:489-501`, `:796-826` (`activeBuffer` 캡처)
