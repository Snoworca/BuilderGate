# Phase 6 검증: 회귀 검증 + E2E

**Phase**: Phase 6 - 회귀 검증 + E2E
**SRS References**: 섹션 8 (테스트 요구사항), 섹션 6 (비기능 요구사항), TC-6701~TC-6712, TC-NFR-01~TC-NFR-05
**Plan Reference**: `plan/step6/06.phase-6-regression-e2e.md`
**검증일**: ____-__-__
**검증자**: __________

---

## 1. Completion Checklist

### 1.1 Playwright 설정
- [ ] `@playwright/test` devDependency 설치
- [ ] Playwright 설정 파일 생성 (`playwright.config.ts`)
- [ ] 테스트 실행 스크립트 추가 (`package.json`)
- [ ] 헤드리스 Chromium 환경 구성
- [ ] 모바일 에뮬레이션 설정 (360px, 768px 뷰포트)

### 1.2 E2E 테스트 스위트
- [ ] `tests/e2e/pane-split.spec.ts` — 분할/닫기/리사이즈 E2E 테스트
- [ ] `tests/e2e/pane-carousel.spec.ts` — 모바일 캐러셀 E2E 테스트
- [ ] `tests/e2e/pane-keyboard.spec.ts` — Ctrl+B prefix 모드 E2E 테스트
- [ ] `tests/e2e/pane-context-menu.spec.ts` — 컨텍스트 메뉴 E2E 테스트
- [ ] `tests/e2e/pane-persistence.spec.ts` — IndexedDB 저장/복원 E2E 테스트
- [ ] `tests/e2e/pane-preset.spec.ts` — 프리셋 레이아웃 E2E 테스트

### 1.3 엣지케이스 테스트 전체 통과
- [ ] TC-6701~TC-6712 엣지케이스 테스트 모두 통과
- [ ] 네트워크 오류, 부분 실패, 데이터 손상 시나리오 검증

### 1.4 회귀 테스트 스위트
- [ ] 기존 탭 기능 회귀 테스트 통과 (파일 탭, 뷰어 탭)
- [ ] 기존 세션 관리 회귀 테스트 통과 (생성/삭제/이름변경/재정렬)
- [ ] 기존 모바일 레이아웃 회귀 테스트 통과 (사이드바, 탭바)
- [ ] 기존 인증 기능 회귀 테스트 통과

### 1.5 성능 벤치마크
- [ ] NFR-6101: 8 Pane 동시 표시 60fps 확인
- [ ] NFR-6102: 리사이즈 16ms 이내 레이아웃 업데이트
- [ ] NFR-6103: IndexedDB 저장 50ms 이내
- [ ] NFR-6104: 앱 로드 시 복원 100ms 이내
- [ ] NFR-6105: 스와이프 애니메이션 300ms, 제스처 인식 50ms 이내
- [ ] NFR-6106: 8 Pane 운용 시 500MB 이내
- [ ] NFR-6111: 8 Pane 동시 활발한 출력 시 UI 응답 지연 200ms 이내

### 1.6 빌드 및 최종 검증
- [ ] `npm run build` 성공 (프론트엔드)
- [ ] 서버 빌드 성공 (서버 코드 변경 없음 확인)
- [ ] 전체 E2E 테스트 스위트 CI 통과

---

## 2. Test Results

### 2.1 엣지케이스 테스트 (TC-6701~TC-6712)

| Test ID | 설명 | Status | Notes |
|---------|------|--------|-------|
| TC-6701 | 네트워크 오프라인에서 Pane 분할 시도 → 에러 메시지 표시, 레이아웃 변경 없음 | | |
| TC-6702 | "다른 Pane 모두 닫기" 중 일부 세션 삭제 API 실패 → 실패한 Pane 유지, 성공한 Pane만 제거, 실패 건수 표시 | | |
| TC-6703 | 줌 상태에서 줌 대상 외 Pane의 서버측 세션 종료 → 줌 해제 시 해당 Pane 트리에서 자동 제거 | | |
| TC-6704 | `zoomedPaneId` 설정 상태에서 앱 새로고침 → 줌 상태 복원 | | |
| TC-6705 | 모바일 캐러셀에서 현재 Pane 닫기 → 이전 Pane으로 자동 스와이프, 인디케이터 감소 | | |
| TC-6706 | Pane 교환 모드 중 우클릭 메뉴 열기 → 교환 모드 유지, 다른 동작 선택 시 교환 취소 | | |
| TC-6707 | Prefix 모드에서 인식 불가 키 입력 → Prefix 해제, "Unknown key" 메시지 1초 표시 | | |
| TC-6708 | localStorage에 손상된 JSON 데이터 상태에서 마이그레이션 → 파싱 실패, 기본 단일 Pane 초기화 | | |
| TC-6709 | 정확히 깊이 4인 트리에서 추가 분할 시도 → 분할 메뉴 비활성화 | | |
| TC-6710 | 앱 로드 시 IndexedDB의 sessionId가 서버에 없음 → 해당 Pane 자동 제거, 레이아웃 재구성 | | |
| TC-6711 | Pane 닫기 후 SSE EventSource 종료 확인 → DevTools Network에서 연결 종료 확인 | | |
| TC-6712 | 데스크톱 4분할 → 모바일 전환 → 다시 데스크톱 → 4분할 레이아웃 일관성 유지 | | |

### 2.2 비기능 요구사항 검증 (TC-NFR-01~TC-NFR-05)

| Test ID | 설명 | Status | Notes |
|---------|------|--------|-------|
| TC-NFR-01 | NFR-6101: 8 Pane 동시 표시 → Chrome DevTools Performance에서 60fps 확인 | | |
| TC-NFR-02 | NFR-6106: 8 Pane 운용 시 메모리 → Chrome Task Manager에서 500MB 이하 | | |
| TC-NFR-03 | NFR-6107: 360px 너비 뷰포트 → 캐러셀 정상 동작, 도트 인디케이터 8개 표시 가능 | | |
| TC-NFR-04 | NFR-6108: 키보드만으로 Pane 조작 → Tab 키 + Ctrl+B prefix로 모든 조작 가능 | | |
| TC-NFR-05 | NFR-6111: 8 Pane 동시 활발한 출력 → UI 응답 지연 200ms 이내 | | |

---

## 3. Quality Evaluation

| 기준 | 등급 | 비고 |
|------|------|------|
| **Plan-Code 정합성** — 전체 Phase 1~6 계획서 대비 구현 일치도 | | |
| **SOLID 원칙** — 전체 시스템 아키텍처 품질 | | |
| **Test Coverage** — E2E + 단위 + 통합 테스트 종합 커버리지 | | |
| **Readability** — 전체 코드베이스 가독성, 일관성 | | |
| **Error Handling** — 엣지케이스, 네트워크 오류, 데이터 손상 처리 | | |
| **Documentation** — 전체 코드 문서화 품질 | | |
| **Performance** — NFR 전 항목 충족 여부 | | |

---

## 4. Issues Found

| # | 심각도 | 설명 | 해결 상태 | 해결 방법 |
|---|--------|------|-----------|-----------|
| | | | | |
| | | | | |
| | | | | |

---

## 5. Regression Results

### 5.1 기존 기능 회귀
- [ ] 세션 생성/삭제 정상 동작
- [ ] 세션 이름 변경 정상 동작
- [ ] 탭 추가/삭제/재정렬 정상 동작
- [ ] 파일 탭 (파일 매니저) 정상 동작
- [ ] 뷰어 탭 (마크다운/코드 뷰어) 정상 동작
- [ ] SSE 스트림 정상 동작
- [ ] xterm.js 터미널 입력/출력 정상 동작
- [ ] xterm.js FitAddon 자동 맞춤 정상 동작

### 5.2 인증/보안 회귀
- [ ] JWT 인증 정상 동작
- [ ] 2FA 인증 정상 동작 (설정된 경우)
- [ ] 세션 만료 처리 정상 동작

### 5.3 모바일 회귀
- [ ] 모바일 사이드바 정상 동작
- [ ] 모바일 TabBar 정상 동작
- [ ] 모바일 AddTabModal 정상 동작
- [ ] 모바일 드래그 재정렬 정상 동작

### 5.4 설정 회귀
- [ ] Settings 페이지 정상 동작
- [ ] RuntimeConfigStore 정상 동작
- [ ] workspace ↔ settings 화면 전환 시 Pane 상태 유지

### 5.5 빌드 회귀
- [ ] 프론트엔드 `npm run build` 성공
- [ ] 서버 빌드 성공
- [ ] 타입 오류 없음

---

## 6. Approval Checklist

- [ ] 모든 Completion Checklist 항목 완료
- [ ] 엣지케이스 테스트 TC-6701~TC-6712 전체 PASS
- [ ] NFR 테스트 TC-NFR-01~TC-NFR-05 전체 PASS
- [ ] E2E 테스트 스위트 전체 PASS
- [ ] Quality Evaluation 전 항목 B 이상
- [ ] Critical/High 이슈 없음 (또는 모두 해결)
- [ ] 회귀 테스트 전 항목 통과
- [ ] Step 6 최종 완료 조건 충족

**승인 여부**: ☐ 승인 / ☐ 조건부 승인 / ☐ 반려
**승인자**: __________
**승인일**: ____-__-__
