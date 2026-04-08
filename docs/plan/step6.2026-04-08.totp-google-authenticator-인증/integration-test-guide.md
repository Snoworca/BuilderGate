# 통합 테스트 가이드

## 1. 테스트 전제 조건

```bash
# 서버 시작 (dev.js 사용)
node dev.js

# TOTP 테스트용 모바일 앱 필요:
# - Google Authenticator
# - Microsoft Authenticator
# - Authy
```

---

## 2. COMBO별 E2E 테스트

### COMBO-1: 2FA 없이 비밀번호만 로그인

**설정**:
```json5
twoFactor: { enabled: false }
```

**테스트**:
```bash
curl -k -X POST https://localhost:4242/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "1234"}'
# 기대: 200 OK, { success: true, token: "...", expiresIn: ... }
```

---

### COMBO-2: 이메일 OTP 플로우 (기존 동작 + nextStage 확인)

**설정**:
```json5
twoFactor: { enabled: true, totp: { enabled: false }, smtp: { ... } }
```

**테스트**:
```bash
# Step 1: 로그인
curl -k -X POST https://localhost:4242/api/auth/login \
  -d '{"password": "1234"}'
# 기대: 202, { requires2FA: true, tempToken: "...", maskedEmail: "...", nextStage: "email" }

# Step 2: OTP 검증
curl -k -X POST https://localhost:4242/api/auth/verify \
  -d '{"tempToken": "...", "otpCode": "123456", "stage": "email"}'
# 기대: 200, { success: true, token: "...", expiresIn: ... }
```

---

### COMBO-3: TOTP 전용 플로우

**설정**:
```json5
twoFactor: { enabled: true, totp: { enabled: true } }
# smtp 없음
```

**테스트**:
```bash
# Step 1: 로그인
curl -k -X POST https://localhost:4242/api/auth/login \
  -d '{"password": "1234"}'
# 기대: 202, { requires2FA: true, tempToken: "...", nextStage: "totp" }

# Step 2: TOTP 검증 (Google Authenticator 앱에서 코드 확인)
curl -k -X POST https://localhost:4242/api/auth/verify \
  -d '{"tempToken": "...", "otpCode": "654321", "stage": "totp"}'
# 기대: 200, { success: true, token: "...", expiresIn: ... }
```

---

### COMBO-4: 이메일 OTP + TOTP 순차 플로우

**설정**:
```json5
twoFactor: { enabled: true, totp: { enabled: true }, smtp: { ... } }
```

**테스트**:
```bash
# Step 1: 로그인
curl -k -X POST https://localhost:4242/api/auth/login \
  -d '{"password": "1234"}'
# 기대: 202, { nextStage: "email", maskedEmail: "...", ... }

# Step 2: 이메일 OTP 검증
curl -k -X POST https://localhost:4242/api/auth/verify \
  -d '{"tempToken": "...", "otpCode": "123456", "stage": "email"}'
# 기대: 202, { success: true, nextStage: "totp" } (token 없음)

# Step 3: TOTP 검증
curl -k -X POST https://localhost:4242/api/auth/verify \
  -d '{"tempToken": "...", "otpCode": "654321", "stage": "totp"}'
# 기대: 200, { success: true, token: "...", expiresIn: ... }
```

---

## 3. 엣지 케이스 테스트

### TOTP 미등록 차단 (FR-401)

```bash
# data/totp.secret 파일 삭제 후 서버 재시작
rm data/totp.secret

# config: totp.enabled = true
# 로그인 시도
curl -k -X POST https://localhost:4242/api/auth/login -d '{"password":"1234"}'
# 기대: 503, { success: false, message: "TOTP is enabled but not configured..." }
```

### localhostPasswordOnly 바이패스 (FR-602)

```bash
# config: auth.localhostPasswordOnly = true
# 서버를 localhost에서 접속하면 2FA 건너뜀
curl -k -X POST https://localhost:4242/api/auth/login -d '{"password":"1234"}'
# 기대: 200, { success: true, token: "..." } (2FA 없이 즉시 JWT)
```

### stage 불일치 (FR-802)

```bash
# COMBO-3 로그인 후 stage: 'email'로 verify 시도
curl -k -X POST https://localhost:4242/api/auth/verify \
  -d '{"tempToken":"...", "otpCode":"654321", "stage":"email"}'
# 기대: 400, { message: "Unexpected verification stage" }
```

### TOTP 재사용 방지 (NFR-105)

```bash
# 동일한 TOTP 코드로 연속 2회 verify 시도
# 기대: 첫 번째 200 OK, 두 번째 401 Unauthorized
```

---

## 4. 호환성 테스트 (NFR-301~304)

| 앱 | 알고리즘 | 기대 결과 |
|----|---------|---------|
| Google Authenticator | HMAC-SHA1, 6자리, 30초 | ✅ 정상 |
| Microsoft Authenticator | HMAC-SHA1, 6자리, 30초 | ✅ 정상 |
| Authy | HMAC-SHA1, 6자리, 30초 | ✅ 정상 |

**시간 오차 테스트**: 시스템 시계를 ±25초 조정 후 TOTP 코드 검증 → 통과해야 함

---

## 5. 성능 검증 (NFR-201, NFR-202)

```bash
# NFR-201: 로그인 응답 < 200ms 검증
time curl -k -X POST https://localhost:4242/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password": "1234"}'
# real 시간이 0.200s 미만이어야 함

# NFR-202: OTP 검증 응답 < 100ms 검증
# (로그인 후 tempToken 획득 후)
time curl -k -X POST https://localhost:4242/api/auth/verify \
  -H 'Content-Type: application/json' \
  -d "{\"tempToken\": \"$TEMP_TOKEN\", \"otpCode\": \"$TOTP_CODE\", \"stage\": \"totp\"}"
# real 시간이 0.100s 미만이어야 함
```

> 로컬 환경에서 기준 미달 시: Node.js 프로파일러 확인, bcrypt rounds 수 점검
