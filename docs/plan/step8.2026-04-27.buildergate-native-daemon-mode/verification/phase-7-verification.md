# Phase 7 검증: Build Output과 PM2 Dependency 제거

## 검증 대상

- `FR-8-006`, `FR-8-013`, `FR-8-014`
- `AC-8-012`, `AC-8-013`
- `TEST-8-017`

## 필수 검증

- [x] `npm run build:daemon-exe` 성공
- [x] output은 `dist/bin`이며 `dist/daemon`이 기본값이 아님
- [x] `BuilderGate.exe`, `BuilderGateStop.exe`, `server/`, `config.json5`, `config.json5.example`, `README.md` 존재
- [x] `server/node_modules/.bin/node(.exe)` bundled Node 존재
- [x] runtime dependency에 PM2 없음
- [x] packaged sentinel self-reexec 코드 포함 smoke 통과
- [x] source sentinel 실행 파일 누락 없음
- [x] packaged config path는 EXE 옆 `config.json5`
- [x] clean checkout build에서 `server/config.json5`가 없어도 OS-aware bootstrap `config.json5` 생성 경로 검증
- [x] packaged README에 PM2 문서 패턴 없음

## 검증 명령 후보

```powershell
npm run build:daemon-exe
Test-Path dist/bin/BuilderGate.exe
Test-Path dist/bin/BuilderGateStop.exe
if (Test-Path dist/bin/server/node_modules/pm2) { throw 'PM2 runtime dependency must not exist' }
```

## 실행 결과

| 검증 | 결과 |
| --- | --- |
| `node --test tools/daemon/build-daemon-exe.test.js` | PASS, 10 tests |
| `npm run test:daemon` | PASS, 105 tests |
| `npm run build:daemon-exe` | PASS |
| `dist/bin` artifact + PM2 부재 + `dist/daemon` 미생성 PowerShell check | PASS |
| `README.md`, `dist/bin/README.md` PM2 forbidden grep | PASS |
| `validateSourceDaemonInputs()`, `validateBuildOutput(dist/bin)`, packaged config path smoke | PASS |
| `loadBootstrapConfigTemplate()` Windows/Linux bootstrap defaults smoke | PASS |
| `npm --prefix server test` | PASS, 161 tests |
| 코드 리뷰어 재검토 | PASS, `No findings` |

## 완료 판정

빌드 산출물만으로 native daemon start/stop 준비가 가능하고 PM2 runtime dependency가 없어야 한다.
