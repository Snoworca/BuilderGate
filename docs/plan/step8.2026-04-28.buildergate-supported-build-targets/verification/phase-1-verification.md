---
title: Phase 1 검증 계획
date: 2026-04-28
type: verification
phase: 1
---

# Phase 1 검증 계획

## 검증 명령

```powershell
node --test tools/daemon/build-daemon-exe.test.js
```

## 확인 항목

- [x] `--all-supported`가 5개 target을 반환한다.
- [x] `--required-amd64`가 `win-amd64`, `linux-amd64`만 반환한다.
- [x] `parseArgs([])`와 `build:daemon-exe` 단일 기본 output 계약이 유지된다.
- [x] `package.json` scripts가 새 표준 script와 호환 alias를 모두 제공한다.

## 실행 결과

- `node --test tools/daemon/build-daemon-exe.test.js`: PASS, 21/21 통과
- Phase 1 코드 리뷰: `No findings`

## 통과 기준

- 관련 node:test 전체 통과.
- SRS의 `FR-RUN-012`, `FR-RUN-013`, `AC-015`에 대한 target/script 매핑 누락 없음.
