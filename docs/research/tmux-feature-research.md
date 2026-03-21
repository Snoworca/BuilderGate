# BuilderGate + tmux 기능 연구 보고서 v2

> **프로젝트**: BuilderGate (코딩 에이전트 병렬 운용 웹 IDE)
> **목적**: tmux 스타일 화면 분할 및 세션 관리 기능 도입 검토
> **일자**: 2026-03-21
> **v2 변경**: 컨텍스트 메뉴 중심 UX, 모바일 스와이프 내비게이션, IndexedDB 영속화 반영

---

## 1. 현재 아키텍처 요약

### 1.1 세션 모델

| 계층 | 구현 상태 | 설명 |
|------|----------|------|
| **백엔드 세션** | `Map<string, SessionData>` | 인메모리, 서버 재시작 시 소멸 |
| **PTY 관리** | `node-pty` (ConPTY) | 세션당 1개 PTY + N개 자식 PTY |
| **통신** | SSE + HTTP POST | 서버→클라이언트 스트림, 클라이언트→서버 입력 |
| **인증** | JWT + 2FA(선택) | SSE는 `?token=` 쿼리 파라미터로 인증 |

### 1.2 프론트엔드 레이아웃 (현재)

```
┌─ Header ────────────────────────────────┐
├─ Sidebar ─┬─ Content ──────────────────┤
│ Session 1 │ TabBar: [Main] [Term-2] [+]│
│ Session 2 │ ┌──────────────────────────┐│
│ Session 3 │ │                          ││
│            │ │   단일 터미널 화면       ││
│            │ │   (한 번에 1개 탭만)     ││
│            │ │                          ││
│            │ └──────────────────────────┘│
├─ StatusBar ─────────────────────────────┤
└─────────────────────────────────────────┘
```

### 1.3 핵심 훅 구조

| 훅 | 역할 |
|----|------|
| `useSession` | 부모 세션 CRUD, 사이드바 목록 관리 |
| `useTabManager` | 세션별 탭 상태 머신 (터미널/파일/뷰어) |
| `useSSE` | 세션별 SSE 연결, 출력 스트림 수신 |
| `useDragReorder` | 탭 드래그 앤 드롭 재정렬 |

### 1.4 현재 제약사항

- **화면 분할 없음** — 탭 전환으로만 터미널 전환
- **세션 그룹 없음** — 플랫 리스트
- **세션 영속성 없음** — 서버 재시작 시 모든 세션 소멸
- **글로벌 상태 라이브러리 없음** — 순수 React 훅
- **라우터 없음** — `useState<'workspace' | 'settings'>` 뷰 전환

---

## 2. tmux 기능 매핑 분석

### 2.1 기능별 격차 분석

| tmux 기능 | BuilderGate 현재 | 격차 크기 | 구현 난이도 |
|-----------|-----------------|----------|------------|
| **Pane Split** (수평/수직 분할) | ❌ 없음 | 🔴 큼 | ⭐⭐⭐ 높음 |
| **Pane Resize** (드래그 크기 조절) | ❌ 없음 | 🔴 큼 | ⭐⭐⭐ 높음 |
| **Pane Zoom** (전체화면 토글) | ❌ 없음 | 🟡 중간 | ⭐⭐ 중간 |
| **Window** (탭 그룹) | 🟡 탭 시스템 유사 | 🟢 작음 | ⭐ 낮음 |
| **Session** (세션 그룹) | 🟡 사이드바 세션 | 🟡 중간 | ⭐⭐ 중간 |
| **Detach/Attach** | 🟡 SSE 버퍼 64KB | 🟡 중간 | ⭐⭐ 중간 |
| **Copy Mode** (스크롤백) | 🟢 xterm 10K라인 | 🟢 작음 | ⭐ 낮음 |
| **Status Bar** | 🟢 StatusBar 존재 | 🟢 작음 | ⭐ 낮음 |
| **Prefix Key** (단축키 체계) | 🟡 일부 Ctrl키 | 🟡 중간 | ⭐⭐ 중간 |

### 2.2 프로젝트 비전과의 연결

> *"브라우저 하나로 다수의 셸 세션을 관리하고, 세션 간 에이전트 명령을 중계한다. 최종 목표는 원격에서 N개 코딩 에이전트를 동시 운용하여 병렬 개발을 수행하는 것."* — CLAUDE.md

**Pane Split이 가장 높은 우선순위인 이유:**
- N개 에이전트를 **동시에 시각적으로 모니터링**하는 것이 핵심 가치
- 탭 전환으로는 에이전트 간 실시간 비교/감시 불가
- tmux의 가장 차별화된 기능이자 웹 IDE에서 가장 흔히 부족한 기능

---

## 3. 핵심 설계 결정 (v2 신규)

### 3.1 컨텍스트 메뉴 중심 UX

**원칙**: 모든 Pane 조작은 **우클릭 컨텍스트 메뉴**를 통해 접근 가능해야 한다.

#### 3.1.1 Pane 영역 우클릭 메뉴

```
┌─────────────────────────┐
│ ✂  수평 분할 (위/아래)   │
│ ┃  수직 분할 (좌/우)     │
│ ─────────────────────── │
│ 🔍 줌 토글 (전체화면)    │
│ ↔  Pane 교환             │
│ ─────────────────────── │
│ 📋 출력 복사             │
│ 🔗 세션 연결 변경        │
│ ─────────────────────── │
│ ✕  Pane 닫기             │
│ ✕  다른 Pane 모두 닫기   │
└─────────────────────────┘
```

#### 3.1.2 분할 경계선 우클릭 메뉴

```
┌─────────────────────────┐
│ ⚖  균등 분할             │
│ 🔄 방향 전환 (↔ ↕)      │
│ ─────────────────────── │
│ ✕  왼쪽/위 Pane 닫기     │
│ ✕  오른쪽/아래 Pane 닫기 │
└─────────────────────────┘
```

#### 3.1.3 TabBar 탭 우클릭 메뉴 (기존 확장)

```
┌─────────────────────────┐
│ 📝 이름 변경             │
│ ─────────────────────── │
│ 📐 레이아웃 저장         │
│ 📂 레이아웃 불러오기     │
│ 🔲 프리셋 레이아웃  ▶   │
│   ├─ ⬜ 단일 (1x1)      │
│   ├─ ◫  좌우 분할 (1:1)  │
│   ├─ ⬒ 상하 분할 (1:1)  │
│   ├─ ⊞ 4분할 (2x2)     │
│   └─ ◨ 1+2 (좌1 우2)   │
│ ─────────────────────── │
│ ✕  탭 닫기              │
│ ✕  다른 탭 모두 닫기     │
└─────────────────────────┘
```

#### 3.1.4 구현: 통합 ContextMenu 컴포넌트

기존 `ContextMenu` 컴포넌트를 확장하여 **서브메뉴** 지원 추가:

```typescript
interface ContextMenuItem {
  label: string;
  icon?: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  children?: ContextMenuItem[];  // 서브메뉴
}
```

---

### 3.2 모바일: 횡 스와이프 내비게이션

**원칙**: 모바일에서는 분할하지 않고, Pane을 **횡 방향으로 나열**하며 **스와이프로 전환**한다.

#### 3.2.1 데스크톱 vs 모바일 비교

```
[데스크톱] 분할 레이아웃
┌──────────┬──────────┐
│ Terminal │ Terminal │
│    A     │    B     │
├──────────┴──────────┤
│     Terminal C      │
└─────────────────────┘
  → 3개 Pane 동시 표시

[모바일] 횡 스와이프 캐러셀
┌─────────┐
│ ● ○ ○   │ ← Pane 인디케이터 (도트)
│         │
│Terminal │  ←── 스와이프 ──→  Terminal B (숨김)
│   A     │
│         │
│ [1/3]   │ ← 현재 위치 표시
└─────────┘
  → 한 번에 1개 Pane, 좌우 스와이프
```

#### 3.2.2 모바일 전환 로직

```typescript
const isMobile = useMediaQuery('(max-width: 768px)');

if (isMobile) {
  const panes = flattenPaneTree(layout.root);
  return <PaneCarousel panes={panes} />;
} else {
  return <SplitPane node={layout.root} />;
}
```

**핵심**: 데이터 구조(PaneNode 트리)는 동일하게 유지하고, **렌더링만 분기**한다.

#### 3.2.3 PaneCarousel 상세 설계

```typescript
interface PaneCarouselProps {
  panes: PaneLeaf[];
  focusedIndex: number;
  onSwipe: (direction: 'left' | 'right') => void;
  onPaneAction: (paneId: string, action: PaneAction) => void;
}
```

**스와이프 구현:**
- `touch-action: pan-y` 설정 (세로 스크롤은 터미널에게 위임)
- `touchstart` → `touchmove` → `touchend` 에서 X축 delta 계산
- delta > 50px → 스와이프 확정, `transform: translateX()` 애니메이션
- 현재 Pane 양 옆에 이전/다음 Pane을 미리 렌더링 (부드러운 전환)

**모바일 Pane 조작:**
- 롱프레스 (500ms) → 컨텍스트 메뉴 (데스크톱 우클릭과 동일 메뉴)
- 메뉴에서 "Pane 추가" → 오른쪽에 새 Pane 생성, 자동 스와이프

---

### 3.3 IndexedDB 레이아웃 영속화

**원칙**: Pane 레이아웃을 **브라우저 IndexedDB**에 저장하여, 새로고침/재방문 시 복원한다.

#### 3.3.1 왜 IndexedDB인가?

| 저장소 | 용량 제한 | 구조화 데이터 | 비동기 | 적합성 |
|--------|----------|-------------|--------|--------|
| `localStorage` | ~5MB | ❌ 문자열만 | ❌ 동기 | 🟡 단순 설정 |
| **`IndexedDB`** | **수백 MB+** | **✅ 객체/배열** | **✅ 비동기** | **🟢 레이아웃 + 히스토리** |
| `sessionStorage` | ~5MB | ❌ 문자열만 | ❌ 동기 | ❌ 탭 닫으면 소멸 |

#### 3.3.2 DB 스키마

```typescript
// DB 이름: 'buildergate'
// 버전: 1

interface BuilderGateDB {
  paneLayouts: {
    key: string;             // sessionId
    value: {
      sessionId: string;
      layout: PaneLayout;
      updatedAt: number;
    };
    indexes: { byUpdatedAt: number };
  };

  savedLayouts: {
    key: string;
    value: {
      id: string;
      name: string;
      layout: PaneLayout;
      isBuiltIn: boolean;
      createdAt: number;
      thumbnail?: string;
    };
    indexes: { byName: string };
  };

  sessionMeta: {
    key: string;             // sessionId
    value: {
      sessionId: string;
      groupId?: string;
      color?: string;
      lastConnected: number;
    };
  };
}
```

#### 3.3.3 구현: `usePaneDB` 훅

```typescript
function usePaneDB() {
  return {
    saveLayout(sessionId: string, layout: PaneLayout): Promise<void>;
    loadLayout(sessionId: string): Promise<PaneLayout | null>;
    deleteLayout(sessionId: string): Promise<void>;
    savePreset(name: string, layout: PaneLayout): Promise<string>;
    loadPresets(): Promise<SavedLayout[]>;
    deletePreset(id: string): Promise<void>;
    migrateFromLocalStorage(): Promise<void>;
  };
}
```

#### 3.3.4 저장 타이밍

| 이벤트 | 동작 |
|--------|------|
| Pane 분할/닫기 | 즉시 저장 (debounce 300ms) |
| Pane 리사이즈 드래그 끝 | `pointerup` 시 저장 |
| 포커스 Pane 변경 | 즉시 저장 |
| 탭 전환 | 이전 탭의 레이아웃 저장 |
| 브라우저 `beforeunload` | 최종 저장 (안전망) |
| 앱 로드 시 | IndexedDB에서 복원 → 없으면 기본 단일 Pane |

#### 3.3.5 기존 localStorage 마이그레이션

```
기존: localStorage('tab_state_{sessionId}')  → JSON 문자열
     localStorage('child_session_ids')       → Set<string>

마이그레이션:
1. 앱 최초 로드 시 localStorage에 기존 탭 상태 존재 확인
2. 있으면 → PaneLayout으로 변환 (각 터미널 탭 → 단일 PaneLeaf)
3. IndexedDB에 저장
4. localStorage에 'migrated_to_idb' 플래그 설정
5. 이후 localStorage의 탭 상태는 읽지 않음
```

---

## 4. 통합 데이터 구조 (최종)

### 4.1 PaneNode 트리

```typescript
type PaneNode = PaneLeaf | PaneSplit;

interface PaneLeaf {
  type: 'terminal';
  id: string;
  sessionId: string;
}

interface PaneSplit {
  type: 'split';
  direction: 'horizontal' | 'vertical';
  ratio: number;  // 0.0 ~ 1.0
  children: [PaneNode, PaneNode];
}

interface PaneLayout {
  root: PaneNode;
  focusedPaneId: string;
}
```

### 4.2 Pane 트리 유틸리티 함수

```typescript
// 트리 조작 (불변 업데이트)
function splitPane(root, paneId, direction, newSessionId): PaneNode;
function closePane(root, paneId): PaneNode | null;
function resizePane(root, splitId, ratio): PaneNode;
function swapPanes(root, paneA, paneB): PaneNode;

// 트리 쿼리
function flattenPaneTree(root): PaneLeaf[];
function findPane(root, paneId): PaneLeaf | null;
function findParentSplit(root, paneId): PaneSplit | null;
function getAdjacentPane(root, paneId, direction): PaneLeaf | null;
function countPanes(root): number;
```

---

## 5. 전체 아키텍처 다이어그램

```
┌─ Browser ──────────────────────────────────────────────────┐
│                                                            │
│  ┌─ React App ──────────────────────────────────────────┐  │
│  │                                                      │  │
│  │  useSession ──── useTabManager ──── usePaneManager   │  │
│  │       │                │                  │          │  │
│  │       │                │            usePaneDB        │  │
│  │       │                │                  │          │  │
│  │       ▼                ▼                  ▼          │  │
│  │   Sidebar          TabBar          PaneRenderer      │  │
│  │                                    ┌─────┴─────┐     │  │
│  │                              (desktop)    (mobile)   │  │
│  │                              SplitPane  PaneCarousel  │  │
│  │                                 │           │        │  │
│  │                            TerminalContainer (×N)    │  │
│  │                                 │                    │  │
│  │                              useSSE (×N)             │  │
│  └──────────────────────────────────────────────────────┘  │
│                          │                                 │
│  ┌─ IndexedDB ──────────┐│                                 │
│  │ paneLayouts          ││                                 │
│  │ savedLayouts         ││                                 │
│  │ sessionMeta          ││                                 │
│  └──────────────────────┘│                                 │
└──────────────────────────┼─────────────────────────────────┘
                           │ SSE + HTTP
                           ▼
┌─ Server ─────────────────────────────────────────────────┐
│  SessionManager (Map<string, SessionData>)               │
│       │                                                  │
│  node-pty (×N PTY 프로세스)                              │
└──────────────────────────────────────────────────────────┘
```

---

## 6. 구현 로드맵

### Phase 1A: 기반 (IndexedDB + 트리 유틸)
### Phase 1B: 데스크톱 분할 (SplitPane + 컨텍스트 메뉴)
### Phase 1C: 모바일 캐러셀 (PaneCarousel + 스와이프)
### Phase 2: 키보드 단축키 (Prefix 모드)
### Phase 3: 세션 그룹 + 프리셋

---

## 7. 기본 프리셋 레이아웃

| 이름 | 미리보기 | PaneNode 구조 |
|------|---------|---------------|
| **단일** | `⬜` | `{ type: 'terminal' }` |
| **좌우 분할** | `◫` | `split(vertical, 0.5, [term, term])` |
| **상하 분할** | `⬒` | `split(horizontal, 0.5, [term, term])` |
| **4분할** | `⊞` | `split(h, 0.5, [split(v, 0.5, [t,t]), split(v, 0.5, [t,t])])` |
| **1+2 (메인+보조)** | `◨` | `split(v, 0.6, [term, split(h, 0.5, [term, term])])` |
| **에이전트 모니터** | `⊟` | `split(h, 0.7, [split(v, 0.5, [t,t]), term])` |

---

## 8. 요약 및 추천

| 우선순위 | 기능 | 이유 |
|---------|------|------|
| 🥇 **1순위** | Pane Split + 컨텍스트 메뉴 + IndexedDB | 핵심 가치 (N개 에이전트 동시 모니터링) + 데이터 영속성 |
| 🥈 **2순위** | 모바일 캐러셀 | 동일 데이터 구조로 모바일 UX 제공 |
| 🥉 **3순위** | 키보드 단축키 | 파워 유저 생산성 |
| 4순위 | 세션 그룹 + 프리셋 | 대규모 운용 시 조직화 |

**핵심 설계 원칙:**
1. **하나의 데이터, 두 개의 뷰** — PaneNode 트리는 동일, 데스크톱(분할)/모바일(캐러셀) 렌더링만 분기
2. **컨텍스트 메뉴 = 주 인터페이스** — 모든 Pane 조작은 우클릭(데스크톱) / 롱프레스(모바일)로 접근
3. **IndexedDB = 단일 진실 공급원** — 레이아웃 상태의 영속화, localStorage에서 점진적 마이그레이션
4. **백엔드 변경 최소화** — `SessionManager`의 기존 자식 세션 메커니즘 그대로 활용
