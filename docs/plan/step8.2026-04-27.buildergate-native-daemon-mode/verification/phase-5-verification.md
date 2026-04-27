# Phase 5 검증: PID 검증, Internal Shutdown, Stop

## 검증 대상

- `FR-8-008`, `FR-8-009`, `FR-8-010`
- `AC-8-006`, `AC-8-007`, `AC-8-008`, `AC-8-009`, `AC-8-019`
- `TEST-8-004`, `TEST-8-012`, `TEST-8-013`, `TEST-8-014`, `TEST-8-021`

## 필수 검증

- [x] stale PID와 PID reuse는 kill 없이 거부
- [x] start time 조회 불가 fallback에서는 executable/command/cwd와 heartbeat freshness를 모두 검증
- [x] stale heartbeat는 경고 또는 실패로 처리하되 kill fallback으로 이어지지 않음
- [x] stop utility가 state를 `stopping`으로 갱신하고 sentinel을 먼저 중지
- [x] internal shutdown route가 token+loopback을 모두 검증
- [x] forwarding header spoofing을 신뢰하지 않음
- [x] shutdown route `404 Not Found`와 `500` failure response contract 검증
- [x] 10초 단일 graceful stop budget과 timeout 시 non-zero graceful failure 검증
- [x] shutdown response에 flush result 포함
- [x] workspace JSON `lastUpdated`와 `state.tabs[].lastCwd` 검증
- [x] `/health` 비응답 확인 후 stopped 처리
- [x] foreground process는 stop 대상 아님

## 자동 검증 결과

| 검증 | 결과 |
| --- | --- |
| PID validator | `tools/daemon/process-info.test.js` 포함, 통과 |
| native stop | `tools/daemon/stop-client.test.js` 포함, 통과 |
| shutdown negative | 서버 route 테스트와 stop-client 401/403/404/500 테스트 통과 |
| workspace/CWD flush | `performGracefulShutdown` fixture에서 `lastUpdated`, `state.tabs[].lastCwd` 확인 |
| foreground stop negative | state 없음 경로가 daemon not running으로 통과 |
| 전체 회귀 | `npm run test:daemon` 95 tests, `npm --prefix server test` 161 tests |
| 코드 리뷰 | `No findings`, reviewer `019dcd26-605f-77c2-98b6-6c0918596008`; 재검증 reviewer `019dcd57-5b53-7772-931e-db68aae22185` |
| 추가 회귀 | 10초 단일 budget, flush evidence 누락 거부, 성공 로그 flush marker 검증 |

## 수동 검증 후보

```powershell
node tools/start-runtime.js -p 2002
curl -k https://localhost:2002/health
node stop.js
curl -k https://localhost:2002/health
```

## 완료 판정

Stop이 검증된 daemon만 graceful하게 종료하고, 검증 실패에서는 무관 PID를 절대 종료하지 않아야 한다.
