---
title: 탭/그리드 모드 UX 통일 및 세션 유지
project: BuilderGate
date: 2026-04-06
type: srs
version: srs.step3
tech_stack: React 18, TypeScript, xterm.js, Node.js
code_path: frontend/src/
request_doc: docs/archive/srs/request/2026-04-06.request.srs.탭-그리드-모드-UX-통일-및-세션-유지.md
---

# 탭/그리드 모드 UX 통일 및 세션 유지 SRS

## 1. 개요

### 1.1 목적 및 배경

BuilderGate의 터미널 UI는 탭 모드(단일 터미널 표시)와 그리드 모드(Mosaic 다분할)를 제공한다. 현재 두 모드 간 UX 기능 격차가 있어 사용자가 모드를 전환할 때 일관되지 않은 경험을 받는다.

- 그리드 모드에서는 우클릭 컨텍스트 메뉴를 사용할 수 있으나 탭 모드에서는 불가
- 탭 모드에서는 탭 더블클릭으로 이름 변경이 가능하나 그리드 모드에서는 불가
- 워크스페이스를 전환했다 돌아오면 터미널 스크롤백 히스토리가 소멸

이 SRS는 두 모드 간 기능을 통일하고, 워크스페이스 전환 시 세션 상태를 유지하는 기능을 정의한다.

### 1.2 범위

**In-Scope:**
- 탭 모드 터미널 영역 우클릭 컨텍스트 메뉴
- 그리드 모드 MetadataRow 세션 이름 더블클릭 편집
- 워크스페이스 전환 시 xterm 인스턴스 유지 (설정 가능한 최대 수)

**Out-of-Scope:**
- 서버 재시작 후 터미널 히스토리 복원 (PTY 세션 자체가 소멸하므로 별도 범위)
- 브라우저 새로고침 후 히스토리 복원
- 컨텍스트 메뉴 항목 추가/변경 (기존 항목 유지)

### 1.3 용어 정의

| 용어 | 정의 |
|------|------|
| 탭 모드 | `viewMode === 'tab'`일 때의 레이아웃. 활성 탭 1개만 전체 화면으로 표시 |
| 그리드 모드 | `viewMode === 'grid'`일 때의 레이아웃. react-mosaic으로 다분할 표시 |
| MetadataRow | 그리드 모드 각 타일 하단의 메타데이터 바. 세션 이름, CWD, 시간 표시 |
| 스크롤백 버퍼 | xterm.js의 `scrollback` 옵션으로 유지되는 과거 터미널 출력 라인 |
| 활성 워크스페이스 | 현재 사용자가 보고 있는 워크스페이스 (`activeWorkspaceId`) |

## 2. 이해관계자 및 사용자

### 2.1 이해관계자 목록

| 역할 | 관심사 |
|------|--------|
| 개발자 (사용자) | 모드 간 일관된 UX, 세션 히스토리 보존 |
| 프로젝트 관리자 | 코드 복잡도 최소화, 메모리 효율 |

### 2.2 사용자 유형

- **단일 사용자**: BuilderGate 웹 터미널을 통해 다수의 코딩 에이전트를 병렬 관리하는 개발자

### 2.3 사용자 시나리오

**시나리오 1 — 탭 모드 컨텍스트 메뉴 (정상 흐름)**
1. 사용자가 탭 모드에서 터미널 영역을 우클릭한다
2. 컨텍스트 메뉴가 클릭 위치에 표시된다 (새 세션, 세션 닫기, 복사, 붙여넣기)
3. 사용자가 메뉴 항목을 클릭하면 해당 동작이 실행된다
4. 메뉴 바깥을 클릭하거나 ESC를 누르면 메뉴가 닫힌다

**시나리오 2 — 그리드 모드 세션 이름 변경 (정상 흐름)**
1. 사용자가 그리드 모드의 MetadataRow에서 세션 이름을 더블클릭한다
2. 세션 이름이 인라인 입력 필드로 전환된다
3. 새 이름을 입력하고 Enter를 누르면 이름이 변경된다
4. ESC를 누르면 변경이 취소된다

**시나리오 3 — 워크스페이스 전환 후 복귀 (정상 흐름)**
1. 사용자가 워크스페이스 A에서 명령을 실행하여 긴 출력을 생성한다
2. 워크스페이스 B로 전환하여 다른 작업을 수행한다
3. 워크스페이스 A로 다시 전환한다
4. 이전에 실행한 명령의 출력과 스크롤백 히스토리가 그대로 유지되어 있다

**시나리오 3a — 세션 유지 상한 도달 (대안 흐름)**
1. 설정에서 최대 유지 워크스페이스 수가 N으로 설정되어 있다
2. N+1번째 워크스페이스로 전환한다
3. 가장 오래전에 방문한 워크스페이스의 터미널 인스턴스가 조용히 해제된다 (사용자 알림 없음 — 백그라운드 LRU 정리)
4. 해제된 워크스페이스로 복귀하면 터미널이 새로 초기화된다 (서버 PTY 재연결)

**시나리오 2a — 이름 변경 실패 (예외 흐름)**
1. 사용자가 그리드/탭 모드에서 세션 이름을 변경하고 Enter를 누른다
2. 서버 API 호출이 실패한다 (네트워크 오류 등)
3. UI에서 기존 이름으로 롤백되고, 사용자에게 오류가 표시되지 않는다 (기존 탭 모드 동작과 동일)

**시나리오 3b — 비활성 워크스페이스에서 서버 세션 종료 (예외 흐름)**
1. 워크스페이스 A의 터미널이 비활성 상태(display: none)로 유지 중이다
2. 서버 PTY 프로세스가 종료된다 (프로세스 exit, 타임아웃 등)
3. 터미널은 DOM에 유지되지만 disconnected 상태로 전환된다
4. 워크스페이스 A로 복귀하면 DisconnectedOverlay가 표시되며 재시작 가능

## 3. 기능 요구사항 (FR)

### FR-001: 탭 모드 터미널 컨텍스트 메뉴 — 우선순위: HIGH

- **설명**: 탭 모드에서 터미널 영역을 우클릭하면 그리드 모드와 동일한 컨텍스트 메뉴를 표시한다
- **입력**: 터미널 영역에서 마우스 우클릭 이벤트 (`contextmenu`)
- **출력**: ContextMenu 컴포넌트가 클릭 위치에 렌더링됨
- **메뉴 항목**: 그리드 모드와 완전 동일
  - 새 세션 (셸 선택 서브메뉴 포함, `availableShells > 1`일 때)
  - 세션 닫기
  - 구분선
  - 복사 (텍스트 선택 시에만 활성)
  - 붙여넣기
- **예외**: 브라우저 기본 컨텍스트 메뉴는 `e.preventDefault()`로 억제
- **인수 조건**:
  - 탭 모드 터미널 영역 우클릭 시 ContextMenu가 표시된다
  - 메뉴 항목이 그리드 모드의 `buildTerminalContextMenuItems`과 동일한 항목을 포함한다
  - "새 세션" 클릭 시 세션이 추가된다
  - "세션 닫기" 클릭 시 확인 모달 후 세션이 종료된다
  - "복사" 클릭 시 선택된 텍스트가 클립보드에 복사된다
  - 텍스트 미선택 시 "복사" 항목이 disabled 상태로 렌더링되어 클릭 불가하다 (그리드 모드 기존 동작과 동일)
  - "붙여넣기" 클릭 시 클립보드 내용이 터미널에 입력된다

### FR-002: 컨텍스트 메뉴 빌더 공유 — 우선순위: HIGH

- **설명**: 탭 모드와 그리드 모드의 컨텍스트 메뉴 항목 구성 로직을 공유 함수로 추출하여 코드 중복을 방지한다
- **입력**: 현재 탭 정보 (`WorkspaceTabRuntime`), 콜백 함수들, `availableShells`
- **출력**: `ContextMenuItem[]` 배열
- **제약**: 기존 `MosaicContainer.buildTerminalContextMenuItems`의 동작을 정확히 유지
- **인수 조건**:
  - 탭 모드와 그리드 모드에서 동일한 함수로 메뉴 항목이 생성된다
  - `MosaicContainer` 내부의 `buildTerminalContextMenuItems` 인라인 로직이 제거되고 공유 함수를 호출한다

### FR-003: 그리드 모드 세션 이름 더블클릭 편집 — 우선순위: HIGH

- **설명**: 그리드 모드 MetadataRow의 세션 이름을 더블클릭하면 인라인 입력 필드로 전환되어 이름을 변경할 수 있다
- **입력**: MetadataRow 세션 이름 영역 더블클릭
- **출력**: 인라인 `<input>` 표시 → Enter 시 이름 변경, ESC 시 취소
- **유효성 규칙** (탭 모드와 동일):
  - 빈 문자열 → 기존 이름 유지 (변경 무시)
  - 최대 32자 (`maxLength={32}`)
  - 좌우 공백 자동 제거 (`trim()`)
  - ESC 키로 편집 취소 (기존 이름 복원)
  - 포커스 잃으면(`onBlur`) 편집 확정
- **예외**: 편집 중 터미널에 포커스가 가지 않도록 `e.stopPropagation()` 처리
- **인수 조건**:
  - MetadataRow의 세션 이름 더블클릭 시 인라인 입력 필드가 표시된다
  - 입력 필드에 기존 이름이 채워져 있다
  - Enter 키로 이름이 변경된다 (서버에 반영)
  - ESC 키로 편집이 취소되고 기존 이름이 복원된다
  - 빈 문자열 입력 시 기존 이름이 유지된다
  - 코드가 탭 모드 WorkspaceTabBar의 편집 로직과 동일한 패턴/함수를 공유한다

### FR-004: 워크스페이스 전환 시 터미널 세션 유지 — 우선순위: HIGH

- **설명**: 워크스페이스를 전환했다 돌아왔을 때 터미널의 스크롤백 버퍼, 커서 위치, 화면 내용이 그대로 유지된다
- **구현 방식**: 비활성 워크스페이스의 터미널 컴포넌트를 DOM에서 제거하지 않고 CSS로 숨긴다 (`display: none`)
- **입력**: 워크스페이스 전환 이벤트 (`activeWorkspaceId` 변경)
- **출력**: 이전 워크스페이스의 터미널이 DOM에 유지되며, 복귀 시 즉시 표시
- **세부 동작**:
  - 활성 워크스페이스의 터미널: `display: flex` (보임)
  - 비활성 워크스페이스의 터미널: `display: none` (숨김, xterm 인스턴스 유지)
  - 비활성 상태에서 서버 PTY 출력은 계속 수신하여 xterm 버퍼에 기록 (WebSocket 연결은 세션 단위이므로 워크스페이스 전환과 무관하게 유지됨)
  - `display: none` → `display: flex` 전환 시 `requestAnimationFrame` 내에서 `fitAddon.fit()` 호출로 DOM 레이아웃 완료 후 크기 재조정
- **예외**:
  - `display: none` 상태에서 ResizeObserver가 0-size를 감지하여 PTY resize를 보내지 않도록 가드 처리
  - 비활성 상태에서는 `fitAddon.fit()` 호출을 스킵
- **인수 조건**:
  - 워크스페이스 A에서 명령 실행 → B로 전환 → A로 복귀 시 스크롤백 히스토리가 유지된다
  - 비활성 워크스페이스의 터미널에서 실행 중인 명령의 출력이 계속 기록된다
  - 복귀 시 터미널 크기가 올바르게 재조정된다

### FR-005: 세션 유지 상한 설정 — 우선순위: MEDIUM

- **설명**: 동시에 유지할 수 있는 워크스페이스 수의 상한을 설정에서 지정할 수 있다. 상한 초과 시 LRU(Least Recently Used) 방식으로 가장 오래 방문하지 않은 워크스페이스의 터미널을 해제한다.
- **입력**: 설정값 `maxAliveWorkspaces` (기본값: 전체 유지 = 워크스페이스 수와 동일)
- **출력**: 상한 초과 시 LRU 워크스페이스의 터미널 컴포넌트가 언마운트됨
- **세부 동작**:
  - 워크스페이스 방문 시 LRU 순서 업데이트
  - `maxAliveWorkspaces` 초과 시 가장 오래 방문하지 않은 워크스페이스의 터미널을 `dispose()` 후 DOM에서 제거
  - 해제된 워크스페이스에 복귀하면 터미널이 새로 초기화되고 서버 PTY에 재연결
  - 기본값은 `0` (= 제한 없음, 모든 워크스페이스 유지)
- **설정 위치**: `server/config.json5`의 `pty.maxAliveWorkspaces` 또는 프론트엔드 Settings UI
- **설정값 유효성**:
  - 0 = 제한 없음 (기본값)
  - 1~100 = 해당 수만큼 유지
  - 음수, 비정수, 100 초과 → 기본값(0)으로 폴백
- **인수 조건**:
  - `maxAliveWorkspaces=3`일 때 4번째 워크스페이스 진입 시 가장 오래된 워크스페이스의 터미널이 해제된다
  - `maxAliveWorkspaces=1`일 때 워크스페이스 전환 시 이전 워크스페이스가 즉시 해제된다
  - `maxAliveWorkspaces=0`일 때 모든 워크스페이스의 터미널이 항상 유지된다
  - 워크스페이스가 1개뿐일 때 LRU 해제가 발생하지 않는다 (현재 활성 워크스페이스는 해제 대상이 아님)
  - 해제된 워크스페이스에 복귀하면 터미널이 새로 초기화된다

## 4. 비기능 요구사항 (NFR)

### NFR-001: 메모리 효율 — MEDIUM

- xterm.js 인스턴스 유지 시 워크스페이스당 최대 8개 탭 × `scrollback` 줄 수만큼 메모리 사용
- `maxAliveWorkspaces` 설정으로 동시 유지 인스턴스 수를 제한하여 메모리 사용량 관리
- 기본 `scrollback` 값(현재 설정값) 변경 없음

### NFR-002: 전환 성능 — LOW

- 워크스페이스 전환 시 터미널 표시 지연 200ms 이내
- `display: none` → `flex` 전환 + `fitAddon.fit()` 호출로 즉시 표시

### NFR-003: 기존 기능 호환 — HIGH

- 탭 모드/그리드 모드의 기존 동작을 깨뜨리지 않음
- 기존 컨텍스트 메뉴 항목, 탭 이름 변경, 워크스페이스 관리 동작 유지

## 5. 인터페이스 명세

### 5.1 공유 컨텍스트 메뉴 빌더 함수

```typescript
// frontend/src/utils/contextMenuBuilder.ts (신규)

interface BuildTerminalMenuOptions {
  tab: WorkspaceTabRuntime | undefined;
  tabs: WorkspaceTabRuntime[];
  maxTabs: number;
  availableShells?: ShellInfo[];
  onAddTab: (cwd?: string, shell?: string) => void;
  onCloseTab: (tabId: string) => void;
  onCopy: () => Promise<void>;
  onPaste: (tabId: string) => Promise<void>;
  hasSelection: boolean;
}

function buildTerminalContextMenuItems(options: BuildTerminalMenuOptions): ContextMenuItem[]
```

### 5.2 MetadataRow 이름 편집 Props 확장

```typescript
// MetadataRow props 추가
interface MetadataRowProps {
  tab: WorkspaceTabRuntime;
  isOdd: boolean;
  onRename?: (name: string) => void;  // 추가
}
```

### 5.3 세션 유지 설정 인터페이스

```typescript
// 설정 확장
interface PTYConfig {
  // 기존 필드 유지...
  maxAliveWorkspaces: number;  // 추가. 0 = 제한 없음
}
```

### 5.4 데이터 모델

기존 데이터 모델 변경 없음. `WorkspaceTabRuntime`, `Workspace` 타입 유지.

LRU 추적을 위한 런타임 상태 추가 (React state):
```typescript
// useWorkspaceManager 또는 App.tsx 내부
const [workspaceVisitOrder, setWorkspaceVisitOrder] = useState<string[]>([]);
// 워크스페이스 전환 시 해당 ID를 배열 맨 뒤로 이동
```

## 6. 제약사항

### 6.1 기술 스택 제약

- React 18, TypeScript, xterm.js (현재 버전 유지)
- xterm.js의 `Terminal.dispose()` 호출 후에는 스크롤백 복원 불가 → DOM 유지 방식 필수

### 6.2 아키텍처 제약

- `TerminalContainer`의 `isVisible` prop이 이미 존재하여 `display: none` 토글 가능
- `TerminalView`의 `ResizeObserver`가 `display: none` 상태에서 0-size를 감지할 수 있음 → `isVisible` 조건 가드 필요
- 현재 `App.tsx`에서 `activeWorkspaceTabs`만 렌더링하는 구조를 전체 탭 렌더링으로 변경 필요

### 6.3 비즈니스 제약

- 기존 사용자 워크플로우를 방해하지 않아야 함
- 설정 기본값은 "제한 없음"으로 하여 기존 동작과 다르지만 데이터 손실은 없도록 함

## 7. 수용 조건 (Acceptance Criteria)

### FR-001 수용 조건
- [ ] 탭 모드에서 터미널 영역 우클릭 시 ContextMenu가 표시된다
- [ ] 메뉴 항목이 그리드 모드와 동일하다 (새 세션/세션 닫기/복사/붙여넣기)
- [ ] 각 메뉴 항목 클릭 시 해당 동작이 정상 실행된다
- [ ] 브라우저 기본 컨텍스트 메뉴가 억제된다

### FR-002 수용 조건
- [ ] `MosaicContainer`와 `App.tsx`(탭 모드)에서 동일한 빌더 함수를 사용한다
- [ ] 빌더 함수 변경 시 양쪽 모드에 동시 반영된다

### FR-003 수용 조건
- [ ] 그리드 모드 MetadataRow의 세션 이름 더블클릭 시 인라인 입력이 표시된다
- [ ] Enter로 이름 변경, ESC로 취소, 빈 문자열 시 기존 이름 유지
- [ ] 최대 32자 제한이 적용된다
- [ ] 편집 로직이 탭 모드와 코드 수준에서 공유된다

### FR-004 수용 조건
- [ ] 워크스페이스 A → B → A 전환 시 A의 스크롤백 히스토리가 유지된다
- [ ] 비활성 워크스페이스에서 실행 중인 명령의 출력이 계속 기록된다
- [ ] 복귀 시 터미널 크기가 올바르게 재조정된다 (fitAddon.fit)
- [ ] 비활성 상태에서 PTY resize 이벤트가 전송되지 않는다

### FR-005 수용 조건
- [ ] `maxAliveWorkspaces=3` 설정 시 4번째 워크스페이스 진입 시 가장 오래된 것이 해제된다
- [ ] `maxAliveWorkspaces=0` 설정 시 모든 워크스페이스가 유지된다
- [ ] 해제된 워크스페이스 복귀 시 터미널이 새로 초기화된다

### 통합 테스트 시나리오
- [ ] 탭 모드에서 우클릭 메뉴로 세션 추가 → 그리드 모드 전환 → 동일 메뉴 확인
- [ ] 그리드 모드에서 이름 변경 → 탭 모드 전환 → 변경된 이름 확인
- [ ] 5개 워크스페이스 순회 → 첫 번째 워크스페이스 복귀 → 스크롤백 유지 확인
- [ ] `maxAliveWorkspaces=2` 설정 → 3개 워크스페이스 순회 → 첫 번째 복귀 → 초기화 확인
- [ ] 탭 모드와 그리드 모드에서 컨텍스트 메뉴 빌더가 동일 함수를 호출하는지 확인 (FR-002)
- [ ] `maxAliveWorkspaces=1` → 워크스페이스 전환 → 이전 워크스페이스 복귀 → 초기화 확인
- [ ] 비활성 워크스페이스에서 PTY 종료 → 복귀 시 DisconnectedOverlay 표시 확인
