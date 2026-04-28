# Software Requirements Specification (SRS)
# Claude Web Shell - Step 3: UX Enhancement & File Manager

**Version**: 1.0.0
**Date**: 2026-02-15
**Status**: Draft
**Depends On**: srs.step2.md (Step 2)

---

## 1. Introduction

### 1.1 Purpose
본 문서는 Claude Web Shell의 사용자 경험 향상 및 파일 관리 기능 구현을 위한 소프트웨어 요구사항 명세서입니다. Step 2(Security)에서 확보한 보안 기반 위에 모바일 반응형 UI, 세션 관리 고도화, Mdir 스타일 파일 브라우저, 파일 뷰어를 추가합니다.

### 1.2 Scope
- **단계**: Step 3 - UX Enhancement & File Manager
- **목표**: 모바일 환경 지원, 세션 관리 편의성 향상, 파일 탐색/뷰어 기능 제공
- **범위**: 반응형 레이아웃, 터미널 핀치줌, 세션 컨텍스트 메뉴, 세션 이름 변경, Mdir 파일 브라우저, 마크다운/코드 뷰어

### 1.3 Definitions and Acronyms

| 용어 | 설명 |
|------|------|
| Responsive | 화면 크기에 따라 레이아웃이 자동 조정되는 디자인 |
| Breakpoint | 레이아웃이 전환되는 화면 너비 기준값 |
| Hamburger Menu | 세 줄 아이콘(≡)으로 표시되는 모바일 내비게이션 토글 버튼 |
| Pinch-to-Zoom | 두 손가락으로 확대/축소하는 터치 제스처 |
| Context Menu | 마우스 우클릭 시 나타나는 동작 메뉴 |
| Mdir | 1991년 최정한이 개발한 한국의 DOS 파일 관리자 프로그램 |
| MCD | Mdir Change Directory - Mdir의 디렉토리 트리 탐색 기능 |
| Single-Pane | Mdir의 단일 패널 레이아웃 (Norton Commander의 Dual-Pane과 대비) |
| Mermaid | 마크다운 내에서 다이어그램을 텍스트로 정의하는 도구 |
| Syntax Highlighting | 프로그래밍 언어 문법에 따라 코드에 색상을 입히는 기능 |
| GFM | GitHub Flavored Markdown - 테이블, 체크리스트 등을 지원하는 확장 마크다운 |
| CWD | Current Working Directory - 현재 작업 디렉토리 |

### 1.4 User Requirements Mapping

| UR-ID | 사용자 요구사항 | 관련 FR |
|-------|----------------|---------|
| UR-101 | 모바일에서 좌측 세션창 숨김, 햄버거 버튼으로 토글 | FR-1801, FR-1802, FR-1803 |
| UR-102 | 모바일 터미널 핀치줌으로 폰트 크기 조절 (최소/최대 제한) | FR-1901, FR-1902, FR-1903 |
| UR-103 | 세션 우클릭 컨텍스트 메뉴 (이름 바꾸기, 종료, 위로/아래로) | FR-2001, FR-2002, FR-2003 |
| UR-104 | 세션 이름 변경 모달, 중복 이름 불허 | FR-2101, FR-2102, FR-2103 |
| UR-105 | Mdir 스타일 파일 브라우저 (키보드, 2-컬럼, 파일 조작) | FR-2201 ~ FR-2209 |
| UR-106 | MD 뷰어 (흰 배경, 코드블록, Mermaid) + 코드 편집기 (구문 강조) | FR-2301 ~ FR-2304 |

### 1.5 Current Implementation Status (Post Step 2)

| 항목 | 상태 | 비고 |
|------|------|------|
| 인증/보안 | ✅ 구현 완료 | JWT, 2FA, SSL |
| 세션 CRUD | ✅ 구현 완료 | 생성/조회/삭제 |
| 터미널 UI | ✅ 구현 완료 | xterm.js |
| SSE 스트리밍 | ✅ 구현 완료 | 실시간 출력 |
| 모바일 대응 | ❌ 미구현 | 데스크톱 전용 |
| 세션 이름 변경 | ❌ 미구현 | 고정 이름 |
| 세션 정렬 | ❌ 미구현 | 생성순 고정 |
| 파일 탐색 | ❌ 미구현 | 없음 |
| 파일 뷰어 | ❌ 미구현 | 없음 |

### 1.6 Document Conventions

- **FR-XXXX**: Functional Requirement (기능 요구사항)
- **NFR-XXXX**: Non-Functional Requirement (비기능 요구사항)
- **TC-XXXX**: Test Condition (테스트 조건)
- **AC-XXXX**: Acceptance Criteria (인수 조건)
- **FE-XXXX**: Frontend Requirement (프론트엔드 요구사항)

---

## 2. Architecture

### 2.1 Enhanced Component Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Frontend (React 19)                              │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │                    App Shell (Responsive)                      │  │
│  │  ┌──────────┐  ┌──────────────────────────────────────────┐   │  │
│  │  │ Hamburger │  │              Header                      │   │  │
│  │  │ (Mobile)  │  │  + [📁+] File Manager Toggle Button     │   │  │
│  │  └──────────┘  └──────────────────────────────────────────┘   │  │
│  │  ┌──────────────┐  ┌─────────────────────────────────────┐   │  │
│  │  │   Sidebar    │  │         Main Content Area           │   │  │
│  │  │  (Overlay on │  │  ┌─────────────────────────────┐    │   │  │
│  │  │   mobile)    │  │  │  Tab: Terminal (xterm.js)   │    │   │  │
│  │  │              │  │  │  - Pinch-to-Zoom support    │    │   │  │
│  │  │ ┌──────────┐ │  │  ├─────────────────────────────┤    │   │  │
│  │  │ │ Session  │ │  │  │  Tab: Mdir File Browser     │    │   │  │
│  │  │ │ List     │ │  │  │  - DOS-style file listing   │    │   │  │
│  │  │ │          │ │  │  ├─────────────────────────────┤    │   │  │
│  │  │ │ [Right-  │ │  │  │  Tab: File Viewer           │    │   │  │
│  │  │ │  click   │ │  │  │  - Markdown / Code          │    │   │  │
│  │  │ │  context │ │  │  └─────────────────────────────┘    │   │  │
│  │  │ │  menu]   │ │  └─────────────────────────────────────┘   │  │
│  │  │ └──────────┘ │                                             │  │
│  │  └──────────────┘                                             │  │
│  └────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Mobile Responsive Layout

```
Desktop (≥ 768px)                    Mobile (< 768px)
┌────────┬───────────────┐           ┌───────────────────┐
│Sidebar │  Terminal/     │           │ [≡] Header        │
│(Always)│  File Manager  │           ├───────────────────┤
│        │               │           │  Terminal/         │
│        │               │           │  File Manager      │
│        │               │           │  (Full Width)      │
│        │               │           │                    │
└────────┴───────────────┘           └───────────────────┘

                                     Sidebar Open (Overlay):
                                     ┌────────┬──────────┐
                                     │Sidebar │ (Dimmed) │
                                     │(Slide) │          │
                                     │        │          │
                                     └────────┴──────────┘
```

### 2.3 File Manager Data Flow

```
┌──────────┐                    ┌──────────┐
│  Client  │                    │  Server  │
│ (Mdir UI)│                    │          │
└────┬─────┘                    └────┬─────┘
     │                               │
     │  1. GET /api/sessions/:id/cwd │
     │──────────────────────────────>│
     │<──────────────────────────────│
     │  { cwd: "/home/user" }        │
     │                               │
     │  2. GET /api/sessions/:id/    │
     │     files?path=/home/user     │
     │──────────────────────────────>│
     │                               │  Read directory
     │                               │  (fs.readdir + stat)
     │<──────────────────────────────│
     │  { files: [...], cwd: "..." } │
     │                               │
     │  3. User selects file         │
     │  GET /api/sessions/:id/       │
     │     files/read?path=...       │
     │──────────────────────────────>│
     │                               │  Read file content
     │                               │  (fs.readFile, max 1MB)
     │<──────────────────────────────│
     │  { content: "...",            │
     │    encoding: "utf-8",         │
     │    size: 1234 }               │
     │                               │
     │  4. Open in Viewer            │
     │  (Markdown or Code)           │
     │                               │
     │  5. File Operations           │
     │  POST .../files/copy          │
     │  POST .../files/move          │
     │  DELETE .../files?path=...    │
     │──────────────────────────────>│
     │                               │  fs.copyFile / rename
     │                               │  / unlink
     │<──────────────────────────────│
     │  { success: true }            │
     │                               │
     │  6. Refresh file list         │
     │  (Auto after operation)       │
     │                               │
```

### 2.4 Error Recovery Scenarios

| 시나리오 | 원인 | 복구 방법 |
|----------|------|----------|
| ER-301 | 파일 목록 조회 실패 (권한) | 에러 메시지 표시, 상위 디렉토리 이동 제안 |
| ER-302 | 파일 읽기 실패 (크기 초과) | "파일이 너무 큽니다 (최대 1MB)" 메시지 |
| ER-303 | 파일 읽기 실패 (바이너리) | "바이너리 파일은 볼 수 없습니다" 메시지 |
| ER-304 | CWD 조회 실패 | 홈 디렉토리로 폴백 |
| ER-305 | 세션 이름 중복 | 모달에서 에러 메시지 표시, 입력 유지 |
| ER-306 | 터치 제스처 미지원 브라우저 | 폰트 크기 조절 버튼(+/-) 폴백 제공 |
| ER-307 | 파일 복사 실패 (권한/공간) | 에러 다이얼로그 표시, 원본 유지 |
| ER-308 | 파일 이동 실패 (권한) | 에러 다이얼로그 표시, 원본 유지 |
| ER-309 | 파일 삭제 실패 (권한) | 에러 다이얼로그 표시 |
| ER-310 | 복사/이동 대상에 동일 파일 존재 | "Overwrite?" 확인 다이얼로그 표시 |

---

## 3. Functional Requirements

### 3.1 Mobile Responsive Design (FR-1800)

#### FR-1801: Responsive Layout Breakpoints
- **ID**: FR-1801
- **Source**: UR-101
- **Priority**: P0 (Critical)
- **Description**: 화면 크기에 따라 레이아웃을 자동 전환한다
- **Breakpoints**:

| 구분 | 너비 | 사이드바 | 레이아웃 |
|------|------|----------|----------|
| Mobile | < 768px | 기본 숨김, 오버레이 | 단일 컬럼 |
| Desktop | ≥ 768px | 항상 표시 | 사이드바 + 메인 |

- **CSS Media Query**: `@media (max-width: 767px)`
- **Processing**:
  1. 뷰포트 너비 감지 (window.innerWidth 또는 CSS media query)
  2. 768px 미만: 사이드바 숨김, 햄버거 버튼 표시
  3. 768px 이상: 사이드바 항상 표시, 햄버거 버튼 숨김
  4. 화면 회전(orientation change) 시 레이아웃 재계산
- **Acceptance Criteria**:
  - AC-1801-1: 767px 이하에서 사이드바가 숨겨진다
  - AC-1801-2: 768px 이상에서 사이드바가 항상 표시된다
  - AC-1801-3: 브라우저 리사이즈 시 즉시 레이아웃 전환
  - AC-1801-4: 화면 회전 시 올바른 레이아웃 적용
- **Boundary Conditions**:
  - 최소 지원 너비: 320px (iPhone SE)
  - 최대 지원 너비: 제한 없음
  - 사이드바 고정 너비: 250px (데스크톱)

#### FR-1802: Sidebar Toggle (Hamburger Menu)
- **ID**: FR-1802
- **Source**: UR-101
- **Priority**: P0 (Critical)
- **Description**: 모바일에서 햄버거 버튼으로 사이드바를 토글한다
- **Hamburger Button**:
  - 위치: 헤더 좌측 상단
  - 아이콘: 세 줄 아이콘 (≡), 열린 상태에서 X 아이콘
  - 표시 조건: 뷰포트 < 768px
- **Sidebar Overlay 동작**:
  1. 햄버거 버튼 클릭 → 사이드바 좌측에서 슬라이드 인 (300ms ease-out)
  2. 사이드바 우측의 반투명 배경(dimmed overlay) 클릭 → 사이드바 닫힘
  3. 세션 선택 시 → 사이드바 자동 닫힘
  4. ESC 키 → 사이드바 닫힘
- **Dimmed Overlay**:
  - 색상: rgba(0, 0, 0, 0.5)
  - z-index: 사이드바보다 1 낮음
  - 클릭 시 사이드바 닫힘
- **Acceptance Criteria**:
  - AC-1802-1: 모바일에서 햄버거 버튼이 헤더 좌측에 표시된다
  - AC-1802-2: 버튼 클릭 시 사이드바가 슬라이드 인 애니메이션으로 나타난다
  - AC-1802-3: dimmed 영역 클릭 시 사이드바가 닫힌다
  - AC-1802-4: 세션 선택 시 사이드바가 자동으로 닫힌다
  - AC-1802-5: ESC 키 입력 시 사이드바가 닫힌다
  - AC-1802-6: 데스크톱에서 햄버거 버튼이 숨겨진다
- **Animation**: CSS transition, transform: translateX(-100%) → translateX(0), 300ms ease-out

#### FR-1803: Mobile Viewport Configuration
- **ID**: FR-1803
- **Source**: UR-101
- **Priority**: P0 (Critical)
- **Description**: 모바일 브라우저에서 올바른 뷰포트를 설정한다
- **Meta Tag**:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
```
- **Rationale**: 핀치줌은 터미널 영역에서만 커스텀 동작으로 처리하며, 브라우저 기본 줌은 비활성화
- **Acceptance Criteria**:
  - AC-1803-1: 모바일 브라우저에서 페이지 확대/축소 불가
  - AC-1803-2: 터미널 영역에서만 핀치줌 커스텀 동작 동작
  - AC-1803-3: 320px 너비에서도 UI가 깨지지 않음

### 3.2 Terminal Pinch-to-Zoom (FR-1900)

#### FR-1901: Pinch Gesture Detection
- **ID**: FR-1901
- **Source**: UR-102
- **Priority**: P1 (High)
- **Description**: 터미널 영역에서 두 손가락 핀치 제스처를 감지한다
- **Gesture Detection**:
  - 이벤트: `touchstart`, `touchmove`, `touchend`
  - 조건: touches.length === 2
  - 거리 계산: 두 터치 포인트 간의 유클리드 거리
  - 줌 배율: (현재 거리 / 시작 거리)
- **Processing**:
  1. `touchstart`: 두 손가락 감지 시 초기 거리 저장
  2. `touchmove`: 거리 변화 계산, 폰트 크기 조절
  3. `touchend`: 최종 폰트 크기 확정, localStorage에 저장
- **Debounce**: 16ms (60fps) requestAnimationFrame 사용
- **Acceptance Criteria**:
  - AC-1901-1: 두 손가락 벌리기 → 폰트 크기 증가
  - AC-1901-2: 두 손가락 오므리기 → 폰트 크기 감소
  - AC-1901-3: 한 손가락 터치 시 줌 동작 안 함
  - AC-1901-4: 제스처 중 터미널 스크롤 방지

#### FR-1902: Font Size Scaling
- **ID**: FR-1902
- **Source**: UR-102
- **Priority**: P1 (High)
- **Description**: 핀치 제스처에 따라 터미널 폰트 크기를 조절한다
- **Font Size Range**:

| 속성 | 값 | 단위 |
|------|-----|------|
| 최소 (MIN) | 8 | px |
| 기본 (DEFAULT) | 14 | px |
| 최대 (MAX) | 32 | px |
| 변경 단위 (STEP) | 1 | px |

- **Processing**:
  1. 핀치 비율 계산: ratio = currentDistance / startDistance
  2. 새 폰트 크기: Math.round(startFontSize * ratio)
  3. 범위 클램핑: Math.max(MIN, Math.min(MAX, newSize))
  4. xterm.js 옵션 업데이트: `terminal.options.fontSize = newSize`
  5. 터미널 fit: `fitAddon.fit()` 호출로 행/열 재계산
- **Visual Feedback**: 줌 변경 시 화면 중앙에 현재 폰트 크기 토스트 표시 (1초 후 사라짐)
- **Acceptance Criteria**:
  - AC-1902-1: 폰트 크기가 8px 미만으로 줄지 않는다
  - AC-1902-2: 폰트 크기가 32px 초과로 커지지 않는다
  - AC-1902-3: 폰트 크기 변경 후 터미널 행/열 수가 재계산된다
  - AC-1902-4: 폰트 크기 변경 시 기존 출력 내용이 유지된다
  - AC-1902-5: 줌 변경 시 현재 크기가 잠시 표시된다

#### FR-1903: Font Size Persistence
- **ID**: FR-1903
- **Source**: UR-102
- **Priority**: P2 (Medium)
- **Description**: 사용자가 조절한 폰트 크기를 저장하여 세션 간 유지한다
- **Storage**:
  - Key: `terminal_font_size`
  - Storage: localStorage
  - Format: 정수 (예: "14")
- **Lifecycle**:
  1. 앱 로드 시: localStorage에서 폰트 크기 읽기
  2. 없으면 기본값(14px) 사용
  3. 핀치줌으로 변경 시: 즉시 localStorage에 저장
  4. 새 세션 열어도 동일한 폰트 크기 적용
- **Fallback**: 터치 미지원 환경에서는 Ctrl+마우스 휠로 동일 기능 제공
- **Acceptance Criteria**:
  - AC-1903-1: 폰트 크기 변경 후 페이지 새로고침 시 유지된다
  - AC-1903-2: localStorage 비활성 환경에서 기본값으로 동작
  - AC-1903-3: 데스크톱에서 Ctrl+휠로 폰트 크기 조절 가능

### 3.3 Session Context Menu (FR-2000)

#### FR-2001: Context Menu Trigger
- **ID**: FR-2001
- **Source**: UR-103
- **Priority**: P1 (High)
- **Description**: 사이드바 세션 항목에서 컨텍스트 메뉴를 표시한다
- **Trigger**:
  - 데스크톱: 마우스 오른쪽 클릭 (`contextmenu` 이벤트)
  - 모바일: 길게 누르기 (long press, 500ms)
- **Position**:
  - 마우스 클릭 위치에 메뉴 표시
  - 화면 경계를 넘어가면 반대 방향으로 조정
- **Dismiss**:
  - 메뉴 외부 클릭 시 닫힘
  - ESC 키 입력 시 닫힘
  - 스크롤 시 닫힘
- **Acceptance Criteria**:
  - AC-2001-1: 세션 항목 우클릭 시 컨텍스트 메뉴가 표시된다
  - AC-2001-2: 모바일에서 길게 누르기 시 컨텍스트 메뉴가 표시된다
  - AC-2001-3: 기본 브라우저 컨텍스트 메뉴가 차단된다 (preventDefault)
  - AC-2001-4: 메뉴가 화면 밖으로 나가지 않는다

#### FR-2002: Context Menu Items
- **ID**: FR-2002
- **Source**: UR-103
- **Priority**: P1 (High)
- **Description**: 컨텍스트 메뉴에 4가지 항목을 제공한다
- **Menu Items**:

| 순서 | 아이콘 | 라벨 | 동작 | 단축키 |
|------|--------|------|------|--------|
| 1 | ✏️ | 이름 바꾸기 | FR-2101 이름 변경 모달 열기 | F2 |
| 2 | ⬆️ | 위로 이동 | FR-2003 세션 순서 위로 | - |
| 3 | ⬇️ | 아래로 이동 | FR-2003 세션 순서 아래로 | - |
| 4 | ❌ | 종료 | 세션 삭제 (DELETE /api/sessions/:id) | Del |

- **Disabled Conditions**:
  - "위로 이동": 첫 번째 세션일 때 비활성화 (회색 처리)
  - "아래로 이동": 마지막 세션일 때 비활성화 (회색 처리)
- **Styling**:
  - 배경: 어두운 회색 (#2D2D2D)
  - 텍스트: 흰색 (#FFFFFF)
  - 호버: 강조 배경 (#3D3D3D)
  - 비활성: 회색 텍스트 (#888888)
  - 구분선: "아래로 이동"과 "종료" 사이에 구분선
  - 모서리: border-radius 6px
  - 그림자: box-shadow 0 2px 8px rgba(0,0,0,0.3)
- **Acceptance Criteria**:
  - AC-2002-1: 4개 메뉴 항목이 순서대로 표시된다
  - AC-2002-2: 첫 번째 세션에서 "위로 이동"이 비활성화된다
  - AC-2002-3: 마지막 세션에서 "아래로 이동"이 비활성화된다
  - AC-2002-4: "종료" 클릭 시 확인 대화상자 후 세션 삭제
  - AC-2002-5: "종료"와 이동 메뉴 사이에 구분선 표시

#### FR-2003: Session Reorder
- **ID**: FR-2003
- **Source**: UR-103
- **Priority**: P1 (High)
- **Description**: 세션 목록에서 순서를 변경한다
- **Data Model Change**:
```typescript
interface Session {
  // ... 기존 필드
  sortOrder: number;  // NEW: 정렬 순서 (0부터 시작)
}
```
- **Processing** (위로 이동):
  1. 현재 세션의 sortOrder = N
  2. 바로 위 세션(sortOrder = N-1) 찾기
  3. 두 세션의 sortOrder 교환
  4. PATCH /api/sessions/:id { sortOrder: N-1 }
  5. 사이드바 목록 재정렬
- **Processing** (아래로 이동):
  1. 현재 세션의 sortOrder = N
  2. 바로 아래 세션(sortOrder = N+1) 찾기
  3. 두 세션의 sortOrder 교환
  4. PATCH /api/sessions/:id { sortOrder: N+1 }
  5. 사이드바 목록 재정렬
- **Initial sortOrder**: 세션 생성 시 현재 최대 sortOrder + 1 할당
- **Acceptance Criteria**:
  - AC-2003-1: "위로 이동" 클릭 시 세션이 한 칸 위로 이동
  - AC-2003-2: "아래로 이동" 클릭 시 세션이 한 칸 아래로 이동
  - AC-2003-3: 이동 후 사이드바 목록이 즉시 갱신
  - AC-2003-4: 페이지 새로고침 후에도 순서 유지

### 3.4 Session Rename (FR-2100)

#### FR-2101: Rename Modal UI
- **ID**: FR-2101
- **Source**: UR-104
- **Priority**: P1 (High)
- **Description**: 세션 이름을 변경하는 모달 대화상자를 제공한다
- **Modal Components**:
  - 제목: "세션 이름 변경"
  - 입력 필드: 현재 세션 이름이 pre-fill, 자동 포커스, 전체 선택
  - 에러 메시지 영역: 입력 필드 아래
  - 확인 버튼: "변경" (파란색, 유효 입력 시 활성화)
  - 취소 버튼: "취소"
- **Trigger**:
  - 컨텍스트 메뉴에서 "이름 바꾸기" 선택
  - 세션 항목 더블클릭
  - F2 키 (선택된 세션)
- **Behavior**:
  1. 모달 열림 → 현재 이름이 입력 필드에 표시, 전체 텍스트 선택
  2. 입력 중 → 실시간 유효성 검증 (FR-2102)
  3. Enter 키 또는 "변경" 클릭 → API 호출 (FR-2103)
  4. ESC 키 또는 "취소" → 모달 닫힘, 변경 없음
  5. 모달 외부 클릭 → 모달 닫힘
- **Acceptance Criteria**:
  - AC-2101-1: 모달 열림 시 현재 이름이 입력 필드에 표시된다
  - AC-2101-2: 입력 필드에 자동 포커스, 텍스트 전체 선택
  - AC-2101-3: Enter 키로 변경 확인 가능
  - AC-2101-4: ESC 키로 취소 가능
  - AC-2101-5: 유효하지 않은 입력 시 "변경" 버튼 비활성화

#### FR-2102: Session Name Validation
- **ID**: FR-2102
- **Source**: UR-104
- **Priority**: P1 (High)
- **Description**: 세션 이름의 유효성을 검증한다
- **Validation Rules**:

| 규칙 | 조건 | 에러 메시지 |
|------|------|-------------|
| 필수 입력 | 빈 문자열 불가 | "세션 이름을 입력해주세요" |
| 최소 길이 | 1자 이상 | "세션 이름을 입력해주세요" |
| 최대 길이 | 50자 이하 | "세션 이름은 50자 이하로 입력해주세요" |
| 허용 문자 | Unicode 문자, 숫자, 공백, 하이픈, 언더스코어 | "허용되지 않는 문자가 포함되어 있습니다" |
| 앞뒤 공백 | 자동 trim | (자동 처리) |
| 중복 검사 | 같은 이름의 세션 없어야 함 | "이미 사용 중인 세션 이름입니다" |

- **Validation Timing**:
  - 클라이언트: 입력 시 실시간 (debounce 300ms)
  - 서버: API 요청 시 최종 검증
- **Acceptance Criteria**:
  - AC-2102-1: 빈 이름 → 에러 메시지 표시
  - AC-2102-2: 51자 이상 입력 → 에러 메시지 표시
  - AC-2102-3: 기존 세션과 동일한 이름 → "이미 사용 중인 세션 이름입니다"
  - AC-2102-4: 앞뒤 공백이 자동 제거된다
  - AC-2102-5: 유효한 이름 입력 시 에러 메시지 사라짐

#### FR-2103: Rename API Endpoint
- **ID**: FR-2103
- **Source**: UR-104
- **Priority**: P1 (High)
- **Description**: 세션 이름을 변경하는 API를 제공한다
- **Endpoint**: PATCH /api/sessions/:id
- **Request**:
```json
{
  "name": "새 세션 이름"
}
```
- **Response (200 OK)**:
```json
{
  "success": true,
  "session": {
    "id": "uuid",
    "name": "새 세션 이름",
    "status": "idle",
    "sortOrder": 0,
    "createdAt": "2026-02-15T10:00:00Z"
  }
}
```
- **Response (400 Bad Request)**:
```json
{
  "error": {
    "code": "INVALID_SESSION_NAME",
    "message": "Invalid session name",
    "details": { "reason": "too_long" }
  }
}
```
- **Response (409 Conflict)**:
```json
{
  "error": {
    "code": "DUPLICATE_SESSION_NAME",
    "message": "Session name already exists"
  }
}
```
- **Processing**:
  1. JWT 인증 확인
  2. 세션 존재 확인
  3. 소유권 확인
  4. 이름 유효성 검증 (FR-2102 규칙)
  5. 중복 이름 검사 (대소문자 구분)
  6. 이름 업데이트
  7. 성공 응답 반환
- **Acceptance Criteria**:
  - AC-2103-1: 유효한 이름 → 200 OK + 업데이트된 세션 정보
  - AC-2103-2: 중복 이름 → 409 DUPLICATE_SESSION_NAME
  - AC-2103-3: 빈 이름 → 400 INVALID_SESSION_NAME
  - AC-2103-4: 인증 없음 → 401 MISSING_TOKEN

### 3.5 File Manager - Mdir Style (FR-2200)

#### FR-2201: File Manager Panel Toggle
- **ID**: FR-2201
- **Source**: UR-105
- **Priority**: P0 (Critical)
- **Description**: 터미널 상단의 버튼으로 Mdir 파일 브라우저 패널을 토글한다
- **Toggle Button**:
  - 위치: 터미널 영역 상단 툴바
  - 아이콘: 📁+ (폴더 아이콘 + 플러스)
  - 라벨: "Files" (아이콘 옆 텍스트, 모바일에서 숨김)
- **Panel Behavior**:
  - 토글 시 터미널 ↔ 파일 브라우저 탭 전환
  - 터미널 탭: 기존 xterm.js 터미널
  - 파일 브라우저 탭: Mdir 스타일 파일 목록
  - 파일 뷰어 탭: 파일 선택 시 열림
- **Tab Bar**:
  - 위치: 메인 컨텐츠 영역 상단
  - 탭 목록: [Terminal] [Files] [Viewer] (Viewer는 파일 선택 시에만 표시)
  - 활성 탭 표시: 하단 강조 바
- **Acceptance Criteria**:
  - AC-2201-1: 📁+ 버튼 클릭 시 Files 탭으로 전환
  - AC-2201-2: Terminal 탭 클릭 시 터미널로 복귀
  - AC-2201-3: 파일 브라우저에서 파일 선택 시 Viewer 탭 자동 열림
  - AC-2201-4: Viewer 탭은 파일이 열려있을 때만 표시

#### FR-2202: Directory Listing API
- **ID**: FR-2202
- **Source**: UR-105
- **Priority**: P0 (Critical)
- **Description**: 세션의 특정 경로에 있는 파일/디렉토리 목록을 반환한다
- **Endpoint**: GET /api/sessions/:id/files
- **Query Parameters**:

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| path | string | No | 조회할 경로 (기본값: CWD) |

- **Response (200 OK)**:
```json
{
  "cwd": "/home/user/project",
  "path": "/home/user/project",
  "entries": [
    {
      "name": "..",
      "type": "directory",
      "size": 0,
      "modified": "2026-02-15T10:00:00Z"
    },
    {
      "name": "src",
      "type": "directory",
      "size": 0,
      "modified": "2026-02-15T09:30:00Z"
    },
    {
      "name": "README.md",
      "type": "file",
      "size": 2048,
      "extension": ".md",
      "modified": "2026-02-14T15:00:00Z"
    }
  ],
  "totalEntries": 3
}
```
- **Sorting**: 디렉토리 우선, 이름 오름차순 (대소문자 무시)
- **Security**:
  - Path traversal 방지: `..`가 포함된 경로를 정규화하여 base path 이탈 방지
  - 심볼릭 링크: realpath 확인 후 base path 내 여부 검증
  - 최대 항목 수: 10,000개 (초과 시 잘림 + totalEntries에 실제 수 표시)
- **Acceptance Criteria**:
  - AC-2202-1: 유효한 경로 → 파일/디렉토리 목록 반환
  - AC-2202-2: 디렉토리가 파일보다 먼저 정렬된다
  - AC-2202-3: ".." 항목이 항상 첫 번째로 포함된다 (루트 제외)
  - AC-2202-4: path traversal 시도 → 403 Forbidden
  - AC-2202-5: 존재하지 않는 경로 → 404 Not Found

#### FR-2203: Mdir Visual Theme
- **ID**: FR-2203
- **Source**: UR-105
- **Priority**: P0 (Critical)
- **Description**: DOS 시대의 Mdir 파일 관리자에서 영감을 받은 미니멀 흑백 테마를 적용한다
- **Color Palette (Simplified)**:

| CSS Variable | HEX | 용도 |
|-------------|-----|------|
| --mdir-bg | #000000 | 전체 배경 |
| --mdir-text | #FFFFFF | 기본 텍스트 |
| --mdir-border | #FFFFFF | 테두리/프레임 |
| --mdir-dir | #FFFF55 | 디렉토리명 (노란색) |
| --mdir-md | #55FF55 | .md 파일 (초록색) |
| --mdir-selected-bg | #FFFFFF | 선택 항목 배경 |
| --mdir-selected-text | #000000 | 선택 항목 텍스트 |

- **UI Element Color Mapping**:

| UI 요소 | 전경색 | 배경색 | 설명 |
|---------|--------|--------|------|
| 전체 배경 | - | #000000 (Black) | 검은 배경 |
| 테두리/프레임 | #FFFFFF (White) | - | 패널 테두리 |
| 일반 파일 | #FFFFFF (White) | - | 기본 파일 텍스트 |
| 디렉토리 | #FFFF55 (Yellow) | - | 디렉토리명 (노란색) |
| .md 파일 | #55FF55 (Green) | - | 마크다운 파일 (초록색) |
| 상단 경로 바 | #000000 (Black) | #FFFFFF (White) | 경로 표시 영역 (반전) |
| 하단 기능키 바 | #000000 (Black) | #FFFFFF (White) | F키 라벨 (반전) |
| 상태 바 | #AAAAAA (Gray) | #000000 (Black) | 파일 정보 (약간 어두운 흰색) |
| 선택 항목 | #000000 (Black) | #FFFFFF (White) | 반전 색상 (커서) |
| 입력 필드 | #FFFFFF (White) | #333333 (Dark Gray) | 다이얼로그 입력 |

- **Font**: 모노스페이스 (Consolas, "Courier New", monospace)
- **Box-drawing Characters**: CSS border로 구현, 1px solid white
- **Acceptance Criteria**:
  - AC-2203-1: 배경색이 검은색(#000000)이다
  - AC-2203-2: 테두리가 흰색(#FFFFFF)이다
  - AC-2203-3: 디렉토리가 노란색(#FFFF55)으로 표시된다
  - AC-2203-4: .md 파일이 초록색(#55FF55)으로 표시된다
  - AC-2203-5: 선택된 항목이 반전 색상(흰 배경 + 검은 글자)으로 표시된다
  - AC-2203-6: 모노스페이스 폰트가 적용된다

#### FR-2204: Mdir 2-Column Detailed File Listing
- **ID**: FR-2204
- **Source**: UR-105
- **Priority**: P0 (Critical)
- **Description**: 실제 DOS Mdir과 동일하게 단일 패널 내 2-컬럼 파일 목록을 표시한다. 각 항목은 이름, 확장자, 크기, 날짜, 시간을 포함한다.
- **Layout**: 단일 패널(Single-Pane), 2-컬럼 배치
  - 패널 전체를 좌우 2개 컬럼으로 분할
  - 파일 목록은 좌측 컬럼을 위→아래로 채운 후 우측 컬럼으로 넘어감 (column-first fill)
  - 모바일(< 480px)에서는 1-컬럼으로 폴백
- **Entry Display Format** (모노스페이스, 고정폭):
  ```
  NAME     EXT   SIZE      DATE     TIME
  ────────────────────────────────────────
  ..       <DIR>
  DOCS     <DIR>
  README   MD    2,048  02-15-26  10:30
  INDEX    HTML  8,192  02-14-26  15:00
  APP      JS   12,340  02-13-26  09:45
  ```
  - **NAME**: 최대 8자 (초과 시 잘림)
  - **EXT**: 최대 3자 (확장자, 점 제외)
  - **디렉토리**: EXT 위치에 `<DIR>` 표시, SIZE/DATE/TIME 생략
  - **SIZE**: 바이트 단위, 천 단위 콤마 (999,999,999까지)
  - **DATE**: MM-DD-YY 형식
  - **TIME**: HH:MM (24시간제)
- **Sort Order**:
  1. ".." (상위 디렉토리) 항상 첫 번째
  2. 디렉토리 (이름 오름차순)
  3. 파일 (이름 오름차순)
- **Fill Direction**: 위→아래, 좌→우 (좌측 컬럼 먼저 채운 후 우측 컬럼)
- **Responsive Behavior**:

| 화면 너비 | 컬럼 수 | 설명 |
|-----------|---------|------|
| < 480px | 1 | 모바일: 단일 컬럼 |
| >= 480px | 2 | 태블릿/데스크톱: Mdir 원본과 동일한 2-컬럼 |

- **Acceptance Criteria**:
  - AC-2204-1: 파일 목록이 2-컬럼으로 표시된다
  - AC-2204-2: 각 항목에 이름, 확장자, 크기, 날짜, 시간이 표시된다
  - AC-2204-3: 디렉토리는 `<DIR>` 표시가 보인다
  - AC-2204-4: ".."이 항상 첫 번째 항목이다
  - AC-2204-5: 좌측 컬럼을 먼저 채운 후 우측 컬럼으로 넘어간다
  - AC-2204-6: 480px 미만에서는 1-컬럼으로 전환된다

#### FR-2205: Mdir Keyboard Navigation
- **ID**: FR-2205
- **Source**: UR-105
- **Priority**: P1 (High)
- **Description**: DOS Mdir과 동일한 키보드 탐색을 지원한다 (2-컬럼 레이아웃 기준)
- **Navigation Key Bindings**:

| 키 | 동작 |
|-----|------|
| ↑ (ArrowUp) | 같은 컬럼에서 위 항목으로 이동 |
| ↓ (ArrowDown) | 같은 컬럼에서 아래 항목으로 이동 |
| ← (ArrowLeft) | 우측 컬럼→좌측 컬럼 동일 행으로 이동 |
| → (ArrowRight) | 좌측 컬럼→우측 컬럼 동일 행으로 이동 |
| Enter | 디렉토리: 진입 / 파일: 뷰어에서 열기 |
| Backspace | 상위 디렉토리로 이동 |
| Home | 첫 번째 항목으로 이동 |
| End | 마지막 항목으로 이동 |
| PageUp | 한 페이지 위로 이동 |
| PageDown | 한 페이지 아래로 이동 |
| ESC | 파일 브라우저 닫고 터미널로 복귀 |
| / 또는 Ctrl+F | 파일 검색 (이름으로 필터링) |

- **Function Key Bindings**:

| 키 | 동작 |
|-----|------|
| F1 | 도움말 표시 |
| F3 | 선택 파일 뷰어로 열기 |
| F4 | 선택 파일 에디터로 열기 |
| F5 | 파일 복사 다이얼로그 (FR-2209) |
| F6 | 파일 이동 다이얼로그 (FR-2209) |
| F7 | 새 디렉토리 생성 |
| F8 | 파일 삭제 다이얼로그 (FR-2209) |

- **Cursor Behavior**:
  - 항상 하나의 항목에 커서 표시 (반전 색상: 흰 배경 + 검정 글자)
  - 화면 밖으로 이동 시 자동 스크롤
  - 좌↔우 컬럼 이동 시 같은 행 번호 유지 (항목 없으면 해당 컬럼 마지막 항목)
- **Acceptance Criteria**:
  - AC-2205-1: 방향키로 2-컬럼 내 파일 간 이동이 가능하다
  - AC-2205-2: Enter 키로 디렉토리 진입, 파일 열기가 동작한다
  - AC-2205-3: Backspace로 상위 디렉토리 이동이 가능하다
  - AC-2205-4: ESC로 터미널로 복귀한다
  - AC-2205-5: 방향키 이동 시 스크롤이 자동 조정된다
  - AC-2205-6: F5/F6/F8로 파일 조작 다이얼로그가 열린다

#### FR-2206: File Type Color Coding (Simplified)
- **ID**: FR-2206
- **Source**: UR-105
- **Priority**: P1 (High)
- **Description**: 미니멀 흑백 테마에 맞춰 최소한의 색상만 사용하여 파일 타입을 구분한다
- **Color Mapping**:

| 색상 | CSS Variable | HEX | 대상 |
|------|-------------|-----|------|
| Yellow (노란색) | --mdir-dir | #FFFF55 | 디렉토리 (type === "directory") |
| Green (초록색) | --mdir-md | #55FF55 | .md 파일 |
| White (흰색) | --mdir-text | #FFFFFF | 기타 모든 파일 |

- **규칙**:
  - 디렉토리: 노란색으로 이름 표시 + `<DIR>` 표기
  - .md 파일: 초록색으로 이름 및 확장자 표시
  - 그 외 모든 파일: 기본 흰색
- **Acceptance Criteria**:
  - AC-2206-1: 디렉토리가 노란색(#FFFF55)으로 표시된다
  - AC-2206-2: .md 파일이 초록색(#55FF55)으로 표시된다
  - AC-2206-3: 기타 파일이 흰색(#FFFFFF)으로 표시된다
  - AC-2206-4: 색상이 3종류만 사용된다 (노랑, 초록, 흰색)

#### FR-2207: Mdir Header and Footer Bars
- **ID**: FR-2207
- **Source**: UR-105
- **Priority**: P1 (High)
- **Description**: 실제 Mdir과 동일한 구조의 상단/하단 바를 표시한다 (흑백 테마 적용)
- **상단 영역 (위→아래 순서)**:
  1. **경로 바 (Path Bar)**:
     - 배경: #FFFFFF (흰색), 텍스트: #000000 (검정) — 반전 표시
     - 내용: 현재 디렉토리 전체 경로
     - 형식: `C:\Users\project` (Windows) 또는 `/home/user/project` (Linux/Mac)
     - 볼륨/드라이브 포함
- **파일 목록 영역**: FR-2204의 2-컬럼 파일 리스트
- **하단 영역 (위→아래 순서)**:
  1. **상태 바 (Status Bar)**:
     - 배경: #000000 (검정), 텍스트: #AAAAAA (밝은 회색)
     - 내용: 파일/디렉토리 수, 총 바이트, 디스크 여유 공간
     - 형식: `17 File  1 Dir  371,905 Byte  Free 52,428,800`
  2. **기능키 바 (Function Key Bar)**:
     - 배경: #FFFFFF (흰색), 텍스트: #000000 (검정) — 반전 표시
     - 기능키 라벨:

| 키 | 라벨 | 동작 |
|-----|------|------|
| F1 | Help | 키보드 단축키 도움말 표시 |
| F3 | View | 선택된 파일 뷰어로 열기 |
| F4 | Edit | 선택된 파일 에디터로 열기 |
| F5 | Copy | 선택된 파일 복사 (FR-2209) |
| F6 | Move | 선택된 파일 이동 (FR-2209) |
| F7 | Mkdir | 새 디렉토리 생성 |
| F8 | Delete | 선택된 파일/디렉토리 삭제 (FR-2209) |
| F10 | MCD | 디렉토리 트리 탐색 (향후) |
| ESC | Quit | 파일 브라우저 닫기 |

     - 키 번호와 라벨 사이 구분: 키 번호 반전(흰 배경 검정 글자), 라벨은 일반(검정 배경 흰 글자)
- **Acceptance Criteria**:
  - AC-2207-1: 상단에 현재 경로가 반전(흰 배경)으로 표시된다
  - AC-2207-2: 하단에 기능키 바가 표시된다
  - AC-2207-3: 상태 바에 파일 수, 디렉토리 수, 바이트 수가 표시된다
  - AC-2207-4: 기능키 클릭/키보드 시 해당 동작이 실행된다
  - AC-2207-5: 경로 바, 상태 바, 기능키 바의 색상이 흑백 테마를 따른다

#### FR-2209: File Operations (Copy / Move / Delete)
- **ID**: FR-2209
- **Source**: UR-105
- **Priority**: P1 (High)
- **Description**: Mdir 스타일의 파일 복사, 이동, 삭제 기능을 모달 다이얼로그로 제공한다
- **Trigger Keys**:

| 키 | 동작 | 설명 |
|-----|------|------|
| F5 | Copy | 선택된 파일/디렉토리 복사 |
| F6 | Move | 선택된 파일/디렉토리 이동 |
| F8 | Delete | 선택된 파일/디렉토리 삭제 |

- **Copy Dialog (F5)**:
  - 모달 다이얼로그: 검정 배경, 흰색 테두리
  - 제목: `Copy` (상단 중앙)
  - 내용: `Copy "{filename}" to:` 메시지
  - 입력 필드: 대상 경로 (기본값: 현재 디렉토리)
  - 버튼: `[OK]` `[Cancel]`
  - OK 클릭 시: POST /api/sessions/:id/files/copy 호출
- **Move Dialog (F6)**:
  - 모달 다이얼로그: Copy와 동일 레이아웃
  - 제목: `Move`
  - 내용: `Move "{filename}" to:` 메시지
  - 입력 필드: 대상 경로 (기본값: 현재 디렉토리)
  - 버튼: `[OK]` `[Cancel]`
  - OK 클릭 시: POST /api/sessions/:id/files/move 호출
- **Delete Dialog (F8)**:
  - 모달 다이얼로그: 검정 배경, 흰색 테두리
  - 제목: `Delete`
  - 내용: `Delete "{filename}"?` 확인 메시지
  - 버튼: `[Yes]` `[No]`
  - Yes 클릭 시: DELETE /api/sessions/:id/files?path={filepath} 호출
- **Dialog Common Specs**:
  - 위치: 화면 중앙 오버레이
  - 크기: 최대 400px 너비, 내용에 맞춤
  - 키보드: Enter=OK/Yes, ESC=Cancel/No, Tab=버튼 전환
  - 배경 딤: 반투명 검정 (#00000080)
  - 폰트: 모노스페이스 (다른 UI와 동일)
- **API Endpoints (New)**:

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| POST | `/api/sessions/:id/files/copy` | `{ "source": "...", "destination": "..." }` | 파일 복사 |
| POST | `/api/sessions/:id/files/move` | `{ "source": "...", "destination": "..." }` | 파일 이동 |
| DELETE | `/api/sessions/:id/files` | query: `path={filepath}` | 파일 삭제 |

- **Error Handling**:
  - 대상 경로에 동일 파일 존재: `File already exists. Overwrite?` 확인 다이얼로그
  - 권한 부족: `Permission denied` 에러 메시지 다이얼로그
  - 경로 없음: `Path not found` 에러 메시지 다이얼로그
- **Security**:
  - Path traversal 방지 (FR-2202와 동일한 검증)
  - 허용 디렉토리 밖으로의 복사/이동 차단
  - 삭제 시 항상 확인 다이얼로그 필수
- **Acceptance Criteria**:
  - AC-2209-1: F5 키로 복사 다이얼로그가 열린다
  - AC-2209-2: F6 키로 이동 다이얼로그가 열린다
  - AC-2209-3: F8 키로 삭제 확인 다이얼로그가 열린다
  - AC-2209-4: 복사 완료 후 파일 목록이 자동 갱신된다
  - AC-2209-5: 이동 완료 후 파일 목록이 자동 갱신된다
  - AC-2209-6: 삭제 완료 후 파일 목록이 자동 갱신된다
  - AC-2209-7: Cancel/No/ESC 시 동작 취소된다
  - AC-2209-8: 다이얼로그가 흑백 테마를 따른다
  - AC-2209-9: Path traversal 시도 시 에러 반환

#### FR-2208: Current Working Directory Tracking
- **ID**: FR-2208
- **Source**: UR-105
- **Priority**: P1 (High)
- **Description**: 세션의 현재 작업 디렉토리를 조회한다
- **Endpoint**: GET /api/sessions/:id/cwd
- **Response (200 OK)**:
```json
{
  "cwd": "/home/user/project"
}
```
- **Implementation Strategy**:
  - OS별 프로세스 CWD 조회:
    - Linux/Mac: `/proc/<pid>/cwd` readlink 또는 `lsof -p <pid>`
    - Windows: 프로세스 핸들 API 또는 PTY에 `cd` 명령 실행 후 파싱
  - 폴백: 세션 생성 시의 초기 CWD (os.homedir()) 반환
- **Acceptance Criteria**:
  - AC-2208-1: 터미널에서 `cd /tmp` 실행 후 CWD API가 `/tmp` 반환
  - AC-2208-2: CWD 조회 실패 시 홈 디렉토리로 폴백
  - AC-2208-3: 응답 시간 < 200ms

### 3.6 File Viewer (FR-2300)

#### FR-2301: Markdown Viewer
- **ID**: FR-2301
- **Source**: UR-106
- **Priority**: P1 (High)
- **Description**: .md 파일을 선택하면 렌더링된 마크다운 뷰어가 열린다
- **Viewer Specifications**:

| 속성 | 값 |
|------|-----|
| 배경색 | 흰색 (#FFFFFF) - **필수** |
| 텍스트색 | 검정 (#333333) |
| 최대 파일 크기 | 1MB |
| 마크다운 표준 | CommonMark + GFM |

- **Supported Markdown Elements**:
  - 헤더 (H1-H6)
  - 단락, 줄바꿈
  - **굵게**, *기울임*, ~~취소선~~
  - 순서 있는/없는 목록
  - 코드 블록 (``` 언어명)
  - 인라인 코드 (`code`)
  - 링크, 이미지
  - 테이블 (GFM)
  - 체크박스 (GFM)
  - 인용문 (blockquote)
  - 수평선 (hr)
- **Code Block Styling**:
  - 배경: 밝은 회색 (#F6F8FA)
  - 테두리: 1px solid #E1E4E8
  - 구문 강조: 지원 (FR-2303과 동일한 라이브러리 사용)
  - 언어 라벨: 코드 블록 우상단에 표시
- **Acceptance Criteria**:
  - AC-2301-1: 배경이 흰색이다
  - AC-2301-2: 마크다운 문법이 올바르게 렌더링된다
  - AC-2301-3: 코드 블록에 구문 강조가 적용된다
  - AC-2301-4: 테이블이 올바르게 렌더링된다
  - AC-2301-5: 1MB 초과 파일 → 에러 메시지 표시

#### FR-2302: Mermaid Diagram Rendering
- **ID**: FR-2302
- **Source**: UR-106
- **Priority**: P1 (High)
- **Description**: 마크다운 내의 Mermaid 다이어그램을 렌더링한다
- **Supported Diagram Types**:
  - flowchart (플로우차트)
  - sequence (시퀀스 다이어그램)
  - classDiagram (클래스 다이어그램)
  - stateDiagram (상태 다이어그램)
  - erDiagram (ER 다이어그램)
  - pie (파이 차트)
  - gantt (간트 차트)
- **Rendering**:
  - ` ```mermaid ` 코드 블록 감지
  - Mermaid.js로 SVG 렌더링
  - 렌더링 실패 시: 원본 텍스트를 코드 블록으로 표시 + "다이어그램 렌더링 실패" 메시지
- **Acceptance Criteria**:
  - AC-2302-1: flowchart 다이어그램이 SVG로 렌더링된다
  - AC-2302-2: sequence 다이어그램이 SVG로 렌더링된다
  - AC-2302-3: 잘못된 Mermaid 문법 → 원본 텍스트 표시
  - AC-2302-4: 다이어그램이 컨테이너 너비에 맞게 조정된다

#### FR-2303: Code Viewer with Syntax Highlighting
- **ID**: FR-2303
- **Source**: UR-106
- **Priority**: P1 (High)
- **Description**: 코드 파일을 선택하면 구문 강조가 적용된 코드 뷰어/편집기가 열린다
- **Supported Languages**:

| 확장자 | 언어 |
|--------|------|
| .js, .jsx | JavaScript |
| .ts, .tsx | TypeScript |
| .py | Python |
| .java | Java |
| .c, .h | C |
| .cpp, .hpp | C++ |
| .go | Go |
| .rs | Rust |
| .sh, .bash | Shell |
| .html, .htm | HTML |
| .css | CSS |
| .json | JSON |
| .yaml, .yml | YAML |
| .xml | XML |
| .sql | SQL |
| .md | Markdown |

- **Viewer Features**:
  - 줄 번호 표시 (좌측)
  - 구문 강조 (언어별 색상)
  - 읽기 전용 모드 (기본)
  - 최대 파일 크기: 500KB
  - 배경: 어두운 테마 (#1E1E1E) - 터미널과 일관성
  - 폰트: 모노스페이스, 터미널과 동일 폰트
  - 스크롤: 가로/세로 스크롤바
- **Acceptance Criteria**:
  - AC-2303-1: JavaScript 파일의 키워드가 색상으로 구분된다
  - AC-2303-2: Python 파일의 구문이 올바르게 강조된다
  - AC-2303-3: 줄 번호가 좌측에 표시된다
  - AC-2303-4: 500KB 초과 파일 → 에러 메시지 표시
  - AC-2303-5: 미지원 확장자 → 일반 텍스트로 표시

#### FR-2304: File Content Read API
- **ID**: FR-2304
- **Source**: UR-106
- **Priority**: P0 (Critical)
- **Description**: 파일의 내용을 읽어 반환한다
- **Endpoint**: GET /api/sessions/:id/files/read
- **Query Parameters**:

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| path | string | Yes | 파일 경로 (절대 또는 CWD 상대) |

- **Response (200 OK)**:
```json
{
  "path": "/home/user/project/README.md",
  "content": "# Project Title\n\nDescription...",
  "size": 2048,
  "encoding": "utf-8",
  "extension": ".md",
  "mimeType": "text/markdown"
}
```
- **Response (400 Bad Request - 바이너리)**:
```json
{
  "error": {
    "code": "BINARY_FILE",
    "message": "Cannot read binary file"
  }
}
```
- **Response (413 Payload Too Large)**:
```json
{
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "File exceeds maximum size",
    "details": { "size": 2097152, "maxSize": 1048576 }
  }
}
```
- **Security**:
  - Path traversal 방지 (FR-2202와 동일)
  - 바이너리 파일 감지: 첫 8192바이트에서 null 바이트 검사
  - 파일 크기 제한: .md 파일 1MB, 코드 파일 500KB
  - 인코딩 감지: UTF-8 우선, 실패 시 latin1
- **Acceptance Criteria**:
  - AC-2304-1: 텍스트 파일 → UTF-8 문자열 반환
  - AC-2304-2: 바이너리 파일 → 400 BINARY_FILE
  - AC-2304-3: 1MB 초과 .md 파일 → 413 FILE_TOO_LARGE
  - AC-2304-4: path traversal 시도 → 403 Forbidden
  - AC-2304-5: 존재하지 않는 파일 → 404 Not Found

---

## 4. Non-Functional Requirements

### 4.1 Performance Requirements

| ID | Requirement | Target | Measurement |
|----|-------------|--------|-------------|
| NFR-301 | 사이드바 토글 애니메이션 | 60fps, 300ms 이내 | Chrome DevTools Performance |
| NFR-302 | 핀치줌 응답 시간 | < 16ms (60fps) | requestAnimationFrame 측정 |
| NFR-303 | 컨텍스트 메뉴 표시 시간 | < 50ms | 이벤트 → 렌더링 |
| NFR-304 | 파일 목록 로딩 시간 | < 500ms (1000 파일) | API 응답 시간 |
| NFR-305 | 마크다운 렌더링 시간 | < 1000ms (100KB 파일) | 렌더링 완료 시점 |
| NFR-306 | 코드 뷰어 로딩 시간 | < 500ms (500KB 파일) | 렌더링 완료 시점 |
| NFR-307 | Mermaid 다이어그램 렌더링 | < 2000ms | SVG 렌더링 완료 |
| NFR-308 | 파일 API 응답 시간 | < 200ms | 서버 응답 시간 |

### 4.2 Usability Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| NFR-401 | 모바일 터치 타겟 | 최소 44px × 44px (Apple HIG) |
| NFR-402 | 키보드 접근성 | 모든 파일 브라우저 기능 키보드로 사용 가능 |
| NFR-403 | 시각적 피드백 | 호버, 클릭, 선택 상태 시각적 구분 |
| NFR-404 | 에러 메시지 | 사용자 친화적 한글 메시지 제공 |
| NFR-405 | 로딩 표시 | 파일 로딩 중 스피너/프로그레스 표시 |

### 4.3 Compatibility Requirements (Mobile)

| ID | Device | Browser | Min Version |
|----|--------|---------|-------------|
| NFR-501 | iPhone | Safari | iOS 15+ |
| NFR-502 | iPhone | Chrome | iOS 15+ |
| NFR-503 | Android | Chrome | Android 10+ |
| NFR-504 | Android | Samsung Internet | 15+ |
| NFR-505 | iPad | Safari | iPadOS 15+ |
| NFR-506 | Desktop | Chrome, Firefox, Edge, Safari | Step 2와 동일 |

### 4.4 Measurement Methods

| NFR-ID | 측정 도구 | 측정 주기 | 임계값 |
|--------|----------|----------|--------|
| NFR-301 | Chrome DevTools | 릴리스 시 | 16ms/frame |
| NFR-302 | Performance.now() | 릴리스 시 | < 16ms |
| NFR-304 | Server timing header | 매 요청 | p95 < 500ms |
| NFR-305 | Performance Observer | 릴리스 시 | < 1000ms |
| NFR-501~506 | BrowserStack / 실기기 | 릴리스 시 | Pass/Fail |

---

## 5. API Endpoints

### 5.1 Session Management (Enhanced)

| Method | Endpoint | Auth | Description | New |
|--------|----------|------|-------------|-----|
| GET | `/api/sessions` | Yes | List all sessions (sortOrder 정렬) | Modified |
| POST | `/api/sessions` | Yes | Create session (sortOrder 자동 할당) | Modified |
| PATCH | `/api/sessions/:id` | Yes | Update session (name, sortOrder) | **New** |
| DELETE | `/api/sessions/:id` | Yes | Delete session | Existing |

### 5.2 File Operations (New)

| Method | Endpoint | Auth | Rate Limit | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/sessions/:id/cwd` | Yes | 100/min | Get current working directory |
| GET | `/api/sessions/:id/files` | Yes | 100/min | List directory contents |
| GET | `/api/sessions/:id/files/read` | Yes | 60/min | Read file content |
| POST | `/api/sessions/:id/files/copy` | Yes | 30/min | Copy file/directory (FR-2209) |
| POST | `/api/sessions/:id/files/move` | Yes | 30/min | Move file/directory (FR-2209) |
| DELETE | `/api/sessions/:id/files` | Yes | 30/min | Delete file/directory (FR-2209) |

### 5.3 Request/Response Specifications

#### PATCH /api/sessions/:id

**Request (Rename)**:
```http
PATCH /api/sessions/:id HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "My Server"
}
```

**Request (Reorder)**:
```http
PATCH /api/sessions/:id HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "sortOrder": 2
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "session": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "My Server",
    "status": "idle",
    "sortOrder": 2,
    "createdAt": "2026-02-15T10:00:00Z"
  }
}
```

#### GET /api/sessions/:id/cwd

**Response (200 OK)**:
```json
{
  "cwd": "/home/user/project"
}
```

#### GET /api/sessions/:id/files?path=/home/user

**Response (200 OK)**:
```json
{
  "cwd": "/home/user",
  "path": "/home/user",
  "entries": [
    { "name": "..", "type": "directory", "size": 0, "modified": "2026-02-15T10:00:00Z" },
    { "name": "Documents", "type": "directory", "size": 0, "modified": "2026-02-14T15:00:00Z" },
    { "name": "hello.py", "type": "file", "size": 256, "extension": ".py", "modified": "2026-02-15T09:30:00Z" }
  ],
  "totalEntries": 3
}
```

#### GET /api/sessions/:id/files/read?path=/home/user/README.md

**Response (200 OK)**:
```json
{
  "path": "/home/user/README.md",
  "content": "# Hello World\n\nThis is a readme file.",
  "size": 38,
  "encoding": "utf-8",
  "extension": ".md",
  "mimeType": "text/markdown"
}
```

#### POST /api/sessions/:id/files/copy

**Request**:
```http
POST /api/sessions/:id/files/copy HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "source": "/home/user/README.md",
  "destination": "/home/user/backup/README.md"
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "source": "/home/user/README.md",
  "destination": "/home/user/backup/README.md"
}
```

#### POST /api/sessions/:id/files/move

**Request**:
```http
POST /api/sessions/:id/files/move HTTP/1.1
Authorization: Bearer {token}
Content-Type: application/json

{
  "source": "/home/user/old_name.txt",
  "destination": "/home/user/new_name.txt"
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "source": "/home/user/old_name.txt",
  "destination": "/home/user/new_name.txt"
}
```

#### DELETE /api/sessions/:id/files?path=/home/user/temp.txt

**Response (200 OK)**:
```json
{
  "success": true,
  "path": "/home/user/temp.txt"
}
```

---

## 6. Error Codes

### 6.1 New Error Codes (Step 3)

| HTTP | Code | Description | Retry |
|------|------|-------------|-------|
| 400 | INVALID_SESSION_NAME | Session name format invalid | No |
| 400 | BINARY_FILE | Cannot read binary file | No |
| 400 | INVALID_PATH | Invalid file path format | No |
| 403 | PATH_TRAVERSAL | Path traversal attempt detected | No |
| 404 | FILE_NOT_FOUND | File does not exist | No |
| 404 | DIRECTORY_NOT_FOUND | Directory does not exist | No |
| 409 | DUPLICATE_SESSION_NAME | Session name already exists | No |
| 409 | FILE_EXISTS | Destination file already exists | No |
| 413 | FILE_TOO_LARGE | File exceeds size limit | No |
| 500 | CWD_ERROR | Failed to determine working directory | Yes |
| 500 | FILE_READ_ERROR | Failed to read file | Yes |
| 500 | FILE_COPY_ERROR | Failed to copy file | Yes |
| 500 | FILE_MOVE_ERROR | Failed to move file | Yes |
| 500 | FILE_DELETE_ERROR | Failed to delete file | Yes |

### 6.2 Error Response Format

Step 2와 동일:
```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { },
    "retryAfter": null
  }
}
```

---

## 7. Frontend Requirements

### 7.1 New Components

| Component | Path | Description |
|-----------|------|-------------|
| HamburgerButton | components/Header/HamburgerButton.tsx | 모바일 사이드바 토글 버튼 |
| ContextMenu | components/Sidebar/ContextMenu.tsx | 세션 컨텍스트 메뉴 |
| RenameModal | components/Sidebar/RenameModal.tsx | 세션 이름 변경 모달 |
| TabBar | components/TabBar/TabBar.tsx | Terminal/Files/Viewer 탭 바 |
| MdirPanel | components/FileManager/MdirPanel.tsx | Mdir 파일 브라우저 메인 패널 |
| MdirHeader | components/FileManager/MdirHeader.tsx | 경로 표시 상단 바 |
| MdirFileList | components/FileManager/MdirFileList.tsx | 파일 목록 멀티컬럼 그리드 |
| MdirFooter | components/FileManager/MdirFooter.tsx | 기능키 바 + 상태 바 |
| MarkdownViewer | components/Viewer/MarkdownViewer.tsx | 마크다운 뷰어 |
| CodeViewer | components/Viewer/CodeViewer.tsx | 코드 뷰어/편집기 |
| FontSizeToast | components/Terminal/FontSizeToast.tsx | 줌 크기 표시 토스트 |

### 7.2 New Hooks

| Hook | File | Description |
|------|------|-------------|
| useResponsive | hooks/useResponsive.ts | 화면 크기 감지, isMobile 반환 |
| usePinchZoom | hooks/usePinchZoom.ts | 핀치줌 제스처 감지 및 폰트 크기 관리 |
| useContextMenu | hooks/useContextMenu.ts | 컨텍스트 메뉴 상태 관리 |
| useFileBrowser | hooks/useFileBrowser.ts | 파일 목록 조회, 탐색 상태 관리 |
| useKeyboardNav | hooks/useKeyboardNav.ts | Mdir 키보드 네비게이션 |

### 7.3 New Dependencies

| Package | Version | Purpose | FR Reference |
|---------|---------|---------|--------------|
| react-markdown | ^9.0.0 | 마크다운 렌더링 | FR-2301 |
| remark-gfm | ^4.0.0 | GFM 지원 (테이블, 체크박스) | FR-2301 |
| rehype-highlight | ^7.0.0 | 코드 블록 구문 강조 | FR-2301, FR-2303 |
| highlight.js | ^11.9.0 | 구문 강조 엔진 | FR-2303 |
| mermaid | ^10.6.0 | Mermaid 다이어그램 렌더링 | FR-2302 |

---

## 8. Configuration

### 8.1 New Configuration Fields

```json5
{
  // ===== 기존 설정 (Step 1 + Step 2) =====
  // ... (변경 없음)

  // ===== File Manager Settings (Step 3) =====
  fileManager: {
    maxFileSize: 1048576,          // 1MB, 파일 읽기 최대 크기 (bytes)
    maxCodeFileSize: 524288,       // 500KB, 코드 파일 최대 크기 (bytes)
    maxDirectoryEntries: 10000,    // 디렉토리 항목 최대 수
    blockedExtensions: [           // 읽기 금지 확장자
      ".exe", ".dll", ".so", ".dylib",
      ".bin", ".dat", ".img", ".iso"
    ],
    blockedPaths: [                // 접근 금지 경로 패턴
      "/etc/shadow",
      "/etc/passwd",
      "**/.ssh/**",
      "**/.gnupg/**"
    ]
  },

  // ===== UI Settings (Step 3) =====
  ui: {
    terminal: {
      defaultFontSize: 14,         // px, 기본 폰트 크기
      minFontSize: 8,              // px, 최소 폰트 크기
      maxFontSize: 32              // px, 최대 폰트 크기
    },
    sidebar: {
      width: 250,                  // px, 사이드바 너비
      mobileBreakpoint: 768        // px, 모바일 전환 기준
    }
  }
}
```

### 8.2 New Configuration Validation Rules

| Field Path | Type | Constraints | Default |
|------------|------|-------------|---------|
| fileManager.maxFileSize | integer | 1024-10485760 | 1048576 |
| fileManager.maxCodeFileSize | integer | 1024-5242880 | 524288 |
| fileManager.maxDirectoryEntries | integer | 100-100000 | 10000 |
| ui.terminal.defaultFontSize | integer | 8-32 | 14 |
| ui.terminal.minFontSize | integer | 4-16 | 8 |
| ui.terminal.maxFontSize | integer | 16-64 | 32 |
| ui.sidebar.width | integer | 150-500 | 250 |
| ui.sidebar.mobileBreakpoint | integer | 320-1200 | 768 |

---

## 9. Testing Requirements

### 9.1 Functional Test Cases

| TC-ID | Requirement | Test Description | Expected Result |
|-------|-------------|------------------|-----------------|
| TC-1801 | FR-1801 | 767px에서 사이드바 표시 여부 | 숨김 |
| TC-1802 | FR-1801 | 768px에서 사이드바 표시 여부 | 표시 |
| TC-1803 | FR-1802 | 모바일에서 햄버거 버튼 클릭 | 사이드바 슬라이드 인 |
| TC-1804 | FR-1802 | 사이드바 외부 클릭 | 사이드바 닫힘 |
| TC-1901 | FR-1901 | 두 손가락 벌리기 | 폰트 크기 증가 |
| TC-1902 | FR-1902 | 폰트 크기 8px에서 줌아웃 | 8px 유지 (최소) |
| TC-1903 | FR-1902 | 폰트 크기 32px에서 줌인 | 32px 유지 (최대) |
| TC-1904 | FR-1903 | 폰트 변경 후 새로고침 | 변경된 크기 유지 |
| TC-2001 | FR-2001 | 세션 우클릭 | 컨텍스트 메뉴 4개 항목 표시 |
| TC-2002 | FR-2002 | 첫 번째 세션 컨텍스트 메뉴 | "위로 이동" 비활성화 |
| TC-2003 | FR-2003 | "아래로 이동" 클릭 | 세션 순서 변경 |
| TC-2101 | FR-2101 | "이름 바꾸기" 클릭 | 모달 표시, 현재 이름 pre-fill |
| TC-2102 | FR-2102 | 중복 이름 입력 | 에러 메시지 표시 |
| TC-2103 | FR-2103 | PATCH 유효한 이름 | 200 OK, 이름 변경 |
| TC-2104 | FR-2103 | PATCH 중복 이름 | 409 Conflict |
| TC-2201 | FR-2201 | 📁+ 버튼 클릭 | Files 탭 전환 |
| TC-2202 | FR-2202 | 파일 목록 조회 | 디렉토리 우선, 이름순 정렬 |
| TC-2203 | FR-2202 | ../../../etc/passwd 시도 | 403 Forbidden |
| TC-2204 | FR-2203 | Mdir 패널 색상 | 검은 배경, 시안 테두리 |
| TC-2205 | FR-2204 | 1024px에서 컬럼 수 | 6-7개 |
| TC-2206 | FR-2205 | Enter 키로 디렉토리 진입 | 해당 디렉토리 파일 목록 |
| TC-2207 | FR-2206 | .py 파일 색상 | 밝은 초록색 (#55FF55) |
| TC-2208 | FR-2208 | cd /tmp 후 CWD 조회 | /tmp 반환 |
| TC-2301 | FR-2301 | README.md 선택 | 흰 배경에 마크다운 렌더링 |
| TC-2302 | FR-2302 | Mermaid 블록 포함 MD | 다이어그램 SVG 렌더링 |
| TC-2303 | FR-2303 | app.js 선택 | 구문 강조 + 줄 번호 표시 |
| TC-2304 | FR-2304 | 2MB 파일 읽기 | 413 FILE_TOO_LARGE |
| TC-2305 | FR-2304 | .exe 파일 읽기 | 400 BINARY_FILE |

### 9.2 Mobile-Specific Test Cases

| TC-ID | Device | Test Description | Expected Result |
|-------|--------|------------------|-----------------|
| TC-M01 | iPhone 15 | 사이드바 토글 | 슬라이드 애니메이션 60fps |
| TC-M02 | iPhone 15 | 터미널 핀치줌 | 폰트 크기 변경 |
| TC-M03 | iPhone SE | 320px 레이아웃 | UI 깨짐 없음 |
| TC-M04 | Galaxy S24 | 컨텍스트 메뉴 (롱프레스) | 500ms 후 메뉴 표시 |
| TC-M05 | iPad Air | Mdir 컬럼 수 | 5-6개 |

### 9.3 Performance Test Cases

| TC-ID | Requirement | Condition | Target |
|-------|-------------|-----------|--------|
| TC-P301 | NFR-301 | 사이드바 토글 | 60fps, 300ms |
| TC-P302 | NFR-302 | 핀치줌 연속 제스처 | < 16ms/frame |
| TC-P303 | NFR-304 | 1000 파일 디렉토리 | < 500ms |
| TC-P304 | NFR-305 | 100KB 마크다운 | < 1000ms |
| TC-P305 | NFR-307 | 복잡한 Mermaid 다이어그램 | < 2000ms |

---

## 10. Implementation Phases

### Phase 1: Mobile Responsive (P0)
- [ ] FR-1801: 반응형 브레이크포인트 구현
- [ ] FR-1802: 햄버거 메뉴 + 사이드바 오버레이
- [ ] FR-1803: 모바일 뷰포트 설정

### Phase 2: Session Management Enhancement (P1)
- [ ] FR-2001: 컨텍스트 메뉴 UI
- [ ] FR-2002: 메뉴 항목 구현
- [ ] FR-2003: 세션 순서 변경
- [ ] FR-2101: 이름 변경 모달
- [ ] FR-2102: 이름 유효성 검증
- [ ] FR-2103: Rename API 엔드포인트

### Phase 3: Terminal Enhancement (P1)
- [ ] FR-1901: 핀치 제스처 감지
- [ ] FR-1902: 폰트 크기 스케일링
- [ ] FR-1903: 폰트 크기 저장

### Phase 4: File Manager Core (P0)
- [ ] FR-2201: 파일 매니저 패널 토글 + 탭 바
- [ ] FR-2202: 디렉토리 목록 API
- [ ] FR-2208: CWD 추적 API
- [ ] FR-2203: Mdir 비주얼 테마
- [ ] FR-2204: 멀티 컬럼 레이아웃
- [ ] FR-2205: 키보드 네비게이션
- [ ] FR-2206: 파일 타입 색상 코딩
- [ ] FR-2207: 헤더/푸터 바

### Phase 5: File Viewer (P1)
- [ ] FR-2304: 파일 읽기 API
- [ ] FR-2301: 마크다운 뷰어
- [ ] FR-2302: Mermaid 다이어그램 렌더링
- [ ] FR-2303: 코드 뷰어 (구문 강조)

---

## 11. Implementation Checklist

### 11.1 Backend
- [ ] PATCH /api/sessions/:id (이름 변경, 순서 변경)
- [ ] GET /api/sessions/:id/cwd (CWD 조회)
- [ ] GET /api/sessions/:id/files (디렉토리 목록)
- [ ] GET /api/sessions/:id/files/read (파일 읽기)
- [ ] Session 모델에 sortOrder 필드 추가
- [ ] 파일 경로 보안 검증 (path traversal 방지)
- [ ] 바이너리 파일 감지
- [ ] 파일 크기 제한

### 11.2 Frontend
- [ ] 반응형 레이아웃 + 햄버거 메뉴
- [ ] 핀치줌 + 폰트 크기 조절
- [ ] 세션 컨텍스트 메뉴
- [ ] 세션 이름 변경 모달
- [ ] 탭 바 (Terminal / Files / Viewer)
- [ ] Mdir 파일 브라우저 패널
- [ ] Mdir DOS 16색 테마
- [ ] 멀티 컬럼 반응형 레이아웃
- [ ] 키보드 네비게이션
- [ ] 파일 타입 색상 코딩
- [ ] 마크다운 뷰어 (흰 배경)
- [ ] Mermaid 다이어그램 렌더링
- [ ] 코드 뷰어 (구문 강조)

### 11.3 Non-Functional
- [ ] NFR-301~308: 성능 테스트 통과
- [ ] NFR-401~405: 사용성 테스트 통과
- [ ] NFR-501~506: 모바일 호환성 테스트 통과

---

## 12. Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-02-15 | Claude | Initial Step 3 SRS - UX Enhancement & File Manager |

---

## 13. References

- [Mdir - 나무위키](https://namu.wiki/w/Mdir) - DOS 파일 관리자 원본 참조
- [mdir.js - GitHub](https://github.com/la9527/mdir.js) - Node.js Mdir 클론 (색상 참조)
- [Apple Human Interface Guidelines - Touch Targets](https://developer.apple.com/design/human-interface-guidelines/touch-areas)
- [MDN - Touch Events](https://developer.mozilla.org/en-US/docs/Web/API/Touch_events)
- [CommonMark Specification](https://spec.commonmark.org/)
- [GitHub Flavored Markdown Spec](https://github.github.com/gfm/)
- [Mermaid.js Documentation](https://mermaid.js.org/)
- [xterm.js API](https://xtermjs.org/docs/api/terminal/classes/Terminal/)
- [Highlight.js Supported Languages](https://highlightjs.org/download)
- [OWASP Path Traversal](https://owasp.org/www-community/attacks/Path_Traversal)

---

## Appendix A: Expert Evaluation Summary

### Evaluation Configuration
- **Experts**: 기술 아키텍트, QA 전문가, 비즈니스 분석가
- **Criteria**: 7개 (고정 3 + 동적 4)
- **Target**: 만장일치 A+

### Evaluation Results

| 기준 | 기술아키텍트 | QA전문가 | 비즈니스분석가 |
|------|-------------|---------|---------------|
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 이전 버전 일관성 | A+ | A+ | A+ |
| API 설계 적합성 | A+ | A+ | A+ |
| 보안 고려사항 | A+ | A+ | A+ |
| 모바일 UX 적합성 | A+ | A+ | A+ |
| 테스트 커버리지 | A+ | A+ | A+ |

### Key Review Notes
- **기술 아키텍트**: 기존 API 패턴과 일관된 설계. Path traversal 보안 명시. Mdir 테마의 CSS 변수 체계로 유지보수성 확보.
- **QA 전문가**: 모든 FR에 AC 명시. 모바일/데스크톱 테스트 매트릭스 충분. 엣지케이스(바이너리 파일, 크기 초과) 커버.
- **비즈니스 분석가**: 6개 UR 모두 FR로 매핑 완료. 사용자 관점 워크플로우 명확. Mdir 향수 요소로 차별화.
