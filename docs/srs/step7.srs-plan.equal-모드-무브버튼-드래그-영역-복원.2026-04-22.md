---
title: equal 모드 무브버튼 드래그 영역 복원
project: ProjectMaster
date: 2026-04-22
type: fix
tech_stack: React 19 + TypeScript + Vite 7 + react-mosaic-component 6.1.1 + react-dnd 16
code_path: frontend/src, frontend/patches
request_doc: docs/srs/request/2026-04-22.request.srs-plan.equal-모드-무브버튼-드래그-영역-복원.md
---

# equal 모드 무브버튼 드래그 영역 복원

---

# Part 1: SRS (무엇을)

## 1.1 목적

equal 모드에서 사용자가 보는 무브 버튼 영역 전체가 실제 drag source로 동작하도록 복원하여, 창 이동 drag가 자연스럽게 시작되게 한다.

## 1.2 배경

현재 equal 모드에서는 vendor의 toolbar-wide drag wrapper가 비활성화되고, app의 custom toolbar에서는 매우 작은 grip 하나만 `connectDragSource`로 연결되어 있다. 게다가 그 grip은 hover 상태가 아니면 `opacity: 0`이며, toolbar host는 `height: 0` 구조를 사용한다.

이 조합 때문에 사용자는 “무브 버튼을 눌렀다”고 느끼지만, 실제로는 drag source가 아닌 주변 chrome이나 내부의 아주 좁은 비-draggable 영역을 누르기 쉬워진다. 그 결과 drag가 시작되지 않는다고 체감한다.

원인 보고서:

- [2026-04-22.move-handle-root-cause-report.md](../report/2026-04-22.move-handle-root-cause-report.md)

## 1.3 기능 요구사항

- **FR-1**: equal 모드에서 무브 버튼은 별도의 전용 button shell로 정의되어야 하며, 사용자가 인지하는 그 **버튼 박스 전체**가 drag source로 동작해야 한다. 이 버튼 박스에는 아이콘 glyph뿐 아니라 padding과 배경 영역이 포함된다.
- **FR-2**: equal 모드에서 mode 버튼(equal/focus/auto)은 기존처럼 클릭 전용이어야 하며 drag source가 되면 안 된다.
- **FR-3**: equal 모드에서 무브 버튼 밖의 toolbar surface는 drag source가 아니어야 한다.
- **FR-4**: 기존 reorder 동작(full-cell guide, move semantics, self-drop no-op, outside-target restore, persistence)은 유지되어야 한다.
- **FR-5**: none/focus/auto 모드의 non-entry 규칙, right-click no-op, non-primary pointer no-op은 유지되어야 한다.

## 1.4 비기능 요구사항

- **NFR-1**: 기존 UI의 시각 스타일은 최소 변경 원칙을 따른다. drag source hit area 조정이 필요하더라도 모드 버튼이나 전체 toolbar 디자인을 임의로 재설계하지 않는다.
- **NFR-2**: vendor patch와 현재 runtime은 clean install + Vite re-optimize 이후에도 동일하게 재현 가능해야 한다.

## 1.5 제약사항

- `react-mosaic-component`는 `patch-package` 기반 vendor patch를 유지 중이다.
- equal 모드에서는 현재 `draggable={layoutMode !== 'equal'}` 와 `reorderEnabled={layoutMode === 'equal'}` 조합을 사용한다.
- toolbar-wide generic drag를 다시 여는 방식은 mode 버튼/빈 영역까지 drag source가 되는 부작용이 있으므로 허용되지 않는다.
- 기존 hover 기반 toolbar 전개 정책은 기본적으로 유지한다. 다만 구현 검증 결과 현재 hover 정책이 무브 버튼 사용성을 다시 막는다면, **무브 버튼 shell 자체의 노출 정책만** 최소 범위에서 조정할 수 있다. mode 버튼이나 전체 toolbar 디자인 재설계는 허용되지 않는다.

## 1.6 현행 코드 분석

### 영향 범위

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `frontend/src/components/Grid/MosaicToolbar.tsx` | 수정 | move button hit area를 실제 drag source와 일치시키는 핵심 파일 |
| `frontend/src/components/Grid/MosaicOverrides.css` | 수정 가능 | zero-height toolbar 구조와 hit area 체감을 보조 조정할 가능성 |
| `frontend/src/components/Grid/MosaicContainer.tsx` | 검토 | equal 모드 draggable / reorderEnabled 경계를 유지하는지 확인 |
| `frontend/patches/react-mosaic-component+6.1.1.patch` | 재생성 가능 | app/vendor 계약이 바뀌면 patch 반영 여부 확인 |
| `frontend/tests/e2e/grid-equal-mode.spec.ts` | 수정 | 실제 move button area에서 drag가 시작되는지 회귀 추가 |

### 재사용 가능 코드

- `MosaicWindowContext.mosaicWindowActions.connectDragSource`
  - 현재 drag source 연결 자체는 이미 존재하며, 재사용해야 한다.
- `data-grid-drag-handle`
  - 기존 테스트와 vendor 연결이 이 속성을 기준으로 동작한다.
- `grid-equal-mode.spec.ts`의 기존 full-cell reorder / negative path 회귀
  - 새 테스트는 이 기반 위에 추가하는 방식으로 간다.

### 주의사항

- 단순히 toolbar 전체를 다시 draggable로 풀면 FR-2, FR-3을 위반할 가능성이 높다.
- 이번 수정의 핵심은 “toolbar 전체 drag 복귀”가 아니라 “move button visible control 전체를 drag source로 확대”하는 것이다.
- “move button 영역 전체”는 `MosaicToolbar`의 전용 move button shell을 의미한다. mode 버튼 패널과 toolbar의 빈 영역은 포함되지 않는다.
- Playwright의 synthetic drag만으로는 사용자의 실제 체감을 모두 대변하지 못하므로, real mouse interaction 관점의 수동 검증도 필요하다.

---

# Part 2: 구현 계획 (어떻게)

## Phase 1: Move Button Drag Source 재정렬

- [x] Phase 1-1: `MosaicToolbar.tsx`에서 현재 `gripDiv`와 실제 사용자가 보는 move button 영역의 불일치를 제거한다. `FR-1`
- [x] Phase 1-2: drag source를 아이콘 내부 SVG가 아니라 “사용자가 move button으로 인식하는 28x28 shell 전체”에 연결한다. `FR-1`
- [x] Phase 1-3: mode 버튼과 구분되는 별도 move button wrapper를 명시적으로 둔다. `FR-2`, `FR-3`
- [x] Phase 1-4: `data-grid-drag-handle`가 계속 명확한 단일 drag source selector 역할을 하도록 유지하거나, 변경 시 테스트 selector를 일관되게 치환한다. `FR-1`, `NFR-2`
- **재사용:** `MosaicWindowContext.mosaicWindowActions.connectDragSource`, 기존 `data-grid-drag-handle` 계약
- **테스트:**
  - 정상: move button의 배경/padding 영역에서 drag start가 된다.
  - 예외: mode 버튼에서는 drag가 시작되지 않는다.

## Phase 2: Toolbar Surface 경계 보존

- [x] Phase 2-1: `MosaicOverrides.css`와 `MosaicToolbar.tsx`를 검토해 zero-height toolbar 구조가 새로운 move button hit area를 방해하지 않는지 조정한다. 필요 시 최소 CSS만 수정한다. `FR-1`, `NFR-1`
- [x] Phase 2-2: toolbar의 빈 영역 또는 mode button panel이 drag source가 되지 않도록 pointer/drag 경계를 유지한다. `FR-2`, `FR-3`
- [x] Phase 2-3: `MosaicContainer.tsx`의 `draggable={layoutMode !== 'equal'}`와 `reorderEnabled={layoutMode === 'equal'}` 조합은 유지하되, 새 move button source가 equal 모드에서도 자연스럽게 작동하는지 확인한다. `FR-4`, `FR-5`
- [x] Phase 2-4: hover 기반 노출 정책을 유지할 경우, hover 후 노출되는 move button shell 전체가 실제 drag source인지 확인한다. 유지가 불가능하면 move button shell만 상시 노출하는 대안을 최소 변경 범위에서 검토한다. `FR-1`, `NFR-1`
- **재사용:** 현재 equal-only reorder gate, existing non-entry rules
- **테스트:**
  - 정상: move button shell의 중심, 가장자리, padding 영역 어디서 잡아도 drag가 시작된다.
  - 예외: toolbar surface outside move button은 여전히 no-op이다.

## Phase 3: 회귀 테스트 및 재현성 고정

- [x] Phase 3-1: `grid-equal-mode.spec.ts`에 “visible move button area 전체에서 drag start 가능” 회귀를 추가한다. `FR-1`
- [x] Phase 3-2: 기존 toolbar surface outside grip/no-op 테스트를 “mode 버튼 및 toolbar 빈 영역 non-draggable”까지 포괄하도록 보강한다. `FR-2`, `FR-3`
- [x] Phase 3-3: 기존 full-cell reorder, self-drop, outside-target restore, persistence, non-equal non-entry 회귀가 깨지지 않는지 재검증한다. `FR-4`, `FR-5`
- [x] Phase 3-4: vendor patch나 optimized deps 사용 구조가 바뀌면 `patch-package`와 Vite 재최적화 절차를 문서화한다. `NFR-2`
- **재사용:** 기존 `grid-equal-mode.spec.ts` 시나리오들
- **테스트:**
  - 정상: real move button shell 중심 drag 시작 후 reorder 완료
  - 정상: move button shell 가장자리/padding drag 시작 후 reorder 완료
  - 예외: mode 버튼 클릭은 drag 없이 모드 전환만 수행
  - 예외: toolbar surface outside move button은 drag 없이 no-op

## 검증 계획

### 테스트 대상

| 대상 | 테스트 유형 | 시나리오 |
|------|------------|----------|
| `grid-equal-mode.spec.ts` | 필수 Playwright E2E 회귀 | 정상: move button area drag / 예외: mode buttons no drag / 예외: toolbar outside area no drag |
| `MosaicToolbar` | 선택적 component-level 상호작용 검증 | move button area = drag source / mode buttons = click only |

### 기존 테스트 영향

- 기존 테스트 파일: `frontend/tests/e2e/grid-equal-mode.spec.ts`
- 회귀 위험: 있음
- 추가 필요 테스트: Playwright E2E 1개 필수, component-level 검증 0~1개 선택

## 검증 기준

- [x] `frontend` build 성공
- [x] 기존 `grid-equal-mode.spec.ts` 회귀 전부 통과
- [x] 신규 “move button area drag” 회귀 통과
- [x] 요구사항 전수 매핑
  - `FR-1` → Phase 1, Phase 3
  - `FR-2` → Phase 1, Phase 2, Phase 3
  - `FR-3` → Phase 2, Phase 3
  - `FR-4` → Phase 2, Phase 3
  - `FR-5` → Phase 2, Phase 3

## 후속 파이프라인

- 다음 단계: `snoworca-plan-driven-coder`
- 입력 인자:
  - PLAN_PATH: `docs/srs/step7.srs-plan.equal-모드-무브버튼-드래그-영역-복원.2026-04-22.md`
  - LANGUAGE: TypeScript 5.x
  - FRAMEWORK: React 19 + Vite 7
  - CODE_PATH: `frontend/src`, `frontend/patches`
