---
title: Phase 3 검증 계획
date: 2026-04-28
type: verification
phase: 3
---

# Phase 3 검증 계획

## 검증 명령

```powershell
npm run test:docs
node --test tools/daemon/build-daemon-exe.test.js tools/daemon/docs.test.js
git diff --check
```

## 선택 빌드 검증

```powershell
node tools/build-daemon-exe.js --required-amd64 --skip-runtime-install
npm run build
```

`npm run build`는 5개 대상 전체 패키징이므로 다운로드와 실행 시간이 길 수 있다. 실행하지 못하면 사유와 대체 검증을 기록한다.

## 확인 항목

- [x] README가 `npm run build` 전체 5개 대상 생성을 설명한다.
- [x] README가 macOS ARM64-only와 `BuilderGate.app`을 설명한다.
- [x] packaged README 후보가 5개 target 구조를 반영한다.
- [x] PM2 production guidance가 문서에 남아 있지 않다.

## 실행 결과

- `npm run test:docs`: PASS, 3/3 통과
- `node --test tools/daemon/build-daemon-exe.test.js tools/daemon/docs.test.js`: PASS, 35/35 통과
- `npm run test:daemon`: PASS, 136/136 통과
- `node tools/build-daemon-exe.js --required-amd64 --skip-runtime-install`: PASS, `dist/bin/win-amd64`, `dist/bin/linux-amd64` 생성
- `git diff --check`: PASS, 공백 오류 없음. Git LF/CRLF 경고만 출력
- `npm run build`: 미실행. 전체 5개 target 패키징은 release 준비 시 수행
- Phase 3 코드/문서 리뷰: `No findings`

## 통과 기준

- docs test 통과.
- diff whitespace check 통과.
- 가능한 경우 build smoke 또는 전체 build 통과.
