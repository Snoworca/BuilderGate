---
title: 전체 지원 대상 빌드 통합 테스트 가이드
date: 2026-04-28
type: integration-test-guide
---

# 전체 지원 대상 빌드 통합 테스트 가이드

## 기본 검증 순서

1. Build unit/docs 테스트를 먼저 실행한다.

```powershell
node --test tools/daemon/build-daemon-exe.test.js tools/daemon/docs.test.js
```

2. daemon 회귀 테스트를 실행한다.

```powershell
npm run test:daemon
npm run test:docs
```

3. 빠른 build smoke를 실행한다.

```powershell
node tools/build-daemon-exe.js --required-amd64 --skip-runtime-install
```

4. release 후보에서는 전체 build를 실행한다.

```powershell
npm run build
```

## 전체 build 산출물 확인

```powershell
Test-Path dist/bin/win-amd64/BuilderGate.exe
Test-Path dist/bin/win-amd64/BuilderGateStop.exe
Test-Path dist/bin/win-amd64/server/dist/public/index.html
Test-Path dist/bin/win-amd64/server/node_modules/.bin/node.exe
Test-Path dist/bin/win-amd64/BuilderGate.ico

Test-Path dist/bin/linux-amd64/buildergate
Test-Path dist/bin/linux-amd64/buildergate-stop
Test-Path dist/bin/linux-amd64/server/dist/public/index.html
Test-Path dist/bin/linux-amd64/server/node_modules/.bin/node
Test-Path dist/bin/linux-amd64/BuilderGate.svg

Test-Path dist/bin/win-arm64/BuilderGate.exe
Test-Path dist/bin/linux-arm64/buildergate
Test-Path dist/bin/macos-arm64/buildergate
Test-Path dist/bin/macos-arm64/buildergate-stop
Test-Path dist/bin/macos-arm64/BuilderGate.app/Contents/Info.plist
Test-Path dist/bin/macos-arm64/BuilderGate.app/Contents/Resources/BuilderGate.icns
Test-Path dist/bin/macos-arm64/BuilderGate.app/Contents/Resources/runtime/buildergate
```

## PM2 부재 확인

```powershell
if (Test-Path dist/bin/win-amd64/server/node_modules/pm2) { throw 'PM2 must not exist in win-amd64 runtime' }
if (Test-Path dist/bin/linux-amd64/server/node_modules/pm2) { throw 'PM2 must not exist in linux-amd64 runtime' }
if (Test-Path dist/bin/win-arm64/server/node_modules/pm2) { throw 'PM2 must not exist in win-arm64 runtime' }
if (Test-Path dist/bin/linux-arm64/server/node_modules/pm2) { throw 'PM2 must not exist in linux-arm64 runtime' }
if (Test-Path dist/bin/macos-arm64/server/node_modules/pm2) { throw 'PM2 must not exist in macos-arm64 runtime' }
```

## 실패 시 기록할 정보

- 실패 명령.
- 실패 target profile.
- 누락 artifact path.
- Node runtime 다운로드 실패 여부.
- pkg executable 생성 실패 여부.
- PM2 dependency 또는 forbidden README pattern 검출 여부.
