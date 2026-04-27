# Phase 6 검증: Sentinel Watchdog

## 검증 대상

- `FR-8-007`, `FR-8-011`, `FR-8-015`, `FR-8-017`
- `AC-8-010`, `AC-8-011`, `AC-8-020`
- `TEST-8-015`, `TEST-8-016`, `TEST-8-022`

## 필수 검증

- [x] abnormal app exit 시 sentinel이 backoff 후 재시작
- [x] 10분 내 5회 초과 시 더 이상 재시작하지 않음
- [x] fatal startup failure는 restart-loop 없이 `status=fatal` 기록
- [x] `status=stopping` 중에는 app을 재시작하지 않음
- [x] heartbeat와 restart fields가 state에 갱신됨
- [x] sentinel log가 runtime log path에 기록됨

## 자동 검증 결과

| 항목 | 결과 |
| --- | --- |
| targeted daemon tests | `node --check tools/daemon/sentinel.js; node --test tools/daemon/sentinel.test.js tools/daemon/stop-client.test.js` 통과, 28 tests |
| daemon regression | `npm run test:daemon` 통과, 93 tests |
| server regression | `npm --prefix server test` 통과, 161 tests |
| review | `No findings` by `019dcd40-f570-7d61-ae35-44b5458d817a` |

## 완료 판정

Sentinel은 PM2 감시 대체 역할을 수행하지만 fatal/stop 상태에서 재시작하지 않아야 한다.
