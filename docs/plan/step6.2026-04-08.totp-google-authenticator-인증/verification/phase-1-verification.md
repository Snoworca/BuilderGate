# Phase 1 검증: 기반 스키마/타입

## 검증 체크리스트

- [ ] `npm run build` (server) 성공
- [ ] `twoFactor.enabled=true, totp.enabled=true, smtp 없음` → Zod 파싱 성공
- [ ] `twoFactor.enabled=true, smtp 없음, totp 없음` → Zod 파싱 실패 (올바른 에러 메시지)
- [ ] `TOTPConfig` 타입 TypeScript 빌드 통과
- [ ] `TwoFAStage` 타입 `'email' | 'totp'` 정의 확인
- [ ] `OTPData.stage: TwoFAStage` 필드 확인
- [ ] `LoginResponse.nextStage?: TwoFAStage` 필드 확인
- [ ] `config.json5`에 `localhostPasswordOnly: false` 추가 확인
- [ ] `config.json5`에 `twoFactor.totp.enabled: false` 추가 확인
- [ ] `.gitignore`에 `data/totp.secret` 추가 확인
- [ ] `node_modules/otplib` 설치 확인
- [ ] `node_modules/qrcode-terminal` 설치 확인
