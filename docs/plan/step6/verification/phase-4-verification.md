# Phase 4 검증: 모바일 캐러셀

**Phase**: Phase 4 - 모바일 캐러셀
**SRS References**: FR-6301~FR-6307, 섹션 5.3 (모바일 캐러셀 내비게이션), 섹션 7.2 (모바일 레이아웃), NFR-6105/6107
**Plan Reference**: `plan/step6/04.phase-4-mobile-carousel.md`
**검증일**: ____-__-__
**검증자**: __________

---

## 1. Completion Checklist

### 1.1 PaneCarousel.tsx 스와이프 엔진 (FR-6302)
- [ ] `PaneCarousel.tsx` 생성 완료
- [ ] `flattenPaneTree()`로 PaneLayout을 선형 배열로 변환
- [ ] 좌우 스와이프로 Pane 전환 (X축 delta > 50px, Y축 delta < X축 delta)
- [ ] 스와이프 애니메이션: `transform: translateX()`, `transition: 300ms ease-out`
- [ ] 현재 Pane 양 옆에 이전/다음 Pane 미리 렌더링 (부드러운 전환)
- [ ] `touch-action: pan-y` 설정 (세로 스크롤 충돌 방지)
- [ ] 투명 터치 레이어 배치 (xterm.js 터치 이벤트 분리)
- [ ] 50ms 방향 판정: X축 → 스와이프 처리, Y축 → xterm 스크롤 위임
- [ ] 첫 번째 Pane에서 왼쪽 스와이프 시 바운스 효과
- [ ] 마지막 Pane에서 오른쪽 스와이프 시 바운스 효과
- [ ] 스와이프 완료 시 `setFocusedPane` 호출

### 1.2 PaneIndicator.tsx 도트 인디케이터 (FR-6303)
- [ ] `PaneIndicator.tsx` 생성 완료
- [ ] 캐러셀 상단에 도트 인디케이터 표시
- [ ] 현재 Pane: 채워진 원 (`●`), 다른 Pane: 빈 원 (`○`)
- [ ] 도트 탭으로 해당 Pane 직접 이동
- [ ] 캐러셀 하단에 위치 텍스트: `[1/3] Terminal A`
- [ ] Pane 수 변경 시 도트 수 즉시 업데이트

### 1.3 모바일 롱프레스 메뉴 (FR-6205)
- [ ] Pane 영역 롱프레스(500ms)로 컨텍스트 메뉴 표시
- [ ] 바텀시트(bottom sheet) 스타일 메뉴 (기존 AddTabModal 패턴 활용)
- [ ] FR-6201 메뉴 항목 전체 포함
- [ ] 서브메뉴: 바텀시트 내 슬라이드 전환 (뒤로가기 버튼 포함)
- [ ] 50ms 방향 판정과 500ms 롱프레스 충돌 없음

### 1.4 모바일 Pane 추가/닫기 (FR-6304, FR-6306)
- [ ] 모바일 Pane 추가: 캐러셀 오른쪽 끝에 새 Pane 추가
- [ ] 추가 후 자동으로 새 Pane으로 스와이프 전환
- [ ] 트리 구조: 루트 노드에서 수직 분할 (트리 균형 유지)
- [ ] 모바일 Pane 닫기: 현재 표시 중이면 이전 Pane으로 자동 스와이프
- [ ] 이전 Pane 없으면 다음 Pane으로 이동
- [ ] 도트 인디케이터 즉시 1개 감소
- [ ] 위치 텍스트 즉시 업데이트
- [ ] 마지막 Pane에서 "Pane 닫기" 비활성화

### 1.5 터치 레이어링 (ADR-608)
- [ ] 투명 터치 레이어 (absolute, z-index 위) 배치
- [ ] touchstart: 좌표 기록, 50ms 타이머 시작
- [ ] touchmove: X축 > Y축 → 스와이프 모드, Y축 > X축 → xterm 위임
- [ ] touchend: 스와이프 완료 또는 클린업
- [ ] xterm.js 터치 기반 텍스트 선택(500ms 롱프레스) 정상 동작

### 1.6 반응형 분기 (FR-6301, FR-6305)
- [ ] `PaneRenderer.tsx`에 반응형 분기 구현
- [ ] 768px 이하: PaneCarousel 렌더링
- [ ] 769px 이상: SplitPane 렌더링
- [ ] 브라우저 크기 변경 시 자동 모드 전환
- [ ] 모바일-데스크톱 전환 시 PaneLayout 데이터 일관성 유지

### 1.7 모바일 키보드 단축키 대체 수단 (FR-6307)
- [ ] 모든 Pane 조작이 롱프레스 메뉴로 접근 가능
- [ ] 분할(수평/수직), 닫기, 줌, 교환 → 롱프레스 메뉴
- [ ] 포커스 이동 → 스와이프 좌/우
- [ ] 번호 표시 → 도트 인디케이터로 대체

### 1.8 빌드 및 통합
- [ ] `npm run build` 성공
- [ ] 태블릿(769px~1024px) 경계선 터치 타겟 20px 확장

---

## 2. Test Results

| Test ID | 설명 | Status | Notes |
|---------|------|--------|-------|
| TC-6301 | 768px 이하 → 캐러셀 모드 전환 | | |
| TC-6302 | 좌우 스와이프 → Pane 전환 애니메이션 | | |
| TC-6303 | 도트 인디케이터 탭 → 해당 Pane으로 이동 | | |
| TC-6304 | 모바일 Pane 추가 → 오른쪽에 추가, 자동 스와이프 | | |
| TC-6305 | 모바일→데스크톱 전환 → 레이아웃 일관성 | | |
| TC-6705 | 모바일 캐러셀에서 현재 Pane 닫기 → 이전 Pane으로 자동 스와이프, 인디케이터 감소 | | |
| TC-6712 | 데스크톱에서 4분할 후 모바일로 전환 후 다시 데스크톱 → 4분할 레이아웃 일관성 유지 | | |

---

## 3. Quality Evaluation

| 기준 | 등급 | 비고 |
|------|------|------|
| **Plan-Code 정합성** — 계획서 대비 구현 일치도 | | |
| **SOLID 원칙** — 단일책임, 개방폐쇄, 의존성 역전 등 | | |
| **Test Coverage** — 단위/통합 테스트 커버리지 | | |
| **Readability** — 코드 가독성, 네이밍, 주석 | | |
| **Error Handling** — 터치 이벤트 에러, 캐러셀 인덱스 범위 초과 | | |
| **Documentation** — 인라인 문서, JSDoc, 타입 주석 | | |
| **Performance** — 스와이프 300ms 애니메이션, 제스처 인식 50ms, 360px 정상 동작 | | |

---

## 4. Issues Found

| # | 심각도 | 설명 | 해결 상태 | 해결 방법 |
|---|--------|------|-----------|-----------|
| | | | | |
| | | | | |
| | | | | |

---

## 5. Regression Results

- [ ] 데스크톱 Pane 분할/닫기/리사이즈 정상 동작 (Phase 2)
- [ ] 데스크톱 컨텍스트 메뉴 정상 동작 (Phase 3)
- [ ] 기존 모바일 사이드바 정상 동작
- [ ] 기존 모바일 TabBar 정상 동작
- [ ] 기존 모바일 AddTabModal 정상 동작
- [ ] 기존 `useDragReorder` 롱프레스 기반 드래그 정상 동작
- [ ] xterm.js 세로 스크롤 정상 동작 (캐러셀 스와이프와 충돌 없음)
- [ ] `npm run build` 성공 (타입 오류 없음)

---

## 6. Approval Checklist

- [ ] 모든 Completion Checklist 항목 완료
- [ ] 모든 테스트 PASS
- [ ] Quality Evaluation 전 항목 B 이상
- [ ] Critical/High 이슈 없음 (또는 모두 해결)
- [ ] 회귀 테스트 전 항목 통과
- [ ] Phase 6 진행 조건 충족 확인

**승인 여부**: ☐ 승인 / ☐ 조건부 승인 / ☐ 반려
**승인자**: __________
**승인일**: ____-__-__
