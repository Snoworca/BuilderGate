# Phase 1 Verification

## 목표

- missing `config.json5` 환경에서 OS별 bootstrap 결과가 의도대로 생성되는지 검증한다.

## 확인 항목

- [x] Windows bootstrap 기본값이 문서와 일치한다
- [x] non-Windows bootstrap 기본값이 문서와 일치한다
- [x] example config와 README 예시가 bootstrap 계약과 모순되지 않는다

## 증거

- 테스트 로그:
  - `server npm run test` 통과
  - `Config bootstrap applies OS-aware PTY defaults when creating config text`
  - `Config loader bootstraps missing config files with platform-aware PTY defaults`
- 생성된 config 샘플:
  - Windows bootstrap: `useConpty: true`, `windowsPowerShellBackend: "inherit"`
  - non-Windows bootstrap: `useConpty: false`, `windowsPowerShellBackend: "inherit"`
- 관련 파일:
  - `server/src/utils/config.ts`
  - `server/src/utils/ptyPlatformPolicy.ts`
  - `server/config.json5.example`
  - `README.md`
