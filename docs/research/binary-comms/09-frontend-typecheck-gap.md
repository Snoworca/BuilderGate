# 프론트엔드 타입 검사 공백 — 실측과 폐쇄 방안

> 기준선 `baseline/00-baseline-summary.md:95-102` 이 기록한 공백을 실측으로 채우고, S4 착수 전에 무엇을 해야 하는지 판정한다.
>
> ⚠️ **이 문서를 쓰는 동안 같은 디렉터리에 다른 문서가 동시에 쓰이고 있었다.** 착수 시점(14:15)에는 `00`~`06` + `baseline/` 5개가 전부였고, 종료 시점(14:40)에 `08-client-wiring-design.md` 가 생겨 있었다(mtime 14:39:43). `07` 은 이 시점까지 없다. 이 문서의 번호는 지시된 파일명을 그대로 따른 것이며 결번을 메우지 않는다. **`06-work-plan.md` 도 이 세션 중(mtime 14:16:13) 제3자에 의해 갱신됐다** — 아래 `06:NNN` 인용은 전부 14:16 이후 상태를 읽은 것이나, 이후 다시 바뀌었다면 줄 번호가 어긋날 수 있다 `[미확인]`.

| 항목 | 값 |
|---|---|
| 측정일 | 2026-08-19 (14:10~14:35 KST) |
| HEAD | `eb2f4f89b7a40c0461d11866b0a36f5bc2b4b8a9` |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| **측정 대상** | **HEAD 가 아니라 워킹트리** — 저장소 전체 추적 수정 122 / 미추적(`-uall`) 1,269 |
| node / tsc | v24.16.0 / 5.9.3 (`frontend/package.json:51` `typescript: ~5.9.3`) |
| 실행 환경 | 전부 `env -u NODE_ENV`, cwd 는 각 절에 명시 |
| **파일 변경** | **0건.** 설정 파일을 수정하지 않았다. tsc 는 전부 `--noEmit` + 파일 인자로 재라 |

---

## 0. 요약 — 다섯 줄

1. **프론트 타입 검사 범위는 `src/**` + `vite.config.ts` 뿐이다.** `tsc -b --verbose --dry` 가 정확히 두 프로젝트(`tsconfig.app.json`·`tsconfig.node.json`)만 나열한다. `frontend/tests/**` 98개 파일과 `frontend/playwright.config.ts` 는 **어떤 tsconfig 에도 속하지 않는다.**
2. **`--experimental-transform-types` 로 바꾸는 안은 기각된다 — 실측으로 반증했다.** strip / transform / Node 24 기본값 **셋 다** 타입 에러 2건이 있는 파일을 exit 0 으로 실행했다(§3).
3. **지금 tests 를 검사 대상에 넣으면 244 error / 32 file 이 red 다** (src 152 + tests 98 = 250 파일 중 32개). 이 중 **166건(68%)이 미추적 신규 테스트 12개**에서 나온다. src 자체는 **0건**이다.
4. **S4 가 실제로 건드리는 범위만 잘라내면 82 error / 8 file**, 유닛만 자르면 **35 error / 3 file** 이다. 전면 도입은 불필요하고 위험하며, **35건이 S4 전 최소 착수 단위**다.
5. **타입 검사는 서버·프론트 `ws-protocol.ts` drift 를 잡지 못한다.** 두 파일이 각자 일관되기 때문이다. 실측: 서버가 실제로 보내는 `terminal-authority:*` **17종** 중 `server/src/types/ws-protocol.ts` 가 선언한 것은 **0종**, 프론트 복제본은 **6종**이다. 이미 있는 텍스트 대조 가드(`wsCheckpointProtocol.test.ts:182`)는 파일의 **24.5% / 21.4%** 만 덮고, drift 는 그 구간 **끝에서 25줄 뒤**부터 시작한다(§D).

---

## 1. 현행 구성 전수 — 무엇이 검사되고 무엇이 안 되는가

### 1.1 tsconfig 3개 (프론트 전체, `node_modules` 제외 — glob 전수)

| 파일 | `include` | `references` | `composite` | `noEmit` | `types` | 실제 검사 대상 |
|---|---|---|---|---|---|---|
| `frontend/tsconfig.json` | **없음** (`"files": []`, `:2`) | `./tsconfig.app.json`, `./tsconfig.node.json` (`:4-5`) | 없음 | — | — | **0 파일** (솔루션 파일) |
| `frontend/tsconfig.app.json` | `["src"]` (`:27`) | 없음 | **없음** | `true` (`:16`) | `["vite/client"]` (`:8`) | `src/**/*.{ts,tsx}` **152개** |
| `frontend/tsconfig.node.json` | `["vite.config.ts"]` (`:25`) | 없음 | **없음** | `true` (`:16`) | `["node"]` (`:7`) | `vite.config.ts` **1개** |

`server/tsconfig.json` 과의 대비:

| 파일 | `include` | `exclude` | 결과 |
|---|---|---|---|
| `server/tsconfig.json` | `["src/**/*"]` (`:17`) | `["node_modules","dist"]` (`:18`) | `src/**` **138개 — `*.test.ts` 39개 포함** |

### 1.2 검사 경계 (프론트, 파일 수는 `find` 전수)

| 경로 | 파일 수 | tsc 검사 | 근거 |
|---|---:|---|---|
| `frontend/src/**/*.{ts,tsx}` | 152 | ✅ | `tsconfig.app.json:27` |
| `frontend/vite.config.ts` | 1 | ✅ | `tsconfig.node.json:25` |
| `frontend/tests/unit/*.ts` | 56 | ❌ | 어떤 `include` 에도 없음 |
| `frontend/tests/e2e/*.ts` | 34 | ❌ | 〃 |
| `frontend/tests/benchmarks/*.ts` | 4 | ❌ | 〃 |
| `frontend/tests/support/*.ts` | 3 | ❌ | 〃 |
| `frontend/tests/helpers/*.ts` | 1 | ❌ | 〃 |
| **`frontend/playwright.config.ts`** | 1 | ❌ | `tsconfig.node.json:25` 는 `vite.config.ts` **하나만** 나열한다 |
| `frontend/tools/*.{cjs,mjs}` | 3 | N/A | JS |

**tests 총 98 파일 + `playwright.config.ts` 1 파일이 무검사 영역이다.**

### 1.3 `frontend/package.json` 스크립트 (전수 확인)

| 스크립트 | 정의 | 타입 검사? |
|---|---|---|
| `typecheck` (`:12`) | `tsc -b` | ✅ **단 `src` + `vite.config.ts` 뿐** |
| `build` (`:9`) | `tsc -b && vite build` | ✅ 같은 범위. `vite build` 자체는 esbuild 라 검사 없음 |
| `lint` (`:11`) | `eslint .` | ❌ — §1.4 |
| `test:unit:command-management` (`:14`) | `node --experimental-strip-types --test tests/unit/...` | ❌ — §3 |
| `test:unit:terminal-shortcuts` (`:17`) | 〃 | ❌ |
| `test:e2e:*` (`:15`,`:18`,`:19`) | `playwright test ... --project "Desktop Chrome"` | ❌ — §5 |
| `lint:command-management` (`:13`) | `eslint <파일 나열>` — **`tests/unit/*.ts` 10개와 `tests/e2e/*.ts` 2개를 명시적으로 나열한다** | ❌ (type-aware 아님) |

> `lint:command-management`(`:13`)·`lint:terminal-shortcuts`(`:16`)가 테스트 파일을 명시적으로 나열하고 있다는 사실은 의미가 있다: **테스트 파일을 정적 검사 대상으로 삼겠다는 의도는 이미 저장소에 있고, 빠진 것은 "타입" 축뿐이다.**

### 1.4 ESLint 는 타입을 보지 않는다

`frontend/eslint.config.js:11` 이 `files: ['**/*.{ts,tsx}']` 로 **tests 를 포함**하지만, `:13-17` 의 extends 는 `tseslint.configs.recommended` 다 — `recommendedTypeChecked` 가 아니고, `languageOptions`(`:18-21`)에 `parserOptions.project` 도 `projectService` 도 **없다**. 즉 타입 정보 없는 구문 규칙만 돈다.

**결론: 프론트에서 테스트 코드의 타입을 보는 도구는 현재 0개다.**

---

## 2. `tsc -b` 가 실제로 무엇을 도는가 (실행 확인)

```bash
cd frontend && env -u NODE_ENV npx tsc -b --verbose --dry
```

출력 전문(요지):

```
Projects in this build:
    * tsconfig.app.json
    * tsconfig.node.json
    * tsconfig.json
Project 'tsconfig.app.json' is out of date because output file 'src/App.js' does not exist
Project 'tsconfig.node.json' is out of date because output file 'vite.config.js' does not exist
```

두 가지가 확정된다.

1. **`tsc -b` 가 도는 프로젝트는 정확히 2개**이고, 그 합집합이 `src/**` + `vite.config.ts` 다. tests 로 가는 경로가 없다.
2. `composite: true` 가 없어서 `tsc -b` 가 **매번 out-of-date 로 판정**한다 (`noEmit: true` 인데 `src/App.js` 를 찾는다). 증분이 실질적으로 동작하지 않는다 — 아래 실측 시간과 일치한다. `node_modules/.tmp/` 에 `tsconfig.app.tsbuildinfo`(7,025B)·`tsconfig.node.tsbuildinfo`(51B)가 남아 있으나 재사용되지 않는 것으로 보인다 `[추정]` — 원인 규명은 이 문서의 범위 밖이다.

**현재 범위의 실행 결과 (실측, 워킹트리):**

```bash
cd frontend && env -u NODE_ENV npx tsc -p tsconfig.app.json  --noEmit   # exit 0, error 0
cd frontend && env -u NODE_ENV npx tsc -p tsconfig.node.json --noEmit   # exit 0, error 0
cd server   && env -u NODE_ENV npx tsc -p tsconfig.json      --noEmit   # exit 0, error 0
```

⚠️ **미커밋 작업이 대량인 상태에서도 세 프로젝트가 전부 green 이다.** 즉 지금 red 가 없는 이유는 "코드가 깨끗해서"가 아니라 **red 가 날 파일을 안 보고 있어서**다.

소요(실측, 워킹트리 캐시 상태):

| 범위 | 실측 |
|---|---:|
| `tsc -p tsconfig.app.json --noEmit` (=현행 `typecheck` 의 사실상 전부) | **4.6s** |
| src 152 + tests 98 전부 | **7.7s** |
| src 152 + S4 관련 13개 | **6.0s** |

**비용은 문제가 아니다. 3초 늘어난다.**

---

## 3. 실행 방식 — `--experimental-strip-types` 는 타입을 보지 않는다 (실증)

### 3.1 반증 실험

`{scratchpad}/typeerr.ts` (임시 디렉터리, 저장소 밖):

```ts
interface Msg { type: 'a'; encoding: 'json' }
const m: Msg = { type: 'a' };            // TS2741: 'encoding' 누락
const n: number = 'not a number';        // TS2322
console.log('RAN ANYWAY', JSON.stringify(m), n);
```

| 실행 | 결과 |
|---|---|
| `npx tsc --noEmit --strict typeerr.ts` | **error 2건, exit 2** (TS2741 / TS2322) |
| `node --experimental-strip-types typeerr.ts` | `RAN ANYWAY {"type":"a"} not a number` / **exit 0** |
| `node --experimental-transform-types typeerr.ts` | 동일 출력 + `ExperimentalWarning: Transform Types` / **exit 0** |
| `node typeerr.ts` (플래그 없음, Node 24 기본) | 동일 출력 / **exit 0** |

**`WsTransportMessage` 에 `encoding` 을 필수 필드로 두어도 프론트 테스트에서는 정확히 이 시나리오가 된다** — 필드가 빠진 픽스처가 그대로 실행되고 exit 0 이다. 작업 계획 `06:664-669` 의 판정을 실행으로 재확인했다.

### 3.2 strip vs transform 의 차이 — 타입 검사가 아니라 **구문 허용 범위**다

`{scratchpad}/enum.ts`:

```ts
enum E { A = 1 }
console.log('E.A =', E.A);
```

| 실행 | 결과 |
|---|---|
| `node --experimental-strip-types enum.ts` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode` / **exit 1** |
| `node --experimental-transform-types enum.ts` | `E.A = 1` / **exit 0** |

정리:

| | 소거 불가 구문(enum/namespace/parameter property) | **타입 검사** |
|---|---|---|
| `--experimental-strip-types` | **거부**(SyntaxError) | **안 함** |
| `--experimental-transform-types` | **컴파일해서 실행** | **안 함** |
| Node 24 기본(플래그 없음) | strip 과 동일하게 거부 | **안 함** |

> **⇒ 방안 "실행을 `--experimental-transform-types` 로 전환" 은 목적을 하나도 달성하지 못한다.** 오히려 `erasableSyntaxOnly` 로 얻고 있던 유일한 구문 가드까지 풀어버린다. **기각**(§A-5).

Node 공식 문서에 "Node.js does not type check" 가 명시돼 있다는 것은 통념이나, **이번 조사에서 문서를 직접 열어 확인하지는 않았다** `[미확인]`. 위 표는 전부 실행 결과다.

---

## 4. 서버는 왜 작동하는가

| | 서버 | 프론트 |
|---|---|---|
| 테스트 파일 위치 | **`server/src/**` 안** (`*.test.ts` 39개) | **`frontend/tests/**`** — `src` 밖 |
| tsconfig `include` | `["src/**/*"]` (`server/tsconfig.json:17`) → **테스트 포함** | `["src"]` (`frontend/tsconfig.app.json:27`) → **테스트 제외** |
| 검사 명령 | `tsc` (build) / `tsc --noEmit` (Tier 0, `06:2038`) | `tsc -b` (`frontend/package.json:12`) |
| 실행 | `tsx` (테스트별) — tsx 도 타입 검사는 안 하지만 **컴파일 게이트가 별도로 존재** | `node --experimental-strip-types` — **게이트 자체가 없음** |
| 현재 상태(워킹트리 실측) | **error 0** | src **error 0** / tests **error 244** |

**차이의 본질은 한 줄이다: `include` 가 `src/**/*` 인가 `src` 인가.** 서버는 테스트를 소스 트리 안에 두어 우연히(혹은 설계상) 같은 프로젝트에 넣었고, 프론트는 `tests/` 를 형제 디렉터리로 두어 밖으로 밀어냈다.

부수 사실: 서버 build 는 `outDir: "./dist"`(`server/tsconfig.json:6`)로 **`dist/**/*.test.js` 까지 emit** 한다. `TerminalAuthorityProductionRegression.test.ts` 가 `dist` 를 대상으로만 성립하는 이유가 이것이다(CLAUDE.md 테스트 규칙 절).

서버에 `src` 밖 테스트는 `server/tools/ensure-node-pty-windows-hide.test.cjs`·`server/tools/write-fair-scheduler-evidence-bundle.test.mjs` **2개뿐이고 둘 다 TS 가 아니다** — 즉 서버 쪽 TS 테스트는 **누락 없이 100% 검사된다.**

---

## 5. E2E 는 타입 검사를 받는가 — 받지 않는다

- `frontend/playwright.config.ts:7` 의 `testDir: './tests/e2e'` 는 **어느 tsconfig 의 `include` 에도 없다.**
- **`playwright.config.ts` 자기 자신도 검사되지 않는다** (`tsconfig.node.json:25` 는 `vite.config.ts` 만 나열).
- Playwright 는 spec 을 esbuild 로 트랜스파일해 실행하며 타입 검사를 하지 않는다 — **공식 문서를 직접 열어 확인하지는 않았다** `[미확인]`. 다만 **정황 증거가 결정적**이다: 이번 측정에서 `tests/e2e/**` 에 **180건**의 타입 에러가 존재하는데(§6.2), 기준선(`baseline/e2e-baseline.md`)의 Playwright 실행은 **155 테스트를 수집·실행**했다. 타입 검사를 했다면 수집 단계에서 죽었어야 한다 `[추정 → 사실상 확정]`.
- Playwright 가 `tsconfig.json` 을 읽는 것은 `paths`/`baseUrl` 해석 목적뿐인데, `frontend/tsconfig.json` 에는 `compilerOptions` 자체가 없다(`:1-7` 전문이 `files`+`references` 2키). **읽을 것도 없다.**

이번 조사에서 Playwright 를 실행하지 않았다(금지 범위). 위 판정은 설정 파일 독해 + 기준선 문서 대조로만 이루어졌다.

---

## 6. 실측 — 지금 켜면 몇 개가 빨간가

### 6.1 측정 방법 (재현 절차)

**설정 파일을 만들지 않았다.** `tsconfig.app.json` 의 컴파일러 옵션을 커맨드라인으로 옮기고 파일 목록을 인자로 주는 방식으로 재라. tsc 의 **응답 파일**(`@파일`) 기능을 썼다.

`opts.txt` — `tsconfig.app.json:2-26` 을 1:1 전사하고 `types` 에만 `node` 를 추가한 것:

```
--noEmit
--target ES2022
--lib ES2022,DOM,DOM.Iterable
--module ESNext
--moduleResolution bundler
--allowImportingTsExtensions
--verbatimModuleSyntax
--moduleDetection force
--jsx react-jsx
--skipLibCheck
--strict
--noUnusedLocals
--noUnusedParameters
--erasableSyntaxOnly
--noFallthroughCasesInSwitch
--noUncheckedSideEffectImports
--types vite/client,node
```

실행:

```bash
cd frontend
find src   -type f \( -name '*.ts' -o -name '*.tsx' \) > src-files.txt
find tests -type f \( -name '*.ts' -o -name '*.tsx' \) > test-files.txt
cat opts.txt src-files.txt test-files.txt > args-all.txt
env -u NODE_ENV npx tsc "@args-all.txt"
```

**옵션 등가성 검증(필수 단계):** 같은 `opts.txt` 로 `src` 만 돌려 `tsc -p tsconfig.app.json --noEmit` 과 결과가 같은지 먼저 확인했다 — **양쪽 모두 error 0 / exit 0**. 즉 아래 수치는 "옵션을 다르게 줘서 나온 에러"가 아니다.

> ⚠️ `--types` 에 `node` 를 추가한 것은 불가피하다. tests 가 `node:test`·`node:assert/strict`·`process` 를 쓴다. `node` 를 빼면 `tests/e2e` 에서 **TS2591(`Cannot find name`) 82건 + TS2307(모듈 없음) 24건**이 추가로 터진다(실측: 371건). **`node` 를 넣은 259건 쪽이 하한이며, 그 259개 위치는 `node` 없는 371개 위치의 부분집합이다**(`comm -12` 로 확인 — 교집합 259 = with-node 전량).

### 6.2 결과 — src + tests 전부

| 범위 | error | 파일 | exit |
|---|---:|---:|---:|
| `src` 152개만 | **0** | 0 | 0 |
| `src` + `tests/unit` 56개 | 64 | 11 | 2 |
| `src` + `tests/e2e` 34개 | 180 | 21 | 2 |
| **`src` + `tests` 98개 전부** | **244** | **32** | 2 |

디렉터리별:

| 디렉터리 | 파일 수 | error | red 파일 | green 파일 |
|---|---:|---:|---:|---:|
| `tests/unit` | 56 | 63 | 10 | **46** |
| `tests/e2e` | 34 | 178 | 19 | **15** |
| `tests/support` | 3 | 2 | 2 | 1 |
| `tests/benchmarks` | 4 | 1 | 1 | 3 |
| `tests/helpers` | 1 | 0 | 0 | 1 |
| **합계** | **98** | **244** | **32** | **66 (67%)** |

### 6.3 누구의 빚인가 — git status 귀속

`git status --porcelain=v1 -uall -- frontend/<파일>` 로 32개 red 파일을 분류했다.

| 상태 | error | 파일 | 비중 |
|---|---:|---:|---:|
| `??` **미추적(신규 미커밋)** | **166** | 12 | **68%** |
| ` M` 추적 수정(미커밋) | 45 | 10 | 18% |
| (clean) HEAD 와 동일 | **33** | 10 | **14%** |

파일별 전수 (error 수 / git 상태):

```
67  ??  tests/e2e/wave3-terminal-authority-promotion.spec.ts
31  ??  tests/e2e/wave3-terminal-authority-fairness.spec.ts
23  ??  tests/unit/terminalCheckpointRuntime.test.ts
22  ??  tests/e2e/wave1-retained-state-characterization.spec.ts
 9   M  tests/unit/visibleOutputRecovery.test.ts
 9   M  tests/unit/terminalOutputScheduler.test.ts
 9  --  tests/e2e/terminal-mobile-scroll.spec.ts
 8   M  tests/e2e/helpers.ts
 7  ??  tests/unit/terminalCheckpointCapabilityScoping.test.ts
 5   M  tests/unit/terminalInputSequencer.test.ts
 5   M  tests/e2e/terminal-authority.spec.ts
 5  --  tests/e2e/terminal-title-auto-tab-name.spec.ts
 4  ??  tests/unit/terminalWriteCoordinator.test.ts
 4  ??  tests/e2e/terminal-clipboard.spec.ts
 4  --  tests/e2e/terminal-korean-ime.spec.ts
 4  --  tests/e2e/terminal-keyboard-regression.spec.ts
 3  ??  tests/e2e/wave1-split-characterization.spec.ts
 3   M  tests/e2e/header-context-menu-regression.spec.ts
 3  --  tests/e2e/settings-password-policy.spec.ts
 2  ??  tests/unit/terminalRetainedState.test.ts
 2   M  tests/e2e/terminal-context-menu-registered-items.spec.ts
 2   M  tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts
 2  --  tests/unit/settingsDraftHelpers.test.ts
 2  --  tests/e2e/terminal-shortcut-manager.spec.ts
 2  --  tests/e2e/auth-bootstrap.spec.ts
 1  ??  tests/unit/terminalDebugCapture.test.ts
 1  ??  tests/support/terminalSoleWriterInventory.ts
 1  ??  tests/benchmarks/terminalNoRenderFixture.ts
 1   M  tests/unit/terminalHiddenOutput.test.ts
 1   M  tests/e2e/grid-equal-mode.spec.ts
 1  --  tests/support/perfBgstab010Ac6BrowserAckHarness.ts
 1  --  tests/e2e/pane-split.spec.ts
```

⚠️ **"clean 33건 = HEAD 에서도 red" 가 아니다** `[추정]`. clean 은 *테스트 파일이* HEAD 와 같다는 뜻이고, 그 파일이 참조하는 `src/**` 는 미커밋 수정이 섞여 있다. **HEAD 상태를 실측하지 않았다** — 워킹트리를 건드리지 않고는 잴 수 없어 시도하지 않았다 `[미확인]`. 33 은 "HEAD 에서도 red 일 후보의 상한"에 가깝다.

### 6.4 에러 코드 분포 (244건)

| 코드 | 건 | 의미 | 성격 |
|---|---:|---|---|
| TS2339 | 57 | `Property 'x' does not exist on type 'never'` 등 | **다수가 vacuity 신호** |
| TS2769 | 45 | 오버로드 불일치 | 대부분 `token ? {Authorization} : {}` 패턴 1종 |
| TS2345 | 35 | 인자 타입 불일치 | 픽스처 drift |
| TS18048/18047 | 35 | `possibly undefined/null` | strict 미준수 |
| TS2322 | 15 | 대입 불가 | 픽스처 drift |
| TS7006 | 12 | 암묵 any 파라미터 | |
| TS2353 | 11 | 알 수 없는 속성 | **픽스처가 존재하지 않는 필드를 채운다** |
| TS2352/2349/2739/2741/2722/2367/2717/2550/2502/1354/1484/7053/6133 | 34 | | |

**`--noUnusedLocals`/`--noUnusedParameters` 를 끄고 `lib` 을 ES2023 으로 올려도 244 → 233 이다** (실측). 스타일 잔소리가 아니라 **실질 에러**다.

### 6.5 이미 잡히는 것들 — 타입 검사가 실제로 무엇을 찾아내는가

무검사 상태가 무엇을 감추고 있었는지 세 가지 계열이 두드러진다.

**(a) 공허하게 통과하는 테스트** — 기준선 §3 "신뢰할 수 없는 신호" 와 같은 부류가 추가로 발견된다.

`frontend/tests/unit/settingsDraftHelpers.test.ts:63-68`:

```ts
assert.equal(WAVE6_RESOURCE_LIMIT_GROUPS.some((group) =>
  group.fields.some((field) => field.key === 'resourceLimits.telemetry.sampleIntervalMs')
), false);
```

→ `TS2367: This comparison appears to be unintentional because the types 'Wave6ResourceLimitKey' and '"resourceLimits.telemetry.sampleIntervalMs"' have no overlap.`

`field.key` 는 `Wave6ResourceLimitKey`(`frontend/src/components/Settings/settingsDraftHelpers.ts:10`, `:36`)이고 비교 대상 리터럴은 그 유니온에 **없다**. 즉 `some(...)` 은 **구현이 무엇이든 항상 `false`** 이고, `assert.equal(..., false)` 는 **절대 실패할 수 없다.** 같은 파일에서 2건.

같은 계열: `terminalWriteCoordinator.test.ts:1619/1626/1665/1667` 의 `Property 'sourceSeq'/'snapshotSeq' does not exist on type 'never'` — 어서션 대상이 `never` 로 좁혀졌다는 것은 그 분기가 **도달 불가**라는 뜻이다.

**(b) 프로덕션 선언과 테스트 픽스처의 drift**

`tests/unit/terminalCheckpointCapabilityScoping.test.ts:43/232/314`:
`Type '{ active, disposed, recoveryPending, legacyRecoveryPending, viewGeneration, registrationViewGeneration }' is missing the following properties from type 'Readonly<TerminalCheckpointRuntimeState>': ready, checkpointDeliveryPreparationPending, orderedRollbackPending`

→ **런타임 상태 타입에 필드 3개가 늘었는데 픽스처가 따라오지 않았다.** `06:664` 가 `encoding` 필수 필드로 노리던 바로 그 효과가, 이미 존재하는 다른 필드에서 놓쳐지고 있었다.

`tests/unit/visibleOutputRecovery.test.ts:769/946/971/985/1040`: `Property 'terminalFailed' does not exist on type 'RecoveryTransactionState'` — **존재하지 않는 필드를 5곳에서 읽고 있다.**

**(c) 전역 선언의 중복과 drift** — §D 로 이어지는 핵심

`frontend/tests/e2e/grid-equal-mode.spec.ts:64-76` 이 이렇게 선언한다:

```ts
declare global {
  interface Window {
    __buildergateTerminalDebug?: {
      enable: () => void;
      clear: () => void;
      getEvents: () => TerminalDebugEvent[];
    };
  }
}
```

정본은 `frontend/src/utils/terminalDebugCapture.ts:122-126` 의 `TerminalDebugStore` 이고, 거기서 `enable` 은 **`sessionId` 를 받으며**(`:102-103` 에 `setInputTransportOverride(sessionId, ...)`·`readInputGateSnapshot(sessionId)` 도 있다) 멤버가 20개 이상이다. e2e 전체를 한 프로그램으로 컴파일하면 이 **좁은 사본이 전역에 병합**되어:

- `TS2554: Expected 0 arguments, but got 1` **48건** (`terminal-authority.spec.ts:473` 등 — 전부 `debug.enable(sessionId)`)
- `TS2339: Property 'readInputGateSnapshot' does not exist on type '{ enable; clear; getEvents }'` (`wave3-terminal-authority-promotion.spec.ts:1152`)
- `TS2717: Subsequent property declarations must have the same type. Property '__buildergateCapturedWsMessages'` — `terminal-authority.spec.ts:18` 과 `grid-equal-mode.spec.ts:66` 이 **각자의 로컬 `CapturedWsMessage`** 로 같은 전역을 선언

역으로 `grid-equal-mode.spec.ts` 를 빼면 에러가 **줄지 않고 259 → 389 로 늘어난다** (실측). e2e 파일들이 `src/utils/terminalDebugCapture.ts` 를 import 하지 않기 때문에 **정본 선언이 프로그램에 아예 없고**, 좁은 사본 하나가 유일한 선언이었던 것이다. `src` 를 함께 넣으면 259 → **180** 으로 떨어진다.

> **⇒ tests 전용 tsconfig 는 반드시 `src` 를 함께 포함해야 한다.** tests 만 검사하면 정본 ambient 선언이 없어 수치가 무의미해진다.

---

## A. 방안 비교

측정된 초기 red 규모를 각 안에 붙였다. 모든 수치는 §6 의 워킹트리 실측이다.

### A-1. `tsconfig.app.json` 의 `include` 를 `["src","tests"]` 로 확장

| | |
|---|---|
| 변경 | `frontend/tsconfig.app.json:27` 1줄 + `:8` `types` 에 `"node"` 추가 |
| 초기 red | **244 error / 32 file** |
| 비용 | tsc 4.6s → 7.7s |
| **치명적 부작용** | **`npm run build` 가 `tsc -b && vite build`(`frontend/package.json:9`) 이므로 테스트 타입 에러가 곧 build 실패다.** 그리고 `tools/build-daemon-exe.js:756-764` 의 `ensureBuildArtifacts()` 가 `frontend` → `server` 순으로 `npm run build` 를 부르므로, **루트 build 계열 스크립트 18개 전부와 `release.yml` CI 가 red** 가 된다. CLAUDE.md 가 경고한 "frontend 실패 시 server build 미도달" 함정이 그대로 발동한다 |
| 2차 부작용 | `types` 에 `node` 가 들어가면 **`src/**` 프로덕션 코드가 `process`·`Buffer` 를 참조해도 컴파일된다.** 브라우저 번들에 Node 전역이 새는 것을 막던 가드가 사라진다 (`tsconfig.app.json:8` 이 `["vite/client"]` 만 둔 것은 의도로 보인다 `[추정]`) |
| 판정 | **기각.** 릴리스 경로를 인질로 잡는다 |

### A-2. 테스트 전용 `tsconfig.test.json` 신설 (독립 프로젝트, references 편입 **안 함**)

```jsonc
// frontend/tsconfig.test.json  — 예시, 이 문서에서는 만들지 않았다
{
  "extends": "./tsconfig.app.json",
  "compilerOptions": {
    "types": ["vite/client", "node"],
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.test.tsbuildinfo"
  },
  "include": ["src", "tests"]
}
```
```jsonc
// frontend/package.json scripts 추가
"typecheck:tests": "tsc -p tsconfig.test.json --noEmit"
```

| | |
|---|---|
| 초기 red | **244 error / 32 file** (`include` 를 tests 전부로 잡을 경우) |
| 비용 | 별도 7.7s. `tsc -b`(4.6s)와 중복 컴파일 → 합계 12.3s |
| 부작용 | **build 경로와 완전히 분리된다.** `tsc -b` 는 여전히 2개 프로젝트만 돈다(§2 실측으로 확인 — `tsconfig.json:3-6` references 에 넣지 않는 한 `-b` 는 이 파일을 보지 않는다) |
| §10.2 관점 | `extends` 로 옵션을 상속하므로 **컴파일러 옵션 중복 0** |
| 판정 | **골격으로 채택.** 단 `include` 를 처음부터 `tests` 전부로 잡으면 244 red 라 게이트로 못 쓴다 → A-6 과 결합 |

### A-3. `tsconfig.test.json` 신설 + `tsconfig.json:3-6` references 에 편입

| | |
|---|---|
| 초기 red | 244 (A-2 와 동일) |
| 장점 | `npm run typecheck` **하나**로 전부 덮인다. 진입점 1개(§10.1) |
| **치명적 부작용** | `npm run build`(`frontend/package.json:9`)가 같은 `tsc -b` 를 쓰므로 **A-1 과 똑같이 릴리스 빌드가 인질이 된다** |
| 회피 | `build` 를 `tsc -p tsconfig.app.json && vite build` 로 바꾸면 분리된다 — 그러나 그 순간 "typecheck 와 build 가 서로 다른 범위" 라는 혼동이 생긴다 |
| 판정 | **S4 기간 중 보류.** 전면 green 달성 후 최종 상태로는 이것이 옳다 `[설계결정]` |

### A-4. CI/스크립트에 별도 `tsc --noEmit` 패스 (설정 파일 없이 파일 인자)

이 문서가 실제로 쓴 방식(§6.1).

| | |
|---|---|
| 초기 red | 244 |
| 장점 | 설정 파일 0 수정. 조사·일회성 측정에 적합 |
| **부작용** | `tsconfig.app.json:2-26` 의 옵션 16개를 **커맨드라인에 복제**한다 → §10.2 위반. `tsconfig.app.json` 을 고치면 조용히 어긋난다 (한쪽만 고쳐지는 전형) |
| 판정 | **조사 도구로만. 게이트로 승격 금지** |

### A-5. 실행을 `--experimental-transform-types` 로 전환

| | |
|---|---|
| 초기 red | **0 — 아무것도 검사하지 않으므로** |
| 근거 | §3.1 실측: 타입 에러 2건 파일을 exit 0 으로 실행 |
| 부작용 | `erasableSyntaxOnly`(`tsconfig.app.json:23`) 로 얻던 유일한 구문 가드마저 무력화. 실측: strip 은 `enum` 을 SyntaxError 로 거부하는데 transform 은 실행한다 |
| 판정 | **기각.** 목적을 하나도 달성하지 못하고 기존 가드를 되레 없앤다 |

### A-6. 점진 allowlist — `tsconfig.test.json` 의 `files` 를 S4 관련만으로 시작

`include` 대신 `files` 배열로 대상을 명시하고, S4 가 건드리는 파일부터 넣는다.

**S4 관련 파일 판정 기준** — `frontend/tests/**` 에서 `ws-protocol` 을 import 하거나 `WsTransportMessage`·`wsCodec`·`WebSocketContext` 를 언급하는 파일 (grep 전수):

| 단계 | 대상 | error | 파일 |
|---|---|---:|---:|
| **A-6a** | `src` + **유닛 S4 관련 9개**<br>`terminalAuthorityProductionWiring`, `terminalCheckpointCapabilityScoping`, `terminalCheckpointRollbackTailWatermark`, `terminalCheckpointRuntime`, `terminalInputSequencer`, `terminalRetainedStateDigest`, `webSocketBackpressure`, `wsCheckpointProtocol`, `terminalContainerRecoveryContract` | **35** | **3** |
| A-6b | A-6a + e2e S4 관련 4개(`terminal-keyboard-regression`, `wave1-characterization-artifacts`, `wave1-split-characterization`, `wave3-terminal-authority-fairness`) | **82** | **8** |
| A-6c | `src` + `tests/unit` 전부 | 64 | 11 |
| A-6d | `src` + `tests` 전부 | 244 | 32 |

**A-6a 의 35건은 단 3개 파일에 몰려 있다:**

```
23  tests/unit/terminalCheckpointRuntime.test.ts          (??  미추적)
 7  tests/unit/terminalCheckpointCapabilityScoping.test.ts (??  미추적)
 5  tests/unit/terminalInputSequencer.test.ts              ( M  수정)
```

나머지 6개(`terminalAuthorityProductionWiring`, `terminalCheckpointRollbackTailWatermark`, `terminalRetainedStateDigest`, `webSocketBackpressure`, `wsCheckpointProtocol`, `terminalContainerRecoveryContract`)는 **이미 green 이다.**

| | |
|---|---|
| 장점 | 게이트를 **즉시 green 으로 만들 수 있는 최소 단위**. 파일을 추가할 때마다 범위가 명시적으로 넓어진다 |
| 부작용 | `files` 배열이 자라면 관리 부담. 새 테스트 파일이 자동으로 포함되지 않는다(빠뜨리기 쉬움) |
| 완화 | 별도 검사 스크립트가 "`tests/**` 중 `files` 에 없는 파일 목록"을 출력하게 하면 누락이 보인다 `[설계결정]` — 다만 이는 도구 신설이므로 S4 전 필수는 아니다 |
| 판정 | **채택** |

### A 비교 정리

| 안 | 초기 red | build 인질 | 설정 중복 | S4 전 착수 가능 | 판정 |
|---|---:|---|---|---|---|
| A-1 include 확장 | 244 | **예 (CI 포함)** | 없음 | ✗ | 기각 |
| A-2 독립 tsconfig.test | 244 | 아니오 | 없음(`extends`) | △ | 골격 채택 |
| A-3 + references | 244 | **예** | 없음 | ✗ | 최종 상태로 보류 |
| A-4 커맨드라인 | 244 | 아니오 | **있음** | △ | 조사 전용 |
| A-5 transform-types | 0(무의미) | 아니오 | — | — | **기각** |
| **A-6 = A-2 + allowlist** | **35** | 아니오 | 없음 | **✓** | **권장** |

---

## B. 권장안과 착수 순서

### B-1 결론

**A-2 의 `frontend/tsconfig.test.json`(`extends: "./tsconfig.app.json"`, `include: ["src"]` + `files:` allowlist) + A-6a 범위로 시작한다.** `tsconfig.json:3-6` references 에는 **넣지 않는다** — build 를 인질로 잡지 않기 위해서다.

**S4 전에 반드시 끝내야 하는 것은 A-6a 의 35건, 3개 파일뿐이다.** 244건 전면 green 은 S4 의 선행 조건이 아니다.

### B-2 순서

| # | 작업 | 검증 |
|---|---|---|
| 1 | `frontend/tsconfig.test.json` 신설 (`extends`, `types: ["vite/client","node"]`, `include: ["src"]`, `files:` 에 S4 관련 유닛 9개) | `npx tsc -p tsconfig.test.json --noEmit` 이 **35 error** 를 낸다 (본 문서 수치와 일치해야 한다. 어긋나면 워킹트리가 변한 것) |
| 2 | `frontend/package.json` 에 `"typecheck:tests": "tsc -p tsconfig.test.json --noEmit"` 추가 | 스크립트 실행 |
| 3 | 3개 파일 35건 해소 (§6.5 (a)(b) 계열이 다수 — **테스트 의미가 바뀌는 수정이므로 각 건마다 "픽스처를 고칠 것인가 구현이 틀린 것인가"를 판정해야 한다**) | `typecheck:tests` **exit 0** |
| 4 | `baseline/typecheck-baseline.md` 기록 (§C) | 문서 |
| 5 | **S4 착수** — `WirePayload` 유니온(`06:645-652`) 도입. 이 시점부터 프론트 픽스처가 컴파일 에러로 드러난다 | S4 의 RED 테스트가 실제로 red 가 되는지 |
| 6 | (S4 중) `files` 에 새로 건드리는 테스트를 추가할 때마다 해당 파일 green 유지 | 매 커밋 `typecheck:tests` |
| 7 | (S4 후) A-6b → A-6c → A-6d 순 확대. 최종적으로 `files` 를 `include: ["src","tests"]` 로 교체 | 244 → 0 |
| 8 | (최종) A-3 으로 승격 — `tsconfig.json` references 에 편입하고 `typecheck:tests` 스크립트 제거 (진입점 1개, §10.1) | `npm run typecheck` 하나로 전부 |

### B-3 3번 단계에서 주의할 것

35건 중 상당수가 **"테스트를 고치면 통과하지만 고쳐서는 안 되는" 부류**일 수 있다. §6.5 (a) 의 `settingsDraftHelpers` 예처럼 **어서션이 공허했던 것**이면 타입을 맞추는 순간 그 테스트가 진짜로 실패할 수 있다. 그것이 정상이다.

> **타입 에러를 없애려고 `as any`·`as unknown as {...}` 로 덮는 것은 금지한다.** 메모리 `unchecked_private_field_casts_go_vacuous` 의 정확한 재현 경로다 — 캐스트로 통과시키면 타입 검사를 켠 의미가 사라지고, 앞으로의 drift 도 같은 캐스트 뒤에 숨는다.

---

## C. 회귀 게이트로의 편입

### C-1 타입 검사는 build 와 독립인가 — **조건부로 그렇다**

`06:2026-2030` 은 이전 판의 *"전환 중 build 가 정상적으로 빨갛다"* 를 정정해 **"핀 파일을 편집한 순간부터 그 단계의 republish 가 끝날 때까지만 빨갛고, 단계 경계에서는 green"** 으로 확정했다. 그 red 의 원인은 **fair-scheduler provenance / evidence-bundle 핀**이지 타입이 아니다.

| 검사 | build 를 타는가 | 근거 |
|---|---|---|
| `cd frontend && npm run typecheck` (`tsc -b`) | **아니오** — `vite build` 도 `prebuild`(`ensure-react-mosaic-patch.cjs`, `frontend/package.json:8`)도 부르지 않는다 | 스크립트 정의(`:12`) |
| `cd frontend && npx tsc -p tsconfig.test.json --noEmit` (권장안) | **아니오** — 같은 이유 + references 미편입 | 설계상 |
| `cd server && npx tsc --noEmit` (`06:2038`) | **아니오** — `npm run build` 의 `prebuild`/`postbuild`(evidence-bundle 재검증)를 건너뛴다 → **P1 핀 게이트 우회** | `06:2038` 이 이미 이 이유로 채택 |
| `npm --prefix server test` / 루트 `test:daemon` / `npx playwright test` / 루트 build 18종 | **예** | CLAUDE.md 테스트 규칙 절 |

**⇒ 타입 검사는 핀 게이트와 직교한다.** 핀 때문에 build 가 빨간 창(window) 안에서도 타입 검사는 green 이어야 하고, green 이 아니면 그것은 순수하게 타입 회귀다. **이 직교성이 타입 검사를 Tier 0 에 넣어도 안전한 이유이자, A-1/A-3 을 지금 기각하는 이유다** — A-1/A-3 은 이 직교성을 파괴한다.

> ⚠️ 단 하나 주의: **A-1/A-3 을 채택하면 위 표의 1행이 "예"로 바뀐다.** 그 순간 타입 검사 red 와 핀 red 가 같은 exit code 에 섞이고, 기준선 §3 이 경고한 "exit code 를 단독 신호로 쓰지 말라" 가 여기에도 적용된다.

### C-2 `06:2042` Tier 0 #7 의 구체화

`06:2042` 는 `npx tsc --noEmit -p <tests 포함 tsconfig>` 를 "신설 권고"로 남겨두었다. 이 문서가 그 `<tests 포함 tsconfig>` 를 확정한다:

```
| 7 | cd frontend && npx tsc -p tsconfig.test.json --noEmit | ... |
```

`06:2036` 의 기존 #1(`npm run typecheck`)은 **그대로 둔다** — 범위가 `src` 로 다르고, 둘 다 도는 것이 맞다(합계 12.3s).

### C-3 `baseline/` 에 추가할 것

`docs/research/binary-comms/baseline/typecheck-baseline.md` (신설 권고, **이 문서에서는 만들지 않았다**). 담을 것:

| 항목 | 값(본 측정) |
|---|---|
| `frontend tsc -p tsconfig.app.json --noEmit` | **0** |
| `frontend tsc -p tsconfig.node.json --noEmit` | **0** |
| `server tsc -p tsconfig.json --noEmit` | **0** |
| `frontend src + tests` (§6.1 커맨드) | **244 / 32 file** |
| 디렉터리별 | unit 63/10, e2e 178/19, support 2/2, benchmarks 1/1 |
| git 귀속 | `??` 166/12, ` M` 45/10, clean 33/10 |
| **파일별 전수표** | §6.3 |

**왜 파일별 전수표가 필요한가**: 기준선 §1 의 원칙 그대로다 — S4 중에 red 가 나왔을 때 *"우리가 깬 것"* 과 *"원래 244 안에 있던 것"* 을 갈라야 한다. 총계만으로는 **한 건이 없어지고 다른 한 건이 생기면 244 그대로**라 회귀를 놓친다. **파일:줄:코드 단위로 동결해야 한다** `[설계결정]`.

⚠️ 기준선 `00-baseline-summary.md:13` 의 경고가 이 수치에도 그대로 적용된다: **미커밋 작업이 커밋되거나 되돌려지면 재측정이 필요하다.** 244 중 211(86%)이 미커밋 파일에서 나오므로 이 기준선은 다른 기준선보다도 **더 빨리 낡는다.**

---

## D. drift 재발 방지 — 타입 검사만으로는 못 잡는다

### D-1 판정

**타입 검사는 필요조건이지 충분조건이 아니다.** 두 `ws-protocol.ts` 가 **각자 내부적으로 일관되면 양쪽 다 컴파일에 성공**한다. 실제로 지금 `frontend tsc -p tsconfig.app.json --noEmit` 도 `server tsc --noEmit` 도 **둘 다 error 0** 인데, 아래 drift 는 실재한다.

### D-2 drift 실측 (2026-08-19, 워킹트리)

```bash
# 내보낸 심볼 이름 집합
grep -o "^export \(interface\|type\|const\|function\) [A-Za-z0-9_]*" \
  {server/src,frontend/src}/types/ws-protocol.ts | awk '{print $3}' | sort -u
```

| | server | frontend |
|---|---:|---:|
| 파일 길이 | 1,206줄 | 1,380줄 |
| `export` 심볼 | **92** | **101** |
| 공통 | **77** | |
| 한쪽에만 | server-only **15** / frontend-only **24** | |

메시지 타입 리터럴(`'xxx:yyy'` 형태):

| | server | frontend |
|---|---:|---:|
| 리터럴 | 44 | 51 |
| 공통 | 44 | |
| **frontend-only** | — | **7** (`'sha256:'` 는 다이제스트 접두사이므로 실질 **6**) |

frontend-only 6종 (전부 `terminal-authority:*`):

```
terminal-authority:compatibility-drained
terminal-authority:legacy-responder-enabled
terminal-authority:responder-disable-boundary
terminal-authority:responder-disabled
terminal-authority:rollback-start
terminal-authority:view-attributes
```

**더 나쁜 사실** — `server/src` **전체**에서 `terminal-authority:*` 리터럴을 전수하면 **17종**이 나오는데(`'terminal-authority:'` 접두사 리터럴 1개 제외), **`server/src/types/ws-protocol.ts` 안의 개수는 `0`** 이다 (`grep -c "terminal-authority:" server/src/types/ws-protocol.ts` → `0`).

| | 종수 |
|---|---:|
| `server/src` 전체가 아는 `terminal-authority:*` | **17** |
| `server/src/types/ws-protocol.ts` 가 **선언**한 것 | **0** |
| `frontend/src` 가 아는 것 | 6 (전부 서버 17종의 부분집합) |
| **프론트에 선언이 아예 없는 서버 메시지** | **11** |

`01:129-133` 이 *"`ServerWsMessage` union 은 wire 의 완전한 목록이 아니다"* 라며 12종을 열거한 것과 방향이 일치한다. 종수 차이(12 vs 17)는 이 문서의 grep 범위(`server/src` 전체 vs `01` 의 서버→클라이언트 한정)가 달라서로 보이나 **대조하지 않았다** `[미확인]`.

**⇒ 진짜 SSOT 는 두 타입 파일 중 어느 쪽도 아니고 `server/src/ws/WsRouter.ts` 의 문자열 리터럴이다.** 타입 파일 두 개는 **둘 다 부분 사본**이다.

### D-3 이미 있는 가드와 그 구멍

저장소에는 이미 크로스 바운더리 텍스트 대조 테스트가 있다 — `frontend/tests/unit/wsCheckpointProtocol.test.ts:182-186`:

```ts
test('frontend and server expose the exact same checkpoint wire declarations', () => {
  const frontend = readFileSync(new URL('../../src/types/ws-protocol.ts', import.meta.url), 'utf8');
  const server   = readFileSync(new URL('../../../server/src/types/ws-protocol.ts', import.meta.url), 'utf8');
  assert.equal(checkpointContract(frontend), checkpointContract(server));
});
```

`checkpointContract()`(`:46-54`)는 `// terminal-checkpoint-contract:start` ~ `:end` 마커 사이만 잘라낸다.

| | 마커 구간 | 파일 길이 | **커버리지** |
|---|---|---:|---:|
| `server/src/types/ws-protocol.ts` | `:13` ~ `:308` (296줄) | 1,206 | **24.5%** |
| `frontend/src/types/ws-protocol.ts` | `:15` ~ `:310` (296줄) | 1,380 | **21.4%** |

**drift 한 6종은 프론트 `:335`, `:346`, `:376`, `:405`, `:409`, `:425` 에 있다 — 마커 종료(`:310`)에서 25줄 뒤부터 시작한다.** 가드가 **딱 그 앞에서 멈춘다.**

두 번째 문제: 이 가드는 **소스 텍스트 동등성**을 요구하므로 **주석 문구 차이만으로 red** 가 된다. 실제로 기준선이 그렇게 기록했다 — `baseline/frontend-baseline.md:48`: *"차이는 `TerminalCheckpointContinuityRecord` 위의 JSDoc 주석 문구 한 블록뿐이다 … 타입 선언 자체는 동일"*. 그리고 CLAUDE.md Rules 는 **주석을 검증 범위에서 제외**한다. **가드가 프로젝트 규칙과 충돌한 채로 red 를 내고 있다.** 마커 구간을 지금 그대로 파일 전체로 넓히면 이 오탐이 4배로 늘어난다.

### D-4 무엇이 필요한가 — 네 층 (§10.2 관점)

§10.2 는 *"같은 책임을 두 곳이 나눠 갖지 않는다 — 이것이 중복 코드보다 나쁘다: 한쪽만 고쳐지고 다른 쪽은 조용히 어긋난다"* 고 못 박는다. **이 파일 쌍이 정확히 그 사례다.**

| 층 | 수단 | 잡는 것 | 비용 | S4 전 |
|---|---|---|---|---|
| **1 (근본)** | **단일 선언원** — 한 파일을 양쪽이 import | 모든 drift. 애초에 두 벌이 없어진다 | 큼(아래) | ✗ |
| 2 | 마커 구간을 **파일 전체로 확대 + 정규화 비교**(주석·공백 제거 후 대조) | 공통 선언의 구조 drift + 누락 | 중 | △ |
| 3 | **심볼/리터럴 집합 대조 테스트** — §D-2 의 grep 을 테스트로 승격, 현재 차이(15/24, 6)를 allowlist 로 **동결**하고 증가 시 red | 새 drift 유입. 기존 drift 는 못 고치지만 **더 벌어지는 것을 막는다** | **작음** | **✓** |
| 4 | **라운드트립 차분 테스트** — 서버 인코딩 → 프론트 디코딩 → 원본 대조 (`01:1197` 이 요구) | **실제 wire 비호환** — 타입이 같아도 인코딩이 갈리면 잡힌다 | 중 | S4 산출물 |

**층 1 의 장애물 (조사 결과):**

- `server/tsconfig.json:7` 이 `"rootDir": "./src"` 다. `src` 밖 파일을 import 하면 `outDir`(`:6` `./dist`) 레이아웃이 깨지고 TS6059 가 난다. **공유 파일을 `server/src` 밖에 둘 수 없다.**
- 반대로 `server/src/types/ws-protocol.ts` 를 SSOT 로 삼고 프론트가 상대 경로로 import 하는 방법은 — 프론트 `moduleResolution: "bundler"`(`tsconfig.app.json:12`) vs 서버 `NodeNext`(`server/tsconfig.json:4-5`), `verbatimModuleSyntax`(양쪽 다 있음), Vite 의 `fs.allow` 등 걸리는 것이 여럿이다. **실제로 되는지 시도하지 않았다** `[미확인]`.
- 깨끗한 안은 루트에 `shared/` 워크스페이스 패키지를 만드는 것이나, `frontend/pnpm-workspace.yaml` 이 이미 있고 서버는 별도 `npm` 트리라 **패키지 매니저가 갈린다.** 비용이 S4 범위를 넘는다 `[추정]`.

**⇒ 판정:**

> **S4 전에는 층 3 만 한다** — 값싸고, 현재 drift 를 "고치지 않고 동결" 하므로 기준선 원칙과도 맞는다.
> **층 4 는 S4 의 산출물로 만든다** — `01:1197` 이 이미 요구했고, `06:2047-2050` 의 "최소한의 최소"(양쪽 `binaryFrameCodec.test.ts` 가 골든 벡터를 공유)가 바로 그 형태다.
> **층 2 는 층 3 이 자리 잡은 뒤** — 정규화 비교로 바꾸지 않고 확대하면 주석 오탐이 늘어 아무도 안 보게 된다(`05:689` 가 경고한 실패 모드와 같다).
> **층 1 은 S4 범위 밖.** 다만 **`ws-protocol.ts` 를 두 벌로 두는 구조 자체가 §10.2 위반이라는 사실은 명시적으로 기록해 둔다** — 층 3·4 는 증상 완화이지 치료가 아니다.

### D-5 곁가지 — 전역 선언 중복도 같은 병이다

§6.5 (c) 의 `grid-equal-mode.spec.ts:64-76` 은 `terminalDebugCapture.ts:122-126` 의 축소 사본이다. **타입 검사를 켜는 것만으로 이것은 잡힌다** (TS2554 48건 + TS2717 2건). 즉:

| 중복 | 타입 검사로 잡히나 |
|---|---|
| tests 안의 `declare global` 사본 vs `src` 정본 | **✅ 잡힌다** — 같은 프로그램에 들어가는 순간 병합 충돌 |
| server `ws-protocol.ts` vs frontend `ws-protocol.ts` | **❌ 못 잡는다** — 서로 다른 프로그램 |

이 구분이 §D 전체의 요지다.

---

## 미확인 · 한계

| # | 항목 | 마커 |
|---|---|---|
| 1 | **HEAD 상태를 측정하지 않았다.** 워킹트리만 쟀다. "clean 33건"은 *테스트 파일이* HEAD 와 같다는 뜻일 뿐, 그 파일이 참조하는 `src/**` 는 미커밋 수정이 섞여 있다 | `[미확인]` |
| 2 | 실제 `tsconfig.test.json` 을 만들지 않았다. 파일 순서·`include` 확장 방식에 따라 수치가 미세하게 달라질 수 있다. 단 `src` 대조 실험(옵션 커맨드라인 이관 → error 0, `tsc -p tsconfig.app.json` 과 동일)으로 **옵션 등가성은 확인**했다 | `[추정]` |
| 3 | Playwright 가 타입 검사를 하지 않는다는 것은 공식 문서로 확인하지 않았다. 정황(180건 에러 상태에서 155 테스트 수집·실행)으로 판정 | `[미확인]` (문서) / `[추정→사실상 확정]` (동작) |
| 4 | Node 공식 문서의 "does not type check" 문구를 직접 열지 않았다. §3 은 전부 실행 결과 | `[미확인]` |
| 5 | `tsc -b` 가 매번 out-of-date 로 판정하는 원인(`composite` 부재 ↔ `tsbuildinfo` 존재)을 규명하지 않았다 | `[추정]` |
| 6 | `01:129-133` 의 "`terminal-authority:*` 12종" 과 이 문서의 "server/src 전체 17종" 의 차이를 대조하지 않았다. grep 범위 차이로 보이나 확인 안 함 | `[미확인]` |
| 7 | 층 1(단일 선언원)의 실현 가능성 — `rootDir` 제약 확인 외에 실제 import 를 시도하지 않았다 | `[미확인]` |
| 8 | 244건 각각이 "픽스처가 틀린 것"인지 "구현이 틀린 것"인지 판정하지 않았다. §6.5 의 세 계열만 표본으로 확인했다 | `[미확인]` |
| 9 | 테스트·빌드·E2E 를 실행하지 않았다(지시된 금지 범위). 2222 서버 무접촉 | — |

---

## 재현 커맨드 전문

```bash
# --- 0. 환경 ---
node --version        # v24.16.0
cd frontend && env -u NODE_ENV npx tsc --version   # 5.9.3

# --- 1. 현행 범위 확인 ---
cd frontend && env -u NODE_ENV npx tsc -b --verbose --dry

# --- 2. 현행 3개 프로젝트 (전부 0 error) ---
cd frontend && env -u NODE_ENV npx tsc -p tsconfig.app.json  --noEmit
cd frontend && env -u NODE_ENV npx tsc -p tsconfig.node.json --noEmit
cd server   && env -u NODE_ENV npx tsc -p tsconfig.json      --noEmit

# --- 3. opts.txt (§6.1 참조) 를 만든 뒤 ---
cd frontend
find src   -type f \( -name '*.ts' -o -name '*.tsx' \) > src-files.txt
find tests -type f \( -name '*.ts' -o -name '*.tsx' \) > test-files.txt

# 옵션 등가성 검증 — 0 이어야 한다
cat opts.txt src-files.txt > args-src.txt
env -u NODE_ENV npx tsc "@args-src.txt"

# 전체 — 244
cat opts.txt src-files.txt test-files.txt > args-all.txt
env -u NODE_ENV npx tsc "@args-all.txt" 2>&1 | grep -c 'error TS'

# 파일별 / 코드별
env -u NODE_ENV npx tsc "@args-all.txt" 2>&1 | grep 'error TS' | sed 's/(.*//'        | sort | uniq -c | sort -rn
env -u NODE_ENV npx tsc "@args-all.txt" 2>&1 | grep -o 'error TS[0-9]*'                | sort | uniq -c | sort -rn

# --- 4. strip vs transform 반증 (§3) ---
node --experimental-strip-types    typeerr.ts   # exit 0, 타입에러 2건 무시
node --experimental-transform-types typeerr.ts  # exit 0, 동일
node                                typeerr.ts  # exit 0, 동일
node --experimental-strip-types    enum.ts      # exit 1, ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX
node --experimental-transform-types enum.ts     # exit 0, 실행됨

# --- 5. drift 실측 (§D-2) ---
cd <repo root>
grep -o "^export \(interface\|type\|const\|function\) [A-Za-z0-9_]*" server/src/types/ws-protocol.ts   | awk '{print $3}' | sort -u > srv.txt
grep -o "^export \(interface\|type\|const\|function\) [A-Za-z0-9_]*" frontend/src/types/ws-protocol.ts | awk '{print $3}' | sort -u > fe.txt
comm -12 srv.txt fe.txt | wc -l   # 77
comm -23 srv.txt fe.txt | wc -l   # 15
comm -13 srv.txt fe.txt | wc -l   # 24

grep -rho "'terminal-authority:[a-z0-9-]*'" server/src   --include=*.ts               | sort -u | wc -l  # 18 (접두사 리터럴 1 포함)
grep -c  "terminal-authority:" server/src/types/ws-protocol.ts                                          # 0
grep -rho "'terminal-authority:[a-z0-9-]*'" frontend/src --include=*.ts --include=*.tsx | sort -u | wc -l # 6
```

> `grep -P` 는 이 환경에서 `-P supports only unibyte and UTF-8 locales` 로 실패한다. 위 커맨드는 전부 BRE/ERE 로만 썼다.
