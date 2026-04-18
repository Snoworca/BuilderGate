# Completion Report

## 요약

Step22를 구현했다. 목표는 Windows 전용 PTY 기본값 때문에 macOS/Linux 부팅이 깨지는 문제를 막고, Settings에서 현재 OS와 맞지 않는 PTY 옵션이 저장 계약을 깨지 않도록 정렬하는 것이었다.

이번 구현은 다음 네 축으로 정리된다.

1. `config.json5`가 없을 때 OS-aware bootstrap
2. non-Windows stale Windows PTY 값의 로드 정규화
3. Settings capability, validation, persistence, UI 계약 정렬
4. 회귀 테스트와 문서 정렬

## 주요 변경

- `server/src/utils/ptyPlatformPolicy.ts`
  - PTY bootstrap/default/normalization 정책 helper 추가
- `server/src/utils/config.ts`
  - missing config bootstrap에 OS-aware PTY 기본값 적용
  - `loadConfigFromPath()` 추가
  - 실제 loader 경계에서 non-Windows normalization 적용
- `server/src/services/SessionManager.ts`
  - runtime PTY normalization seam 적용
  - non-Windows shell fallback hardening
- `server/src/services/ConfigFileRepository.ts`
  - changed-key 기반 partial persistence 도입
- `server/src/services/SettingsService.ts`
  - capability snapshot 기준 save validation 추가
  - runtime apply 시 PTY normalization 분리
  - detected shell 목록 기반 shell capability 노출
- `frontend/src/components/Settings/SettingsPage.tsx`
  - PTY patch를 changed-field 기준으로 축소
- `frontend/src/types/settings.ts`
  - shell type 계약 확장
- `server/config.json5.example`, `README.md`
  - cross-platform bootstrap 및 PTY 설명 정렬
- `server/src/test-runner.ts`
  - bootstrap, load normalization, host-probed shell capability, hidden PTY value preservation, winpty capability rejection 회귀 테스트 추가

## 검증 결과

- `server npm run test` 통과
  - `106 test(s) passed`
- `frontend npm run build` 통과

추가로 다음 경계를 실제 테스트로 덮었다.

- missing config bootstrap (`loadConfigFromPath`)
- non-Windows stale Windows PTY normalization
- non-Windows unrelated save 시 hidden Windows PTY 값 보존
- winpty probe failure 시 `windowsPowerShellBackend='winpty'` 조기 거절
- winpty probe failure 시 `useConpty=false` 조기 거절
- Settings shell options가 실제 detected shell 목록을 따르는지 검증

## 계획-구현 일치

- Phase 1: OS-aware bootstrap 완료
- Phase 2: runtime normalization / fallback hardening 완료
- Phase 3: settings capability/save/UI 정렬 완료
- Phase 4: 회귀 테스트 및 README 정렬 완료

## 남은 리스크

- 실제 macOS/Linux 실기기 수동 smoke validation은 이번 세션에서 수행하지 못했다.
- 그러나 loader/settings/session 경계는 platform-injected integration test로 보강했다.
