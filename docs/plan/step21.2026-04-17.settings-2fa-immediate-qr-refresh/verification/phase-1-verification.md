# Phase 1 Verification

- [ ] `SettingsServiceDeps`에 TOTP runtime callback이 추가되었다
- [ ] `twoFactor.enabled`, `issuer`, `accountName`, `externalOnly` 변경 시 changed key가 정확히 집계된다
- [ ] save 성공 경로에서 TOTP runtime apply가 호출된다
- [ ] rollback 경로에서 이전 config 기준 TOTP runtime 복원이 호출된다
- [ ] enable 시 `totpService`가 생성 또는 재생성된다
- [ ] disable 시 `totpService`가 제거된다
- [ ] 초기화 실패가 warning으로 반환되고 save hard-fail로 바뀌지 않는다
- [ ] `authRoutes`가 최신 accessor 인스턴스를 계속 사용한다

