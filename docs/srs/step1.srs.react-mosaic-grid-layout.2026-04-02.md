# SRS: React Mosaic 기반 그리드 레이아웃 시스템

**문서 ID**: SRS-MOSAIC-001
**작성일**: 2026-04-03
**버전**: 1.2 (검증 완료)
**상태**: Final
**기반 PRD**: PRD-MOSAIC-001 v1.2 Final
**작성 방식**: SRS-QNA (3인 분석 + Agent Dropout)

---

## 1. 개요

### 1.1 목적

BuilderGate의 그리드 모드 레이아웃을 CSS Grid 기반에서 React Mosaic v6.1.1 기반 타일형 레이아웃으로 전환한다. 드래그 앤 드롭 창 재배치, 사용자 크기 조절, 3가지 크기 모드(균등/포커스/오토)를 구현하고, 향후 파일트리·코드 뷰어 등 비터미널 패널 배치를 위한 확장 가능 구조를 구축한다.

### 1.2 범위

| 포함 | 제외 |
|------|------|
| React Mosaic 타일 레이아웃 (FR-1) | 키보드 단축키 레이아웃 조작 |
| 터미널 컨텍스트 메뉴 (FR-2) | 비터미널 패널 배치 (구조만 지원) |
| 세션 생성/닫기 동작 (FR-3) | 레이아웃 프리셋 저장/불러오기 |
| 크기 모드 아이콘 박스 (FR-4) | 다중 모니터 지원 |
| 포커스 확대 모드 (FR-5) | 에이전트 오케스트레이션 UI |
| 오토 모드 (FR-6) | |
| 레이아웃 영속화 (FR-7) | |

### 1.3 기술 결정 사항 (QNA 확정)

| 결정 | 선택 | 근거 |
|------|------|------|
| Mosaic leaf ID 타입 | `tabId` (string) | 워크스페이스 내 고유, 서버와 직접 매핑 |
| 포커스 확대 알고리즘 | 기존 트리 유지 + 조상 splitPercentage 조정 | 사용자 배치 보존 |
| 오토 모드 전략 | 현재 트리 유지 + 최선 근사치 | 배치 변경 최소화 |
| addTab cwd 파라미터 | 프론트~서버 전 계층 추가 | 깔끔한 API |
| 서버 GridLayout 스키마 | Breaking change (기존 필드 제거) | 레거시 호환 불필요 |
| React Mosaic 버전 | v6.1.1 고정 (`@^6`) | 안정, PRD 이진 트리 설계 일치 |
| ConfirmModal 위치 | MosaicContainer 내부 | 관심사 로컬화 |
| 모드 전환 애니메이션 | 즉시 전환 (16ms 이내 적용) | Mosaic inline style 제약으로 CSS transition 불가. PRD FR-5 수용 조건의 "200~300ms transition" 요건을 폐기하고 "즉시 적용(16ms 이내)" 대체 기준 채택 |
| 다중 idle 균등 확대 전략 | 비율 근사 (±30% 보정) | PRD "idle 균등 확대" 요건에 대해, 이진 트리에서 비인접 leaf의 true 균등은 트리 재구성이 필요하여 UX 훼손. 배치 변경 최소화를 우선하여 근사치 전략 채택 |
| 저장소 | localStorage 전용 | beforeunload 동기 제약 |
| localStorage 스키마 | `schemaVersion: 1` 필드 포함 | 마이그레이션 대비 |
| Blueprint CSS | 미도입 | 커스텀 CSS 유지 |
| Clipboard 실패 | toast 알림 | 비치명적 실패 |
| 세션 생성 실패 | Mosaic 트리 rollback | 고스트 슬롯 방지 |

---

## 2. 기능 요구사항

### FR-1: React Mosaic 그리드 레이아웃

#### FR-1.1: MosaicContainer 컴포넌트

**파일**: `frontend/src/components/Grid/MosaicContainer.tsx` (신규, GridContainer.tsx 대체)

```typescript
import { Mosaic, MosaicWindow, MosaicNode, MosaicDirection } from 'react-mosaic-component';

interface MosaicContainerProps {
  tabs: WorkspaceTabRuntime[];
  workspaceId: string;
  layoutMode: LayoutMode;
  onAddTab: (cwd?: string) => void;
  onCloseTab: (tabId: string) => void;
  onRestartTab: (tabId: string) => void;
  renderTerminal: (tab: WorkspaceTabRuntime) => React.ReactNode;
  onLayoutModeChange: (mode: LayoutMode) => void;
}

export function MosaicContainer(props: MosaicContainerProps): JSX.Element;
```

**내부 상태**:
```typescript
const [mosaicTree, setMosaicTree] = useState<MosaicNode<string> | null>(null);
const [confirmTarget, setConfirmTarget] = useState<string | null>(null); // 닫기 확인 모달
```

**Mosaic 렌더링**:
```typescript
<Mosaic<string>
  value={mosaicTree}
  onChange={handleMosaicChange}
  renderTile={(tabId, path) => (
    <MosaicTile
      tabId={tabId}
      tab={tabMap.get(tabId)}
      path={path}
      layoutMode={layoutMode}
      onContextMenu={handleTileContextMenu}
      onLayoutModeChange={(mode) => {
        // 포커스 모드 시 현재 타일의 tabId를 focusTarget으로 전달
        if (mode === 'focus') {
          onLayoutModeChange('focus');
          layoutModeHook.setMode('focus', tabId);
        } else {
          onLayoutModeChange(mode);
        }
      }}
    >
      {renderTerminal(tabMap.get(tabId)!)}
    </MosaicTile>
  )}
  resize={{ minimumPaneSizePercentage: getMinPercentage(tabs.length) }}
  className="mosaic-buildergate"
/>
```

**`handleMosaicChange` 콜백**:
```typescript
function handleMosaicChange(newTree: MosaicNode<string> | null): void {
  // 1. 최소 크기 클램핑 (resize prop이 처리하나 안전장치)
  const clamped = clampSplitPercentages(newTree, minPercent);
  setMosaicTree(clamped);

  // 2. 오토 모드 중 사용자 수동 리사이즈 감지 → 균등 모드 전환
  if (layoutMode === 'auto' && isUserDrag.current) {
    onLayoutModeChange('equal');
  }

  // 3. 레이아웃 저장 디바운스 (1초)
  debouncedSave(clamped);
}
```

**사용자 드래그 vs 프로그래매틱 변경 구분**:
```typescript
const isUserDrag = useRef(false);

// Mosaic의 분할선 드래그 시작/종료 감지
// MosaicWindow 내 .mosaic-split 요소에 pointerdown/pointerup 리스너
useEffect(() => {
  const container = containerRef.current;
  if (!container) return;

  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.mosaic-split')) {
      isUserDrag.current = true;
    }
  };
  const onPointerUp = () => { isUserDrag.current = false; };

  container.addEventListener('pointerdown', onPointerDown);
  document.addEventListener('pointerup', onPointerUp);
  return () => {
    container.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointerup', onPointerUp);
  };
}, []);
```

#### FR-1.2: 최소 크기 비율 함수

```typescript
function getMinPercentage(sessionCount: number): number {
  if (sessionCount <= 2) return 15;
  if (sessionCount === 3) return 10;
  if (sessionCount === 4) return 8;
  if (sessionCount <= 6) return 6;
  return 5; // 7~8
}
```

#### FR-1.3: 균등 Mosaic 트리 생성

```typescript
function buildEqualMosaicTree(ids: string[]): MosaicNode<string> {
  if (ids.length === 0) return ids[0]; // 불가능 케이스
  if (ids.length === 1) return ids[0];
  if (ids.length === 2) {
    return { direction: 'row', first: ids[0], second: ids[1], splitPercentage: 50 };
  }
  const mid = Math.ceil(ids.length / 2);
  const depth = getTreeDepth(ids.length); // 재귀 깊이 계산
  return {
    direction: depth % 2 === 0 ? 'row' : 'column',
    first: buildEqualMosaicTree(ids.slice(0, mid)),
    second: buildEqualMosaicTree(ids.slice(mid)),
    splitPercentage: (mid / ids.length) * 100,
  };
}

// 정본: Math.ceil 사용. N=3일 때 depth=2 → direction='column' (행/열 교차 보장)
function getTreeDepth(n: number): number {
  return Math.ceil(Math.log2(Math.max(n, 1)));
}
```

#### FR-1.4: 모바일 그리드 비활성화

```typescript
// useResponsive() 훅의 isMobile 판정 활용
// App.tsx 또는 WorkspaceTabBar에서:
if (isMobile && workspace.viewMode === 'grid') {
  // 그리드 모드 전환 버튼 비활성화
  // 강제로 탭 모드 표시
}
```

---

### FR-2: 세션 터미널 컨텍스트 메뉴

#### FR-2.1: MosaicTile에 컨텍스트 메뉴 바인딩

**파일**: `frontend/src/components/Grid/MosaicTile.tsx` (신규)

```typescript
interface MosaicTileProps {
  tabId: string;
  tab: WorkspaceTabRuntime | undefined;
  path: MosaicBranch[];
  layoutMode: LayoutMode;
  onContextMenu: (x: number, y: number, tabId: string) => void;
  onLayoutModeChange: (mode: LayoutMode) => void;
  children: React.ReactNode;
}

export function MosaicTile({ tabId, tab, path, layoutMode, onContextMenu, onLayoutModeChange, children }: MosaicTileProps) {
  const longPressRef = useLongPress((e) => {
    onContextMenu(e.clientX, e.clientY, tabId);
  }, 500);

  return (
    <div
      className="mosaic-tile-wrapper"
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY, tabId);
      }}
      {...longPressRef}
    >
      <MosaicToolbar
        layoutMode={layoutMode}
        onLayoutModeChange={onLayoutModeChange}
      />
      <div className="mosaic-tile-content">
        {tab ? children : <EmptyCell onAdd={() => {}} />}
      </div>
      {tab && <MetadataRow tab={tab} isOdd={false} />}
      {tab?.status === 'disconnected' && (
        <DisconnectedOverlay onRestart={() => {}} />
      )}
    </div>
  );
}
```

#### FR-2.2: 컨텍스트 메뉴 아이템 구성

```typescript
function buildTerminalContextMenuItems(
  tab: WorkspaceTabRuntime,
  terminal: TerminalHandle | null,
  onNewSession: (cwd: string) => void,
  onCloseSession: (tabId: string) => void,
  onCopy: () => void,
  onPaste: () => void,
): ContextMenuItem[] {
  const hasSelection = terminal?.hasSelection?.() ?? false;

  return [
    {
      label: '새 세션 열기',
      icon: '+',
      onClick: () => onNewSession(tab.cwd),
    },
    {
      label: '세션 닫기',
      icon: '×',
      destructive: true,
      onClick: () => onCloseSession(tab.id),
    },
    { separator: true },
    {
      label: '복사',
      shortcut: 'Ctrl+C',
      disabled: !hasSelection,
      onClick: onCopy,
    },
    {
      label: '붙여넣기',
      shortcut: 'Ctrl+V',
      onClick: onPaste,
    },
  ];
}
```

#### FR-2.3: 복사/붙여넣기 구현

```typescript
async function handleCopy(terminal: TerminalHandle): Promise<void> {
  const selection = terminal.getSelection();
  if (!selection) return;
  try {
    await navigator.clipboard.writeText(selection);
    terminal.clearSelection();
  } catch (err) {
    showToast('클립보드 복사 실패: 브라우저 권한을 확인하세요', 'warning');
  }
}

async function handlePaste(onInput: (data: string) => void): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) onInput(text);
  } catch (err) {
    showToast('클립보드 붙여넣기 실패: 브라우저 권한을 확인하세요', 'warning');
  }
}
```

#### FR-2.4: 롱프레스 훅 (모바일)

```typescript
// frontend/src/hooks/useLongPress.ts (신규)
interface UseLongPressReturn {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
  onTouchMove: () => void;
}

function useLongPress(
  callback: (e: { clientX: number; clientY: number }) => void,
  ms: number = 500,
): UseLongPressReturn {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchPosRef.current = { x: touch.clientX, y: touch.clientY };
    timerRef.current = setTimeout(() => {
      callback({ clientX: touch.clientX, clientY: touch.clientY });
      // 진동 피드백 (지원 시)
      navigator.vibrate?.(50);
    }, ms);
  }, [callback, ms]);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  return { onTouchStart, onTouchEnd: cancel, onTouchMove: cancel };
}
```

---

### FR-3: 세션 생성/닫기 동작

#### FR-3.1: addTab API cwd 파라미터 추가

**프론트엔드 변경**:
```typescript
// useWorkspaceManager.ts
addTab: (workspaceId: string, shell?: string, name?: string, cwd?: string) => Promise<void>

// 구현
const addTab = useCallback(async (workspaceId: string, shell?: string, name?: string, cwd?: string) => {
  try {
    const tab = await workspaceApi.addTab(workspaceId, shell, name, cwd);
    setWorkspaces(prev => prev.map(w =>
      w.id === workspaceId ? { ...w, activeTabId: tab.id } : w
    ));
  } catch (err: any) {
    setError(err.message);
  }
}, []);
```

**API 변경**:
```typescript
// services/api.ts
addTab(workspaceId: string, shell?: string, name?: string, cwd?: string): Promise<WorkspaceTab> {
  return this.post(`/api/workspaces/${workspaceId}/tabs`, { shell, name, cwd });
}
```

**서버 변경**:
```typescript
// workspaceRoutes.ts - POST /:id/tabs
const { shell, name, cwd } = req.body;
const tab = await workspaceService.addTab(workspaceId, shell, name, cwd);

// WorkspaceService.ts
async addTab(workspaceId: string, shell?: string, name?: string, cwd?: string): Promise<WorkspaceTab> {
  const session = await sessionManager.createSession({ shell, cwd });
  // ...
}
```

#### FR-3.2: 세션 추가 시 Mosaic 트리 균등 재배치

```typescript
// MosaicContainer 내부
function handleAddSession(cwd?: string): void {
  onAddTab(cwd); // 서버에 세션 생성 요청

  // WebSocket 'tab:added' 이벤트 수신 후 트리 재구성:
  // useEffect에서 tabs 변경 감지 → 새 탭 발견 시:
  const newTabIds = tabs.map(t => t.id);
  const newTree = buildEqualMosaicTree(newTabIds);
  setMosaicTree(newTree);
  // 새 세션으로 포커스 이동
  focusSession(newTabId);
}
```

**실패 시 롤백**:
```typescript
// addTab API 실패 시 Mosaic 트리 변경하지 않음
// WS 'tab:added' 이벤트가 오지 않으므로 자연스러운 롤백
```

#### FR-3.3: 세션 닫기 (확인 모달 + 포커스 이동)

```typescript
// MosaicContainer 내부
const [confirmTarget, setConfirmTarget] = useState<string | null>(null);

function handleCloseRequest(tabId: string): void {
  setConfirmTarget(tabId); // 모달 표시
}

async function handleCloseConfirm(): Promise<void> {
  if (!confirmTarget) return;

  // 1. 마지막 사용 세션 결정
  const nextFocusTabId = focusHistory.getPrevious(confirmTarget);

  // 2. 서버에 삭제 요청
  await onCloseTab(confirmTarget);

  // 3. Mosaic 트리에서 제거
  const newTree = removeFromMosaicTree(mosaicTree, confirmTarget);

  // 4. 마지막 세션이면 빈 트리
  if (newTree === null) {
    setMosaicTree(null);
  } else {
    setMosaicTree(newTree);
    // 5. 포커스 이동
    if (nextFocusTabId) focusSession(nextFocusTabId);
  }

  setConfirmTarget(null);
}

// Mosaic 트리에서 leaf 제거
function removeFromMosaicTree(
  tree: MosaicNode<string> | null,
  tabId: string,
): MosaicNode<string> | null {
  if (tree === null) return null;
  if (typeof tree === 'string') return tree === tabId ? null : tree;
  if (tree.first === tabId) return tree.second as MosaicNode<string>;
  if (tree.second === tabId) return tree.first as MosaicNode<string>;
  const newFirst = removeFromMosaicTree(tree.first, tabId);
  const newSecond = removeFromMosaicTree(tree.second, tabId);
  if (newFirst === null) return newSecond;
  if (newSecond === null) return newFirst;
  return { ...tree, first: newFirst, second: newSecond };
}
```

#### FR-3.4: 포커스 히스토리 훅

**파일**: `frontend/src/hooks/useFocusHistory.ts` (신규)

```typescript
interface UseFocusHistoryReturn {
  recordFocus: (tabId: string) => void;
  getPrevious: (excludeTabId: string) => string | null;
  getHistory: () => string[];
}

export function useFocusHistory(): UseFocusHistoryReturn {
  const historyRef = useRef<string[]>([]);

  const recordFocus = useCallback((tabId: string) => {
    const h = historyRef.current;
    // 중복 제거 후 맨 뒤에 추가
    historyRef.current = [...h.filter(id => id !== tabId), tabId];
    // 최대 20개 유지
    if (historyRef.current.length > 20) {
      historyRef.current = historyRef.current.slice(-20);
    }
  }, []);

  const getPrevious = useCallback((excludeTabId: string): string | null => {
    const h = historyRef.current.filter(id => id !== excludeTabId);
    return h.length > 0 ? h[h.length - 1] : null;
  }, []);

  return { recordFocus, getPrevious, getHistory: () => historyRef.current };
}
```

---

### FR-4: 크기 모드 아이콘 박스

#### FR-4.1: MosaicToolbar 컴포넌트

**파일**: `frontend/src/components/Grid/MosaicToolbar.tsx` (신규)

```typescript
type LayoutMode = 'equal' | 'focus' | 'auto';

interface MosaicToolbarProps {
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
}

export function MosaicToolbar({ layoutMode, onLayoutModeChange }: MosaicToolbarProps) {
  const [visible, setVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setVisible(true);
  };

  const handleMouseLeave = () => {
    hideTimerRef.current = setTimeout(() => setVisible(false), 300);
  };

  if (!visible) {
    return (
      <div
        className="mosaic-toolbar-trigger"
        onMouseEnter={handleMouseEnter}
        style={{
          position: 'absolute', top: 4, left: 4,
          width: 24, height: 24, zIndex: 10,
        }}
      />
    );
  }

  return (
    <div
      className="mosaic-toolbar"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        position: 'absolute', top: 4, left: 4, zIndex: 10,
        display: 'flex', gap: 2, padding: '2px 6px',
        backgroundColor: 'rgba(128, 128, 128, 0.4)',
        borderRadius: 6,
      }}
    >
      <ToolbarButton
        icon="⊞"   // 균등
        active={layoutMode === 'equal'}
        onClick={() => onLayoutModeChange('equal')}
        title="균등 분할"
      />
      <ToolbarButton
        icon="⊡"   // 포커스: 클릭한 타일 자신의 tabId를 focusTarget으로 사용
        active={layoutMode === 'focus'}
        onClick={() => onLayoutModeChange('focus')}
        title="포커스 확대"
      />
      <ToolbarButton
        icon="⟳"   // 오토
        active={layoutMode === 'auto'}
        onClick={() => onLayoutModeChange('auto')}
        title="오토"
      />
    </div>
  );
}
```

---

### FR-5: 포커스 확대 모드

#### FR-5.1: 조상 splitPercentage 조정 알고리즘

트리 구조를 유지하면서 특정 leaf만 최대화한다. 루트에서 목표 leaf까지의 경로상 모든 조상 노드의 `splitPercentage`를 재계산한다.

```typescript
function applyFocusMode(
  tree: MosaicNode<string>,
  focusTabId: string,
  minPercent: number,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree;

  const totalLeaves = countLeaves(tree);
  const focusSide = findLeafSide(tree, focusTabId); // 'first' | 'second' | null

  if (focusSide === null) return tree; // focusTabId가 이 서브트리에 없음

  const firstLeaves = countLeaves(tree.first);
  const secondLeaves = countLeaves(tree.second);

  let splitPct: number;
  if (focusSide === 'first') {
    // first 쪽에 포커스 타겟 → first를 크게
    const otherMinTotal = secondLeaves * minPercent;
    splitPct = Math.max(100 - otherMinTotal, minPercent);
  } else {
    // second 쪽에 포커스 타겟 → second를 크게
    const otherMinTotal = firstLeaves * minPercent;
    splitPct = Math.min(otherMinTotal, 100 - minPercent);
  }

  return {
    ...tree,
    splitPercentage: splitPct,
    first: applyFocusMode(tree.first, focusTabId, minPercent),
    second: applyFocusMode(tree.second, focusTabId, minPercent),
  };
}

function findLeafSide(
  tree: MosaicParent<string>,
  targetId: string,
): 'first' | 'second' | null {
  if (containsLeaf(tree.first, targetId)) return 'first';
  if (containsLeaf(tree.second, targetId)) return 'second';
  return null;
}

function containsLeaf(node: MosaicNode<string>, targetId: string): boolean {
  if (typeof node === 'string') return node === targetId;
  return containsLeaf(node.first, targetId) || containsLeaf(node.second, targetId);
}

function countLeaves(node: MosaicNode<string>): number {
  if (typeof node === 'string') return 1;
  return countLeaves(node.first) + countLeaves(node.second);
}
```

---

### FR-6: 오토 모드

#### FR-6.1: 오토 모드 상태 감시 + 트리 조정

```typescript
// useMosaicLayout.ts 내부
useEffect(() => {
  if (layoutMode !== 'auto' || !mosaicTree) return;

  const idleTabs = tabs.filter(t => t.status === 'idle').map(t => t.id);
  const runningTabs = tabs.filter(t => t.status !== 'idle').map(t => t.id);

  let newTree: MosaicNode<string>;

  if (idleTabs.length === 0) {
    // 전부 running → 균등
    newTree = applyEqualMode(mosaicTree);
  } else if (idleTabs.length === 1) {
    // idle 1개 → 포커스 확대
    newTree = applyFocusMode(mosaicTree, idleTabs[0], getMinPercentage(tabs.length));
  } else {
    // idle 여러 개 → 최선 근사치
    // 전략: 각 idle 세션에 대해 포커스 비율의 1/idleCount를 배분
    newTree = applyMultiFocusApprox(mosaicTree, idleTabs, getMinPercentage(tabs.length));
  }

  setMosaicTree(newTree);
}, [tabs.map(t => `${t.id}:${t.status}`).join(','), layoutMode]);
```

#### FR-6.2: 다중 idle 세션 근사 확대

```typescript
function applyMultiFocusApprox(
  tree: MosaicNode<string>,
  idleIds: string[],
  minPercent: number,
): MosaicNode<string> {
  if (typeof tree === 'string') return tree;

  const firstIdleCount = countMatchingLeaves(tree.first, idleIds);
  const secondIdleCount = countMatchingLeaves(tree.second, idleIds);
  const firstTotal = countLeaves(tree.first);
  const secondTotal = countLeaves(tree.second);

  // idle이 많은 쪽에 더 많은 공간 배분
  const totalLeaves = firstTotal + secondTotal;
  const firstIdleRatio = firstIdleCount / Math.max(idleIds.length, 1);
  const secondIdleRatio = secondIdleCount / Math.max(idleIds.length, 1);

  // 기본 균등 비율에서 idle 비율만큼 보정
  const baseSplit = (firstTotal / totalLeaves) * 100;
  const idleBoost = (firstIdleRatio - secondIdleRatio) * 30; // 최대 ±30% 보정
  const splitPct = Math.max(minPercent, Math.min(100 - minPercent, baseSplit + idleBoost));

  return {
    ...tree,
    splitPercentage: splitPct,
    first: applyMultiFocusApprox(tree.first, idleIds, minPercent),
    second: applyMultiFocusApprox(tree.second, idleIds, minPercent),
  };
}
```

---

### FR-7: 레이아웃 영속화

#### FR-7.1: localStorage 스키마

```typescript
interface PersistedMosaicLayout {
  schemaVersion: 1;
  tree: MosaicNode<string>;
  mode: LayoutMode;
  focusTarget: string | null;
  savedAt: string; // ISO 8601
}

const STORAGE_KEY_PREFIX = 'mosaic_layout_';

function saveLayout(workspaceId: string, layout: PersistedMosaicLayout): void {
  try {
    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${workspaceId}`,
      JSON.stringify(layout),
    );
  } catch (err) {
    // quota 초과 시 무시 (치명적이지 않음)
    console.warn('Layout save failed:', err);
  }
}

function loadLayout(workspaceId: string): PersistedMosaicLayout | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${workspaceId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // 스키마 버전 검증
    if (parsed.schemaVersion !== 1) {
      console.warn(`Unknown schema version: ${parsed.schemaVersion}, falling back`);
      return null;
    }
    // 트리 구조 기본 검증
    if (!isValidMosaicTree(parsed.tree)) {
      console.warn('Invalid mosaic tree, falling back');
      return null;
    }
    return parsed;
  } catch {
    return null; // 파싱 실패 → 폴백
  }
}
```

#### FR-7.2: 저장 시점 (디바운스 + beforeunload)

```typescript
// useMosaicLayout.ts
const debouncedSave = useMemo(
  () => debounce((tree: MosaicNode<string>) => {
    saveLayout(workspaceId, {
      schemaVersion: 1,
      tree,
      mode: layoutMode,
      focusTarget: layoutMode === 'focus' ? focusTarget : null,
      savedAt: new Date().toISOString(),
    });
  }, 1000),
  [workspaceId, layoutMode, focusTarget],
);

// beforeunload 즉시 저장
useEffect(() => {
  const handleUnload = () => {
    if (mosaicTree) {
      // debounce 취소 + 즉시 저장
      debouncedSave.cancel();
      saveLayout(workspaceId, {
        schemaVersion: 1,
        tree: mosaicTree,
        mode: layoutMode,
        focusTarget: layoutMode === 'focus' ? focusTarget : null,
        savedAt: new Date().toISOString(),
      });
    }
  };
  window.addEventListener('beforeunload', handleUnload);
  return () => window.removeEventListener('beforeunload', handleUnload);
}, [mosaicTree, workspaceId, layoutMode, focusTarget]);
```

#### FR-7.3: 세션 소멸 시 복원

```typescript
function restoreLayoutWithSessionRecovery(
  persisted: PersistedMosaicLayout,
  currentTabIds: string[],
  createNewSession: (slotId: string) => Promise<string>,
): MosaicNode<string> {
  const persistedIds = extractLeafIds(persisted.tree);
  const validIds = persistedIds.filter(id => currentTabIds.includes(id));
  const missingIds = persistedIds.filter(id => !currentTabIds.includes(id));

  if (missingIds.length === 0) {
    // 모든 세션 존재 → 그대로 복원
    return persisted.tree;
  }

  if (validIds.length === 0) {
    // 전부 소멸 → 균등 그리드 폴백
    return buildEqualMosaicTree(currentTabIds);
  }

  // 부분 소멸 → 트리 구조 유지 + 빈 슬롯에 새 세션 생성
  // missingIds 각각에 대해 createNewSession 호출 후 트리의 leaf ID 교체
  let tree = persisted.tree;
  for (const missingId of missingIds) {
    const newTabId = createNewSession(missingId); // 비동기, 결과를 기다림
    tree = replaceLeafId(tree, missingId, newTabId);
  }
  return tree;
}
```

---

### FR-4~6 통합: 크기 모드 상태 머신

#### 상태 전이표

| 현재 모드 | 이벤트 | 다음 모드 | 액션 |
|-----------|--------|-----------|------|
| `equal` | 균등 버튼 클릭 | `equal` | (no-op) |
| `equal` | 포커스 버튼 클릭 | `focus` | `applyFocusMode(tree, activeTabId, min%)` |
| `equal` | 오토 버튼 클릭 | `auto` | idle 세션 확인 → 적절한 트리 조정 |
| `focus` | 균등 버튼 클릭 | `equal` | `applyEqualMode(tree)` |
| `focus` | 포커스 버튼 클릭 | `focus` | (no-op, 또는 대상 변경) |
| `focus` | 오토 버튼 클릭 | `auto` | idle 세션 확인 → 적절한 트리 조정 |
| `focus` | 포커스 대상 탭 닫힘 | `equal` | `applyEqualMode(tree)` |
| `focus` | 사용자 수동 리사이즈 | `focus` | (허용, 모드 유지) |
| `auto` | 균등 버튼 클릭 | `equal` | `applyEqualMode(tree)` |
| `auto` | 포커스 버튼 클릭 | `focus` | `applyFocusMode(tree, activeTabId, min%)` |
| `auto` | 오토 버튼 클릭 | `auto` | (no-op) |
| `auto` | 사용자 수동 리사이즈 | `equal` | 오토 해제 |
| `auto` | 탭 status 변경 | `auto` | 트리 재조정 (즉시, UI는 바로 반영) |
| `*` | 세션 추가 | `*` (유지) | 균등 재배치 후 현재 모드 재적용 |

#### useLayoutMode 훅

**파일**: `frontend/src/hooks/useLayoutMode.ts` (신규)

```typescript
type LayoutMode = 'equal' | 'focus' | 'auto';

interface UseLayoutModeReturn {
  mode: LayoutMode;
  focusTarget: string | null;
  setMode: (mode: LayoutMode, focusTabId?: string) => void;
  applyToTree: (tree: MosaicNode<string>, tabs: WorkspaceTabRuntime[]) => MosaicNode<string>;
}

export function useLayoutMode(initialMode: LayoutMode = 'equal'): UseLayoutModeReturn {
  const [mode, setModeState] = useState<LayoutMode>(initialMode);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);

  const setMode = useCallback((newMode: LayoutMode, focusTabId?: string) => {
    setModeState(newMode);
    if (newMode === 'focus' && focusTabId) {
      setFocusTarget(focusTabId);
    } else if (newMode !== 'focus') {
      setFocusTarget(null);
    }
  }, []);

  const applyToTree = useCallback((
    tree: MosaicNode<string>,
    tabs: WorkspaceTabRuntime[],
  ): MosaicNode<string> => {
    const minPct = getMinPercentage(tabs.length);

    switch (mode) {
      case 'equal':
        return applyEqualMode(tree);
      case 'focus':
        return focusTarget
          ? applyFocusMode(tree, focusTarget, minPct)
          : applyEqualMode(tree);
      case 'auto': {
        const idleIds = tabs.filter(t => t.status === 'idle').map(t => t.id);
        if (idleIds.length === 0) return applyEqualMode(tree);
        if (idleIds.length === 1) return applyFocusMode(tree, idleIds[0], minPct);
        return applyMultiFocusApprox(tree, idleIds, minPct);
      }
    }
  }, [mode, focusTarget]);

  return { mode, focusTarget, setMode, applyToTree };
}
```

---

## 3. 비기능 요구사항

| ID | 요구사항 | 기준 | 측정 방법 |
|----|---------|------|----------|
| NFR-1 | UI 반응성 | 4~8 타일 드래그/리사이즈 시 50fps 미만 3회 연속 드롭 없음 | Chrome DevTools Performance, 5초 드래그 |
| NFR-2 | 오토 모드 반응 | idle 전환 후 UI 반영 300ms 이내 | status 전환 타임스탬프 vs Mosaic onChange 타임스탬프 |
| NFR-3 | TUI 무결성 | 리사이즈 후 terminal.cols/rows ↔ 컨테이너 크기 ±1 이내 | htop/vim 실행 상태 리사이즈 |
| NFR-4 | 레이아웃 복원 | 동일 브라우저 100% 복원 | splitPercentage 비교 |
| NFR-5 | 번들 크기 | react-mosaic-component + react-dnd 추가분 50KB gzipped 이내 | webpack-bundle-analyzer |

---

## 4. 데이터 요구사항

### 4.1 서버 측 GridLayout 스키마 변경

**기존** (제거):
```typescript
interface GridLayout {
  workspaceId: string;
  columns: number;
  rows: number;
  tabOrder: string[];
  cellSizes: { colWidths: number[]; rowHeights: number[] } | null;
}
```

**신규** (교체):
```typescript
interface GridLayout {
  workspaceId: string;
  mosaicTree: MosaicNode<string> | null;  // null = 균등 기본
}
```

### 4.2 클라이언트 측 타입 변경

**`frontend/src/types/workspace.ts`**:
```typescript
import type { MosaicNode } from 'react-mosaic-component';

export interface GridLayout {
  workspaceId: string;
  mosaicTree: MosaicNode<string> | null;
}
```

### 4.3 레거시 마이그레이션

```typescript
function migrateGridLayout(legacy: any): GridLayout {
  if ('mosaicTree' in legacy) return legacy; // 이미 신규 형식
  if ('tabOrder' in legacy && Array.isArray(legacy.tabOrder)) {
    return {
      workspaceId: legacy.workspaceId,
      mosaicTree: buildEqualMosaicTree(legacy.tabOrder),
    };
  }
  return { workspaceId: legacy.workspaceId, mosaicTree: null };
}
```

---

## 5. 인터페이스 요구사항

### 5.1 서버 API 변경

#### PUT `/api/workspaces/:id/grid`

**요청** (변경):
```json
{
  "mosaicTree": {
    "direction": "row",
    "first": "tab-abc",
    "second": {
      "direction": "column",
      "first": "tab-def",
      "second": "tab-ghi",
      "splitPercentage": 50
    },
    "splitPercentage": 60
  }
}
```

**응답**:
```json
{
  "workspaceId": "ws-123",
  "mosaicTree": { ... }
}
```

#### POST `/api/workspaces/:id/tabs` (변경)

**요청** (cwd 추가):
```json
{
  "shell": "bash",
  "name": "Terminal 3",
  "cwd": "/home/user/project"
}
```

### 5.2 WebSocket 이벤트 (변경 없음)

기존 이벤트 구조 유지. `grid:updated` 이벤트의 payload만 신규 `GridLayout` 형식으로 변경.

```json
{ "type": "grid:updated", "data": { "workspaceId": "ws-123", "mosaicTree": { ... } } }
```

---

## 6. 제약사항

| 제약 | 설명 |
|------|------|
| React Mosaic v6.1.1 고정 | `@^6` 버전 pinning, v7 beta 사용 금지 |
| react-dnd peer dependency | `react-dnd@^16`, `react-dnd-html5-backend@^16` 설치 필요 |
| 모바일 그리드 비활성화 | `useResponsive().isMobile`이면 그리드 모드 전환 불가 |
| localStorage 용량 | 워크스페이스당 ~2KB 이내 (트리 직렬화) |
| Mosaic 애니메이션 | inline style 제약으로 CSS transition 불가, 즉시 전환 |
| 동시 세션 수 | 4~8개 최적화, 8개 초과 시 성능 보장 없음 |

---

## 7. 인수 조건

### TC-1: 기본 그리드 렌더링
- **전제**: 4개 세션이 있는 워크스페이스
- **동작**: 그리드 모드 활성화
- **기대**: React Mosaic이 4개 타일을 `splitPercentage: 50`으로 균등 배치
- **PASS**: 각 타일에 xterm.js 터미널 정상 렌더링, cols/rows가 컨테이너 크기에 맞음
- **FAIL**: 터미널 빈 화면, 문자 격자 깨짐, Mosaic 에러

### TC-2: 드래그 앤 드롭
- **전제**: 4개 타일 균등 배치
- **동작**: 타일 A를 타일 B 옆으로 드래그
- **기대**: Mosaic 트리 재구성, 모든 터미널 정상
- **PASS**: htop/vim 실행 중에도 문자 격자 유지
- **FAIL**: 드래그 중 프리징, 터미널 소실

### TC-3: 크기 조절
- **전제**: 4개 타일
- **동작**: 분할선 극단까지 드래그
- **기대**: splitPercentage ≥ 8% (4세션 기준)
- **PASS**: Mosaic onChange에서 클램핑 확인
- **FAIL**: 타일이 5% 미만, 터미널 문자 잘림

### TC-4: 컨텍스트 메뉴
- **전제**: 그리드 모드, 세션 B 선택 상태
- **동작**: 세션 B 우클릭
- **기대**: 커스텀 메뉴 (새 세션/닫기/복사/붙여넣기)
- **PASS**: 브라우저 기본 메뉴 차단, 복사 비활성(미선택), 새 세션→CWD 동일
- **FAIL**: 기본 메뉴 표시, 복사 활성(미선택)

### TC-5: 크기 모드 전환
- **전제**: 4개 세션, 균등 모드
- **동작**: 포커스 → 오토 → 균등 순 전환
- **PASS 균등**: 모든 splitPercentage = 50 ± 1
- **PASS 포커스**: 현재 타일 76%, 나머지 각 8%
- **PASS 오토(idle 2개)**: idle 타일들이 running보다 큼
- **FAIL**: 모드 전환 무반응, splitPercentage 미변경

### TC-6: 레이아웃 영속화
- **동작**: 레이아웃 변경 → 새로고침
- **PASS**: `mosaic_layout_{id}` 키에 `schemaVersion: 1` 포함, 트리 동일 복원
- **FAIL**: 균등 그리드 폴백 (의도치 않은)

### TC-7: 모바일
- **전제**: 모바일 뷰포트
- **PASS**: 그리드 모드 버튼 비활성, 탭 모드만 동작
- **FAIL**: 그리드 렌더링 시도

### TC-8: 마지막 세션 닫기
- **전제**: 세션 1개
- **동작**: 우클릭 → 닫기 → 확인
- **PASS**: Mosaic 트리 null, 빈 화면, JS 에러 없음
- **FAIL**: 에러 발생

### TC-9: 세션 소멸 복원
- **전제**: 3세션 레이아웃 저장, 서버 재시작(2세션 소멸)
- **PASS**: 트리 구조 유지, 빈 슬롯에 새 세션
- **FAIL**: 균등 폴백 또는 에러

### TC-10: 손상 데이터 폴백
- **동작**: localStorage에 `{invalid json` 주입
- **PASS**: 균등 그리드 폴백, UI 크래시 없음
- **FAIL**: React Error Boundary 발동

### TC-11: splitPercentage 경계값
- **전제**: 8세션 포커스 모드
- **PASS**: 주 타일 65% ± 2, 나머지 각 5% ± 1
- **FAIL**: 비율 불일치

---

## 신규/변경 파일 요약

### 신규 파일 (7개)

| 파일 | 설명 |
|------|------|
| `frontend/src/components/Grid/MosaicContainer.tsx` | Mosaic `<Mosaic>` 래퍼 + ConfirmModal 상태 |
| `frontend/src/components/Grid/MosaicTile.tsx` | 각 타일 래퍼 (컨텍스트 메뉴 + 툴바 + 콘텐츠) |
| `frontend/src/components/Grid/MosaicToolbar.tsx` | 왼쪽 상단 호버 아이콘 박스 |
| `frontend/src/hooks/useMosaicLayout.ts` | Mosaic 트리 상태 + 영속화 + 트리 조작 함수 |
| `frontend/src/hooks/useLayoutMode.ts` | 균등/포커스/오토 상태 머신 |
| `frontend/src/hooks/useFocusHistory.ts` | 세션 사용 순서 추적 |
| `frontend/src/hooks/useLongPress.ts` | 모바일 롱프레스 감지 |

### 변경 파일 (8개)

| 파일 | 변경 |
|------|------|
| `frontend/src/types/workspace.ts` | `GridLayout` 타입 → `mosaicTree` 기반 |
| `frontend/src/hooks/useWorkspaceManager.ts` | `addTab` cwd 파라미터, `updateGrid` 스키마 변경 |
| `frontend/src/components/Grid/index.ts` | 배럴 export 갱신 |
| `frontend/src/components/Terminal/TerminalView.tsx` | `hasSelection()`, `getSelection()` 메서드 TerminalHandle에 추가 |
| `server/src/routes/workspaceRoutes.ts` | PUT grid → mosaicTree, POST tabs → cwd |
| `server/src/services/WorkspaceService.ts` | `updateGridLayout`, `addTab` 시그니처 변경 |
| `server/data/workspaces.json` | GridLayout 스키마 마이그레이션 |
| `frontend/src/App.tsx` | GridContainer → MosaicContainer 교체 |

### 새 의존성

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `react-mosaic-component` | `^6.1.1` | 타일형 레이아웃 |
| `react-dnd` | `^16` | peer dependency |
| `react-dnd-html5-backend` | `^16` | HTML5 드래그 백엔드 |

---

## 후속 파이프라인

- 다음 단계: `snoworca-implementation-planner`
- 입력 인자:
  - SPEC_PATH: `docs/srs/step1.srs.react-mosaic-grid-layout.2026-04-02.md`
  - CODE_PATH: `frontend/src/`
  - LANGUAGE: TypeScript
  - FRAMEWORK: React 18 + Vite
