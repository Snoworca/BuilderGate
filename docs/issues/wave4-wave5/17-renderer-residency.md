# 안 보이는 터미널이 자원을 얼마나 먹는지 먼저 재고, 안전하게 되살릴 수 있는 것만 내려놓기

> 원문 제목: `[Orca][P7-C] renderer suspension과 snapshot-backed hidden runtime residency`
> 원본 이슈: `Snoworca/BuilderGate#17` — https://github.com/Snoworca/BuilderGate/issues/17

## 한 줄 요약

지금 숨겨진 터미널은 "렌더러만 쉬게 하기"가 아예 없고 "런타임 통째로 버리기"만 있으며, 버릴지 말지를 정할 때 **그 터미널을 되살릴 스냅샷이 있는지 확인하지 않는다.** 먼저 렌더러만 쉬게 했을 때 효과를 측정하고, 되살릴 수 있는 세션만 내려놓게 만들어야 한다.

## 지금 무슨 문제가 있나요?

### 증상 1 — 중간 단계가 없다: 완전히 살아있거나, 통째로 버려지거나

현재 잔존 정책은 `frontend/src/hooks/useTerminalRuntimeResidency.ts:131-201`의 `resolveTerminalRuntimeResidency`에 있고, 결과는 `residentTabs`(남길 탭)와 `evictedTabIds`(버릴 탭) **두 갈래뿐**이다. "화면에 그리는 일만 멈추고 나머지는 살려둔다"는 중간 상태가 없다.

이게 왜 문제인가: 숨겨진 터미널의 비용은 크게 (a) 화면에 그리는 비용과 (b) 화면 상태(xterm 인스턴스, 스크롤백 셀 배열)를 메모리에 들고 있는 비용으로 나뉜다. (a)만 끄면 되살리기는 즉시(같은 xterm을 다시 그리기만)지만, (b)까지 버리면 되살릴 때 서버에서 스냅샷을 받아 화면을 재구성해야 한다. **(a)만 껐을 때 이미 충분한 효과가 나오는데 (b)까지 하면 복잡성만 늘고 되살리기가 느려진다.** 그래서 이 이슈의 첫 완료 조건이 "구현하라"가 아니라 "**따로 측정하라**"인 것이다.

코드에도 미구현 흔적이 남아 있다. `useTerminalRuntimeResidency.ts:224-226`:

```ts
lifecycle: {
  warmRuntimeDelta: 0,
  suspended: false,
  disposed: false,
},
```

세 값이 전부 **하드코딩된 리터럴**이고, 타입 정의(`:39-41`)조차 `warmRuntimeDelta: 0; suspended: false; disposed: false`로 리터럴 타입이다. 즉 "suspension이라는 개념은 자리만 잡아놨고 실제로는 아무것도 일어나지 않는다"는 뜻이다.

> ⚠️ 한 가지 더 나쁜 점: 이 `lifecycle` 블록은 `withHiddenRecoveryTransition`(`:203-230`) 안에 있고, 그 함수는 `:207`에서 `input.hiddenRecovery?.outcome !== 'authoritative-checkpoint-applied'`이면 결과를 그대로 돌려주고 끝난다. 즉 이 리터럴조차 **권위 체크포인트가 적용된 특수 경로에서만 방출되고**, 평상시 잔존 판정 결과에는 `lifecycle` 필드가 **아예 존재하지 않는다**. "suspension 상태를 나타내는 자리가 있긴 있다"보다도 약한 상황이라, 이 이슈가 서스펜션 상태를 새로 설계해야 한다는 근거가 더 강해진다.

### 증상 2 — 되살릴 수 있는지 확인하지 않고 버린다

`useTerminalRuntimeResidency.ts:131-201`이 탭을 버릴지 정하는 기준은 세 가지다.
1. `tab.status !== 'disconnected'`인가 (`:132`)
2. 숨겨진 지 `hiddenRuntimeTtlMs`를 넘었는가 (`:150-165`)
3. `maxLiveTerminals` / `maxLiveWorkspaces` 예산에 드는가 (`:168-189`)

여기 없는 것: **"이 세션의 권위 스냅샷이 서버에 실제로 있는가"**. 스냅샷이 없거나 낡은 상태에서 런타임을 버리면, 사용자가 그 탭으로 돌아왔을 때 되살릴 근거가 없다 — 빈 화면이 뜨거나 최근 몇 줄만 남는다.

사용자에게는 이렇게 보인다: 터미널을 10개 넘게 열어두고 한동안 다른 탭에서 작업한 뒤 오래된 탭으로 돌아가면, 그동안 쌓인 출력이 사라져 있다.

### 증상 3 — 히스테리시스가 없어 경계에서 진동한다

TTL과 개수 상한이 **단일 임계값**이다(`:152-165`, `:168`). 탭이 정확히 상한 경계에 걸쳐 있으면 조금만 왔다 갔다 해도 버려졌다 되살아났다를 반복한다. 되살릴 때마다 스냅샷 왕복이 일어나므로 자원을 아끼려던 정책이 오히려 서버 부하를 만든다.

또한 임계값들의 **근거가 벤치마크가 아니다**. 값 자체는 `resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs` 등 설정에서 오지만(`server/src/services/TerminalResourcePolicy.ts:118-120`), 그 기본값이 어떤 측정에서 나왔는지는 소스에 명시되지 않았다. 완료 조건 3번이 "benchmark-derived policy를 사용한다"고 요구하는 이유다.

### 증상 4 — 선택 영역이 어떻게 되는지 정의돼 있지 않다

사용자가 어떤 터미널에서 텍스트를 드래그해놓고 다른 탭으로 갔다가, 그 사이 그 터미널이 파킹됐다가 돌아오면 — 선택이 살아 있어야 하나? 지워져야 하나? 살아 있는데 다른 줄을 가리키면? 지금 코드에는 이 경로에 대한 정의가 없다.

## 왜 고쳐야 하나요?

정직하게: **이건 주로 부하 상황의 자원 문제이고, 증상 2만 데이터(화면 히스토리) 유실 위험이다.**

- 터미널 1~3개만 쓰는 사용자는 지금도 아무 문제 없다.
- BuilderGate의 목표 시나리오(에이전트 N개 동시 운용)에서는 브라우저 하나가 xterm 인스턴스 십수 개와 그 스크롤백을 전부 들고 있게 된다. 스크롤백은 설정된 보존 줄 수만큼 셀 배열을 잡으므로 탭 개수에 비례해 메모리가 늘어난다. 탭이 늘수록 브라우저가 무거워지고, 심하면 브라우저가 탭을 강제로 내려버린다.
- 증상 2는 "자원을 아끼려다 사용자 데이터를 잃는" 경우다. 이건 성능 문제가 아니라 신뢰성 문제이므로 우선순위가 다르다.

그리고 이 이슈가 **먼저 측정하라**고 요구하는 이유가 있다. 콜드 파킹(런타임 통째 폐기)은 복잡하고 되살리기가 느리고 버그 나기 쉽다. 렌더러 서스펜션만으로 이미 CPU/GPU/DOM의 대부분을 회수한다면 콜드 파킹을 **안 만드는 것이 정답**일 수 있다. 측정 없이 둘 다 만들면 §10.2(중복 아키텍처 금지)를 위반하는 두 개의 자원 회수 경로가 생긴다.

## 배경 지식

### residency (잔존)
"지금 이 순간 브라우저 메모리에 살아있는 터미널 런타임의 집합"을 결정하는 정책. BuilderGate에는 이미 `frontend/src/hooks/useTerminalRuntimeResidency.ts`가 있다. 세션(PTY)은 서버에서 계속 돌고 있고, 여기서 말하는 것은 **브라우저 쪽 xterm 인스턴스**의 생사다.

### renderer suspension (렌더러 서스펜션)
xterm 인스턴스와 화면 상태(버퍼)는 **그대로 두고**, 화면에 그리는 일만 멈추는 것. 구체적으로는 WebGL addon dispose, DOM 갱신 중단 같은 것. 되살릴 때는 다시 그리기만 하면 되므로 즉각적이다. **비용이 싸고 되돌리기 쉬운 쪽.**

### cold parking (콜드 파킹)
xterm 인스턴스를 **통째로 폐기**하고 DOM에서 떼어내는 것. 메모리를 가장 많이 회수하지만, 되살릴 때 새 xterm을 만들고 서버 스냅샷으로 화면을 재구성해야 하므로 느리고 실패 가능성이 있다. **비용이 비싸고 되돌리기 어려운 쪽.**

이 이슈의 핵심 판단은 "**suspension만으로 충분한가, 아니면 parking까지 필요한가**"를 추측이 아니라 측정으로 정하는 것이다.

### snapshot-backed (스냅샷 뒷받침됨)
"이 세션은 서버에 유효한 권위 스냅샷이 있어서, 런타임을 버려도 스냅샷으로 되살릴 수 있다"는 상태. 파킹 후보가 되려면 **먼저 이 조건을 만족해야 한다.** 스냅샷 없이 파킹하면 되살릴 방법이 없다.

### authoritative snapshot (권위 스냅샷)
서버가 들고 있는, 복구할 때 믿을 기준이 되는 화면 상태. 브라우저가 자체적으로 들고 있는 로컬 스냅샷은 프리뷰일 뿐이고 서버 것이 정답이다. 완료 조건 6번이 "롤백/재마운트는 **기존 셀 상태 재해석이 아니라** fresh authoritative snapshot을 사용한다"고 못박은 이유: 버려진 런타임의 잔해에서 화면을 짜맞추려 하면 미묘하게 틀린 화면이 나오고 그 틀림은 조용히 전파된다. 새로 받아서 새로 그리는 것이 항상 옳다.

### warm retention (웜 보존)
"방금 숨겨진 터미널은 곧 다시 볼 가능성이 높으니 일정 시간은 그대로 둔다"는 정책. 탭 A와 B를 왔다 갔다 하는 사용자에게 매번 파킹/복구를 시키면 안 되기 때문이다. 코드에는 이미 `hiddenRuntimeTtlMs` 기반 유예가 있다(`useTerminalRuntimeResidency.ts:150-165`) — "숨겨진 지 TTL이 지나지 않은 탭은 `protectedHiddenTabs`로 보호".

### hysteresis (히스테리시스)
**들어가는 문턱과 나오는 문턱을 다르게 두어 경계에서의 진동을 막는 기법.** 온도조절기가 좋은 비유다: 20도에서 켜고 20도에서 끄면 20도 근처에서 계속 딸깍거린다. 그래서 19도에서 켜고 21도에서 끈다. 여기서는 "숨겨진 지 60초가 지나면 파킹, 하지만 되살아난 뒤에는 최소 120초는 다시 파킹하지 않는다" 같은 식이다. (구체적 숫자는 소스에 명시되지 않음 — 벤치마크로 정해야 한다.)

### benchmark-derived policy (벤치마크에서 도출된 정책)
TTL·상한 같은 숫자를 감으로 정하지 말고 **실제 측정 결과에서 유도**하라는 뜻. 이 저장소에는 이미 벤치마크 인프라가 있다 — `server/src/benchmarks/benchmarkStatistics.ts`(워밍업/측정 단계 구분, 통계 검증), `server/src/benchmarks/terminalCharacterization.ts`.

### baseline convergence (기준선 수렴)
숨기기/보이기/파킹을 예를 들어 50번 반복한 뒤 측정한 값이 1번 했을 때 값으로 돌아오는 것. 완료 조건 5번이 열거하는 측정 대상: 살아있는 **xterm 인스턴스 수**, **WebGL/캔버스 컨텍스트 수**, **DOM 요소 수**, 등록된 **타이머**(`setTimeout`/`setInterval`) 수, **이벤트 리스너** 수, **JS 힙** 사용량. 이 중 하나라도 계속 증가하면 누수이고, 반복 사용하는 IDE에서는 결국 브라우저가 죽는다.

### selection anchor remap (선택 앵커 재매핑)
파킹 전에 사용자가 잡아둔 선택 영역을, 파킹 후 복구된 화면의 어느 줄/칸에 대응시킬지 다시 계산하는 것. 그 대응이 **검증 가능**해야만 선택을 되살리고, 아니면 지운다. 이 앵커 규칙 자체는 이 이슈가 정하지 않는다 — **#16이 정의하고 이 이슈는 그것을 소비해 파킹 경로에서 검증한다** (#16 완료 조건 8번에 명시).

### stale-copy reject (낡은 복사 거부)
복구된 화면이 선택 당시와 같은지 확인할 수 없으면, 복사를 성공시키지 말고 **실패시키고 선택을 지운다**. 조용히 틀린 텍스트를 클립보드에 넣는 것보다 낫다는 판단이다.

### remount (리마운트)
파킹된 터미널을 다시 화면에 붙이는 것. 새 xterm 생성 → 서버에서 스냅샷 수신 → 화면 재구성 → DOM 부착의 순서다.

### rollback (롤백)
이 기능에 문제가 생겨 이전 동작으로 되돌리는 절차. 이 이슈에서는 "파킹된 뷰는 fresh snapshot으로 remount가 필요하다"가 롤백 절차의 일부다(연구 문서 Phase 7 Rollback). 플래그만 끄고 파킹된 뷰를 방치하면 롤백이 아니다.

## 무엇을 만들어야 하나요?

**순서가 이 이슈의 본질이다. 측정 → 정책 → 구현이고, 측정을 건너뛰면 안 된다.**

1. **렌더러 서스펜션만의 효과를 측정한다.**
   측정 대상 지표가 전부 **브라우저 안에 있는 값**(GPU 컨텍스트, DOM 노드, JS 힙)이라는 점에 주의한다. 그래서 역할을 둘로 나눠야 한다.

   - **워크로드 생성은 서버 쪽 하네스**가 맡는다. `server/src/benchmarks/` 아래 기존 하네스(`benchmarkStatistics.ts`의 워밍업/측정 단계 구분과 통계 검증, `terminalCharacterization.ts`)를 그대로 따라, 터미널 N개에 재현 가능한 출력 부하를 먹인다. 서버에서 잴 수 있는 것은 서버 CPU·전송량이지 브라우저 자원이 아니다.
   - **자원 측정은 브라우저 안에서** 한다. Playwright E2E로 페이지를 띄우고 CDP(Chrome DevTools Protocol)를 통해 값을 읽는다.

     CDP 세션을 여는 방법이 이 이슈의 첫 걸림돌이므로 호출 형태를 그대로 적는다. Playwright에서는 `page.context().newCDPSession(page)`로 세션을 얻고 `send(<도메인>.<메서드>)`로 명령을 보낸다.

     ```ts
     const cdp = await page.context().newCDPSession(page);
     const domCounters = await cdp.send('Memory.getDOMCounters');
     // → { documents, nodes, jsEventListeners }
     ```

     이 저장소에 이미 같은 패턴을 쓰는 E2E가 있으므로 그대로 따라가면 된다 — `frontend/tests/e2e/terminal-keyboard-regression.spec.ts:181`. (`--project "Desktop Chrome"`으로 돌려야 CDP를 쓸 수 있다. Chromium 계열 전용 API다.)

     - DOM 노드·리스너 수: CDP `Memory.getDOMCounters`
     - JS 힙: `performance.memory`(Chromium) 또는 CDP `Runtime`/`HeapProfiler` 계열.
       ⚠️ **힙 수치는 GC를 강제하지 않으면 흔들린다.** 아직 수거되지 않은 쓰레기가 그대로 잡히므로 "누수"와 "GC 전"이 구분되지 않는다. 샘플링 **직전에** `HeapProfiler.collectGarbage`(또는 `Memory.forciblyPurgeJavaScriptMemory`)를 보내고 나서 읽어야 기준선 수렴을 assert할 수 있는 값이 나온다. 기준선 측정과 반복 후 측정 **양쪽 모두** 같은 절차를 밟아야 비교가 성립한다.
     - 살아있는 WebGL 컨텍스트 수: #15가 남기는 렌더러 attach/dispose 디버그 이벤트를 세거나, 페이지 안에서 컨텍스트 생성/해제를 계수한다 (#15의 `recordTerminalDebugEvent` 경로를 그대로 쓴다)
     - CPU 시간: 브라우저 쪽은 Playwright 트레이스/프로파일, 서버 쪽은 하네스 자체 측정 — **두 값을 섞어 하나의 숫자로 보고하지 않는다.**

   세 조건에서 위 지표를 각각 측정한다.
   - (기준) 아무것도 안 함
   - (A) 숨겨진 터미널의 렌더러만 서스펜드
   - (B) 숨겨진 터미널을 콜드 파킹

   **A와 B의 차이가 작으면 B(파킹)를 만들지 않는 것이 결론일 수 있다** — 그 결론도 유효한 산출물이다.

2. **측정 결과로 파킹 여부와 임계값을 정한다.** 웜 보존 시간, 히스테리시스 상/하한, 개수 상한의 근거를 문서로 남긴다.

3. **파킹 후보 판정에 스냅샷 조건을 추가한다.**
   `frontend/src/hooks/useTerminalRuntimeResidency.ts:131-201`의 `resolveTerminalRuntimeResidency`에 "권위 스냅샷 보유" 여부를 입력으로 넣고, 없으면 후보에서 제외한다. 현재 입력 타입은 `ResolveTerminalRuntimeResidencyInput`(`:58-67`)이고 탭별 메타데이터가 `metadataByTabId`로 들어오므로, 여기에 필드를 추가하는 것이 자연스럽다. `resolveTerminalRuntimeResidency`는 순수 함수이므로 브라우저 없이 단위 테스트할 수 있다 — TDD하기 좋다.

4. **활성/보이는 터미널을 명시적으로 제외한다.**
   `resolveVisibleTerminalTabIds`(같은 파일 `:98-129`)가 이미 보이는 탭을 계산하므로, 그 결과가 잔존 판정에 확실히 반영되는지 확인한다.

5. **`lifecycle` 하드코딩을 실제 값으로 바꾼다.**
   `useTerminalRuntimeResidency.ts:39-41`(타입)과 `:224-226`(값)의 `warmRuntimeDelta: 0 / suspended: false / disposed: false` 리터럴을 실제 계산 결과가 들어가는 타입으로 넓힌다. 위 증상 1의 ⚠️대로 지금은 이 필드가 권위 체크포인트 경로에서만 나오므로, **평상시 잔존 결과에도 서스펜션 상태가 실려야 한다**는 것까지 포함한다.

6. **선택 앵커 처리를 #16 계약에 연결한다.** 파킹 전 앵커를 보관하고, 복구 후 #16의 식별자로 재매핑을 시도하고, 실패하면 clear한다.

7. **반복 누수 테스트를 붙인다.** hide/reveal/parking을 반복한 뒤 위 배경 지식의 6개 지표가 기준선으로 수렴하는지 assert한다.

### 테스트를 어디서 어떻게 돌리나

- **서버 단위/통합**: `server` 디렉터리에서 `npx tsx src/test-runner.ts`. 단 이 러너는 `*.test.ts`(`node:test`) 스위트를 **돌리지 않는다** — 그쪽에 붙였다면 파일별로 따로 실행해야 한다.
- **프론트 단위**: `frontend` 디렉터리에서 `frontend/tests/unit/` 아래에 두고 `node --experimental-strip-types --test tests/unit/<파일>.test.ts`로 실행한다 (`frontend/package.json`의 `test:unit:*` 스크립트가 이 형태다 — 명령 안의 경로가 상대경로이므로 반드시 `frontend`에서 실행해야 한다). `resolveTerminalRuntimeResidency`가 순수 함수라 3번·4번의 red 테스트는 전부 여기서 쓴다.
- **프론트 E2E**: `frontend` 디렉터리에서 `frontend/tests/e2e/` 아래에 두고 `playwright test tests/e2e/<파일>.spec.ts --project "Desktop Chrome"`으로 실행한다 (`frontend/package.json`의 `test:e2e:*` 스크립트가 `npx` 없이 이 형태를 쓴다. `Desktop Chrome`은 `frontend/playwright.config.ts:21`에 실제로 선언된 project 이름이고, CDP를 쓰려면 이 project여야 한다). 1번의 브라우저 자원 측정과 7번의 반복 누수 테스트는 여기여야 한다. 서버가 `node dev.js --port 2222`로 떠 있어야 한다.

## 완료 조건 (원문 유지)

- [ ] renderer suspension의 CPU/GPU/DOM/heap 효과를 cold parking과 분리 측정한다.

**해설**: "분리 측정한다"가 핵심. 두 기법을 한꺼번에 켜고 "빨라졌다"고 하면 안 된다. 각각의 기여도를 따로 알아야 파킹이 필요한지 판단할 수 있다. 측정 도구 배치는 위 "무엇을 만들어야 하나요" 1번 참조 — 워크로드는 서버 하네스, 지표 수집은 브라우저다.

- [ ] snapshot-backed session만 parking 후보가 되고 active/visible terminal은 제외된다.

**해설**: 두 가지 금지를 담고 있다. (a) 되살릴 스냅샷이 없으면 파킹 금지, (b) 지금 보이고 있는 터미널은 무조건 파킹 금지.

- [ ] 최근 hidden warm retention과 hysteresis가 benchmark-derived policy를 사용한다.

**해설**: 숫자를 감으로 정하지 말라는 뜻. 1번의 측정 결과에서 유도해야 한다.

- [ ] parking 전후 selection anchor를 P7-B identity로 재매핑할 수 있을 때만 보존하고 불가능하면 clear/stale-copy reject한다.

**해설**: "P7-B identity"는 #16이 정의하는 선택 앵커 식별자를 가리킨다. 즉 이 조건은 **#16 없이는 만족시킬 수 없다.**

- [ ] repeated hide/reveal/parking 후 xterm, context, DOM, timer, listener, heap이 기준선으로 수렴한다.

**해설**: 위 배경 지식의 baseline convergence 참조. 6개 지표 전부다.

- [ ] rollback/remount는 기존 cell state 재해석이 아니라 fresh authoritative snapshot을 사용한다.

**해설**: 되살릴 때 예전 셀 데이터를 재활용해서 화면을 짜맞추지 말고, 서버에서 새 스냅샷을 받아 처음부터 그리라는 뜻. 재해석은 미묘하게 틀린 화면을 만들고 그 오류는 조용히 남는다.

### 공통 완료 조건

- Parent: #2
- Source plan: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`
- 구현 전 Requirement/Stability gate를 SpecKiwi로 확인하고 missing/draft/deprecated 계약에서는 blocked다.
- failing regression test부터 TDD로 진행하고 관련 test/typecheck/build 및 적용 가능한 `https://localhost:2222` 검증을 수행한다.
- `node.exe`와 TCP 2001/2002 process를 중단하지 않는다. rollout metric과 bounded convergence rollback을 남기며 unsafe legacy 경로는 복원하지 않는다.
- Phase reviewer finding을 해결하고 재리뷰에서 `No findings`를 받아야 닫는다.

**해설**

- **wave-4에는 SRS 요구사항이 아직 하나도 없다.** 코드를 짜기 전에 SpecKiwi로 요구사항을 만들고 `Stability`를 확인해야 한다. 조회·판정은 세 줄이면 끝난다.

  1. MCP가 있으면 `get_requirement`(ID 단건 조회), 없으면 CLI로 **`speckiwi show <ID> --json`**.
  2. 읽을 필드는 **`metadata.Stability`** 하나다.
  3. **`stable`만 통과.** `draft`·`evolving`·`deprecated`는 시작하지 않고, `Stability` 행이 없거나 ID를 못 찾으면 "요구사항 없음"이므로 역시 **blocked**다.

  ⚠️ target 전체를 열거할 때는 `speckiwi list --json`을 쓰고 `--target wave-4`로 좁히지 않는다(wave-4는 0건이다). `speckiwi list --status <status>`는 status를 이미 알아야 해서 이 용도로 못 쓰고, `speckiwi validate`는 진단만 낸다. 실행 시 `SRS-E002 Duplicate requirement ID: REL-BGSTAB-015` 진단이 함께 나올 수 있는데 명령 실패가 아니다. 긴 판정 근거와 예외 처리는 #16 문서의 같은 섹션에 있다.
- **측정(1번 완료 조건)은 요구사항 게이트 이전에 시작해도 된다.** 게이트가 막는 것은 "구현", 즉 제품 동작을 바꾸는 변경이고, 1번은 벤치마크 하네스와 E2E 계측으로 숫자를 얻는 관측 작업이라 제품 동작을 바꾸지 않기 때문이다. 경계는 명확하다 — **제품 코드의 동작을 한 줄이라도 바꾸는 순간부터는 게이트가 적용된다.** 따라서 2번(측정값을 실제 정책 임계값으로 넣기) 이후는 전부 요구사항이 `stable`이 된 뒤에 한다.
- **TDD**: `resolveTerminalRuntimeResidency`가 순수 함수라 실패 테스트를 먼저 쓰기 쉽다. "스냅샷 없는 탭이 `evictedTabIds`에 들어가면 안 된다"를 red로 만들고 시작하면 된다.

## 의존성과 순서

- **선행: #14 (`[P6] hidden delivery gate와 authoritative snapshot recovery`)**
  "스냅샷으로 되살릴 수 있는 세션만 파킹한다"는 이 이슈의 중심 조건인데, 그 스냅샷 복구 계약을 #14가 만든다. #14 없이는 "스냅샷 뒷받침됨"을 판정할 기준 자체가 없다.

- **선행: #15 (`[P7-A] WebGL renderer/DOM fallback`)**
  1번 완료 조건이 "renderer suspension의 **GPU** 효과"를 요구한다. WebGL 렌더러가 없으면 GPU 자원이 애초에 안 쓰이므로 측정할 대상이 없다. 또 "숨길 때 addon/context를 dispose한다"는 서스펜션 동작 자체가 #15에서 만들어진다.

- **선행: #16 (`[P7-B] Unicode·selection identity`)**
  4번 완료 조건이 "P7-B identity로 재매핑"을 명시적으로 요구한다. #16이 앵커 식별자를 정의하고, 이 이슈가 그것을 파킹 경로에서 소비한다. 역할 분담은 #16 완료 조건 8번에 못박혀 있다.

- **정리하면 이 이슈는 wave-4 렌더링 계열의 마지막**이다: #14 → #15 → #16 → #17.

## 참고

- 원본 이슈: `Snoworca/BuilderGate#17` (`gh issue view 17 --repo Snoworca/BuilderGate`)
- 관련 SRS: `FR-BGSTAB-004/005/014` 및 신규 renderer-residency 계약
- 연구 문서: `docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md:634-637` (Phase 7 PR 7C), `:639-643` (Phase 7 종료 조건·Rollback), `:102` (§3.1 live runtime cap/TTL) — 이 로드맵 전체의 원본 설계 문서다
- wave-master 계획 wave-4 범위·게이트: `docs/plans/2026-07-15.projectmaster.orca-terminal-performance.wave-master.plan.md:70-81`
- `frontend/src/hooks/useTerminalRuntimeResidency.ts:39-41` (`lifecycle` 리터럴 타입), `:58-67` (`ResolveTerminalRuntimeResidencyInput`), `:98-129` (`resolveVisibleTerminalTabIds`), `:131-201` (`resolveTerminalRuntimeResidency`), `:203-230` (`withHiddenRecoveryTransition` — `:224-226`의 하드코딩된 `lifecycle`이 그 안에 있다), `:232-254` (`getNextTerminalRuntimeResidencyRefreshDelay`)
- `server/src/services/TerminalResourcePolicy.ts:118-120` (`hiddenRuntimeTtlMs`, `maxLiveTerminals`, `maxLiveWorkspaces`)
- `server/src/services/TerminalResourcePolicyInventory.ts:145-146` (residency 소비 지점 카탈로그)
- `server/src/benchmarks/benchmarkStatistics.ts:45`, `:101`, `:182-211` (워밍업/측정 단계 구분)
- `server/src/benchmarks/terminalCharacterization.ts:252`
