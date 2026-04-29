---
title: Phase 2 Verification
date: 2026-04-29
type: verification
---

# Phase 2 Verification

## 자동 테스트

```powershell
Push-Location frontend
npx playwright test tests/e2e/terminal-authority.spec.ts --project="Desktop Chrome"
Pop-Location
```

필요 시 신규 파일:

```powershell
Push-Location frontend
npx playwright test tests/e2e/local-storage-quota.spec.ts --project="Desktop Chrome"
Pop-Location
```

## 필수 케이스

| ID | Given | When | Then |
|---|---|---|---|
| TC-028-2A | 여러 session의 오래된 snapshot이 aggregate budget 초과 | 새 snapshot 저장 | 오래된 snapshot부터 삭제 |
| TC-028-2B | 현재 session snapshot과 다른 session snapshot이 공존 | quota cleanup | 현재 session이 우선 보존 |
| TC-028-2C | 손상된 JSON snapshot 존재 | cleanup 실행 | 손상 snapshot 삭제 |
| TC-028-2D | snapshot save 첫 시도 quota | retry 실행 | 정리 후 1회 재시도 성공 |

## 수동 확인

- 여러 터미널 탭을 열고 큰 출력 후 새로고침한다.
- 오래된 snapshot이 정리되어도 현재 terminal 동작과 server replay가 유지되는지 확인한다.

## 2026-04-29 실행 결과

- `npm --prefix frontend run build`: 통과
- `node --test tools/daemon/terminal-snapshot-quota.test.js`: 통과
- `TC-2306`에서 오래된 `terminal_snapshot_*`가 auth quota recovery 중 LRU 기준으로 정리되는 것을 검증함
- `terminal-snapshot-quota.test.js`에서 aggregate budget LRU, current session 보존, corrupt snapshot 제거, quota retry를 직접 검증함
- `terminal-authority.spec.ts`는 현재 로컬 source config/data fixture가 테스트 전제와 맞지 않아 최종 통과 대상으로 사용하지 않음
