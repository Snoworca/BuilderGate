# Integration Test Guide

**Version**: 1.0.0
**Date**: 2026-01-12
**Source**: SRS Step 2 (srs.step2.md)

---

## 1. Integration Test Purpose

### 1.1 Original Intent (SRS에서 추출)

Claude Web Shell Step 2의 핵심 목표:
- **프로덕션 환경에서 안전하게 사용 가능한 수준의 보안 구현**
- 인증, 암호화, 세션 관리, SSL/TLS, 공격 방어

### 1.2 Verification Goals

시스템 전체가 달성해야 할 것:
1. 인증 없이 보호된 리소스 접근 불가
2. 비밀번호, 토큰 등 민감 정보가 안전하게 처리됨
3. 무차별 대입 공격에 대한 방어
4. 모든 통신이 TLS로 암호화됨
5. 세션이 안전하게 관리되고 적시에 만료됨
6. 감사 추적이 가능한 로깅

---

## 2. End-to-End Test Scenarios

### Scenario 1: Complete Authentication Flow (2FA Disabled)

**Purpose**: 기본 인증 흐름 검증

```
Given:
  - HTTPS 서버 실행 중
  - config.json5에 비밀번호 "testPassword123" 설정
  - twoFactor.enabled = false
  - 브라우저에서 https://localhost:4242 접속

When:
  1. 로그인 페이지 표시 확인
  2. 잘못된 비밀번호 "wrongPassword" 입력
  3. 올바른 비밀번호 "testPassword123" 입력
  4. 터미널 화면 진입 확인
  5. "ls" 명령어 실행
  6. 로그아웃 버튼 클릭

Then:
  - Step 1: 로그인 폼이 화면에 표시됨
  - Step 2: "Invalid password" 에러 메시지
  - Step 3: 로그인 성공, 토큰 저장됨
  - Step 4: 터미널 UI 표시, 세션 생성됨
  - Step 5: 명령어 출력 표시
  - Step 6: 토큰 삭제, 로그인 페이지로 리다이렉트
```

### Scenario 2: Complete Authentication Flow (2FA Enabled)

**Purpose**: 2단계 인증 흐름 검증

```
Given:
  - HTTPS 서버 실행 중
  - twoFactor.enabled = true
  - 유효한 SMTP 설정
  - 이메일 수신 가능한 환경

When:
  1. 올바른 비밀번호 입력
  2. 2FA 입력 폼 표시 확인
  3. 이메일에서 OTP 코드 확인
  4. OTP 코드 입력
  5. 터미널 화면 진입 확인

Then:
  - Step 1: "Verification code sent to a***@example.com"
  - Step 2: OTP 입력 필드, 카운트다운 타이머
  - Step 3: 6자리 숫자 코드 이메일 수신
  - Step 4: 로그인 성공, 토큰 발급
  - Step 5: 터미널 UI 표시
```

### Scenario 3: Session Management & Heartbeat

**Purpose**: 세션 유지 및 갱신 검증

```
Given:
  - 로그인 완료된 상태
  - session.durationMs = 300000 (5분)
  - 하트비트 간격 = 150000 (2.5분)

When:
  1. 로그인 후 2.5분 대기
  2. 하트비트 발생 확인
  3. 추가 2.5분 대기
  4. 두 번째 하트비트 확인
  5. 네트워크 연결 끊기
  6. 하트비트 재시도 확인

Then:
  - Step 1-2: 새 토큰 발급, localStorage 업데이트
  - Step 3-4: 계속 세션 유지
  - Step 5-6: 1회 재시도 후 세션 만료 처리
```

### Scenario 4: Brute Force Protection

**Purpose**: 무차별 대입 공격 방어 검증

```
Given:
  - security.maxLoginAttempts = 5
  - security.lockoutDurationMs = 60000 (1분)
  - 올바른 비밀번호: "correctPassword"

When:
  1. 잘못된 비밀번호로 5회 연속 로그인 시도
  2. 6번째 로그인 시도
  3. 1분 대기
  4. 올바른 비밀번호로 로그인 시도

Then:
  - Step 1: 각 시도마다 프로그레시브 딜레이 (200ms, 400ms, 800ms, ...)
  - Step 2: 403 ACCOUNT_LOCKED, remainingMs 표시
  - Step 3: 잠금 해제
  - Step 4: 로그인 성공
```

### Scenario 5: Rate Limiting

**Purpose**: API 요청 속도 제한 검증

```
Given:
  - security.rateLimit.maxRequests = 100
  - security.rateLimit.loginMaxRequests = 10
  - security.rateLimit.windowMs = 60000

When:
  1. 10초 내에 로그인 요청 11회 시도
  2. 1분 대기
  3. 다시 로그인 요청

Then:
  - Step 1: 11번째 요청에서 429 RATE_LIMITED
  - Step 2: 윈도우 리셋
  - Step 3: 요청 허용
```

### Scenario 6: Session Ownership

**Purpose**: PTY 세션 소유권 검증

```
Given:
  - 사용자 A 로그인 후 세션 생성
  - 사용자 A의 세션 ID: "session-123"

When:
  1. 사용자 A가 세션에서 명령 실행
  2. 사용자 A 로그아웃
  3. 사용자 A 다시 로그인 (새 토큰)
  4. 기존 세션 "session-123" 접근 시도
  5. 새 세션 생성

Then:
  - Step 1: 명령 실행 성공
  - Step 2: 로그아웃 완료
  - Step 3: 새 토큰 발급
  - Step 4: 403 SESSION_NOT_OWNED (토큰 체인 깨짐)
  - Step 5: 새 세션 생성 성공
```

### Scenario 7: HTTPS & Security Headers

**Purpose**: 전송 보안 검증

```
Given:
  - HTTPS 서버 실행 중
  - 자체 서명 또는 유효한 인증서

When:
  1. HTTP로 접속 시도 (http://localhost:4242)
  2. HTTPS로 접속 (https://localhost:4242)
  3. TLS 1.1로 연결 시도
  4. 응답 헤더 확인

Then:
  - Step 1: HTTPS로 리다이렉트 (301)
  - Step 2: 연결 성공
  - Step 3: 연결 거부
  - Step 4: 보안 헤더 포함
    - Strict-Transport-Security
    - X-Content-Type-Options: nosniff
    - X-Frame-Options: DENY
    - Content-Security-Policy
```

### Scenario 8: Environment Variable Filtering

**Purpose**: 민감한 환경변수 보호 검증

```
Given:
  - 서버 환경: AWS_SECRET_ACCESS_KEY="secret123"
  - 서버 환경: PATH="/usr/bin"
  - envFilter 기본 설정

When:
  1. 로그인 후 세션 생성
  2. 터미널에서 "echo $AWS_SECRET_ACCESS_KEY" 실행
  3. 터미널에서 "echo $PATH" 실행

Then:
  - Step 1: 세션 생성 성공
  - Step 2: 빈 출력 (환경변수 필터링됨)
  - Step 3: PATH 값 출력됨
```

### Scenario 9: Audit Logging

**Purpose**: 보안 감사 로깅 검증

```
Given:
  - logging.securityLog = true
  - logs/security.log 파일

When:
  1. 로그인 성공
  2. 로그인 실패
  3. 세션 생성
  4. 로그아웃
  5. Rate limit 초과

Then:
  - Step 1: LOGIN_SUCCESS 이벤트 로깅
  - Step 2: LOGIN_FAILED 이벤트 로깅
  - Step 3: SESSION_CREATED 이벤트 로깅
  - Step 4: TOKEN_REVOKED 이벤트 로깅
  - Step 5: RATE_LIMITED 이벤트 로깅
  - 모든 로그에 timestamp, ip, userAgent 포함
  - 로그에 password, token 값 없음
```

---

## 3. Component Integration Verification

| Component A | Component B | Integration Point | Verification Method |
|-------------|-------------|-------------------|---------------------|
| Frontend LoginForm | Backend /api/auth/login | HTTP POST | E2E test: successful login |
| Frontend useHeartbeat | Backend /api/auth/heartbeat | Token refresh | E2E test: session persistence |
| AuthMiddleware | SessionRoutes | JWT verification | API test: protected routes |
| AuthService | CryptoService | Password validation | Unit test: timing-safe compare |
| TwoFactorService | SMTP | Email delivery | Integration test: OTP email |
| RateLimitService | authRoutes | Request throttling | Load test: rate limit |
| SSLService | Express HTTPS | Certificate loading | Integration test: TLS handshake |
| EnvFilterService | SessionManager | Environment filtering | Unit test: filtered env |
| AuditService | All services | Event logging | Log analysis |

---

## 4. Integration Test Code Structure

### 4.1 Test Setup

```typescript
// tests/integration/setup.ts
import { createServer } from '../../server/src';
import { tokenStorage } from '../../frontend/src/services/tokenStorage';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Allow self-signed cert
  server = await createServer({ port: 0 }); // Random port
  baseUrl = `https://localhost:${server.address().port}`;
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  tokenStorage.clearToken();
});
```

### 4.2 Test Helpers

```typescript
// tests/integration/helpers.ts
export async function login(password: string): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
}

export async function authenticatedFetch(
  url: string,
  token: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(`${baseUrl}${url}`, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    }
  });
}

export async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### 4.3 Example Test Cases

```typescript
// tests/integration/auth.test.ts
describe('Authentication Integration', () => {
  describe('Login Flow', () => {
    it('should login successfully with correct password', async () => {
      const response = await login('correctPassword');
      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.token).toBeDefined();
      expect(data.expiresIn).toBeGreaterThan(0);
    });

    it('should reject incorrect password', async () => {
      const response = await login('wrongPassword');
      expect(response.status).toBe(401);

      const data = await response.json();
      expect(data.error.code).toBe('INVALID_PASSWORD');
    });

    it('should lock account after 5 failures', async () => {
      for (let i = 0; i < 5; i++) {
        await login('wrong');
      }

      const response = await login('wrong');
      expect(response.status).toBe(403);

      const data = await response.json();
      expect(data.error.code).toBe('ACCOUNT_LOCKED');
      expect(data.error.details.remainingMs).toBeGreaterThan(0);
    });
  });

  describe('Protected Routes', () => {
    it('should reject request without token', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`);
      expect(response.status).toBe(401);
    });

    it('should accept request with valid token', async () => {
      const loginResponse = await login('correctPassword');
      const { token } = await loginResponse.json();

      const response = await authenticatedFetch('/api/sessions', token);
      expect(response.status).toBe(200);
    });
  });
});
```

```typescript
// tests/integration/session.test.ts
describe('Session Management Integration', () => {
  let token: string;

  beforeEach(async () => {
    const response = await login('correctPassword');
    const data = await response.json();
    token = data.token;
  });

  it('should create session with ownership', async () => {
    const response = await authenticatedFetch('/api/sessions', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Session' })
    });

    expect(response.status).toBe(201);
    const session = await response.json();
    expect(session.id).toBeDefined();
    expect(session.name).toBe('Test Session');
  });

  it('should refresh token via heartbeat', async () => {
    const response = await authenticatedFetch('/api/auth/heartbeat', token, {
      method: 'POST'
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.token).toBeDefined();
    expect(data.token).not.toBe(token); // New token
  });
});
```

---

## 5. Performance & Load Testing

### 5.1 Performance Test Cases

| TC-ID | Requirement | Condition | Target |
|-------|-------------|-----------|--------|
| TC-P01 | NFR-501 | Login request | < 1000ms |
| TC-P02 | NFR-502 | JWT verification (1000x) | avg < 10ms |
| TC-P03 | NFR-503 | Heartbeat (100x) | avg < 50ms |
| TC-P04 | NFR-504 | Rate limit check | < 5ms |
| TC-P05 | NFR-505 | TLS handshake | < 200ms |
| TC-P06 | NFR-506 | OTP email | < 15s |

### 5.2 Load Test Script

```typescript
// tests/load/rate-limit.test.ts
describe('Rate Limit Load Test', () => {
  it('should handle burst of login requests', async () => {
    const requests = Array(15).fill(null).map(() =>
      login('anyPassword').then(r => r.status)
    );

    const results = await Promise.all(requests);

    // First 10 should be processed (pass or fail)
    const processed = results.filter(s => s !== 429).length;
    expect(processed).toBeLessThanOrEqual(10);

    // Rest should be rate limited
    const limited = results.filter(s => s === 429).length;
    expect(limited).toBeGreaterThanOrEqual(5);
  });
});
```

---

## 6. Original Purpose Achievement Verification

| 요구사항 ID | 설명 | 검증 방법 | 예상 결과 |
|------------|------|----------|----------|
| UR-001 | 평문 비밀번호 자동 암호화 | 서버 재시작 후 config.json5 확인 | enc(...) 형식 |
| UR-002 | 2단계 인증 지원 | Scenario 2 실행 | OTP 이메일 수신, 검증 성공 |
| UR-003 | JWT 토큰 방식 인증 | 모든 인증 시나리오 | JWT 발급, 검증, 갱신 |
| UR-004 | 세션 유지시간 설정 | Scenario 3 실행 | 설정된 시간 후 만료 |
| UR-005 | 하트비트로 세션 유지 | Scenario 3 실행 | interval마다 토큰 갱신 |
| UR-006 | 무차별 대입 공격 방지 | Scenario 4, 5 실행 | 잠금, Rate limit |
| UR-007 | SSL 인증서 자동 생성 | 서버 시작 | certs/ 디렉토리 생성 |

---

## 7. Security Checklist

### 7.1 OWASP Top 10 Coverage

| # | OWASP | 대응 | 검증 |
|---|-------|------|------|
| A01 | Broken Access Control | Session ownership, Auth middleware | Scenario 6 |
| A02 | Cryptographic Failures | AES-256-GCM, TLS 1.2+ | Scenario 7 |
| A03 | Injection | Input validation, Zod schemas | Manual review |
| A04 | Insecure Design | Security-first architecture | Architecture review |
| A05 | Security Misconfiguration | Secure defaults, Helmet | Scenario 7 |
| A06 | Vulnerable Components | Latest stable versions | npm audit |
| A07 | Auth Failures | JWT, 2FA, Rate limiting | Scenario 1-5 |
| A08 | Integrity Failures | HMAC signatures, Auth tags | Unit tests |
| A09 | Logging Failures | Audit logging | Scenario 9 |
| A10 | SSRF | N/A (no external requests) | N/A |

### 7.2 Security Headers Verification

```bash
# Verify security headers
curl -I https://localhost:4242/api/health | grep -E "(Strict-Transport|X-Content-Type|X-Frame|Content-Security)"
```

Expected output:
```
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Content-Security-Policy: default-src 'self'; ...
```

### 7.3 TLS Configuration Verification

```bash
# Verify TLS version
openssl s_client -connect localhost:4242 -tls1_1 2>&1 | grep -i "protocol"
# Expected: Connection refused or error

openssl s_client -connect localhost:4242 -tls1_2 2>&1 | grep -i "protocol"
# Expected: Protocol  : TLSv1.2

openssl s_client -connect localhost:4242 -tls1_3 2>&1 | grep -i "protocol"
# Expected: Protocol  : TLSv1.3
```

---

## 8. Test Environment Setup

### 8.1 Prerequisites

```bash
# Install dependencies
cd server && npm install
cd ../frontend && npm install

# Start server in test mode
NODE_ENV=test npm run dev
```

### 8.2 Test Configuration

```json5
// server/config.test.json5
{
  server: { port: 4243 },
  auth: { password: "testPassword123" },
  session: { durationMs: 60000 },  // 1 minute for faster testing
  twoFactor: { enabled: false },
  security: {
    maxLoginAttempts: 3,
    lockoutDurationMs: 10000,  // 10 seconds
    rateLimit: {
      windowMs: 10000,
      maxRequests: 20,
      loginMaxRequests: 5
    }
  },
  logging: {
    level: "debug",
    securityLog: true
  }
}
```

### 8.3 Running Tests

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests
npm run test:e2e

# All tests
npm run test
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-01-12 | Claude | Initial integration test guide |
