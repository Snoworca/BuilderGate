# Phase 2 검증: Foreground 실행 계약

## 검증 대상

- `FR-8-002`, `FR-8-003`
- `AC-8-003`, `AC-8-019`
- `TEST-8-006`, `TEST-8-008`, `TEST-8-021`

## 필수 검증

- [ ] `--foreground`와 `--forground`가 같은 foreground mode로 동작
- [ ] sentinel이 시작되지 않음
- [ ] active daemon state가 기록되지 않음
- [ ] stdout/stderr가 현재 콘솔에 연결됨
- [ ] stop utility가 foreground process를 종료하지 않음

## 수동 검증 후보

```powershell
node tools/start-runtime.js --foreground -p 2002
curl -k https://localhost:2002/health
node stop.js
curl -k https://localhost:2002/health
```

## 완료 판정

Foreground가 daemon state와 완전히 분리되고, stop negative가 통과해야 완료된다.
