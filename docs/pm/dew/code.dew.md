---
stage: CODE
grade: N/A (리뷰 전)
output: server/src/services/SessionManager.ts, server/src/services/OscDetector.ts, server/src/shell-integration/bash-osc133.sh, server/src/shell-integration/zsh-osc133.zsh, server/package.json
decisions:
  - Phase 1: EchoTracker+isEchoOutput 에코 휴리스틱 (모든 셸)
  - Phase 2: OscDetector 모듈 + bash/zsh 셸 integration 스크립트
  - Phase 3: onData 통합, 자동 heuristic→osc133 승격, stripped 출력
  - BASH_ENV로 자동 주입, buildShellEnv/getShellIntegrationPath/toWslPath 메서드
  - package.json 빌드 스크립트에 shell-integration 복사 추가
warnings_for_next: TypeScript 컴파일 확인 필요. 빌드 스크립트 동작 검증 필요.
summary: Tier1(에코 휴리스틱) + Tier2(OSC 133) 전체 구현 완료
completed_at: 2026-04-04T14:30:00
---
