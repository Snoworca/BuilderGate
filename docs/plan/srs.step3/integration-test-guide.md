# Integration Test Guide - Step 3

**Version**: 1.0.0
**Date**: 2026-02-15
**실행 조건**: 모든 Phase (1-5) 완료 후

---

## 1. 핵심 E2E 시나리오

### E2E-001: 모바일 풀 워크플로우 (CRITICAL)

```
Given: 모바일 기기 (iPhone 15, 390px)에서 앱 접속
When:
  1. 로그인 (인증 통과)
  2. 햄버거 버튼 클릭 → 사이드바 슬라이드 인
  3. "새 세션" 생성
  4. 세션 선택 → 사이드바 자동 닫힘
  5. 터미널에서 `ls` 실행
  6. 핀치줌으로 폰트 크기 24px로 변경
  7. 📁+ 버튼 → Files 탭
  8. 파일 목록 1-컬럼 표시 확인
  9. README.md 선택 → Viewer 탭
  10. 마크다운 렌더링 확인 (흰 배경)
  11. Terminal 탭으로 복귀
Then:
  - 모든 단계가 터치/탭으로 완료 가능
  - UI 깨짐 없음
  - 애니메이션 부드러움 (60fps)
```

### E2E-002: 데스크톱 파일 관리 풀 워크플로우 (CRITICAL)

```
Given: 데스크톱 브라우저 (1440px)에서 앱 접속, 인증 완료
When:
  1. 세션 생성 후 터미널에서 `cd /tmp && mkdir test_dir` 실행
  2. 📁+ 버튼 → Files 탭
  3. Mdir 화면: 검은 배경, 흰 테두리, 2-컬럼 확인
  4. 경로 바에 /tmp 표시 확인 (흰 배경 반전)
  5. 방향키로 test_dir 이동 (노란색 확인)
  6. Enter → test_dir 진입
  7. Backspace → /tmp로 복귀
  8. F7 (Mkdir) → 디렉토리 이름 입력 → OK → 생성 완료
  9. 파일 선택 → F5 (Copy 다이얼로그)
  10. 대상 경로 입력 → OK → 복사 완료
  11. F8 (Delete) → 확인 → 삭제 완료
  12. 상태 바에 파일/디렉토리 수 갱신 확인
  13. ESC → Terminal 탭 복귀
Then:
  - 키보드만으로 모든 파일 조작 가능
  - 파일 목록 자동 갱신
  - Mdir 테마 일관성 유지
```

### E2E-003: 세션 관리 워크플로우 (HIGH)

```
Given: 3개 세션 (A, B, C) 존재
When:
  1. 세션 B 우클릭 → 컨텍스트 메뉴
  2. "이름 바꾸기" → 모달 → "My Server" 입력 → Enter
  3. 사이드바에서 "My Server" 확인
  4. 세션 C 우클릭 → "위로 이동"
  5. 순서: A → C → B 확인
  6. 세션 A 우클릭 → "위로 이동" 비활성화 확인
  7. 페이지 새로고침 → 이름/순서 유지 확인
Then:
  - 이름 변경 즉시 반영
  - 순서 변경 즉시 반영
  - 서버 재시작 전까지 유지
```

### E2E-004: 파일 뷰어 렌더링 (HIGH)

```
Given: 프로젝트 디렉토리에 다양한 파일 존재
When:
  1. Files 탭에서 README.md 선택 (초록색 확인)
  2. Viewer → 흰 배경 마크다운 렌더링 확인
  3. Mermaid 다이어그램 → SVG 렌더링 확인
  4. 코드 블록 → 구문 강조 확인
  5. Files 탭 복귀 → app.js 선택
  6. Viewer → 어두운 배경 (#1E1E1E), 줄 번호, 구문 강조
  7. 500KB 초과 파일 선택 → 에러 메시지
  8. .exe 파일 선택 → "바이너리 파일" 에러
Then:
  - .md → MarkdownViewer (흰 배경)
  - 코드 파일 → CodeViewer (어두운 배경)
  - 에러 → 사용자 친화적 메시지
```

---

## 2. 보안 통합 테스트

### SEC-001: Path Traversal 전면 차단

```
Given: 인증된 사용자
When:
  1. GET /files?path=../../../etc/passwd
  2. GET /files?path=/etc/shadow
  3. GET /files/read?path=../../.ssh/id_rsa
  4. POST /files/copy { source: "../../../etc/passwd", destination: "./stolen" }
  5. POST /files/move { source: "../secret", destination: "./here" }
  6. DELETE /files?path=../../../important
Then:
  - 모든 요청 → 403 PATH_TRAVERSAL
  - 서버 로그에 경고 기록
```

### SEC-002: 인증 없는 파일 API 접근

```
Given: 인증되지 않은 요청 (JWT 토큰 없음)
When:
  1. GET /api/sessions/:id/cwd (토큰 없음)
  2. GET /api/sessions/:id/files (토큰 없음)
  3. POST /api/sessions/:id/files/copy (토큰 없음)
Then:
  - 모든 요청 → 401 Unauthorized
```

---

## 3. 성능 통합 테스트

| TC-ID | 시나리오 | 측정 방법 | Target | 결과 |
|-------|----------|----------|--------|------|
| PERF-001 | 사이드바 토글 애니메이션 | Chrome DevTools | 60fps, 300ms | [ ] |
| PERF-002 | 핀치줌 연속 10회 | Performance.now() | < 16ms/frame | [ ] |
| PERF-003 | 1000 파일 디렉토리 로딩 | API timing | < 500ms | [ ] |
| PERF-004 | 100KB 마크다운 렌더링 | Performance Observer | < 1000ms | [ ] |
| PERF-005 | 500KB 코드 파일 로딩 | Performance Observer | < 500ms | [ ] |
| PERF-006 | 복잡한 Mermaid 다이어그램 | Performance Observer | < 2000ms | [ ] |
| PERF-007 | 컨텍스트 메뉴 표시 | Event timing | < 50ms | [ ] |
| PERF-008 | 파일 API 응답 | Server timing | < 200ms | [ ] |

---

## 4. 모바일 호환성 테스트 매트릭스

| Device | Browser | 반응형 | 핀치줌 | 롱프레스 | 파일브라우저 | 결과 |
|--------|---------|--------|--------|---------|-------------|------|
| iPhone 15 | Safari | [ ] | [ ] | [ ] | [ ] | |
| iPhone SE | Safari | [ ] | [ ] | [ ] | [ ] | |
| iPhone 15 | Chrome | [ ] | [ ] | [ ] | [ ] | |
| Galaxy S24 | Chrome | [ ] | [ ] | [ ] | [ ] | |
| Galaxy S24 | Samsung | [ ] | [ ] | [ ] | [ ] | |
| iPad Air | Safari | [ ] | [ ] | [ ] | [ ] | |
| Desktop | Chrome | [ ] | N/A | N/A | [ ] | |
| Desktop | Firefox | [ ] | N/A | N/A | [ ] | |
| Desktop | Edge | [ ] | N/A | N/A | [ ] | |

---

## 5. Component Integration Matrix

```
                    ┌──────────┐
                    │ AuthGuard│
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
        ┌─────▼──┐  ┌───▼────┐  ┌─▼────────┐
        │ Header │  │Sidebar │  │MainContent│
        │(Phase1)│  │(Ph1+2) │  │ (Ph1-5)  │
        └────────┘  └────────┘  └─────┬─────┘
                                      │
                         ┌────────────┼────────────┐
                         │            │            │
                   ┌─────▼────┐ ┌────▼─────┐ ┌───▼──────┐
                   │ Terminal  │ │ MdirPanel│ │ Viewer   │
                   │ (Ph1+3)  │ │ (Phase4) │ │ (Phase5) │
                   └──────────┘ └──────────┘ └──────────┘
```

**통합 포인트별 테스트**:

| # | 통합 포인트 | 테스트 내용 | 결과 |
|---|------------|------------|------|
| 1 | Header ↔ Sidebar | 햄버거 버튼으로 사이드바 토글 | [ ] |
| 2 | Sidebar ↔ MainContent | 세션 선택 → 터미널/파일 브라우저 연결 | [ ] |
| 3 | TabBar ↔ MainContent | 탭 전환 → 올바른 패널 표시 | [ ] |
| 4 | MdirPanel ↔ Viewer | 파일 선택 → Viewer 탭 자동 활성화 | [ ] |
| 5 | Terminal ↔ MdirPanel | CWD 동기화 (터미널에서 cd → 파일 브라우저 경로) | [ ] |
| 6 | ContextMenu ↔ RenameModal | 이름 바꾸기 메뉴 → 모달 열기 | [ ] |
| 7 | FileOp Dialog ↔ useFileBrowser | 파일 조작 후 목록 갱신 | [ ] |

---

## 6. Requirements Traceability

| UR-ID | FR-IDs | Phase | E2E TC | 통합 결과 |
|-------|--------|-------|--------|----------|
| UR-101 | FR-1801, FR-1802, FR-1803 | Phase 1 | E2E-001 | [ ] |
| UR-102 | FR-1901, FR-1902, FR-1903 | Phase 3 | E2E-001 | [ ] |
| UR-103 | FR-2001, FR-2002, FR-2003 | Phase 2 | E2E-003 | [ ] |
| UR-104 | FR-2101, FR-2102, FR-2103 | Phase 2 | E2E-003 | [ ] |
| UR-105 | FR-2201~FR-2209 | Phase 4 | E2E-002 | [ ] |
| UR-106 | FR-2301~FR-2304 | Phase 5 | E2E-004 | [ ] |

**100% 요구사항 추적 달성 여부**: [ ] Yes / [ ] No
