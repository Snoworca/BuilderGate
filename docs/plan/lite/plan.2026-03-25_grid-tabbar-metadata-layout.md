---
title: Grid Mode 탭바 숨김 + 전환 버튼 Header 이동 + MetadataRow 개별 터미널 하단 배치
project: BuilderGate
date: 2026-03-25
type: enhancement
tech_stack: React 18 + TypeScript + Vite
code_path: frontend/src
---

# Grid Mode 탭바 숨김 + 전환 버튼 Header 이동 + MetadataRow 개별 터미널 하단 배치

## 1. 의도 및 요구사항

### 1.1 목적
Grid Mode의 레이아웃을 개선하여 터미널 영역을 최대화하고, 상태 정보를 각 터미널 셀에 직접 표시한다.

### 1.2 배경
현재 Grid Mode에서 상단 TabBar가 불필요하게 공간을 차지하고, MetadataBar가 화면 하단에 모든 세션이 몰려있어 어떤 터미널에 해당하는 정보인지 직관적이지 않다.

### 1.3 기능 요구사항
- FR-1: Grid Mode에서 상단 TabBar를 숨긴다 (Tab Mode에서만 표시)
- FR-2: Grid/Tab 전환 버튼을 Header의 Settings 버튼 좌측으로 이동한다
- FR-3: MetadataRow(세션 이름 + 경과시간 + 복사 버튼)를 각 GridCell 하단에 개별 배치한다 (기존 하단 MetadataBar는 Grid Mode에서 숨김)

### 1.4 비기능 요구사항
- NFR-1: Tab Mode의 기존 동작은 변경하지 않는다

### 1.5 제약사항
- Header 컴포넌트에 viewMode 전환 콜백을 전달해야 한다

## 2. 현행 코드 분석

### 2.1 영향 범위
| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `frontend/src/App.tsx` | 수정 | TabBar 조건부 렌더링 (Tab Mode만), MetadataBar 조건부 렌더링 (Tab Mode만), Header에 viewMode props 전달 |
| `frontend/src/components/Header/Header.tsx` | 수정 | 전환 버튼을 Settings 좌측에 추가 |
| `frontend/src/components/Grid/GridCell.tsx` | 수정 | 하단에 MetadataRow 추가 |
| `frontend/src/components/Workspace/WorkspaceTabBar.tsx` | 수정 | ViewModeToggle 버튼 제거 (Header로 이동) |

### 2.2 재사용 가능 코드
- `MetadataRow` 컴포넌트(`frontend/src/components/MetadataBar/MetadataRow.tsx`) — GridCell 내부에서 직접 재사용

### 2.3 주의사항
- GridCell에 MetadataRow를 넣으면 터미널 영역이 MetadataRow 높이(24px)만큼 줄어듦 — flex 레이아웃이므로 자동 조정됨
- Tab Mode에서는 기존 하단 MetadataBar 유지

## 3. 구현 계획

## Phase 1: Grid Mode 탭바 숨김 + 전환 버튼 Header 이동

- [ ] Phase 1-1: `App.tsx` — Grid Mode일 때 `<WorkspaceTabBar>` 렌더링 조건을 `viewMode === 'tab'`으로 변경 `FR-1`
- [ ] Phase 1-2: `Header.tsx` — props에 `viewMode`, `onToggleViewMode`, `isMobile` 추가. Settings 버튼 좌측에 전환 버튼 렌더링 (데스크톱만, 모바일 숨김). 아이콘: Tab Mode → `⊞` (Grid로), Grid Mode → `☰` (Tab으로) `FR-2`
- [ ] Phase 1-3: `App.tsx` — Header에 `viewMode`, `onToggleViewMode` props 전달 `FR-2`
- [ ] Phase 1-4: `WorkspaceTabBar.tsx` — ViewModeToggle 버튼 제거 (Header에서 처리) `FR-2`
- **테스트:** (정상) Grid 전환 시 탭바 사라짐 + Header에 전환 버튼 표시 / (예외) 모바일에서 전환 버튼 숨김

## Phase 2: MetadataRow를 GridCell 하단에 개별 배치

- [ ] Phase 2-1: `GridCell.tsx` — props에 `tab` 데이터 전달 (이미 있음). 터미널 children 아래에 `<MetadataRow tab={tab} isOdd={false} />` 추가 `FR-3`
- [ ] Phase 2-2: `App.tsx` — Grid Mode일 때 하단 `<MetadataBar>` 숨김. Tab Mode에서만 MetadataBar 표시 `FR-3`
- **테스트:** (정상) 각 GridCell 하단에 세션이름+시간+복사 표시 / (예외) Tab Mode에서는 기존 하단 MetadataBar 유지 `NFR-1`

## 4. 검증 기준
- [ ] 빌드 성공 (`tsc --noEmit` 에러 0)
- [ ] Grid Mode에서 탭바가 보이지 않음
- [ ] Header Settings 좌측에 전환 버튼 표시
- [ ] Grid Mode에서 각 셀 하단에 세션이름+경과시간+복사 표시
- [ ] Tab Mode에서 기존 동작 유지 (탭바 + 하단 MetadataBar)
- [ ] 모바일에서 전환 버튼 숨김
- [ ] 요구사항 전수 매핑: FR-1 → Phase 1-1, FR-2 → Phase 1-2~1-4, FR-3 → Phase 2-1~2-2
