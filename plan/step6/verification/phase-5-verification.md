# Phase 5 검증: 키보드 단축키

**Phase**: Phase 5 - 키보드 단축키
**SRS References**: FR-6601~FR-6605, 섹션 5.5 (키보드 단축키), 섹션 7.5 (오버레이 스타일), NFR-6108
**Plan Reference**: `plan/step6/05.phase-5-keyboard-shortcuts.md`
**검증일**: ____-__-__
**검증자**: __________

---

## 1. Completion Checklist

### 1.1 Prefix 모드 상태 머신 (FR-6601)
- [ ] `TerminalView.tsx`의 `customKeyEventHandler`에 Ctrl+B 감지 추가
- [ ] Prefix 모드 진입: Ctrl+B → `usePaneManager.enterPrefixMode()`
- [ ] Prefix 모드에서 키 입력이 PTY로 전달되지 않음
- [ ] Prefix 모드 타임아웃: 1500ms 무입력 시 자동 해제
- [ ] 타임아웃 관리: `useEffect` 클린업으로 타이머 정리
- [ ] 상태 전이 정확성:
  - [ ] NORMAL → (Ctrl+B) → PREFIX
  - [ ] PREFIX → (키입력) → 명령실행 → NORMAL
  - [ ] PREFIX → (1500ms) → NORMAL
  - [ ] PREFIX → (Ctrl+B) → PTY에 `\x02` 전송 → NORMAL
  - [ ] PREFIX → (ESC) → NORMAL

### 1.2 키 매핑 (FR-6602)
- [ ] `%` (Shift+5) → 수직 분할 (좌/우)
- [ ] `"` (Shift+') → 수평 분할 (위/아래)
- [ ] `←` → 포커스 왼쪽 이동
- [ ] `→` → 포커스 오른쪽 이동
- [ ] `↑` → 포커스 위쪽 이동
- [ ] `↓` → 포커스 아래쪽 이동
- [ ] `x` → 현재 Pane 닫기 (확인 포함)
- [ ] `z` → Pane 줌 토글
- [ ] `q` → Pane 번호 오버레이 표시 (2초)
- [ ] `o` → 다음 Pane으로 포커스 순환
- [ ] `handlePrefixKey()` 메서드에 전체 매핑 구현

### 1.3 PaneNumberOverlay.tsx (FR-6603)
- [ ] `PaneNumberOverlay.tsx` 생성 완료
- [ ] 각 Pane 중앙에 번호(0부터) 오버레이 표시
- [ ] 스타일: 반투명 검정 배경 `rgba(0,0,0,0.7)`, 흰색 48px bold 숫자, 중앙 정렬
- [ ] 애니메이션: `fadeIn 200ms`
- [ ] 2초 후 자동 사라짐
- [ ] 오버레이 표시 중 숫자 키 입력 → 해당 번호 Pane으로 포커스 이동
- [ ] `showPaneNumbers()` / `selectPaneByNumber(num)` 연동

### 1.4 StatusBar 표시 (FR-6601, FR-6104)
- [ ] `StatusBar.tsx` 수정 완료
- [ ] Prefix 모드 진입 시 `[PREFIX]` 표시 (노란색 배경)
- [ ] 줌 상태에서 `[ZOOMED]` 표시
- [ ] 현재 Pane 정보 표시 (예: `Pane 1/3`)
- [ ] `usePaneManager`의 `prefixMode`, `layout.zoomedPaneId` 상태 연동

### 1.5 Ctrl+B 충돌 방지 (FR-6605)
- [ ] Prefix 모드 아닌 상태에서 Ctrl+B → Prefix 모드 진입, PTY 미전달
- [ ] Prefix 모드에서 Ctrl+B → PTY에 `\x02` (Ctrl+B) 전달
- [ ] 기존 `customKeyEventHandler`의 Ctrl+C/V 등 동작 영향 없음

### 1.6 에러 처리 (FR-6604)
- [ ] 인식 불가 키 입력 시 Prefix 모드 해제
- [ ] StatusBar에 "Unknown key: {key}" 메시지 1초간 표시
- [ ] 동작 불가 상황(단일 Pane에서 닫기 등)에서 동작 없이 Prefix 해제

### 1.7 빌드 및 통합
- [ ] `npm run build` 성공
- [ ] 기존 `customKeyEventHandler` 동작 유지 (Ctrl+C/V, 방향키 등)

---

## 2. Test Results

| Test ID | 설명 | Status | Notes |
|---------|------|--------|-------|
| TC-6601 | Ctrl+B Prefix 모드 진입 → StatusBar `[PREFIX]` 표시 | | |
| TC-6602 | Ctrl+B, % → 수직 분할 | | |
| TC-6603 | Ctrl+B, x → Pane 닫기 | | |
| TC-6604 | Ctrl+B, q → 번호 오버레이 표시 | | |
| TC-6605 | Ctrl+B, Ctrl+B → PTY에 `\x02` 전달 | | |
| TC-6606 | 1500ms 무입력 → Prefix 모드 자동 해제 | | |
| TC-6707 | Prefix 모드에서 인식 불가 키 입력 (예: Ctrl+B, 1) → Prefix 해제, "Unknown key: 1" 1초 표시 | | |

---

## 3. Quality Evaluation

| 기준 | 등급 | 비고 |
|------|------|------|
| **Plan-Code 정합성** — 계획서 대비 구현 일치도 | | |
| **SOLID 원칙** — 단일책임, 개방폐쇄, 의존성 역전 등 | | |
| **Test Coverage** — 단위/통합 테스트 커버리지 | | |
| **Readability** — 코드 가독성, 네이밍, 주석 | | |
| **Error Handling** — 인식 불가 키 처리, 타임아웃 정리, 동작 불가 처리 | | |
| **Documentation** — 인라인 문서, JSDoc, 타입 주석 | | |
| **Performance** — 키 입력 지연 없음, 오버레이 애니메이션 부드러움 | | |

---

## 4. Issues Found

| # | 심각도 | 설명 | 해결 상태 | 해결 방법 |
|---|--------|------|-----------|-----------|
| | | | | |
| | | | | |
| | | | | |

---

## 5. Regression Results

- [ ] 기존 `customKeyEventHandler` 동작 유지 (Ctrl+C 복사, Ctrl+V 붙여넣기)
- [ ] 기존 방향키 입력 정상 동작 (Prefix 모드 아닌 상태에서)
- [ ] 기존 Ctrl+[A-Z] 키 핸들링 정상 동작
- [ ] Pane 분할/닫기/리사이즈 정상 동작 (Phase 2)
- [ ] 컨텍스트 메뉴 정상 동작 (Phase 3)
- [ ] 모바일 캐러셀 정상 동작 (Phase 4)
- [ ] StatusBar 기존 정보 표시 정상 동작
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
