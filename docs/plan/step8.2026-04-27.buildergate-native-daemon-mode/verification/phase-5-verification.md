# Phase 5 검증: PID 검증, Internal Shutdown, Stop

## 검증 대상

- `FR-8-008`, `FR-8-009`, `FR-8-010`
- `AC-8-006`, `AC-8-007`, `AC-8-008`, `AC-8-009`, `AC-8-019`
- `TEST-8-004`, `TEST-8-012`, `TEST-8-013`, `TEST-8-014`, `TEST-8-021`

## 필수 검증

- [ ] stale PID와 PID reuse는 kill 없이 거부
- [ ] start time 조회 불가 fallback에서는 executable/command/cwd와 heartbeat freshness를 모두 검증
- [ ] stale heartbeat는 경고 또는 실패로 처리하되 kill fallback으로 이어지지 않음
- [ ] stop utility가 state를 `stopping`으로 갱신하고 sentinel을 먼저 중지
- [ ] internal shutdown route가 token+loopback을 모두 검증
- [ ] forwarding header spoofing을 신뢰하지 않음
- [ ] shutdown route `404 Not Found`와 `500` failure response contract 검증
- [ ] 10초 graceful stop timeout과 timeout 시 non-zero graceful failure 검증
- [ ] shutdown response에 flush result 포함
- [ ] workspace JSON `lastUpdated`와 `state.tabs[].lastCwd` 검증
- [ ] `/health` 비응답 확인 후 stopped 처리
- [ ] foreground process는 stop 대상 아님

## 수동 검증 후보

```powershell
node tools/start-runtime.js -p 2002
curl -k https://localhost:2002/health
node stop.js
curl -k https://localhost:2002/health
```

## 완료 판정

Stop이 검증된 daemon만 graceful하게 종료하고, 검증 실패에서는 무관 PID를 절대 종료하지 않아야 한다.
