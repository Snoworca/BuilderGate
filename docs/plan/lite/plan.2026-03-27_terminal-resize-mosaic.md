---
title: 터미널 리사이즈 수정 + react-mosaic 도입
project: BuilderGate
date: 2026-03-27
type: enhancement
tech_stack: TypeScript 5.9, React 19, Vite 7, xterm.js 6, @xterm/addon-fit 0.11
code_path: ./frontend/src
---

# 터미널 리사이즈 수정 + react-mosaic 도입

## 1. 의도 및 요구사항

### 1.1 목적
터미널 너비가 컨테이너를 100% 채우지 못하는 버그를 수정하고, CSS Grid 기반 GridContainer를 react-mosaic로 교체하여 스플리터 드래그 리사이즈가 가능한 타일링 터미널을 구현한다.

### 1.2 배경
- 현재 FitAddon.fit()이 레이아웃 완료 전에 호출되어 PTY cols가 실제 컨테이너 너비보다 적게 계산됨 (65~80%만 채움)
- ResizeObserver 콜백에 디바운스가 없어 드래그 리사이즈 시 서버에 초당 120회+ HTTP POST 발생 위험
- 다음 스프린트에서 react-mosaic를 도입하여 tmux/cmux 수준의 패널 리사이즈 경험을 제공할 예정
- 분석 보고서: `docs/analysis/terminal-width-issue.md`

### 1.3 기능 요구사항
- FR-1: FitAddon 초기 fit 타이밍을 이중 `requestAnimationFrame`으로 변경하여 레이아웃 완료 후 측정을 보장한다
- FR-2: flex 체인 전체(`.terminal-view`, `.terminal-container`, TerminalContainer 외부 div)에 `min-width: 0`을 추가한다
- FR-2b: ResizeObserver 감시 대상에 `terminalRef.current`(`.terminal-container`)도 추가하여 FitAddon 측정 대상과 일치시킨다
- FR-3: ResizeObserver 콜백에 rAF 스로틀(fitAddon.fit())과 100ms 디바운스(onResize HTTP POST)를 적용한다
- FR-4: `react-mosaic-component@6.1.1`을 설치하고 CSS Grid 기반 `GridContainer`/`GridCell`을 react-mosaic 기반 `MosaicContainer`로 교체한다. 스플리터 드래그 리사이즈, 패널 최소 크기 제한(10%)을 지원한다.
- FR-5: `TerminalContainer`를 `React.memo`로 감싸고, `TerminalView`에서 중복된 `window.resize` 이벤트 리스너를 제거한다

### 1.4 비기능 요구사항
- NFR-1: 스플리터 드래그 중 터미널 시각적 리사이즈는 60fps 이상을 유지한다 (rAF 스로틀)
- NFR-2: 스플리터 드래그 중 서버 PTY resize HTTP POST는 100ms 디바운스로 초당 최대 10회를 넘지 않는다
- NFR-3: 기존 탭 모드(`viewMode='tab'`) 동작에 영향을 주지 않는다

### 1.5 제약사항
- react-mosaic v6.1.1 사용 (v7은 베타, v6은 이진 트리 구조)
- Blueprint.js는 설치하지 않음 — 커스텀 다크 테마 사용
- react-mosaic의 `<Mosaic>` 부모 컨테이너에 `position: relative` + 명시적 높이 필요
- 모바일에서는 mosaic 비활성 (기존과 동일하게 탭 모드만 사용)
- 기존 `GridLayout` 타입은 서버에도 있으므로 호환성 유지 필요 — 서버 스키마는 변경하지 않고, `GridLayout.cellSizes` 필드에 mosaic 트리를 JSON 직렬화하여 저장/복원한다 (기존 Grid 비율 배열과 호환 불가하므로, 클라이언트가 파싱 시 형태를 감지하여 처리)
- mosaic 모드에서 `TerminalContainer`의 `isVisible`은 항상 `true` 전달 — mosaic이 타일 가시성을 관리하므로 `display: none` 숨김이 불필요

## 2. 현행 코드 분석

### 2.1 영향 범위

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `components/Terminal/TerminalView.tsx` | 수정 | setTimeout→이중rAF, ResizeObserver rAF+디바운스, window.resize 제거 |
| `components/Terminal/TerminalView.css` | 수정 | `.terminal-view`와 `.terminal-container`에 `min-width: 0` 추가 |
| `components/Terminal/TerminalContainer.tsx` | 수정 | 외부 div에 `minWidth: 0` 추가, `React.memo` 적용 |
| `components/Grid/MosaicContainer.tsx` | 신규 | react-mosaic 기반 타일링 컨테이너 (GridContainer 대체) |
| `components/Grid/MosaicWindow.tsx` | 신규 | mosaic 타일 내부 래퍼 (GridCell 역할 — 컬러 바 + MetadataRow + 터미널) |
| `components/Grid/GridContainer.tsx` | 삭제 | react-mosaic로 교체됨 |
| `components/Grid/GridCell.tsx` | 삭제 | MosaicWindow로 교체됨 |
| `components/Grid/index.ts` | 수정 | export 대상을 MosaicContainer로 변경 |
| `App.tsx` | 수정 | GridContainer → MosaicContainer 교체, renderTerminal 콜백 유지 |
| `types/workspace.ts` | 수정 | `MosaicTreeLayout` 타입 추가 + `GridLayout.cellSizes` union 확장: `{ colWidths; rowHeights } \| { mosaicTree: string } \| null` |
| `hooks/useWorkspaceManager.ts` | 수정 | mosaic 트리 상태 관리 (updateGrid → updateMosaicLayout) |
| `package.json` | 수정 | `react-mosaic-component@6.1.1` 추가 |
| `server/` (변경 없음) | — | 서버 스키마 변경 불필요. `cellSizes` 필드에 mosaic 트리를 opaque JSON으로 저장 |

### 2.2 재사용 가능 코드
- `GridCell.tsx`의 내부 구조 (flex column + MetadataRow + DisconnectedOverlay) → `MosaicWindow.tsx`에서 동일 패턴 사용
- `GridContainer.tsx`의 자동 cols/rows 계산 로직 (`ceil(sqrt(n))`) → mosaic 초기 트리 생성 시 활용
- `App.tsx`의 `renderTerminal` 콜백 패턴 → mosaic의 `renderTile`에 직접 매핑
- `useWorkspaceManager.ts`의 gridLayouts 상태 관리 패턴 → mosaic 레이아웃 관리에 재사용

### 2.3 주의사항
- react-mosaic의 부모 컨테이너에 **반드시 `position: relative` + 명시적 `height: 100%`** 필요 (없으면 보이지 않음)
- react-mosaic `onChange`는 ~30fps throttle이 내장되어 있으나, 각 터미널의 ResizeObserver는 독립적으로 발동 → 4개 터미널이면 4배 콜백
- mosaic의 `.mosaic-tile`은 `position: absolute`로 배치됨 → `.terminal-view`의 `flex: 1`이 정상 작동하려면 tile 내부에 `height: 100%` 래퍼 필요
- `GridLayout.cellSizes` (비율 배열)를 mosaic의 `splitPercentage` (0~100 정수)로 변환해야 함
- React 19와 react-mosaic v6.1.1 호환성: peer dep은 "react 16-19"이므로 호환됨
- `EmptyCell.tsx`(빈 셀에 + 버튼)는 mosaic에서는 불필요 → mosaic 자체 split 기능으로 대체

## 3. 구현 계획

## Phase 1: 터미널 리사이즈 버그 수정 (FR-1, FR-2, FR-3, FR-5)

- [x] Phase 1-1: `TerminalView.tsx`에서 `setTimeout(() => { fitAddon.fit(); ... }, 0)`을 이중 `requestAnimationFrame`으로 교체 `FR-1`
  ```typescript
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitAddon.fit();
      onResize(term.cols, term.rows);
      term.focus();
      const bg = term.options.theme?.background || '#1e1e1e';
      document.documentElement.style.setProperty('--terminal-bg', bg);
    });
  });
  ```
- [x] Phase 1-2: `TerminalView.css`에서 `.terminal-view`와 `.terminal-container`에 `min-width: 0` 추가 `FR-2`
- [x] Phase 1-3: `TerminalContainer.tsx` 외부 div에 `minWidth: 0` 인라인 스타일 추가 `FR-2`
- [ ] Phase 1-3b: `TerminalView.tsx`의 ResizeObserver에 `terminalRef.current`도 추가 감시 — FitAddon이 실제 측정하는 `.terminal-container` 요소의 크기 변화를 직접 감지 `FR-2b`
  ```typescript
  resizeObserver.observe(containerRef.current!);
  resizeObserver.observe(terminalRef.current!);  // FitAddon 측정 대상도 감시
  ```
- [x] Phase 1-4: `TerminalView.tsx`의 ResizeObserver 콜백을 rAF 스로틀 + 100ms 디바운스 패턴으로 교체 `FR-3`
  ```typescript
  let rafId: number | null = null;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  const resizeObserver = new ResizeObserver(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      rafId = null;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        onResize(term.cols, term.rows);
        resizeTimer = null;
      }, 100);
    });
  });
  ```
- [x] Phase 1-5: `TerminalView.tsx`에서 `window.addEventListener('resize', handleResize)` 및 관련 cleanup 제거 (ResizeObserver가 이미 모든 크기 변화 감지) `FR-5`
- [x] Phase 1-6: `TerminalContainer.tsx`를 `React.memo`로 감싸기 `FR-5`
  ```typescript
  export const TerminalContainer = React.memo(function TerminalContainer({ ... }: Props) { ... });
  ```
- **테스트:**
  - 정상: Playwright `browser_navigate` → 터미널 열기 → `browser_evaluate`로 `.xterm-screen`의 `clientWidth`가 `.terminal-container`의 `clientWidth - 14`(스크롤바) 이상인지 검증
  - 정상: Playwright `browser_resize({width: 1024})` → 100ms 대기 → `browser_evaluate`로 `term.cols` 재측정하여 이전보다 작아졌는지 확인
  - 예외: `browser_resize({width: 200})` → cols가 2 이상인지 확인
  - 경계값: 탭 모드 ↔ 그리드 모드 전환 후 `browser_evaluate`로 `.xterm-screen.clientWidth`가 `.terminal-container.clientWidth`의 95% 이상인지 검증

## Phase 2: react-mosaic 설치 및 MosaicContainer 구현 (FR-4)

- [ ] Phase 2-1: `npm install react-mosaic-component@6.1.1` 설치 및 `react-mosaic-component/react-mosaic-component.css` import `FR-4`
- [ ] Phase 2-2: `types/workspace.ts`에 `MosaicTreeLayout` 타입 추가 및 `GridLayout.cellSizes` union 확장 `FR-4`
  ```typescript
  import type { MosaicNode } from 'react-mosaic-component';
  export type MosaicTreeLayout = MosaicNode<string> | null;  // string = tab.id

  // cellSizes를 union 타입으로 확장 — 기존 Grid 비율 배열과 mosaic 트리 직렬화 모두 지원
  export interface GridCellSizes { colWidths: number[]; rowHeights: number[]; }
  export interface MosaicCellSizes { mosaicTree: string; }  // JSON.stringify(MosaicNode)
  export interface GridLayout {
    workspaceId: string;
    columns: number;
    rows: number;
    tabOrder: string[];
    cellSizes: GridCellSizes | MosaicCellSizes | null;
  }
  ```
  프론트엔드에서 `cellSizes`가 `MosaicCellSizes`인지 판별: `'mosaicTree' in cellSizes`
- [ ] Phase 2-3: `components/Grid/MosaicWindow.tsx` 신규 생성 — 기존 GridCell 구조 재사용 `FR-4`
  - 컬러 바 (상단 2px border)
  - children (터미널 콘텐츠) — `height: 100%`, `flex: 1`
  - MetadataRow (하단)
  - DisconnectedOverlay (조건부)
  - `renderTerminal(tab)` 호출 시 `isVisible`은 항상 `true` 전달 (mosaic이 가시성 관리)
- [ ] Phase 2-4: `components/Grid/MosaicContainer.tsx` 신규 생성 `FR-4`
  - Props 인터페이스:
    ```typescript
    interface MosaicContainerProps {
      tabs: WorkspaceTabRuntime[];
      gridLayout: GridLayout | undefined;  // cellSizes에서 mosaic 트리 복원
      onAddTab: () => void;
      onRestartTab: (tabId: string) => void;
      onLayoutChange: (layout: Omit<GridLayout, 'workspaceId'>) => void;  // 서버 저장 콜백
      renderTerminal: (tab: WorkspaceTabRuntime) => React.ReactNode;
    }
    ```
  - `<Mosaic<string>>` 래핑, `renderTile(tabId, path)` 콜백으로 MosaicWindow + 터미널 렌더링
  - 초기 트리 자동 생성 알고리즘 (`buildBalancedTree(tabIds: string[])`):
    ```typescript
    // tabIds를 이진 트리로 변환하는 재귀 함수
    // depth를 매개변수로 받아 짝수 depth→row, 홀수 depth→column 교대 배치
    function buildBalancedTree(ids: string[], depth = 0): MosaicNode<string> {
      if (ids.length === 1) return ids[0];          // 리프 노드
      const mid = Math.ceil(ids.length / 2);
      return {
        direction: depth % 2 === 0 ? 'row' : 'column',  // 교대 방향
        first: buildBalancedTree(ids.slice(0, mid), depth + 1),
        second: buildBalancedTree(ids.slice(mid), depth + 1),
        splitPercentage: 50,                         // 균등 분할
      };
    }
    // 예시 결과:
    // 2개: { row, 'A', 'B', 50 }
    // 3개: { row, { column, 'A', 'B', 50 }, 'C', 50 }
    // 4개: { row, { column, 'A', 'B', 50 }, { column, 'C', 'D', 50 }, 50 }
    ```
  - `onChange(newTree)` → 로컬 `mosaicTree` state 업데이트 (시각적 즉시 반영, 서버 저장 안 함)
  - `onRelease(newTree)` → 300ms 디바운스 후 서버에 레이아웃 저장 (`workspaceApi.updateGrid`)
  - `className=""` (Blueprint 테마 비활성화) + 커스텀 다크 테마 CSS
  - 부모 div에 `position: relative; width: 100%; height: 100%`
  - `resize={{ minimumPaneSizePercentage: 10 }}`
- [ ] Phase 2-5: mosaic용 다크 테마 CSS 작성 (`.mosaic-root`, `.mosaic-tile`, `.mosaic-split` 오버라이드) `FR-4`
  - 스플리터 바: `#333` 배경, 호버 시 `#555`, 6px 너비
  - 타일 배경: `var(--terminal-bg, #1e1e1e)`
  - `.mosaic-window` 툴바 숨김 (터미널에는 불필요)
- [ ] Phase 2-6: `components/Grid/index.ts` export를 `MosaicContainer`로 변경, 기존 GridContainer/GridCell 파일 삭제 `FR-4`
- [ ] Phase 2-7: `App.tsx`에서 `GridContainer` → `MosaicContainer` 교체 `FR-4`
  - props 매핑: `tabs`, `onAddTab`, `onRestartTab`, `renderTerminal` 유지
  - mosaic 트리 상태는 MosaicContainer 내부에서 관리 (controlled)
- [ ] Phase 2-8: `useWorkspaceManager.ts` 수정 — mosaic 레이아웃 상태 관리 `FR-4`
  - `gridLayouts` 상태는 기존 타입 유지. `cellSizes` 필드에 mosaic 트리를 JSON 직렬화하여 저장:
    ```typescript
    // 저장 시: MosaicNode → GridLayout.cellSizes에 MosaicCellSizes로 직렬화
    const cellSizes: MosaicCellSizes = { mosaicTree: JSON.stringify(mosaicTree) };
    await workspaceApi.updateGrid(workspaceId, { ...gridLayout, cellSizes });

    // 복원 시: cellSizes 타입 판별 후 역직렬화
    if (gridLayout?.cellSizes && 'mosaicTree' in gridLayout.cellSizes) {
      return JSON.parse(gridLayout.cellSizes.mosaicTree) as MosaicNode<string>;
    }
    return buildBalancedTree(tabIds); // 기존 GridCellSizes 데이터면 새로 생성
    ```
  - `updateGrid` 호출은 `MosaicContainer`의 `onRelease` 콜백에서 300ms 디바운스 후 수행
  - SSE `onGridUpdated` 핸들러에서 수신한 데이터의 `cellSizes.mosaicTree` 필드를 감지하여 mosaic 트리로 역변환
  - 서버 스키마 변경 없음 — `cellSizes`는 JSON 객체로 서버에 opaque하게 저장됨
- **테스트:**
  - 정상: 그리드 모드 전환 → 터미널이 mosaic 타일로 배치되는지 확인
  - 정상: Playwright `browser_evaluate`로 `.mosaic-split`의 `getBoundingClientRect()` 읽기 → `browser_drag`로 스플리터를 100px 이동 → 두 타일의 `.mosaic-tile` width 비율이 변경되었는지 `browser_evaluate`로 확인
  - 정상: 터미널 추가 → mosaic 트리에 새 리프 추가되는지 확인
  - 정상: 터미널 닫기 → mosaic 트리에서 리프 제거되는지 확인
  - 예외: 터미널 1개만 있을 때 → 스플리터 없이 전체 크기로 표시
  - 예외: 모바일에서 → mosaic 대신 탭 모드로 표시
  - 경계값: 최대 8개 터미널 → mosaic 트리가 올바르게 균형 잡히는지 확인 (`buildBalancedTree` 결과의 리프 수 === 탭 수)
  - 경계값: 스플리터를 최소 크기(10%)까지 드래그 → 터미널이 최소 크기 유지
  - 성능: Playwright `browser_evaluate`로 `performance.now()` 기반 스플리터 드래그 중 resize 요청 카운팅 — 서버 `/api/workspaces/:id/grid` 호출이 1초 내 10회 미만

## 4. 검증 기준

- [ ] TypeScript 빌드 성공 (`npx tsc --noEmit` 에러 없음)
- [ ] 기존 테스트 통과 (회귀 없음)
- [ ] 탭 모드: 터미널 가로선이 컨테이너 100% 채움 (FR-1, FR-2 검증)
- [ ] 탭 모드: 브라우저 창 리사이즈 시 터미널 즉시 반응 (FR-3 검증)
- [ ] 그리드(mosaic) 모드: 스플리터 드래그로 터미널 자유 리사이즈 (FR-4 검증)
- [ ] 그리드(mosaic) 모드: 드래그 중 서버 콘솔에 resize 요청이 초당 10회 미만 (NFR-2 검증)
- [ ] 그리드(mosaic) 모드: 터미널 추가/제거 시 트리 자동 재구성 (FR-4 검증)
- [ ] 모바일: 기존 탭 모드 정상 동작 (NFR-3 검증)
- [ ] 요구사항 전수 매핑: FR-1→Phase1-1, FR-2→Phase1-2/1-3, FR-2b→Phase1-3b, FR-3→Phase1-4, FR-4→Phase2-1~2-8, FR-5→Phase1-5/1-6
