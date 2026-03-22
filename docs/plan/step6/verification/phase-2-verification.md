# Phase 2 검증: 데스크톱 Pane 분할

**Phase**: Phase 2 - 데스크톱 Pane 분할
**SRS References**: FR-6101~FR-6106, 섹션 3.4 (usePaneManager), 섹션 7.1/7.3/7.4 (UI 스펙)
**Plan Reference**: `plan/step6/02.phase-2-desktop-pane-split.md`
**검증일**: ____-__-__
**검증자**: __________

---

## 1. Completion Checklist

### 1.1 usePaneManager.ts 훅
- [ ] `usePaneManager.ts` 생성 완료
- [ ] `layout` 상태 관리 (PaneLayout)
- [ ] `prefixMode`, `swapSource`, `paneNumberOverlay` 상태 관리
- [ ] `splitPane(paneId, direction)` — 세션 생성 후 트리 분할, 실패 시 롤백
- [ ] `closePane(paneId)` — SSE 해제 → deleteSession → 트리 갱신
- [ ] `closeOtherPanes(keepPaneId)` — 나머지 Pane 순차 종료, 부분 실패 처리
- [ ] `setFocusedPane(paneId)` — 포커스 변경
- [ ] `moveFocus(direction)` — 방향별 인접 Pane으로 포커스 이동
- [ ] `cycleFocus()` — 다음 Pane으로 순환
- [ ] `toggleZoom(paneId?)` — 줌 토글, zoomedPaneId 관리
- [ ] `resizePane(splitId, ratio)` — ratio 업데이트 (0.15~0.85 클램핑)
- [ ] `equalizePanes(splitId)` — ratio를 0.5로 설정
- [ ] `toggleDirection(splitId)` — horizontal ↔ vertical 전환
- [ ] `startSwap(paneId)` / `executeSwap(targetPaneId)` / `cancelSwap()` — 교환 모드
- [ ] `applyPreset(preset)` — 기존 세션 종료 → 새 세션 생성 → 프리셋 적용
- [ ] `saveLayout(name)` / `loadLayout(layoutId)` — usePaneDB 연동
- [ ] computed: `paneCount`, `treeDepth`, `canSplit`, `allSessionIds`
- [ ] IndexedDB 자동 저장 (debounce 300ms, 분할/닫기/포커스/줌 시)

### 1.2 SplitPane.tsx 재귀 렌더러
- [ ] `SplitPane.tsx` 생성 완료
- [ ] PaneSplit 노드: `flex-direction` + ratio 기반 자식 렌더링
- [ ] PaneLeaf 노드: `TerminalContainer` 렌더링
- [ ] 재귀 구조로 깊은 중첩 지원
- [ ] 줌 상태 처리: 줌 대상만 표시, 나머지 `display: none`
- [ ] 포커스 표시: 상단 2px `var(--accent-color)` 바
- [ ] Pane 클릭 시 `setFocusedPane` 호출

### 1.3 PaneResizer.tsx 드래그 핸들
- [ ] `PaneResizer.tsx` 생성 완료
- [ ] 수직 분할: `cursor: col-resize`, 4px 너비
- [ ] 수평 분할: `cursor: row-resize`, 4px 높이
- [ ] 호버 시 `var(--accent-color)` 하이라이트
- [ ] 드래그 중 `pointer-events: none` 오버레이 (xterm.js 이벤트 차단)
- [ ] 드래그 완료(`pointerup`) 시 IndexedDB 즉시 저장
- [ ] ratio 0.15~0.85 클램핑
- [ ] 최소 Pane 크기(120px/80px) 클램핑

### 1.4 PaneRenderer.tsx
- [ ] `PaneRenderer.tsx` 생성 완료
- [ ] 반응형 분기 로직 (768px 기준) — 데스크톱: SplitPane, 모바일: placeholder/캐러셀(Phase 4)

### 1.5 App.tsx 통합
- [ ] `usePaneManager` 훅 연동
- [ ] `childSessionIds` → `allSessionIds` computed value로 전환
- [ ] 기존 탭 콘텐츠 영역에 `PaneRenderer` 배치
- [ ] 터미널 탭에서만 Pane 분할 활성화 (파일/뷰어 탭 제외)

### 1.6 PaneSystem.css 스타일
- [ ] `PaneSystem.css` 생성 완료
- [ ] 분할 레이아웃 flex 스타일
- [ ] 포커스 표시 스타일
- [ ] 경계선(resizer) 스타일 (기본, 호버, 드래그 중)
- [ ] 줌 상태 스타일
- [ ] 교환 모드 하이라이트 스타일 (점선 테두리)

### 1.7 빌드 및 통합
- [ ] `npm run build` 성공
- [ ] 기존 TerminalContainer 인터페이스 변경 없음
- [ ] ResizeObserver + FitAddon 자동 맞춤 정상 동작

---

## 2. Test Results

| Test ID | 설명 | Status | Notes |
|---------|------|--------|-------|
| TC-6101 | 단일 Pane에서 수직 분할 → 좌우 2개 Pane 표시, 각각 독립 PTY | | |
| TC-6102 | 8개 Pane에서 분할 시도 → 분할 메뉴 비활성화 | | |
| TC-6103 | 2개 Pane에서 하나 닫기 → 나머지가 전체 영역 차지, PTY 종료 확인 | | |
| TC-6104 | 마지막 Pane 닫기 시도 → 닫기 메뉴 비활성화 | | |
| TC-6105 | 경계선 드래그로 리사이즈 → ratio 변경, xterm 자동 맞춤 | | |
| TC-6106 | 극단적 리사이즈 (ratio 0.1) → 0.15에서 클램핑 | | |
| TC-6107 | Pane 줌 토글 → 줌 상태에서 단일 Pane만 표시, 해제 시 원래 레이아웃 복원 | | |
| TC-6108 | 2개 Pane 교환 → 세션이 반대 위치로 이동 | | |
| TC-6109 | 방향키로 포커스 이동 → 인접 Pane으로 정확히 이동 | | |

---

## 3. Quality Evaluation

| 기준 | 등급 | 비고 |
|------|------|------|
| **Plan-Code 정합성** — 계획서 대비 구현 일치도 | | |
| **SOLID 원칙** — 단일책임, 개방폐쇄, 의존성 역전 등 | | |
| **Test Coverage** — 단위/통합 테스트 커버리지 | | |
| **Readability** — 코드 가독성, 네이밍, 주석 | | |
| **Error Handling** — 예외 처리, 세션 생성 실패 롤백, 부분 실패 처리 | | |
| **Documentation** — 인라인 문서, JSDoc, 타입 주석 | | |
| **Performance** — 리사이즈 16ms 이내, Reflow 최적화, 불필요한 리렌더링 방지 | | |

---

## 4. Issues Found

| # | 심각도 | 설명 | 해결 상태 | 해결 방법 |
|---|--------|------|-----------|-----------|
| | | | | |
| | | | | |
| | | | | |

---

## 5. Regression Results

- [ ] 기존 탭 추가/삭제/재정렬 정상 동작
- [ ] 기존 파일 탭, 뷰어 탭 정상 동작 (Pane 분할 영향 없음)
- [ ] 기존 세션 생성/삭제 API 정상 동작
- [ ] 기존 SSE 스트림 정상 동작
- [ ] 기존 사이드바 세션 목록 정상 동작 (`childSessionIds` 전환 후)
- [ ] 기존 xterm.js FitAddon 자동 맞춤 정상 동작
- [ ] `npm run build` 성공 (타입 오류 없음)
- [ ] 기존 모바일 레이아웃 깨지지 않음

---

## 6. Approval Checklist

- [ ] 모든 Completion Checklist 항목 완료
- [ ] 모든 테스트 PASS
- [ ] Quality Evaluation 전 항목 B 이상
- [ ] Critical/High 이슈 없음 (또는 모두 해결)
- [ ] 회귀 테스트 전 항목 통과
- [ ] Phase 3, 4, 5 병렬 진행 가능 상태 확인

**승인 여부**: ☐ 승인 / ☐ 조건부 승인 / ☐ 반려
**승인자**: __________
**승인일**: ____-__-__
