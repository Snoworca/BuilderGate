---
title: Phase 2 검증 계획
date: 2026-04-28
type: verification
phase: 2
---

# Phase 2 검증 계획

## 검증 명령

```powershell
node --test tools/daemon/build-daemon-exe.test.js
```

## 확인 항목

- [x] Windows output fixture 정상/누락 케이스 통과.
- [x] Linux output fixture는 SVG만 필수 icon으로 통과.
- [x] macOS output fixture는 `BuilderGate.icns`와 `BuilderGate.app` bundle을 필수 검증.
- [x] `server/dist/public/index.html` 누락 시 실패.
- [x] PM2 runtime dependency 존재 시 실패.
- [x] amd64 target의 npm dependency install이 `--cpu x64`를 사용.

## 실행 결과

- `node --test tools/daemon/build-daemon-exe.test.js`: PASS, 32/32 통과
- 1차 Phase 2 코드 리뷰: Medium 1건, Low 1건 발견
- 수정 후 재실행: `node --test tools/daemon/build-daemon-exe.test.js`: PASS, 32/32 통과
- Phase 2 재리뷰: `No findings`

## 통과 기준

- 관련 node:test 전체 통과.
- `TEST-8-017`의 build output validation 조건이 fixture 수준에서 보호됨.
