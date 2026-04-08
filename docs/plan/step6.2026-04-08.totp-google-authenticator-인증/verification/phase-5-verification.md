# Phase 5 검증: Frontend AuthContext

## 검증 체크리스트

- [ ] TypeScript 빌드 성공 (타입 에러 0개)
- [ ] `AuthState.nextStage` 필드 존재 확인
- [ ] `AuthState.emailFallback` 필드 존재 확인
- [ ] 초기 상태 `nextStage: null`, `emailFallback: false` 확인
- [ ] COMBO-3 로그인 후 `state.nextStage === 'totp'` (React DevTools)
- [ ] COMBO-4 이메일 OTP 통과 후 `state.nextStage === 'totp'`, `state.maskedEmail === null`
- [ ] COMBO-4 TOTP 통과 후 `state.nextStage === null`, `state.isAuthenticated === true`
- [ ] `emailFallback: true` 응답 수신 후 `state.emailFallback === true`
- [ ] `authApi.verify(tempToken, code, 'totp')` 호출 시 요청 body에 `stage: 'totp'` 포함 확인
