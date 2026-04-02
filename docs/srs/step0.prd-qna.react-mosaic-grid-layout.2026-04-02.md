# PRD: React Mosaic 기반 그리드 레이아웃 시스템

**문서 ID**: PRD-MOSAIC-001
**작성일**: 2026-04-02
**버전**: 1.2 (이중 검증 완료)
**상태**: Final
**작성 방식**: PRD-QNA (3인 분석 + Agent Dropout)

---

## 1. Executive Summary

BuilderGate의 그리드 모드 터미널 레이아웃을 현재 CSS Grid 기반에서 **React Mosaic 라이브러리 기반 타일형 레이아웃**으로 전환한다. 이를 통해 드래그 앤 드롭 창 재배치, 사용자 크기 조절, 3가지 크기 모드(균등/포커스/오토)를 지원하며, 향후 터미널 외에 파일트리, 코드 뷰어 등 다양한 패널을 그리드 셀에 배치할 수 있는 확장 가능한 레이아웃 인프라를 구축한다.

### 핵심 목표

1. React Mosaic을 활용한 유연한 타일형 그리드 레이아웃 구현
2. 세션 터미널 컨텍스트 메뉴를 통한 직관적 세션 관리
3. 3가지 크기 모드(균등/포커스/오토)로 다양한 작업 흐름 지원
4. 레이아웃 상태의 브라우저 DB 영속화
5. 향후 비터미널 패널(파일트리, 코드 뷰어) 지원을 위한 확장 가능 구조

### 기대 효과

오토 모드 도입으로 에이전트 idle 감지 후 사용자 전환 시간을 현재 수동 확인 방식(평균 ~5초) 대비 0.3초 이내로 단축하고, 병렬 에이전트 8개 운용 시 모니터링 부담을 대폭 감소시킨다. React Mosaic 기반 확장 구조는 향후 파일트리·코드 뷰어 패널 배치를 위한 인프라 투자이기도 하다.

### 성공 지표

| 지표 | 목표 | 측정 방법 |
|------|------|----------|
| 4~8개 세션 동시 운용 시 UI 반응성 | Chrome DevTools Performance 기준 50fps 미만 3회 연속 드롭 없음 | 5초간 분할선 드래그, Frame Rendering Stats |
| 오토 모드 세션 확대 지연 | idle 상태 전환 후 300ms 이내 (→ FR-6.4) | status 전환 타임스탬프 vs Mosaic onChange 타임스탬프 차이 |
| TUI 깨짐 발생률 | 0% — 리사이즈 완료 후 terminal.cols/rows가 컨테이너 크기와 ±1 이내 일치 | htop/vim 실행 상태에서 리사이즈 후 문자 격자 정렬 확인 |
| 레이아웃 복원 성공률 | 동일 브라우저 재접속 시 100% | 저장된 splitPercentage와 복원 후 값 비교 |

---

## 2. 현재 시스템 분석

### 2.1 기존 그리드 구현

현재 그리드 모드는 CSS Grid 기반으로 구현되어 있다:

- **`GridContainer.tsx`**: `Math.ceil(Math.sqrt(count))`로 열/행 자동 계산, CSS `grid-template-columns/rows` 사용
- **`GridCell.tsx`**: 각 셀에 터미널 + MetadataRow + DisconnectedOverlay 렌더링
- **`GridLayout` 타입**: `{ workspaceId, columns, rows, tabOrder, cellSizes: { colWidths: number[], rowHeights: number[] } | null }`

**한계점**:
- 드래그 앤 드롭 위치 변경 불가
- 사용자 직접 크기 조절 불가 (서버 저장된 고정 비율만 적용)
- 셀 단위 분할/병합 불가
- 향후 비터미널 패널 배치 확장 어려움

### 2.2 관련 컴포넌트/훅 현황

| 컴포넌트/훅 | 상태 | React Mosaic 전환 시 |
|-------------|------|---------------------|
| `GridContainer.tsx` | CSS Grid 레이아웃 | **대체** → MosaicContainer |
| `GridCell.tsx` | 셀 래퍼 | **대체** → MosaicTile |
| `EmptyCell.tsx` | 빈 셀 | **유지** (Mosaic 내 빈 노드로 활용) |
| `ContextMenu.tsx` | 완성됨 | **재사용** (터미널 전용 메뉴 항목 추가) |
| `useContextMenu.ts` | 완성됨 | **재사용** |
| `useWorkspaceManager.ts` | 세션/탭/그리드 관리 | **수정** (GridLayout 타입 변경, Mosaic 트리 저장) |
| `TerminalView.tsx` | xterm.js + ResizeObserver | **재사용** (ResizeObserver가 Mosaic 리사이즈에도 대응) |
| `useTabManager.ts` | 탭 모드 상태 관리 | **유지** (탭 모드 전용, 그리드와 독립) |

### 2.3 기술 스택

- **Frontend**: React 18 + TypeScript, Vite, xterm.js
- **통신**: WebSocket (단일 채널)
- **세션 상태**: `WorkspaceTabRuntime.status: 'running' | 'idle' | 'disconnected'`
- **CWD 추적**: `WorkspaceTabRuntime.cwd` (실시간 업데이트)
- **브라우저 저장소**: localStorage (탭 상태, 워크스페이스 ID 등)

---

## 3. 사용자 경험

### 3.1 타겟 페르소나

**Primary: 솔로 파워 유저**
- 1인이 4~8개 AI 코딩 에이전트를 동시 운용
- 각 에이전트의 진행 상황을 실시간 모니터링
- 데스크톱 대형 모니터 환경

**Secondary: 팀 리드 / 오케스트레이터**
- 여러 서브태스크를 에이전트에 분배하고 결과 취합
- 어느 에이전트가 유휴/대기 중인지 한눈에 파악 필요

### 3.2 플랫폼별 UX

| 플랫폼 | 뷰 모드 | 레이아웃 조작 |
|--------|---------|--------------|
| **데스크톱** | 탭 모드 / 그리드 모드 선택 가능 | 드래그 앤 드롭 + 마우스 리사이즈 |
| **모바일** | **탭 모드 전용** (그리드 모드 없음) | 스와이프 탭 전환, 롱프레스 컨텍스트 메뉴 |

### 3.3 사용자 시나리오

**시나리오 1: 기본 그리드 작업**
1. 워크스페이스에 4개 세션이 있는 상태에서 그리드 모드 활성화
2. React Mosaic이 4개 타일을 균등 배치
3. 사용자가 드래그로 세션 A를 왼쪽에서 오른쪽으로 이동
4. 분할선을 드래그하여 세션 B를 더 크게 조절
5. 레이아웃이 자동 저장됨

**시나리오 2: 오토 모드 활용**
1. 8개 에이전트가 동시 작업 중 (전부 `running` 상태)
2. 오토 모드 활성화 → 전부 균등 크기
3. 에이전트 C, E가 작업 완료되어 `idle` 상태 전환
4. 에이전트 C, E 타일이 자동 확대 (입력 대기 중이므로)
5. 나머지 6개는 최소 크기로 축소

**시나리오 3: 컨텍스트 메뉴로 세션 관리**
1. 세션 B에서 우클릭 → 컨텍스트 메뉴 표시
2. "새 세션 열기" 선택 → 세션 B의 CWD 기반으로 새 세션 생성
3. Mosaic 트리가 균등 재배치되고 새 세션으로 포커스 이동
4. 세션 D에서 우클릭 → "세션 닫기" → 확인 모달 → 삭제
5. 마지막으로 사용했던 세션으로 포커스 이동

---

## 4. 기능 요구사항

### FR-1: React Mosaic 그리드 레이아웃

**설명**: 현재 CSS Grid 기반 `GridContainer`를 React Mosaic 기반으로 전환한다.

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-1.1 | React Mosaic (`react-mosaic-component`)을 사용하여 타일형 레이아웃 구현 | P0 |
| FR-1.2 | 드래그 앤 드롭으로 타일(세션 창) 위치 변경 | P0 |
| FR-1.3 | 분할선 드래그로 사용자 직접 크기 조절 | P0 |
| FR-1.4 | 크기 변경 시 xterm.js `FitAddon.fit()` + PTY resize 처리 (TUI 깨짐 방지) | P0 |
| FR-1.5 | 각 타일에 최소 크기 비율 제한 (splitPercentage 기반, 최소 5%) | P0 |
| FR-1.6 | 데스크톱 전용. 모바일에서는 그리드 모드 비활성화, 탭 모드만 사용 | P0 |

**수용 조건**:
- 4~8개 타일 동시 표시 시 Chrome DevTools Performance 기준 50fps 미만 3회 연속 드롭 없음 (5초간 분할선 드래그로 측정)
- 리사이즈 완료 후 500ms 이내에 xterm.js FitAddon.fit() 호출 완료, terminal.cols × terminal.rows가 컨테이너 크기 / charWidth(Height)와 ±1 이내 일치 (htop/vim 문자 격자 정렬 유지)
- Mosaic onChange 콜백에서 splitPercentage가 최소값(세션 수별 5~15%) 미만으로 내려가지 않음

### FR-2: 세션 터미널 컨텍스트 메뉴

**설명**: 각 세션 터미널에서 우클릭(데스크톱) 또는 롱프레스(모바일 탭 모드)로 컨텍스트 메뉴를 표시한다. 기존 `ContextMenu` 컴포넌트를 재사용한다.

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-2.1 | 터미널 영역에서 우클릭 시 컨텍스트 메뉴 표시 | P0 |
| FR-2.2 | 모바일에서 롱프레스(~500ms) 시 컨텍스트 메뉴 표시 | P0 |
| FR-2.2a | 롱프레스 진행 중 시각적 피드백 제공 (진동 또는 타일 하이라이트) | P1 |
| FR-2.3 | 메뉴 항목: **새 세션 열기** | P0 |
| FR-2.4 | 메뉴 항목: **세션 닫기** | P0 |
| FR-2.5 | 메뉴 항목: **복사** — 텍스트 선택 시에만 활성화, 미선택 시 `disabled` | P0 |
| FR-2.6 | 메뉴 항목: **붙여넣기** | P0 |

**수용 조건**:
- xterm.js의 기본 우클릭 동작(브라우저 컨텍스트 메뉴)이 차단되고 커스텀 메뉴가 표시됨
- 복사 항목은 `terminal.hasSelection() === false`일 때 `disabled` 스타일 적용
- 롱프레스가 xterm.js 터치 이벤트와 충돌하지 않음

### FR-3: 세션 생성/닫기 동작

**설명**: 컨텍스트 메뉴를 통한 세션 생성/닫기의 상세 동작을 정의한다.

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-3.1 | **새 세션 열기**: 현재 세션의 `cwd`를 초기 디렉토리로 새 PTY 세션 생성 | P0 |
| FR-3.2 | 그리드 모드: 세션 추가 후 Mosaic 트리 **전체 균등 재배치** + 새 세션으로 포커스 이동 | P0 |
| FR-3.3 | 탭 모드: 탭 추가 후 해당 탭으로 전환 | P0 |
| FR-3.4 | **세션 닫기**: 확인 모달("정말 닫으시겠습니까?") 표시 후 삭제 | P0 |
| FR-3.5 | 닫기 후 **마지막으로 사용(입력)한 세션**으로 포커스 이동 | P0 |
| FR-3.6 | 마지막 남은 세션을 닫으면 빈 화면 표시 (세션 없는 상태) | P1 |

**수용 조건**:
- 새 세션의 `cwd`가 원본 세션의 `cwd`와 동일
- 포커스 이동 후 100ms 이내에 xterm.js `terminal.focus()` 호출 완료, 키보드 입력이 해당 터미널로 전달됨
- 마지막 사용 순서 추적을 위한 타임스탬프/스택 관리

### FR-4: 크기 모드 아이콘 박스

**설명**: 각 세션 타일의 왼쪽 상단 모서리에 호버 시 크기 모드 컨트롤을 표시한다.

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-4.1 | 각 타일 왼쪽 상단에 마우스 호버 시 아이콘 박스 표시 | P0 |
| FR-4.2 | 스타일: 회색 반투명 배경, 둥근 모서리, 가로가 긴 직사각형 | P0 |
| FR-4.3 | 아이콘 버튼 1: **균등 분할** — 모든 타일 동일 크기 | P0 |
| FR-4.4 | 아이콘 버튼 2: **포커스 확대** — 현재 타일 최대화, 나머지 최소 크기 | P0 |
| FR-4.5 | 아이콘 버튼 3: **오토** — 기본 균등 + `idle` 세션 자동 확대 | P0 |
| FR-4.6 | 3가지 모드는 **상호 배타적** (한 번에 하나만 활성) | P0 |
| FR-4.7 | 현재 활성 모드의 아이콘에 시각적 표시 (하이라이트/언더라인) | P1 |

**수용 조건**:
- 아이콘 박스는 타일 위에 z-index로 오버레이 표시 (position: absolute)
- 마우스가 아이콘 박스를 벗어나면 300ms 후 사라짐, 재진입 시 타이머 초기화
- 모바일에서는 표시하지 않음 (그리드 모드 없음)

### FR-5: 포커스 확대 모드

**설명**: 현재 타일을 최대한 크게, 나머지를 최소 크기로 배치한다.

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-5.1 | 나머지 타일은 최소 크기(비율 기반)로 축소 | P0 |
| FR-5.2 | 현재 타일은 `1.0 - (최소크기비율 × 나머지 타일 수)`의 공간 차지 | P0 |
| FR-5.3 | 포커스 대상 타일 변경 시 Mosaic 트리의 splitPercentage 재계산 | P0 |

**수용 조건**:
- 8개 세션, 최소 5% 기준: 포커스 타일 = 65%, 나머지 각 5%
- 포커스 전환 시 CSS transition duration 200~300ms로 splitPercentage 변경 (즉시 점프 방식 불가)

### FR-6: 오토 모드

**설명**: 기본 균등 배치를 유지하되, `idle` 상태(입력 대기) 세션을 자동 확대한다.

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-6.1 | `idle` 세션이 없으면 전체 균등 크기 유지 | P0 |
| FR-6.2 | `idle` 세션이 1개면 해당 세션만 확대 (포커스 확대와 동일 비율) | P0 |
| FR-6.3 | `idle` 세션이 여러 개면 해당 세션들만 **균등 확대** | P0 |
| FR-6.4 | `status` 변경 감지 후 300ms 이내에 레이아웃 재조정 (→ 성공 지표 참조) | P0 |
| FR-6.5 | 레이아웃 재조정 시 부드러운 애니메이션 적용 | P2 |

**수용 조건**:
- `status`가 `idle`로 전환된 시점부터 300ms 이내에 해당 세션 타일의 splitPercentage가 확대 비율로 변경됨 (상태 전환 타임스탬프 vs Mosaic onChange 콜백 타임스탬프 차이로 측정)
- `idle` 세션이 없을 때 모든 타일의 splitPercentage가 균등값(50 ± 1)
- 오토 모드 중 사용자가 수동으로 분할선을 조절하면 오토 모드 해제 (균등 모드로 전환)

### FR-7: 레이아웃 영속화

**설명**: Mosaic 레이아웃을 브라우저 DB에 저장하고 재접속 시 복원한다.

| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-7.1 | Mosaic 트리(`MosaicNode`)를 직렬화하여 localStorage/IndexedDB에 저장 | P0 |
| FR-7.2 | 저장 시점: 리사이즈/드래그 완료 후 **1초 디바운스** + **beforeunload** | P0 |
| FR-7.3 | 동일 브라우저 재접속 시 저장된 Mosaic 트리 복원 | P0 |
| FR-7.4 | 다른 브라우저에서는 기본 균등 그리드로 표시 | P0 |
| FR-7.5 | 복원 시 이전 세션이 소멸했으면: 레이아웃 구조 유지 + 빈 슬롯에 새 세션 자동 생성 | P1 |
| FR-7.6 | 현재 활성 크기 모드(균등/포커스/오토)도 함께 저장/복원 | P1 |

**수용 조건**:
- Mosaic 트리의 `splitPercentage` 값이 실수(float) 기반 상대 비율로 저장
- 저장 키: 워크스페이스 ID 기반 (`mosaic_layout_{workspaceId}`)
- 직렬화/역직렬화 시 데이터 유실 없음

---

## 5. 영향도 분석

### 5.1 변경 대상 파일

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `GridContainer.tsx` | **대체** | CSS Grid → React Mosaic `<Mosaic>` 컴포넌트 |
| `GridCell.tsx` | **대체** | Mosaic 타일 래퍼로 전환 |
| `EmptyCell.tsx` | **수정** | Mosaic 빈 노드로 활용 |
| `frontend/src/types/workspace.ts` | **수정** | 클라이언트 측 `GridLayout` 타입을 `MosaicNode` 기반으로 변경 |
| `frontend/src/components/Grid/index.ts` | **수정** | 배럴 export 갱신 (GridContainer → MosaicContainer) |
| `useWorkspaceManager.ts` | **수정** | `updateGrid()` → Mosaic 트리 저장/복원 로직 |
| `WorkspaceTabBar.tsx` | **수정** | 그리드 모드 전환 시 Mosaic 초기화 |
| `TerminalView.tsx` | **수정** | 컨텍스트 메뉴 이벤트 바인딩 추가 |
| `TerminalContainer.tsx` | **수정** | 컨텍스트 메뉴 핸들러 + 포커스 순서 추적 |

### 5.2 새로 생성할 파일

| 파일 | 설명 |
|------|------|
| `MosaicContainer.tsx` | React Mosaic `<Mosaic>` 래퍼 (균등/포커스/오토 모드 로직 포함) |
| `MosaicTile.tsx` | 각 타일 래퍼 (아이콘 박스 + TerminalView/향후 패널) |
| `MosaicToolbar.tsx` | 왼쪽 상단 호버 아이콘 박스 (3개 모드 버튼) |
| `useMosaicLayout.ts` | Mosaic 트리 상태 관리 + 영속화 훅 |
| `useLayoutMode.ts` | 균등/포커스/오토 모드 상태 머신 |
| `useFocusHistory.ts` | 세션 사용 순서 추적 (포커스 이동용) |
| ~~`ConfirmModal.tsx`~~ | 기존 `components/Modal/ConfirmModal.tsx` 재사용 (신규 생성 불필요) |

### 5.3 서버 측 변경

| 파일 | 변경 | 설명 |
|------|------|------|
| `GridLayout` 서버 모델 | **수정** | `columns/rows/cellSizes` → `mosaicTree: MosaicNode` |
| `workspaceRoutes.ts` | **수정** | grid update API가 Mosaic 트리 직렬화 데이터 수신 |
| `WorkspaceService.ts` | **수정** | `updateGridLayout()` 메서드 시그니처 및 내부 로직을 Mosaic 트리 기반으로 변경 |
| `workspaces.json` | **스키마 변경** | gridLayouts 데이터 구조 마이그레이션 |

### 5.4 새 의존성

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `react-mosaic-component` | latest | 타일형 레이아웃 코어 |
| `react-dnd` | (peer dep) | react-mosaic-component의 peer dependency |
| `react-dnd-html5-backend` | (peer dep) | react-dnd HTML5 백엔드 |

---

## 6. 기술 설계 가이드

### 6.1 Mosaic 트리 구조

```typescript
// React Mosaic의 MosaicNode<T>
type MosaicNode<T> = MosaicParent<T> | T;

interface MosaicParent<T> {
  direction: 'row' | 'column';
  first: MosaicNode<T>;
  second: MosaicNode<T>;
  splitPercentage?: number; // 0~100, 기본 50
}

// BuilderGate에서 T = string (탭 ID)
type BuilderGateMosaicNode = MosaicNode<string>;
```

### 6.2 크기 모드 상태 머신

```
[균등] ←→ [포커스] ←→ [오토]
  ↑                      |
  └──────────────────────┘

  전환 트리거:
  * 사용자가 수동 리사이즈 시: 오토 → 균등으로 전환
  * 포커스 대상 탭이 닫힐 때: 포커스 → 균등으로 전환
  * 모드 전환 시: Mosaic 트리의 splitPercentage 일괄 재계산
```

### 6.3 최소 크기 비율

| 세션 수 | 최소 비율 | 포커스 확대 시 주 타일 |
|---------|----------|---------------------|
| 2 | 15% | 85% |
| 3 | 10% | 80% |
| 4 | 8% | 76% |
| 5 | 6% | 76% |
| 6 | 6% | 70% |
| 7 | 5% | 70% |
| 8 | 5% | 65% |

### 6.4 레이아웃 영속화 키

```
localStorage key: `mosaic_layout_${workspaceId}`
value: JSON.stringify({
  tree: MosaicNode<string>,
  mode: 'equal' | 'focus' | 'auto',
  focusTarget: string | null,  // 포커스 모드 시 대상 타일 ID
  savedAt: ISO timestamp
})
```

### 6.5 resize 처리 전략

기존 `TerminalView.tsx`의 `ResizeObserver` + rAF 쓰로틀 + debounce PTY resize(100ms) 패턴을 그대로 활용한다. Mosaic의 분할선 드래그 시 발생하는 컨테이너 크기 변경을 `ResizeObserver`가 자동 감지하므로 추가 코드 불필요.

### 6.6 초기 균등 Mosaic 트리 생성 알고리즘

N개 탭 ID를 균등 이진 분할 트리로 생성한다:

```typescript
function buildEqualMosaicTree(ids: string[]): MosaicNode<string> {
  if (ids.length === 1) return ids[0];
  const mid = Math.ceil(ids.length / 2);
  const depth = Math.floor(Math.log2(ids.length));
  return {
    direction: depth % 2 === 0 ? 'row' : 'column', // 행/열 교차
    first: buildEqualMosaicTree(ids.slice(0, mid)),
    second: buildEqualMosaicTree(ids.slice(mid)),
    splitPercentage: (mid / ids.length) * 100,
  };
}
```

### 6.7 레거시 GridLayout 마이그레이션

서버/클라이언트 초기화 시 기존 `GridLayout` 형식(`columns/rows/cellSizes`)이 감지되면:
1. 레거시 형식을 `buildEqualMosaicTree(tabOrder)`로 변환
2. 변환된 Mosaic 트리를 신규 형식으로 저장
3. 레거시 데이터 백업 후 삭제

---

## 7. 리스크 & 완화 전략

| 리스크 | 심각도 | 가능성 | 완화 전략 |
|--------|--------|--------|----------|
| React Mosaic + xterm.js 렌더링 충돌 | 높음 | 중간 | ResizeObserver + rAF 쓰로틀 검증, 드래그 중 fit() 호출 빈도 제한 |
| Mosaic 트리 직렬화/역직렬화 데이터 유실 | 중간 | 낮음 | 저장 전 validation, 실패 시 기본 균등 그리드 폴백 |
| 오토 모드 레이아웃 점핑 (idle/running 빈번 전환) | 중간 | 중간 | 상태 전환 디바운스(300ms), CSS transition으로 부드러운 전환 |
| React Mosaic 라이브러리 유지보수 중단 | 중간 | 중간 | 포크 준비, 핵심 기능만 사용하여 교체 용이성 확보 |
| GridLayout 서버 스키마 마이그레이션 | 낮음 | 높음 | 마이그레이션 스크립트 작성, 기존 데이터 백업 |

---

## 8. 수용 조건 (통합 테스트 시나리오)

### TC-1: 기본 그리드 렌더링
- 4개 세션이 있는 워크스페이스에서 그리드 모드 활성화
- React Mosaic이 4개 타일을 균등 배치
- 각 타일에 xterm.js 터미널이 정상 렌더링

### TC-2: 드래그 앤 드롭
- 타일 A를 드래그하여 타일 B 옆으로 이동
- Mosaic 트리가 재구성되고 모든 터미널이 정상 표시
- TUI 프로그램(htop, vim 등) 실행 중에도 깨지지 않음

### TC-3: 크기 조절
- 분할선을 드래그하여 타일 크기 변경
- Mosaic onChange에서 splitPercentage가 최소값(세션 수별 5~15%) 미만으로 내려가지 않음
- 리사이즈 완료 후 terminal.cols × terminal.rows가 컨테이너 픽셀 크기 / charWidth(Height)와 ±1 이내 일치
- FAIL 조건: 터미널 내용이 절반 이상 공백이거나 문자가 잘림

### TC-4: 컨텍스트 메뉴
- 터미널 우클릭 → 메뉴 표시 (새 세션, 닫기, 복사, 붙여넣기)
- 텍스트 미선택 시 복사 비활성화
- 새 세션 → CWD 동일 + 포커스 이동
- 닫기 → 모달 확인 → 마지막 사용 세션으로 포커스

### TC-5: 크기 모드 전환
- 균등 → 모든 노드의 splitPercentage = 50 ± 1
- 포커스 → 현재 타일의 비율이 6.3절 테이블 값과 ±2 이내 일치, 나머지는 최소값
- 오토 → idle 세션의 splitPercentage가 확대 비율로 변경됨
- 오토 중 수동 리사이즈 → 모드가 '균등'으로 전환됨 (useLayoutMode 상태 확인)
- 포커스 대상 탭 닫기 → 모드가 '균등'으로 자동 전환

### TC-6: 레이아웃 영속화
- 레이아웃 변경 후 페이지 새로고침 → 동일 레이아웃 복원
- 시크릿 모드/다른 브라우저 → 기본 균등 그리드
- 서버 재시작 후 재접속 → 레이아웃 구조 유지, 빈 슬롯에 새 세션 생성

### TC-7: 모바일
- 모바일 뷰포트에서 그리드 모드 비활성화, 탭 모드만 동작
- 롱프레스 컨텍스트 메뉴 정상 동작

### TC-8: 마지막 세션 닫기 (엣지 케이스)
- 세션이 1개 남은 상태에서 우클릭 → 닫기
- 확인 모달 표시 후 확인
- 빈 화면 표시 (Mosaic 트리 empty 상태)
- 포커스 이동 대상 없음 → JavaScript 오류 없이 처리됨

### TC-9: 세션 소멸 복원 (엣지 케이스)
- 워크스페이스에 3개 세션이 있는 레이아웃을 저장
- 서버에서 세션 2개를 강제 소멸 (서버 재시작)
- 페이지 재접속 시 레이아웃 구조(splitPercentage) 유지됨
- 소멸된 2개 슬롯에 새 세션이 자동 생성됨 (cwd는 기본값)

### TC-10: 손상된 레이아웃 데이터 폴백 (부정적 테스트)
- localStorage의 `mosaic_layout_{id}` 값을 `{invalid json`으로 훼손
- 페이지 접속 시 기본 균등 그리드로 폴백
- 콘솔 경고는 허용하되 UI 크래시 없음 (React Error Boundary 미발동)

### TC-11: splitPercentage 최소 제한 경계값 (부정적 테스트)
- 분할선을 극단까지 드래그하여 한 타일을 최소화 시도
- splitPercentage가 최소값(세션 수별 5~15%) 미만으로 내려가지 않음
- 8개 세션 상태에서 포커스 확대: 주 타일 65% ± 2, 나머지 각 5% ± 1 검증

---

## 부록 A: Non-Goals (범위 외)

- 키보드 단축키를 통한 레이아웃 조작 (향후 별도 PRD)
- 그리드 셀에 비터미널 패널 배치 (향후 별도 PRD로 확장 예정, 이번 구조가 지원)
- 레이아웃 프리셋 저장/불러오기
- 다중 모니터 지원
- 세션 간 에이전트 오케스트레이션 UI

---

<!-- internal: 파이프라인 안내 (운영자용)
이 PRD를 기반으로 다음 단계를 진행할 수 있습니다:
- SRS 작성: snoworca-srs-incremental-qna
- 구현 계획: snoworca-implementation-planner
- 직접 구현: snoworca-plan-driven-coder
-->

---

## QNA 결정 이력

| 질문 | 결정 | 근거 |
|------|------|------|
| 입력 대기 판단 기준 | `status: 'idle'` 활용 | 기존 코드의 상태 추적 재사용 |
| 포커스 이동 대상 | 마지막 사용(입력) 순서 | 가장 자연스러운 UX |
| 포커스 확대 비율 | 나머지 = 최소크기, 현재 = 나머지 전부 | 사용자 요구 |
| 최소 크기 | 비율 기반 (세션 수에 따라 5~15%) | 유연한 대응 |
| 마지막 세션 닫기 | 빈 화면 표시 | 사용자 요구 |
| 세션 추가 시 | 전체 균등 재배치 | 일관된 UX |
| 저장 시점 | 디바운스 + beforeunload | 데이터 안전성 |
| 세션 소멸 시 복원 | 레이아웃 유지 + 새 세션 생성 | 레이아웃 투자 보존 |
| 크기 모드 관계 | 상호 배타적 | 혼란 방지 |
| 모바일 그리드 | 없음 (탭 모드 전용) | 화면 크기 제약 |
| 세션 수 상한 | 4~8개 | 타겟 사용자 패턴 |
| React Mosaic | 필수 도입 | 향후 파일트리/코드뷰어 확장 |

---

## 부록 B: SRS 도메인 검증 결과

**검증일**: 2026-04-02
**검증자**: SRS 도메인 검증자 (react-mosaic 공식 문서, GitHub 소스, MDN, xterm.js 공식 문서 기반)

---

### B.1 React Mosaic API 검증

#### B.1.1 `<Mosaic<T>>` 컴포넌트의 실제 props

공식 README 및 GitHub 소스(`libs/react-mosaic-component/`) 기반:

| Prop | 타입 | 필수 | 설명 |
|------|------|------|------|
| `renderTile` | `(id: T, path: MosaicPath) => ReactElement` | **필수** | 각 타일 렌더링 함수 |
| `initialValue` | `MosaicNode<T> \| null` | 선택 | 비제어 모드 초기값 |
| `value` | `MosaicNode<T> \| null` | 선택 | 제어 모드 현재값 |
| `onChange` | `(newNode: MosaicNode<T> \| null) => void` | 선택 | 레이아웃 변경 콜백 |
| `onRelease` | 콜백 | 선택 | 드래그/리사이즈 완료 시점 콜백 (저장 시점에 적합) |
| `resize` | `ResizeOptions` | 선택 | 리사이즈 옵션 객체 |
| `className` | `string` | 선택 | 추가 CSS 클래스 |
| `blueprintNamespace` | `string` | 선택 | Blueprint v4/v5 네임스페이스 |
| `createNode` | `CreateNode<T>` | 선택 | 새 노드 생성 함수 (MosaicWindow용) |
| `zeroStateView` | `ReactElement` | 선택 | 트리 비어있을 때 표시 |
| `dragAndDropManager` | 외부 DnD 매니저 | 선택 | 외부 DndProvider와 공유 시 |
| `mosaicId` | `string` | 선택 | 복수 Mosaic 인스턴스 구분자 |

**PRD 영향 없음**: PRD의 controlled 모드(`value` + `onChange`) 설계는 실제 API와 일치한다. `onRelease`는 FR-7.2의 "리사이즈 완료 후 1초 디바운스" 저장 트리거로 활용 가능하다.

#### B.1.2 `MosaicNode<T>` 타입 — **v6과 v7 간 중대한 breaking change 확인**

> **경고**: v7.0.0-beta0 (2025-03-13 출시)에서 트리 구조가 완전히 변경되었다.

**v6 구조 (현재 안정 버전, PRD가 가정한 구조)**:
```typescript
type MosaicNode<T> = MosaicParent<T> | T;

interface MosaicParent<T> {
  direction: 'row' | 'column';
  first: MosaicNode<T>;      // 이진 트리
  second: MosaicNode<T>;     // 이진 트리
  splitPercentage?: number;  // 단일 숫자 (0~100)
}
```

**v7 구조 (beta, n진 트리)**:
```typescript
type MosaicNode<T> = MosaicSplitNode<T> | MosaicTabsNode<T> | T;

interface MosaicSplitNode<T> {
  type: 'split';
  direction: 'row' | 'column';
  children: MosaicNode<T>[];          // n개 자식 (배열)
  splitPercentages?: number[];         // 배열로 변경됨
}

interface MosaicTabsNode<T> {
  type: 'tabs';
  tabs: T[];
  activeTabIndex: number;
}
```

**도메인 결정 필요 사항 (Q1)**:
- PRD는 v6의 `{ direction, first, second, splitPercentage }` 구조를 가정한다.
- **npm latest는 v6.1.1 (2024-12-20)**이며 v7은 beta이다.
- 구현 시 `react-mosaic-component@^6` 을 명시적으로 pinning하거나, v7 채택 여부를 결정해야 한다.
- v7 채택 시 PRD 6.1절, 6.6절의 트리 구조 정의와 `buildEqualMosaicTree` 알고리즘 전면 수정 필요.
- v7에는 `convertLegacyToNary` 마이그레이션 유틸리티가 제공된다.

**권장**: v6.1.1 pinning. v7은 tabbed window 기능이 필요할 때 별도 마이그레이션.

#### B.1.3 `splitPercentage` 최소값 — **라이브러리 수준 지원 확인됨**

> **핵심 발견**: `minimumPaneSizePercentage`는 `resize` prop을 통해 라이브러리 수준에서 지원된다.

```tsx
// 라이브러리가 드래그 중 splitPercentage를 자동으로 클램핑함
<Mosaic
  resize={{ minimumPaneSizePercentage: 5 }}
  ...
/>
```

- **기본값**: `minimumPaneSizePercentage: 20` (기본 20%, 변경 가능)
- **동작**: 분할선 드래그 중 라이브러리 내부에서 클램핑 처리 — `onChange`에서 수동 클램핑 불필요
- **PRD 수용 조건 수정 필요**: TC-3, TC-11의 "Mosaic onChange 콜백에서 splitPercentage가 최소값 미만으로 내려가지 않음" 표현은 정확하지 않다. 정확히는 "resize prop에 minimumPaneSizePercentage를 설정하면 라이브러리가 드래그 중 자동 클램핑하므로 onChange 값 자체가 최소값 미만으로 오지 않는다"가 맞다.
- **FR-1.5 구현**: `<Mosaic resize={{ minimumPaneSizePercentage: N }} />` 한 줄로 충분. onChange에서 별도 클램핑 로직 불필요.

#### B.1.4 react-dnd 의존성과 DndProvider 설정

**v6 기준**:
- `react-mosaic-component@6`은 내부적으로 `react-dnd@16`, `react-dnd-html5-backend@16`, `react-dnd-multi-backend@9`를 번들하거나 peer dependency로 요구
- **`<Mosaic>`**: 자체 DndProvider 내장 — 사용자가 별도 DndProvider 불필요
- **`<MosaicWithoutDragDropContext>`**: 외부에 이미 DndProvider가 있을 때 사용하는 variant

**주의사항**:
- 프로젝트에 react-dnd를 이미 사용 중이라면 버전 충돌 확인 필요
- BuilderGate는 현재 react-dnd를 사용하지 않으므로 충돌 없음
- **PRD 5.4절 의존성 목록 수정**: `react-dnd`, `react-dnd-html5-backend`를 개발자가 직접 설치할 필요가 없을 수 있다 (v6에서 Mosaic이 내부 처리). 단, peerDep 방식이면 별도 설치 필요 — 설치 후 `npm ls react-dnd`로 버전 확인 권장.

**Blueprint CSS 의존성**:
- `react-mosaic-component.css` import는 필수
- Blueprint CSS(`@blueprintjs/core/lib/css/blueprint.css`, `@blueprintjs/icons`) import는 Blueprint 테마 사용 시에만 필요
- Blueprint를 사용하지 않고 커스텀 CSS만 써도 동작하나, 리사이즈 핸들 등 일부 스타일이 없어 직접 구현 필요

---

### B.2 xterm.js + Mosaic 통합 검증

#### B.2.1 Mosaic 분할선 드래그 중 fit() 호출 빈도와 성능

**현재 TerminalView.tsx 구현 분석**:
```typescript
// 기존 구현: rAF 쓰로틀 + 100ms debounce PTY resize
const resizeObserver = new ResizeObserver(() => {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    fitAddon.fit();       // 프레임당 1회로 제한됨
    // PTY resize는 100ms debounce
    resizeTimer = setTimeout(() => onResize(term.cols, term.rows), 100);
  });
});
```

**검증 결론**:
- 현재 구현의 **rAF 쓰로틀(프레임당 1회 fit())** 방식은 Mosaic 분할선 드래그에도 유효하게 동작한다.
- Mosaic이 분할선 드래그 시 컨테이너 크기를 변경하면 ResizeObserver가 자동 감지 — 추가 이벤트 바인딩 불필요 (PRD 6.5절 설계 확인됨).
- **8개 xterm.js 인스턴스 동시 resize 시**: fit() 자체는 경량 DOM 측정 연산이므로 rAF당 8회 호출은 허용 범위. PTY resize(서버 전송)는 100ms debounce로 이미 최적화됨.
- xterm.js GitHub Issues에서 다수 resize 관련 이슈(플리커, 문자 위치 오류) 보고됨. 단, 이는 주로 **동기적 크기 변경**이 원인이며 rAF 기반 비동기 처리로 대부분 회피 가능.
- **PRD FR-1.4 수용 조건**: 기존 ResizeObserver 패턴 재사용으로 달성 가능 확인.

#### B.2.2 CSS transition으로 splitPercentage 애니메이션 가능 여부

> **중요 제약 발견**: CSS transition으로 Mosaic 분할 애니메이션은 **직접 적용 불가**.

**이유**:
- Mosaic은 `splitPercentage`를 React state에서 읽어 **인라인 스타일(flex-basis 또는 width %)** 로 DOM에 직접 적용한다.
- CSS `transition` 속성은 CSS class 변경에 의한 스타일 변경에는 동작하지만, **React가 인라인 스타일을 직접 업데이트하는 방식**에서는 transition이 동작하지 않는다 — 브라우저가 중간 상태 없이 즉시 적용함.

**PRD FR-5.3, FR-6.5 영향**:
- "CSS transition duration 200~300ms로 splitPercentage 변경 (즉시 점프 방식 불가)" — **구현 불가 (직접 CSS transition 방식)**
- **대안 구현 방법** (도메인 결정 필요 사항 Q2):
  1. **requestAnimationFrame 보간(권장)**: 현재값 → 목표값을 rAF 루프에서 선형/이징 보간하며 `setValue()` 호출. 애니메이션 프레임마다 React state 업데이트 → 성능 주의 (60fps × 300ms = 18회 setState).
  2. **CSS custom property + transition**: Mosaic 소스 수정 또는 래퍼에서 CSS 변수로 크기 제어하는 별도 레이어 추가 — 복잡도 높음.
  3. **애니메이션 포기 (P2로 강등)**: FR-6.5는 이미 P2. 즉시 점프 방식 허용하되 오토 모드 디바운스(300ms)로 잦은 전환을 방지.
- **권장**: FR-5.3의 transition 요구사항을 rAF 보간으로 구현하거나, "즉시 전환" 허용으로 AC 완화. FR-6.5(P2)는 MVP에서 제외.

#### B.2.3 여러 xterm.js 인스턴스 동시 resize 성능 특성

- fit()는 DOM layout read (getBoundingClientRect) + terminal.resize() 호출로 구성.
- 8개 인스턴스가 같은 rAF 사이클에서 fit()를 호출하면 강제 레이아웃 재계산(layout thrashing) 발생 가능.
- **완화 전략**: 각 TerminalView 인스턴스의 ResizeObserver가 독립 rAF를 예약하므로 자연스럽게 분산됨. 단, 모든 인스턴스가 같은 프레임에 트리거되면 동시 fit() 호출 발생.
- **실용적 한계**: 4~8개 인스턴스 + 60fps 드래그 시나리오는 Chrome DevTools 실측 필요. PRD의 "50fps 미만 3회 연속 드롭 없음" 기준은 합리적이나 보장 불가 — 구현 후 프로파일링 필수.

---

### B.3 Clipboard API 검증

#### B.3.1 navigator.clipboard.readText()의 브라우저 권한 모델

**HTTPS/Secure Context 요구**:
- `navigator.clipboard`는 **Secure Context(HTTPS 또는 localhost)에서만 사용 가능**.
- BuilderGate는 `https://localhost:4242`(HTTPS) + Vite dev server(`http://localhost:4545`)를 사용.
- **Vite dev server(http://localhost:4545)**: localhost는 secure context로 간주됨 — `navigator.clipboard` 사용 가능. (MDN: "localhost is always a secure context")

**포커스 요구**:
- `clipboard.readText()`는 **문서가 포커스를 갖고 있어야** 작동한다.
- 브라우저별 차이:
  - **Chrome**: `clipboard-read` 권한 필요. 최초 호출 시 권한 요청 다이얼로그.
  - **Firefox 125+**: 포커스 + 사용자 제스처(transient activation) 기반. 임시 "붙여넣기" 팝업 표시.
  - **Safari 13.1+**: 사용자 제스처 필요. Promise 처리 방식이 Chromium과 다름.
- **BuilderGate 영향**: 터미널 컨텍스트 메뉴에서 "붙여넣기"를 클릭하는 시점은 사용자 제스처 내에 있으므로 권한 조건 충족.

**현재 TerminalView.tsx와의 관계**:
- 현재 코드는 `Ctrl+V` 입력 시 `return true`로 xterm.js 네이티브 붙여넣기에 위임한다 (이중 붙여넣기 방지 주석 있음).
- xterm.js 네이티브 `onData`는 내부적으로 Clipboard API를 호출한다.
- **컨텍스트 메뉴 "붙여넣기"(FR-2.6)** 구현 시 `navigator.clipboard.readText()` + `terminal.paste(text)` 패턴을 사용해야 한다.
- **충돌 가능성**: 컨텍스트 메뉴 클릭 이벤트 처리 중 `readText()`를 호출하면 사용자 제스처 내에 있으므로 충돌 없음. 단, 비동기 Promise이므로 메뉴 닫기→readText 완료→paste 순서 보장 필요.

**xterm.js 기본 복사/붙여넣기와의 충돌**:
- 현재 `attachCustomKeyEventHandler`에서 `Ctrl+C` + 선택 시 `navigator.clipboard.writeText()` + `return false` 처리 중.
- `Ctrl+V`는 xterm 네이티브에 위임(`return true`) — xterm.js가 내부적으로 clipboard API 사용.
- **컨텍스트 메뉴 붙여넣기**는 키보드 이벤트 경로와 다른 경로이므로 충돌 없음.
- **우클릭 차단(FR-2.1)**: xterm.js는 기본적으로 브라우저 우클릭 메뉴를 차단하지 않는다. `contextmenu` 이벤트에 `preventDefault()`를 수동으로 추가해야 한다.

---

### B.4 미해결 도메인 질문

| ID | 질문 | source | satisfied |
|----|------|--------|-----------|
| Q1 | react-mosaic-component 버전을 v6.1.1로 pinning할 것인가, 아니면 v7.0.0-beta를 채택할 것인가? v7은 `MosaicNode` 타입이 n-ary 구조로 변경되어 PRD 6.1절, 6.6절 트리 알고리즘 전면 수정이 필요하다. | domain | false |
| Q2 | FR-5.3의 "포커스 전환 시 CSS transition duration 200~300ms" 요구사항을 rAF 보간으로 구현할 것인가, 아니면 즉시 전환(점프)으로 수용 조건을 완화할 것인가? CSS transition은 Mosaic 인라인 스타일 방식으로 인해 직접 적용 불가하다. | domain | false |
| Q3 | `<Mosaic>` 컴포넌트 사용 시 react-dnd peer dependency(`react-dnd@16`, `react-dnd-html5-backend@16`)를 별도 설치해야 하는가, 아니면 라이브러리가 내부 번들로 포함하는가? 설치 방식에 따라 PRD 5.4절 의존성 목록이 달라진다. | domain | false |
| Q4 | Blueprint CSS(`@blueprintjs/core`, `@blueprintjs/icons`)를 도입할 것인가? 미도입 시 Mosaic 기본 스타일(리사이즈 핸들 등)을 커스텀 CSS로 직접 구현해야 한다. | domain | false |

---

### B.5 PRD 수정 권고 사항 (검증 결과 기반)

| 항목 | 현재 PRD 내용 | 검증 결과 | 권고 수정 |
|------|--------------|----------|----------|
| 5.4절 의존성 | react-dnd, react-dnd-html5-backend (peer dep) 명시 | react-dnd 버전 pinning 및 peerDep 여부 미확인 | 설치 후 `npm ls react-dnd` 확인 후 확정 |
| 6.1절 MosaicNode 타입 | v6 이진 트리 구조 (`first`, `second`, `splitPercentage`) | v7 beta에서 n-ary로 변경됨 | v6 버전 명시, v7 채택 시 구조 전면 수정 필요 명시 |
| FR-1.5 최소 크기 구현 | "onChange에서 clamp" 암시 | resize prop으로 라이브러리 내장 처리 | `<Mosaic resize={{ minimumPaneSizePercentage: N }} />`으로 구현 명시 |
| FR-5.3 AC | CSS transition 200~300ms | CSS transition 직접 적용 불가 | rAF 보간 또는 즉시 전환으로 대안 명시 |
| TC-3, TC-11 | "onChange 콜백에서 최소값 미만 오지 않음" | resize prop이 드래그 중 자동 클램핑 | 표현을 "resize.minimumPaneSizePercentage 설정 시 라이브러리가 자동 클램핑" 으로 수정 |
| FR-2.6 붙여넣기 | navigator.clipboard.readText() 사용 | HTTPS/localhost 필수, 사용자 제스처 내 호출 필요 | 현재 설계 유효, 비동기 처리 주의 사항 추가 |
| FR-2.1 우클릭 차단 | xterm.js 기본 차단 가정 가능성 | xterm.js는 contextmenu 이벤트 차단 안 함 | `contextmenu` 이벤트에 `preventDefault()` 수동 추가 명시 |
