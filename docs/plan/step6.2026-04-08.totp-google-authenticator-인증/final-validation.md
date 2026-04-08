# 최종 검증 보고서 템플릿

## SRS 인수 조건 체크리스트

### FR-1xx: TOTPService 초기화
- [ ] AC-101: TOTP secret 자동 생성 및 QR 출력 (data/totp.secret 없을 때)
- [ ] AC-102: 기존 secret 재사용 (서버 재시작 후 동일 QR)
- [ ] AC-103: TOTP 미등록 경고 로그 출력

### FR-2xx: 파일 관리
- [ ] AC-201: secret 복호화 실패 시 서버 시작 중단
- [ ] AC-202: secret 파일 권한 0o600 설정 (Linux)

### FR-3xx: 인증 플로우
- [ ] AC-COMBO-1: 2FA 없이 비밀번호만으로 로그인 (200 + token)
- [ ] AC-COMBO-2: 이메일 OTP 플로우 (nextStage: 'email' 포함)
- [ ] AC-COMBO-3: TOTP 전용 플로우 (nextStage: 'totp')
- [ ] AC-COMBO-4: 이메일 OTP + TOTP 순차 플로우 (202 중간 단계)

### FR-4xx: TOTP 미등록 차단
- [ ] AC-401: TOTP 미등록 시 503 반환

### FR-5xx: 이메일 폴백
- [ ] AC-501: 이메일 실패 시 nextStage: 'totp', emailFallback: true 반환

### FR-6xx: localhostPasswordOnly
- [ ] AC-601: localhost에서 localhostPasswordOnly=true 시 2FA 건너뜀

### 보안 검증
- [ ] NFR-101: TOTP 검증 timing-safe 처리 (otplib 내장)
- [ ] NFR-102: data/totp.secret 암호화 저장 확인
- [ ] NFR-104: 3회 시도 초과 시 tempToken 폐기
- [ ] NFR-105: 동일 TOTP 코드 재사용 차단

### 성능 검증
- [ ] NFR-201: TOTP 검증 응답 시간 < 100ms
- [ ] NFR-202: QR 출력 포함 서버 시작 시간 < 2초

### 하위 호환 검증
- [ ] 기존 이메일 OTP 플로우 (stage 없는 요청) 정상 동작
- [ ] config.json5 기존 설정으로 서버 기동 (totp 필드 없어도 OK)

## 검증 결과

| 항목 | 결과 | 비고 |
|------|------|------|
| 빌드 (server) | ⬜ | |
| 빌드 (frontend) | ⬜ | |
| COMBO-1 | ⬜ | |
| COMBO-2 | ⬜ | |
| COMBO-3 | ⬜ | |
| COMBO-4 | ⬜ | |
| COMBO-4 이메일 폴백 | ⬜ | |
| TOTP 미등록 503 | ⬜ | |
| localhostPasswordOnly | ⬜ | |
| GA 앱 호환성 | ⬜ | |
| 기존 이메일 OTP 하위 호환 | ⬜ | |
