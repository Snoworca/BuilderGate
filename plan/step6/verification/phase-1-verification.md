# Phase 1 검증: 기반 인프라

**Phase**: Phase 1 - 기반 인프라
**SRS References**: 섹션 3.1~3.3 (PaneNode 트리), 섹션 4.1~4.5 (IndexedDB), FR-6401~FR-6407, FR-6501
**Plan Reference**: `plan/step6/01.phase-1-infrastructure.md`
**검증일**: ____-__-__
**검증자**: __________

---

## 1. Completion Checklist

### 1.1 타입 정의
- [ ] `frontend/src/types/pane.types.ts` 생성 완료
- [ ] `PaneNode`, `PaneLeaf`, `PaneSplit` 타입 정의
- [ ] `PaneLayout` 인터페이스 정의 (`root`, `focusedPaneId`, `zoomedPaneId`)
- [ ] `PresetType` 6종 정의 (`single`, `vertical-2`, `horizontal-2`, `quad`, `main-side`, `agent-monitor`)
- [ ] `Direction`, `FocusDirection` 타입 정의
- [ ] IndexedDB 레코드 타입 정의 (`PaneLayoutRecord`, `SavedLayoutRecord`, `SessionMetaRecord`)

### 1.2 paneTree.ts 순수 함수 (14개)
- [ ] `splitPane` — PaneLeaf를 PaneSplit으로 교체, ratio=0.5
- [ ] `closePane` — PaneLeaf 제거, 형제 승격, 루트 제거 시 null 반환
- [ ] `resizePane` — ratio 업데이트 (0.15~0.85 클램핑)
- [ ] `swapPanes` — 두 PaneLeaf 위치 교환
- [ ] `toggleDirection` — horizontal ↔ vertical 전환
- [ ] `flattenPaneTree` — 깊이 우선 순회, PaneLeaf 배열 반환
- [ ] `findPane` — ID로 PaneLeaf 검색
- [ ] `findSplit` — ID로 PaneSplit 검색
- [ ] `findParentSplit` — PaneLeaf의 부모 PaneSplit 반환
- [ ] `getAdjacentPane` — 방향별 인접 PaneLeaf 반환
- [ ] `countPanes` — 전체 PaneLeaf 수
- [ ] `getTreeDepth` — 트리 최대 깊이
- [ ] `equalizeRatios` — ratio를 0.5로 설정
- [ ] `buildPresetLayout` — 프리셋 타입 + 세션 ID로 PaneLayout 생성

### 1.3 paneDb.ts IndexedDB 모듈
- [ ] `openDB()` — DB 열기, 스키마 초기화 (`buildergate`, v1)
- [ ] Object Store `paneLayouts` 생성 (keyPath: `sessionId`, index: `byUpdatedAt`)
- [ ] Object Store `savedLayouts` 생성 (keyPath: `id`, index: `byName`)
- [ ] Object Store `sessionMeta` 생성 (keyPath: `sessionId`)
- [ ] `txPut<T>()` — 트랜잭션 기반 put 헬퍼
- [ ] `txGet<T>()` — 트랜잭션 기반 get 헬퍼
- [ ] `txDelete()` — 트랜잭션 기반 delete 헬퍼
- [ ] `txGetAll<T>()` — 트랜잭션 기반 getAll 헬퍼
- [ ] IndexedDB 미지원 시 localStorage 폴백 처리

### 1.4 usePaneDB.ts 훅
- [ ] `saveLayout(sessionId, layout)` — 레이아웃 upsert
- [ ] `loadLayout(sessionId)` — 레이아웃 로드 (없으면 null)
- [ ] `deleteLayout(sessionId)` — 레이아웃 삭제
- [ ] `savePreset(name, layout)` — 커스텀 프리셋 저장
- [ ] `loadPresets()` — 전체 프리셋 조회
- [ ] `deletePreset(id)` — 커스텀 프리셋 삭제 (`isBuiltIn` 검증)
- [ ] `initBuiltInPresets()` — 6개 기본 프리셋 생성 (중복 스킵)
- [ ] `migrateFromLocalStorage()` — 기존 탭 상태 마이그레이션

### 1.5 단위 테스트
- [ ] paneTree 단위 테스트 전체 통과
- [ ] IndexedDB 모듈 테스트 통과
- [ ] 빌드 오류 없음 (`npm run build`)

---

## 2. Test Results

| Test ID | 설명 | Status | Notes |
|---------|------|--------|-------|
| TC-6801 | `splitPane`: 루트 PaneLeaf 분할 → PaneSplit 반환, ratio=0.5, 자식 2개 | | |
| TC-6802 | `closePane`: 루트가 대상 → null 반환 | | |
| TC-6803 | `closePane`: 2레벨 트리에서 리프 닫기 → 형제가 루트로 승격 | | |
| TC-6804 | `resizePane`: ratio 0.1 입력 → 0.15로 클램핑 | | |
| TC-6805 | `flattenPaneTree`: 4분할 트리 → 4개 PaneLeaf 배열 반환 | | |
| TC-6806 | `getAdjacentPane`: 수직 분할에서 왼쪽 Pane의 right 이동 → 오른쪽 Pane 반환 | | |
| TC-6807 | `buildPresetLayout`: sessionIds 수 불일치 → 에러 throw | | |
| TC-6401 | 앱 새로고침 후 레이아웃 복원 → IndexedDB에서 정확히 복원 | | |
| TC-6402 | 기존 localStorage 데이터 있는 앱 로드 → IndexedDB로 마이그레이션 후 복원 | | |
| TC-6403 | IndexedDB 미지원 환경 → localStorage 폴백 동작 | | |

---

## 3. Quality Evaluation

| 기준 | 등급 | 비고 |
|------|------|------|
| **Plan-Code 정합성** — 계획서 대비 구현 일치도 | | |
| **SOLID 원칙** — 단일책임, 개방폐쇄, 의존성 역전 등 | | |
| **Test Coverage** — 단위/통합 테스트 커버리지 | | |
| **Readability** — 코드 가독성, 네이밍, 주석 | | |
| **Error Handling** — 예외 처리, 폴백, 에러 메시지 | | |
| **Documentation** — 인라인 문서, JSDoc, 타입 주석 | | |
| **Performance** — 불필요한 연산 없음, 메모리 효율 | | |

---

## 4. Issues Found

| # | 심각도 | 설명 | 해결 상태 | 해결 방법 |
|---|--------|------|-----------|-----------|
| | | | | |
| | | | | |
| | | | | |

---

## 5. Regression Results

- [ ] 기존 `frontend/src/types/index.ts` 타입에 영향 없음
- [ ] 기존 `useTabManager` 정상 동작
- [ ] 기존 `useSession` 정상 동작
- [ ] 기존 localStorage 기반 기능 정상 동작 (마이그레이션 전)
- [ ] `npm run build` 성공 (타입 오류 없음)
- [ ] 기존 터미널 세션 생성/삭제 정상 동작

---

## 6. Approval Checklist

- [ ] 모든 Completion Checklist 항목 완료
- [ ] 모든 테스트 PASS
- [ ] Quality Evaluation 전 항목 B 이상
- [ ] Critical/High 이슈 없음 (또는 모두 해결)
- [ ] 회귀 테스트 전 항목 통과
- [ ] Phase 2 진행 가능 상태 확인

**승인 여부**: ☐ 승인 / ☐ 조건부 승인 / ☐ 반려
**승인자**: __________
**승인일**: ____-__-__
