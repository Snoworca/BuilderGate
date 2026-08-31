# 터미널 화면을 GPU로 그리게 하되, GPU가 죽어도 화면이 안 깨지게 만들기

> 원문 제목: `[Orca][P7-A] visible-only WebGL auto renderer와 DOM fallback`
> 원본 이슈: `Snoworca/BuilderGate#15` — https://github.com/Snoworca/BuilderGate/issues/15

## 한 줄 요약

BuilderGate 터미널은 지금 화면 전체를 DOM(HTML 요소)으로만 그리고 있어서 출력이 쏟아질 때 느리다. GPU 렌더러(WebGL)를 붙이되, GPU 컨텍스트가 날아갔을 때 화면이 빈 화면이나 깨진 글자로 남지 않도록 DOM 렌더러로 되돌아오는 안전장치를 **먼저** 만들어야 한다.

## 지금 무슨 문제가 있나요?

지금 실제로 발생하고 있는 문제는 **증상 1 하나**이고, 증상 2·3은 **GPU를 안전장치 없이 켜는 순간 새로 생길** 문제다. 이 이슈의 제목이 "GPU를 켠다"가 아니라 "안전장치를 먼저 깔고 켠다"인 이유가 이것이다.

**증상 1 (현재 발생) — GPU 렌더러가 아예 없다.**
사용자가 `yarn build`나 대용량 로그처럼 출력이 초당 수천 줄 쏟아지는 명령을 실행하면, 브라우저가 그 글자들을 전부 DOM 요소로 만들어 그리느라 CPU를 태우고 스크롤이 버벅인다.

근거 (코드로 확인함):
- `frontend/package.json:23-38` — dependencies에 `@xterm/addon-fit`, `@xterm/addon-serialize`, `@xterm/xterm`만 있고 `@xterm/addon-webgl`은 **없다**.
- `frontend/src/components/Terminal/TerminalView.tsx:3116-3129` — `new Terminal({...})` 후 `term.loadAddon(fitAddon)`, `term.loadAddon(serializeAddon)` 두 개만 붙인다. 렌더러 addon은 하나도 붙지 않으므로 xterm의 기본값인 DOM 렌더러가 쓰인다.
- 저장소 전체(`frontend/src`, `server/src`)를 `webgl` 문자열로 검색해도 결과가 0건이다.

**증상 2 (아직 발생하지 않음 · 안전장치 없이 GPU를 켜면 발생) — fallback 경로가 없다.**
WebGL은 브라우저가 언제든 컨텍스트를 회수할 수 있다(아래 배경 지식 참조). 지금처럼 fallback 경로가 없는 상태에서 addon만 붙이면, 노트북이 절전 모드에서 깨어나거나 GPU 드라이버가 재시작될 때 터미널이 **하얀 화면 또는 깨진 글자**로 남는다. 그래서 이 이슈의 순서는 "GPU를 켠다"가 아니라 "**떨어질 자리를 먼저 깔고** GPU를 켠다"이다.

**증상 3 (아직 발생하지 않음 · 안전장치 없이 GPU를 켜면 발생) — 안 보이는 탭까지 GPU 자원을 물게 된다.**
BuilderGate는 탭/그리드로 터미널을 여러 개 띄운다. 브라우저가 한 페이지에서 허용하는 WebGL 컨텍스트 개수는 유한하다(정확한 수는 브라우저 구현에 달려 있고 **소스에 명시되지 않음**). 숨겨진 탭까지 전부 컨텍스트를 잡으면 새 탭을 열 때 오래된 컨텍스트가 강제로 회수되면서 다른 탭이 깨진다. 그래서 "**보이는 터미널에만**" 붙여야 한다.

## 왜 고쳐야 하나요?

정직하게 말하면 이건 **데이터 유실 문제가 아니라 부하 상황에서의 성능 문제**다. 지금도 화면 내용이 틀리게 나오지는 않는다.

다만 BuilderGate의 목표가 "N개 코딩 에이전트를 브라우저 하나에서 동시 운용"이므로, 여러 터미널이 동시에 출력을 뿜는 상황이 정상 시나리오다. (**"제품이 N개까지 버텨야 한다"는 목표치로 못박힌 숫자는 없다. 다만 검증에 쓸 축은 있다** — 아래 §참고의 연구 문서 §10.1 검증 matrix `:730-741`이 client 수 `1 / 2 / 8`, session 수 `1 / 8 / 32 / 54`를 열거한다. 성능 측정과 회귀 시나리오는 감으로 고른 숫자가 아니라 이 축을 쓴다. wave-5의 #21도 같은 축을 인용한다.) 그 상황에서 DOM 렌더러는 브라우저 메인 스레드를 잡아먹고, 그러면 터미널 렌더링뿐 아니라 파일 매니저·입력·SSE 처리까지 같이 느려진다.

반대로 **fallback 없이 GPU만 켜면** 성능은 얻지만 "가끔 화면이 하얗게 되는" 새 버그를 얻는다. 그건 성능 문제가 아니라 신뢰성 문제라서 더 나쁘다. 그래서 이 이슈의 완료 조건 대부분이 "빠르게 만들기"가 아니라 "**실패해도 안전하게 만들기**"에 할애돼 있다.

## 배경 지식

### WebGL 렌더러 (WebGL renderer)
xterm.js는 글자를 화면에 그리는 방식을 갈아끼울 수 있다. 기본은 **DOM 렌더러**로, 글자 한 줄마다 `<span>` 같은 HTML 요소를 만들어 브라우저에게 배치·그리기를 맡긴다. **WebGL 렌더러**(`@xterm/addon-webgl`)는 대신 글리프(글자 모양)를 텍스처 아틀라스에 캐시해두고 GPU에게 사각형 뭉치를 한 번에 그리게 한다. 예: 100줄이 한꺼번에 바뀔 때 DOM 렌더러는 수백 개 요소를 갱신하지만, WebGL 렌더러는 GPU 드로우 콜 몇 번으로 끝난다.

### DOM fallback
"GPU 렌더러가 못 쓰게 되면 원래의 DOM 렌더러로 되돌아간다"는 뜻이다. 되돌아갈 때 화면 내용을 다시 그려주지 않으면 사용자에게는 빈 화면이 보인다. 그래서 fallback은 "addon을 dispose한다"로 끝이 아니라 "**DOM 렌더러로 정상 프레임이 다시 나올 때까지**"가 한 세트다.

### context loss (컨텍스트 손실)
WebGL 컨텍스트는 브라우저가 소유한 GPU 자원 핸들이고, 브라우저는 이걸 **아무 때나 회수할 수 있다**. 흔한 원인: 노트북 절전/복귀, GPU 드라이버 크래시나 업데이트, 탭이 백그라운드에서 오래 있음, 한 페이지가 컨텍스트를 너무 많이 만들어서 오래된 것을 밀어냄. 회수되면 `webglcontextlost` 이벤트가 뜨고 그 순간부터 그 컨텍스트로는 아무것도 못 그린다. **정상 동작의 일부**로 취급해야지, 예외 상황으로 보면 안 된다.

테스트에서는 브라우저가 회수해주기를 기다릴 수 없으므로 표준 WebGL 디버그 확장으로 직접 유도한다 — `gl.getExtension('WEBGL_lose_context').loseContext()`. 완료 조건 3번이 말하는 "public API 범위"가 가리키는 것이 이 표준 확장이다.

### attach / dispose
`term.loadAddon(webglAddon)`이 attach, `webglAddon.dispose()`가 dispose다. dispose를 빼먹으면 GPU 메모리(텍스처 아틀라스)와 DOM 캔버스 요소, 이벤트 리스너가 그대로 남는다. 탭을 100번 열고 닫으면 그게 100배로 쌓인다 — 이게 완료 조건의 "기준선으로 수렴한다"가 말하는 것이다.

### visible / hidden (보이는 / 숨겨진 터미널)
BuilderGate에는 탭 모드와 그리드(분할) 모드가 있고, 지금 화면에 실제로 보이는 터미널은 일부다. 판정 로직은 `frontend/src/hooks/useTerminalRuntimeResidency.ts:98-129`의 `resolveVisibleTerminalTabIds`에 이미 있다. 숨겨진 터미널도 PTY는 계속 돌고 출력도 계속 받지만, **화면에 그릴 필요는 없다**.

### suspend / resume (중단 / 재개)
숨겨질 때 렌더러를 놓고(suspend), 다시 보일 때 붙이는(resume) 것. resume 시 GPU가 아직 여유가 없어 attach가 실패할 수 있으므로 재시도가 필요하고, 그 재시도는 **bounded** — 즉 "최대 N번, 최대 T밀리초까지만"으로 상한이 있어야 한다. 상한이 없으면 실패한 탭이 무한 재시도 루프를 돌며 CPU를 먹는다. (구체적 N, T 값은 소스에 명시되지 않음 — 구현 시 정하고 근거를 남겨야 한다.)

### auto policy (자동 정책)
"이 플랫폼/GPU에서 WebGL을 켤지 말지"를 자동으로 판단하는 규칙. 예: 소프트웨어 렌더링만 되는 환경, 알려진 드라이버 버그가 있는 GPU, WebGL2를 지원하지 않는 브라우저에서는 켜지 않는다. 사용자가 설정을 읽지 않아도 안전한 쪽이 기본이어야 한다.

### stable public API vs private patch
xterm.js가 공식적으로 문서화한 API(`loadAddon`, `dispose`, `onRender` 등)가 public API다. 이걸로 안 되는 걸 하려고 xterm 내부 필드(`(term as any)._core...`)를 건드리는 게 private patch다. private patch는 xterm 버전을 올리는 순간 조용히 깨진다. 완료 조건 마지막 항목은 "**public API로는 정말 안 된다는 테스트 증거 + 버전 고정(version pin)이 있을 때만** private patch를 별도 승인한다"는 뜻이다.

### heap / listener / DOM node 기준선 수렴
"기준선(baseline)으로 수렴한다"는, 숨기기·보이기를 예를 들어 50번 반복한 뒤 측정한 JS 힙 사용량, DOM 요소 개수, 등록된 이벤트 리스너 수, 살아있는 WebGL 컨텍스트 수가 **1번 했을 때와 비슷한 값으로 돌아온다**는 뜻이다. 계속 증가하면 누수다.

## 무엇을 만들어야 하나요?

1. **`@xterm/addon-webgl`을 `frontend/package.json` dependencies에 추가한다.**
   xterm 코어가 `^6.0.0`이므로 addon도 v6 계열과 호환되는 버전을 골라야 한다. (정확한 버전 번호는 소스에 명시되지 않음.)

2. **렌더러 정책 모듈을 새로 만든다.**
   `frontend/src/utils/` 아래에 `terminalRendererPolicy.ts` 같은 파일을 두고, 순수 함수로 "이 환경에서 WebGL을 켤 것인가"를 판단하게 한다. 순수 함수여야 테스트에서 브라우저 없이 검증할 수 있다. 기존 파일 중 `terminalViewAttributes.ts:75-79`의 `resolveTerminalXtermOptions`가 비슷한 역할(옵션 계산)을 하므로 그 옆에 나란히 두는 것이 자연스럽다.

3. **렌더러 라이프사이클을 `TerminalView.tsx`에 연결한다.**
   - attach 지점: `TerminalView.tsx:3116-3129`의 addon 로딩 구간. 단, 정책 통과 + `isVisibleRef.current === true`일 때만.
   - `webglcontextlost` 리스너를 달고, 발생 시 addon dispose → DOM 렌더러로 복귀 → 화면 다시 그리기.
   - 가시성 전환 지점: `isVisible` prop이 이미 `TerminalView.tsx:369`로 들어오고 `isVisibleRef`로 추적되고 있으므로, 여기에 suspend/resume을 건다.

4. **재시도를 상한 있게 만든다.**
   재시도 상태를 **테스트에서 단언할 수 있는 값 객체**로 들고 있어야 한다 — 예: `{ attempts: number; nextDelayMs: number; lastError: string | null; gaveUp: boolean }`. "재시도를 몇 번 했고, 다음 시도까지 얼마 남았고, 마지막 실패 사유가 무엇이고, 최종 포기했는가"를 밖에서 읽을 수 있어야 완료 조건 4번의 "bounded"와 "observable"을 테스트로 증명할 수 있다. 최종 실패는 `recordTerminalDebugEvent`(이미 `TerminalView.tsx:2877-2879`에서 clipboard가 쓰는 방식)로도 남긴다.

5. **우클릭 selection workaround의 회귀를 별도로 확인한다.**
   `TerminalView.tsx:4089-4103`에 "DOM 렌더러에서 right-click mousedown이 DOM selection을 collapse시켜 xterm이 스스로 clearSelection 하는 타이밍 문제"를 우회하는 코드가 있다(`:4089`가 그 이유를 적은 `// 우클릭 캡처:` 주석이고 `:4092-4103`이 실제 핸들러다). 이 workaround가 WebGL 렌더러에서도 필요한지, 오히려 해로운지는 **DOM 모드와 WebGL 모드에서 각각 따로 테스트**해야 한다. 연구 문서(`docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md` — 이 로드맵 전체의 원본 설계 문서) §3.3이 명시적으로 요구하는 항목이다.

6. **TDD 순서로 진행한다.** 실패하는 회귀 테스트(context loss 시뮬레이션 → 빈 화면 아님을 assert) → 구현 → 통과.

### 테스트를 어디서 어떻게 돌리나

- **서버 단위/통합**: `server` 디렉터리에서 `npx tsx src/test-runner.ts`. 단 이 러너는 `*.test.ts`(`node:test`) 스위트를 **돌리지 않는다** — 그쪽에 붙였다면 파일별로 따로 실행해야 한다.
- **프론트 단위**: `frontend` 디렉터리에서 `frontend/tests/unit/` 아래에 두고 `node --experimental-strip-types --test tests/unit/<파일>.test.ts`로 실행한다 (`frontend/package.json`의 `test:unit:*` 스크립트가 이 형태다 — 명령 안의 경로가 상대경로이므로 반드시 `frontend`에서 실행해야 한다).
- **프론트 E2E**: `frontend` 디렉터리에서 `frontend/tests/e2e/` 아래에 두고 `playwright test tests/e2e/<파일>.spec.ts --project "Desktop Chrome"`으로 실행한다 (`frontend/package.json`의 `test:e2e:*` 스크립트가 `npx` 없이 이 형태를 쓴다. `Desktop Chrome`은 `frontend/playwright.config.ts:21`에 실제로 선언된 project 이름이다). 서버가 `node dev.js --port 2222`로 떠 있어야 한다.
- 이 이슈의 핵심 시나리오인 context loss는 E2E에서 `gl.getExtension('WEBGL_lose_context').loseContext()`로 유도한다.

## 완료 조건 (원문 유지)

- [ ] platform/GPU auto policy를 통과한 visible terminal에만 stable public WebGL addon을 attach한다.

**해설**: "auto policy 통과 + 지금 보이는 터미널" 두 조건을 **모두** 만족할 때만 addon을 붙인다. 숨겨진 터미널에는 절대 붙이지 않는다.

- [ ] attach 실패/context loss 시 즉시 DOM renderer로 fallback하고 정상 frame을 bounded 시간 내 표시한다.

**해설**: "bounded 시간 내"는 "언젠가는 복구된다"가 아니라 "정해진 상한 안에 복구된다"는 뜻이다. 테스트에서 그 상한을 assert할 수 있어야 한다.

- [ ] hide/suspend 시 addon/context를 dispose하며 필요 시 public API 범위에서 context loss를 유도한다.

**해설**: "필요 시 public API 범위에서 context loss를 유도한다"는, 브라우저가 알아서 회수해주기를 기다리지 말고 우리가 능동적으로 컨텍스트를 놓아 다른 탭이 쓸 수 있게 하라는 뜻이다. 단 그 방법이 xterm/WebGL의 공개 API 범위 안이어야 한다 — 표준 `WEBGL_lose_context` 확장의 `loseContext()`가 그 수단이다.

- [ ] wake/resume retry가 bounded하고 실패는 observable하다.

**해설**: "observable하다"는 실패가 조용히 삼켜지지 않고 디버그 이벤트/메트릭으로 남아 나중에 조회 가능하다는 뜻이다. 위 "무엇을 만들어야 하나요" 4번의 재시도 상태 객체가 그 근거가 된다.

- [ ] repeated context loss/hide/reveal 후 WebGL context, DOM node, listener, heap이 기준선으로 수렴한다.

**해설**: 위 배경 지식의 "기준선 수렴" 참조. 누수 없음을 수치로 증명하라는 요구다.

- [ ] private patch는 public API로 재현 결함을 해결할 수 없다는 test evidence와 version pin이 있을 때만 별도 승인한다.

**해설**: xterm 내부를 건드리는 패치는 기본 금지. 예외를 원하면 (a) public API로 해결 불가함을 보이는 테스트와 (b) xterm 버전 고정을 함께 제출하고 별도 승인을 받으라는 뜻이다.

### 공통 완료 조건

- Parent: #2
- Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
- 구현 전 Requirement/Stability gate를 SpecKiwi로 확인하고 missing/draft/deprecated 계약에서는 blocked다.
- failing regression test부터 TDD로 진행하고 관련 test/typecheck/build 및 적용 가능한 `https://localhost:2222` 검증을 수행한다.
- `node.exe`와 TCP 2001/2002 process를 중단하지 않는다. rollout metric과 bounded convergence rollback을 남기며 unsafe legacy 경로는 복원하지 않는다.
- Phase reviewer finding을 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.

**해설**

- **Requirement/Stability gate**: 이 저장소는 `docs/spec/`을 요구사항 SSOT로 쓴다. wave-4에는 아직 SRS 요구사항이 하나도 작성되지 않았으므로, 코드를 짜기 전에 SpecKiwi로 요구사항을 만들고 `Stability`를 확인해야 한다. 조회·판정은 세 줄이면 끝난다.

  1. MCP가 있으면 `get_requirement`(ID 단건 조회), 없으면 CLI로 **`speckiwi show <ID> --json`**.
  2. 읽을 필드는 **`metadata.Stability`** 하나다.
  3. **`stable`만 통과.** `draft`·`evolving`·`deprecated`는 시작하지 않고, `Stability` 행이 없거나 ID를 못 찾으면 "요구사항 없음"이므로 역시 **blocked**다.

  ⚠️ target 전체를 열거할 때는 `speckiwi list --json`을 쓰고 `--target wave-4`로 좁히지 않는다(wave-4는 0건이다). `speckiwi list --status <status>`는 status를 이미 알아야 해서 이 용도로 못 쓰고, `speckiwi validate`는 진단만 낸다. 실행 시 `SRS-E002 Duplicate requirement ID: REL-BGSTAB-015` 진단이 함께 나올 수 있는데 명령 실패가 아니다. 긴 판정 근거와 예외 처리는 #16 문서의 같은 섹션에 있다.
- **node.exe 중단 금지**: dev 서버(`node dev.js --port 2222`)는 hot reload로 자동 재시작하므로 프로세스를 죽이면 안 된다. `CLAUDE.md`의 프로젝트 규칙이다.
- **rollback**: 연구 문서 Phase 7이 지정한 롤백은 "WebGL을 dispose하고 DOM renderer를 refresh한다"이다. 플래그만 끄는 것은 롤백이 아니다.

## 의존성과 순서

- **선행: #14 (`[Orca][P6] hidden delivery gate와 authoritative snapshot recovery`)**
  왜 먼저인가: 이 이슈는 "숨겨질 때 렌더러를 놓고 다시 보일 때 되살린다"를 한다. 그런데 렌더러를 놓은 동안 도착한 출력을 **어디에 어떻게 보관했다가 어떻게 복구할지**는 #14가 정하는 계약이다. #14 없이 렌더러만 껐다 켜면, 되살아난 화면이 그동안의 출력을 놓친 상태일 수 있다. 즉 #15는 "화면을 어떻게 그리냐"이고 #14는 "무엇을 그려야 하냐"이므로, 후자가 먼저다.

- **이 이슈에 의존하는 것**: #16(선택 영역이 context loss·DOM fallback을 거쳐도 살아남는지 회귀 검증), #17(렌더러 suspension 효과를 측정한 뒤 cold parking을 결정).

- **wave 게이트**: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:80`에 따르면 wave-4 전체의 선행 게이트는 "`wave-3` authority/recovery 완료"다.

## 참고

- 원본 이슈: `Snoworca/BuilderGate#15` (`gh issue view 15 --repo Snoworca/BuilderGate`)
- 관련 SRS: `FR-BGSTAB-005/014` 및 신규 renderer auto/context-loss 계약
- 연구 문서: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:122-131` (§3.3), `:615` (Phase 7), `:619-624` (PR 7A), `:639-643` (Phase 7 종료 조건·Rollback)
- wave-master 계획 wave-4 범위·게이트·제외: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:70-81`
- `frontend/package.json:23-38` (dependencies에 addon-webgl 없음; devDependencies `:39-54`에도 없음)
- `frontend/src/components/Terminal/TerminalView.tsx:3116-3129` (Terminal 생성 + addon 로딩), `:4089-4103` (우클릭 selection workaround — `:4089`가 이유 주석, `:4092-4103`이 핸들러), `:369` (`isVisible` prop)
- `frontend/src/utils/terminalViewAttributes.ts:75-79` (`resolveTerminalXtermOptions`)
- `frontend/src/hooks/useTerminalRuntimeResidency.ts:98-129` (`resolveVisibleTerminalTabIds`)
