---
title: 탭바 죽은 코드 제거 및 모바일 컬러 바 통합
project: BuilderGate
date: 2026-04-07
type: refactor + fix
tech_stack: React 18, TypeScript, Vite
code_path: frontend/src
request_doc: docs/srs/request/2026-04-07.request.srs-plan.탭바-죽은코드-제거-및-모바일-통합.md
---

# 탭바 죽은 코드 제거 및 모바일 컬러 바 통합

---

# Part 1: SRS (무엇을)

## 1.1 목적
사용되지 않는 `TabBar` 컴포넌트(죽은 코드)를 제거하고, 모바일에서 탭 상단 컬러 바가 데스크탑과 동일하게 표시되도록 수정한다.

## 1.2 배경
- 프로젝트에 두 개의 탭 바 컴포넌트가 존재: `TabBar`(구버전)와 `WorkspaceTabBar`(현재 사용)
- `TabBar`는 어디에서도 import되지 않는 완전한 죽은 코드
- `TabBar` 전용으로 사용되는 `AddTabModal`, `TabContextModal`도 다른 곳에서 미사용
- 모바일에서 `globals.css`의 `button { min-height: 44px }` 규칙이 `WorkspaceTabBar` 내부 버튼에 적용되어, 탭 컨테이너(36px) 대비 버튼이 팽창 → 탭 div가 수직 중앙정렬되면서 `borderTop` 컬러 바가 컨테이너 상단 밖으로 밀려 잘림

## 1.3 기능 요구사항
- **FR-1**: `TabBar` 컴포넌트 및 관련 죽은 코드 파일 전수 삭제
- **FR-2**: 모바일에서 `WorkspaceTabBar` 탭 상단 컬러 바가 데스크탑과 동일하게 표시되도록 수정
- **FR-3**: `WorkspaceTabBar`에서 미사용 `isMobile` prop 제거 (불필요한 인터페이스 정리)

## 1.4 비기능 요구사항
- **NFR-1**: 삭제 후 빌드 오류 없음 (TypeScript + Vite 빌드 통과)
- **NFR-2**: 기존 데스크탑 탭 바 동작에 회귀 없음

## 1.5 제약사항
- `useTabManager.ts`는 `MdirPanel.tsx`에서 `PendingOp` 타입을 import하므로 **삭제 불가**
- `Modal/index.ts`에서 삭제 대상 모달의 export를 제거해야 함

## 1.6 현행 코드 분석

### 영향 범위

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `components/TabBar/TabBar.tsx` | **삭제** | 죽은 코드 (App.tsx에서 미import) |
| `components/TabBar/TabBar.css` | **삭제** | TabBar 전용 스타일 |
| `components/TabBar/index.ts` | **삭제** | TabBar 배럴 export |
| `components/Modal/AddTabModal.tsx` | **삭제** | TabBar에서만 사용, WorkspaceTabBar 미사용 |
| `components/Modal/AddTabModal.css` | **삭제** | AddTabModal 전용 스타일 |
| `components/Modal/TabContextModal.tsx` | **삭제** | TabBar에서만 사용, WorkspaceTabBar 미사용 |
| `components/Modal/TabContextModal.css` | **삭제** | TabContextModal 전용 스타일 |
| `components/Modal/index.ts` | **수정** | AddTabModal, TabContextModal export 제거 |
| `components/Workspace/WorkspaceTabBar.tsx` | **수정** | isMobile prop 제거 |
| `components/Workspace/WorkspaceTabBar.css` | **수정** | 모바일 버튼 min-height 예외 처리 추가 |
| `App.tsx` | **수정** | WorkspaceTabBar에 전달하는 isMobile prop 제거 |

### 재사용 가능 코드
- `hooks/useTabManager.ts` — 삭제 불가, `PendingOp` 타입이 `MdirPanel.tsx`에서 사용됨
- `hooks/useDragReorder.ts` — WorkspaceTabBar에서도 독립적으로 사용 중, 영향 없음

### 주의사항
- `AddTabModal`/`TabContextModal` 삭제 시 `Modal/index.ts`의 export 정리 필수
- `useTabManager.ts`의 `UnifiedTab` 타입은 삭제된 TabBar에서만 사용하지만 타입 자체는 훅 내부에서도 정의/사용되므로 무해 (삭제 불필요)

---

# Part 2: 구현 계획 (어떻게)

## Phase 1: 죽은 코드 삭제 `FR-1`

### 파일 삭제 (7개)
- [ ] Phase 1-1: `components/TabBar/TabBar.tsx` 삭제 `FR-1`
- [ ] Phase 1-2: `components/TabBar/TabBar.css` 삭제 `FR-1`
- [ ] Phase 1-3: `components/TabBar/index.ts` 삭제 `FR-1`
- [ ] Phase 1-4: `components/Modal/AddTabModal.tsx` 삭제 `FR-1`
- [ ] Phase 1-5: `components/Modal/AddTabModal.css` 삭제 `FR-1`
- [ ] Phase 1-6: `components/Modal/TabContextModal.tsx` 삭제 `FR-1`
- [ ] Phase 1-7: `components/Modal/TabContextModal.css` 삭제 `FR-1`

### export 정리 (1개)
- [ ] Phase 1-8: `components/Modal/index.ts`에서 `AddTabModal`, `TabContextModal` export 행 제거 `FR-1`

- **테스트:**
  - 정상: `tsc --noEmit` 통과 (타입 오류 없음)
  - 정상: `vite build` 통과 (번들 오류 없음)

## Phase 2: 모바일 탭 컬러 바 수정 `FR-2`

- [ ] Phase 2-1: `WorkspaceTabBar.css`에 모바일 예외 규칙 추가 `FR-2`
  - `.workspace-tabbar button { min-height: auto; }` (전역 44px 규칙 무효화)
  - 또는 모바일 미디어쿼리 안에서 `.workspace-tabbar` 버튼 예외 처리

- **근본 원인**: `globals.css:108`의 `@media (max-width: 767px) { button { min-height: 44px; } }`가 WorkspaceTabBar 내부 ×/+ 버튼에 적용 → 버튼 팽창 → 탭 div 팽창 → `align-items: center`로 중앙정렬 → `borderTop` 컬러 바가 컨테이너(36px) 상단 밖으로 밀려 `overflow-y: hidden`에 의해 잘림
- **해결**: WorkspaceTabBar 내부 버튼에만 `min-height: auto` 적용하여 컨테이너 높이 내에서 정상 렌더링

- **테스트:**
  - 정상: 브라우저 모바일 뷰(≤767px)에서 탭 상단 컬러 바 표시 확인
  - 정상: 데스크탑 뷰에서 탭 컬러 바 변경 없음 (회귀 없음)
  - 예외: ×/+ 버튼이 여전히 터치 가능 크기 유지 확인

## Phase 3: 미사용 prop 제거 `FR-3`

- [ ] Phase 3-1: `WorkspaceTabBar.tsx`의 Props 인터페이스에서 `isMobile` 제거 `FR-3`
- [ ] Phase 3-2: `WorkspaceTabBar.tsx`의 props 구조분해에서 `isMobile` 제거 `FR-3`
- [ ] Phase 3-3: `App.tsx`에서 `<WorkspaceTabBar>`에 전달하는 `isMobile={isMobile}` prop 제거 `FR-3`

- **테스트:**
  - 정상: `tsc --noEmit` 통과

## 단위 테스트 계획

### 테스트 대상
| 대상 | 테스트 유형 | 시나리오 |
|------|------------|----------|
| 빌드 | 통합 | `tsc --noEmit` + `vite build` 성공 |
| WorkspaceTabBar 모바일 | 시각 | 모바일 뷰포트에서 탭 컬러 바 표시 확인 |
| WorkspaceTabBar 데스크탑 | 회귀 | 데스크탑에서 기존과 동일한 UI |
| ×/+ 버튼 | 기능 | 모바일에서 버튼 터치 여전히 동작 |

### 기존 테스트 영향
- 기존 테스트 파일: 해당 없음 (프론트엔드 유닛 테스트 미존재)
- 회귀 위험: 낮음 (죽은 코드 삭제 + CSS 예외 추가)
- 추가 필요 테스트: 빌드 검증 + 시각적 확인

## 검증 기준
- [ ] 빌드 성공 (`tsc --noEmit` + `vite build`)
- [ ] 삭제된 7개 파일이 더 이상 존재하지 않음
- [ ] `Modal/index.ts`에서 삭제된 모달 export 없음
- [ ] 모바일 뷰에서 탭 상단 컬러 바 표시
- [ ] 데스크탑 뷰에서 탭 동작 회귀 없음
- [ ] 요구사항 전수 매핑: FR-1 → Phase 1, FR-2 → Phase 2, FR-3 → Phase 3

## 후속 파이프라인
- 다음 단계: `snoworca-plan-driven-coder`
- 입력 인자:
  - PLAN_PATH: `docs/srs/step4.srs-plan.탭바-죽은코드-제거-및-모바일-통합.2026-04-07.md`
  - LANGUAGE: TypeScript 5.x
  - FRAMEWORK: React 18 + Vite
  - CODE_PATH: `frontend/src`
