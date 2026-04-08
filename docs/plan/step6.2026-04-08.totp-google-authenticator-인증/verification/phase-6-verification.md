# Phase 6 검증: TwoFactorForm UI

## 검증 체크리스트

- [ ] Frontend 빌드 성공
- [ ] `nextStage === 'email'` → 이메일 OTP 화면, 5분 카운트다운 타이머 표시
- [ ] `nextStage === 'totp'` → TOTP 화면, 카운트다운 타이머 없음
- [ ] TOTP 화면 안내 문구: "Enter the 6-digit code from your authenticator app."
- [ ] `emailFallback === true` → 경고 배너: "Email delivery failed. Please use your Authenticator app instead."
- [ ] COMBO-4 흐름: 이메일 화면 → TOTP 화면으로 자동 전환 확인 (페이지 새로고침 없음)
- [ ] 입력 placeholder "000000" 표시 확인
- [ ] **최종 E2E**: 브라우저에서 COMBO-3 완전 로그인 (QR 스캔 → 코드 입력 → 터미널 접속)
