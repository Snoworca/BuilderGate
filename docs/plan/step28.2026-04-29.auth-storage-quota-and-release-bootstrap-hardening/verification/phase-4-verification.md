---
title: Phase 4 Verification
date: 2026-04-29
type: verification
---

# Phase 4 Verification

## 자동 테스트

```powershell
node --test tools/daemon/launcher.test.js tools/daemon/start-runtime-compat.test.js
node --test tools/daemon/process-info.test.js tools/daemon/native-daemon.integration.test.js
```

## Packaged smoke

```powershell
node tools/build-daemon-exe.js --profile win-amd64 --skip-runtime-install
node tools/daemon/packaged-bootstrap-smoke.js --runtime dist\bin\win-amd64-0.3.0 --port 23002 --timeout-ms 60000
```

실제 release smoke는 [integration-test-guide.md](../integration-test-guide.md)의 fresh extraction 절차를 따른다.

## 필수 케이스

| ID | Given | When | Then |
|---|---|---|
| TC-028-4A | packaged foreground launch | child env 생성 | `BUILDERGATE_INTERNAL_MODE=app` |
| TC-028-4B | packaged app launch | command args 생성 | `--internal-app`를 module arg로 전달하지 않음 |
| TC-028-4C | packaged sentinel launch | child env 생성 | `BUILDERGATE_INTERNAL_MODE=sentinel` |
| TC-028-4D | fresh release extraction | `/api/auth/bootstrap-status` 호출 | `setupRequired: true`, localhost `requesterAllowed: true` |
| TC-028-4E | 기존 2001/2002 listener 존재 | smoke 시작 | stale process를 명확히 보고하고 중단 |

## 2026-04-29 실행 결과

- `node --test tools/daemon/launcher.test.js tools/daemon/start-runtime-compat.test.js tools/daemon/process-info.test.js`: 통합 daemon test bundle 안에서 통과
- `node tools/daemon/packaged-bootstrap-smoke.js --runtime dist\bin\win-amd64-0.3.0 --port 23002 --timeout-ms 60000`: 통과
- smoke script는 `23002`와 redirect port `23001`을 사전 검사하고, `BUILDERGATE_*`/`PKG_EXECPATH` 환경 오염을 제거한 상태로 실행함
- packaged foreground는 self-spawn하지 않고 current process에서 `runInternalApp()`로 진입하도록 수정
- packaged daemon app/sentinel은 `--internal-app`/`--internal-sentinel` args 없이 `BUILDERGATE_INTERNAL_MODE=app|sentinel` env로 진입함
- foreground와 daemon mode 모두 `/api/auth/bootstrap-status`가 `setupRequired: true`, `requesterAllowed: true` 반환
