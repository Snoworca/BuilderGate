# Software Requirements Specification (SRS)
# Claude Web Shell - Step 2: Security Implementation

**Version**: 1.2.0
**Date**: 2026-01-12
**Status**: Draft
**Depends On**: srs.startup.md (Step 1)

---

## 1. Introduction

### 1.1 Purpose
본 문서는 Claude Web Shell의 보안 기능 구현을 위한 소프트웨어 요구사항 명세서입니다. Step 1(Pilot)에서 누락된 인증, 암호화, 세션 관리 등 보안 관련 기능을 정의합니다.

### 1.2 Scope
- **단계**: Step 2 - Security Implementation
- **목표**: 프로덕션 환경에서 안전하게 사용 가능한 수준의 보안 구현
- **범위**: 인증, 암호화, 세션 관리, SSL/TLS, 공격 방어

### 1.3 Definitions and Acronyms

| 용어 | 설명 |
|------|------|
| JWT | JSON Web Token - 상태 없는 인증 토큰 |
| 2FA | Two-Factor Authentication - 2단계 인증 |
| SMTP | Simple Mail Transfer Protocol - 이메일 전송 프로토콜 |
| OTP | One-Time Password - 일회용 비밀번호 |
| HTTPS | HTTP over TLS - 암호화된 HTTP 통신 |
| TLS | Transport Layer Security - 전송 계층 보안 |
| PBKDF2 | Password-Based Key Derivation Function 2 |
| AES | Advanced Encryption Standard |
| GCM | Galois/Counter Mode - 인증된 암호화 모드 |
| Brute Force | 무차별 대입 공격 |
| Rate Limiting | 요청 속도 제한 |
| Session | 인증된 사용자의 연결 상태 (JWT 토큰 유효 기간) |
| PTY Session | 터미널 프로세스 세션 (Step 1에서 정의) |
| Heartbeat | 세션 유지를 위한 주기적 신호 |

### 1.4 User Requirements Mapping

| UR-ID | 사용자 요구사항 | 관련 FR |
|-------|----------------|---------|
| UR-001 | config.json5에 평문 비밀번호 입력 시 자동 암호화 | FR-601, FR-602 |
| UR-002 | 2단계 인증 지원 (SMTP + OTP) | FR-701 ~ FR-704 |
| UR-003 | JWT 토큰 방식 인증 | FR-801 ~ FR-804 |
| UR-004 | 설정 파일에 세션 유지시간 설정 | FR-901 |
| UR-005 | 웹 페이지 하트비트로 세션 유지 (간격: 세션시간/2) | FR-902, FR-903 |
| UR-006 | 무차별 대입 공격 방지 | FR-1001 ~ FR-1005 |
| UR-007 | SSL 인증서 경로 설정 및 자동 생성 | FR-1101 ~ FR-1104 |

### 1.5 Current Security Status (Step 1)

| 항목 | 상태 | 위험도 | CVSS |
|------|------|--------|------|
| 인증 | 미구현 | CRITICAL | 9.8 |
| 권한 관리 | 미구현 | CRITICAL | 9.8 |
| HTTPS/TLS | 미구현 | HIGH | 7.5 |
| 입력 검증 | 최소한 | HIGH | 7.2 |
| CORS | 전체 허용 | HIGH | 8.1 |
| Rate Limiting | 미구현 | MEDIUM | 5.3 |
| Audit Logging | 미구현 | MEDIUM | 4.0 |

### 1.6 Document Conventions

- **FR-XXX**: Functional Requirement (기능 요구사항)
- **NFR-XXX**: Non-Functional Requirement (비기능 요구사항)
- **TC-XXX**: Test Condition (테스트 조건)
- **AC-XXX**: Acceptance Criteria (인수 조건)

---

## 2. Security Architecture

### 2.1 Overall Security Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Client (Browser)                               │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────────────┐  │
│  │  Login Form │  │  2FA Input   │  │  Terminal (Authenticated)     │  │
│  │  (HTTPS)    │  │  (OTP Code)  │  │  + Heartbeat (session/2 interval)│ │
│  └──────┬──────┘  └──────┬───────┘  └────────────────┬───────────────┘  │
└─────────┼────────────────┼───────────────────────────┼──────────────────┘
          │ HTTPS          │ HTTPS                     │ HTTPS + JWT
          ▼                ▼                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Express Server (HTTPS:4242)                       │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                     Security Middleware Stack                    │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────┐  │    │
│  │  │   Rate   │→│  CORS    │→│  Auth    │→│  JWT     │→│ Audit │  │    │
│  │  │  Limiter │ │  Filter  │ │  Guard   │ │ Verify   │ │  Log  │  │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └───────┘  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐   │
│  │  Auth        │  │  2FA         │  │  Session Manager             │   │
│  │  Service     │  │  Service     │  │  (with ownership check)      │   │
│  │  (JWT+Pass)  │  │  (SMTP+OTP)  │  │                              │   │
│  └──────────────┘  └──────────────┘  └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          config.json5                                    │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  password: "enc(AES256_ENCRYPTED_STRING)"  ← Auto-encrypt on boot │   │
│  │  twoFactor: { enabled, smtp: {...}, email }                      │   │
│  │  session: { durationMs, jwtSecret }                              │   │
│  │  ssl: { certPath, keyPath }  ← Auto-generate if empty            │   │
│  │  security: { maxLoginAttempts, lockoutDurationMs, ... }          │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Authentication Flow

```
┌──────────┐                  ┌──────────┐                  ┌──────────┐
│  Client  │                  │  Server  │                  │   SMTP   │
└────┬─────┘                  └────┬─────┘                  └────┬─────┘
     │                             │                              │
     │  1. POST /api/auth/login    │                              │
     │  { password }               │                              │
     │────────────────────────────>│                              │
     │                             │                              │
     │                             │  2. Validate password        │
     │                             │     (decrypt & compare)      │
     │                             │                              │
     │              ┌──────────────┴──────────────┐               │
     │              │  2FA Enabled?               │               │
     │              └──────────────┬──────────────┘               │
     │                             │                              │
     │  [2FA Disabled]             │  [2FA Enabled]               │
     │                             │                              │
     │  3a. Return JWT token       │  3b. Generate OTP (6 digits) │
     │<────────────────────────────│                              │
     │                             │  4. Send OTP via email       │
     │                             │─────────────────────────────>│
     │                             │                              │
     │  5. Return pending status   │                              │
     │  { requires2FA: true,       │                              │
     │    tempToken }              │                              │
     │<────────────────────────────│                              │
     │                             │                              │
     │  6. POST /api/auth/verify   │                              │
     │  { tempToken, otpCode }     │                              │
     │────────────────────────────>│                              │
     │                             │                              │
     │                             │  7. Validate OTP             │
     │                             │     (time-limited, 5min)     │
     │                             │                              │
     │  8. Return JWT token        │                              │
     │<────────────────────────────│                              │
     │                             │                              │
```

### 2.3 Session Heartbeat Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                      Session Lifecycle                            │
└──────────────────────────────────────────────────────────────────┘

Login Success
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  JWT Token Issued                                                │
│  - exp: now + sessionDurationMs                                  │
│  - iat: now                                                      │
│  - sub: "admin" (single user system)                            │
│  - jti: UUID v4                                                  │
└─────────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Client: Start Heartbeat Timer                                   │
│  - interval = sessionDurationMs / 2                              │
│  - Example: 30min session → 15min heartbeat                      │
└─────────────────────────────────────────────────────────────────┘
     │
     ├──────────────────────────────┐
     │                              │
     ▼                              ▼
┌──────────────────┐    ┌──────────────────────────────────────────┐
│  Every interval: │    │  On Token Expiry:                        │
│  POST /heartbeat │    │  - Clear local storage                   │
│  { token }       │    │  - Redirect to login                     │
│       │          │    │  - Show "Session expired" message        │
│       ▼          │    └──────────────────────────────────────────┘
│  Server returns  │
│  new token       │
│  (refreshed exp) │
└──────────────────┘
```

### 2.4 Error Recovery Scenarios

| 시나리오 | 원인 | 복구 방법 |
|----------|------|----------|
| ER-001 | SMTP 서버 연결 실패 | 3회 재시도 (지수 백오프: 1s, 2s, 4s), 실패 시 에러 반환 |
| ER-002 | JWT Secret 분실 | 서버 재시작 시 신규 생성, 기존 토큰 무효화 |
| ER-003 | SSL 인증서 만료 | 자체 서명 인증서 자동 재생성 |
| ER-004 | config.json5 손상 | 기본값으로 폴백, 경고 로그 출력 |
| ER-005 | 마스터 키 분실 | 신규 키 생성, 기존 암호화 데이터 복호화 불가 경고 |
| ER-006 | 메모리 부족 (OTP 저장) | 오래된 OTP 자동 삭제 (FIFO), 최대 1000개 유지 |
| ER-007 | Rate Limit 저장소 오류 | 인메모리 폴백, 경고 로그 출력 |

---

## 3. Functional Requirements

### 3.1 Password Management (FR-600)

#### FR-601: Password Storage in Config
- **ID**: FR-601
- **Source**: UR-001
- **Priority**: P0 (Critical)
- **Description**: 설정 파일에 비밀번호를 안전하게 저장한다
- **Input**:
  - 평문 비밀번호: `password: "mySecretPassword"`
- **Output**:
  - 암호화된 비밀번호: `password: "enc(BASE64_AES256_ENCRYPTED)"`
- **Processing**:
  1. 서버 기동 시 password 필드 확인
  2. `enc(...)` 형식이 아니면 평문으로 간주
  3. 평문 비밀번호를 AES-256-GCM으로 암호화
  4. config.json5 파일에 `enc(...)` 형식으로 덮어쓰기
  5. 원본 평문은 메모리에서 즉시 제거 (Buffer.fill(0))
- **Acceptance Criteria**:
  - AC-601-1: 평문 비밀번호 입력 후 서버 재시작 시 `enc(...)` 형식으로 변환됨
  - AC-601-2: 변환 후 원본 비밀번호로 로그인 성공
  - AC-601-3: 서버 로그에 평문 비밀번호가 노출되지 않음
- **Boundary Conditions**:
  - 비밀번호 최소 길이: 1자
  - 비밀번호 최대 길이: 128자
  - 허용 문자: ASCII 32-126 (출력 가능 문자)

#### FR-602: Password Encryption Algorithm
- **ID**: FR-602
- **Source**: UR-001
- **Priority**: P0 (Critical)
- **Description**: 비밀번호 암호화에 사용할 알고리즘을 정의한다
- **Specification**:
  - 알고리즘: AES-256-GCM
  - 키 유도: PBKDF2 (SHA-256, iterations: 100,000)
  - Salt: 32 bytes (crypto.randomBytes)
  - IV: 12 bytes (crypto.randomBytes)
  - Auth Tag: 16 bytes
- **Structure**: `enc(base64(salt[32] + iv[12] + authTag[16] + ciphertext))`
- **Acceptance Criteria**:
  - AC-602-1: 동일 평문을 두 번 암호화하면 서로 다른 결과 생성 (Salt/IV 차이)
  - AC-602-2: Auth Tag 검증 실패 시 복호화 거부
- **Dependencies**: Node.js crypto module (built-in)

#### FR-603: Password Validation
- **ID**: FR-603
- **Source**: UR-001
- **Priority**: P0 (Critical)
- **Description**: 로그인 시 비밀번호를 검증한다
- **Input**: 사용자 입력 비밀번호 (string)
- **Output**: 검증 결과 (boolean)
- **Processing**:
  1. 저장된 암호화 비밀번호 복호화
  2. 입력 비밀번호와 상수 시간 비교 (crypto.timingSafeEqual)
  3. 결과 반환 (성공/실패)
- **Acceptance Criteria**:
  - AC-603-1: 올바른 비밀번호 → true 반환
  - AC-603-2: 잘못된 비밀번호 → false 반환
  - AC-603-3: 비밀번호 길이 차이에 관계없이 응답 시간 일정 (±10ms)
- **Performance**: 검증 시간 < 500ms (PBKDF2 포함)

### 3.2 Two-Factor Authentication (FR-700)

#### FR-701: 2FA Configuration
- **ID**: FR-701
- **Source**: UR-002
- **Priority**: P1 (High)
- **Description**: 2단계 인증 설정을 config.json5에 정의한다
- **Configuration Schema**:
```json5
{
  twoFactor: {
    enabled: true,                    // boolean, required
    email: "admin@example.com",       // string, required if enabled
    otpLength: 6,                     // integer, 4-8, default: 6
    otpExpiryMs: 300000,              // integer, 60000-600000, default: 300000
    smtp: {
      host: "smtp.gmail.com",         // string, required if enabled
      port: 587,                      // integer, 1-65535
      secure: false,                  // boolean, default: false
      auth: {
        user: "sender@gmail.com",     // string, required
        password: "app-password"      // string, auto-encrypted
      }
    }
  }
}
```
- **Acceptance Criteria**:
  - AC-701-1: enabled=true이고 email 미설정 시 서버 시작 실패 (에러 메시지 출력)
  - AC-701-2: SMTP 설정 불완전 시 서버 시작 실패
  - AC-701-3: smtp.auth.password도 enc() 형식으로 자동 변환

#### FR-702: OTP Generation
- **ID**: FR-702
- **Source**: UR-002
- **Priority**: P1 (High)
- **Description**: 암호학적으로 안전한 OTP를 생성한다
- **Algorithm**: crypto.randomInt(10^(length-1), 10^length)
- **Format**: 숫자만 (기본 6자리: 100000-999999)
- **Storage**:
  - 구조: Map<tempToken, { otp: string, email: string, expiresAt: number, attempts: number }>
  - 최대 크기: 1000개 (초과 시 FIFO 삭제)
- **Acceptance Criteria**:
  - AC-702-1: OTP 길이가 설정값과 일치
  - AC-702-2: 숫자만 포함
  - AC-702-3: 1000회 생성 시 중복률 < 0.1%

#### FR-703: OTP Email Delivery
- **ID**: FR-703
- **Source**: UR-002
- **Priority**: P1 (High)
- **Description**: 생성된 OTP를 이메일로 전송한다
- **Email Template**:
  - Subject: "[Claude Web Shell] Login Verification Code"
  - Body:
    ```
    Your verification code is: {OTP}

    This code will expire in {expiryMinutes} minutes.

    If you did not request this code, please ignore this email.
    Do not share this code with anyone.
    ```
- **Retry Policy**:
  - 최대 3회 재시도
  - 지수 백오프: 1초, 2초, 4초
- **Acceptance Criteria**:
  - AC-703-1: 이메일 전송 성공 시 true 반환
  - AC-703-2: 3회 실패 시 SMTP_ERROR 에러 반환
  - AC-703-3: 이메일 전송 완료까지 최대 15초
- **Dependencies**: nodemailer ^6.9.0

#### FR-704: OTP Verification
- **ID**: FR-704
- **Source**: UR-002
- **Priority**: P1 (High)
- **Description**: 사용자가 입력한 OTP를 검증한다
- **Input**: tempToken (string), otpCode (string)
- **Output**: JWT token 또는 error
- **Processing**:
  1. tempToken으로 저장된 OTP 조회
  2. 만료 시간 확인 (Date.now() < expiresAt)
  3. 시도 횟수 확인 (attempts < 3)
  4. OTP 일치 여부 확인 (crypto.timingSafeEqual)
  5. 성공 시: OTP 데이터 삭제, JWT 발급
  6. 실패 시: attempts++, 3회 초과 시 OTP 삭제
- **Acceptance Criteria**:
  - AC-704-1: 올바른 OTP → JWT 토큰 발급
  - AC-704-2: 만료된 OTP → OTP_EXPIRED 에러
  - AC-704-3: 3회 실패 → OTP_MAX_ATTEMPTS 에러
  - AC-704-4: 잘못된 tempToken → INVALID_TEMP_TOKEN 에러

### 3.3 JWT Token Management (FR-800)

#### FR-801: JWT Token Structure
- **ID**: FR-801
- **Source**: UR-003
- **Priority**: P0 (Critical)
- **Description**: 인증에 사용할 JWT 토큰 구조를 정의한다
- **Header**:
```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```
- **Payload**:
```json
{
  "sub": "admin",
  "iat": 1705000000,
  "exp": 1705003600,
  "jti": "550e8400-e29b-41d4-a716-446655440000"
}
```
- **Signature**: HMAC-SHA256
- **Total Size**: < 500 bytes
- **Acceptance Criteria**:
  - AC-801-1: 발급된 토큰이 JWT 형식 (header.payload.signature)
  - AC-801-2: Base64URL 인코딩 사용
  - AC-801-3: jti가 UUID v4 형식

#### FR-802: JWT Token Issuance
- **ID**: FR-802
- **Source**: UR-003
- **Priority**: P0 (Critical)
- **Description**: 로그인 성공 시 JWT 토큰을 발급한다
- **Input**: 인증 성공 이벤트
- **Output**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 1800000
}
```
- **Processing**:
  1. Payload 생성 (sub: "admin", iat: now, exp: now + durationMs, jti: uuid())
  2. Header + Payload를 JSON 직렬화 후 Base64URL 인코딩
  3. HMAC-SHA256으로 서명
  4. 토큰 반환
- **Acceptance Criteria**:
  - AC-802-1: exp가 iat + sessionDurationMs와 일치
  - AC-802-2: 매 발급 시 jti가 고유함
- **Dependencies**: jsonwebtoken ^9.0.0

#### FR-803: JWT Token Validation
- **ID**: FR-803
- **Source**: UR-003
- **Priority**: P0 (Critical)
- **Description**: 모든 보호된 API 요청에서 토큰을 검증한다
- **Input**: HTTP Request (Authorization: Bearer {token})
- **Output**: 인증 성공 (next()) 또는 에러 응답
- **Processing**:
  1. Authorization 헤더 존재 확인
  2. "Bearer " 접두어 확인 및 토큰 추출
  3. 서명 검증 (jwt.verify with secret)
  4. 만료 시간 확인 (exp > now)
  5. 블랙리스트 확인 (jti 검색)
  6. 검증 성공 시 req.user에 payload 저장
- **Acceptance Criteria**:
  - AC-803-1: 유효한 토큰 → 요청 진행 (200)
  - AC-803-2: 토큰 없음 → 401 MISSING_TOKEN
  - AC-803-3: 잘못된 형식 → 401 INVALID_TOKEN
  - AC-803-4: 서명 불일치 → 401 INVALID_SIGNATURE
  - AC-803-5: 만료됨 → 401 TOKEN_EXPIRED
  - AC-803-6: 블랙리스트 → 401 TOKEN_REVOKED
- **Performance**: 검증 시간 < 10ms

#### FR-804: JWT Secret Configuration
- **ID**: FR-804
- **Source**: UR-003
- **Priority**: P0 (Critical)
- **Description**: JWT 서명에 사용할 비밀키를 설정한다
- **Auto-generation**:
  - 조건: session.jwtSecret이 빈 문자열
  - 생성: crypto.randomBytes(32).toString('base64')
  - 저장: enc() 형식으로 config.json5에 저장
- **Acceptance Criteria**:
  - AC-804-1: jwtSecret 비어있을 때 서버 시작 시 자동 생성
  - AC-804-2: 생성된 secret 길이 ≥ 256 bits
  - AC-804-3: 자동 생성 후 config.json5에 enc() 형식으로 저장

### 3.4 Session Management (FR-900)

#### FR-901: Session Duration Configuration
- **ID**: FR-901
- **Source**: UR-004
- **Priority**: P0 (Critical)
- **Description**: 세션 유지 시간을 설정한다
- **Configuration**:
```json5
{
  session: {
    durationMs: 1800000,      // 30분 (default)
    maxDurationMs: 86400000   // 24시간 (max limit)
  }
}
```
- **Validation Rules**:
  - durationMs: 60000 (1분) ~ 86400000 (24시간)
  - durationMs > maxDurationMs 시 maxDurationMs로 조정
- **Acceptance Criteria**:
  - AC-901-1: JWT exp가 iat + durationMs로 설정됨
  - AC-901-2: durationMs < 60000 시 60000으로 조정
  - AC-901-3: durationMs > 86400000 시 86400000으로 조정

#### FR-902: Heartbeat Endpoint
- **ID**: FR-902
- **Source**: UR-005
- **Priority**: P0 (Critical)
- **Description**: 세션 유지를 위한 하트비트 엔드포인트를 제공한다
- **Endpoint**: POST /api/auth/heartbeat
- **Request**:
  - Header: Authorization: Bearer {token}
- **Response** (200 OK):
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...(new)",
  "expiresIn": 1800000
}
```
- **Processing**:
  1. 현재 토큰 검증 (FR-803)
  2. 새 토큰 발급 (동일 sub, 새 jti, 갱신된 exp)
  3. 이전 토큰 jti를 블랙리스트에 추가 (TTL: 이전 토큰 남은 시간)
- **Acceptance Criteria**:
  - AC-902-1: 유효한 토큰 → 새 토큰 발급
  - AC-902-2: 새 토큰의 exp > 이전 토큰의 exp
  - AC-902-3: 이전 토큰으로 재요청 시 401 TOKEN_REVOKED
- **Performance**: 응답 시간 < 50ms

#### FR-903: Client Heartbeat Interval
- **ID**: FR-903
- **Source**: UR-005
- **Priority**: P1 (High)
- **Description**: 클라이언트는 자동으로 하트비트를 전송한다
- **Interval Calculation**: sessionDurationMs / 2
- **Examples**:
  - 30분 세션 → 15분 (900,000ms) 간격
  - 1시간 세션 → 30분 (1,800,000ms) 간격
- **Client Behavior**:
  1. 로그인 성공 시 하트비트 타이머 시작
  2. 매 interval마다 POST /api/auth/heartbeat 호출
  3. 성공 시 토큰 갱신, 타이머 재시작
  4. 실패 시 로그인 페이지로 리다이렉트
- **Acceptance Criteria**:
  - AC-903-1: 클라이언트가 정확히 interval 간격으로 하트비트 전송
  - AC-903-2: 네트워크 오류 시 1회 즉시 재시도
  - AC-903-3: 2회 연속 실패 시 세션 만료 처리

#### FR-904: Session Termination
- **ID**: FR-904
- **Source**: UR-005
- **Priority**: P1 (High)
- **Description**: 세션을 명시적으로 종료한다
- **Endpoint**: POST /api/auth/logout
- **Request**: Authorization: Bearer {token}
- **Response** (200 OK):
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```
- **Processing**:
  1. 토큰 검증
  2. jti를 블랙리스트에 추가 (TTL: 토큰 남은 유효시간)
  3. 성공 응답 반환
- **Acceptance Criteria**:
  - AC-904-1: 로그아웃 후 동일 토큰 사용 시 401 TOKEN_REVOKED
  - AC-904-2: 로그아웃 응답 시간 < 50ms

### 3.5 Brute Force Protection (FR-1000)

#### FR-1001: Login Attempt Tracking
- **ID**: FR-1001
- **Source**: UR-006
- **Priority**: P0 (Critical)
- **Description**: 로그인 시도를 추적한다
- **Tracking Target**: Client IP Address (req.ip or X-Forwarded-For)
- **Storage**: In-memory Map<IP, LoginAttemptData>
```typescript
interface LoginAttemptData {
  attempts: number;          // 현재 시도 횟수
  firstAttemptAt: number;    // 첫 시도 시각 (timestamp)
  lockedUntil: number | null; // 잠금 해제 시각
  lockCount: number;         // 누적 잠금 횟수
}
```
- **Cleanup**: 1시간 동안 활동 없는 IP 데이터 자동 삭제
- **Acceptance Criteria**:
  - AC-1001-1: 실패 시 attempts 증가
  - AC-1001-2: 성공 시 attempts 초기화
  - AC-1001-3: IP 데이터 1시간 후 자동 삭제

#### FR-1002: Account Lockout
- **ID**: FR-1002
- **Source**: UR-006
- **Priority**: P0 (Critical)
- **Description**: 연속 실패 시 해당 IP를 잠근다
- **Configuration**:
```json5
{
  security: {
    maxLoginAttempts: 5,           // 최대 시도 횟수
    lockoutDurationMs: 900000,     // 기본 잠금 시간 (15분)
    lockoutMultiplier: 2.0         // 반복 잠금 시 배수
  }
}
```
- **Lockout Duration Calculation**:
  - 1차 잠금: lockoutDurationMs (15분)
  - 2차 잠금: lockoutDurationMs × 2 (30분)
  - 3차 잠금: lockoutDurationMs × 4 (60분)
  - 최대: 24시간
- **Acceptance Criteria**:
  - AC-1002-1: 5회 실패 → 403 ACCOUNT_LOCKED
  - AC-1002-2: 잠금 응답에 remainingMs 포함
  - AC-1002-3: 잠금 해제 후 시도 카운터 초기화
  - AC-1002-4: 반복 잠금 시 시간 배수 적용

#### FR-1003: Progressive Delay
- **ID**: FR-1003
- **Source**: UR-006
- **Priority**: P1 (High)
- **Description**: 실패 횟수에 따라 응답 지연을 증가시킨다
- **Delay Formula**: `delay = min(200 × 2^(attempts-1), 10000)` ms
- **Examples**:
  - 1회 실패: 200ms
  - 2회 실패: 400ms
  - 3회 실패: 800ms
  - 4회 실패: 1,600ms
  - 5회 실패: 3,200ms
  - 6회 이상: 10,000ms (최대)
- **Acceptance Criteria**:
  - AC-1003-1: 실패 응답 시간이 공식에 맞게 지연됨
  - AC-1003-2: 성공 시 지연 없음
  - AC-1003-3: 최대 10초 초과하지 않음

#### FR-1004: Rate Limiting
- **ID**: FR-1004
- **Source**: UR-006
- **Priority**: P0 (Critical)
- **Description**: 전체 API에 요청 속도 제한을 적용한다
- **Configuration**:
```json5
{
  security: {
    rateLimit: {
      windowMs: 60000,           // 1분 윈도우
      maxRequests: 100,          // 일반 API: 분당 100회
      loginMaxRequests: 10       // 로그인: 분당 10회
    }
  }
}
```
- **Response (429 Too Many Requests)**:
```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "retryAfter": 45000
  }
}
```
- **Headers**:
  - X-RateLimit-Limit: 100
  - X-RateLimit-Remaining: 0
  - X-RateLimit-Reset: 1705000060
- **Acceptance Criteria**:
  - AC-1004-1: 101번째 요청 → 429 응답
  - AC-1004-2: 윈도우 리셋 후 요청 허용
  - AC-1004-3: 로그인 엔드포인트 분당 10회 제한
- **Dependencies**: express-rate-limit ^7.0.0

#### FR-1005: IP Blacklist
- **ID**: FR-1005
- **Source**: UR-006
- **Priority**: P1 (High)
- **Description**: 악의적인 IP를 차단한다
- **Auto-Blacklist Conditions**:
  - 1시간 내 10회 이상 잠금 발생
- **Configuration**:
```json5
{
  security: {
    ipBlacklist: ["192.168.1.100"],  // 수동 차단
    autoBlacklistThreshold: 10,       // 자동 차단 임계값
    autoBlacklistDurationMs: 86400000 // 24시간
  }
}
```
- **Response (403 Forbidden)**:
```json
{
  "error": {
    "code": "IP_BLACKLISTED",
    "message": "Your IP has been blocked",
    "blockedUntil": "2026-01-13T10:00:00Z"
  }
}
```
- **Acceptance Criteria**:
  - AC-1005-1: 수동 차단 IP → 즉시 403
  - AC-1005-2: 10회 잠금 → 자동 차단
  - AC-1005-3: 24시간 후 자동 해제

### 3.6 SSL/TLS Configuration (FR-1100)

#### FR-1101: SSL Certificate Configuration
- **ID**: FR-1101
- **Source**: UR-007
- **Priority**: P0 (Critical)
- **Description**: SSL 인증서 경로를 설정한다
- **Configuration**:
```json5
{
  ssl: {
    certPath: "/path/to/cert.pem",   // X.509 인증서
    keyPath: "/path/to/key.pem",     // RSA/EC 개인키
    caPath: "/path/to/ca.pem"        // (선택) 체인 인증서
  }
}
```
- **Validation**:
  - 파일 존재 여부 확인
  - 인증서-키 쌍 일치 확인
  - 인증서 만료일 확인 (30일 이내 만료 시 경고)
- **Acceptance Criteria**:
  - AC-1101-1: 유효한 인증서 경로 → HTTPS 서버 시작
  - AC-1101-2: 파일 없음 → 자동 생성 (FR-1102)
  - AC-1101-3: 인증서-키 불일치 → 서버 시작 실패

#### FR-1102: Auto-Generate Self-Signed Certificate
- **ID**: FR-1102
- **Source**: UR-007
- **Priority**: P0 (Critical)
- **Description**: 인증서 경로가 비어있으면 자체 서명 인증서를 자동 생성한다
- **Trigger Conditions**:
  - ssl.certPath가 빈 문자열
  - ssl.keyPath가 빈 문자열
  - 지정된 파일이 존재하지 않음
- **Generated Certificate Spec**:
  - Algorithm: RSA 2048-bit
  - Signature: SHA-256
  - Validity: 365일
  - Subject: CN=localhost
  - SAN (Subject Alternative Names):
    - DNS: localhost
    - IP: 127.0.0.1
    - IP: ::1
- **Output Files**:
  - `./certs/self-signed.crt`
  - `./certs/self-signed.key`
- **Config Update**: 생성 후 config.json5에 경로 자동 저장
- **Acceptance Criteria**:
  - AC-1102-1: 인증서 파일 생성됨
  - AC-1102-2: config.json5에 경로 저장됨
  - AC-1102-3: openssl verify 통과
  - AC-1102-4: 365일 유효
- **Dependencies**: node-forge ^1.3.0 또는 selfsigned ^2.4.0

#### FR-1103: HTTPS Only
- **ID**: FR-1103
- **Source**: UR-007
- **Priority**: P0 (Critical)
- **Description**: 서버는 HTTPS만 지원한다
- **Behavior**:
  - HTTP 요청 시 HTTPS로 301 리다이렉트
  - HSTS 헤더 설정
- **HTTP Redirect Server**: (선택적)
  - Port: 80 또는 server.port - 1
  - 모든 요청을 https://host:port로 리다이렉트
- **Acceptance Criteria**:
  - AC-1103-1: HTTPS 연결 성공
  - AC-1103-2: HTTP → HTTPS 리다이렉트 (301)
  - AC-1103-3: HSTS 헤더 포함

#### FR-1104: TLS Configuration
- **ID**: FR-1104
- **Source**: UR-007
- **Priority**: P0 (Critical)
- **Description**: 안전한 TLS 설정을 적용한다
- **Settings**:
  - Minimum Version: TLS 1.2
  - Preferred Version: TLS 1.3
  - Disabled Ciphers:
    - RC4, DES, 3DES
    - MD5 기반
    - Export 등급
  - Enabled Cipher Suites (TLS 1.2):
    - ECDHE-RSA-AES256-GCM-SHA384
    - ECDHE-RSA-AES128-GCM-SHA256
- **Acceptance Criteria**:
  - AC-1104-1: TLS 1.1 연결 시도 → 거부
  - AC-1104-2: TLS 1.2/1.3 연결 → 성공
  - AC-1104-3: nmap --script ssl-enum-ciphers 취약 암호 없음

---

## 4. Additional Security Requirements

### 4.1 CORS Hardening (FR-1200)

#### FR-1201: Strict CORS Policy
- **ID**: FR-1201
- **Priority**: P1 (High)
- **Description**: CORS 정책을 엄격하게 설정한다
- **Configuration**:
```json5
{
  security: {
    cors: {
      allowedOrigins: [
        "https://localhost:3000"
      ],
      allowCredentials: true,
      maxAge: 86400,
      allowedMethods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"]
    }
  }
}
```
- **Default Behavior**: allowedOrigins가 빈 배열이면 same-origin만 허용
- **Acceptance Criteria**:
  - AC-1201-1: 허용된 origin → Access-Control-Allow-Origin 포함
  - AC-1201-2: 허용되지 않은 origin → CORS 헤더 없음
  - AC-1201-3: Preflight 요청 정상 처리

### 4.2 Security Headers (FR-1300)

#### FR-1301: HTTP Security Headers
- **ID**: FR-1301
- **Priority**: P1 (High)
- **Description**: 보안 관련 HTTP 헤더를 설정한다
- **Headers**:

| Header | Value | Purpose |
|--------|-------|---------|
| Strict-Transport-Security | max-age=31536000; includeSubDomains | HTTPS 강제 |
| X-Content-Type-Options | nosniff | MIME 스니핑 방지 |
| X-Frame-Options | DENY | 클릭재킹 방지 |
| X-XSS-Protection | 0 | 레거시 XSS 필터 비활성화 (CSP 사용) |
| Content-Security-Policy | default-src 'self'; script-src 'self' | XSS 방지 |
| Referrer-Policy | strict-origin-when-cross-origin | 리퍼러 제한 |
| Permissions-Policy | geolocation=(), microphone=(), camera=() | 기능 제한 |
| Cache-Control | no-store | 민감 데이터 캐싱 방지 |

- **Acceptance Criteria**:
  - AC-1301-1: 모든 응답에 보안 헤더 포함
  - AC-1301-2: securityheaders.com A등급 이상
- **Dependencies**: helmet ^7.0.0

### 4.3 Audit Logging (FR-1400)

#### FR-1401: Security Event Logging
- **ID**: FR-1401
- **Priority**: P1 (High)
- **Description**: 보안 관련 이벤트를 로깅한다
- **Event Types**:

| Event | Severity | Description |
|-------|----------|-------------|
| LOGIN_SUCCESS | INFO | 로그인 성공 |
| LOGIN_FAILED | WARN | 로그인 실패 |
| ACCOUNT_LOCKED | WARN | 계정 잠금 |
| ACCOUNT_UNLOCKED | INFO | 계정 잠금 해제 |
| OTP_SENT | INFO | OTP 이메일 발송 |
| OTP_VERIFIED | INFO | OTP 검증 성공 |
| OTP_FAILED | WARN | OTP 검증 실패 |
| TOKEN_ISSUED | INFO | JWT 토큰 발급 |
| TOKEN_REVOKED | INFO | 토큰 무효화 (로그아웃) |
| RATE_LIMITED | WARN | Rate Limit 초과 |
| IP_BLACKLISTED | WARN | IP 자동 차단 |
| SESSION_CREATED | INFO | PTY 세션 생성 |
| SESSION_DELETED | INFO | PTY 세션 삭제 |
| CONFIG_ENCRYPTED | INFO | 설정 암호화 |

- **Log Format** (JSON):
```json
{
  "timestamp": "2026-01-12T10:30:00.000Z",
  "level": "WARN",
  "event": "LOGIN_FAILED",
  "ip": "192.168.1.100",
  "userAgent": "Mozilla/5.0...",
  "details": {
    "reason": "invalid_password",
    "attempts": 3
  }
}
```
- **Output**:
  - Console (structured JSON)
  - File: `./logs/security.log`
- **Acceptance Criteria**:
  - AC-1401-1: 모든 보안 이벤트가 로깅됨
  - AC-1401-2: 로그에 민감 정보(비밀번호, OTP) 미포함
  - AC-1401-3: 타임스탬프 ISO 8601 형식

#### FR-1402: Log Rotation
- **ID**: FR-1402
- **Priority**: P2 (Medium)
- **Description**: 로그 파일을 자동으로 로테이션한다
- **Configuration**:
```json5
{
  logging: {
    maxFileSize: "10MB",
    maxFiles: 30,
    compress: true
  }
}
```
- **Behavior**:
  - 파일 크기 10MB 초과 시 새 파일 생성
  - 최대 30개 파일 유지
  - 오래된 파일 gzip 압축
- **Acceptance Criteria**:
  - AC-1402-1: 10MB 초과 시 새 파일 생성
  - AC-1402-2: 31번째 파일 생성 시 가장 오래된 파일 삭제
- **Dependencies**: winston ^3.11.0, winston-daily-rotate-file ^5.0.0

### 4.4 Input Validation (FR-1500)

#### FR-1501: Request Validation
- **ID**: FR-1501
- **Priority**: P0 (Critical)
- **Description**: 모든 요청 입력을 검증한다
- **Validation Rules**:

| Field | Type | Constraints | Error Code |
|-------|------|-------------|------------|
| password | string | 1-128자, ASCII 32-126 | INVALID_PASSWORD_FORMAT |
| otpCode | string | 정규식: ^[0-9]{4,8}$ | INVALID_OTP_FORMAT |
| sessionName | string | 1-100자, ^[a-zA-Z0-9\s\-_]+$ | INVALID_SESSION_NAME |
| cols | integer | 10-500 | INVALID_TERMINAL_SIZE |
| rows | integer | 5-200 | INVALID_TERMINAL_SIZE |
| tempToken | string | UUID v4 형식 | INVALID_TEMP_TOKEN |

- **Acceptance Criteria**:
  - AC-1501-1: 유효하지 않은 입력 → 400 Bad Request
  - AC-1501-2: 에러 응답에 field명과 이유 포함
- **Dependencies**: zod ^3.22.0 또는 joi ^17.11.0

#### FR-1502: Command Injection Prevention
- **ID**: FR-1502
- **Priority**: P1 (High)
- **Description**: 메타 정보에서 명령 주입을 방지한다
- **Scope**:
  - 세션 이름 (PTY 프로세스 환경 변수로 전달될 수 있음)
  - 로그 메시지 (로그 주입 방지)
- **Sanitization**:
  - 세션 이름: 특수문자 제거 또는 이스케이프
  - 로그: JSON 직렬화로 이스케이프
- **Acceptance Criteria**:
  - AC-1502-1: 세션 이름에 쉘 메타문자 포함 시 제거됨
  - AC-1502-2: 로그 메시지에 JSON injection 불가

### 4.5 Session Ownership (FR-1600)

#### FR-1601: Session-User Binding
- **ID**: FR-1601
- **Priority**: P0 (Critical)
- **Description**: 세션을 생성한 사용자만 접근할 수 있다
- **Implementation**:
  1. PTY 세션 생성 시 JWT의 jti를 ownerJti로 저장
  2. PTY 세션 접근 시 현재 토큰의 jti 확인
  3. ownerJti와 불일치 시 403 Forbidden
- **Data Structure**:
```typescript
interface SessionData {
  // ... existing fields
  ownerJti: string;  // JWT jti of creator
}
```
- **Acceptance Criteria**:
  - AC-1601-1: 생성자의 토큰으로 세션 접근 → 성공
  - AC-1601-2: 다른 토큰으로 세션 접근 → 403 SESSION_NOT_OWNED
  - AC-1601-3: 토큰 갱신(heartbeat) 후에도 접근 유지

### 4.6 Environment Variable Protection (FR-1700)

#### FR-1701: Filtered Environment
- **ID**: FR-1701
- **Priority**: P1 (High)
- **Description**: PTY에 전달되는 환경변수를 필터링한다
- **Configuration**:
```json5
{
  security: {
    envFilter: {
      blockPatterns: [
        "*_SECRET", "*_KEY", "*_PASSWORD", "*_TOKEN",
        "*_CREDENTIALS", "*_API_KEY"
      ],
      blockPrefixes: ["AWS_", "AZURE_", "GCP_", "GOOGLE_"],
      allowList: ["PATH", "HOME", "TERM", "LANG", "USER", "SHELL"]
    }
  }
}
```
- **Filtering Logic**:
  1. allowList에 있으면 허용
  2. blockPatterns에 매칭되면 차단
  3. blockPrefixes로 시작하면 차단
  4. 나머지 허용
- **Acceptance Criteria**:
  - AC-1701-1: AWS_SECRET_ACCESS_KEY → PTY에 전달 안됨
  - AC-1701-2: PATH → PTY에 전달됨
  - AC-1701-3: CUSTOM_API_KEY → PTY에 전달 안됨

---

## 5. Non-Functional Requirements

### 5.1 Performance Requirements

| ID | Requirement | Target | Measurement |
|----|-------------|--------|-------------|
| NFR-501 | 로그인 응답 시간 | < 1000ms | 서버 로그 (PBKDF2 포함) |
| NFR-502 | JWT 검증 시간 | < 10ms | 미들웨어 측정 |
| NFR-503 | 하트비트 응답 시간 | < 50ms | API 응답 시간 |
| NFR-504 | Rate Limit 검사 시간 | < 5ms | 미들웨어 측정 |
| NFR-505 | SSL 핸드셰이크 시간 | < 200ms | TLS 연결 측정 |
| NFR-506 | OTP 이메일 전송 시간 | < 15s | SMTP 응답 (재시도 포함) |

### 5.2 Reliability Requirements

| ID | Requirement | Description |
|----|-------------|-------------|
| NFR-601 | 암호화 무결성 | AES-GCM Auth Tag 검증 실패 시 복호화 거부 |
| NFR-602 | 토큰 블랙리스트 지속성 | 서버 재시작 시 블랙리스트 초기화 허용 (토큰 만료 시간 내) |
| NFR-603 | 설정 파일 백업 | 암호화 변환 전 .bak 파일 생성 |
| NFR-604 | SMTP 실패 복구 | 3회 재시도 후 명확한 에러 반환 |
| NFR-605 | SSL 인증서 갱신 | 만료 30일 전 경고 로그 출력 |

### 5.3 Security Requirements

| ID | Requirement | Standard |
|----|-------------|----------|
| NFR-701 | 비밀번호 저장 | 평문 저장 금지, 암호화 필수 |
| NFR-702 | 전송 암호화 | TLS 1.2 이상 필수 |
| NFR-703 | 세션 관리 | JWT 만료 시간 필수, 블랙리스트 지원 |
| NFR-704 | 접근 제어 | 인증 없이 보호된 리소스 접근 불가 |
| NFR-705 | 감사 추적 | 모든 인증 관련 이벤트 로깅 |
| NFR-706 | 입력 검증 | 모든 사용자 입력 검증 |

### 5.4 Compatibility Requirements

| ID | Requirement | Target | Verification |
|----|-------------|--------|--------------|
| NFR-801 | Node.js 버전 | 18.x, 20.x, 22.x | CI/CD 매트릭스 테스트 |
| NFR-802 | 브라우저 | Chrome 90+, Firefox 88+, Edge 90+, Safari 14+ | Playwright E2E 테스트 |
| NFR-803 | OS | Windows 10+, Ubuntu 20.04+, macOS 12+ | GitHub Actions 매트릭스 |

### 5.5 Measurement Methods

| NFR-ID | 측정 도구 | 측정 주기 | 임계값 |
|--------|----------|----------|--------|
| NFR-501 | Server-side timing middleware | 매 요청 | p99 < 1000ms |
| NFR-502 | Benchmark script (1000 iterations) | 릴리스 시 | avg < 10ms |
| NFR-503 | API response time header | 매 요청 | p95 < 50ms |
| NFR-504 | Middleware profiling | 릴리스 시 | max < 5ms |
| NFR-505 | openssl s_time | 릴리스 시 | avg < 200ms |
| NFR-506 | SMTP response logging | 매 요청 | max < 15s |

---

## 6. Configuration Schema

### 6.1 Complete config.json5 Structure

```json5
{
  // ===== Server Settings (Step 1) =====
  server: {
    port: 4242,                          // integer, 1-65535
  },

  // ===== PTY Settings (Step 1) =====
  pty: {
    termName: "xterm-256color",          // string
    defaultCols: 80,                     // integer, 10-500
    defaultRows: 24,                     // integer, 5-200
    useConpty: true,                     // boolean
    maxBufferSize: 65536,                // integer, bytes
  },

  // ===== Session Settings (Step 1 + Step 2) =====
  session: {
    idleDelayMs: 200,                    // Step 1
    durationMs: 1800000,                 // Step 2: 30min default
    maxDurationMs: 86400000,             // Step 2: 24hr max
    jwtSecret: "",                       // Step 2: auto-generate if empty
  },

  // ===== Authentication (Step 2) =====
  auth: {
    password: "",                        // plaintext → enc() on boot
  },

  // ===== Two-Factor Auth (Step 2) =====
  twoFactor: {
    enabled: false,                      // boolean
    email: "",                           // required if enabled
    otpLength: 6,                        // 4-8
    otpExpiryMs: 300000,                 // 60000-600000
    smtp: {
      host: "",                          // required if enabled
      port: 587,                         // 1-65535
      secure: false,                     // boolean
      auth: {
        user: "",                        // required
        password: "",                    // auto-encrypt
      }
    }
  },

  // ===== SSL Settings (Step 2) =====
  ssl: {
    certPath: "",                        // auto-generate if empty
    keyPath: "",                         // auto-generate if empty
    caPath: "",                          // optional
  },

  // ===== Security Settings (Step 2) =====
  security: {
    maxLoginAttempts: 5,                 // 1-100
    lockoutDurationMs: 900000,           // 60000-86400000
    lockoutMultiplier: 2.0,              // 1.0-10.0

    rateLimit: {
      windowMs: 60000,                   // 1000-3600000
      maxRequests: 100,                  // 1-10000
      loginMaxRequests: 10,              // 1-100
    },

    cors: {
      allowedOrigins: [],                // empty = same-origin only
      allowCredentials: true,
      maxAge: 86400,
      allowedMethods: ["GET", "POST", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
    },

    envFilter: {
      blockPatterns: ["*_SECRET", "*_KEY", "*_PASSWORD", "*_TOKEN"],
      blockPrefixes: ["AWS_", "AZURE_", "GCP_"],
      allowList: ["PATH", "HOME", "TERM", "LANG", "USER", "SHELL"],
    },

    ipBlacklist: [],                     // manual block list
    autoBlacklistThreshold: 10,          // 1-100
    autoBlacklistDurationMs: 86400000,   // ms
  },

  // ===== Logging Settings (Step 2) =====
  logging: {
    level: "info",                       // debug, info, warn, error
    securityLog: true,
    auditLog: true,
    logDir: "./logs",
    maxFileSize: "10MB",
    maxFiles: 30,
    compress: true,
  },
}
```

### 6.2 Configuration Validation Rules

| Field Path | Type | Constraints | Default |
|------------|------|-------------|---------|
| server.port | integer | 1-65535 | 4242 |
| session.durationMs | integer | 60000-86400000 | 1800000 |
| security.maxLoginAttempts | integer | 1-100 | 5 |
| security.lockoutDurationMs | integer | 60000-86400000 | 900000 |
| security.rateLimit.maxRequests | integer | 1-10000 | 100 |
| twoFactor.otpLength | integer | 4-8 | 6 |
| twoFactor.otpExpiryMs | integer | 60000-600000 | 300000 |
| logging.level | enum | debug\|info\|warn\|error | info |

---

## 7. API Endpoints

### 7.1 Authentication Endpoints

| Method | Endpoint | Auth | Rate Limit | Description |
|--------|----------|------|------------|-------------|
| POST | `/api/auth/login` | No | 10/min | Password authentication |
| POST | `/api/auth/verify` | No | 10/min | 2FA OTP verification |
| POST | `/api/auth/heartbeat` | Yes | 100/min | Session refresh |
| POST | `/api/auth/logout` | Yes | 100/min | Session termination |

### 7.2 Protected Session Endpoints

| Method | Endpoint | Auth | Rate Limit | Description |
|--------|----------|------|------------|-------------|
| GET | `/api/sessions` | Yes | 100/min | List all sessions |
| POST | `/api/sessions` | Yes | 100/min | Create session |
| GET | `/api/sessions/:id` | Yes | 100/min | Get session details |
| DELETE | `/api/sessions/:id` | Yes | 100/min | Delete session |
| POST | `/api/sessions/:id/input` | Yes | 1000/min | Send terminal input |
| POST | `/api/sessions/:id/resize` | Yes | 100/min | Resize terminal |
| GET | `/api/sessions/:id/stream` | Yes | 100/min | SSE output stream |

### 7.3 Request/Response Specifications

#### POST /api/auth/login

**Request**:
```http
POST /api/auth/login HTTP/1.1
Host: localhost:4242
Content-Type: application/json

{
  "password": "mySecretPassword"
}
```

**Response (200, 2FA disabled)**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 1800000
}
```

**Response (200, 2FA enabled)**:
```json
{
  "success": true,
  "requires2FA": true,
  "tempToken": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Verification code sent to a***@example.com"
}
```

**Response (401)**:
```json
{
  "error": {
    "code": "INVALID_PASSWORD",
    "message": "Invalid password"
  }
}
```

**Response (403)**:
```json
{
  "error": {
    "code": "ACCOUNT_LOCKED",
    "message": "Account is locked",
    "details": {
      "lockedUntil": "2026-01-12T10:45:00Z",
      "remainingMs": 540000
    }
  }
}
```

#### POST /api/auth/verify

**Request**:
```http
POST /api/auth/verify HTTP/1.1
Content-Type: application/json

{
  "tempToken": "550e8400-e29b-41d4-a716-446655440000",
  "otpCode": "123456"
}
```

**Response (200)**:
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "expiresIn": 1800000
}
```

#### POST /api/auth/heartbeat

**Request**:
```http
POST /api/auth/heartbeat HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**Response (200)**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...(new)",
  "expiresIn": 1800000
}
```

---

## 8. Error Codes

### 8.1 Complete Error Code Reference

| HTTP | Code | Description | Retry |
|------|------|-------------|-------|
| 400 | INVALID_REQUEST | Malformed request body | No |
| 400 | INVALID_PASSWORD_FORMAT | Password format invalid | No |
| 400 | INVALID_OTP_FORMAT | OTP format invalid | No |
| 400 | INVALID_SESSION_NAME | Session name invalid | No |
| 400 | INVALID_TERMINAL_SIZE | Terminal size out of range | No |
| 401 | MISSING_TOKEN | Authorization header missing | No |
| 401 | INVALID_TOKEN | Token format invalid | No |
| 401 | INVALID_SIGNATURE | Token signature mismatch | No |
| 401 | TOKEN_EXPIRED | Token has expired | No |
| 401 | TOKEN_REVOKED | Token has been revoked | No |
| 401 | INVALID_PASSWORD | Password does not match | Yes* |
| 401 | INVALID_OTP | OTP does not match | Yes* |
| 401 | OTP_EXPIRED | OTP has expired | No |
| 401 | INVALID_TEMP_TOKEN | Temp token not found | No |
| 403 | ACCOUNT_LOCKED | Too many failed attempts | After lockout |
| 403 | IP_BLACKLISTED | IP address is blocked | After unblock |
| 403 | SESSION_NOT_OWNED | Session belongs to another user | No |
| 404 | SESSION_NOT_FOUND | Session does not exist | No |
| 429 | RATE_LIMITED | Too many requests | After retryAfter |
| 500 | INTERNAL_ERROR | Server error | Yes |
| 500 | SMTP_ERROR | Email sending failed | Yes |
| 503 | SERVICE_UNAVAILABLE | Server is starting | Yes |

*With progressive delay

### 8.2 Error Response Format

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": { },
    "retryAfter": 60000
  }
}
```

---

## 9. Frontend Requirements

### 9.1 Login Page (FE-100)

#### FE-101: Login Form
- **Components**:
  - Password input field (type="password")
  - Login button (disabled until password entered)
  - Error message display area
  - Loading spinner during authentication
- **Validation**:
  - Password: 1-128자, 빈 값 제출 방지
- **Behavior**:
  - Enter 키로 제출 가능
  - 로그인 중 버튼 비활성화
  - 실패 시 에러 메시지 표시 (잠금 시 남은 시간 포함)

#### FE-102: 2FA Verification Form
- **Trigger**: 로그인 응답에 `requires2FA: true` 포함 시
- **Components**:
  - 6자리 OTP 입력 필드 (숫자만 허용)
  - 이메일 마스킹 표시 (예: a***@example.com)
  - 남은 유효시간 카운트다운
  - 재전송 버튼 (60초 쿨다운)
- **Behavior**:
  - 자동 포커스
  - 6자리 입력 시 자동 제출
  - 만료 시 로그인 폼으로 리다이렉트

### 9.2 Session Management (FE-200)

#### FE-201: Token Storage
- **Storage**: localStorage 또는 sessionStorage
- **Key**: `auth_token`
- **Format**: JWT 문자열
- **Security**:
  - XSS 방지: CSP 헤더와 함께 사용
  - 로그아웃 시 즉시 삭제

#### FE-202: Heartbeat Implementation
```typescript
interface HeartbeatConfig {
  intervalMs: number;        // sessionDurationMs / 2
  maxRetries: number;        // 1
  onTokenRefresh: (token: string) => void;
  onSessionExpired: () => void;
}

class HeartbeatManager {
  private timer: number | null = null;

  start(config: HeartbeatConfig): void;
  stop(): void;
  private async sendHeartbeat(): Promise<void>;
}
```
- **Lifecycle**:
  1. 로그인 성공 → start()
  2. 하트비트 성공 → 토큰 갱신, 타이머 재시작
  3. 1회 실패 → 즉시 재시도
  4. 2회 연속 실패 → onSessionExpired() 호출
  5. 로그아웃 → stop()

#### FE-203: Session Expiry Handling
- **Detection**:
  - API 응답 401 TOKEN_EXPIRED
  - 하트비트 2회 연속 실패
- **Actions**:
  1. localStorage에서 토큰 삭제
  2. "세션이 만료되었습니다" 알림 표시
  3. 로그인 페이지로 리다이렉트 (3초 후)

### 9.3 API Client (FE-300)

#### FE-301: Request Interceptor
```typescript
// 모든 요청에 Authorization 헤더 자동 추가
axios.interceptors.request.use((config) => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
```

#### FE-302: Response Interceptor
```typescript
// 401 응답 시 자동 처리
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const code = error.response.data?.error?.code;
      if (code === 'TOKEN_EXPIRED' || code === 'TOKEN_REVOKED') {
        handleSessionExpired();
      }
    }
    return Promise.reject(error);
  }
);
```

### 9.4 UI State Machine (FE-400)

```
                    ┌─────────────┐
                    │   INITIAL   │
                    └──────┬──────┘
                           │ check token
                           ▼
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       ┌─────────────┐           ┌─────────────┐
       │   LOGIN     │           │ AUTHENTICATED│
       └──────┬──────┘           └──────┬──────┘
              │                         │
    ┌─────────┼─────────┐       ┌───────┼───────┐
    ▼         ▼         ▼       ▼       │       ▼
┌───────┐ ┌───────┐ ┌───────┐   │  ┌────────┐  │
│SUCCESS│ │2FA_REQ│ │ ERROR │   │  │HEARTBEAT│ │
└───┬───┘ └───┬───┘ └───────┘   │  └────────┘  │
    │         │                 │       │      │
    │    ┌────┴────┐            │       │      │
    │    ▼         ▼            │       ▼      │
    │ ┌─────┐ ┌────────┐        │   ┌───────┐  │
    │ │VERIFY│ │OTP_ERR │       │   │REFRESH│  │
    │ └──┬──┘ └────────┘        │   └───────┘  │
    │    │                      │              │
    └────┴──────────────────────┘              │
                                               ▼
                                        ┌─────────────┐
                                        │  LOGGED_OUT │
                                        └─────────────┘
```

---

## 10. Implementation Dependencies

### 10.1 Required NPM Packages

| Package | Version | Purpose | FR Reference |
|---------|---------|---------|--------------|
| jsonwebtoken | ^9.0.0 | JWT creation/verification | FR-801~804 |
| nodemailer | ^6.9.0 | Email sending | FR-703 |
| express-rate-limit | ^7.0.0 | Rate limiting | FR-1004 |
| helmet | ^7.0.0 | Security headers | FR-1301 |
| winston | ^3.11.0 | Logging | FR-1401~1402 |
| winston-daily-rotate-file | ^5.0.0 | Log rotation | FR-1402 |
| zod | ^3.22.0 | Input validation | FR-1501 |
| selfsigned | ^2.4.0 | SSL cert generation | FR-1102 |

### 10.2 Node.js Built-in Modules

| Module | Purpose | FR Reference |
|--------|---------|--------------|
| crypto | Encryption, hashing | FR-601~603, FR-702 |
| https | HTTPS server | FR-1103 |
| tls | TLS configuration | FR-1104 |
| fs | Config file R/W | FR-601, FR-1102 |

---

## 11. Testing Requirements

### 11.1 Security Test Cases

| TC-ID | Requirement | Test Description | Expected Result |
|-------|-------------|------------------|-----------------|
| TC-601 | FR-601 | 평문 비밀번호 설정 후 재시작 | enc() 형식으로 변환 |
| TC-602 | FR-603 | 올바른 비밀번호로 로그인 | 200 OK + JWT |
| TC-603 | FR-603 | 잘못된 비밀번호로 로그인 | 401 INVALID_PASSWORD |
| TC-701 | FR-702 | OTP 생성 | 6자리 숫자 |
| TC-702 | FR-704 | 만료된 OTP로 검증 | 401 OTP_EXPIRED |
| TC-801 | FR-803 | 만료된 JWT로 요청 | 401 TOKEN_EXPIRED |
| TC-802 | FR-803 | 블랙리스트 JWT로 요청 | 401 TOKEN_REVOKED |
| TC-901 | FR-902 | 하트비트 후 새 토큰 | 새 토큰 발급 |
| TC-1001 | FR-1002 | 5회 연속 로그인 실패 | 403 ACCOUNT_LOCKED |
| TC-1002 | FR-1004 | 101번째 요청 | 429 RATE_LIMITED |
| TC-1101 | FR-1102 | SSL 경로 비움 | 자체 서명 인증서 생성 |
| TC-1102 | FR-1103 | HTTP로 접속 시도 | HTTPS로 리다이렉트 |
| TC-1601 | FR-1601 | 다른 토큰으로 세션 접근 | 403 SESSION_NOT_OWNED |

### 11.2 Performance Test Cases

| TC-ID | Requirement | Condition | Target |
|-------|-------------|-----------|--------|
| TC-P01 | NFR-501 | 로그인 요청 | < 1000ms |
| TC-P02 | NFR-502 | JWT 검증 (1000회) | 평균 < 10ms |
| TC-P03 | NFR-503 | 하트비트 (100회) | 평균 < 50ms |
| TC-P04 | NFR-504 | Rate Limit 검사 | < 5ms |

---

## 12. Implementation Checklist

### 12.1 Functional Requirements

- [ ] FR-601: 평문 비밀번호 자동 암호화
- [ ] FR-602: AES-256-GCM 암호화 구현
- [ ] FR-603: 비밀번호 검증 (timing-safe)
- [ ] FR-701: 2FA 설정 구조 정의
- [ ] FR-702: OTP 생성 구현
- [ ] FR-703: 이메일 발송 구현
- [ ] FR-704: OTP 검증 구현
- [ ] FR-801: JWT 토큰 구조 정의
- [ ] FR-802: 토큰 발급 구현
- [ ] FR-803: 토큰 검증 미들웨어
- [ ] FR-804: JWT Secret 자동 생성
- [ ] FR-901: 세션 시간 설정
- [ ] FR-902: 하트비트 엔드포인트
- [ ] FR-903: 클라이언트 하트비트
- [ ] FR-904: 로그아웃 구현
- [ ] FR-1001: 로그인 시도 추적
- [ ] FR-1002: 계정 잠금 구현
- [ ] FR-1003: Progressive Delay 구현
- [ ] FR-1004: Rate Limiting 미들웨어
- [ ] FR-1005: IP Blacklist 구현
- [ ] FR-1101: SSL 설정 구현
- [ ] FR-1102: 자체 서명 인증서 자동 생성
- [ ] FR-1103: HTTPS Only 구현
- [ ] FR-1104: TLS 설정 구현
- [ ] FR-1201: CORS 정책 강화
- [ ] FR-1301: 보안 헤더 적용
- [ ] FR-1401: 감사 로깅 구현
- [ ] FR-1402: 로그 로테이션 구현
- [ ] FR-1501: 입력 검증 구현
- [ ] FR-1502: 명령 주입 방지
- [ ] FR-1601: 세션 소유권 확인
- [ ] FR-1701: 환경변수 필터링

### 12.2 Non-Functional Requirements

- [ ] NFR-501~506: 성능 테스트 통과
- [ ] NFR-601~605: 신뢰성 테스트 통과
- [ ] NFR-701~706: 보안 테스트 통과
- [ ] NFR-801~803: 호환성 테스트 통과

---

## 13. Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-01-12 | Claude | Initial Step 2 SRS |
| 1.1.0 | 2026-01-12 | Claude | Added: UR mapping, NFR, Error Recovery, Boundary Conditions, Test Cases, Dependencies |
| 1.2.0 | 2026-01-12 | Claude | Added: Frontend Requirements (FE-100~400), Measurement Methods (5.5), UI State Machine |

---

## 14. References

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [JWT Best Practices (RFC 8725)](https://datatracker.ietf.org/doc/html/rfc8725)
- [Node.js Crypto Documentation](https://nodejs.org/api/crypto.html)
- [Nodemailer Documentation](https://nodemailer.com/)
- [Express Rate Limit](https://www.npmjs.com/package/express-rate-limit)
- [IEEE 830-1998 SRS Standard](https://standards.ieee.org/standard/830-1998.html)
- [Mozilla TLS Configuration](https://wiki.mozilla.org/Security/Server_Side_TLS)
