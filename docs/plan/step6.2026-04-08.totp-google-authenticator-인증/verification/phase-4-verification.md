# Phase 4 검증: authRoutes 플로우

## 검증 체크리스트

### COMBO-3 (TOTP 전용)
- [ ] POST /login → 202, `nextStage: 'totp'`, `maskedEmail` 없음
- [ ] POST /verify `{stage: 'totp', otpCode: <유효코드>}` → 200, `token` 포함
- [ ] POST /verify `{stage: 'totp', otpCode: <만료코드>}` → 401, `attemptsRemaining: 2`
- [ ] POST /verify 3회 실패 → tempToken 폐기, 재시도 불가

### COMBO-4 (이메일 + TOTP)
- [ ] POST /login → 202, `nextStage: 'email'`, `maskedEmail` 포함
- [ ] POST /verify `{stage: 'email', otpCode: <이메일OTP>}` → 202, `nextStage: 'totp'`, `token` 없음
- [ ] POST /verify `{stage: 'totp', otpCode: <TOTP>}` → 200, `token` 포함
- [ ] 이메일 OTP 통과 후 `stage: 'email'` 재요청 → 400, "Unexpected verification stage"

### FR-401: TOTP 미등록 차단
- [ ] totp.enabled=true, data/totp.secret 없음 → 503, 적절한 메시지

### FR-602: localhostPasswordOnly
- [ ] auth.localhostPasswordOnly=true, localhost 접속 → 200, 즉시 JWT (2FA 없음)
- [ ] auth.localhostPasswordOnly=true, 외부 IP 접속 → 202, 2FA 진행

### FR-501: 이메일 폴백
- [ ] SMTP 실패 시 → 202, `nextStage: 'totp'`, `emailFallback: true`

### 회귀 테스트
- [ ] COMBO-1 (2FA 없음) 정상 작동
- [ ] COMBO-2 (이메일 OTP) 정상 작동 (stage 없이 요청 시 하위 호환)
