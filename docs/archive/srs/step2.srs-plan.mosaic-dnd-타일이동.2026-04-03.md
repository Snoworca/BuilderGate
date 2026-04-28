---
document_id: SRS-PLAN-MOSAIC-DND-001
title: "Mosaic DnD 타일 이동 — SRS + 구현 계획"
created: 2026-04-03
version: 1.0
status: Draft
related_prd: PRD-MOSAIC-001 v1.2 Final
related_srs: SRS-MOSAIC-001 v1.2 Final
scope: "FR-1.2(DnD 타일 이동) + FR-2(모바일 viewMode reset) + FR-3(복사 disabled)"
---

# Mosaic DnD 타일 이동 — SRS + 구현 계획

---

## Part 1: SRS

---

### 1.1 목적

React Mosaic v6.1.1이 제공하는 `MosaicWindow` + react-dnd 기반 드래그 앤 드롭(DnD) 타일 이동 기능을 BuilderGate 그리드 뷰에 활성화한다.

현재 `MosaicContainer`는 `<Mosaic>` 컴포넌트를 사용하면서도 `renderTile`에서 `MosaicWindow`를 래핑하지 않아 DnD가 동작하지 않는다(PRD FR-1.2 P0 미구현 상태). 본 SRS는 `MosaicWindow` 도입에 필요한 최소 변경 범위와 요구사항을 정의하고, 함께 처리할 두 가지 부수 결함(모바일 viewMode reset, 복사 메뉴 disabled)을 포함한다.

---

### 1.2 배경

#### PRD 참조

PRD-MOSAIC-001 §FR-1.2(P0): "사용자는 타일을 드래그하여 다른 위치로 이동할 수 있다."

SRS-MOSAIC-001 §FR-1.1에서 `MosaicContainer`는 `<Mosaic renderTile={...}>`를 사용하도록 명세되었으나, `renderTile` 내부에서 `MosaicWindow`로 래핑하는 코드가 구현에서 누락되었다.

#### Implementation Review 결과

코드 분석으로 식별된 구현 간극:

| 항목 | 현재 상태 | 필요 상태 |
|------|-----------|-----------|
| `MosaicWindow` 래핑 | 없음 — `MosaicTile`을 직접 반환 | `renderTile`에서 `MosaicWindow`로 래핑 필수 |
| DnD Provider | `<Mosaic>`이 내부 제공 | 외부 `DndProvider` 추가 금지 |
| 드래그 그립 | 없음 | `MosaicWindowContext.connectDragSource`로 연결된 아이콘 필요 |
| 툴바 교체 | `MosaicWindow.renderToolbar` 미사용 | `renderToolbar`로 기존 `MosaicToolbar` 대체 |
| CSS 레이아웃 충돌 | `.mosaic-window-body` 미오버라이드 | flex 레이아웃 유지를 위한 CSS 오버라이드 필요 |
| 모바일 viewMode | 그리드 모드 유지 가능 | 모바일 전환 시 'tab'으로 자동 reset |
| 복사 메뉴 | 항상 활성화 | 선택 텍스트 없을 때 disabled |

---

### 1.3 기능 요구사항

#### FR-1: DnD 타일 이동

**FR-1.1 MosaicWindow 래핑**

- `renderTile(tabId: string, path: MosaicBranch[])` 시그니처로 변경한다. (`path` 인자는 Mosaic v6이 콜백에 주입한다.)
- `renderTile` 내부에서 `<MosaicWindow path={path} renderToolbar={...}>` 로 `MosaicTile`을 감싼다.
- `MosaicWindow`의 `title` prop에는 `tabId`를 전달한다(기본 제목, 표시 불필요).
- `MosaicWindow`가 기본 제공하는 툴바는 `renderToolbar`로 완전히 교체하여 숨긴다.

**FR-1.2 그립 아이콘 + connectDragSource**

- `MosaicToolbar`에 드래그 그립 아이콘(⠿)을 추가한다.
- 그립 아이콘 `<div>`는 `MosaicWindowContext`의 `connectDragSource`에 연결한다.
- 그립 아이콘 이외의 UI 요소에는 `connectDragSource`를 적용하지 않는다.
- 그립 아이콘은 항상 표시(호버 불필요)하거나 기존 `⋯` 트리거 영역과 동일한 hover 정책을 따른다. (구현 Phase 1-2에서 결정)

**FR-1.3 DnD Provider 이중 래핑 금지**

- `<Mosaic>` 컴포넌트는 내부적으로 `DndProvider(react-dnd-html5-backend)`를 제공한다.
- 상위 컴포넌트(`MosaicContainer`, `App.tsx`)에 별도 `DndProvider`를 추가하지 않는다.
- 기존 코드에 `DndProvider`가 없음을 확인하고 유지한다.

**FR-1.4 기존 기능 정상 동작 유지**

DnD 도입 후에도 다음 기능이 정상 동작해야 한다:

| 기능 | 검증 항목 |
|------|-----------|
| 포커스 모드 | 타일 이동 후 포커스 모드 전환 시 올바른 타일 확대 |
| 균등 모드 | 타일 이동 후 균등 모드 전환 시 전체 균등 분할 |
| 오토 모드 | 타일 이동 후 idle/running 상태 기반 비율 자동 조정 |
| 크기 조절(splitPercentage) | 드래그 분할선으로 크기 조절 후 저장 정상 동작 |
| 컨텍스트 메뉴 | 타일 이동 후 우클릭 컨텍스트 메뉴 정상 표시 |

#### FR-2: 모바일 viewMode Reset

- `isMobile === true`이고 `activeWorkspace.viewMode === 'grid'`인 경우, 자동으로 `'tab'`으로 변경한다.
- 변경 시점: 해당 조건이 처음 참이 되는 렌더 사이클의 `useEffect` 콜백 내.
- 조건이 해제(데스크톱으로 전환)되어도 자동으로 `'grid'`로 되돌리지 않는다.

#### FR-3: 복사 메뉴 Disabled

- 컨텍스트 메뉴의 '복사' 항목은 `window.getSelection()?.toString()`이 빈 문자열일 때 `disabled: true`를 반환한다.
- `disabled` 상태의 메뉴 항목은 클릭 시 아무 동작도 하지 않는다(기존 `ContextMenu` 컴포넌트의 `disabled` 처리 의존).

---

### 1.4 비기능 요구사항

| ID | 항목 | 요건 |
|----|------|------|
| NFR-1 | 드래그 프레임레이트 | 타일 드래그 중 50fps 이상 유지 (Chrome DevTools Performance 기준) |
| NFR-2 | 드롭 오버레이 시각 피드백 | 드롭 가능 영역 진입 시 100ms 이내 하이라이트 표시 |
| NFR-3 | 타일 이동 후 렌더 | 드롭 완료 후 200ms 이내 레이아웃 재렌더 완료 |
| NFR-4 | 번들 크기 | 추가 패키지 없음 — react-dnd는 react-mosaic-component 의존성으로 이미 포함 |

---

### 1.5 제약사항

| 제약 | 내용 |
|------|------|
| React Mosaic 버전 | v6.1.1 고정. `MosaicWindow`, `MosaicWindowContext`의 API는 해당 버전 기준 |
| `MosaicWindow` 필수 | DnD 기능은 `MosaicWindow` 없이 활성화 불가. 우회 구현(커스텀 DnD 레이어) 금지 |
| `DndProvider` 이중 래핑 금지 | `<Mosaic>` 내부 Provider와 충돌하여 런타임 오류 발생 |
| `MosaicWindow` 기본 툴바 | `renderToolbar` prop으로 반드시 교체. 기본 툴바는 기존 `MosaicToolbar`와 시각 충돌 |
| `.mosaic-window-body` CSS | `MosaicWindow`가 삽입하는 `.mosaic-window-body` div가 flex 레이아웃을 깨뜨림 → CSS 오버라이드 필수 |
| 모바일 DnD | HTML5 Drag-and-Drop API는 터치 미지원. 모바일에서 타일 이동은 FR-2 reset으로 그리드 자체가 비활성화되므로 별도 처리 불필요 |

---

### 1.6 현행 코드 분석

#### 영향 범위 테이블

| 파일 | 변경 유형 | 영향 범위 |
|------|-----------|-----------|
| `frontend/src/components/Grid/MosaicContainer.tsx` | 수정 | `renderTile` 시그니처 변경, `MosaicWindow` import 추가, 복사 `disabled` 로직 추가 |
| `frontend/src/components/Grid/MosaicTile.tsx` | 수정 | `MosaicWindow` children으로 구조 재배치, `grid-cell` 클래스 유지 확인 |
| `frontend/src/components/Grid/MosaicToolbar.tsx` | 수정 | 그립 아이콘(⠿) 추가, `MosaicWindowContext` import 및 `connectDragSource` 연결 |
| `frontend/src/components/Grid/MosaicOverrides.css` | 수정 | `.mosaic-window`, `.mosaic-window-body`, 드롭 오버레이 CSS 추가 |
| `frontend/src/App.tsx` | 수정 | 모바일 viewMode reset `useEffect` 추가 |

#### 재사용 코드 (변경 없음)

| 코드 | 재사용 이유 |
|------|-------------|
| `useMosaicLayout`, `useLayoutMode`, `useFocusHistory` | DnD는 `MosaicNode` 트리 변경을 `onChange`로 전달 → 기존 훅 그대로 처리 |
| `handleMosaicChange` 콜백 | DnD 이동 후 Mosaic이 `onChange`를 호출하므로 별도 핸들러 불필요 |
| `buildTerminalContextMenuItems` | `disabled` 필드 추가만 필요, 구조 변경 없음 |
| `mosaic` 유틸 함수들 | `applyEqualMode`, `applyFocusMode` 등 트리 조작 함수 영향 없음 |

#### 주의사항

1. **`renderToolbar` 반환값 전체가 `connectDragSource`로 감싸지는 문제**: `MosaicWindow`의 기본 동작은 `renderToolbar` 결과 전체를 드래그 소스로 등록한다. 기존 버튼(균등/포커스/오토)을 클릭할 때 드래그가 시작되는 부작용이 발생할 수 있다. 그립 아이콘 `<div>`에만 `connectDragSource`를 명시적으로 호출하고, 나머지 버튼 영역에는 `draggable={false}`를 부여한다.

2. **`.mosaic-window-body` 레이아웃 충돌**: `MosaicWindow` 래핑 시 DOM 구조가 `grid-cell → .mosaic-window → .mosaic-window-body → MosaicTile 내용`으로 변경된다. `.mosaic-window-body`의 기본 스타일이 `overflow: auto`, `flex-direction`이 미정의이면 터미널이 올바르게 늘어나지 않는다. `overflow: hidden`, `flex: 1`, `flex-direction: column`, `min-height: 0` CSS 오버라이드가 필요하다.

3. **`path` 인자 타입**: Mosaic v6의 `renderTile` 콜백 시그니처는 `(tabId: string, path: MosaicBranch[]) => React.ReactNode`이다. `path`를 `MosaicWindow`에 그대로 전달해야 DnD와 크기 조절이 올바르게 동작한다.

---

## Part 2: 구현 계획

---

### Phase 1: MosaicWindow 래핑 + DnD 기반 인프라 (FR-1)

#### Phase 1-1: renderTile에 path 인자 추가 + MosaicWindow 래핑

**대상 파일**: `frontend/src/components/Grid/MosaicContainer.tsx`

**변경 내용**:

1. `react-mosaic-component`에서 `MosaicWindow`, `MosaicBranch` import 추가.

2. `renderTile` 콜백 시그니처를 `(tabId: string, path: MosaicBranch[]) => React.ReactNode`로 변경.

3. `renderTile` 내부에서 `MosaicTile`을 `MosaicWindow`로 래핑:

```tsx
const renderTile = useCallback(
  (tabId: string, path: MosaicBranch[]) => {
    const tab = tabMap.get(tabId);
    return (
      <MosaicWindow<string>
        path={path}
        title={tabId}
        renderToolbar={() => (
          <MosaicToolbar
            layoutMode={layoutMode}
            onLayoutModeChange={(mode) => {
              if (mode === 'focus') {
                handleLayoutModeChange('focus', tabId);
              } else {
                handleLayoutModeChange(mode);
              }
            }}
          />
        )}
      >
        <MosaicTile
          tabId={tabId}
          tab={tab}
          layoutMode={layoutMode}
          onContextMenu={contextMenu.open}
          onLayoutModeChange={handleLayoutModeChange}
          onRestart={() => onRestartTab(tabId)}
          onAdd={() => onAddTab(tab?.cwd)}
          onFocus={() => handleTileFocus(tabId)}
          onRegisterRef={(el) => registerTileRef(tabId, el)}
        >
          {tab ? renderTerminal(tab) : null}
        </MosaicTile>
      </MosaicWindow>
    );
  },
  [
    tabMap,
    layoutMode,
    contextMenu.open,
    handleLayoutModeChange,
    onRestartTab,
    onAddTab,
    renderTerminal,
    handleTileFocus,
    registerTileRef,
  ],
  // path는 콜백 인자이므로 deps에 포함하지 않는다
);
```

4. `renderTile`에서 `MosaicToolbar`를 `MosaicWindow`의 `renderToolbar` prop으로 이동했으므로, `MosaicTile` 내부에서 `MosaicToolbar`를 렌더링하는 코드(현재 `MosaicTile.tsx` line 101-110)를 제거한다. `MosaicTile`은 `showToolbar?: boolean` prop을 추가하거나, 단순히 해당 `<MosaicToolbar .../>` JSX 블록을 삭제한다. 제거 후 `MosaicTile`의 `onLayoutModeChange` prop은 유지한다(Phase 1-1.5에서 처리).

**검증**: `renderTile`이 `(tabId, path)` 두 인자를 받고 `MosaicWindow`를 반환하는지 TypeScript 컴파일 통과 확인.

---

#### Phase 1-2: MosaicToolbar에 그립 아이콘 + connectDragSource

**대상 파일**: `frontend/src/components/Grid/MosaicToolbar.tsx`

**변경 내용**:

1. `MosaicWindowContext`를 `react-mosaic-component`에서 import.

2. `MosaicToolbar` 내부에서 `useContext(MosaicWindowContext)`로 `connectDragSource` 추출.
   - `MosaicWindowContext`의 `connectDragSource` 타입은 `react-dnd`의 `ConnectDragSource`이며, `(element: React.ReactElement) => React.ReactElement` 형태이다.
   - `MosaicWindowContext`가 없는 환경(독립 렌더 또는 단위 테스트)에서는 `connectDragSource`가 `undefined`일 수 있으므로 `connectDragSource?.(el) ?? el` 패턴으로 방어한다.

3. 그립 아이콘 `<div>`를 추가하고 `connectDragSource`로 감싸기:

```tsx
import { MosaicWindowContext } from 'react-mosaic-component';
import { useContext } from 'react';

export function MosaicToolbar({ layoutMode, onLayoutModeChange }: MosaicToolbarProps) {
  const { connectDragSource } = useContext(MosaicWindowContext);
  // ... 기존 상태/타이머 코드 유지 ...

  const gripDiv = (
    <div
      style={{
        width: '24px',
        height: '24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'grab',
        color: 'rgba(255,255,255,0.4)',
        fontSize: '14px',
        flexShrink: 0,
      }}
      title="드래그하여 타일 이동"
    >
      ⠿
    </div>
  );
  // connectDragSource가 undefined인 경우(Context 외부 렌더) gripDiv를 그대로 사용
  const gripIcon = connectDragSource ? connectDragSource(gripDiv) : gripDiv;

  return (
    <div
      style={{ position: 'absolute', top: 4, left: 4, zIndex: 10, display: 'flex', alignItems: 'center' }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {gripIcon}
      {/* 기존 툴바 패널 — expanded 상태에서 표시, draggable={false}로 드래그 방지 */}
      {expanded && (
        <div draggable={false} style={{ /* 기존 패널 스타일 */ }}>
          <ToolbarButton ... />
          <ToolbarButton ... />
          <ToolbarButton ... />
        </div>
      )}
    </div>
  );
}
```

4. 기존 툴바 패널(`<div draggable={false} ...>`) 내의 `ToolbarButton` 3개에는 `draggable={false}`를 패널 래퍼 div에 이미 부여했으므로 추가 처리 불필요. 단, `ToolbarButton`의 `<button>` 요소에도 `onDragStart={(e) => e.stopPropagation()}` 추가 권장.

**검증**: 그립 아이콘(⠿) 드래그 시 타일이 드래그 상태로 전환된다. 균등(⊞)/포커스(⊡)/자동(⟳) 버튼 클릭 시 드래그가 시작되지 않는다. `MosaicWindowContext` 없이 단독 렌더 시 crash 없이 gripDiv가 그대로 표시된다.

---

#### Phase 1-2.5: MosaicTile.tsx — 내장 툴바 제거

**대상 파일**: `frontend/src/components/Grid/MosaicTile.tsx`

**변경 내용**:

`MosaicTile` 컴포넌트는 현재 내부에서 `MosaicToolbar`를 직접 렌더링한다(line 101-110). `MosaicWindow`의 `renderToolbar` prop으로 툴바 위치가 이전됨에 따라, 이 중복 렌더를 제거한다.

1. `MosaicTile.tsx`에서 다음 코드 블록을 **삭제**한다:

```tsx
{/* Toolbar overlay — focus mode passes this tile's tabId */}
<MosaicToolbar
  layoutMode={layoutMode}
  onLayoutModeChange={(mode) => {
    if (mode === 'focus') {
      onLayoutModeChange('focus', tabId);
    } else {
      onLayoutModeChange(mode);
    }
  }}
/>
```

2. `MosaicToolbar` import 구문을 삭제한다 (`import { MosaicToolbar } from './MosaicToolbar';`).

3. `MosaicTileProps`의 `onLayoutModeChange` prop은 **유지**한다. `MosaicTile`은 여전히 `EmptyCell` 클릭, 기타 내부 액션에서 레이아웃 모드 변경을 트리거할 가능성이 있으므로 인터페이스를 보존한다. 실제로 사용하지 않는다면 호출부(`MosaicContainer.tsx`)에서 prop 전달을 제거한다.

**검증**: `MosaicWindow` 래핑 후 각 타일에 툴바가 1개만 표시된다(중복 없음). `MosaicTile` 단독 스냅샷에서 `MosaicToolbar`가 나타나지 않는다.

---

#### Phase 1-3: MosaicOverrides.css — window/body/drop 오버레이 CSS

**대상 파일**: `frontend/src/components/Grid/MosaicOverrides.css`

**추가 CSS 블록**:

```css
/* MosaicWindow 기본 레이아웃 초기화 */
.mosaic-window {
  display: flex;
  flex-direction: column;
  position: absolute;
  inset: 0;
}

/* mosaic-window-body: MosaicWindow가 children을 감싸는 div */
.mosaic-window .mosaic-window-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* MosaicWindow 기본 툴바 영역 — renderToolbar로 교체하므로 height 0 처리 */
.mosaic-window > .mosaic-window-toolbar {
  height: 0;
  overflow: hidden;
  padding: 0;
}

/* 드롭 오버레이 — 타일 이동 중 드롭 가능 영역 하이라이트 */
.mosaic-preview,
.mosaic-tile-drag-preview {
  background: rgba(100, 149, 237, 0.15) !important;
  border: 2px solid rgba(100, 149, 237, 0.5) !important;
}

/* 드롭 대상 활성화 시 강조 */
.drop-target.drop-target-hover {
  background: rgba(100, 149, 237, 0.25) !important;
}
```

**클래스명 확인**: `react-mosaic-component` v6.1.1의 실제 DOM 출력 기준:
- `.mosaic-window`: `MosaicWindow` 루트 div — Blueprint 테마에서 확인됨
- `.mosaic-window-body`: `MosaicWindow`가 children을 감싸는 div — 확인됨
- `.mosaic-window-toolbar`: `renderToolbar` 결과를 감싸는 div — 실제 클래스명은 브라우저 DevTools에서 확인 필요. 확인 전까지 `display: none` 대신 `height: 0; overflow: hidden; padding: 0` 적용하여 레이아웃 영향 최소화
- `.mosaic-preview`: 드래그 중 고스트 타일 — Blueprint 테마에서 확인됨

**주의**: `!important`는 Blueprint CSS(`.mosaic-blueprint-theme`) 기본 스타일 덮어쓰기에만 사용.

**검증**:
1. `MosaicWindow` 래핑 후 브라우저 DevTools에서 DOM 구조가 `.mosaic-tile > .mosaic-window > .mosaic-window-toolbar + .mosaic-window-body`임을 확인한다.
2. 타일 이동 후 터미널 콘텐츠 영역이 부모 높이를 100% 채우는지, xterm.js 크기가 올바르게 조절되는지 확인한다.
3. CSS 적용 전후 레이아웃 비교: `.mosaic-window-body`에 `flex: 1; min-height: 0` 없이는 터미널이 높이를 채우지 못함을 DevTools에서 검증.

---

#### Phase 1-4: 드래그 시 기존 기능(포커스/균등/오토 모드) 정상 동작 검증

**검증 항목 및 방법**:

| 시나리오 | 검증 방법 | 합격 기준 |
|----------|-----------|-----------|
| 타일 이동 후 균등 모드 전환 | ⊞ 버튼 클릭 | 모든 타일이 동등 비율로 재배치 |
| 타일 이동 후 포커스 모드 전환 | ⊡ 버튼 클릭 | 해당 타일이 확대, 나머지 최소 비율 |
| 타일 이동 후 오토 모드 | ⟳ 버튼 클릭 후 셸 명령 실행 | running 타일 확대, idle 타일 축소 |
| 분할선 드래그 후 저장 | 크기 조절 → 페이지 새로고침 | localStorage에서 크기 복원 |
| 컨텍스트 메뉴 | 타일 이동 후 우클릭 | 메뉴 정상 표시, tabId 올바름 |
| 포커스 타일 닫기 | 포커스 모드 진입 → 타일 닫기 | 균등 모드로 자동 revert |

---

### Phase 2: 부수 간극 수정 (FR-2, FR-3)

#### Phase 2-1: App.tsx 모바일 viewMode Reset useEffect

**대상 파일**: `frontend/src/App.tsx`

**변경 내용**:

`AppContent` 컴포넌트에 다음 `useEffect` 추가 (기존 `handleToggleViewMode` 아래):

```tsx
// FR-2: 모바일에서 그리드 모드 자동 해제
useEffect(() => {
  if (
    isMobile &&
    wm.activeWorkspace?.viewMode === 'grid' &&
    wm.activeWorkspaceId
  ) {
    wm.setViewMode(wm.activeWorkspaceId, 'tab');
  }
}, [isMobile, wm.activeWorkspace?.viewMode, wm.activeWorkspaceId]);
```

**의존성 배열 주의**: `wm` 객체 전체를 deps에 넣으면 매 렌더마다 effect가 재실행된다. 필요한 값만 참조한다.
`wm.setViewMode`의 참조 안정성 확보 방법: `useWorkspaceManager` 훅에서 `setViewMode`가 `useCallback`으로 감싸져 있으면 deps에 포함해도 무한 루프가 발생하지 않는다. 감싸져 있지 않은 경우, `useEffect` 내부에서 `const fn = wm.setViewMode; fn(...)` 형태로 사용하고 deps에서 `wm.setViewMode`를 제외한다. 안전한 패턴:

```tsx
useEffect(() => {
  if (
    isMobile &&
    wm.activeWorkspace?.viewMode === 'grid' &&
    wm.activeWorkspaceId
  ) {
    wm.setViewMode(wm.activeWorkspaceId, 'tab');
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [isMobile, wm.activeWorkspace?.viewMode, wm.activeWorkspaceId]);
// wm.setViewMode는 wm 객체 내 안정적 메서드로 간주하여 deps 제외.
// 만약 ESLint가 경고를 발생시키면 useWorkspaceManager에서 setViewMode를 useCallback으로 감쌀 것.
```

**검증**: 데스크톱에서 그리드 모드 진입 후 브라우저 폭을 모바일(<768px) 이하로 줄이면 자동으로 탭 모드로 전환.

---

#### Phase 2-2: 복사 메뉴 Disabled (hasSelection 체크)

**대상 파일**: `frontend/src/components/Grid/MosaicContainer.tsx`

**변경 내용**:

`buildTerminalContextMenuItems` 내 복사 항목에 `disabled` 필드 추가:

```tsx
const buildTerminalContextMenuItems = useCallback(
  (tabId: string) => {
    const tab = tabMap.get(tabId);
    const hasSelection = (window.getSelection()?.toString() ?? '').length > 0;
    return [
      // ... 새 세션, 세션 닫기, separator ...
      {
        label: '복사',
        icon: '⎘',
        disabled: !hasSelection,   // 선택 텍스트 없으면 비활성
        onClick: () => {
          handleCopy();
        },
      },
      // ... 붙여넣기 ...
    ];
  },
  [tabMap, contextMenu, onAddTab, handleCopy, handlePaste, tabs.length],
);
```

**검증**: 텍스트 선택 없이 우클릭 → 복사 항목이 dimmed/비활성. 텍스트 선택 후 우클릭 → 복사 항목 활성.

---

### 단위 테스트 계획

> 프로젝트에 Jest + React Testing Library가 없으면 수동 검증으로 대체한다. 각 테스트 케이스에 수동 검증 절차를 함께 기술한다.

| 테스트 케이스 | 유형 | 검증 내용 | 수동 검증 절차 |
|---------------|------|-----------|---------------|
| `renderTile`이 `MosaicWindow`를 반환 | 단위/수동 | `MosaicContainer`의 `renderTile` 반환 타입 확인 | `tsc --noEmit` 통과 확인 + React DevTools에서 `MosaicWindow` 컴포넌트 존재 확인 |
| `MosaicToolbar` — `connectDragSource` 정상 연결 | 단위/수동 | `MosaicWindowContext` mock으로 `connectDragSource` 호출 여부 확인 | 그립 아이콘(⠿) 드래그 시 반투명 드래그 고스트 표시 확인 |
| `MosaicToolbar` — `MosaicWindowContext` 외부에서 렌더 | 단위/수동 | Context 없이 렌더 시 crash 없음 | 컴포넌트 단독 렌더 또는 Storybook에서 에러 없이 표시됨 |
| `MosaicTile` 단독 렌더 — 툴바 없음 | 회귀/수동 | Phase 1-2.5 이후 `MosaicTile` 내부에 `MosaicToolbar`가 없음 | React DevTools에서 `MosaicTile` 자식 트리에 `MosaicToolbar` 없음 확인 |
| 복사 항목 `disabled` 조건 | 단위/수동 | `window.getSelection` mock으로 빈 문자열/비어있지 않은 경우 각각 확인 | 텍스트 미선택 후 우클릭: 복사 항목 회색(비활성). 텍스트 선택 후 우클릭: 복사 항목 활성 |
| 모바일 viewMode reset | 단위/수동 | `isMobile=true` + `viewMode='grid'` 조건에서 `setViewMode('tab')` 호출 확인 | DevTools에서 뷰포트를 375px로 축소 후 그리드 모드 → 자동으로 탭 모드 전환 확인 |
| `MosaicTile` 툴바 이중 표시 없음 (회귀) | 회귀/수동 | 타일당 툴바 아이콘이 1개만 표시 | 그리드 모드에서 타일 좌상단에 ⋯(또는 ⠿) 아이콘이 1개만 나타나는지 확인 |
| CSS 레이아웃 — 터미널 전체 높이 | 수동 | `.mosaic-window-body`가 부모 높이를 가득 채움 | DevTools Elements 패널에서 `.mosaic-window-body` computed height가 부모 `.mosaic-window`와 동일한지 확인 |

---

### 검증 기준

구현 완료의 합격 기준:

| 번호 | 기준 | 측정 방법 |
|------|------|-----------|
| V-1 | TypeScript 빌드 오류 없음 | `npm run build` 또는 `tsc --noEmit` 0 errors |
| V-2 | 타일을 드래그하여 위치 교환 가능 | Playwright: drag(tile-A) → drop(tile-B 위치), 위치 교환 확인 |
| V-3 | 드래그 중 드롭 영역 시각 피드백 | Playwright: 드래그 시작 후 `page.screenshot()` 캡처 → `.mosaic-preview` 요소 존재 여부 DOM 검사(`$('.mosaic-preview')`) |
| V-4 | 타일 이동 후 터미널 정상 렌더 | 이동 후 터미널 입력/출력 정상 동작 |
| V-5 | 기존 크기 조절 정상 | 분할선 드래그 후 localStorage 저장, 새로고침 후 복원 |
| V-6 | 포커스/균등/오토 모드 타일 이동 후 정상 | Phase 1-4 시나리오 전체 통과 |
| V-7 | 모바일 viewMode 자동 reset | 브라우저 폭 축소 시 탭 모드로 전환 |
| V-8 | 복사 메뉴 disabled 조건 | 선택 없음 → dimmed, 선택 있음 → 활성 |
| V-9 | `DndProvider` 이중 래핑 없음 | React DevTools 컴포넌트 트리에서 `DndProvider` 1개만 확인 |
| V-10 | 50fps 유지 | Chrome Performance 패널: 드래그 중 프레임 드롭 없음 |
| V-11 | 툴바 이중 표시 없음 (MosaicTile 회귀) | 그리드 모드 타일 좌상단에 아이콘 1개만 표시. React DevTools에서 `MosaicTile` 자식에 `MosaicToolbar` 없음 |
| V-12 | CSS 레이아웃 — 터미널 전체 높이 | DevTools에서 `.mosaic-window-body` computed height = 부모 `.mosaic-window` height |
