# Phase 4 Verification

## 목표

- 테스트, 문서, 운영 가이드가 최종 cross-platform PTY 정책과 일치하는지 검증한다.

## 확인 항목

- [x] server 회귀 테스트가 모두 통과한다
- [x] README PTY 설명이 example/bootstrap/runtime 정책과 일치한다
- [x] 수동 검증 가이드가 clean install과 stale config를 모두 다룬다

## 증거

- 테스트 로그:
  - `server npm run test` 통과, `106 test(s) passed`
  - `frontend npm run build` 통과
- 문서 diff:
  - README PTY 섹션에 OS별 bootstrap 기본값, `auto` shell 동작, `maxSnapshotBytes`/`scrollbackLines` 기준 반영
  - Step22 verification/final validation 문서 갱신
- 관련 파일:
  - `README.md`
  - `docs/plan/step22.../integration-test-guide.md`
  - `docs/plan/step22.../final-validation.md`
