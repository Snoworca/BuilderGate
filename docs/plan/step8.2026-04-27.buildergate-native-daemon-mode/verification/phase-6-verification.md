# Phase 6 검증: Sentinel Watchdog

## 검증 대상

- `FR-8-007`, `FR-8-011`, `FR-8-015`, `FR-8-017`
- `AC-8-010`, `AC-8-011`, `AC-8-020`
- `TEST-8-015`, `TEST-8-016`, `TEST-8-022`

## 필수 검증

- [ ] abnormal app exit 시 sentinel이 backoff 후 재시작
- [ ] 10분 내 5회 초과 시 더 이상 재시작하지 않음
- [ ] fatal startup failure는 restart-loop 없이 `status=fatal` 기록
- [ ] `status=stopping` 중에는 app을 재시작하지 않음
- [ ] heartbeat와 restart fields가 state에 갱신됨
- [ ] sentinel log가 runtime log path에 기록됨

## 완료 판정

Sentinel은 PM2 감시 대체 역할을 수행하지만 fatal/stop 상태에서 재시작하지 않아야 한다.
