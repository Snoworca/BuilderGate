---
stage: PLAN
grade: A+
output: docs/plan/step9/
decisions:
  - 3-phase 구성: Phase1(에코 휴리스틱) → Phase2(OSC 133 모듈+스크립트) → Phase3(자동 전환+통합)
  - EchoTracker + DetectionMode를 SessionData에 추가
  - 50ms+길이x2 에코 판정, Enter시 즉시 running
  - OSC 133 자동 감지 시 osc133 모드 승격
  - sh/dash는 Tier1 고정 (OSC C/D 불가)
warnings_for_next: 기존 onData 핸들러 구조 변경 필요. sData 변수 위치 이동 주의.
summary: Tier1+Tier2 3-phase 구현 계획 완료
completed_at: 2026-04-04T14:15:00
---
