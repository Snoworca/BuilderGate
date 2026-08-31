# T-PH001-04 Paired benchmark와 frontend 통합 GREEN 보고

- 실행 ID: `2026-07-15.projectmaster.wave2-hotpath`
- 요구사항: `PERF-BGSTAB-009` AC-7~AC-10
- 결과: `GREEN`
- benchmark artifact: `docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave2-hotpath/scheduler-benchmark.json`

## 구현 결과

Wave-1 revision `ca111f…`의 scheduler source를 `git show`로 읽고 SHA-256을 검증한 뒤, 그 source에서 생성한 고정 executable bytes를 같은 프로세스에서 실제 module로 로드한다. native `TextEncoder`를 캡처한 timing module과 probed `TextEncoder`를 캡처한 instrumentation module을 별도 instance로 만들었다. 따라서 elapsed 구간은 frozen baseline과 current candidate 모두 native/default encoder를 사용하며, encode/allocation counter는 동일 pair·workload·operation count의 untimed companion pass에서만 수집한다.

각 pair는 `65,652 bytes`의 동일 workload와 calibration에서 정한 동일 operation 수를 실행한다. seed `7008`에 따라 baseline-first와 candidate-first를 교대하고, warm-up 1회와 measurement 3회를 보존한다. raw sample은 historical source digest, 실제 frozen executable digest, process/hardware, timing order, native timing output parity, untimed counter pass linkage를 포함한다.

## 최종 benchmark

- operations/trial: `13`
- baseline calibration: `259.0281ms`
- baseline p95: `249.3994ms`
- candidate p95: `3.2250ms`
- paired bootstrap 95% CI upper delta: `-239.4780ms`
- baseline p95의 5% tolerance: `12.46997ms`
- 판정: `PASS`

canonical artifact content digest는 `sha256:1af45c5ae4ccc7fae82680db4ef263b23d4988f2a6870579806632cb7d36899d`, file SHA-256은 `ceef7e8b40415c55e3095f0fe9b7e5280c1f08a82f0480c62a3bc799f44795c8`이다. artifact 기록은 `BUILDERGATE_RECORD_SCHEDULER_BENCHMARK=1` 명시 시에만 PID-scoped 임시 파일을 쓴 뒤 rename하는 방식으로 수행한다. 기본 benchmark 실행은 기존 canonical artifact를 검증하되 수정하지 않는다.

5%는 artifact와 test 모두에서 `measurement-noise-regression-tolerance`, `productSlo=false`로 유지했다.

## exact gate

- mixed corpus: `110 bytes`, invocation `1/1`, digest parity
- boundary corpus: `65,542 bytes`, invocation `2/2`, digest parity
- baseline frozen behavior: prefix-loop encode 및 실제 returned allocation 관측
- candidate: accepted ingress당 encode 최대 1회, prefix-loop encode/allocation 0
- 모든 pair: baseline/candidate operation 수와 workload digest 동일

## 검증

- combined benchmark: `3/3` 통과
- scheduler unit regression: `24/24` 통과
- frontend typecheck: 통과
- benchmark 4개 파일 scoped ESLint: 통과
- artifact 독립 parse/canonical digest/provenance 검사: 통과
- 명시적 record mode atomic temp/rename: 통과
- 이후 기본 combined 실행 artifact SHA-256 before/after 불변: 통과
- scoped `git diff --check`: 통과
- 독립 까칠 리뷰: 두 HIGH finding을 수정한 뒤 최종 `No findings`

전체 `npm run lint`는 이번 Task와 무관한 기존 파일에서 `42 errors / 18 warnings`로 실패했다. 대표 위치는 `MdirPanel.tsx`, `useMosaicLayout.ts`, `useTabManager.ts` 및 기존 E2E/unit test이며, 허용 범위 밖이므로 수정하지 않았다. 이번 Task의 scoped lint는 깨끗하다.
