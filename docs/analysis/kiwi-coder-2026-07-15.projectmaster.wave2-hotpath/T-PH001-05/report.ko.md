# T-PH001-05 review-fix 보고

- 실행 ID: `2026-07-15.projectmaster.wave2-hotpath`
- 요구사항: `PERF-BGSTAB-009` AC-1~AC-10
- 결과: `PASS`
- production 변경: 없음
- 강화한 테스트: `frontend/tests/unit/terminalOutputScheduler.test.ts`

## finding 해결 결과

### AC-2 실제 xterm parser 동등성

ANSI SGR·CSI·OSC, CR/LF, 한글, combining character, emoji를 여러 `enqueue()` 호출에 걸쳐 의도적으로 분할했다. scheduler의 flush budget도 3 bytes로 두어 escape sequence가 write 경계에서 다시 나뉘도록 했다.

DOM에 `open()`하지 않은 실제 `@xterm/xterm` `Terminal` 두 개에 다음 입력을 각각 순차 write했다.

1. control: 모든 ingress를 합친 단일 문자열
2. observation: scheduler가 내보낸 모든 `Uint8Array` slice

최종 buffer 전체 line과 wrapped 상태, 각 cell의 chars/width/code, fg/bg color mode와 값, bold/italic/dim/underline/blink/inverse/invisible/strikethrough/overline flag, `cursorX`, `cursorY`, `baseY`, `viewportY`, buffer length를 비교했고 완전히 동일했다. `onTitleChange` event sequence와 final title도 양쪽에서 캡처해 `split-title` 보존을 확인했다. 기존 byte parity 검사도 유지했다.

### AC-4 성공적인 bounded leaf compaction

`maxChunks=2`, flush budget `4B`, queue budget `8B`에서 `2B + 2B + 1B`를 enqueue하여 overflow가 아닌 성공 compaction을 강제했다.

- 앞의 두 leaf가 `4B` backing allocation 하나로 합쳐짐
- write slice와 backing allocation 모두 flush budget `4B` 이하
- pending bytes는 모든 관측점에서 queue budget `8B` 이하
- merged write가 완료되기 전 callback 0회
- 완료 후 첫째·둘째 callback이 ingress 순서로 정확히 1회
- 나머지 write 완료 후 셋째 callback이 정확히 1회
- 최종 pending `0`, idle

강화 테스트가 현 production 구현에서 통과했으므로 production 결함은 재현되지 않았고 코드 변경은 하지 않았다.

첫 xterm 실행의 `23/24` 실패는 Node ESM이 CommonJS package를 `default` 아래 노출하여 생긴 test harness 오류였다. named/default wrapper를 모두 처리하도록 고친 뒤 `24/24`가 통과했다. scheduler 결함으로 분류하지 않는다.

### canonical benchmark artifact 불변성

기본 benchmark test는 timestamp/PID가 포함된 ephemeral result만 검증하고 디스크 artifact를 쓰지 않는다. 이미 기록된 artifact의 canonical digest, source manifest, exact gate를 검증한 뒤 실행 전후 bytes가 동일한지 assertion한다.

artifact 갱신은 `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1`을 명시한 경우에만 수행한다. 이때 PID-scoped temporary file에 UTF-8 JSON을 완성한 뒤 rename하여 canonical path를 교체한다. record mode를 한 번 실행해 다음 값으로 고정했다.

- content digest: `sha256:1af45c5ae4ccc7fae82680db4ef263b23d4988f2a6870579806632cb7d36899d`
- file SHA-256: `ceef7e8b40415c55e3095f0fe9b7e5280c1f08a82f0480c62a3bc799f44795c8`
- run ID: `terminal-output-scheduler-154200-7008-13`

그 뒤 기본 combined `27/27` 실행 전후 file SHA-256이 위 값으로 동일함을 외부 검사와 test 내부 byte equality로 확인했다.

## trace 정정 전달 사항

요청에 따라 plan/sidecar/PM/SRS는 수정하지 않았다. 현재 실제 symbol을 유지하며 루트가 trace amendment를 담당한다.

- T3 AC-8 실제 경로/symbol: `frontend/tests/benchmarks/terminalNoRenderFixture.test.ts` / `NO_RENDER paired benchmark RED 계약 — AC-8`
- T3 AC-9 실제 경로/symbol: `frontend/tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts` / `NO_RENDER paired benchmark RED 계약 — AC-9`
- GREEN 이름으로 억지 rename하지 않고 T2/T4도 현재 실제 `UTF-8 segmented queue RED 계약 — AC-*`, `NO_RENDER paired benchmark RED 계약 — AC-*` symbol에 맞춰야 한다.
- plan의 full-lint DoD와 기존 repository lint baseline은 충돌한다. amendment가 필요하면 루트가 처리한다.

## 검증

- focused scheduler unit: `24/24` 통과
- combined unit + benchmark: `27/27` 통과
- 명시적 artifact record mode: `1/1` 통과, temp/rename 교체
- 이후 기본 combined 실행 artifact byte/file SHA-256 불변: 통과
- frontend typecheck: 통과
- scheduler/benchmark scoped ESLint: 통과
- scoped `git diff --check`: 통과

전체 `npm run lint`는 기존 범위 밖 부채 `42 errors / 18 warnings`로 실패했다. 이 수치는 T-PH001-04와 동일한 baseline이며 이번 review-fix에서 건드리지 않았다.

동일 PH1 reviewer의 최종 독립 재리뷰 판정은 정확히 `No findings`이다.
