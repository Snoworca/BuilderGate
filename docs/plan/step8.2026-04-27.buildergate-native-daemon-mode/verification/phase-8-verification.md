# Phase 8 검증: 문서와 최종 회귀

## 검증 대상

- `FR-8-016`
- `AC-8-015`
- `TEST-8-018`
- `TEST-8-001`부터 `TEST-8-023` 전체 최종 회귀

## 필수 검증

- [x] root README와 `dist/bin/README.md`에 `--foreground`, `--forground`, `BuilderGateStop`, `config.json5`, `QR`, `dist/bin`, `native daemon` 또는 `네이티브 데몬` 포함
- [x] production 실행 문서에 `pm2`, `PM2`, `pm2 start`, `pm2 stop`, `pm2 delete`, `npm install -g pm2` 금지 패턴 없음
- [x] source production 기본 daemon과 foreground 사용법 문서화
- [x] packaged 기본 daemon과 stop utility 사용법 문서화
- [x] TOTP daemon QR preflight 문서화
- [x] 최종 smoke와 회귀 테스트 결과 기록

## 실행 결과

| 명령/검증 | 결과 |
| --- | --- |
| `npm run test:docs` | PASS, 3 tests |
| `npm run test:integration:native-daemon` | PASS, 4 tests |
| `npm run test:daemon` | PASS, 116 tests |
| `npm --prefix server test` | PASS, 162 tests |
| `npm run build:daemon-exe` | PASS |
| `node --test tools/daemon/process-info.test.js tools/daemon/stop-client.test.js` | PASS |
| `node --test tools/daemon/launcher.test.js tools/daemon/start-runtime-compat.test.js` | PASS |
| `node --test tools/daemon/launcher.test.js tools/daemon/runtime-paths.test.js tools/daemon/build-daemon-exe.test.js` | PASS |
| `curl -k https://localhost:2002/health` | PASS, 기존 `tsx src/index.ts` 개발 서버가 200 응답 |
| source daemon smoke | PASS, `node tools/start-runtime.js -p 24565` 후 health 200, `node stop.js` graceful stop |
| packaged daemon smoke | PASS, `dist\bin\BuilderGate.exe -p 24566` 후 health 200, `dist\bin\BuilderGateStop.exe` graceful stop |
| `validateBuildOutput(dist/bin)` | PASS |
| artifact check | PASS, `BuilderGate.exe`, `BuilderGateStop.exe`, `server/dist/index.js`, bundled Node, `config.json5`, `config.json5.example`, `README.md`, 모든 daemon runtime 파일 존재 |
| PM2/build path absence | PASS, `dist/bin/server/node_modules/pm2` 없음, `dist/daemon` 없음 |
| orphan process check | PASS, ProjectMaster native daemon smoke process 0개 |
| foreground signal forwarding | PASS, parent `SIGTERM` 전달 회귀 테스트와 PTY Ctrl+C foreground flush 통합 테스트 추가 |
| cross-OS/cross-arch target guard | PASS, host OS/CPU와 다른 `--target` 명시 거부 회귀 테스트 추가 |

## 포트 검증 메모

프로젝트 규칙상 수동 검증 대상은 `https://localhost:2002`다. 작업 시점에 해당 포트는 기존 개발 서버가 점유 중이었고 health check가 200으로 통과했으므로 사용자 프로세스를 종료하지 않았다. 실제 native daemon source/package start-stop smoke는 포트 충돌과 사용자 작업 영향 방지를 위해 각각 `24565`, `24566`에서 수행했다.

## 완료 판정

사용자가 README만 보고 build/run/foreground/stop/config/QR 정책을 이해할 수 있고, SRS traceability가 100%여야 한다.

판정: PASS. 코드 리뷰 서브에이전트 최종 판정은 `No findings.`다.
