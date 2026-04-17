# 구현 계획: Grid 모드 터미널 스크롤백 보존

**작성일**: 2026-04-12  
**기반 SRS**: Grid 모드 터미널 스크롤백 보존 명세  
**대상 브랜치**: main

---

## 목차

1. [배경 및 현황 분석](#1-배경-및-현황-분석)
2. [Phase 1: Flat 렌더링 + CSS 위치 연동](#2-phase-1-flat-렌더링--css-위치-연동)
3. [Phase 2: Idle 기반 스냅샷 + localStorage 복원](#3-phase-2-idle-기반-스냅샷--localstorage-복원)
4. [의존성 설치](#4-의존성-설치)
5. [테스트 계획](#5-테스트-계획)
6. [위험 요소 및 주의사항](#6-위험-요소-및-주의사항)

---

## 1. 배경 및 현황 분석

### 1.1 Tab 모드 vs Grid 모드 렌더링 차이

**Tab 모드 (스크롤백 보존됨):**

`App.tsx` L429~488 — `wm.tabs` **전체**를 순회하며 `TerminalContainer`를 항상 DOM에 유지.  
비활성 탭은 `display: none`으로 숨김 → xterm 인스턴스 생존.

```
wm.tabs (전체)
  └─ 각 탭: <div style="display: none | flex">
       └─ <TerminalContainer />   ← DOM에 항상 존재
```

**Grid 모드 (문제 상황):**

`MosaicContainer.tsx` → `renderTile` → `MosaicTile` → `{children}` → `renderTerminal(tab)`.  
`renderTerminal`은 `App.tsx` L313의 콜백으로, `wm.activeWorkspaceTabs`에 속한 탭만 렌더.  
워크스페이스 전환 시 MosaicContainer 자체가 새 workspaceId/tabs로 리렌더 되어  
이전 워크스페이스의 TerminalContainer가 React unmount → xterm dispose → 스크롤백 소실.

```
워크스페이스 A → B 전환 시:
  MosaicContainer(workspaceId=A) unmount
  MosaicContainer(workspaceId=B) mount
  TerminalContainer(sessionA) dispose → 스크롤백 소실
```

### 1.2 현재 renderTerminal 콜백 구조

```typescript
// App.tsx L313 — Grid 모드용 renderTerminal
const renderTerminal = useCallback((tab: WorkspaceTabRuntime) => {
  if (tab.status === 'disconnected') {
    return <div style={{ width: '100%', height: '100%' }} />;
  }
  // ... TerminalContainer 반환
}, [ptySettings.suppressScrollbackClear]);
```

Grid 모드에서 이 콜백은 `MosaicContainer.renderTile → MosaicTile children`으로 전달되어  
Mosaic 셀 내부에 직접 마운트된다. 워크스페이스 전환 → 셀 unmount → 소실.

### 1.3 핵심 제약

- `react-mosaic-component` DnD backend는 단일 인스턴스만 허용 → `MosaicContainer`를 복수로 동시 렌더 불가
- 따라서 "모든 워크스페이스의 MosaicContainer를 동시에 렌더"하는 방식은 불가
- 해결책: Mosaic 셀에는 **placeholder div**만 두고, 실제 터미널은 별도 absolute layer에서 위치 추적

---

## 2. Phase 1: Flat 렌더링 + CSS 위치 연동

### 2.1 개념 설계

```
[기존]
  MosaicContainer
    └─ MosaicWindow
         └─ MosaicTile
              └─ TerminalContainer   ← Mosaic 셀 내부에 실제 xterm

[변경 후]
  MosaicContainer
    └─ MosaicWindow
         └─ MosaicTile
              └─ <div id="grid-placeholder-{tabId}" />   ← 빈 placeholder

  <GridTerminalLayer>   ← MosaicContainer 와 동일 부모의 absolute 레이어
    ├─ <div style="position:absolute; {셀 위치}">   ← 활성 워크스페이스 탭
    │    └─ TerminalContainer(tabId=A)
    ├─ <div style="display:none">   ← 비활성 워크스페이스 탭
    │    └─ TerminalContainer(tabId=B)
    └─ ...
```

### 2.2 위치 동기화 방법

각 placeholder div에 `ResizeObserver`를 부착하고 `getBoundingClientRect()`로  
절대 위치를 읽어 터미널 레이어의 스타일을 업데이트한다.

부모 컨테이너(`position: relative`)를 기준으로 `left, top, width, height` 계산:

```
termStyle.left   = placeholder.getBoundingClientRect().left - container.getBoundingClientRect().left
termStyle.top    = placeholder.getBoundingClientRect().top  - container.getBoundingClientRect().top
termStyle.width  = placeholder.offsetWidth
termStyle.height = placeholder.offsetHeight
```

### 2.3 변경 파일 및 상세 내용

---

#### 2.3.1 신규 파일: `frontend/src/components/Grid/GridTerminalLayer.tsx`

**역할**: 모든 Grid 모드 탭을 flat하게 렌더하고, 활성 워크스페이스 탭을 Mosaic 셀 위치에 맞춰 배치

```typescript
// GridTerminalLayer.tsx — 인터페이스 설계

interface GridTerminalLayerProps {
  // 전체 워크스페이스에 걸친 모든 탭 (aliveWorkspaceIds 필터 적용 후)
  allGridTabs: WorkspaceTabRuntime[];
  // 현재 활성 워크스페이스의 탭 ID 집합
  activeTabIds: Set<string>;
  // 각 탭의 placeholder div를 참조하는 Map (MosaicContainer에서 전달)
  placeholderRefs: React.RefObject<Map<string, HTMLDivElement | null>>;
  // 터미널 컨테이너의 부모 (position:relative 기준점)
  containerRef: React.RefObject<HTMLDivElement>;
  // 터미널 공통 props
  suppressScrollbackClear: boolean;
  onStatusChange: (sessionId: string, status: SessionStatus) => void;
  onCwdChange: (sessionId: string, cwd: string) => void;
  onAuthError: () => void;
  terminalRefsMap: React.RefObject<Map<string, { current: TerminalHandle | null }>>;
}
```

**핵심 구현 로직:**

```typescript
// GridTerminalLayer 내부

// 1. 각 탭별 위치 상태
const [positions, setPositions] = useState<Map<string, DOMRect>>(new Map());

// 2. 활성 탭의 placeholder를 관찰하는 ResizeObserver
useEffect(() => {
  const observers = new Map<string, ResizeObserver>();

  activeTabIds.forEach(tabId => {
    const placeholder = placeholderRefs.current?.get(tabId);
    if (!placeholder) return;

    const updatePosition = () => {
      const container = containerRef.current;
      if (!container || !placeholder) return;
      const pRect = placeholder.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      setPositions(prev => new Map(prev).set(tabId, {
        left: pRect.left - cRect.left,
        top: pRect.top - cRect.top,
        width: pRect.width,
        height: pRect.height,
      } as DOMRect));
    };

    const ro = new ResizeObserver(updatePosition);
    ro.observe(placeholder);
    observers.set(tabId, ro);
    updatePosition(); // 초기 위치 즉시 계산
  });

  return () => observers.forEach(ro => ro.disconnect());
}, [activeTabIds, placeholderRefs]);

// 3. 렌더: 모든 탭을 absolute div로 렌더, 활성 탭만 위치 지정 + 표시
return (
  <>
    {allGridTabs.map(tab => {
      const isActive = activeTabIds.has(tab.id);
      const pos = positions.get(tab.id);
      const style: React.CSSProperties = isActive && pos
        ? {
            position: 'absolute',
            left: pos.left,
            top: pos.top,
            width: pos.width,
            height: pos.height,
            display: 'flex',
          }
        : { display: 'none' };

      return (
        <div key={`grid-term-${tab.id}`} style={style}>
          <TerminalContainer
            ref={...}
            sessionId={tab.sessionId}
            isVisible={isActive}
            suppressScrollbackClear={suppressScrollbackClear}
            onStatusChange={onStatusChange}
            onCwdChange={onCwdChange}
            onAuthError={onAuthError}
          />
        </div>
      );
    })}
  </>
);
```

---

#### 2.3.2 수정: `frontend/src/components/Grid/MosaicContainer.tsx`

**변경 목표**: `renderTile`에서 실제 터미널 대신 placeholder를 반환하도록 변경

**추가할 props:**

```typescript
interface MosaicContainerProps {
  // ... 기존 props
  // Phase 1 추가
  placeholderRefs?: React.RefObject<Map<string, HTMLDivElement | null>>;
}
```

**`renderTile` 변경:**

```typescript
// 변경 전
const renderTile = useCallback((tabId: string, path: MosaicBranch[]) => {
  const tab = tabMap.get(tabId);
  return (
    <MosaicWindow ...>
      <MosaicTile ...>
        {tab ? renderTerminal(tab) : null}   // ← 실제 터미널
      </MosaicTile>
    </MosaicWindow>
  );
}, [...]);

// 변경 후
const renderTile = useCallback((tabId: string, path: MosaicBranch[]) => {
  const tab = tabMap.get(tabId);
  return (
    <MosaicWindow ...>
      <MosaicTile ...>
        {/* placeholder: GridTerminalLayer가 이 div의 위치를 추적 */}
        <div
          ref={(el) => placeholderRefs?.current?.set(tabId, el)}
          data-grid-placeholder={tabId}
          style={{ width: '100%', height: '100%', backgroundColor: 'var(--terminal-bg, #1e1e1e)' }}
        />
      </MosaicTile>
    </MosaicWindow>
  );
}, [...]);
```

**주의**: `renderTerminal` prop은 그대로 유지하되, Grid 모드에서는 호출하지 않는다.  
(Tab 모드와 인터페이스 공유를 위해 prop 자체는 남겨둠)

---

#### 2.3.3 수정: `frontend/src/App.tsx`

**변경 목표**: Grid 모드에서 MosaicContainer + GridTerminalLayer를 함께 렌더

**추가할 상태/refs:**

```typescript
// App.tsx에 추가
const gridPlaceholderRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
const gridContainerRef = useRef<HTMLDivElement>(null);
```

**`allGridTabs` 계산**: LRU alive 워크스페이스의 Grid 모드 탭 전체

```typescript
const allGridTabs = useMemo(() => {
  return wm.tabs.filter(tab => {
    // Grid 모드 워크스페이스의 탭만
    const ws = wm.workspaces.find(w => w.id === tab.workspaceId);
    if (!ws || ws.viewMode !== 'grid') return false;
    // LRU alive 체크
    if (MAX_ALIVE_WORKSPACES > 0 && !aliveWorkspaceIds.has(tab.workspaceId)) return false;
    return true;
  });
}, [wm.tabs, wm.workspaces, aliveWorkspaceIds]);
```

**활성 탭 ID 집합:**

```typescript
const activeGridTabIds = useMemo(() => {
  return new Set(wm.activeWorkspaceTabs.map(t => t.id));
}, [wm.activeWorkspaceTabs]);
```

**렌더 변경:**

```tsx
// 변경 전
{viewMode === 'grid' && !isMobile ? (
  <MosaicContainer
    tabs={wm.activeWorkspaceTabs}
    workspaceId={wm.activeWorkspaceId!}
    renderTerminal={renderTerminal}
    ...
  />
) : null}

// 변경 후
{viewMode === 'grid' && !isMobile ? (
  <div ref={gridContainerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
    <MosaicContainer
      tabs={wm.activeWorkspaceTabs}
      workspaceId={wm.activeWorkspaceId!}
      placeholderRefs={gridPlaceholderRefs}
      renderTerminal={renderTerminal}   // Grid 모드에서는 실제로 호출 안 됨
      ...
    />
    <GridTerminalLayer
      allGridTabs={allGridTabs}
      activeTabIds={activeGridTabIds}
      placeholderRefs={gridPlaceholderRefs}
      containerRef={gridContainerRef}
      suppressScrollbackClear={ptySettings.suppressScrollbackClear}
      onStatusChange={handleTerminalStatusChange}
      onCwdChange={handleCwdChange}
      onAuthError={handleAuthError}
      terminalRefsMap={terminalRefsMap}
    />
  </div>
) : null}
```

**Tab 모드 렌더는 변경 없음** (L429~488 동일 유지).

---

#### 2.3.4 워크스페이스 전환 시 위치 업데이트 흐름

```
사용자가 워크스페이스 B → A로 전환
  ↓
handleSelectWorkspace(wsA.id) 호출
  ↓
wm.activeWorkspaceId 변경 → wm.activeWorkspaceTabs 변경
  ↓
activeGridTabIds (Set) 재계산
  ↓
GridTerminalLayer: activeTabIds prop 변경
  ↓
useEffect 재실행: 새 placeholder들에 ResizeObserver 부착
  ↓
각 placeholder.getBoundingClientRect() → positions 상태 업데이트
  ↓
TerminalContainer div의 style이 새 위치로 업데이트
  ↓
isVisible=true인 탭에서 fit() 호출 (TerminalContainer 기존 로직)
```

**MosaicContainer는 workspaceId가 바뀔 때 리렌더되지만**,  
실제 TerminalContainer는 `GridTerminalLayer`에 있으므로 unmount되지 않는다.

---

#### 2.3.5 Mosaic 드래그/리사이즈 시 위치 동기화

Mosaic 분할선 드래그 시 셀 크기가 변하면 placeholder의 크기도 변한다.  
ResizeObserver가 이를 자동 감지하여 `positions` 상태를 업데이트한다.

단, `requestAnimationFrame` throttle 적용 필요 (드래그 중 과도한 업데이트 방지):

```typescript
const updatePosition = useCallback(() => {
  if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
  rafIdRef.current = requestAnimationFrame(() => {
    // 위치 계산 및 setPositions
    rafIdRef.current = null;
  });
}, []);
```

또한 MosaicContainer의 `onLayoutChange` 콜백이 호출될 때 위치를 강제 재계산한다:

```typescript
// GridTerminalLayer에 추가
useEffect(() => {
  // onLayoutChange 이벤트를 받으면 모든 활성 탭 위치 재계산
  recalculateAllPositions();
}, [onLayoutChangeSignal]); // App.tsx에서 signal 전달
```

---

#### 2.3.6 DisconnectedOverlay 처리

`disconnected` 상태 탭은 GridTerminalLayer에서 특별 처리:

```typescript
// GridTerminalLayer 내부 렌더
{tab.status === 'disconnected' && isActive ? (
  <div style={{ position: 'absolute', ...pos }}>
    <DisconnectedOverlay onRestart={() => onRestartTab(tab.id)} />
  </div>
) : tab.status !== 'disconnected' ? (
  <div style={isActive ? { position: 'absolute', ...pos } : { display: 'none' }}>
    <TerminalContainer ... />
  </div>
) : null}
```

---

### 2.4 변경 전/후 구조 비교

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| 터미널 마운트 위치 | MosaicTile children (셀 내부) | GridTerminalLayer (별도 absolute 레이어) |
| 워크스페이스 전환 시 | TerminalContainer unmount | TerminalContainer 유지, display:none |
| Mosaic 셀 내용 | 실제 xterm | 빈 placeholder div |
| 위치 동기화 | N/A | ResizeObserver → getBoundingClientRect |
| Tab 모드 영향 | N/A | 없음 (코드 경로 분리) |

---

## 3. Phase 2: Idle 기반 스냅샷 + localStorage 복원

### 3.1 개념 설계

```
PTY 출력 수신 (TerminalView.write 호출)
  ↓
idle 감지 타이머 리셋 (clearTimeout + setTimeout 2초)
  ↓
2초간 새 출력 없음
  ↓
SerializeAddon.serialize() 호출
  ↓
localStorage.setItem(`terminal_snapshot_${sessionId}`, snapshot)
  ↓
[브라우저 새로고침]
  ↓
TerminalView mount 시 localStorage에서 복원
  ↓
term.write(restoredSnapshot)
```

### 3.2 의존성 추가

`@xterm/addon-serialize` 패키지 설치 필요.

**설치 명령:**
```bash
cd frontend
npm install @xterm/addon-serialize
```

**package.json 변경:**
```json
{
  "dependencies": {
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-serialize": "^0.13.0",   // 추가
    "@xterm/xterm": "^6.0.0",
    ...
  }
}
```

> **버전 주의**: `@xterm/xterm` 6.x와 호환되는 `@xterm/addon-serialize`는 `0.13.x` 대역.  
> 반드시 `^0.13.0` 이상 사용. (`0.12.x`는 xterm v5 대응)

### 3.3 localStorage 키 명명 규칙

```
키 형식: terminal_snapshot_{sessionId}
예시:   terminal_snapshot_ses_abc123def456
```

- prefix `terminal_snapshot_` 로 통일하여 일괄 정리 가능
- `sessionId` 기준 (tabId가 아닌 sessionId) — 탭 재시작 시 sessionId가 바뀌므로 자동 무효화
- 탭 삭제(`closeTab`) 시 해당 key 삭제

**스냅샷 메타데이터 구조:**
```typescript
interface TerminalSnapshot {
  schemaVersion: 1;
  sessionId: string;
  content: string;       // SerializeAddon.serialize() 결과
  savedAt: string;       // ISO8601
  cols: number;
  rows: number;
}
```

```
키: terminal_snapshot_{sessionId}
값: JSON.stringify(TerminalSnapshot)
```

---

### 3.4 변경 파일 및 상세 내용

---

#### 3.4.1 수정: `frontend/src/components/Terminal/TerminalView.tsx`

**추가할 import:**
```typescript
import { SerializeAddon } from '@xterm/addon-serialize';
```

**추가할 refs:**
```typescript
const serializeAddonRef = useRef<SerializeAddon | null>(null);
const idleSnapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
const lastSnapshotRef = useRef<string | null>(null);  // beforeunload 안전망용
```

**SerializeAddon 초기화** (Terminal 생성 직후):
```typescript
// useEffect 내부, term 생성 후
const serializeAddon = new SerializeAddon();
term.loadAddon(serializeAddon);
serializeAddonRef.current = serializeAddon;
```

**snapshot 저장 함수:**
```typescript
const saveSnapshot = useCallback(() => {
  const term = xtermRef.current;
  const serializeAddon = serializeAddonRef.current;
  if (!term || !serializeAddon) return;
  try {
    const content = serializeAddon.serialize();
    const snapshot: TerminalSnapshot = {
      schemaVersion: 1,
      sessionId,
      content,
      savedAt: new Date().toISOString(),
      cols: term.cols,
      rows: term.rows,
    };
    localStorage.setItem(`terminal_snapshot_${sessionId}`, JSON.stringify(snapshot));
    lastSnapshotRef.current = content;
  } catch (e) {
    console.warn('[TerminalView] snapshot save failed:', e);
  }
}, [sessionId]);
```

**idle 감지 debounce** — `write()` 핸들러에 추가:
```typescript
// useImperativeHandle write 구현에 추가
write: (data: string) => {
  // ... 기존 suppressScrollbackClear 처리 ...
  xtermRef.current?.write(output);

  // output-active 클래스 처리 (기존 로직)
  // ...

  // idle 스냅샷 타이머 리셋 (2초 debounce)
  if (idleSnapshotTimerRef.current) clearTimeout(idleSnapshotTimerRef.current);
  idleSnapshotTimerRef.current = setTimeout(() => {
    saveSnapshot();
    idleSnapshotTimerRef.current = null;
  }, 2000);
},
```

**마운트 시 복원** (Terminal 초기화 직후, `fitAddon.fit()` 전):
```typescript
// useEffect 내부, term.open() 이후
const restoreSnapshot = () => {
  try {
    const raw = localStorage.getItem(`terminal_snapshot_${sessionId}`);
    if (!raw) return;
    const snapshot = JSON.parse(raw) as TerminalSnapshot;
    if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== sessionId) return;
    // 저장된 스냅샷 내용을 터미널에 복원
    term.write(snapshot.content);
  } catch (e) {
    console.warn('[TerminalView] snapshot restore failed:', e);
  }
};
restoreSnapshot();
```

**beforeunload 안전망** (마지막 스냅샷이 없는 경우 즉시 저장):
```typescript
// useEffect 내부 (sessionId 의존)
useEffect(() => {
  const handleBeforeUnload = () => {
    // idle 타이머가 대기 중이면 취소하고 즉시 저장
    if (idleSnapshotTimerRef.current) {
      clearTimeout(idleSnapshotTimerRef.current);
      idleSnapshotTimerRef.current = null;
    }
    // 마지막 스냅샷이 없으면 즉시 저장 (안전망)
    if (lastSnapshotRef.current === null) {
      saveSnapshot();
    }
    // lastSnapshotRef.current이 있으면 이미 저장된 것이므로 추가 저장 불필요
  };
  window.addEventListener('beforeunload', handleBeforeUnload);
  return () => window.removeEventListener('beforeunload', handleBeforeUnload);
}, [sessionId, saveSnapshot]);
```

**cleanup 시 타이머 정리:**
```typescript
// 기존 cleanup에 추가
return () => {
  // ...기존 cleanup...
  if (idleSnapshotTimerRef.current) clearTimeout(idleSnapshotTimerRef.current);
  // unmount 시에도 즉시 snapshot 저장 (예: 탭 전환)
  saveSnapshot();
  term.dispose();
};
```

---

#### 3.4.2 수정: `frontend/src/hooks/useWorkspaceManager.ts`

**`closeTab` 시 localStorage 정리:**

```typescript
const closeTab = useCallback(async (workspaceId: string, tabId: string) => {
  try {
    // ... 기존 nextActiveTabId 계산 ...
    
    // 삭제할 탭의 sessionId 조회 (localStorage 정리용)
    const tabToClose = tabs.find(t => t.id === tabId);
    
    await workspaceApi.deleteTab(workspaceId, tabId);
    setTabs(prev => prev.filter(t => t.id !== tabId));
    setWorkspaces(prev => prev.map(w => ...));
    
    // localStorage 스냅샷 정리
    if (tabToClose?.sessionId) {
      try {
        localStorage.removeItem(`terminal_snapshot_${tabToClose.sessionId}`);
      } catch { /* ignore */ }
    }
  } catch (err: any) {
    setError(err.message);
  }
}, [tabs, workspaces]);
```

**`restartTab` 시 구 sessionId 스냅샷 정리:**

```typescript
const restartTab = useCallback(async (workspaceId: string, tabId: string) => {
  try {
    const oldTab = tabs.find(t => t.id === tabId);
    const tab = await workspaceApi.restartTab(workspaceId, tabId);
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...tab, status: 'idle', cwd: tab.lastCwd || '' } : t));
    
    // 구 sessionId 스냅샷 정리 (새 sessionId로 새 스냅샷이 생성될 것임)
    if (oldTab?.sessionId && oldTab.sessionId !== tab.sessionId) {
      try {
        localStorage.removeItem(`terminal_snapshot_${oldTab.sessionId}`);
      } catch { /* ignore */ }
    }
  } catch (err: any) {
    setError(err.message);
  }
}, [tabs]);
```

---

#### 3.4.3 스냅샷 복원 시 터미널 크기 불일치 처리

SerializeAddon은 현재 터미널 크기 기준으로 직렬화한다.  
복원 시 cols/rows가 다르면 렌더링이 깨질 수 있으므로:

```typescript
const restoreSnapshot = () => {
  const snapshot = ...; // 파싱
  
  // cols/rows가 현재와 다르면 write 후 fit으로 재정렬
  term.write(snapshot.content, () => {
    // write 완료 콜백에서 fit 호출
    requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
    });
  });
};
```

---

### 3.5 변경 전/후 구조 비교

| 항목 | 변경 전 | 변경 후 |
|------|---------|---------|
| 새로고침 후 스크롤백 | 소실 | localStorage에서 복원 |
| idle 감지 | 없음 | 2초 debounce |
| 직렬화 방식 | N/A | @xterm/addon-serialize |
| 탭 삭제 시 정리 | N/A | localStorage key 제거 |
| beforeunload | 없음 | 즉시 snapshot 저장 |

---

## 4. 의존성 설치

### 4.1 신규 패키지

```bash
cd frontend
npm install @xterm/addon-serialize
```

### 4.2 버전 호환성 확인

현재 프로젝트 의존성:
- `@xterm/xterm`: `^6.0.0` (실제 설치: 6.x)
- `@xterm/addon-fit`: `^0.11.0`

추가 패키지:
- `@xterm/addon-serialize`: `^0.13.0` (xterm 6.x 호환)

> **주의**: xterm.js의 addon 패키지들은 major 버전이 xterm과 반드시 일치해야 한다.  
> xterm v5 → addon v5.x, xterm v6 → addon v0.13.x (별도 버전 체계).  
> npm 설치 후 peer dependency 경고 없는지 반드시 확인.

---

## 5. 테스트 계획

### 5.1 백엔드 단위 테스트

`server/src/test-runner.ts`에 추가할 테스트는 없음 (이번 변경은 순수 프론트엔드).

### 5.2 E2E 테스트 시나리오 (Playwright)

#### TC-01: Grid 모드 워크스페이스 전환 스크롤백 보존

```
전제: 서버 실행 중 (node dev.js)
1. 로그인 (password: 1234)
2. 워크스페이스 A 생성, Grid 모드 전환
3. 터미널에 'echo scrollback_test_A' 입력
4. 여러 줄 출력 생성 (for i in 1..50 do echo line_$i; done)
5. 워크스페이스 B 생성 (자동으로 B 활성화)
6. 워크스페이스 A로 전환
7. 스크롤백에서 'scrollback_test_A' 텍스트 확인
   → PASS: 텍스트가 보임 (스크롤 가능)
   → FAIL: 텍스트가 사라짐
```

#### TC-02: 브라우저 새로고침 후 스냅샷 복원

```
전제: Grid 모드 활성 워크스페이스
1. 터미널에 50줄 이상 출력 생성
2. 2.5초 대기 (idle 타이머 발동 확인)
3. 브라우저 새로고침 (F5)
4. 로그인 후 해당 워크스페이스 확인
5. 이전 출력 내용이 복원되었는지 확인
   → PASS: 이전 출력 내용이 보임
   → FAIL: 빈 터미널
```

#### TC-03: Tab 모드 회귀 테스트

```
1. Tab 모드에서 탭 2개 생성
2. 각 탭에 서로 다른 출력 생성
3. 탭 간 전환 시 스크롤백 유지 확인
4. 워크스페이스 전환 후 복귀 시 스크롤백 유지 확인
   → 기존 동작 회귀 없음 확인
```

#### TC-04: Mosaic 드래그/리사이즈 시 터미널 위치 동기화

```
1. Grid 모드에서 터미널 2개 활성
2. Mosaic 분할선을 드래그하여 크기 변경
3. 터미널이 Mosaic 셀 위치에 정확히 맞게 배치되는지 확인
4. 터미널 내 텍스트 입력이 정상 동작하는지 확인
   → 위치 오차 없음, 입력 정상
```

#### TC-05: 탭 삭제 시 localStorage 정리

```
1. Grid 모드에서 터미널 실행 (idle 2초 후 스냅샷 저장 대기)
2. 브라우저 DevTools → Application → localStorage 확인
   → 'terminal_snapshot_{sessionId}' 키 존재 확인
3. 탭 닫기
4. localStorage 재확인
   → 해당 키가 삭제되었는지 확인
```

#### TC-06: 복수 워크스페이스 Grid 모드 동시 유지

```
1. 워크스페이스 A, B, C 각각 Grid 모드
2. A → B → C → A 순서로 전환 반복 (각 5회)
3. 각 워크스페이스의 터미널 스크롤백 보존 확인
4. 터미널 위치가 Mosaic 셀과 항상 일치하는지 확인
```

### 5.3 스크린샷 저장 경로

```
.playwright-mcp/tc-01-scrollback-preserve.png
.playwright-mcp/tc-02-snapshot-restore.png
.playwright-mcp/tc-03-tab-mode-regression.png
.playwright-mcp/tc-04-mosaic-resize-sync.png
.playwright-mcp/tc-05-localstorage-cleanup.png
.playwright-mcp/tc-06-multi-workspace.png
```

---

## 6. 위험 요소 및 주의사항

### 6.1 [위험] ResizeObserver 타이밍 문제

**문제**: 워크스페이스 전환 직후 placeholder div가 아직 렌더되기 전에 ResizeObserver 부착 시도.

**대응**:
1. `useEffect`의 deps에 `activeTabIds` 포함 → 탭 변경 시 재실행
2. placeholder ref가 null인 경우 → `MutationObserver` 또는 폴링으로 대기
3. 초기 위치 계산 실패 시 `requestAnimationFrame` 재시도 (최대 3회)

### 6.2 [위험] Mosaic DnD 충돌

**문제**: `GridTerminalLayer`의 absolute div가 Mosaic 분할선 위에 겹쳐 DnD 이벤트를 가로챌 수 있음.

**대응**:
```css
/* GridTerminalLayer 내 터미널 div에 적용 */
.grid-terminal-item {
  pointer-events: none;  /* DnD 가로채기 방지 */
}
.grid-terminal-item > * {
  pointer-events: auto;  /* 터미널 내부는 정상 이벤트 */
}
```

단, 이 경우 터미널 경계 밖 영역에서 클릭이 Mosaic 분할선으로 전달되어 의도치 않은 resize 발생 가능.  
터미널 div의 크기를 placeholder와 정확히 일치시키면 사실상 문제 없음.

### 6.3 [주의] localStorage 용량 제한

**문제**: 스냅샷이 누적될 경우 `localStorage` 5MB 제한 초과 가능.

**대응**:
1. `saveSnapshot` 실패 시 `console.warn`만 출력 (예외 무시)
2. 저장 실패 시 오래된 스냅샷 정리 로직 추가 (선택적):
   ```typescript
   // QuotaExceededError 시 가장 오래된 terminal_snapshot_* 키 삭제 후 재시도
   ```
3. 스냅샷 크기 상한 설정 (예: 1MB 초과 시 저장 건너뜀):
   ```typescript
   if (content.length > 1_000_000) {
     console.warn('[TerminalView] snapshot too large, skipping');
     return;
   }
   ```

### 6.4 [주의] SerializeAddon 설치 전 TypeScript 오류

`@xterm/addon-serialize` 미설치 상태에서 import 시 TypeScript 오류 발생.  
Phase 2 작업 시작 전 반드시 `npm install @xterm/addon-serialize` 먼저 실행.

### 6.5 [주의] Tab 모드 코드 경로 분리 보장

Phase 1에서 `MosaicContainer.renderTerminal` prop이 더 이상 Grid 모드에서 호출되지 않는다.  
Tab 모드의 `TerminalContainer` 렌더 코드(`App.tsx` L429~488)는 **변경하지 않는다.**  
두 코드 경로가 완전히 분리되어야 Tab 모드 회귀를 방지할 수 있다.

### 6.6 [주의] terminalRefsMap 동기화

현재 `terminalRefsMap`은 `App.tsx`에서 관리되고, Grid/Tab 모드가 공유한다.  
Phase 1 이후 Grid 모드 터미널은 `GridTerminalLayer`에서 렌더되므로  
`terminalRefsMap.current.set(tab.id, ref)` 호출이 `GridTerminalLayer` 내부에서 이루어져야 한다.  
`handleFitAllTerminals`, `getTerminalSelection`, `sendTerminalInput` 등이 계속 동작하려면  
`terminalRefsMap` ref를 `GridTerminalLayer`에 전달해야 한다.

### 6.7 [주의] 스냅샷 복원 후 PTY 출력 중복

복원된 스냅샷이 화면에 표시된 직후 PTY 서버에서 새 출력이 오면  
스냅샷 마지막 줄과 새 출력이 자연스럽게 연결된다.  
단, PTY 서버가 재시작된 경우 새 프롬프트가 스냅샷 아래에 추가되므로 사용자가 혼란을 느낄 수 있음.  
이는 허용 가능한 트레이드오프로 간주 (복원 없음보다 복원 있음이 UX상 낫다).

### 6.8 [주의] allGridTabs 범위

`allGridTabs`는 **현재 viewMode='grid'인 워크스페이스의 탭**만 포함해야 한다.  
워크스페이스가 Tab 모드 ↔ Grid 모드를 전환할 때 탭 집합이 변경되므로  
`useMemo` deps에 `wm.workspaces`(viewMode 포함)를 포함해야 한다.

---

## 요약: 파일 변경 목록

### Phase 1

| 파일 | 변경 유형 | 주요 내용 |
|------|-----------|-----------|
| `frontend/src/components/Grid/GridTerminalLayer.tsx` | **신규** | Flat 렌더링 레이어, ResizeObserver 위치 추적 |
| `frontend/src/components/Grid/MosaicContainer.tsx` | **수정** | renderTile → placeholder div, placeholderRefs prop 추가 |
| `frontend/src/components/Grid/index.ts` | **수정** | GridTerminalLayer export 추가 |
| `frontend/src/App.tsx` | **수정** | GridTerminalLayer 렌더, allGridTabs/activeGridTabIds 계산, gridContainerRef 추가 |

### Phase 2

| 파일 | 변경 유형 | 주요 내용 |
|------|-----------|-----------|
| `frontend/package.json` | **수정** | @xterm/addon-serialize 의존성 추가 |
| `frontend/src/components/Terminal/TerminalView.tsx` | **수정** | SerializeAddon, idle debounce, saveSnapshot, restoreSnapshot, beforeunload |
| `frontend/src/hooks/useWorkspaceManager.ts` | **수정** | closeTab/restartTab 시 localStorage 정리 |

---

## 구현 순서 권장사항

1. `npm install @xterm/addon-serialize` (Phase 2 준비이지만 선행해도 무방)
2. Phase 1: `GridTerminalLayer.tsx` 신규 작성
3. Phase 1: `MosaicContainer.tsx` placeholder 전환
4. Phase 1: `App.tsx` GridTerminalLayer 통합
5. TC-01, TC-03, TC-04 테스트
6. Phase 2: `TerminalView.tsx` SerializeAddon 통합
7. Phase 2: `useWorkspaceManager.ts` 정리 로직
8. TC-02, TC-05, TC-06 테스트
9. 전체 회귀 테스트
