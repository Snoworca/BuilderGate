# Phase 7 검증: Build Output과 PM2 Dependency 제거

## 검증 대상

- `FR-8-006`, `FR-8-013`, `FR-8-014`
- `AC-8-012`, `AC-8-013`
- `TEST-8-017`

## 필수 검증

- [ ] `npm run build:daemon-exe` 성공
- [ ] output은 `dist/bin`이며 `dist/daemon`이 기본값이 아님
- [ ] `BuilderGate.exe`, `BuilderGateStop.exe`, `server/`, `config.json5`, `config.json5.example`, `README.md` 존재
- [ ] `server/node_modules/.bin/node(.exe)` bundled Node 존재
- [ ] runtime dependency에 PM2 없음
- [ ] packaged sentinel self-reexec 코드 포함 smoke 통과
- [ ] source sentinel 실행 파일 누락 없음
- [ ] packaged config path는 EXE 옆 `config.json5`

## 검증 명령 후보

```powershell
npm run build:daemon-exe
Test-Path dist/bin/BuilderGate.exe
Test-Path dist/bin/BuilderGateStop.exe
if (Test-Path dist/bin/server/node_modules/pm2) { throw 'PM2 runtime dependency must not exist' }
```

## 완료 판정

빌드 산출물만으로 native daemon start/stop 준비가 가능하고 PM2 runtime dependency가 없어야 한다.
