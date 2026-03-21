# Software Requirements Specification (SRS)
# BuilderGate - Step 6: tmux-Style Pane Split System

**Version**: 2.0.0
**Date**: 2026-03-21
**Status**: Approved (만장일치 A+, 2 라운드)
**Evaluation Rounds**: 2
**Depends On**: `docs/spec/srs.step5.md` (Runtime Settings Page)
**Research Reference**: `docs/research/tmux-feature-research.md`

---

## 1. 개요

### 1.1 목적
본 문서는 BuilderGate에 tmux 스타일 화면 분할(Pane Split) 시스템을 추가하기 위한 Step 6 요구사항 명세서이다. 사용자는 하나의 탭 내에서 여러 터미널을 수평/수직으로 분할하여 동시에 볼 수 있어야 하며, 모바일에서는 횡 스와이프 캐러셀로 전환하여 사용할 수 있어야 한다. 모든 레이아웃 상태는 브라우저 IndexedDB에 영속화된다.

### 1.2 범위
- 재귀적 바이너리 트리 기반 수평/수직 Pane 분할 시스템
- 우클릭 컨텍스트 메뉴 중심 Pane 조작 UX (Pane 영역, 분할 경계선, TabBar)
- 모바일 환경 횡 스와이프 캐러셀 내비게이션
- IndexedDB 기반 레이아웃 영속화 (paneLayouts, savedLayouts, sessionMeta)
- 기존 localStorage 탭 상태에서 IndexedDB로의 마이그레이션
- Pane 줌(전체화면 토글) 기능
- Pane 분할 경계선 드래그 리사이즈
- 프리셋 레이아웃 (단일, 좌우, 상하, 4분할, 1+2, 에이전트 모니터)
- tmux 호환 키보드 단축키 (Ctrl+B prefix 모드)

### 1.3 범위 제외
- 백엔드 `SessionManager` 구조 변경 (기존 자식 세션 생성 메커니즘 그대로 활용)
- 세션 그룹핑 (Step 7 이후)
- 서버사이드 세션 영속성 (Step 7 이후)
- Pane 내 파일 매니저/뷰어 배치 (Step 7 이후, 본 Step에서는 터미널 전용)
- 터미널 출력 히스토리의 서버사이드 저장
- Pane에 연결된 PTY 세션을 다른 기존 세션으로 교체하는 "세션 연결 변경" 기능 (Step 7 이후, 에이전트 오케스트레이션과 함께 도입)
- SSE 멀티플렉싱 (현재 서버는 HTTPS/HTTP/2로 동작하므로 동시 연결 제한 해당 없음)

### 1.4 용어

| 용어 | 설명 |
|------|------|
| Pane | 분할된 화면 영역 하나. 각 Pane은 독립된 PTY 세션에 연결된 터미널을 표시한다 |
| PaneNode | Pane 레이아웃 트리의 노드. `PaneLeaf`(터미널) 또는 `PaneSplit`(분할 노드) |
| PaneLeaf | 트리의 말단 노드. 하나의 터미널(`TerminalContainer`)을 렌더링한다 |
| PaneSplit | 트리의 내부 노드. 두 자식 노드를 수평 또는 수직으로 분할한다 |
| PaneLayout | 하나의 탭이 가지는 전체 분할 구성. `root: PaneNode` + `focusedPaneId: string` |
| Ratio | 분할 노드에서 첫 번째 자식이 차지하는 비율 (0.0~1.0) |
| Prefix Mode | tmux의 Ctrl+B 와 동일한 키보드 명령 입력 대기 상태 |
| Pane Zoom | 특정 Pane을 전체화면으로 확대하여 나머지 Pane을 일시적으로 숨기는 기능 |
| Carousel | 모바일에서 Pane을 횡 방향으로 나열하여 스와이프로 전환하는 UI 패턴 |
| Preset Layout | 미리 정의된 Pane 분할 구성 (단일, 좌우, 상하, 4분할 등) |

### 1.5 이전 버전 대비 변경사항

| 영역 | Step 5까지 | Step 6에서 변경 |
|------|-----------|----------------|
| 탭 콘텐츠 | 한 번에 1개 터미널 표시 | 1개 탭 내 N개 터미널 동시 표시 (분할) |
| 탭 상태 저장 | `localStorage` (`tab_state_{sessionId}`) | `IndexedDB` (`paneLayouts` Object Store) |
| 자식 세션 ID 저장 | `localStorage` (`child_session_ids`) | `IndexedDB` (`paneLayouts` 내 트리에 포함) |
| 컨텍스트 메뉴 | 탭 우클릭 메뉴 (이름변경, 닫기 등) | 탭 메뉴 확장 + Pane 메뉴 + 분할 경계선 메뉴 추가 |
| 모바일 터미널 | 탭 전환으로 터미널 변경 | 탭 내 스와이프 캐러셀로 Pane 전환 |
| 키보드 단축키 | Ctrl+C/V, 기본 입력 | Ctrl+B prefix 모드 + Pane 조작 단축키 추가 |

### 1.6 사용자 요구사항 매핑

| UR-ID | 사용자 요구사항 | 대응 요구사항 |
|-------|----------------|---------------|
| UR-601 | 하나의 화면에서 여러 터미널을 동시에 볼 수 있어야 한다 | FR-6101~FR-6106 |
| UR-602 | 마우스 우클릭으로 Pane을 분할/닫기/조작할 수 있어야 한다 | FR-6201~FR-6205 |
| UR-603 | 모바일에서 Pane을 횡 방향으로 추가하고 스와이프로 전환할 수 있어야 한다 | FR-6301~FR-6305 |
| UR-604 | 브라우저 IndexedDB에 레이아웃을 저장하여 새로고침 시 복원되어야 한다 | FR-6401~FR-6407 |
| UR-605 | 자주 쓰는 레이아웃을 프리셋으로 저장/불러오기 할 수 있어야 한다 | FR-6501~FR-6504 |
| UR-606 | tmux처럼 Ctrl+B 키보드 단축키로 Pane을 조작할 수 있어야 한다 | FR-6601~FR-6605 |

---

## 2. 현재 코드베이스 분석 요약

| 영역 | 현재 구현 상태 | Step 6에 주는 의미 |
|------|----------------|---------------------|
| 탭 시스템 | `useTabManager.ts`가 세션별 `UnifiedTab[]` 배열 관리, `type: 'terminal'` 탭에 `sessionId` 포함 | `UnifiedTab`에 `PaneLayout` 필드를 추가하거나 별도 `usePaneManager` 훅으로 분리해야 한다 |
| 자식 세션 | `App.tsx`의 `handleAddTerminalTab()`이 `createSession('Sub-Terminal', ...)` 호출, `childSessionIds` Set으로 사이드바에서 숨김 | Pane 분할 시 동일한 자식 세션 생성 로직을 재활용할 수 있다 |
| TerminalContainer | `TerminalContainer.tsx`가 `sessionId` props로 SSE 연결 및 xterm.js 렌더링 수행, `display: none`으로 비활성 탭 숨김 | Pane 내부에 배치해도 기존 인터페이스 변경 없이 동작한다 |
| xterm.js FitAddon | `TerminalView.tsx`가 `ResizeObserver`로 컨테이너 크기 변경 감지 후 `fitAddon.fit()` 호출 | Pane 리사이즈 시 자동으로 터미널이 맞춰진다. 별도 리사이즈 로직 불필요 |
| ContextMenu | `ContextMenu` 컴포넌트가 존재하나 서브메뉴 미지원 | 서브메뉴(`children`) 지원 확장이 필요하다 |
| 모바일 UX | `useDragReorder`에 롱프레스(300ms) 기반 드래그 구현, `AddTabModal` 바텀시트 존재 | 롱프레스 기반 컨텍스트 메뉴, 스와이프 제스처를 유사 패턴으로 구현할 수 있다 |
| localStorage | `tab_state_{sessionId}`, `child_session_ids`, `active_session_id` 등 사용 | IndexedDB로 마이그레이션 후 점진적 폐기 필요 |
| SessionManager | `createSession()`이 자식 PTY 세션을 생성하고 `Map`에 저장, SSE 스트림 제공 | 변경 불필요. Pane 분할 시 기존 API(`POST /api/sessions`)로 새 PTY 생성 |
| TerminalView customKeyEventHandler | `Ctrl+C/V`, `Ctrl+[A-Z]`, 방향키 등 처리 | `Ctrl+B` prefix 모드 상태 머신을 여기에 추가해야 한다 |
| StatusBar | `StatusBar` 컴포넌트가 하단에 세션 상태 표시 | Prefix 모드 표시, 현재 Pane 정보 표시를 추가할 수 있다 |
| RuntimeConfigStore | Step 5에서 도입한 mutable 런타임 설정 저장소, `pty.defaultCols/Rows/shell` 등 런타임 변경 가능 | Pane 분할 시 새 PTY 세션 생성에 RuntimeConfigStore의 현재 설정값을 적용해야 한다 |
| childSessionIds | `App.tsx`의 `Set<string>` State + `localStorage('child_session_ids')`, 사이드바에서 자식 세션 숨김 | Step 6에서 Pane 트리 내 `sessionId` 참조로 대체. `childSessionIds`는 Pane 트리의 모든 리프 sessionId를 `useMemo`로 추출하는 computed value로 전환한다 |
| screen state | `AppContent`의 `useState<'workspace' \| 'settings'>` | Pane 분할은 `workspace` 화면에서만 동작. settings 진입/복귀 시 Pane 상태(포커스, 줌 포함)가 그대로 유지되어야 한다 |

---

## 3. 데이터 구조 요구사항

### 3.1 PaneNode 트리 (핵심 데이터 모델)

```typescript
type PaneNode = PaneLeaf | PaneSplit;

interface PaneLeaf {
  type: 'terminal';
  id: string;           // UUID, Pane 고유 식별자
  sessionId: string;    // 백엔드 PTY 세션 ID
}

interface PaneSplit {
  type: 'split';
  id: string;           // UUID, 분할 노드 고유 식별자
  direction: 'horizontal' | 'vertical';
  // horizontal: 상하 분할 (flex-direction: column)
  // vertical: 좌우 분할 (flex-direction: row)
  ratio: number;        // 0.15 ~ 0.85, 첫 번째 자식 비율
  children: [PaneNode, PaneNode];  // 정확히 2개 (바이너리 트리)
}

interface PaneLayout {
  root: PaneNode;
  focusedPaneId: string;       // 현재 포커스된 PaneLeaf ID
  zoomedPaneId: string | null; // 줌 상태인 PaneLeaf ID (null이면 줌 아님)
}
```

### 3.2 제약조건

| 제약 | 값 | 설명 |
|------|---|------|
| 최대 Pane 수 | 8 | `countPanes(root) <= 8`, 초과 시 분할 메뉴 비활성화 |
| 최대 분할 깊이 | 4 | 트리 깊이 제한, 초과 시 분할 메뉴 비활성화 |
| 최소 ratio | 0.15 | 드래그 리사이즈 시 하한 |
| 최대 ratio | 0.85 | 드래그 리사이즈 시 상한 |
| 최소 Pane 크기 | 120px (너비), 80px (높이) | 이 이하로 축소 시 ratio 클램핑 |

### 3.3 PaneNode 트리 유틸리티 함수

다음 순수 함수들을 `frontend/src/utils/paneTree.ts`에 구현한다. 모든 함수는 불변 업데이트를 수행한다 (원본 트리를 수정하지 않고 새 트리를 반환).

| 함수 | 시그니처 | 설명 |
|------|---------|------|
| `splitPane` | `(root: PaneNode, paneId: string, direction: Direction, newSessionId: string) => PaneNode` | 지정 PaneLeaf를 분할하여 PaneSplit으로 교체. 기존 Leaf가 첫 번째 자식, 새 Leaf가 두 번째 자식. 초기 ratio=0.5 |
| `closePane` | `(root: PaneNode, paneId: string) => PaneNode \| null` | 지정 PaneLeaf 제거. 형제 노드가 부모 위치를 대체. root가 제거 대상이면 null 반환 |
| `resizePane` | `(root: PaneNode, splitId: string, ratio: number) => PaneNode` | 지정 PaneSplit의 ratio를 업데이트 (0.15~0.85 클램핑) |
| `swapPanes` | `(root: PaneNode, paneIdA: string, paneIdB: string) => PaneNode` | 두 PaneLeaf의 위치(sessionId 포함)를 교환 |
| `toggleDirection` | `(root: PaneNode, splitId: string) => PaneNode` | 지정 PaneSplit의 direction을 horizontal↔vertical 전환 |
| `flattenPaneTree` | `(root: PaneNode) => PaneLeaf[]` | 트리를 깊이 우선 순회하여 모든 PaneLeaf를 배열로 반환 |
| `findPane` | `(root: PaneNode, paneId: string) => PaneLeaf \| null` | ID로 PaneLeaf 검색 |
| `findSplit` | `(root: PaneNode, splitId: string) => PaneSplit \| null` | ID로 PaneSplit 검색 |
| `findParentSplit` | `(root: PaneNode, paneId: string) => PaneSplit \| null` | 지정 PaneLeaf의 부모 PaneSplit 반환 |
| `getAdjacentPane` | `(root: PaneNode, paneId: string, direction: 'up'\|'down'\|'left'\|'right') => PaneLeaf \| null` | 지정 방향의 인접 PaneLeaf 반환 (포커스 이동용) |
| `countPanes` | `(root: PaneNode) => number` | 전체 PaneLeaf 수 반환 |
| `getTreeDepth` | `(root: PaneNode) => number` | 트리 최대 깊이 반환 |
| `equalizeRatios` | `(root: PaneNode, splitId: string) => PaneNode` | 지정 PaneSplit의 ratio를 0.5로 설정 |
| `buildPresetLayout` | `(preset: PresetType, sessionIds: string[]) => PaneLayout` | 프리셋 타입과 세션 ID 배열로 PaneLayout 생성. `sessionIds.length`가 프리셋의 Pane 수와 불일치하면 에러를 throw한다 |

### 3.4 `usePaneManager` 훅 인터페이스

`frontend/src/hooks/usePaneManager.ts`에 구현한다. `useTabManager`와 동급의 세션별 Pane 상태를 관리한다.

```typescript
interface UsePaneManagerReturn {
  // 상태
  layout: PaneLayout;                 // 현재 활성 탭의 Pane 레이아웃
  prefixMode: boolean;                // Ctrl+B prefix 모드 활성 여부
  swapSource: string | null;          // Pane 교환 모드의 소스 Pane ID
  paneNumberOverlay: boolean;         // Pane 번호 오버레이 표시 여부

  // Pane 분할/닫기
  splitPane(paneId: string, direction: 'horizontal' | 'vertical'): Promise<void>;
  closePane(paneId: string): Promise<void>;
  closeOtherPanes(keepPaneId: string): Promise<void>;

  // 포커스/줌
  setFocusedPane(paneId: string): void;
  moveFocus(direction: 'up' | 'down' | 'left' | 'right'): void;
  cycleFocus(): void;                 // 다음 Pane으로 순환
  toggleZoom(paneId?: string): void;

  // 리사이즈
  resizePane(splitId: string, ratio: number): void;
  equalizePanes(splitId: string): void;
  toggleDirection(splitId: string): void;

  // 교환
  startSwap(paneId: string): void;
  executeSwap(targetPaneId: string): void;
  cancelSwap(): void;

  // 프리셋/레이아웃
  applyPreset(preset: PresetType): Promise<void>;
  saveLayout(name: string): Promise<string>;
  loadLayout(layoutId: string): Promise<void>;

  // Prefix 모드
  enterPrefixMode(): void;
  exitPrefixMode(): void;
  handlePrefixKey(key: string): void;

  // Pane 번호 오버레이
  showPaneNumbers(): void;
  selectPaneByNumber(num: number): void;

  // 쿼리
  paneCount: number;                  // computed: countPanes(layout.root)
  treeDepth: number;                  // computed: getTreeDepth(layout.root)
  canSplit: boolean;                  // computed: paneCount < 8 && treeDepth < 4
  allSessionIds: string[];            // computed: flattenPaneTree(root).map(l => l.sessionId)
}
```

**`useTabManager`와의 책임 경계:**
- `useTabManager`: 탭 목록(`UnifiedTab[]`) 관리, 탭 추가/삭제/재정렬, 활성 탭 ID 관리
- `usePaneManager`: 활성 터미널 탭 내의 Pane 트리 관리, Pane 분할/닫기/포커스/리사이즈/줌
- **연결점**: `useTabManager`의 활성 탭 ID 변경 시 `usePaneManager`가 해당 탭의 `PaneLayout`을 IndexedDB에서 로드한다
- **`childSessionIds` 대체**: 기존 `App.tsx`의 `childSessionIds` Set은 `usePaneManager.allSessionIds`에서 부모 세션 ID를 제외한 값으로 대체한다. `useMemo`로 계산하며, 사이드바의 `visibleSessions` 필터에서 이 값을 사용한다.

### 3.5 `getAdjacentPane` 알고리즘

포커스 이동에서 "인접 Pane"은 **시각적 위치 기반**으로 결정한다:

1. 현재 Pane의 bounding box 중심점을 계산한다.
2. 이동 방향으로 반직선(ray)을 발사한다.
3. 반직선과 교차하는 다른 PaneLeaf들 중 중심점 간 거리가 가장 짧은 것을 선택한다.
4. 교차하는 Pane이 없으면 이동하지 않는다.

이 알고리즘은 깊은 중첩 트리에서도 사용자의 시각적 기대와 일치한다. 구현 시에는 각 PaneLeaf의 DOM 요소에서 `getBoundingClientRect()`를 호출하여 위치를 계산한다.

---

## 4. IndexedDB 요구사항

### 4.1 데이터베이스 스키마

- **DB 이름**: `buildergate`
- **버전**: 1
- **버전 업그레이드 정책**: 각 Step에서 스키마 변경이 필요하면 DB 버전을 1씩 증가시킨다. `onupgradeneeded` 핸들러는 버전별 마이그레이션 함수 체인을 실행한다 (예: v1→v2, v2→v3 순차 적용). 기존 데이터는 보존하며 새 Object Store/인덱스만 추가한다.

#### Object Store 1: `paneLayouts`

세션별 현재 Pane 레이아웃을 저장한다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `sessionId` (keyPath) | `string` | 부모 세션 ID |
| `layout` | `PaneLayout` | 현재 Pane 트리 구성 |
| `updatedAt` | `number` | `Date.now()` 타임스탬프 |

- **인덱스**: `byUpdatedAt` on `updatedAt`

#### Object Store 2: `savedLayouts`

사용자가 저장한 커스텀 레이아웃과 기본 프리셋을 저장한다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `id` (keyPath) | `string` | UUID |
| `name` | `string` | 레이아웃 이름 (예: "나의 3분할") |
| `layout` | `PaneLayout` | Pane 트리 구성 (sessionId는 placeholder) |
| `isBuiltIn` | `boolean` | `true`이면 기본 프리셋, 삭제 불가 |
| `paneCount` | `number` | Pane 수 (UI 표시용) |
| `createdAt` | `number` | 생성 타임스탬프 |

- **인덱스**: `byName` on `name` (non-unique, 기본 프리셋과 커스텀 이름 충돌을 허용하되, 커스텀 저장 시 동일 이름 존재 여부를 앱 레벨에서 확인 후 덮어쓰기 확인 모달을 표시한다)

#### Object Store 3: `sessionMeta`

세션별 메타데이터를 저장한다 (향후 그룹핑 등 확장용).

| 필드 | 타입 | 설명 |
|------|------|------|
| `sessionId` (keyPath) | `string` | 세션 ID |
| `groupId` | `string?` | 그룹 ID (Step 7 예약) |
| `color` | `string?` | 세션 색상 (Step 7 예약) |
| `lastConnected` | `number` | 마지막 접속 타임스탬프 |

### 4.2 `usePaneDB` 훅 요구사항

`frontend/src/hooks/usePaneDB.ts`에 구현한다.

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `saveLayout` | `(sessionId: string, layout: PaneLayout) => Promise<void>` | 세션의 현재 레이아웃 저장 (upsert) |
| `loadLayout` | `(sessionId: string) => Promise<PaneLayout \| null>` | 세션의 레이아웃 복원, 없으면 null |
| `deleteLayout` | `(sessionId: string) => Promise<void>` | 세션 삭제 시 레이아웃도 삭제 |
| `savePreset` | `(name: string, layout: PaneLayout) => Promise<string>` | 커스텀 프리셋 저장, ID 반환 |
| `loadPresets` | `() => Promise<SavedLayout[]>` | 모든 프리셋 조회 (기본 + 커스텀) |
| `deletePreset` | `(id: string) => Promise<void>` | 커스텀 프리셋 삭제 (`isBuiltIn=true`이면 거부) |
| `initBuiltInPresets` | `() => Promise<void>` | 앱 최초 로드 시 기본 프리셋 6개 생성 (이미 존재하면 스킵) |
| `migrateFromLocalStorage` | `() => Promise<void>` | 기존 localStorage 탭 상태 마이그레이션 |

### 4.3 IndexedDB 오류 처리

| 오류 상황 | 동작 |
|----------|------|
| IndexedDB 미지원 브라우저 | `localStorage` 폴백 모드로 동작, 콘솔 경고 출력. 이 경우 마이그레이션은 스킵한다. |
| DB 열기 실패 | 메모리 내 임시 상태로 동작, StatusBar에 경고 표시 |
| 저장 실패 | 다음 저장 타이밍에 재시도 (최대 3회), 실패 시 콘솔 경고 |
| 마이그레이션 실패 | 기존 localStorage 데이터 유지, 다음 앱 로드 시 재시도 |
| QuotaExceededError (스토리지 쿼터 초과) | `savedLayouts`에서 가장 오래된 커스텀 프리셋을 자동 삭제 후 재시도. 재시도 실패 시 사용자에게 "저장 공간이 부족합니다. 사용하지 않는 레이아웃을 삭제해주세요." 안내 |
| 앱 로드 시 세션 불일치 | IndexedDB의 Pane 트리에 있는 `sessionId`가 서버 세션 목록에 없으면, 해당 PaneLeaf를 트리에서 제거한다. 모든 리프가 제거되면 기본 단일 Pane으로 초기화한다. |

### 4.4 저장 타이밍

| 이벤트 | 동작 | debounce |
|--------|------|----------|
| Pane 분할 | 저장 | 300ms |
| Pane 닫기 | 저장 | 300ms |
| Pane 리사이즈 드래그 끝 | 즉시 저장 (`pointerup`) | 없음 |
| 포커스 Pane 변경 | 저장 | 300ms |
| 탭 전환 | 이전 탭 레이아웃 저장 | 없음 |
| 줌 토글 | 저장 | 300ms |
| 브라우저 `visibilitychange` (hidden) | IndexedDB 비동기 저장 실행 | 없음 |
| 브라우저 `beforeunload` | dirty 상태 확인, 미저장 시 경고 표시 (IndexedDB 비동기 특성상 이 시점의 저장은 best-effort) | 없음 |
| 앱 로드 시 | IndexedDB에서 복원 → 서버 세션 목록과 교차 검증(4.3 참조) → 유효하지 않은 세션 제거 → 없으면 기본 단일 Pane | - |

### 4.5 localStorage 마이그레이션

#### FR-6407: 기존 탭 상태 마이그레이션

1. 앱 로드 시 `localStorage.getItem('migrated_to_idb')` 확인
2. 플래그가 없으면 마이그레이션 실행:
   a. `localStorage`에서 `tab_state_{sessionId}` 키들을 검색
   b. 각 탭 상태의 터미널 탭들을 단일 `PaneLeaf`로 변환 (메인 터미널만 Pane에 포함, 추가 터미널 탭은 별도 탭으로 유지)
   c. 변환된 `PaneLayout`을 IndexedDB `paneLayouts`에 저장
   d. `child_session_ids`는 Pane 트리의 sessionId 참조로 대체
3. 마이그레이션 성공 시 `localStorage.setItem('migrated_to_idb', Date.now().toString())`
4. 기존 localStorage 키는 삭제하지 않음 (안전을 위해 보류, 90일 후 자동 정리 가능)

---

## 5. 기능 요구사항

### 5.1 Pane 분할 시스템

#### FR-6101: 수평/수직 Pane 분할

- 사용자는 현재 포커스된 Pane을 수평(상/하) 또는 수직(좌/우)으로 분할할 수 있어야 한다.
- 분할 시 새 PTY 세션이 생성된다 (기존 `createSession('Sub-Terminal', undefined, parentCwd, false)` 로직 재활용).
- 새 세션의 CWD는 부모 세션의 현재 CWD를 기본값으로 사용한다.
- 기존 Pane이 `PaneSplit`의 첫 번째 자식이 되고, 새 Pane이 두 번째 자식이 된다.
- 초기 ratio는 0.5 (균등 분할)이다.
- 분할 후 포커스는 새 Pane으로 이동한다.
- 최대 Pane 수(8개) 또는 최대 트리 깊이(4)에 도달하면 분할 메뉴 항목이 비활성화된다.
- 새 PTY 세션의 기본 cols/rows/shell은 `RuntimeConfigStore`의 현재 `pty.defaultCols`, `pty.defaultRows`, `pty.shell` 값을 적용한다.
- **세션 생성 실패 처리**: `POST /api/sessions` API 호출이 실패(네트워크 오류, 서버 오류 등)하면 PaneNode 트리를 분할 전 상태로 롤백하고, StatusBar에 에러 메시지를 3초간 표시한다. 트리 변경은 세션 생성 성공 확인 후에만 커밋한다 (optimistic update 금지).

**Acceptance Criteria**
- AC-6101-1: 단일 Pane 상태에서 수직 분할 후 좌우 2개 터미널이 동시에 표시된다.
- AC-6101-2: 분할된 터미널 각각에 독립적으로 명령을 입력할 수 있다.
- AC-6101-3: 8개 Pane 상태에서 분할 메뉴 항목이 비활성화(disabled)된다.
- AC-6101-4: 서버가 응답하지 않는 상태에서 분할 시도 시 에러 메시지가 표시되고 레이아웃이 변경되지 않는다.

#### FR-6102: Pane 닫기

- 사용자는 포커스된 Pane을 닫을 수 있어야 한다.
- Pane을 닫으면 해당 `TerminalContainer`의 SSE `EventSource.close()`를 먼저 호출한 후, `deleteSession` API를 호출하여 PTY 세션을 종료한다.
- 닫힌 Pane의 형제 노드가 부모 `PaneSplit` 위치를 대체한다.
- 마지막 남은 Pane은 닫을 수 없다 (메뉴 항목 비활성화).
- 닫기 후 포커스는 형제 Pane으로 이동한다.
- **"다른 Pane 모두 닫기"**: 포커스된 Pane을 제외한 나머지를 순차적으로 닫는다. 일부 세션 삭제 API가 실패해도 나머지는 계속 진행하며, 실패한 Pane은 트리에 유지된다. 모든 처리 완료 후 실패 건수를 StatusBar에 표시한다.
- **탭 닫기 시**: 해당 탭의 Pane 트리에 포함된 모든 `PaneLeaf`의 PTY 세션을 일괄 종료한다. `flattenPaneTree(root)`로 모든 리프를 추출하여 `deleteSession`을 호출한다. IndexedDB의 `paneLayouts` 레코드도 삭제한다.

**Acceptance Criteria**
- AC-6102-1: 2개 Pane 상태에서 하나를 닫으면 나머지가 전체 영역을 차지한다.
- AC-6102-2: 닫힌 Pane의 PTY 세션이 서버에서 삭제된다.
- AC-6102-3: 마지막 Pane의 닫기 메뉴 항목이 비활성화된다.
- AC-6102-4: Pane 닫기 후 해당 세션의 SSE 연결이 브라우저 DevTools Network 탭에서 종료됨을 확인할 수 있다.

#### FR-6103: Pane 리사이즈

- 사용자는 분할 경계선을 드래그하여 인접 Pane의 크기 비율을 조절할 수 있어야 한다.
- 경계선은 4px 너비/높이의 드래그 핸들로 표시된다.
- 드래그 중 `cursor` 스타일이 변경된다: 수직 분할 → `col-resize`, 수평 분할 → `row-resize`.
- ratio는 0.15~0.85 범위로 클램핑된다.
- 최소 Pane 크기(120px 너비, 80px 높이) 미만으로 축소되면 ratio 클램핑이 적용된다.
- 드래그 중 xterm.js 터미널에서 포인터 이벤트를 차단한다 (`pointer-events: none` 오버레이).
- 드래그 완료(`pointerup`) 시 IndexedDB에 레이아웃을 저장한다.
- **모바일 캐러셀 모드(768px 이하)에서는 분할 경계선 드래그가 비활성이다** (캐러셀 모드에서는 경계선이 렌더링되지 않음).
- 태블릿(769px~1024px)에서 경계선의 터치 타겟 영역은 최소 20px로 확장한다 (시각적으로는 4px 유지, 투명 터치 영역 확장).

**Acceptance Criteria**
- AC-6103-1: 분할 경계선을 드래그하면 양쪽 Pane 크기가 실시간으로 변경된다.
- AC-6103-2: xterm.js 터미널이 리사이즈 후 자동으로 cols/rows를 재계산한다.
- AC-6103-3: ratio가 0.15 미만 또는 0.85 초과로 드래그되지 않는다.

#### FR-6104: Pane 줌 (전체화면 토글)

- 사용자는 특정 Pane을 줌(전체화면)으로 확대할 수 있어야 한다.
- 줌 상태에서는 해당 Pane만 전체 탭 콘텐츠 영역을 차지하고, 나머지 Pane은 숨겨진다 (`display: none`).
- 줌 상태에서 다시 줌을 토글하면 원래 분할 레이아웃으로 복원된다.
- 줌 상태에서 StatusBar에 `[ZOOMED]` 표시가 나타난다.
- 줌 상태에서 Pane 분할/닫기 조작은 비활성화된다.
- `PaneLayout.zoomedPaneId`에 줌 상태를 저장한다.

**Acceptance Criteria**
- AC-6104-1: 4분할 상태에서 하나의 Pane을 줌하면 해당 Pane만 전체 영역에 표시된다.
- AC-6104-2: 줌 해제 시 4분할 레이아웃이 그대로 복원된다.
- AC-6104-3: 줌 상태에서 분할/닫기 메뉴 항목이 비활성화된다.

#### FR-6105: Pane 교환

- 사용자는 두 Pane의 위치를 교환할 수 있어야 한다.
- 교환 모드 진입: 컨텍스트 메뉴에서 "Pane 교환" 선택 시 현재 Pane이 소스로 선택된다.
- 소스 Pane에 시각적 하이라이트(점선 테두리)가 표시된다.
- 다른 Pane을 클릭하면 교환이 실행된다.
- ESC 키를 누르면 교환 모드가 취소된다.

**Acceptance Criteria**
- AC-6105-1: Pane A와 Pane B를 교환하면 각 위치의 터미널 세션이 바뀐다.
- AC-6105-2: 교환 모드에서 ESC 키를 누르면 모드가 취소된다.

#### FR-6106: Pane 포커스 이동

- 사용자는 분할된 Pane 간 포커스를 이동할 수 있어야 한다.
- 포커스된 Pane은 시각적으로 구분된다: 1px `var(--accent-color)` 테두리 또는 상단 2px 액센트 바.
- 포커스 이동 방법:
  - Pane 영역 클릭
  - 키보드 단축키 (`Ctrl+B, ←↑↓→`)
- 포커스 이동은 분할 방향을 고려한다:
  - 수직 분할 내에서 `←`/`→`는 좌우 Pane으로 이동
  - 수평 분할 내에서 `↑`/`↓`는 상하 Pane으로 이동
- 해당 방향에 인접 Pane이 없으면 이동하지 않는다.

**Acceptance Criteria**
- AC-6106-1: Pane 클릭 시 해당 Pane에 포커스 표시가 나타나고 xterm.js에 키 입력이 전달된다.
- AC-6106-2: Ctrl+B → 방향키로 인접 Pane으로 포커스가 이동한다.

---

### 5.2 컨텍스트 메뉴 UX

#### FR-6201: Pane 영역 컨텍스트 메뉴

- Pane 영역(터미널 위)에서 우클릭 시 다음 메뉴가 표시되어야 한다:

| 메뉴 항목 | 단축키 표시 | 동작 | 비활성화 조건 |
|-----------|------------|------|--------------|
| 수평 분할 (위/아래) | `Ctrl+B, "` | FR-6101 수평 분할 실행 | Pane 수 ≥ 8 또는 깊이 ≥ 4 |
| 수직 분할 (좌/우) | `Ctrl+B, %` | FR-6101 수직 분할 실행 | Pane 수 ≥ 8 또는 깊이 ≥ 4 |
| 구분선 | - | - | - |
| 줌 토글 | `Ctrl+B, z` | FR-6104 줌 토글 | 단일 Pane 상태 |
| Pane 교환 | - | FR-6105 교환 모드 진입 | 단일 Pane 상태 |
| 구분선 | - | - | - |
| 출력 복사 | - | 현재 터미널의 선택 영역 또는 전체 화면 텍스트를 클립보드에 복사 | - |
| 구분선 | - | - | - |
| Pane 닫기 | `Ctrl+B, x` | FR-6102 Pane 닫기 | 마지막 Pane |
| 다른 Pane 모두 닫기 | - | 포커스된 Pane을 제외한 나머지 모두 닫기 | 단일 Pane 상태 |

- 줌 상태에서는 "줌 해제"로 텍스트가 변경되고, 분할/닫기 항목은 비활성화된다.

**Acceptance Criteria**
- AC-6201-1: 터미널 영역에서 우클릭 시 컨텍스트 메뉴가 표시된다.
- AC-6201-2: 비활성화된 항목이 시각적으로 구분되고 클릭해도 동작하지 않는다.
- AC-6201-3: 메뉴 외부 클릭 시 메뉴가 닫힌다.

#### FR-6202: 분할 경계선 컨텍스트 메뉴

- Pane 분할 경계선(`PaneResizer`) 위에서 우클릭 시 다음 메뉴가 표시되어야 한다:

| 메뉴 항목 | 동작 |
|-----------|------|
| 균등 분할 | ratio를 0.5로 설정 |
| 방향 전환 (↔ ↕) | horizontal ↔ vertical 전환 |
| 구분선 | - |
| 첫 번째 Pane 닫기 | 분할의 첫 번째 자식 Pane 닫기 |
| 두 번째 Pane 닫기 | 분할의 두 번째 자식 Pane 닫기 |

- 첫 번째/두 번째는 방향에 따라 표시: 수직 분할 → "왼쪽/오른쪽", 수평 분할 → "위/아래".

**Acceptance Criteria**
- AC-6202-1: 분할 경계선 우클릭 시 경계선 전용 메뉴가 표시된다.
- AC-6202-2: "균등 분할" 선택 시 양쪽 Pane이 50:50 비율이 된다.
- AC-6202-3: "방향 전환" 선택 시 좌우 분할이 상하로(또는 반대로) 변경된다.

#### FR-6203: TabBar 컨텍스트 메뉴 확장

- 기존 TabBar 탭 우클릭 메뉴에 다음 항목을 추가한다:

| 메뉴 항목 | 동작 |
|-----------|------|
| 레이아웃 저장 | 현재 탭의 PaneLayout을 이름 입력 후 `savedLayouts`에 저장 |
| 레이아웃 불러오기 | 저장된 레이아웃 목록에서 선택하여 현재 탭에 적용 |
| 프리셋 레이아웃 ▶ | 서브메뉴: 단일, 좌우, 상하, 4분할, 1+2, 에이전트 모니터 |

- 레이아웃 불러오기/프리셋 적용 시:
  - 현재 Pane의 PTY 세션들을 모두 종료한다.
  - 프리셋에 필요한 수만큼 새 PTY 세션을 생성한다.
  - 새 PaneLayout을 적용한다.

**Acceptance Criteria**
- AC-6203-1: "프리셋 레이아웃"에 마우스 호버 시 서브메뉴가 표시된다.
- AC-6203-2: "좌우 분할" 프리셋 선택 시 2개의 터미널이 좌우로 분할된다.
- AC-6203-3: "레이아웃 저장" 후 "레이아웃 불러오기"에서 저장된 이름이 표시된다.

#### FR-6204: 컨텍스트 메뉴 서브메뉴 지원

- 기존 `ContextMenu` 컴포넌트를 확장하여 중첩 서브메뉴를 지원해야 한다.
- `ContextMenuItem`에 `children?: ContextMenuItem[]` 필드를 추가한다.
- `children`이 있는 항목은 오른쪽에 `▶` 화살표를 표시한다.
- 마우스 호버 시 서브메뉴가 부모 메뉴의 오른쪽에 표시된다.
- 화면 경계에서는 서브메뉴가 왼쪽에 표시된다 (overflow 방지).
- 서브메뉴에서 벗어나면 300ms 딜레이 후 닫힌다.

**Acceptance Criteria**
- AC-6204-1: 서브메뉴 항목에 `▶` 화살표가 표시된다.
- AC-6204-2: 서브메뉴가 화면 오른쪽 경계를 넘지 않는다.

#### FR-6205: 모바일 롱프레스 컨텍스트 메뉴

- 모바일 환경에서는 Pane 영역 롱프레스(500ms)로 FR-6201의 컨텍스트 메뉴를 표시한다.
- 메뉴는 바텀시트(bottom sheet) 스타일로 표시된다 (기존 `AddTabModal` 패턴 활용).
- 서브메뉴는 바텀시트 내에서 슬라이드 전환으로 표시된다 (새 목록으로 전환, 뒤로가기 버튼 포함).

**Acceptance Criteria**
- AC-6205-1: 모바일에서 터미널 롱프레스 시 바텀시트 메뉴가 표시된다.
- AC-6205-2: 프리셋 레이아웃 항목 탭 시 서브메뉴 목록으로 슬라이드 전환된다.

---

### 5.3 모바일 캐러셀 내비게이션

#### FR-6301: 반응형 렌더링 분기

- 화면 너비 768px 이하를 모바일로 판단한다 (`useMediaQuery('(max-width: 768px)')`).
- 동일한 `PaneLayout` 데이터를 다르게 렌더링한다:
  - 데스크톱: `SplitPane` 재귀 렌더러 (분할 레이아웃)
  - 모바일: `PaneCarousel` 횡 스와이프 캐러셀
- 화면 크기 변경 시 자동으로 렌더링 모드가 전환된다.

**Acceptance Criteria**
- AC-6301-1: 768px 이하에서 캐러셀 모드로 표시된다.
- AC-6301-2: 769px 이상에서 분할 모드로 표시된다.
- AC-6301-3: 브라우저 크기 변경 시 모드가 즉시 전환된다.

#### FR-6302: 횡 스와이프 전환

- 모바일 캐러셀에서 좌우 스와이프로 Pane을 전환할 수 있어야 한다.
- `PaneLayout.root`를 `flattenPaneTree()`로 평탄화하여 Pane 순서를 결정한다.
- 스와이프 인식 기준: X축 delta > 50px, Y축 delta < X축 delta (의도적 횡 스와이프).
- 스와이프 애니메이션: `transform: translateX()`, `transition: 300ms ease-out`.
- 현재 Pane 양 옆에 이전/다음 Pane을 미리 렌더링한다 (부드러운 전환).
- 세로 스크롤(터미널 스크롤백)과 충돌하지 않도록 `touch-action: pan-y`를 설정한다.
- **터치 이벤트 레이어링**: 스와이프 제스처는 터미널 영역 위에 투명 터치 레이어를 배치하여 인식한다. 터치 시작 후 50ms 이내에 이동 방향이 결정되지 않으면 터치 이벤트를 xterm.js에 passthrough한다. X축 이동이 확정되면 스와이프로 처리하고, Y축 이동이 확정되면 터미널 스크롤로 위임한다.
- xterm.js의 터치 기반 텍스트 선택은 롱프레스(500ms) 후 시작되므로, 50ms 방향 판정과 충돌하지 않는다.

**Acceptance Criteria**
- AC-6302-1: 오른쪽 스와이프 시 다음 Pane으로 전환된다.
- AC-6302-2: 첫 번째 Pane에서 왼쪽 스와이프 시 이동하지 않는다 (바운스 효과).
- AC-6302-3: 세로 스크롤(터미널 스크롤백)이 정상 동작한다.

#### FR-6303: Pane 인디케이터

- 캐러셀 상단에 도트 인디케이터를 표시한다.
  - 현재 Pane: 채워진 원 (`●`)
  - 다른 Pane: 빈 원 (`○`)
- 캐러셀 하단에 위치 텍스트를 표시한다: `[1/3] Terminal A`.
- 도트 인디케이터 탭으로 직접 해당 Pane으로 이동할 수 있다.

**Acceptance Criteria**
- AC-6303-1: 3개 Pane 상태에서 도트 3개가 표시된다.
- AC-6303-2: 도트 탭 시 해당 Pane으로 즉시 이동한다.

#### FR-6304: 모바일 Pane 추가

- 모바일에서 Pane을 추가하면 캐러셀의 오른쪽 끝에 새 Pane이 추가된다.
- 추가 후 자동으로 새 Pane으로 스와이프 전환된다.
- 트리 구조에서는 루트 노드를 수직 분할하여 새 Pane을 추가한다 (깊은 중첩 방지를 위해, 마지막 리프 분할 대신 루트에서 분할하여 트리 균형을 유지한다).

**Acceptance Criteria**
- AC-6304-1: 모바일에서 Pane 추가 후 새 터미널이 표시되고 도트 수가 증가한다.

#### FR-6306: 모바일 Pane 닫기

- 모바일 캐러셀에서 Pane을 닫으면(롱프레스 메뉴 → "Pane 닫기"):
  - 닫힌 Pane이 현재 표시 중이면 이전 Pane으로 자동 스와이프된다. 이전 Pane이 없으면 다음 Pane으로 이동한다.
  - 도트 인디케이터가 즉시 1개 감소한다.
  - 위치 텍스트(`[N/M]`)가 즉시 업데이트된다.
  - 마지막 Pane에서는 "Pane 닫기" 메뉴 항목이 비활성화된다.

**Acceptance Criteria**
- AC-6306-1: 3개 Pane 중 현재 표시 중인 2번째 Pane을 닫으면 1번째 Pane이 표시되고 도트가 2개로 감소한다.
- AC-6306-2: 마지막 1개 Pane에서 롱프레스 시 "Pane 닫기" 메뉴 항목이 비활성화된다.

#### FR-6307: 모바일 키보드 단축키 대체 수단

- 모바일에서는 Ctrl+B prefix 키보드 단축키를 사용할 수 없다.
- 모든 Pane 조작(분할, 닫기, 줌, 교환)은 롱프레스 컨텍스트 메뉴(FR-6205)로 접근 가능하다.
- 다음 기능 커버리지를 보장한다:

| 데스크톱 단축키 | 모바일 대체 수단 |
|---------------|----------------|
| `Ctrl+B, %` 수직 분할 | 롱프레스 메뉴 → 수직 분할 |
| `Ctrl+B, "` 수평 분할 | 롱프레스 메뉴 → 수평 분할 |
| `Ctrl+B, x` Pane 닫기 | 롱프레스 메뉴 → Pane 닫기 |
| `Ctrl+B, z` 줌 토글 | 롱프레스 메뉴 → 줌 토글 |
| `Ctrl+B, ←→` 포커스 이동 | 스와이프 좌/우 |
| `Ctrl+B, q` 번호 표시 | 도트 인디케이터로 대체 |
| `Ctrl+B, o` 순환 | 스와이프 |

**Acceptance Criteria**
- AC-6307-1: 모바일에서 키보드 없이도 모든 Pane 조작(분할, 닫기, 줌)이 가능하다.

#### FR-6305: 모바일-데스크톱 전환 일관성

- 모바일에서 Pane을 추가/삭제한 후 데스크톱으로 전환하면 분할 레이아웃에 반영된다.
- 데스크톱에서 레이아웃을 변경한 후 모바일로 전환하면 캐러셀에 반영된다.
- 동일한 `PaneLayout` 데이터가 양쪽 렌더러에서 사용되므로 자동으로 일관성이 유지된다.

**Acceptance Criteria**
- AC-6305-1: 데스크톱에서 4분할 후 모바일로 전환하면 4개 도트가 표시된다.

---

### 5.4 프리셋 레이아웃

#### FR-6501: 기본 프리셋 6종

앱 최초 로드 시 IndexedDB `savedLayouts`에 다음 6개 기본 프리셋을 생성한다:

| 이름 | 프리셋 ID | Pane 수 | 트리 구조 |
|------|----------|---------|----------|
| 단일 | `preset-single` | 1 | `PaneLeaf` |
| 좌우 분할 | `preset-vertical-2` | 2 | `PaneSplit(vertical, 0.5, [Leaf, Leaf])` |
| 상하 분할 | `preset-horizontal-2` | 2 | `PaneSplit(horizontal, 0.5, [Leaf, Leaf])` |
| 4분할 | `preset-quad` | 4 | `PaneSplit(h, 0.5, [PaneSplit(v, 0.5, [L,L]), PaneSplit(v, 0.5, [L,L])])` |
| 1+2 (메인+보조) | `preset-main-side` | 3 | `PaneSplit(v, 0.6, [Leaf, PaneSplit(h, 0.5, [L,L])])` |
| 에이전트 모니터 | `preset-agent-monitor` | 3 | `PaneSplit(h, 0.7, [PaneSplit(v, 0.5, [L,L]), Leaf])` |

- `isBuiltIn: true`, 사용자가 삭제할 수 없다.
- 프리셋의 `PaneLeaf.sessionId`는 placeholder(`__placeholder__`)로 저장된다.
- 프리셋 적용 시 placeholder를 실제 생성된 세션 ID로 교체한다.

**Acceptance Criteria**
- AC-6501-1: 앱 최초 로드 후 프리셋 메뉴에 6개 항목이 표시된다.
- AC-6501-2: 기본 프리셋 삭제 시도 시 거부된다.

#### FR-6502: 커스텀 레이아웃 저장

- 사용자는 현재 Pane 레이아웃에 이름을 붙여 저장할 수 있다.
- 이름 입력은 인라인 텍스트 입력 또는 간단한 모달로 제공한다.
- 이름은 1~30자, 한글/영문/숫자/공백/하이픈/언더스코어 허용.
- 동일 이름이 이미 존재하면 덮어쓰기 확인 모달을 표시한다.
- 저장 시 현재 `PaneLayout`의 `sessionId`를 placeholder로 교체하여 범용 재사용이 가능하게 한다.

**Acceptance Criteria**
- AC-6502-1: "나의 레이아웃"이라는 이름으로 저장 후 불러오기 목록에 표시된다.
- AC-6502-2: 동일 이름 저장 시 덮어쓰기 확인 모달이 표시된다.

#### FR-6503: 레이아웃 불러오기

- 저장된 레이아웃(기본 프리셋 + 커스텀) 목록을 표시한다.
- 각 항목에 이름과 Pane 수를 표시한다.
- 선택 시 현재 탭의 모든 기존 Pane/세션을 종료하고, 프리셋에 맞게 새 세션들을 생성하여 레이아웃을 적용한다.
- 적용 전 현재 레이아웃에 변경사항이 있으면 확인 모달을 표시한다: "현재 레이아웃이 초기화됩니다. 계속하시겠습니까?"

**Acceptance Criteria**
- AC-6503-1: "4분할" 프리셋 선택 시 4개의 새 터미널이 2x2 레이아웃으로 생성된다.
- AC-6503-2: 적용 전 확인 모달에서 "취소" 시 기존 레이아웃이 유지된다.

#### FR-6504: 커스텀 레이아웃 삭제

- 커스텀 레이아웃(`isBuiltIn=false`)은 삭제할 수 있다.
- 삭제 확인 모달: "'{이름}' 레이아웃을 삭제하시겠습니까?"
- 기본 프리셋(`isBuiltIn=true`)에는 삭제 옵션이 표시되지 않는다.

**Acceptance Criteria**
- AC-6504-1: 커스텀 레이아웃 삭제 후 목록에서 사라진다.
- AC-6504-2: 기본 프리셋에는 삭제 버튼이 표시되지 않는다.

---

### 5.5 키보드 단축키

#### FR-6601: Ctrl+B Prefix 모드

- `TerminalView`의 `customKeyEventHandler`에서 `Ctrl+B` 키 조합을 감지한다.
- `Ctrl+B` 입력 시 Prefix 모드에 진입한다.
- Prefix 모드에서는 다음 키 입력이 PTY로 전달되지 않고 Pane 명령으로 해석된다.
- Prefix 모드 타임아웃: 1500ms 동안 키 입력이 없으면 자동 해제.
- Prefix 모드 진입/해제는 `usePaneManager`의 상태로 관리한다.
- Prefix 모드 진입 시 StatusBar에 `[PREFIX]` 표시가 나타난다 (노란색 배경).
- 명령 실행 또는 타임아웃 후 Prefix 모드가 해제된다.

**Acceptance Criteria**
- AC-6601-1: Ctrl+B 입력 후 StatusBar에 `[PREFIX]` 표시가 나타난다.
- AC-6601-2: Prefix 모드에서 키 입력이 PTY로 전달되지 않는다.
- AC-6601-3: 1500ms 무입력 시 Prefix 모드가 자동 해제된다.

#### FR-6602: Pane 조작 단축키

Prefix 모드에서 다음 키 매핑을 지원한다:

| 키 | 동작 | tmux 호환 |
|----|------|----------|
| `%` (Shift+5) | 수직 분할 (좌/우) | Yes |
| `"` (Shift+') | 수평 분할 (위/아래) | Yes |
| `←` | 포커스 왼쪽 이동 | Yes |
| `→` | 포커스 오른쪽 이동 | Yes |
| `↑` | 포커스 위쪽 이동 | Yes |
| `↓` | 포커스 아래쪽 이동 | Yes |
| `x` | 현재 Pane 닫기 (확인 포함) | Yes |
| `z` | Pane 줌 토글 | Yes |
| `q` | Pane 번호 오버레이 표시 (2초) | Yes |
| `o` | 다음 Pane으로 포커스 순환 | Yes |

**Acceptance Criteria**
- AC-6602-1: Ctrl+B, % 입력 시 현재 Pane이 좌우로 분할된다.
- AC-6602-2: Ctrl+B, x 입력 시 Pane 닫기 확인 후 닫힌다.
- AC-6602-3: Ctrl+B, q 입력 시 각 Pane에 번호 오버레이가 2초간 표시된다.

#### FR-6603: Pane 번호 오버레이

- Ctrl+B, q 입력 시 각 Pane 중앙에 번호(0부터)를 2초간 오버레이 표시한다.
- 오버레이: 반투명 검정 배경, 큰 흰색 숫자.
- 오버레이 표시 중 숫자 키를 누르면 해당 번호의 Pane으로 포커스가 이동한다.
- 2초 경과 시 자동으로 오버레이가 사라진다.

**Acceptance Criteria**
- AC-6603-1: 3개 Pane에서 Ctrl+B, q 시 0, 1, 2 번호가 표시된다.
- AC-6603-2: 오버레이 표시 중 "1" 입력 시 Pane 1로 포커스가 이동한다.

#### FR-6604: Prefix 모드 에러 처리

- 인식되지 않는 키 입력 시 Prefix 모드가 해제되고, StatusBar에 "Unknown key: {key}" 메시지가 1초간 표시된다.
- 동작이 불가능한 상황(예: 단일 Pane에서 닫기)에서는 동작하지 않고 Prefix 모드만 해제된다.

#### FR-6605: Prefix 키 충돌 방지

- 기존 `Ctrl+B` 동작(터미널의 커서 뒤로 이동)과 충돌한다.
- Prefix 모드가 아닌 상태에서 `Ctrl+B`를 누르면 Prefix 모드로 진입하고, PTY에는 전달하지 않는다.
- 실제 `Ctrl+B`를 PTY에 보내려면 `Ctrl+B, Ctrl+B` (두 번 연속)를 입력한다.

**Acceptance Criteria**
- AC-6605-1: Ctrl+B, Ctrl+B 입력 시 PTY에 `\x02` (Ctrl+B)가 전달된다.

---

## 6. 비기능 요구사항

| ID | 요구사항 | 목표 |
|----|----------|------|
| NFR-6101 | 분할 렌더링 성능 | 8개 Pane 동시 표시 시 프레임 드롭 없음 (60fps 유지) |
| NFR-6102 | 리사이즈 반응성 | 드래그 리사이즈 시 16ms 이내 레이아웃 업데이트 |
| NFR-6103 | IndexedDB 저장 지연 | 저장 완료까지 50ms 이내 |
| NFR-6104 | 앱 로드 시 복원 시간 | IndexedDB에서 레이아웃 복원까지 100ms 이내 |
| NFR-6105 | 모바일 스와이프 반응성 | 스와이프 애니메이션 300ms, 제스처 인식 50ms 이내 |
| NFR-6106 | 메모리 사용량 | 8개 Pane(xterm.js 인스턴스 8개) 시 500MB 이내 |
| NFR-6107 | 모바일 대응 | 360px 너비에서 캐러셀이 정상 동작 |
| NFR-6108 | 접근성 | 키보드만으로 모든 Pane 조작 가능 (마우스 없이) |
| NFR-6109 | SSE 연결 | Pane당 1개 SSE 연결, 비활성 Pane도 연결 유지. 현재 서버는 HTTPS(HTTP/2)로 동작하므로 동일 도메인 동시 연결 6개 제한에 해당하지 않는다. HTTP/1.1 환경에서 7개 이상 Pane 사용 시 StatusBar에 경고를 표시한다. |
| NFR-6110 | 컨텍스트 메뉴 반응 | 우클릭/롱프레스 후 100ms 이내 메뉴 표시 |
| NFR-6111 | 동시 고출력 성능 | 8개 Pane 모두 활발한 출력 수신 시 UI 응답 지연 200ms 이내. 비포커스 Pane의 xterm.js 렌더링을 `requestAnimationFrame` 단위로 배치(batch) 처리하며, 줌 상태에서 비가시 Pane은 렌더링을 일시 중지한다. |
| NFR-6112 | Reflow 최적화 | 브라우저 창 리사이즈 시 모든 Pane의 `FitAddon.fit()`을 `requestAnimationFrame`으로 배치하여 한 프레임 내에서 처리한다. 개별 ResizeObserver 콜백이 연쇄 layout thrashing을 유발하지 않도록 한다. |
| NFR-6113 | 메모리 측정 방법 | NFR-6106의 500MB 기준은 Chrome DevTools Memory 탭의 "JS Heap" + "xterm.js 렌더러 메모리" 합산으로 측정한다. |
| NFR-6114 | 최대 Pane 수 근거 | 8개 제한은 (1) 8 SSE 연결의 네트워크 부하, (2) 8 xterm.js 인스턴스의 DOM 노드 수(약 4000~8000개), (3) 1920x1080 해상도에서 8분할 시 최소 Pane 크기(240x135px) 확보를 종합적으로 고려한 결과이다. 향후 성능 테스트 결과에 따라 상향 가능하다. |

---

## 7. 인터페이스 요구사항

### 7.1 데스크톱 분할 레이아웃

```
┌─────────────────────────────────────┐
│ TabBar: [Layout ▼] [Files] [+]      │
├──────────────┬──────────────────────┤
│              │                      │
│  Terminal A  │     Terminal B       │
│  [focused]   │                      │
│              ├──────────────────────┤
│              │                      │
│              │     Terminal C       │
│              │                      │
├──────────────┴──────────────────────┤
│ StatusBar: [Session: main] [Pane 1/3] [idle] │
└─────────────────────────────────────┘
```

### 7.2 모바일 캐러셀 레이아웃

```
┌─────────────────┐
│ TabBar: [Layout] │
├─────────────────┤
│ ● ○ ○           │  ← 도트 인디케이터
│                 │
│                 │
│   Terminal A    │  ← 전체 너비
│                 │
│                 │
│ [1/3] Term A    │  ← 위치 텍스트
├─────────────────┤
│ StatusBar       │
└─────────────────┘
```

### 7.3 Pane 포커스 시각적 표시

- 포커스된 Pane: 상단 2px `var(--accent-color, #007acc)` 바
- 비포커스 Pane: 표시 없음
- 줌 상태: 포커스 Pane 상단에 "[ZOOMED]" 배지 추가

### 7.4 분할 경계선 (PaneResizer) 스타일

- 기본: 4px, `var(--border-color, #333)`, 반투명
- 호버: 4px, `var(--accent-color, #007acc)`, 불투명
- 드래그 중: 4px, `var(--accent-color)`, 불투명 + 양쪽 Pane에 반투명 오버레이

### 7.5 Pane 번호 오버레이 스타일

- 배경: `rgba(0, 0, 0, 0.7)`, 전체 Pane 덮음
- 숫자: 흰색, 48px, 중앙 정렬, `font-weight: bold`
- 애니메이션: `fadeIn 200ms`

---

## 8. 테스트 요구사항

| TC-ID | 대상 | 테스트 설명 | 기대 결과 |
|-------|------|-------------|-----------|
| TC-6101 | FR-6101 | 단일 Pane에서 수직 분할 | 좌우 2개 Pane 표시, 각각 독립 PTY |
| TC-6102 | FR-6101 | 8개 Pane에서 분할 시도 | 분할 메뉴 비활성화 |
| TC-6103 | FR-6102 | 2개 Pane에서 하나 닫기 | 나머지가 전체 영역 차지, PTY 종료 확인 |
| TC-6104 | FR-6102 | 마지막 Pane 닫기 시도 | 닫기 메뉴 비활성화 |
| TC-6105 | FR-6103 | 경계선 드래그로 리사이즈 | ratio 변경, xterm 자동 맞춤 |
| TC-6106 | FR-6103 | 극단적 리사이즈 (ratio 0.1) | 0.15에서 클램핑 |
| TC-6107 | FR-6104 | Pane 줌 토글 | 줌 상태에서 단일 Pane만 표시, 해제 시 원래 레이아웃 복원 |
| TC-6108 | FR-6105 | 2개 Pane 교환 | 세션이 반대 위치로 이동 |
| TC-6109 | FR-6106 | 방향키로 포커스 이동 | 인접 Pane으로 정확히 이동 |
| TC-6201 | FR-6201 | 터미널 우클릭 | 컨텍스트 메뉴 표시, 항목 동작 확인 |
| TC-6202 | FR-6202 | 경계선 우클릭 | 경계선 메뉴 표시, 균등 분할/방향 전환 확인 |
| TC-6203 | FR-6203 | 프리셋 서브메뉴 선택 | 프리셋 레이아웃 적용 |
| TC-6204 | FR-6204 | 서브메뉴 hover | 서브메뉴 표시, 화면 경계 처리 |
| TC-6205 | FR-6205 | 모바일 롱프레스 | 바텀시트 메뉴 표시 |
| TC-6301 | FR-6301 | 768px 이하 | 캐러셀 모드 전환 |
| TC-6302 | FR-6302 | 좌우 스와이프 | Pane 전환 애니메이션 |
| TC-6303 | FR-6303 | 도트 인디케이터 탭 | 해당 Pane으로 이동 |
| TC-6304 | FR-6304 | 모바일 Pane 추가 | 오른쪽에 추가, 자동 스와이프 |
| TC-6305 | FR-6305 | 모바일→데스크톱 전환 | 레이아웃 일관성 |
| TC-6401 | FR-6401~6406 | 앱 새로고침 후 레이아웃 복원 | IndexedDB에서 정확히 복원 |
| TC-6402 | FR-6407 | 기존 localStorage 데이터 있는 앱 로드 | IndexedDB로 마이그레이션 후 복원 |
| TC-6403 | 4.3 | IndexedDB 미지원 환경 | localStorage 폴백 동작 |
| TC-6501 | FR-6501 | 최초 로드 시 프리셋 생성 | 6개 기본 프리셋 존재 |
| TC-6502 | FR-6502 | 커스텀 레이아웃 저장/불러오기 | 이름으로 저장 후 정확히 복원 |
| TC-6503 | FR-6504 | 기본 프리셋 삭제 시도 | 거부됨 |
| TC-6601 | FR-6601 | Ctrl+B Prefix 모드 진입 | StatusBar [PREFIX] 표시 |
| TC-6602 | FR-6602 | Ctrl+B, % | 수직 분할 |
| TC-6603 | FR-6602 | Ctrl+B, x | Pane 닫기 |
| TC-6604 | FR-6603 | Ctrl+B, q | 번호 오버레이 표시 |
| TC-6605 | FR-6605 | Ctrl+B, Ctrl+B | PTY에 \x02 전달 |
| TC-6606 | FR-6601 | 1500ms 무입력 | Prefix 모드 자동 해제 |
| | | | |
| **엣지케이스 및 오류 처리** | | | |
| TC-6701 | FR-6101 | 네트워크 오프라인에서 Pane 분할 시도 | 에러 메시지 표시, 레이아웃 변경 없음 |
| TC-6702 | FR-6102 | "다른 Pane 모두 닫기" 중 일부 세션 삭제 API 실패 | 실패한 Pane 유지, 성공한 Pane만 제거, 실패 건수 표시 |
| TC-6703 | FR-6104 | 줌 상태에서 줌 대상 외 Pane의 서버측 세션 종료 | 줌 해제 시 해당 Pane 트리에서 자동 제거 |
| TC-6704 | FR-6104 | `zoomedPaneId` 설정 상태에서 앱 새로고침 | 줌 상태 복원 |
| TC-6705 | FR-6306 | 모바일 캐러셀에서 현재 Pane 닫기 | 이전 Pane으로 자동 스와이프, 인디케이터 감소 |
| TC-6706 | FR-6105 | Pane 교환 모드 중 우클릭 메뉴 열기 | 교환 모드 유지, 메뉴에서 다른 동작 선택 시 교환 취소 |
| TC-6707 | FR-6604 | Prefix 모드에서 인식 불가 키 입력 (예: Ctrl+B, 1) | Prefix 해제, "Unknown key: 1" 메시지 1초 표시 |
| TC-6708 | FR-6407 | localStorage에 손상된 JSON 데이터 상태에서 마이그레이션 | 파싱 실패, 기본 단일 Pane으로 초기화, localStorage 데이터 유지 |
| TC-6709 | 3.2 | 정확히 깊이 4인 트리에서 추가 분할 시도 | 분할 메뉴 비활성화 |
| TC-6710 | 4.3 | 앱 로드 시 IndexedDB의 sessionId가 서버에 없음 | 해당 Pane 자동 제거, 남은 Pane으로 레이아웃 재구성 |
| TC-6711 | FR-6102 | Pane 닫기 후 SSE EventSource 종료 확인 | DevTools Network에서 연결 종료 확인 |
| TC-6712 | FR-6305 | 데스크톱에서 4분할 후 모바일로 전환 후 다시 데스크톱 | 4분할 레이아웃 일관성 유지 |
| | | | |
| **paneTree 유틸리티 단위 테스트** | | | |
| TC-6801 | 3.3 | `splitPane`: 루트 PaneLeaf 분할 | PaneSplit 반환, ratio=0.5, 자식 2개 |
| TC-6802 | 3.3 | `closePane`: 루트가 대상 | null 반환 |
| TC-6803 | 3.3 | `closePane`: 2레벨 트리에서 리프 닫기 | 형제가 루트로 승격 |
| TC-6804 | 3.3 | `resizePane`: ratio 0.1 입력 | 0.15로 클램핑 |
| TC-6805 | 3.3 | `flattenPaneTree`: 4분할 트리 | 4개 PaneLeaf 배열 반환 |
| TC-6806 | 3.3 | `getAdjacentPane`: 수직 분할에서 왼쪽 Pane의 right 이동 | 오른쪽 Pane 반환 |
| TC-6807 | 3.3 | `buildPresetLayout`: sessionIds 수 불일치 | 에러 throw |
| | | | |
| **비기능 요구사항 검증** | | | |
| TC-NFR-01 | NFR-6101 | 8 Pane 동시 표시 | Chrome DevTools Performance에서 60fps 확인 |
| TC-NFR-02 | NFR-6106 | 8 Pane 운용 시 메모리 | Chrome Task Manager에서 500MB 이하 |
| TC-NFR-03 | NFR-6107 | 360px 너비 뷰포트 | 캐러셀 정상 동작, 도트 인디케이터 8개 표시 가능 |
| TC-NFR-04 | NFR-6108 | 키보드만으로 Pane 조작 | Tab 키 + Ctrl+B prefix로 모든 조작 가능 |
| TC-NFR-05 | NFR-6111 | 8 Pane 동시 활발한 출력 | UI 응답 지연 200ms 이내 |

---

## 9. 구현 단계

### Phase 1: 기반 인프라

1. **IndexedDB 모듈**: `paneDb.ts` (스키마, 트랜잭션 헬퍼), `usePaneDB.ts` (React 훅)
2. **PaneNode 트리 유틸**: `paneTree.ts` (순수 함수 전체 구현)
3. **localStorage 마이그레이션**: 기존 탭 상태 변환 로직
4. **기본 프리셋 초기화**: 6개 기본 프리셋 데이터 정의

### Phase 2: 데스크톱 Pane 분할

1. **`usePaneManager` 훅**: Pane 상태 관리 (분할, 닫기, 리사이즈, 포커스, 줌)
2. **`SplitPane` 컴포넌트**: 재귀 PaneNode 렌더러
3. **`PaneResizer` 컴포넌트**: 드래그 리사이즈 핸들
4. **`App.tsx` 통합**: 기존 탭 콘텐츠 영역에 PaneRenderer 연결
5. **TerminalContainer 연동**: 기존 인터페이스 유지하며 Pane 내 배치

### Phase 3: 컨텍스트 메뉴

1. **ContextMenu 서브메뉴 확장**: `children` 필드, 호버 서브메뉴
2. **Pane 컨텍스트 메뉴**: FR-6201 전체 항목 구현
3. **경계선 컨텍스트 메뉴**: FR-6202 항목 구현
4. **TabBar 메뉴 확장**: 프리셋/저장/불러오기 항목 추가

### Phase 4: 모바일 캐러셀

1. **`PaneCarousel` 컴포넌트**: 횡 스와이프 엔진, 터치 제스처
2. **`PaneIndicator` 컴포넌트**: 도트 인디케이터 + 위치 텍스트
3. **`PaneRenderer` 컴포넌트**: 반응형 분기 (데스크톱/모바일)
4. **모바일 롱프레스 메뉴**: 바텀시트 스타일 컨텍스트 메뉴

### Phase 5: 키보드 단축키

1. **Prefix 모드 상태 머신**: `TerminalView` customKeyEventHandler 확장
2. **Pane 조작 단축키**: 분할/닫기/포커스이동/줌 키 바인딩
3. **Pane 번호 오버레이**: 오버레이 컴포넌트 + 숫자 키 입력 처리
4. **StatusBar Prefix 표시**: 상태 연동

### Phase 6: 회귀 검증

1. **기존 탭 기능 회귀**: 파일 탭, 뷰어 탭 정상 동작 확인
2. **기존 세션 관리 회귀**: 세션 생성/삭제/이름변경/재정렬 정상 동작 확인
3. **모바일 레이아웃 회귀**: 사이드바, 탭바, 기존 모바일 기능 정상 동작 확인
4. **성능 검증**: 8 Pane 동시 운영 시 프레임 드롭 테스트

---

## 10. 제약사항

| 제약 | 설명 |
|------|------|
| 백엔드 변경 없음 | `SessionManager`, API 엔드포인트 등 백엔드 코드 변경 불필요 |
| 라우터 미도입 | 기존 view state 패턴 유지 |
| 외부 라이브러리 최소화 | 스와이프 엔진, 분할 렌더러 모두 자체 구현 (의존성 추가 지양) |
| xterm.js 호환 | xterm.js 6.x FitAddon의 ResizeObserver 기반 자동 맞춤에 의존 |
| 기존 탭 구조 유지 | 파일 탭, 뷰어 탭은 기존 동작 그대로 (Pane 분할은 터미널 탭에만 적용) |

---

## 11. 문서 이력

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-03-21 | Claude | Initial Step 6 SRS for tmux-style Pane Split system |
| 2.0.0 | 2026-03-21 | Claude | Round 2: 28개 개선사항 적용 — 전문가 만장일치 A+ 달성 |

---

## Appendix A: Expert Evaluation Summary

### Evaluation Targets
- 요구사항 완전성
- 구현 명확성
- 이전 버전 일관성
- 모바일 UX 적합성
- 데이터 영속성 안정성
- 성능 및 확장성
- 테스트 가능성

### Round 1 Result

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|:---:|:---:|:---:|
| 요구사항 완전성 | A | A | A |
| 구현 명확성 | A | A+ | A+ |
| 이전 버전 일관성 | A | A | A+ |
| 모바일 UX 적합성 | A- | A- | A |
| 데이터 영속성 안정성 | A- | A | A+ |
| 성능 및 확장성 | A- | A | A- |
| 테스트 가능성 | A | A- | A |

### Round 2 Improvements Applied

1. PTY 세션 생성 실패 시 트리 롤백 정책 추가 (FR-6101)
2. `usePaneManager` 훅 전체 인터페이스 정의 추가 (섹션 3.4)
3. `getAdjacentPane` 시각적 위치 기반 알고리즘 명시 (섹션 3.5)
4. SSE EventSource 해제 절차 명시 (FR-6102)
5. "다른 Pane 모두 닫기" 부분 실패 처리 정책 추가 (FR-6102)
6. 탭 닫기 시 Pane 일괄 종료 절차 추가 (FR-6102)
7. `RuntimeConfigStore` 연동 명시 (섹션 2, FR-6101)
8. `childSessionIds` → `allSessionIds` computed value 전환 전략 명시 (섹션 3.4)
9. `screen` state 관계 명시 (섹션 2)
10. 모바일 스와이프-터치 충돌 레이어링 전략 상세화 (FR-6302)
11. 모바일 Pane 닫기 흐름 추가 (FR-6306)
12. 모바일 키보드 단축키 대체 수단 커버리지 매핑 추가 (FR-6307)
13. 모바일 Pane 추가 시 트리 균형 전략 수정 (FR-6304)
14. 태블릿 터치 타겟 20px 확장 (FR-6103)
15. IndexedDB 버전 업그레이드 정책 추가 (섹션 4.1)
16. `savedLayouts` byName 인덱스 non-unique 변경 (섹션 4.1)
17. QuotaExceededError 처리 추가 (섹션 4.3)
18. 앱 로드 시 서버 세션 정합성 검증 추가 (섹션 4.3, 4.4)
19. `beforeunload` → `visibilitychange` 전략 수정 (섹션 4.4)
20. "세션 연결 변경" Step 7 이연 명시 (섹션 1.3)
21. SSE 동시 연결 HTTP/2 전제 조건 및 HTTP/1.1 경고 추가 (NFR-6109)
22. 동시 고출력 성능 NFR 추가 (NFR-6111)
23. Reflow 최적화 NFR 추가 (NFR-6112)
24. 메모리 측정 방법 명시 (NFR-6113)
25. 최대 Pane 수 8개 근거 명시 (NFR-6114)
26. 엣지케이스 테스트 12개 추가 (TC-6701~TC-6712)
27. paneTree 단위 테스트 7개 추가 (TC-6801~TC-6807)
28. NFR 검증 테스트 5개 추가 (TC-NFR-01~05)

### Round 2 Result (Final)

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|:---:|:---:|:---:|
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 이전 버전 일관성 | A+ | A+ | A+ |
| 모바일 UX 적합성 | A+ | A+ | A+ |
| 데이터 영속성 안정성 | A+ | A+ | A+ |
| 성능 및 확장성 | A+ | A+ | A+ |
| 테스트 가능성 | A+ | A+ | A+ |

### Review Notes
- **기술 아키텍트**: `usePaneManager` 인터페이스가 `useTabManager`와 동급으로 정의되어 구현 진입이 명확해졌다. SSE 연결 제한, Reflow 최적화, 세션 정합성 검증이 추가되어 실운영 안정성이 확보되었다.
- **QA 전문가**: 엣지케이스 테스트 12개, 단위 테스트 7개, NFR 검증 테스트 5개 추가로 총 51개 TC가 되었다. `beforeunload` 동기 저장 이슈가 `visibilitychange`로 수정되어 데이터 손실 위험이 해소되었다.
- **비즈니스 분석가**: 모바일 Pane 닫기 흐름과 키보드 대체 수단 매핑이 추가되어 모바일 사용자 경험이 완전해졌다. "세션 연결 변경"의 명시적 Step 7 이연으로 범위가 명확해졌다.
