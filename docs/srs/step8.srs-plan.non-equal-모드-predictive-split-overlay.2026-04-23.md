---
title: non-equal 모드 predictive split overlay
project: ProjectMaster
date: 2026-04-23
type: enhancement
tech_stack: React 19 + TypeScript + Vite 7 + react-mosaic-component 6.1.1
code_path: frontend/src, frontend/patches, frontend/tests/e2e
request_doc: docs/srs/request/2026-04-23.request.srs-plan.non-equal-모드-predictive-split-overlay.md
---

# non-equal 모드 predictive split overlay

---

# Part 1: SRS (무엇을)

## 1.1 목적

`equal`을 제외한 `none/focus/auto` 모드에서 창 드래그 시, 사용자가 실제 split 결과를 미리 예측할 수 있는 predictive split overlay를 제공한다.

## 1.2 배경

현재 `equal`은 full-cell reorder guide를 사용하지만, non-equal은 `react-mosaic` 기본 split target을 그대로 사용한다.  
문제는 앱 오버라이드가 `.mosaic-preview`를 셀 전체처럼 칠해서, 사용자는 “이 셀 전체에 떨어진다”고 느끼기 쉬운 반면 실제 drop은 `left/right/top/bottom` split 이라는 점이다.  
즉 지금의 pain point는 non-equal에서 drag 결과가 안 보이는 것이 아니라, **보이는 것과 실제 의미가 어긋나는 것**이다.

## 1.3 기능 요구사항

- `FR-1`: `none/focus/auto` 모드에서 drag 중 hovered split target이 **실제 split 결과 영역**으로 인식되도록 predictive split overlay를 제공한다.
- `FR-2`: predictive split overlay는 cell 내부 split target뿐 아니라 root edge drop zone에도 적용되어야 한다.
- `FR-3`: `equal` 모드의 full-cell reorder guide와 non-equal predictive split overlay는 시각적으로 명확히 구분되어야 하며, 서로의 selector와 스타일이 충돌하지 않아야 한다.
- `FR-4`: 이번 범위에서 `none/focus/auto`는 기존 split semantics를 유지한다. reorder semantics로 확장하지 않으며, mode별 post-drop invariant를 문서와 테스트로 고정한다.
- `FR-5`: 기존 drag 안정성, right-click/non-primary no-op, equal reorder persistence, move button shell drag source는 회귀되면 안 된다.
- `FR-6`: Option B의 기본 경로는 thin vendor patch가 제공하는 hover metadata를 기반으로 app-owned predictive overlay DOM을 렌더링하는 것이다. CSS-only는 명시적 fallback exit criteria를 충족할 때만 축소안으로 허용한다.

## 1.4 비기능 요구사항

- `NFR-1`: 기본 구현 경로의 vendor patch는 hover metadata 노출에 필요한 최소 범위만 수정해야 한다.
- `NFR-2`: `https://localhost:2002` 기준 Playwright E2E로 hover geometry, root edge 실제 drop commit, persisted tree 또는 최종 DOM geometry, equal 회귀를 함께 검증할 수 있어야 한다.
- `NFR-3`: `grid-equal-mode.spec.ts`에는 `none/focus/auto` 공용 non-equal split-drag helper가 있어야 하며, outside/self/right-click/non-primary edge case까지 자동화해야 한다.

## 1.5 제약사항

- `focus/auto`의 post-drop behavior는 아래 mode contract table로 고정한다.
- 이번 범위의 overlay는 **immediate split result preview**를 의미하며, stabilized layout 자체를 예고하지 않는다.
- `auto`의 timer/status-change 기반 재배치는 drag active 동안 일시 정지하고, drop 또는 cancel 이후에만 재개한다.
- `focus` 재적용은 성공한 primary-button drop commit 이후에만 허용하고, cancel/outside/self/right-click/non-primary에서는 실행되면 안 된다.

## 1.6 Option B 충족 조건

| 항목 | 기본 계약 |
|------|-----------|
| hover metadata source | thin vendor patch가 hovered target의 `kind(root-edge/cell)`, `edge`, `rect`, `target id` 또는 동등한 commit target metadata를 앱으로 전달한다. |
| root/cell 구분 방식 | root edge와 cell split target은 CSS selector 추론이 아니라 명시적 metadata discriminator로 구분한다. |
| overlay DOM ownership | predictive overlay DOM은 app이 렌더링하고 제어한다. non-equal에서는 vendor `.mosaic-preview`를 숨기거나 중립화할 수 있지만, 의미를 설명하는 overlay는 app-owned여야 한다. |
| fallback exit criteria | CSS-only 경로는 `FR-1`, `FR-2`, `FR-5`, `NFR-2`, `NFR-3`를 동일하게 만족하고 root edge 실제 drop commit을 persisted tree 또는 최종 DOM geometry로 검증할 수 있을 때만 허용한다. 하나라도 못 맞추면 thin patch + app-owned overlay 기본 경로를 유지한다. |

## 1.7 모드별 post-drop contract 및 acceptance criteria

### auto status-change deterministic test path

- `TC-NE-5/6`의 기본 재현 경로는 test-only status injection hook `window.__PM_TEST_API__.grid.injectAutoStatusChange(payload)`다.
- `grid-equal-mode.spec.ts`의 공용 helper 이름은 `runNonEqualSplitDragCase`로 고정한다. 이 helper가 `page.evaluate`로 hook을 호출해 drag hold 중 status 전환 요청을 주입하고, drop 또는 cancel 뒤에 다시 호출해 queued transition이 resume되는지 확인한다.
- hook 등록은 dev/test 전용 가드 뒤에서만 수행한다. production build와 수동 검증 경로는 이 namespace를 만들지 않거나, 만들더라도 호출 불가 상태여야 한다.
- namespace 초기화는 `window.__PM_TEST_API__ ??= {}` 후 `window.__PM_TEST_API__.grid ??= {}` 순서의 idempotent 방식으로만 수행하고, 기존 전역 객체를 통째로 덮어쓰지 않는다.
- cleanup 규칙은 `MosaicContainer` unmount와 workspace change 모두에 적용한다. 이 시점에 `injectAutoStatusChange`를 제거하고, `grid` namespace가 비면 함께 정리한다.
- TypeScript에서는 전역 선언 파일의 `declare global { interface Window { __PM_TEST_API__?: ... } }` 또는 동등한 안전한 `window` narrowing을 사용한다. `any` 기반 무제한 확장은 허용하지 않는다.
- 다른 경로(terminal sequence, WS debug hook)는 이번 계획의 기본안이 아니다. 구현과 테스트는 위 hook 경로 하나를 기준으로 맞춘다.

### drag invariant table

| 모드 | drop 직후 raw split 유지 | 후속 트리거 | drag 중 auto timer/status-change | overlay 보장 시점 | FR / AC / Test 매핑 |
|------|--------------------------|------------|----------------------------------|-------------------|---------------------|
| `none` | 유지됨. drop commit 결과와 stabilized layout이 동일해야 한다. | 없음 | 해당 없음 | `immediate = stabilized` | `FR-1`, `FR-2`, `FR-4` / `AC-1` / `TC-NE-1`, `TC-NE-2` |
| `focus` | 유지됨. 먼저 raw split commit을 만든 뒤 기존 focus 규칙이 후속 적용될 수 있다. | 성공한 primary-button drop commit이 drag 종료 후 확정될 때만 focus 재적용. cancel/outside/self/right-click/non-primary에서는 재적용 금지 | 해당 없음 | `immediate`만 보장. stabilized focus layout은 별도 후속 결과 | `FR-1`, `FR-2`, `FR-4`, `FR-5` / `AC-2` / `TC-NE-3`, `TC-NE-4`, `TC-NE-7`, `TC-NE-8` |
| `auto` | 유지됨. drop 직후 raw split commit을 만든 뒤 auto 규칙이 후속 적용될 수 있다. | 없음 | drag active 동안 timer/status-change 기반 재배치는 일시 정지하고 drop/cancel 후 재개. `TC-NE-5/6`은 test-only status injection hook으로 이 pause/resume을 강제한다. | `immediate`만 보장. stabilized auto layout은 재개 후 별도 결과 | `FR-1`, `FR-2`, `FR-4`, `FR-5` / `AC-3` / `TC-NE-5`, `TC-NE-6`, `TC-NE-7`, `TC-NE-8` |

### acceptance criteria

| ID | 기준 | FR / NFR 매핑 | 테스트 매핑 |
|----|------|---------------|-------------|
| `AC-1` | `none`의 cell/root edge overlay rect는 실제 drop commit 결과와 stabilized layout에 모두 일치해야 한다. | `FR-1`, `FR-2`, `FR-4` | `TC-NE-1`, `TC-NE-2` |
| `AC-2` | `focus` overlay는 immediate split result만 예고하며, focus 재적용은 성공한 primary drop commit 이후에만 발생해야 한다. | `FR-1`, `FR-4`, `FR-5` | `TC-NE-3`, `TC-NE-4`, `TC-NE-7`, `TC-NE-8` |
| `AC-3` | `auto`는 drag 중 timer/status-change를 일시 정지해야 하며, overlay는 immediate split result만 예고해야 한다. 이 계약은 `runNonEqualSplitDragCase`가 호출하는 test-only status injection hook으로 `TC-NE-5/6`에서 결정론적으로 검증되어야 한다. | `FR-1`, `FR-4`, `FR-5`, `NFR-3` | `TC-NE-5`, `TC-NE-6`, `TC-NE-7`, `TC-NE-8` |
| `AC-4` | root edge는 screenshot만이 아니라 실제 drop commit 후 persisted tree 또는 최종 DOM geometry로 검증되어야 한다. | `FR-2`, `NFR-2`, `NFR-3` | `TC-NE-2`, `TC-NE-4`, `TC-NE-6` |
| `AC-5` | `outside/self/right-click/non-primary`는 `none/focus/auto` 모두 no-op으로 자동화되어야 한다. | `FR-5`, `NFR-3` | `TC-NE-7`, `TC-NE-8` |
| `AC-6` | `equal` guide와 non-equal overlay는 계속 분리되고, equal 회귀 스위트가 그대로 통과해야 한다. | `FR-3`, `FR-5` | `TC-EQ-1` |

## 1.8 현행 코드 분석

### 영향 범위

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `frontend/src/components/Grid/MosaicContainer.tsx` | 수정 | layout mode class/data attr 주입, hover metadata state 관리, app-owned predictive overlay DOM 렌더링, `auto` pause/resume wiring, dev/test guarded test-only status injection hook 등록/cleanup 추가 |
| `frontend/src/components/Grid/MosaicOverrides.css` | 수정 | app-owned predictive overlay 스타일 정의, non-equal에서 vendor preview 중립화, equal guide selector와 완전 분리 |
| `frontend/tests/e2e/grid-equal-mode.spec.ts` | 수정 | `runNonEqualSplitDragCase` helper, hover rect / root edge commit / persisted tree 또는 최종 DOM geometry / test-only status injection 호출 / equal 회귀 검증 추가 |
| `frontend/patches/react-mosaic-component+6.1.1.patch` | 수정(기본 경로) | hover metadata source, root/cell discriminator, edge/rect 관찰성을 노출하는 thin patch 반영 |

### 재사용 가능 코드

- `react-mosaic-component` 기본 split target geometry
  - [react-mosaic-component.css](../../frontend/node_modules/react-mosaic-component/react-mosaic-component.css)
- `layoutMode` 분기와 `equal` / non-equal gate
  - [MosaicContainer.tsx](../../frontend/src/components/Grid/MosaicContainer.tsx)
- 기존 E2E drag helper와 equal/non-equal baseline 검증
  - [grid-equal-mode.spec.ts](../../frontend/tests/e2e/grid-equal-mode.spec.ts)

### 주의사항

- 현재 `.drop-target-hover .mosaic-preview`를 전역적으로 칠하는 오버라이드는 non-equal 의미를 흐리므로, mode-scoped selector로 쪼개야 한다.
- `.drop-target` selector는 equal/non-equal가 공유되므로, CSS를 넓게 수정하면 `equal` full-cell guide가 바로 회귀할 수 있다.
- root edge target은 `RootDropTargets` 경로라서 cell 내부 타깃과 다른 selector를 가진다. 둘 다 같이 다뤄야 한다.
- CSS-only vendor preview restyle은 root/cell 구분과 commit 결과 검증을 불안정하게 만들 수 있으므로 Option B 기본 경로로 간주하지 않는다.

---

# Part 2: 구현 계획 (어떻게)

## 구현 원칙

- 이번 작업은 `Option B: predictive split overlay`를 수행한다.
- 기본 경로는 `thin vendor patch + app-owned predictive overlay`다. `FR-6`, `NFR-1`
- Option B 충족 조건은 `hover metadata source`, `root/cell explicit discriminator`, `app-owned overlay DOM`, `fallback exit criteria` 네 가지가 모두 문서대로 고정되어야 한다. `FR-6`
- CSS-only restyle은 축소안 또는 fallback이다. 아래 조건을 모두 만족할 때만 허용한다.
  - patch 없이도 root/cell hover metadata를 안정적으로 읽을 수 있음
  - root edge 실제 drop commit을 screenshot이 아니라 persisted tree 또는 최종 DOM geometry로 검증할 수 있음
  - `focus/auto`의 immediate contract와 equal 회귀를 모두 자동화할 수 있음
  - app-owned overlay 기본 경로를 포기해도 `FR-1`, `FR-2`, `FR-5`, `NFR-2`, `NFR-3` 충족 증거를 남길 수 있음

## Phase 1: Scope And Mode Contract Freeze

- [ ] Phase 1-1: `none/focus/auto`의 이번 범위를 “split semantics 유지, reorder 확장 금지”로 문서에 명시한다. `FR-4`
- [ ] Phase 1-2: predictive split overlay의 의미를 “immediate split result preview”로 고정하고, `none/focus/auto` drag invariant 표를 문서에 추가한다. `FR-1`, `FR-4`
- [ ] Phase 1-3: `focus` 재적용 트리거와 `auto` drag 중 timer/status-change pause contract를 문서와 acceptance criteria에 고정한다. `FR-4`, `FR-5`
- [ ] Phase 1-4: Option B 기본 경로의 충족 조건과 CSS-only fallback exit criteria를 명시한다. `FR-6`, `NFR-1`
- [ ] Phase 1-5: equal guide와 non-equal guide의 시각적 의미를 분리하고, equal 회귀 금지를 acceptance criteria로 명시한다. `FR-3`, `FR-5`
- **재사용:** existing `layoutMode` branch in `MosaicContainer.tsx`
- **테스트:**
  - 정상: equal/non-equal 모드별 selector 분기와 mode contract 표가 문서화 완료
  - 예외: non-equal guide를 reorder처럼 표현하는 요구가 계획에 섞이지 않음

## Phase 2: Thin Patch Hover Metadata Baseline

- [ ] Phase 2-1: `react-mosaic-component+6.1.1.patch`에 hovered target metadata(`kind`, `edge`, `rect`, `target id` 또는 동등 정보)를 노출하는 thin patch를 추가한다. `FR-1`, `FR-2`, `FR-6`, `NFR-1`
- [ ] Phase 2-2: root edge와 cell split target은 patch metadata의 explicit discriminator로 구분하고, CSS selector 추론에 의존하지 않는다. `FR-2`, `FR-6`
- [ ] Phase 2-3: drag lifecycle 동안 `auto` timer/status-change 재배치를 pause하고, drop/cancel 뒤에만 resume되도록 wiring한다. `FR-4`, `FR-5`
- [ ] Phase 2-3a: `window.__PM_TEST_API__.grid.injectAutoStatusChange`는 dev/test 전용 가드 뒤에서만 등록한다. namespace는 idempotent하게 초기화하고, `MosaicContainer` unmount 또는 workspace change 시 hook과 빈 namespace를 cleanup한다. TypeScript `Window` 확장은 전역 선언 또는 동등한 안전한 narrowing으로 제한한다. `FR-5`, `NFR-1`, `NFR-3`
- [ ] Phase 2-4: `focus` 재적용은 성공한 primary-button drop commit 후 drag 종료 시점에만 실행되도록 gate를 명시한다. `FR-4`, `FR-5`
- [ ] Phase 2-5: patch는 hover metadata 관찰성만 추가하고 split/reorder semantics 자체는 바꾸지 않는다. `FR-4`, `FR-6`, `NFR-1`
- **재사용:** existing patch-package workflow, vendor `drop-target.left/right/top/bottom` geometry
- **테스트:**
  - 정상: patch metadata만으로 root/cell/edge/rect를 안정적으로 읽을 수 있음
  - 예외: patch가 split semantics, equal reorder behavior를 바꾸지 않음

## Phase 3: App-Owned Predictive Overlay

- [ ] Phase 3-1: `MosaicContainer.tsx`에 root mosaic wrapper 기준 mode-scoped class 또는 data attr를 주입하고, patch metadata를 app state로 승격한다. `FR-3`, `FR-6`
- [ ] Phase 3-2: app-owned predictive overlay DOM을 렌더링하고, non-equal에서는 vendor `.mosaic-preview`를 숨기거나 중립화한다. `FR-1`, `FR-6`
- [ ] Phase 3-3: root edge와 cell overlay를 같은 metadata pipeline으로 그리되, 시각적 표현은 구분 가능하게 만든다. `FR-2`, `FR-3`
- [ ] Phase 3-4: non-equal overlay가 방향을 직관적으로 읽을 수 있도록 border, tint, 필요 시 label을 보강하되, `equal` selector를 덮어쓰지 않도록 격리한다. `FR-1`, `FR-3`, `FR-5`
- [ ] Phase 3-5: overlay는 immediate split result만 보장하고 stabilized focus/auto 결과를 과장해서 보여주지 않는다. `FR-1`, `FR-4`
- **재사용:** existing `layoutMode` branch, current `reorderEnabled` plumbing
- **테스트:**
  - 정상: app-owned overlay가 hovered split target만 강조하고, 셀 전체 full-cell tint처럼 보이지 않음
  - 예외: equal hovered reorder target이 non-equal overlay selector에 오염되지 않음

## Phase 4: CSS-Only Reduced Fallback Gate

- [ ] Phase 4-1: CSS-only 경로는 patch 없이도 `kind/edge/rect` 수준의 hover metadata를 안정적으로 추적할 수 있을 때만 검토한다. `FR-6`, `NFR-1`
- [ ] Phase 4-2: CSS-only fallback도 root edge 실제 drop commit을 persisted tree 또는 최종 DOM geometry로 검증할 수 있어야 한다. screenshot-only면 fallback 불가다. `FR-2`, `NFR-2`, `NFR-3`
- [ ] Phase 4-3: `focus/auto` immediate contract, outside/self/right-click/non-primary no-op, equal 회귀를 자동화로 유지하지 못하면 fallback을 포기한다. `FR-5`, `NFR-2`, `NFR-3`
- [ ] Phase 4-4: fallback exit criteria 중 하나라도 실패하면 thin patch + app-owned overlay 기본 경로를 유지하고, partial CSS-only 구현은 배제한다. `FR-6`
- **재사용:** current CSS selector map only as reduced fallback candidate
- **테스트:**
  - 정상: fallback 허용 여부가 명시적 PASS/FAIL로 판정됨
  - 예외: screenshot만 통과하는 CSS-only path는 채택되지 않음

## Phase 5: E2E And Manual Validation Hardening

- [ ] Phase 5-1: `grid-equal-mode.spec.ts`에 `none/focus/auto` 공용 non-equal split-drag helper를 추가한다. helper는 hover rect 측정, optional drop commit, persisted tree 또는 최종 DOM geometry 읽기까지 담당해야 한다. `NFR-2`, `NFR-3`
- [ ] Phase 5-1a: 공용 helper 이름은 `runNonEqualSplitDragCase`로 고정하고, `page.evaluate(() => window.__PM_TEST_API__.grid.injectAutoStatusChange(...))` 호출 래퍼를 포함한다. `NFR-3`
- [ ] Phase 5-1b: `runNonEqualSplitDragCase`는 hook 존재 여부를 먼저 확인하고, 미등록 환경에서는 테스트를 명시적으로 실패시켜 dev/test guard 누락을 드러낸다. production/manual 검증 경로를 우회 실행하는 fallback은 두지 않는다. `NFR-3`
- [ ] Phase 5-2: `none` 모드에서 cell split target top/left/right/bottom hover rect와 실제 drop commit 결과를 자동화한다. `.reorder-target`은 0개여야 하고, guide rect와 committed geometry가 일치해야 한다. `FR-1`, `FR-4`, `NFR-2`
- [ ] Phase 5-3: `none` 모드에서 root edge guide를 hover screenshot으로만 보지 말고, 실제 root edge drop commit 후 persisted tree 또는 최종 DOM geometry가 예고와 일치하는지 자동화한다. `FR-2`, `NFR-2`, `NFR-3`
- [ ] Phase 5-4: `focus` 모드에서 cell/root edge drop 모두 immediate split result와 commit 결과가 먼저 일치하고, focus 재적용은 성공한 primary drop 이후에만 일어나는지 자동화한다. `FR-1`, `FR-4`, `FR-5`
- [ ] Phase 5-5: `auto` 모드에서 `runNonEqualSplitDragCase`가 drag hold 중 test-only status injection hook을 호출해 status 전환을 주입한다. 이때 layout mutation이 일어나지 않고, drop/cancel 뒤 동일 helper가 후속 hook 호출로 queued transition resume을 확인하도록 자동화한다. `FR-1`, `FR-4`, `FR-5`, `NFR-3`
- [ ] Phase 5-6: outside drop, self-drop, right-click, non-primary pointer edge case를 `none/focus/auto` 각각에 대해 helper 기반으로 no-op 회귀로 고정한다. `FR-5`, `NFR-3`
- [ ] Phase 5-7: 기존 equal 회귀(`TC-6599~6608`)를 그대로 실행하고, equal full-cell guide / move button shell drag source / persistence가 깨지지 않음을 확인한다. `FR-3`, `FR-5`, `NFR-2`
- **재사용:** existing Playwright helper set in `grid-equal-mode.spec.ts`, local validation target `https://localhost:2002`
- **테스트:**
  - 정상: helper 하나로 hover rect, root edge commit, persisted tree 또는 최종 DOM geometry를 모드별 재사용 가능
  - 예외: outside/self/right-click/non-primary pointer는 모든 non-equal 모드에서 no-op 유지

## 단위 테스트 계획

### 테스트 대상

| 대상 | 테스트 유형 | 시나리오 |
|------|------------|----------|
| `react-mosaic-component+6.1.1.patch` hover metadata | DOM/E2E 검증 | 정상: `kind/edge/rect/target id` 또는 동등 정보 노출 / 예외: split semantics 변경 금지 |
| `MosaicContainer` wrapper mode attr + overlay state | DOM/E2E 검증 | 정상: mode별 class/data attr, app-owned overlay DOM, `auto` pause/resume 반영 / 예외: equal과 non-equal 동시 충돌 없음 |
| `MosaicOverrides.css` app-owned overlay selector | Playwright geometry 검증 | 정상: hover rect = split 영역 / 예외: 셀 전체 tint 금지, equal selector 오염 금지 |
| `grid-equal-mode.spec.ts` non-equal split-drag helper | Playwright helper/E2E | 정상: `runNonEqualSplitDragCase`가 hover rect, root edge commit, persisted tree 또는 최종 DOM geometry, auto status injection 호출을 공통화 / 예외: outside/self/right-click/non-primary no-op 유지 |

### 기존 테스트 영향

- 기존 테스트 파일: `frontend/tests/e2e/grid-equal-mode.spec.ts`
- 회귀 위험: 있음
- 추가 필요 테스트: non-equal split-drag helper, hover geometry, root edge actual commit, `focus/auto` post-drop contract, equal guide non-regression

### Playwright 자동화 매트릭스

| 테스트 ID | 모드 | 타깃 | 핵심 assertion |
|-----------|------|------|----------------|
| `TC-NE-1` | `none` | cell split target | hover rect가 예측 split rect와 일치하고, 실제 drop commit 후 최종 geometry도 동일하다. |
| `TC-NE-2` | `none` | root edge | root edge guide가 보이고, 실제 root edge drop commit 후 persisted tree 또는 최종 DOM geometry가 예고와 일치한다. |
| `TC-NE-3` | `focus` | cell split target | hover rect와 immediate commit geometry가 일치하고, focus 재적용은 성공한 primary drop 이후에만 발생한다. |
| `TC-NE-4` | `focus` | root edge | root edge hover/commit이 immediate contract를 유지하고, cancel/no-op에서는 focus 재적용이 없다. |
| `TC-NE-5` | `auto` | cell split target | `runNonEqualSplitDragCase`가 drag hold 중 `window.__PM_TEST_API__.grid.injectAutoStatusChange(...)`를 호출해 status 전환을 주입한다. hover rect와 immediate commit geometry가 일치하고, drag active 동안 layout mutation은 pause되어야 한다. |
| `TC-NE-6` | `auto` | root edge | `runNonEqualSplitDragCase`가 root edge drag 중 같은 hook으로 status 전환을 주입한다. root edge hover/commit은 immediate contract를 유지하고, drop/cancel 뒤 동일 helper가 queued auto 재배치 resume을 검증한다. |
| `TC-NE-7` | `none/focus/auto` | outside/self drop | commit 없음, persisted tree와 최종 geometry 변화 없음 |
| `TC-NE-8` | `none/focus/auto` | right-click / non-primary | no-op 유지, overlay/commit side effect 없음 |
| `TC-EQ-1` | `equal` | reorder baseline | 기존 equal 회귀 스위트가 그대로 통과한다. |

## 검증 기준

- [ ] `frontend` build 성공
- [ ] 기존 `grid-equal-mode.spec.ts` equal 회귀 전부 통과
- [ ] 신규 non-equal split-drag helper 기반 predictive split overlay 회귀 통과
- [ ] root edge guide가 보이지 않는 경우 없음
- [ ] root edge는 screenshot만이 아니라 실제 drop commit 결과로 검증됨
- [ ] non-equal guide가 reorder/full-cell처럼 보이지 않음
- [ ] `focus` 재적용 트리거와 `auto` pause/resume contract가 자동화로 고정됨
- [ ] Option B 기본 경로(`thin vendor patch + app-owned predictive overlay`)가 구현되거나, CSS-only fallback 채택 근거가 exit criteria 기준으로 문서화됨
- [ ] 요구사항 전수 매핑
  - `FR-1` → Phase 1, Phase 2, Phase 3, Phase 5
  - `FR-2` → Phase 1, Phase 2, Phase 3, Phase 4, Phase 5
  - `FR-3` → Phase 1, Phase 3, Phase 5
  - `FR-4` → Phase 1, Phase 2, Phase 3, Phase 5
  - `FR-5` → Phase 1, Phase 2, Phase 3, Phase 4, Phase 5
  - `FR-6` → Phase 1, Phase 2, Phase 3, Phase 4
  - `NFR-1` → Phase 1, Phase 2, Phase 4
  - `NFR-2` → Phase 4, Phase 5
  - `NFR-3` → Phase 4, Phase 5

## 후속 파이프라인

- 다음 단계: `snoworca-plan-driven-coder`
- 입력 인자:
  - PLAN_PATH: `docs/srs/step8.srs-plan.non-equal-모드-predictive-split-overlay.2026-04-23.md`
  - LANGUAGE: TypeScript 5.x
  - FRAMEWORK: React 19 + Vite 7
  - CODE_PATH: `frontend/src`, `frontend/patches`, `frontend/tests/e2e`
