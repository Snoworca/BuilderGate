---
title: Integration Test Guide
date: 2026-04-29
type: test-guide
---

# Integration Test Guide

## 공통 규칙

- 수동 검증과 Playwright E2E는 `https://localhost:2002`를 대상으로 한다.
- `http://localhost:2001`은 redirect server, `http://localhost:2003`은 Vite dev server이므로 앱 검증 target으로 쓰지 않는다.
- 테스트 전 `BUILDERGATE_CONFIG_PATH`가 기존 config를 가리키지 않는지 확인한다.

## 권장 명령

```powershell
git diff --check
npm --prefix frontend run build
Push-Location frontend
npx playwright test tests/e2e/auth-bootstrap.spec.ts --project="Desktop Chrome"
npx playwright test tests/e2e/terminal-authority.spec.ts --project="Desktop Chrome"
Pop-Location
node --test tools/daemon/build-daemon-exe.test.js tools/daemon/launcher.test.js tools/daemon/start-runtime-compat.test.js
npm run test:docs
```

## Auth quota recovery 수동 확인

1. `https://localhost:2002`에 접속한다.
2. DevTools console에서 대형 `terminal_snapshot_old_*` 값을 여러 개 만든다.
3. 로그인 또는 bootstrap password 설정을 수행한다.
4. `localStorage.getItem('cws_auth_token')`가 존재하는지 확인한다.
5. 오래된 `terminal_snapshot_*`가 정리되었는지 확인한다.

## Release first-run smoke

빌드된 또는 GitHub Release에서 압축 해제한 runtime 디렉터리는 다음 스크립트로 foreground와 daemon first-run bootstrap을 함께 검증할 수 있다.

```powershell
node tools/daemon/packaged-bootstrap-smoke.js --runtime dist\bin\win-amd64-0.3.0 --port 23002 --timeout-ms 60000
```

```powershell
$dir = Join-Path $env:TEMP ("buildergate-release-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $dir | Out-Null
gh release download v0.3.0 --repo Snoworca/BuilderGate --pattern BuilderGate-win-amd64-0.3.0.zip --dir $dir
Expand-Archive -Path (Join-Path $dir "BuilderGate-win-amd64-0.3.0.zip") -DestinationPath $dir
Get-Content -Path (Join-Path $dir "BuilderGate-win-amd64-0.3.0\config.json5") -Encoding UTF8
```

실행 전 확인:

```powershell
Get-NetTCPConnection -LocalPort 2001,2002,23001,23002 -ErrorAction SilentlyContinue
$env:BUILDERGATE_CONFIG_PATH
```

기대 상태:

- port 2001/2002에 기존 listener 없음
- smoke 전용 port 23001/23002에 기존 listener 없음
- `BUILDERGATE_CONFIG_PATH` 비어 있음
- release config의 `auth.password: ""`

서버 실행 후:

```powershell
curl.exe -k https://localhost:2002/api/auth/bootstrap-status
```

기대 응답:

```json
{
  "setupRequired": true,
  "requesterAllowed": true
}
```

## 실패 분류

| 증상 | 우선 의심 |
|---|---|
| release config에 non-empty password | Phase 3 build config policy 문제 |
| `Cannot find module '--internal-app'` | Phase 4 packaged internal entrypoint 문제 |
| `/bootstrap-status`가 setupRequired false | 기존 config 사용, stale daemon, env override |
| `cws_auth_token` quota 오류 | Phase 1/2 storage cleanup 문제 |
