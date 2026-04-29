---
title: Phase 1 Verification
date: 2026-04-29
type: verification
---

# Phase 1 Verification

## 자동 테스트

```powershell
npm --prefix frontend run build
Push-Location frontend
npx playwright test tests/e2e/auth-bootstrap.spec.ts --project="Desktop Chrome"
Pop-Location
```

## 필수 케이스

| ID | Given | When | Then |
|---|---|---|---|
| TC-028-1A | 오래된 `terminal_snapshot_*`가 있고 token 저장 첫 시도에 quota 발생 | bootstrap password 설정 | snapshot 정리 후 `cws_auth_token` 저장 성공 |
| TC-028-1B | 정리 가능한 snapshot이 없음 | token 저장이 계속 quota 실패 | `cws_auth_token`, `cws_auth_expires`가 남지 않음 |
| TC-028-1C | non-quota setItem 오류 | login 시도 | snapshot을 삭제하지 않고 오류를 전파 |

## 수동 확인

- DevTools Application 탭에서 `terminal_snapshot_*` 삭제 여부 확인
- Console에 quota cleanup warning이 남는지 확인
- `localStorage.getItem('cws_auth_token')`가 정상 저장되는지 확인

## 2026-04-29 실행 결과

- `npm --prefix frontend run build`: 통과
- `Push-Location frontend; npx playwright test tests/e2e/auth-bootstrap.spec.ts --project="Desktop Chrome"; Pop-Location`: 통과
- 추가된 `TC-2306`, `TC-2307`이 quota recovery와 partial auth state cleanup을 검증함
