# Phase 3 검증: Native Daemon Launcher와 Readiness

## 검증 대상

- `FR-8-001`, `FR-8-006`, `FR-8-012`, `FR-8-015`
- `AC-8-001`, `AC-8-002`, `AC-8-016`, `AC-8-017`, `AC-8-018`
- `TEST-8-005`, `TEST-8-007`, `TEST-8-019`, `TEST-8-020`

## 필수 검증

- [x] 무인자 source production start가 daemon mode로 실행
- [x] 최소 sentinel child가 internal marker와 state PID를 남기고 `status=stopping`에서 종료 가능
- [x] parent가 readiness identity 확인 후 종료하고 app child는 유지
- [x] PM2 명령 호출 없음
- [x] 같은 실행 계약 재시작은 idempotent success
- [x] idempotent success에서 기존 appPid/sentinelPid가 유지됨
- [x] 다른 port/config/argv 재시작은 자동 교체 없이 실패
- [x] 무관 `/health` 200은 readiness success로 인정하지 않음

## 자동 검증 결과

- 2026-04-27: `npm run test:daemon` 통과, 55개 테스트.
- 2026-04-27: `Push-Location server; npm test; Pop-Location` 통과, 149개 테스트.
- 2026-04-27: 코드 리뷰 서브에이전트 최종 판정 `No findings`.

## 수동 검증 후보

```powershell
node tools/start-runtime.js -p 2002
curl -k https://localhost:2002/health
node tools/start-runtime.js -p 2002
node stop.js
```

## 완료 판정

PM2 없이 daemon start/readiness/idempotency/conflict 정책이 닫히고 orphan process가 없어야 한다.
