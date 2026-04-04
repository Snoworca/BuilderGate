---
stage: PLAN
grade: A+
output: docs/plan/step10/00.index.md
decisions:
  - 신규 useLongPress 커스텀 훅 생성 (useDragReorder와 분리)
  - CWD 계열 판별 유틸 shell.ts 분리 (getShellFamily, resolveCwd)
  - 그리드 컨텍스트 메뉴는 ContextMenu children 서브메뉴 방식
warnings_for_next: ContextMenu children 서브메뉴 지원 여부 확인 필요, MosaicTile onAdd 시그니처 확인 필요
summary: 7 Phase 구현 계획 — 신규 2파일 + 수정 5~6파일, 서버 변경 없음
completed_at: 2026-04-04T15:05:00
---
