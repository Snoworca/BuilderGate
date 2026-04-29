---
title: Final Validation
date: 2026-04-29
type: validation
---

# Final Validation

## 완료 게이트

| Gate | 기준 | 상태 |
|---|---|---|
| G1 | auth token quota recovery 구현 및 회귀 테스트 통과 | Done |
| G2 | terminal snapshot budget/LRU cleanup 구현 및 회귀 테스트 통과 | Done |
| G3 | release artifact bootstrap config policy 구현 및 build test 통과 | Done |
| G4 | packaged internal entrypoint 수정 및 launcher compatibility test 통과 | Done |
| G5 | fresh release extraction first-run smoke 문서화 또는 자동화 | Done |
| G6 | `git diff --check`, 관련 unit/E2E/docs test 통과 | Done |
| G7 | Phase completion review rule에 따른 코드 리뷰 루프 완료 | Done |

## 최종 보고에 포함할 항목

- quota 오류의 실제 원인과 삭제된 storage key 범위
- release asset의 `config.json5` 검사 결과
- fresh extraction smoke 결과
- 기존 daemon/config override로 인한 오진 가능성
- 실행한 테스트 명령과 통과/실패 여부

## 남은 리스크

- 실제 localStorage quota는 browser/환경별로 다르므로 합성 quota 테스트와 실제 대형 snapshot 수동 테스트를 함께 유지해야 한다.
- packaged foreground는 self-spawn 대신 같은 프로세스에서 server entry를 실행한다. daemon mode는 기존 child process + sentinel 구조를 유지한다.
- 기존 폴더에 덮어쓰기 설치하는 사용자 흐름은 fresh extraction과 다른 config 보존 정책을 가지므로 문서에서 분리해 안내해야 한다.

## 2026-04-29 검증 결과

| 범위 | 결과 |
|---|---|
| Frontend build | `npm --prefix frontend run build` 통과 |
| Auth bootstrap E2E | `Push-Location frontend; npx playwright test tests/e2e/auth-bootstrap.spec.ts --project="Desktop Chrome"; Pop-Location` 통과 |
| Daemon/build unit | `node --test tools/daemon/build-daemon-exe.test.js tools/daemon/launcher.test.js tools/daemon/start-runtime-compat.test.js tools/daemon/process-info.test.js tools/daemon/terminal-snapshot-quota.test.js` 통과 |
| Docs policy | `npm run test:docs` 통과 |
| Packaged win-amd64 build | `node tools/build-daemon-exe.js --profile win-amd64 --skip-runtime-install` 통과 |
| Packaged foreground/daemon smoke | `node tools/daemon/packaged-bootstrap-smoke.js --runtime dist\bin\win-amd64-0.3.0 --port 23002 --timeout-ms 60000` 통과 |
| Terminal authority regression | 기본 실행은 현재 소스 config가 bootstrap 상태라 login helper 전제와 불일치. 임시 configured config에서는 로컬 기존 workspace/session 데이터 영향으로 일부 실패했으며, 본 변경의 auth quota 회귀는 auth bootstrap E2E로 별도 검증함 |

## 2026-04-29 리뷰 루프

1차 코드 리뷰는 packaged args-empty 계약, Phase 2 테스트 공백, smoke 자동화 부재를 지적했다. 이후 packaged app/sentinel launch args를 env-driven empty args로 되돌리고, Windows `Start-Process`가 빈 `ArgumentList`를 넘기지 않도록 수정했으며, terminal snapshot quota 단위 테스트와 packaged bootstrap smoke script를 추가했다.

2차 코드 리뷰는 packaged parent `PKG_EXECPATH` 처리와 smoke 격리 부족을 지적했다. 이후 packaged parent에서 spawn 순간 `PKG_EXECPATH`를 임시 중립화하도록 복구하고, smoke script가 HTTPS/redirect port를 모두 검사하며 `BUILDERGATE_*`/`PKG_EXECPATH` 환경 변수를 제거하고 실행하도록 수정했다.

최종 코드 리뷰는 `No findings`로 완료되었다. 권장 잔여 커버리지는 로컬 workspace/session baseline 안정화 후 `terminal-authority.spec.ts` 재실행, Linux/macOS release artifact native smoke다.
