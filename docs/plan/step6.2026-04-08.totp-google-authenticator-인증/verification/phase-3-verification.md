# Phase 3 검증: 서버 통합

## 검증 체크리스트

- [ ] `services/index.ts`에 `TOTPService` export 추가 확인
- [ ] `index.ts`에 `totpService` 변수 선언 확인
- [ ] `twoFactor.totp.enabled = true` 설정 → 서버 기동 시 TOTPService 초기화 로그 확인
- [ ] `twoFactor.totp.enabled = false` 설정 → "TOTP is disabled" 로그 확인
- [ ] 배너에 "2FA: Enabled (TOTP only)" 출력 확인 (TOTP-only 설정 시)
- [ ] 배너에 "2FA: Enabled (Email OTP + TOTP)" 출력 확인 (COMBO-4 설정 시)
- [ ] `AuthRouteAccessors`에 `getTOTPService` 추가 확인
- [ ] **회귀**: 기존 이메일 OTP 로그인 (COMBO-2) 정상 작동 확인
- [ ] **회귀**: `twoFactor.enabled = false` 설정으로 COMBO-1 정상 작동 확인
