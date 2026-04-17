# Phase 3 검증 문서

## 완료 체크리스트

- [ ] `screen:snapshot` / `screen:ready` 프로토콜 반영
- [ ] stale ack 무시
- [ ] duplicate subscribe idempotent
- [ ] reconnect resync

## 품질 게이트

- ordering race 테스트 존재
- socket별 replay pending 누수 없음

## 승인 기준

- [ ] protocol contract 가 frontend 와 서버 타입에서 일치한다
- [ ] queued output flush 시점이 `snapshotId` 로 검증된다
