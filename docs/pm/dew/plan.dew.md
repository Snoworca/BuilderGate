---
stage: PLAN
grade: A+
output: docs/plan/step11/00.index.md
decisions:
  - contextMenuBuilder.ts 공유 유틸 추출 (FR-002)
  - useInlineRename.ts 훅으로 이름 편집 코드 공유 (FR-003)
  - 전체 탭 렌더링 + display:none 토글 (FR-004)
warnings_for_next: FR-004 구조 변경이 핵심 — ResizeObserver 가드 + fitAddon 타이밍 주의. App.tsx 대규모 변경.
summary: 4 Phase 구현 계획 — FR-002(빌더추출) → FR-001+003(UX통일) → FR-004(세션유지) → FR-005(LRU설정)
completed_at: 2026-04-06T16:10:00
---
