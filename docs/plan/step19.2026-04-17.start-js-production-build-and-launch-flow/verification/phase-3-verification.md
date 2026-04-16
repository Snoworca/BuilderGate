# Phase 3 Verification

## 목적

start.js launcher contract가 thin하고 안정적으로 동작하는지 검증한다.

## 확인 항목

- [ ] `start.js`가 `cwd=server`로 child를 띄운다
- [ ] 포트 우선순위가 `--port > config server.port > 2222`로 동작한다
- [ ] `NODE_ENV=production`, resolved `PORT`가 child env로 전달된다
- [ ] build artifact 누락 시 명확히 실패한다
- [ ] child exit code/signals가 상위 프로세스로 전파된다
- [ ] `dev.js` flow에는 회귀가 없다

## 증거

- process log
- env/port run evidence
- missing-artifact failure log
