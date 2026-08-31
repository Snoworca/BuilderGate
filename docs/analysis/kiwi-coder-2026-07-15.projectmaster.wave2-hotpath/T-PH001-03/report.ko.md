# T-PH001-03 NO_RENDER paired benchmark RED 계약 보고

- 실행 ID: `2026-07-15.projectmaster.wave2-hotpath`
- 요구사항: `PERF-BGSTAB-009` AC-8, AC-9, AC-10
- 결과: `INTENDED_RED`
- 기준 revision: `ca111fef3b5a5a25d3aa488415c929e90ade46fd`

## 고정한 계약

Wave-1과 동일한 seed `7008`, warm-up `1회`, measurement trial `3회`, calibration target `250ms`를 명시했다. mixed corpus는 정확히 `110 bytes`, control/observation invocation은 `1/1`, boundary corpus는 정확히 `65,542 bytes`, invocation은 `2/2`로 검증한다. 두 corpus 모두 ingress/output digest parity를 확인하고, accepted ingress당 encode 최대 `1회`, 실제 `TextEncoder` 반환 allocation `1회`, prefix-loop encode와 그에 대응하는 temporary allocation counter가 각각 `0`인지 확인한다.

baseline은 revision `ca111f…`의 Wave-1 string scheduler source digest, candidate는 T-PH001-02 segmented byte deque source digest에 고정했다. 테스트가 git baseline과 현재 candidate source를 직접 hash하고 서로 다른 구현인지 확인한다. `250ms`는 baseline의 고정 operation count를 정하는 calibration target이며, 이후 모든 pair는 양쪽에 동일한 `operationsPerTrial`과 동일한 `65,652-byte` workload를 실행한다. raw sample은 양쪽 구현별 행동 계측을 분리한다. 실제 returned-allocation counter에 대해 baseline은 `allocation - accepted ingress = positive prefix count`, candidate는 `allocation = accepted ingress`와 prefix count `0`을 만족해야 한다.

paired benchmark는 동일 프로세스·하드웨어 provenance를 raw sample마다 보존해야 한다. p95 delta는 `512회` paired bootstrap의 95% CI upper bound로 판정하며, 테스트가 raw sample에서 p95와 seeded bootstrap 결과를 독립 재계산한다. 허용치는 baseline p95의 `5%`이고, 이 `5%`는 제품 SLO가 아니라 측정 잡음에 대한 regression tolerance로만 명시했다.

## 의도된 RED 결과

1. `frontend`에서 `node --experimental-strip-types --test tests/benchmarks/terminalNoRenderFixture.test.ts`
   - exit `1`, AC-8/AC-10 두 failure signature
   - Wave-1 exact bytes·digest·invocation·encoder/allocation assertion을 먼저 통과한 뒤 `runPairedTerminalOutputSchedulerBenchmark` 부재 때문에 실패
2. `frontend`에서 `node --experimental-strip-types --test tests/benchmarks/terminalOutputSchedulerBenchmark.test.ts`
   - exit `1`, AC-9 한 failure signature
   - exact manifest assertion을 먼저 통과한 뒤 paired runner 부재 때문에 실패

따라서 현재 RED는 기존 fixture 회귀가 아니라 다음 GREEN Task가 구현해야 할 paired raw sample·bootstrap CI 계약의 부재를 정확히 가리킨다.

## 회귀 및 정적 검사

- scheduler unit: `24/24` 통과
- 변경 대상 4개 benchmark 파일 scoped ESLint: 통과
- 변경 대상 4개 TypeScript 파일 개별 syntax check: 통과
- 기존 NO_RENDER evidence content digest `sha256:c03f1bbd117a0c1a86a83f7945f35428cd9246d76358ecacc9aff0e014dad3b2`: 보존
- 독립 리뷰: `No findings`

상세 기계 판독 증거는 `red-evidence.json`에 기록했다.
