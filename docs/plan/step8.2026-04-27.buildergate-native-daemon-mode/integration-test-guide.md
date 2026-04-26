# BuilderGate 네이티브 기본 데몬 모드 통합 테스트 가이드

## 공통 전제

- 수동 검증과 Playwright E2E 대상은 `https://localhost:2002`다.
- health check는 `curl -k https://localhost:2002/health`를 사용한다.
- local test password는 `1234`다.
- 테스트 후 native stop 또는 안전한 cleanup으로 app/sentinel orphan process가 없어야 한다.

## 권장 실행 순서

1. `Push-Location server; npm test; Pop-Location`
2. `node tools/start-runtime.js -p 2002`
3. `curl -k https://localhost:2002/health`
4. 같은 옵션으로 `node tools/start-runtime.js -p 2002` 재실행 후 idempotent success 확인
5. 다른 port/config로 start해 conflict rejection 확인
6. `node stop.js` 후 `/health` 비응답 확인
7. `node tools/start-runtime.js --foreground -p 2002`로 foreground 확인
8. foreground 실행 중 `node stop.js`가 foreground를 종료하지 않는지 확인
9. TOTP enabled config로 daemon QR preflight와 suppress 확인
10. invalid config/corrupted secret으로 fatal state와 orphan 0개 확인
11. `npm run build:daemon-exe`
12. `dist/bin` output과 PM2 absence 확인
13. README/root와 dist README docs test 실행

## 핵심 Smoke

```powershell
node tools/start-runtime.js -p 2002
curl -k https://localhost:2002/health
node stop.js
```

## Build Smoke

```powershell
npm run build:daemon-exe
Test-Path dist/bin/BuilderGate.exe
Test-Path dist/bin/BuilderGateStop.exe
Test-Path dist/bin/server/dist/index.js
Test-Path dist/bin/config.json5
Test-Path dist/bin/config.json5.example
Test-Path dist/bin/server/node_modules/.bin/node.exe
```

## Docs Smoke

```powershell
rg -n "--foreground|--forground|BuilderGateStop|config\\.json5|QR|dist/bin|native daemon|네이티브 데몬" README.md dist/bin/README.md
if (rg -n "pm2|PM2|pm2 start|pm2 stop|pm2 delete|npm install -g pm2" README.md dist/bin/README.md) { throw 'PM2 production documentation pattern must not remain' }
```

첫 번째 명령은 필수 키워드를 찾아야 하고, 두 번째 명령은 production 문서에서 결과가 없어야 한다.

## 실패 시 기록

- 실행 명령
- exit code
- `runtime/buildergate.daemon.json`의 masked summary
- `runtime/*.log`의 secret-masked excerpt
- orphan app/sentinel PID 유무
- `/health` 응답 또는 비응답 결과
