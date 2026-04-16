# Phase 2 Verification

## 목적

build orchestration과 public staging이 repeatable하게 동작하는지 검증한다.

## 확인 항목

- [ ] `node build.js`가 server build -> frontend build -> staging 순서로 동작한다
- [ ] `server/dist/public/index.html`이 생성된다
- [ ] stale hashed assets가 제거된다
- [ ] build failure 시 non-zero exit와 actionable log가 남는다
- [ ] delete/copy target이 `server/dist/public` 밖으로 벗어나지 않는다

## 증거

- build logs
- directory tree snapshot
- failure injection 결과

