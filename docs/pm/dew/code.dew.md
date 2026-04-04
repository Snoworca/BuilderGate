---
stage: CODE
grade: A+ (tsc --noEmit 통과)
output: frontend/src/utils/shell.ts, frontend/src/hooks/useLongPress.ts, frontend/src/components/Workspace/WorkspaceTabBar.tsx, frontend/src/components/Workspace/EmptyState.tsx, frontend/src/components/Grid/EmptyCell.tsx, frontend/src/components/Grid/MosaicTile.tsx, frontend/src/components/Grid/MosaicContainer.tsx, frontend/src/App.tsx
decisions:
  - useLongPress 확장 (touch 유지 + pointer 추가 + wasLongPress)
  - shell.ts 유틸 (getShellFamily, resolveCwd)
  - 그리드 컨텍스트 메뉴는 ContextMenu children 서브메뉴
warnings_for_next: 런타임 테스트 필요 — 롱프레스 타이밍, 셸 메뉴 위치, CWD 전달 확인
summary: 셸 선택 UI 통일 — 신규 1파일 + 수정 7파일, tsc 통과
completed_at: 2026-04-04T15:15:00
---
