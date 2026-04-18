# Phase 3 Verification

## 목표

- Settings capability/UI/save validation 계약이 현재 OS 기준으로 일치하는지 검증한다.

## 확인 항목

- [x] non-Windows Settings에서 Windows 전용 PTY 필드가 숨겨진다
- [x] 숨겨진/stale 값 때문에 unrelated save가 실패하지 않는다
- [x] capability 옵션과 backend validation allowed values가 일치한다

## 증거

- API snapshot 예시:
  - `SettingsService shell options follow detected host capabilities`
  - shell capability는 `sessionManager.getAvailableShells()` 결과를 사용
- UI 캡처 또는 테스트 로그:
  - `frontend npm run build` 통과
  - `SettingsService rejects winpty saves immediately after capability probe failure`
  - `SettingsService rejects useConpty=false saves immediately when winpty is unavailable`
  - `SettingsService preserves hidden Windows PTY values on non-Windows unrelated saves`
- 관련 파일:
  - `server/src/services/SettingsService.ts`
  - `server/src/services/ConfigFileRepository.ts`
  - `frontend/src/components/Settings/SettingsPage.tsx`
  - `frontend/src/types/settings.ts`
