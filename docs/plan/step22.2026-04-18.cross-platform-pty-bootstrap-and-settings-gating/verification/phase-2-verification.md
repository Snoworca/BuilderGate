# Phase 2 Verification

## 목표

- stale Windows PTY 값이 non-Windows runtime load를 깨지 않도록 정규화되는지 검증한다.

## 확인 항목

- [x] non-Windows에서 `useConpty=true` stale config가 부팅을 깨지 않는다
- [x] non-Windows에서 `windowsPowerShellBackend` override가 `'inherit'`로 정규화된다
- [x] non-Windows에서 Windows 전용 shell 값이 안전한 fallback으로 바뀐다
- [x] Windows 기존 ConPTY 선호 동작은 유지된다

## 증거

- 테스트 로그:
  - `Config loader normalizes stale Windows PTY fields on non-Windows hosts`
  - `SessionManager.createSession normalizes Windows-only shells on non-Windows hosts`
  - `SessionManager non-Windows runtime validation matches the settings contract`
- normalized config snapshot:
  - non-Windows load 결과: `useConpty=false`, `windowsPowerShellBackend='inherit'`, `shell='auto'`
  - auto fallback: bash가 없으면 `sh`
- 관련 파일:
  - `server/src/utils/config.ts`
  - `server/src/utils/ptyPlatformPolicy.ts`
  - `server/src/services/SessionManager.ts`
