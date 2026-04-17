# Phase 4 검증 문서

## 완료 체크리스트

- [ ] `TerminalContainer` state machine 구현
- [ ] `TerminalView` render-only 경량화
- [ ] browser snapshot primary path 제거
- [ ] fallback 조건 분리

## 품질 게이트

- mount/reconnect/remount 상태 전이가 문서대로 재현 가능
- poisoned local snapshot 이 서버 snapshot 보다 앞서 적용되지 않음

## 승인 기준

- [ ] 새 state machine 이 E2E 와 unit 수준 모두에서 설명 가능하다
- [ ] restore deadlock 이 없다
