---
title: 전체 지원 대상 빌드 최종 검증 템플릿
date: 2026-04-28
type: final-validation
---

# 전체 지원 대상 빌드 최종 검증 템플릿

## 스펙-계획 일치 게이트

| 요구사항 | 계획 반영 | 상태 |
|---|---|---|
| `FR-RUN-012` Windows/Linux amd64 필수, ARM64 추가 지원 | Phase 1, Phase 2 | PASS |
| `FR-RUN-013` `dist/bin` 호환 경로, `dist/bin/<target>` 대상별 구조, macOS ARM64 `.app` | Phase 1, Phase 2, Phase 3 | PASS |
| `AC-015` `npm run build` 전체 5개 대상, frontend asset, bundled Node, PM2 부재, icon artifact, macOS app bundle | Phase 1, Phase 2, Phase 3 | PASS |
| `AC-8-012A` 단일 기본 `dist/bin` 유지 | Phase 1, Phase 2 | PASS |
| `TEST-8-017` build output regression | Phase 2, Phase 3 | PASS |

## 최종 검증 명령 기록

| 명령 | 결과 | 비고 |
|---|---|---|
| `node --test tools/daemon/build-daemon-exe.test.js tools/daemon/docs.test.js` | PASS | 35/35 통과 |
| `npm run test:daemon` | PASS | 136/136 통과 |
| `npm run test:docs` | PASS | 3/3 통과 |
| `node tools/build-daemon-exe.js --required-amd64 --skip-runtime-install` | PASS | `win-amd64`, `linux-amd64` smoke build 통과 |
| `npm run build` | NOT RUN | 전체 5개 target 패키징은 release 준비 시 수행 |
| `git diff --check` | PASS | 공백 오류 없음. Git LF/CRLF 경고만 출력 |

## 산출물 체크리스트

- [x] `dist/bin/win-amd64` 존재 (`--required-amd64 --skip-runtime-install` smoke)
- [x] `dist/bin/linux-amd64` 존재 (`--required-amd64 --skip-runtime-install` smoke)
- [ ] `dist/bin/win-arm64` 존재 (전체 `npm run build` 미실행)
- [ ] `dist/bin/linux-arm64` 존재 (전체 `npm run build` 미실행)
- [ ] `dist/bin/macos-arm64` 존재 (전체 `npm run build` 미실행)
- [x] smoke 대상에 실행파일과 stop utility 존재
- [x] smoke 대상에 `server/dist/public/index.html` 존재
- [x] smoke 대상에 bundled Node runtime 존재
- [x] smoke 대상에 `config.json5`, `config.json5.example`, `README.md` 존재
- [x] Windows smoke target에 `BuilderGate.ico` 존재
- [x] Linux smoke target에 `BuilderGate.svg` 존재
- [ ] macOS ARM64 target에 `BuilderGate.icns`와 `BuilderGate.app` 존재 (전체 `npm run build` 미실행)
- [x] smoke target runtime에 PM2 dependency 없음

## 평가 결과

| 평가 관점 | CRITICAL | HIGH | MEDIUM | LOW | 상태 |
|---|---:|---:|---:|---:|---|
| 스펙 반영 | 0 | 0 | 0 | 0 | PASS |
| 계획 품질 | 0 | 0 | 0 | 0 | PASS |
| 코더 호환성 | 0 | 0 | 0 | 0 | PASS |

## 잔여 리스크

- 전체 `npm run build`는 5개 target의 Node runtime/pkg 다운로드와 packaging을 수행하므로 네트워크와 시간이 필요하다.
- Windows 호스트에서 macOS app bundle은 생성 가능하더라도 서명되지 않을 수 있으며, SRS의 macOS signing 안내를 README에 유지해야 한다.
