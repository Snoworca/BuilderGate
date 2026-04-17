# Phase 2 검증 문서

## 완료 체크리스트

- [ ] `SessionData` 에 emulator state 반영
- [ ] PTY output / resize / restart / delete 동기화
- [ ] runtime config 즉시 재조정
- [ ] fallback mode 전환 검증

## 품질 게이트

- session lifecycle 전 구간 테스트 존재
- generation 증가 semantics 확인

## 승인 기준

- [ ] `getScreenSnapshot(sessionId)` 가 안정적으로 동작한다
- [ ] Phase 3 가 SessionManager 내부 구현을 몰라도 snapshot 을 받을 수 있다
