# BuilderGate 네이티브 기본 데몬 모드 최종 검증 템플릿

## Traceability Gate

| 항목 | 목표 | 결과 |
| --- | --- | --- |
| FR-8-001부터 FR-8-017 | 100% Phase 매핑 | PASS |
| AC-8-001부터 AC-8-020 | 100% test/scenario 매핑 | PASS |
| TEST-8-001부터 TEST-8-023 | 100% 실행 또는 명시적 사유 기록 | PASS |
| NFR-8-001부터 NFR-8-012 | 100% architecture/phase 반영 | PASS |
| IR-8-001부터 IR-8-003 | 100% command/API response contract 반영 | PASS |
| DR-8-001부터 DR-8-003 | 100% data/env contract 반영 | PASS |
| CON-8-001부터 CON-8-009 | 100% 제약 반영 | PASS |

## Quality Gate

| 게이트 | 목표 | 결과 |
| --- | --- | --- |
| Unit tests | 관련 테스트 100% 통과 | PASS, `npm run test:daemon` 116 tests, `npm --prefix server test` 162 tests |
| Integration tests | daemon/foreground/stop/readiness/TOTP/sentinel 통과 | PASS, `npm run test:integration:native-daemon` 4 tests 및 source/package smoke |
| Build tests | `dist/bin` output, PM2 absence, bundled Node 통과 | PASS, `npm run build:daemon-exe`, artifact check |
| Docs tests | required keywords 포함, PM2 forbidden pattern 0개 | PASS, `npm run test:docs` 3 tests |
| Review loop | 각 Phase 코드 리뷰 `No findings` | PASS, Phase 1-8 모두 `No findings` |

## Final Manual Validation

```powershell
curl -k https://localhost:2002/health
node tools/start-runtime.js -p 24565
curl -k https://localhost:24565/health
node stop.js
npm run build:daemon-exe
dist\bin\BuilderGate.exe -p 24566
curl -k https://localhost:24566/health
dist\bin\BuilderGateStop.exe
```

`https://localhost:2002`는 기존 개발 서버가 점유 중이라 health 200만 확인했다. 실제 source/package native daemon start-stop smoke는 기존 프로세스를 보존하기 위해 `24565`, `24566`에서 수행했다.

## 실행 결과

| 검증 | 결과 |
| --- | --- |
| source daemon start/health/stop | PASS, `24565` |
| packaged daemon start/health/stop | PASS, `24566` |
| source foreground contract | PASS, `npm run test:integration:native-daemon` 4 tests, PTY Ctrl+C foreground flush integration 포함 |
| stop utility contract | PASS, `node stop.js`, `BuilderGateStop.exe`, integration tests |
| TOTP daemon QR preflight | PASS, daemon tests 및 server TOTP regression |
| Web Crypto fallback | PASS, `TOTPService.initialize()` regression |
| sentinel watchdog/runtime | PASS, daemon tests 및 packaged sentinel entry smoke |
| foreground signal forwarding | PASS, `SIGINT`/`SIGTERM` parent-to-child forwarding regression, PTY Ctrl+C foreground flush integration |
| cross-OS/cross-arch target guard | PASS, host OS/CPU와 다른 `--target` 명시 거부 |
| docs policy | PASS, root/dist README required/forbidden policy |
| PM2 제거 | PASS, dependency/build/docs/runtime absence checks |

## 완료 조건

- [x] 기본 실행이 daemon이다.
- [x] `--foreground`와 `--forground`만 foreground다.
- [x] PM2 호출/설치/dependency/docs 안내가 없다.
- [x] TOTP daemon QR은 parent detach 전에 출력되고 child duplicate QR은 없다.
- [x] native stop은 foreground를 종료하지 않고 valid daemon만 graceful shutdown한다.
- [x] strict config failure가 default fallback으로 숨겨지지 않는다.
- [x] `dist/bin` 산출물과 EXE 옆 config 정책이 유지된다.
- [x] orphan app/sentinel process가 없다.
