---
plan_contract: "1.1.0"
plan_id: "plan-20260507-grid-equal-smart-row"
produced_by: "snoworca-micro-plan@1.5"
produced_at: "2026-05-07T00:07:30+09:00"
spec_refs:
  - "docs/srs/buildergate.srs.md"
scope_freeze: true
previous_hash: null
change_log: []
pre_commit_gate:
  - shell: "pwsh"
    cmd: "npm --prefix frontend run build"
    expected_exit: 0
  - shell: "pwsh"
    cmd: "cd frontend; npx eslint src/utils/mosaic.ts tests/unit/mosaicEqualLayout.test.ts tests/e2e/grid-equal-mode.spec.ts"
    expected_exit: 0
  - shell: "pwsh"
    cmd: "node --experimental-strip-types --test frontend/tests/unit/mosaicEqualLayout.test.ts"
    expected_exit: 0
  - shell: "pwsh"
    cmd: "$env:NODE_ENV='development'; Remove-Item Env:BUILDERGATE_WEB_ROOT -ErrorAction SilentlyContinue; Remove-Item Env:BUILDERGATE_DAEMON_START_ID -ErrorAction SilentlyContinue; Remove-Item Env:BUILDERGATE_DAEMON_STATE_GENERATION -ErrorAction SilentlyContinue; cd frontend; npx playwright test tests/e2e/grid-equal-mode.spec.ts --project \"Desktop Chrome\""
    expected_exit: 0
  - shell: "bash"
    cmd: "npm --prefix frontend run build"
    expected_exit: 0
  - shell: "bash"
    cmd: "cd frontend && npx eslint src/utils/mosaic.ts tests/unit/mosaicEqualLayout.test.ts tests/e2e/grid-equal-mode.spec.ts"
    expected_exit: 0
  - shell: "bash"
    cmd: "node --experimental-strip-types --test frontend/tests/unit/mosaicEqualLayout.test.ts"
    expected_exit: 0
  - shell: "bash"
    cmd: "unset BUILDERGATE_WEB_ROOT BUILDERGATE_DAEMON_START_ID BUILDERGATE_DAEMON_STATE_GENERATION; export NODE_ENV=development; cd frontend && npx playwright test tests/e2e/grid-equal-mode.spec.ts --project \"Desktop Chrome\""
    expected_exit: 0
forbidden_patterns:
  - pattern: "적절[히]|필요\\s*시|알아[서]|상황에\\s*맞게|기존\\s*방식대로|어떻게[든]"
    flags: ""
  - pattern: "rm\\s+-rf|Remove-Item\\s+.*-Recurse|git\\s+reset\\s+--hard|git\\s+checkout\\s+--"
    flags: "i"
platforms:
  - "win32"
  - "posix"
requires_human_approval: false
x-snoworca-code-path: "."
---

# Grid Equal Smart Row Micro Plan

## 1. 목적

`FR-GRID-014`, `FR-GRID-015`, `AC-007`의 새 규칙을 구현한다. Equal mode에서 4개 이상 tab을 배치할 때 가로형 화면의 단일 행 후보와 격자 baseline을 비교하고, 단일 행 pane 폭이 baseline 격자 pane 높이보다 큰 경우 단일 행을 선택한다.

## 2. 현재 동작

- `frontend/src/utils/mosaic.ts`의 `selectEqualGridSpec()`은 4~8개 tab에서 research baseline grid를 우선 선택한다.
- `buildEqualMosaicTree()`는 `spec.bandCounts.length === 1`이면 이미 linear tree를 만들 수 있으므로, 단일 행 후보는 `EqualGridSpec` 선택 단계에서 표현 가능하다.
- `frontend/tests/unit/mosaicEqualLayout.test.ts`와 `frontend/tests/e2e/grid-equal-mode.spec.ts`는 4~8개 wide 화면이 항상 격자 baseline이라고 가정한다.

## 3. 수정 상세

### M-1: wide 단일 행 후보 선택 규칙 추가

대상: `frontend/src/utils/mosaic.ts`

변경 내용:

- `selectEqualGridSpec()`에서 `tabCount >= 4`, `screenArrangement === 'rows'`, measured `width > height`, research baseline이 있는 경우 단일 행 후보를 평가한다.
- 계산식:
  - `singleRowPaneWidth = width / tabCount`
  - `baselineGridPaneHeight = height / baseline.rows`
- `singleRowPaneWidth > baselineGridPaneHeight`이면 `createEqualGridSpec(tabCount, tabCount, 1, 'rows')`를 반환한다.
- `singleRowPaneWidth <= baselineGridPaneHeight`, baseline 부재, container 치수 부재, 정사각형, 세로형 화면에서는 기존 격자 후보 경로를 유지한다.
- `tabCount > 8`의 기존 scoring fallback은 scope 밖으로 두고, workspace cap 8 기준의 4~8 baseline 동작만 바꾼다.

주의:

- `createEqualGridSpec()`은 `rows=1`일 때 `bandCounts=[tabCount]`를 반환할 수 있어야 한다.
- `buildEqualMosaicTree()`의 linear tree fallback을 재사용한다.
- leaf order는 기존 `ids` 순서를 보존한다.

### M-2: unit test 갱신

대상: `frontend/tests/unit/mosaicEqualLayout.test.ts`

변경 내용:

- 표준 wide viewport 예시는 격자 baseline을 유지하는 케이스로 명시한다.
- ultrawide 또는 낮은 높이의 가로형 metrics를 추가해 4개 이상 단일 행 선택을 검증한다.
- 동률 경계는 격자 baseline을 선택해야 한다.
- tall metrics와 square metrics는 4개 이상 단일 행 후보를 선택하지 않아야 한다.
- leaf order와 `isFixedEqualMosaicTree()` 검증은 단일 행 후보까지 포함한다.

필수 케이스:

- `1280x720`, 4개: `2x2` 유지 (`1280 / 4 <= 720 / 2`)
- `2000x600`, 4개: single row (`2000 / 4 > 600 / 2`)
- `1500x600`, 5개: grid 유지 또는 동률 경계 (`1500 / 5 == 600 / 2`)
- tall 5개: `2x3` baseline 유지

### M-3: E2E 기대값 갱신

대상: `frontend/tests/e2e/grid-equal-mode.spec.ts`

변경 내용:

- 기존 wide 4~8 baseline E2E는 `1280x720` 같은 표준 wide 화면에서 baseline 유지 검증으로 둔다.
- 새 E2E를 추가해 ultrawide 가로형 화면에서 4개 tab이 single row로 배치되는지 검증한다.
- 새 E2E는 실제 production path를 유지한다: workspace 1개 tab 생성, API로 tab 추가, `openGridWorkspace()` reload 경로, `.mosaic-tile` rect 측정.
- tall 4~8 E2E는 baseline 유지 회귀로 둔다.

필수 검증:

- tile count가 target tab 수와 같다.
- 4개 ultrawide 케이스에서 모든 tile의 `y` 좌표가 같은 row로 묶인다.
- persisted leaf order가 생성된 tab id를 모두 포함한다.

## 4. 위험과 완화

- 위험: ultrawide E2E viewport가 실제 container 기준으로 조건식을 만족하지 않을 수 있다.
  - 완화: E2E 내부에서 viewport를 충분히 넓고 낮게 설정하고, 실패 시 rect snapshot으로 조건식을 확인한다.
- 위험: 기존 wide baseline E2E 기대값과 새 smart row 규칙이 충돌할 수 있다.
  - 완화: 표준 wide viewport는 `singleRowPaneWidth <= baselineGridPaneHeight`가 되도록 유지한다.
- 위험: React Mosaic reorder 테스트가 single-row tree를 다른 arrangement로 추론할 수 있다.
  - 완화: `inferEqualLayoutArrangement()`와 `isFixedEqualMosaicTree()` unit test에 single-row 4개 케이스를 추가한다.

## 5. 검증 기준

- `npm --prefix frontend run build`
- `cd frontend; npx eslint src/utils/mosaic.ts tests/unit/mosaicEqualLayout.test.ts tests/e2e/grid-equal-mode.spec.ts`
- `node --experimental-strip-types --test frontend/tests/unit/mosaicEqualLayout.test.ts`
- `$env:NODE_ENV='development'; Remove-Item Env:BUILDERGATE_WEB_ROOT -ErrorAction SilentlyContinue; Remove-Item Env:BUILDERGATE_DAEMON_START_ID -ErrorAction SilentlyContinue; Remove-Item Env:BUILDERGATE_DAEMON_STATE_GENERATION -ErrorAction SilentlyContinue; cd frontend; npx playwright test tests/e2e/grid-equal-mode.spec.ts --project "Desktop Chrome"`

## 6. 완료 조건

- `FR-GRID-014`, `FR-GRID-015`의 새 단일 행 후보 규칙이 unit test 이름 또는 assertion 메시지로 추적된다.
- 4개 ultrawide Equal mode E2E가 single row를 검증한다.
- 표준 wide, tall baseline E2E가 계속 통과한다.
- Grid Equal reorder/repair 회귀 테스트가 같은 spec에서 통과한다.

## 7. 평가 메모

- 서브에이전트 평가는 이 세션의 delegation 제한 때문에 수행하지 않았다.
- 계획상 Medium 이상 미해결 위험은 없다.
- 기존 repo-wide `npm --prefix frontend run lint` 실패는 이 micro scope 밖의 기존 lint debt로 유지한다.
