# SRS: Google Authenticator TOTP 인증 추가

**문서 ID**: SRS-TOTP-2026-04-08  
**프로젝트**: BuilderGate  
**작성일**: 2026-04-08  
**버전**: 1.0.0  
**상태**: 확정

---

## 목차

1. [개요](#1-개요)
2. [기능 요구사항](#2-기능-요구사항)
3. [비기능 요구사항](#3-비기능-요구사항)
4. [데이터 요구사항](#4-데이터-요구사항)
5. [인터페이스 요구사항](#5-인터페이스-요구사항)
6. [제약사항](#6-제약사항)
7. [인수 조건](#7-인수-조건)

---

## 1. 개요

### 1.1 프로젝트 범위

BuilderGate는 단일 관리자가 localhost에서 운용하는 웹 기반 터미널 환경이다. 현재 비밀번호 인증과 선택적 이메일 OTP(2FA)를 지원한다. 본 SRS는 **Google Authenticator 호환 TOTP(Time-based One-Time Password)** 를 추가 인증 수단으로 통합하는 작업을 정의한다.

**범위 내(In-scope)**:
- TOTPService 신규 구현 (secret 생성, QR 코드 콘솔 출력, TOTP 검증)
- `data/totp.secret` 파일 기반 secret 관리 (CryptoService 암호화 재사용)
- 4가지 인증 조합에 따른 다단계 로그인 플로우
- 이메일 장애 시 TOTP 폴백 처리
- `localhostPasswordOnly` 옵션 추가
- Zod schema 수정 (TOTP-only 설정 허용)
- Frontend TwoFactorForm 확장 (TOTP 전용 화면)
- AuthContext 및 AuthState 확장 (다단계 stage 지원)

**범위 외(Out-of-scope)**:
- 설정 페이지 UI 변경 (config.json5 직접 수정만 지원)
- 다중 사용자 계정
- TOTP secret 웹 UI 등록
- TOTP 백업 코드 기능

### 1.2 비즈니스 목표

| 목표 | 설명 |
|------|------|
| 보안 강화 | 비밀번호 단독 노출 시에도 인증 우회 불가 |
| 유연성 | 이메일/TOTP를 독립적으로 활성화 가능 |
| 가용성 | 이메일 장애 시 TOTP 폴백으로 운용 중단 방지 |
| 단순성 | 서버 재시작 시 콘솔 QR 출력으로 별도 등록 UI 불필요 |

### 1.3 4가지 인증 조합 시나리오

| 시나리오 ID | twoFactor.enabled | twoFactor.totp.enabled | 로그인 플로우 |
|------------|-------------------|------------------------|--------------|
| **COMBO-1** | false | - | 비밀번호만 → JWT 발급 |
| **COMBO-2** | true | false | 비밀번호 → 이메일 OTP → JWT 발급 |
| **COMBO-3** | true | true (smtp 없음) | 비밀번호 → TOTP → JWT 발급 |
| **COMBO-4** | true | true (smtp 있음) | 비밀번호 → 이메일 OTP → TOTP → JWT 발급 |

> COMBO-4에서 이메일 OTP 전송 실패 시 → TOTP 단독 플로우로 폴백 (FR-501 참조)

---

## 2. 기능 요구사항

### 2.1 TOTPService 초기화 및 QR 코드 출력 (FR-1xx)

#### FR-101: TOTPService 클래스 신규 구현
- **설명**: `server/src/services/TOTPService.ts` 파일을 새로 생성한다.
- **책임**:
  - TOTP secret 생성 (`otplib.authenticator.generateSecret()`)
  - TOTP 코드 검증 (`otplib.authenticator.check()`)
  - `data/totp.secret` 파일 로드/저장 (CryptoService 경유 암호화)
  - QR 코드 URI 생성 및 콘솔 출력 (`qrcode-terminal`)
- **의존성**: `CryptoService`, `otplib`, `qrcode-terminal`

#### FR-102: 서버 시작 시 TOTP QR 코드 콘솔 출력
- **설명**: `twoFactor.totp.enabled = true`이고 `data/totp.secret`이 존재할 때, 서버 시작 시 TOTP URI를 QR 코드로 콘솔에 출력한다.
- **QR 코드 URI 형식**: `otpauth://totp/BuilderGate:admin?secret=<BASE32_SECRET>&issuer=BuilderGate`
- **출력 시점**: `startServer()` 내 TOTPService 초기화 직후
- **동작**: 동일 secret 재사용 (매 시작마다 새 secret 생성하지 않음)
- **콘솔 출력 예시**:
  ```
  [TOTP] Google Authenticator QR Code:
  [TOTP] (QR 코드 아스키아트)
  [TOTP] Manual entry key: JBSWY3DPEHPK3PXP
  [TOTP] Issuer: BuilderGate | Account: admin
  ```

#### FR-103: TOTP 미등록 상태 감지
- **설명**: `twoFactor.totp.enabled = true`이지만 `data/totp.secret` 파일이 없으면 TOTPService는 "미등록(unregistered)" 상태가 된다.
- **동작**: 서버 기동은 허용하되, 로그인 시 차단 처리(FR-401 참조)
- **경고 로그**: `[TOTP] WARNING: TOTP enabled but no secret found. Login will be blocked.`

---

### 2.2 data/totp.secret 파일 관리 (FR-2xx)

#### FR-201: 최초 secret 자동 생성
- **설명**: `twoFactor.totp.enabled = true`이고 `data/totp.secret` 파일이 없으면, 서버 시작 시 새 secret을 자동 생성하여 저장한다.
- **생성 알고리즘**: `otplib.authenticator.generateSecret()` (BASE32, 20바이트 기본값)
- **저장 경로**: `data/totp.secret` (프로젝트 루트 기준)
- **저장 형식**: CryptoService로 암호화한 단일 행 문자열 (`enc(...)` 포맷)
- **디렉토리 자동 생성**: `data/` 디렉토리가 없으면 자동 생성(`fs.mkdirSync(dir, { recursive: true })`)

#### FR-202: 기존 secret 로드
- **설명**: `data/totp.secret` 파일이 존재하면 읽어서 CryptoService로 복호화한 후 메모리에 보관한다.
- **검증**: BASE32 형식 유효성 검사 (`/^[A-Z2-7]+=*$/` 패턴)
- **실패 처리**: 복호화 실패 또는 형식 오류 시 서버 시작을 중단하고 오류 로그 출력

#### FR-203: secret 파일 권한 설정 (Linux/Mac)
- **설명**: secret 파일 저장 시 파일 권한을 `0o600`으로 설정한다.
- **플랫폼**: Windows에서는 무시(해당 API 없음)
- [자동 보완] `process.platform !== 'win32'` 조건으로 분기

#### FR-204: TOTP 재등록 절차 (운영 가이드)
- **설명**: TOTP 재등록은 `data/totp.secret` 파일을 삭제한 후 서버를 재시작하면 된다. 새 secret이 생성되고 새 QR 코드가 콘솔에 출력된다.
- **이 절차는 SRS 요구사항이 아닌 운영 가이드이며, 코드 변경이 필요 없다.**

---

### 2.3 4가지 인증 플로우 (FR-3xx)

#### FR-301: COMBO-1 — 비밀번호 전용 플로우
- **조건**: `twoFactor.enabled = false`
- **플로우**:
  1. `POST /api/auth/login` 비밀번호 검증 성공
  2. 즉시 JWT 발급 후 `200 OK` 반환
- **변경 없음**: 기존 동작 유지

#### FR-302: COMBO-2 — 이메일 OTP 플로우
- **조건**: `twoFactor.enabled = true`, `twoFactor.totp.enabled = false` (또는 미설정)
- **플로우**:
  1. `POST /api/auth/login` 비밀번호 검증 성공
  2. 이메일 OTP 발송 → `202 + { requires2FA: true, tempToken, maskedEmail, nextStage: 'email' }`
  3. `POST /api/auth/verify` `{ tempToken, otpCode, stage: 'email' }` → JWT 발급
- **변경 없음**: 기존 동작과 동일 (nextStage 필드만 추가)

#### FR-303: COMBO-3 — TOTP 전용 플로우
- **조건**: `twoFactor.enabled = true`, `twoFactor.totp.enabled = true`, smtp 미설정
- **플로우**:
  1. `POST /api/auth/login` 비밀번호 검증 성공
  2. TOTP 미등록 상태 확인 (FR-401)
  3. `202 + { requires2FA: true, tempToken, nextStage: 'totp' }` (maskedEmail 없음)
  4. `POST /api/auth/verify` `{ tempToken, otpCode, stage: 'totp' }` → JWT 발급

#### FR-304: COMBO-4 — 이메일 OTP + TOTP 순차 플로우
- **조건**: `twoFactor.enabled = true`, `twoFactor.totp.enabled = true`, smtp 설정 있음
- **플로우**:
  1. `POST /api/auth/login` 비밀번호 검증 성공
  2. 이메일 OTP 발송 시도
     - 성공: `202 + { requires2FA: true, tempToken, maskedEmail, nextStage: 'email' }`
     - 실패: 폴백 처리(FR-501)
  3. `POST /api/auth/verify` `{ tempToken, otpCode, stage: 'email' }` OTP 검증
     - 성공: `202 + { success: true, nextStage: 'totp', tempToken (갱신) }` — JWT 미발급
     - 실패: 오류 반환
  4. `POST /api/auth/verify` `{ tempToken, otpCode, stage: 'totp' }` TOTP 검증
     - 성공: JWT 발급, `200 + { success: true, token, expiresIn }`

> **순서 강제**: stage 값이 예상과 다르면 `400 Bad Request` 반환

#### FR-305: tempToken 스테이지 상태 관리
- **설명**: `otpStore` Map에 저장된 `OTPData`에 `stage: 'email' | 'totp'` 필드를 추가한다.
- **stage 천이 규칙**:
  - 로그인 성공 직후 → `'email'` (COMBO-2/4) 또는 `'totp'` (COMBO-3)
  - 이메일 OTP 검증 성공(COMBO-4) → stage를 `'totp'`로 업데이트 (동일 tempToken 유지)
- **tempToken 재사용**: COMBO-4에서 이메일 OTP 검증 성공 후 새 tempToken을 발급하지 않고 기존 tempToken의 stage만 변경한다. [자동 보완]

---

### 2.4 TOTP 미등록 상태 로그인 차단 (FR-4xx)

#### FR-401: TOTP 미등록 시 로그인 차단
- **조건**: `twoFactor.totp.enabled = true`이고 TOTPService가 "미등록" 상태
- **동작**:
  - `POST /api/auth/login` 비밀번호 검증 성공 이후에도 `503 Service Unavailable` 반환
  - 응답 메시지: `"TOTP is enabled but not configured. Delete data/totp.secret and restart to re-register."`
- **이유**: 비밀번호만 알면 영구 접근 가능한 상태 방지

#### FR-402: TOTP 등록 완료 상태 확인
- **설명**: TOTPService에 `isRegistered(): boolean` 메서드를 제공한다.
- **반환값**: `data/totp.secret` 파일이 존재하고 복호화된 secret이 메모리에 있으면 `true`

---

### 2.5 이메일 장애 시 TOTP 폴백 (FR-5xx)

#### FR-501: 이메일 OTP 전송 실패 시 TOTP 폴백 (COMBO-4)
- **조건**: COMBO-4 플로우에서 이메일 OTP 발송이 모든 재시도 후 실패한 경우
- **동작**:
  - 이메일 발송을 포기하고 TOTP 단독 플로우로 전환
  - `202 + { requires2FA: true, tempToken, nextStage: 'totp', emailFallback: true }`
  - `emailFallback: true` 필드로 frontend가 안내 메시지를 표시 가능
- **로그**: `[Auth] Email OTP failed, falling back to TOTP for tempToken=...`

#### FR-502: 폴백 상태에서 stage 일관성 유지
- **설명**: 폴백 전환 후 생성된 tempToken의 `stage`는 `'totp'`로 설정된다.
- **검증**: 이후 `POST /api/auth/verify`에서 `stage: 'email'` 요청이 오면 `400 Bad Request` 반환

---

### 2.6 localhostPasswordOnly 옵션 (FR-6xx)

#### FR-601: localhostPasswordOnly 설정 항목 추가
- **설명**: `config.json5`에 `auth.localhostPasswordOnly` 필드를 추가한다.
- **타입**: `boolean`
- **기본값**: `false`
- **설명**: `true`로 설정하면 `req.ip`가 localhost(127.0.0.1, ::1, ::ffff:127.0.0.1)인 요청에 대해 2FA 단계를 건너뛰고 비밀번호만으로 JWT를 발급한다.

#### FR-602: localhostPasswordOnly 처리 위치
- **설명**: `POST /api/auth/login` 핸들러에서 비밀번호 검증 성공 직후, 2FA 분기 이전에 localhost 여부를 확인한다.
- **localhost 판별**:
  ```typescript
  const isLocalhost = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip ?? '');
  ```
- **동작**: `localhostPasswordOnly = true` AND `isLocalhost = true` → 2FA 건너뜀 → 즉시 JWT 발급

#### FR-603: localhostPasswordOnly Zod schema 추가
- **경로**: `server/src/schemas/config.schema.ts`의 `authSchema`
- **추가 필드**:
  ```typescript
  localhostPasswordOnly: z.boolean().default(false)
  ```

---

### 2.7 TOTP 재등록 (FR-7xx)

#### FR-701: 파일 삭제 기반 재등록 지원
- **설명**: `data/totp.secret` 파일을 삭제하고 서버를 재시작하면 새 secret이 자동 생성된다 (FR-201 재사용).
- **코드 변경 없음**: FR-201의 파일 부재 시 자동 생성 로직으로 처리됨.

#### FR-702: 재등록 후 기존 세션 강제 무효화 [자동 보완]
- **설명**: 서버 재시작 시 기존 JWT 블랙리스트가 초기화되므로 기존 세션은 자연히 만료된다. 별도 강제 무효화 로직은 불필요하다.

---

### 2.8 다단계 tempToken 플로우 (FR-8xx)

#### FR-801: tempToken 발급 및 stage 설정
- **설명**: `POST /api/auth/login` 성공 시 tempToken과 함께 `nextStage`를 응답한다.
- **nextStage 값**: `'email'` | `'totp'`
- **tempToken 유효 기간**: `twoFactor.otpExpiryMs` (기본 300,000ms = 5분)

#### FR-802: 단계별 verify 요청 검증
- **설명**: `POST /api/auth/verify` 요청 body에 `stage` 필드를 추가로 받는다.
- **검증 규칙**:
  - `stage` 미입력 → 기존 동작과의 하위 호환을 위해 현재 OTPData의 stage 값을 사용 [자동 보완]
  - `stage` 불일치 → `400 Bad Request + "Unexpected verification stage"`

#### FR-803: COMBO-4 중간 단계 응답
- **설명**: 이메일 OTP 검증 성공 직후(TOTP 미검증 상태)에는 JWT를 발급하지 않고 다음 단계를 안내한다.
- **응답 형식**:
  ```json
  {
    "success": true,
    "nextStage": "totp",
    "message": "Email OTP verified. Please enter your TOTP code."
  }
  ```

#### FR-804: 최종 단계 완료 시 JWT 발급
- **설명**: 마지막 인증 단계(COMBO-2/3에서의 단일 verify, COMBO-4에서의 TOTP verify) 성공 시 JWT를 발급한다.
- **응답 형식**:
  ```json
  {
    "success": true,
    "token": "<JWT>",
    "expiresIn": 1800000
  }
  ```

---

## 3. 비기능 요구사항

### 3.1 보안 요구사항

#### NFR-101: TOTP 검증 timing-safe 처리
- **설명**: TOTP 코드 비교 시 `crypto.timingSafeEqual()` 또는 `otplib`의 내부 timing-safe 비교를 사용한다.
- **금지**: 단순 문자열 `===` 비교 금지

#### NFR-102: TOTP secret 암호화 저장
- **설명**: `data/totp.secret` 파일에 저장되는 secret은 반드시 CryptoService의 `encrypt()` 메서드로 암호화한다.
- **형식**: `enc(base64(salt+iv+authTag+ciphertext))` (기존 CryptoService 포맷 동일)

#### NFR-103: secret 메모리 보관 기간 최소화 [자동 보완]
- **설명**: 복호화된 TOTP secret은 TOTPService 인스턴스 수명 동안만 메모리에 보관된다. `destroy()` 호출 시 즉시 제거한다.

#### NFR-104: 최대 검증 시도 횟수 제한
- **설명**: TOTP 검증도 이메일 OTP와 동일하게 tempToken당 최대 3회 시도 후 tempToken을 폐기한다. (`MAX_VERIFICATION_ATTEMPTS = 3`)

#### NFR-105: TOTP 재사용 방지
- **설명**: 동일 TOTP 코드를 30초 창 내에서 두 번 사용할 수 없다. 마지막으로 성공한 코드의 타임스텝을 기록하여 중복 사용 시 `400 Bad Request` 반환. [자동 보완]
- **구현**: TOTPService 내 `lastUsedStep: number` 멤버 변수로 추적

#### NFR-106: tempToken 검증 실패 시 오류 정보 최소화
- **설명**: 인증 실패 응답에 내부 오류 상세(스택 트레이스, 설정값 등)를 포함하지 않는다.

### 3.2 성능 요구사항

#### NFR-201: TOTP 검증 응답 시간 < 100ms
- **설명**: `POST /api/auth/verify`의 TOTP 검증 처리 시간(서버 내부 처리)이 100ms 미만이어야 한다.
- **근거**: TOTP 검증은 순수 메모리 연산(HMAC-SHA1)으로 네트워크 I/O 없음

#### NFR-202: 서버 시작 시 QR 출력 지연 < 2초
- **설명**: TOTPService 초기화(파일 읽기 + 복호화 + QR 렌더링) 전체가 2초 이내에 완료되어야 한다.

### 3.3 호환성 요구사항

#### NFR-301: Google Authenticator 지원
- **알고리즘**: HMAC-SHA1 (RFC 6238 기본값)
- **자릿수**: 6자리
- **시간 간격**: 30초

#### NFR-302: Microsoft Authenticator 지원
- **설명**: `otplib` 기본 TOTP 설정(`algorithm: 'sha1', digits: 6, step: 30`)은 Microsoft Authenticator와 호환된다.

#### NFR-303: Authy 지원
- **설명**: 동일 RFC 6238 기반이므로 Authy와 호환된다.

#### NFR-304: TOTP 시간 윈도우 허용 범위
- **설명**: 클라이언트 시계 오차를 고려하여 현재 타임스텝 기준 ±1 간격(±30초)을 허용한다.
- **otplib 설정**:
  ```typescript
  authenticator.options = { window: 1 };
  ```

### 3.4 운용성 요구사항

#### NFR-401: TOTP 상태 서버 시작 배너 표시
- **설명**: 서버 시작 완료 배너의 `2FA` 항목에 TOTP 상태를 표시한다.
- **예시**:
  ```
  ║  2FA:  Enabled (Email OTP + TOTP)                   ║
  ║  2FA:  Enabled (TOTP only)                          ║
  ║  2FA:  Disabled                                     ║
  ```

#### NFR-402: 잘못된 config 조기 실패
- **설명**: `twoFactor.totp.enabled = true`이지만 필요한 파일/설정이 없을 경우 서버 시작 시 명확한 오류 메시지를 출력한다.

---

## 4. 데이터 요구사항

### 4.1 data/totp.secret 파일 스키마

```
파일 경로: <project_root>/data/totp.secret
파일 내용: enc(<base64_encoded_encrypted_secret>)
인코딩: UTF-8, 개행 없음
예시: enc(AAAA...base64...)
```

**파일 구조 상세**:

| 항목 | 값 |
|------|-----|
| 파일명 | `totp.secret` |
| 디렉토리 | `data/` (프로젝트 루트 기준) |
| 암호화 알고리즘 | AES-256-GCM (CryptoService 동일) |
| 복호화 결과 | BASE32 인코딩 TOTP secret (예: `JBSWY3DPEHPK3PXP`) |
| 파일 권한 (Linux/Mac) | `0o600` (소유자 읽기/쓰기만) |

**.gitignore 추가 필요**:
```
data/totp.secret
```

### 4.2 OTPData 인터페이스 확장

현재 인터페이스:
```typescript
// server/src/types/auth.types.ts
export interface OTPData {
  otp: string;
  email: string;
  expiresAt: number;
  attempts: number;
}
```

변경 후 인터페이스:
```typescript
export interface OTPData {
  otp: string;           // 이메일 OTP 코드 (TOTP-only 플로우에서는 빈 문자열)
  email: string;         // 이메일 주소 (TOTP-only 플로우에서는 빈 문자열)
  expiresAt: number;     // 만료 타임스탬프 (Unix ms)
  attempts: number;      // 검증 시도 횟수
  stage: '2fa_stage';    // 현재 검증 단계
  totpLastUsedStep?: number; // TOTP 재사용 방지용 마지막 사용 타임스텝 [자동 보완]
}

// stage 타입 정의
export type TwoFAStage = 'email' | 'totp';
```

> `stage` 필드는 기존 이메일 OTP 플로우에서 `'email'`로 초기화되어 하위 호환을 유지한다.

### 4.3 config.json5 신규/변경 필드

#### 4.3.1 auth 섹션 변경

```json5
auth: {
  password: "enc(...)",
  durationMs: 1800000,
  maxDurationMs: 86400000,
  jwtSecret: "",
  localhostPasswordOnly: false  // [신규] localhost 접근 시 2FA 건너뜀
}
```

#### 4.3.2 twoFactor 섹션 변경

```json5
twoFactor: {
  enabled: false,
  email: "user@example.com",      // [기존] 이메일 OTP 수신 주소 (smtp 있을 때만 필요)
  otpLength: 6,
  otpExpiryMs: 300000,
  smtp: { ... },                  // [기존] SMTP 설정 (이메일 OTP용, 선택)
  totp: {                         // [신규] TOTP 설정 블록
    enabled: false,               // TOTP 활성화 여부
    issuer: "BuilderGate",        // [자동 보완] QR 코드 발급자 이름 (기본값)
    accountName: "admin"          // [자동 보완] QR 코드 계정 이름 (기본값)
  }
}
```

#### 4.3.3 Zod schema 변경 사항 (현재 문제점 해결)

**현재 문제 1: twoFactorSchema.refine()**

현재 코드 (`server/src/schemas/config.schema.ts`):
```typescript
.refine(
  (data) => !data.enabled || (data.email && data.smtp),
  { message: '2FA enabled requires email and smtp configuration' }
)
```

**문제**: `enabled = true` 이면 반드시 `email + smtp`를 요구하므로 TOTP-only 설정이 불가능.

**변경 후**:
```typescript
.refine(
  (data) => {
    if (!data.enabled) return true;
    const hasEmail = data.email && data.smtp;
    const hasTotp = data.totp?.enabled;
    return hasEmail || hasTotp; // 이메일 OTP 또는 TOTP 중 하나만 있으면 통과
  },
  { message: '2FA enabled requires either email+smtp or totp configuration' }
)
```

**현재 문제 2: validateTwoFactorSecretState()**

[자동 보완] `server/src/utils/config.ts` 또는 서비스 초기화 코드에 `validateTwoFactorSecretState()` 함수가 smtp 없으면 오류를 발생시키는 부분이 있다면 동일한 조건 완화 처리가 필요하다. 해당 함수를 찾아 TOTP-only 경우를 허용하도록 수정한다.

### 4.4 AuthConfig 타입 변경

```typescript
// server/src/types/config.types.ts
export interface AuthConfig {
  password: string;
  durationMs: number;
  maxDurationMs: number;
  jwtSecret: string;
  localhostPasswordOnly?: boolean;  // [신규]
}
```

### 4.5 TwoFactorConfig 타입 변경

```typescript
// server/src/types/config.types.ts

export interface TOTPConfig {                  // [신규]
  enabled: boolean;
  issuer?: string;       // 기본값: 'BuilderGate'
  accountName?: string;  // 기본값: 'admin'
}

export interface TwoFactorConfig {
  enabled: boolean;
  email?: string;          // [변경] optional (TOTP-only 시 불필요)
  otpLength: number;
  otpExpiryMs: number;
  smtp?: SMTPConfig;       // [변경] optional (이미 optional이지만 schema 조건 완화)
  totp?: TOTPConfig;       // [신규]
}
```

---

## 5. 인터페이스 요구사항

### 5.1 API 변경사항

#### 5.1.1 POST /api/auth/login — 변경사항

**요청 (변경 없음)**:
```json
{ "password": "string" }
```

**응답 변경사항**:

| 시나리오 | 기존 응답 | 변경 후 응답 |
|---------|-----------|-------------|
| COMBO-1 (2FA 없음) | `{ success, token, expiresIn }` | 동일 |
| COMBO-2 (이메일 OTP) | `{ success, requires2FA, tempToken, maskedEmail }` | `nextStage: 'email'` 추가 |
| COMBO-3 (TOTP only) | 존재 안 함 | `{ success: true, requires2FA: true, tempToken, nextStage: 'totp' }` |
| COMBO-4 (이메일+TOTP) | 없음 | `{ success: true, requires2FA: true, tempToken, maskedEmail, nextStage: 'email' }` |
| TOTP 미등록 (FR-401) | 없음 | `503 + { success: false, message: "TOTP not configured..." }` |
| localhost bypass (FR-602) | 없음 | `200 + { success: true, token, expiresIn }` |
| 이메일 실패 폴백 (FR-501) | 없음 | `202 + { ..., nextStage: 'totp', emailFallback: true }` |

**상태 코드**:
- `200 OK`: 즉시 JWT 발급 (2FA 없거나 localhost bypass)
- `202 Accepted`: 2FA 단계 진행 중
- `401 Unauthorized`: 비밀번호 불일치
- `503 Service Unavailable`: TOTP 미등록

#### 5.1.2 POST /api/auth/verify — 변경사항

**요청 변경**:
```typescript
// 기존
{
  tempToken: string;
  otpCode: string;
}

// 변경 후
{
  tempToken: string;
  otpCode: string;
  stage?: 'email' | 'totp';  // [신규, 선택] 미입력 시 현재 OTPData.stage 사용
}
```

**응답 변경**:

| 케이스 | 응답 |
|--------|------|
| 단일 단계 완료 (COMBO-2, COMBO-3) | `{ success: true, token, expiresIn }` |
| COMBO-4 이메일 OTP 통과 (TOTP 미완) | `{ success: true, nextStage: 'totp', message: "..." }` (token 없음) |
| COMBO-4 TOTP 통과 (최종) | `{ success: true, token, expiresIn }` |
| 단계 불일치 | `400 + { success: false, message: "Unexpected verification stage" }` |
| OTP 만료 | `401 + { success: false, errorCode: "OTP_EXPIRED" }` |
| 최대 시도 초과 | `401 + { success: false, errorCode: "OTP_MAX_ATTEMPTS", attemptsRemaining: 0 }` |

**Zod verifySchema 변경**:
```typescript
// server/src/routes/authRoutes.ts
const verifySchema = z.object({
  tempToken: z.string().uuid('Invalid temporary token format'),
  otpCode: z.string().min(4, 'OTP code is required').max(8, 'OTP code too long'),
  stage: z.enum(['email', 'totp']).optional()  // [신규]
});
```

#### 5.1.3 응답 타입 변경

```typescript
// server/src/types/auth.types.ts

// LoginResponse 변경
export interface LoginResponse {
  success: boolean;
  token?: string;
  expiresIn?: number;
  requires2FA?: boolean;
  tempToken?: string;
  maskedEmail?: string;
  nextStage?: 'email' | 'totp';  // [신규]
  emailFallback?: boolean;        // [신규] 이메일 장애 폴백 안내
  message?: string;
}

// VerifyResponse 변경
export interface VerifyResponse {
  success: boolean;
  token?: string;
  expiresIn?: number;
  nextStage?: 'email' | 'totp';  // [신규] 다음 단계가 있을 경우
  message?: string;
}
```

### 5.2 Frontend AuthContext 상태 확장

#### 5.2.1 AuthState 타입 변경

```typescript
// frontend/src/types/index.ts (또는 Auth 관련 타입 파일)

// 기존 AuthState
export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  requires2FA: boolean;
  tempToken: string | null;
  maskedEmail: string | null;
  expiresAt: number | null;
}

// 변경 후 AuthState
export interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  requires2FA: boolean;
  tempToken: string | null;
  maskedEmail: string | null;
  nextStage: 'email' | 'totp' | null;  // [신규] 현재 대기 중인 2FA 단계
  emailFallback: boolean;               // [신규] 이메일 장애 폴백 여부
  expiresAt: number | null;
}
```

#### 5.2.2 AuthContext 초기 상태 변경

```typescript
// frontend/src/contexts/AuthContext.tsx
const [state, setState] = useState<AuthState>({
  isAuthenticated: false,
  isLoading: true,
  error: null,
  requires2FA: false,
  tempToken: null,
  maskedEmail: null,
  nextStage: null,       // [신규]
  emailFallback: false,  // [신규]
  expiresAt: null
});
```

#### 5.2.3 login() 콜백 변경

```typescript
// login 성공 후 requires2FA 상태 저장 시 nextStage 포함
if (response.requires2FA) {
  setState(s => ({
    ...s,
    isLoading: false,
    requires2FA: true,
    tempToken: response.tempToken || null,
    maskedEmail: response.maskedEmail || null,
    nextStage: response.nextStage || null,      // [신규]
    emailFallback: response.emailFallback ?? false  // [신규]
  }));
  return false;
}
```

#### 5.2.4 verify2FA() 콜백 변경

```typescript
// COMBO-4 중간 단계 처리 추가
const verify2FA = useCallback(async (otpCode: string): Promise<boolean> => {
  // ... 기존 코드 ...
  const response = await authApi.verify(state.tempToken, otpCode, state.nextStage ?? undefined);

  // 다음 단계가 있는 경우 (COMBO-4 이메일 OTP 통과)
  if (response.nextStage && !response.token) {
    setState(s => ({
      ...s,
      isLoading: false,
      nextStage: response.nextStage!,  // 'totp'로 업데이트
      maskedEmail: null                // 이메일 마스킹 정보 제거
    }));
    return false; // 아직 인증 완료 아님
  }

  // 최종 JWT 발급
  if (response.token && response.expiresIn) {
    tokenStorage.setToken(response.token, response.expiresIn);
    setState(s => ({
      ...s,
      isAuthenticated: true,
      isLoading: false,
      requires2FA: false,
      tempToken: null,
      maskedEmail: null,
      nextStage: null,
      emailFallback: false,
      expiresAt: Date.now() + response.expiresIn!
    }));
    return true;
  }
}, [state.tempToken, state.nextStage]);
```

### 5.3 Frontend TwoFactorForm 확장

#### 5.3.1 TOTP 전용 화면 렌더링

```typescript
// frontend/src/components/Auth/TwoFactorForm.tsx
// nextStage에 따라 다른 화면 렌더링

function TwoFactorForm() {
  const { nextStage, maskedEmail, emailFallback, ... } = useAuth();

  // stage에 따른 안내 문구
  const stageInfo = nextStage === 'totp'
    ? {
        title: 'Authenticator Code',
        description: emailFallback
          ? 'Email unavailable. Please enter your Authenticator code.'
          : 'Enter the 6-digit code from your authenticator app.',
        showCountdown: false,   // TOTP는 30초 자동 갱신이므로 OTP 만료 카운트다운 불필요
        placeholder: '000000',
        inputMode: 'numeric' as const
      }
    : {
        title: 'Verification',
        description: `Verification code sent to ${maskedEmail}`,
        showCountdown: true,
        placeholder: '000000',
        inputMode: 'numeric' as const
      };

  // ... 렌더링 로직
}
```

#### 5.3.2 TOTP 화면 카운트다운 비표시

- 이메일 OTP (`stage: 'email'`): 기존 5분 카운트다운 타이머 유지
- TOTP (`stage: 'totp'`): 카운트다운 타이머 미표시 (TOTP는 30초마다 코드가 자동 갱신됨)

#### 5.3.3 이메일 폴백 안내 메시지 표시

- `emailFallback: true`이면 상단에 경고 배너 표시:
  ```
  "Email delivery failed. Please use your Authenticator app instead."
  ```

### 5.4 authApi 클라이언트 변경

```typescript
// frontend/src/services/api.ts (또는 authApi 정의 파일)
verify: (tempToken: string, otpCode: string, stage?: 'email' | 'totp') =>
  post('/api/auth/verify', { tempToken, otpCode, stage })
```

---

## 6. 제약사항

### 6.1 사용 라이브러리

| 라이브러리 | 버전 | 용도 | 설치 위치 |
|-----------|------|------|---------|
| `otplib` | ^12.0.0 | TOTP 생성/검증 (RFC 6238) | `server/` |
| `qrcode-terminal` | ^0.12.0 | QR 코드 콘솔 아스키 출력 | `server/` |
| `@types/qrcode-terminal` | ^0.12.2 | TypeScript 타입 정의 | `server/` (devDependency) |

**설치 명령**:
```bash
cd server && npm install otplib qrcode-terminal
cd server && npm install -D @types/qrcode-terminal
```

### 6.2 변경 필요 파일 목록

#### 6.2.1 신규 생성 파일

| 파일 경로 | 이유 |
|----------|------|
| `server/src/services/TOTPService.ts` | TOTP 핵심 로직 구현 |

#### 6.2.2 수정 필요 파일

| 파일 경로 | 수정 이유 |
|----------|---------|
| `server/src/schemas/config.schema.ts` | (1) `twoFactorSchema.refine()` 조건 완화 (TOTP-only 허용), (2) `totpSchema` 신규 추가, (3) `authSchema`에 `localhostPasswordOnly` 추가 |
| `server/src/types/config.types.ts` | `TwoFactorConfig`에 `totp?: TOTPConfig` 추가, `AuthConfig`에 `localhostPasswordOnly?: boolean` 추가, `TOTPConfig` 인터페이스 신규 추가 |
| `server/src/types/auth.types.ts` | `OTPData`에 `stage: TwoFAStage`, `totpLastUsedStep?: number` 추가; `LoginResponse`에 `nextStage`, `emailFallback` 추가; `VerifyResponse`에 `nextStage` 추가; `TwoFAStage` 타입 신규 추가; `VerifyRequest`에 `stage?: TwoFAStage` 추가 |
| `server/src/services/TwoFactorService.ts` | `createPendingAuth()`에 `stage` 파라미터 추가; `verifyOTP()`에 stage 검증 로직 추가; COMBO-4 이메일 OTP 통과 후 stage 업데이트 로직 추가 |
| `server/src/routes/authRoutes.ts` | (1) `verifySchema`에 `stage` 추가; (2) TOTP 검증 분기 로직 추가; (3) `localhostPasswordOnly` 처리 추가; (4) TOTP 미등록 차단 처리 추가; (5) 이메일 폴백 처리 추가 |
| `server/src/index.ts` | `TOTPService` 초기화 및 의존성 주입; 서버 시작 배너 2FA 상태 문구 변경 |
| `server/src/services/index.ts` | `TOTPService` export 추가 |
| `frontend/src/types/index.ts` | `AuthState`에 `nextStage`, `emailFallback` 추가 |
| `frontend/src/contexts/AuthContext.tsx` | 초기 상태, `login()`, `verify2FA()` 변경 |
| `frontend/src/components/Auth/TwoFactorForm.tsx` | `nextStage`에 따른 조건부 렌더링 추가 |
| `frontend/src/services/api.ts` | `verify()` 함수에 `stage` 파라미터 추가 |

#### 6.2.3 Zod schema refine 조건 수정 필수 명시

`server/src/schemas/config.schema.ts` 의 `twoFactorSchema` refine 조건은 반드시 수정해야 한다. 현재 조건이 수정되지 않으면:
- `twoFactor.totp.enabled = true`, smtp 없음 → Zod 유효성 검사 실패
- 서버가 TOTP-only 설정으로 기동 불가

#### 6.2.4 .gitignore 추가 필수

```
# TOTP secret
data/totp.secret
```

### 6.3 기존 이메일 OTP 하위 호환 유지

- 기존 `POST /api/auth/verify` 요청 (`{ tempToken, otpCode }`)에서 `stage` 미입력 시 동작이 변경되지 않아야 한다.
- 기존 `OTPData` 구조에서 `stage`가 없는 경우를 처리하는 방어 코드 추가 [자동 보완]:
  ```typescript
  const currentStage = otpData.stage ?? 'email'; // 기존 데이터 호환
  ```
- `LoginResponse.nextStage`는 선택 필드이므로 기존 클라이언트가 이 필드를 무시해도 문제없다.

### 6.4 아키텍처 제약

- `TOTPService`는 `TwoFactorService`와 별도 클래스로 구현한다. 기존 `TwoFactorService` 내부에 통합하지 않는다.
  - **이유**: 단일 책임 원칙(SRP), 이메일 OTP와 TOTP는 독립적으로 활성화/비활성화 가능해야 함
- `TOTPService` 인스턴스는 `server/src/index.ts`에서 생성하여 `authRoutes`에 의존성 주입한다.
- `AuthRouteAccessors` 인터페이스에 `getTOTPService: () => TOTPService | undefined` 추가 필요

---

## 7. 인수 조건

모든 인수 조건은 Given/When/Then 형식으로 기술한다.

---

### 7.1 FR-101 ~ FR-103: TOTPService 초기화

#### AC-101: TOTP secret 자동 생성 및 QR 출력
```
Given: twoFactor.enabled = true, twoFactor.totp.enabled = true
  AND: data/totp.secret 파일이 존재하지 않음
When: 서버가 시작됨
Then: data/totp.secret 파일이 생성됨
  AND: 파일 내용이 enc(...) 형식으로 암호화됨
  AND: 콘솔에 QR 코드 아스키아트가 출력됨
  AND: 콘솔에 "Manual entry key: <BASE32_SECRET>" 가 출력됨
```

#### AC-102: 기존 secret 재사용
```
Given: twoFactor.enabled = true, twoFactor.totp.enabled = true
  AND: data/totp.secret 파일이 존재함
When: 서버를 재시작함
Then: data/totp.secret 파일 내용이 변경되지 않음
  AND: 이전과 동일한 QR 코드가 콘솔에 출력됨
  AND: 기존에 등록된 Google Authenticator 앱이 여전히 유효한 TOTP 코드를 생성함
```

#### AC-103: TOTP 미등록 경고 로그
```
Given: twoFactor.enabled = true, twoFactor.totp.enabled = true
  AND: data/totp.secret 파일이 존재하지 않고 서버 시작 시 생성도 실패함
When: 서버가 시작됨
Then: "[TOTP] WARNING: TOTP enabled but no secret found." 로그가 출력됨
  AND: 서버는 기동되지만 로그인 시 503 반환됨
```

---

### 7.2 FR-201 ~ FR-203: 파일 관리

#### AC-201: secret 복호화 실패 시 서버 시작 중단
```
Given: twoFactor.totp.enabled = true
  AND: data/totp.secret 파일이 존재하지만 내용이 손상됨 (잘못된 enc 포맷)
When: 서버가 시작됨
Then: 서버가 기동을 중단함
  AND: "TOTP secret file is corrupted or cannot be decrypted" 오류 메시지가 출력됨
```

#### AC-202: secret 파일 권한 설정 (Linux)
```
Given: Linux/Mac 환경
  AND: twoFactor.totp.enabled = true
  AND: data/totp.secret 파일이 존재하지 않음
When: 서버가 시작됨 (신규 secret 생성)
Then: data/totp.secret 파일의 권한이 0o600임
  AND: 소유자 외 접근 불가
```

---

### 7.3 FR-301 ~ FR-304: 4가지 인증 조합 시나리오

#### AC-COMBO-1: 2FA 없이 비밀번호만으로 로그인
```
Given: twoFactor.enabled = false
  AND: 올바른 비밀번호를 입력함
When: POST /api/auth/login { password: "correct" }
Then: 200 OK 반환
  AND: 응답에 token, expiresIn 포함
  AND: requires2FA = undefined 또는 false
```

#### AC-COMBO-2: 이메일 OTP 플로우
```
Given: twoFactor.enabled = true, twoFactor.totp.enabled = false
  AND: SMTP 설정 정상
  AND: 올바른 비밀번호 입력

Step 1:
When: POST /api/auth/login { password: "correct" }
Then: 202 Accepted 반환
  AND: 응답에 { requires2FA: true, tempToken, maskedEmail, nextStage: 'email' } 포함
  AND: 이메일로 OTP 코드 발송됨

Step 2:
When: POST /api/auth/verify { tempToken, otpCode: "<발송된 코드>", stage: 'email' }
Then: 200 OK 반환
  AND: 응답에 { success: true, token, expiresIn } 포함
  AND: nextStage 필드 없음 (최종 단계)
```

#### AC-COMBO-3: TOTP 전용 플로우
```
Given: twoFactor.enabled = true, twoFactor.totp.enabled = true
  AND: SMTP 설정 없음
  AND: data/totp.secret 파일 존재
  AND: 올바른 비밀번호 입력

Step 1:
When: POST /api/auth/login { password: "correct" }
Then: 202 Accepted 반환
  AND: 응답에 { requires2FA: true, tempToken, nextStage: 'totp' } 포함
  AND: maskedEmail 없음

Step 2 (유효한 TOTP 코드):
When: POST /api/auth/verify { tempToken, otpCode: "<GA 앱 코드>", stage: 'totp' }
Then: 200 OK 반환
  AND: 응답에 { success: true, token, expiresIn } 포함

Step 2 (만료 TOTP 코드):
When: POST /api/auth/verify { tempToken, otpCode: "<30초 이전 코드>", stage: 'totp' }
Then: 401 Unauthorized 반환
  AND: attemptsRemaining: 2
```

#### AC-COMBO-4: 이메일 OTP + TOTP 순차 플로우
```
Given: twoFactor.enabled = true, twoFactor.totp.enabled = true
  AND: SMTP 설정 정상
  AND: data/totp.secret 파일 존재
  AND: 올바른 비밀번호 입력

Step 1 - 비밀번호:
When: POST /api/auth/login { password: "correct" }
Then: 202 Accepted 반환
  AND: { requires2FA: true, tempToken, maskedEmail, nextStage: 'email' }
  AND: 이메일 OTP 발송됨

Step 2 - 이메일 OTP 검증:
When: POST /api/auth/verify { tempToken, otpCode: "<이메일 코드>", stage: 'email' }
Then: 202 Accepted 반환 (JWT 미발급)
  AND: { success: true, nextStage: 'totp', message: "Email OTP verified. Please enter your TOTP code." }

Step 3 - TOTP 검증:
When: POST /api/auth/verify { tempToken, otpCode: "<GA 앱 코드>", stage: 'totp' }
Then: 200 OK 반환
  AND: { success: true, token, expiresIn }

Step 3 잘못된 stage:
When: POST /api/auth/verify { tempToken, otpCode: "123456", stage: 'email' } (이메일 OTP 재시도)
Then: 400 Bad Request 반환
  AND: { success: false, message: "Unexpected verification stage" }
```

---

### 7.4 FR-401 ~ FR-402: TOTP 미등록 차단

#### AC-401: TOTP 미등록 시 로그인 차단
```
Given: twoFactor.totp.enabled = true
  AND: data/totp.secret 파일이 없음 (TOTPService 미등록 상태)
  AND: 올바른 비밀번호 입력
When: POST /api/auth/login { password: "correct" }
Then: 503 Service Unavailable 반환
  AND: 응답 message에 "TOTP is enabled but not configured" 포함
  AND: JWT 미발급
  AND: "[TOTP] Login blocked" 로그 출력
```

#### AC-402: TOTP 등록 완료 후 로그인 가능
```
Given: twoFactor.totp.enabled = true
  AND: data/totp.secret 파일이 존재함 (TOTPService 등록 완료)
When: TOTPService.isRegistered() 호출
Then: true 반환
```

---

### 7.5 FR-501 ~ FR-502: 이메일 장애 폴백

#### AC-501: 이메일 전송 실패 시 TOTP 폴백
```
Given: COMBO-4 조건 (이메일 + TOTP 모두 활성화)
  AND: SMTP 서버가 응답 없음 (모든 재시도 실패)
  AND: data/totp.secret 파일 존재
  AND: 올바른 비밀번호 입력
When: POST /api/auth/login { password: "correct" }
Then: 202 Accepted 반환
  AND: { requires2FA: true, tempToken, nextStage: 'totp', emailFallback: true }
  AND: "[Auth] Email OTP failed, falling back to TOTP" 로그 출력
  AND: 이후 TOTP 코드로만 로그인 가능
```

#### AC-502: 폴백 후 이메일 단계 요청 차단
```
Given: 위 AC-501 결과로 nextStage: 'totp' 상태
When: POST /api/auth/verify { tempToken, otpCode: "123456", stage: 'email' }
Then: 400 Bad Request 반환
  AND: "Unexpected verification stage" 메시지
```

---

### 7.6 FR-601 ~ FR-603: localhostPasswordOnly

#### AC-601: localhostPasswordOnly = false (기본값) — 2FA 강제 적용
```
Given: localhostPasswordOnly = false (또는 미설정)
  AND: twoFactor.enabled = true
  AND: 요청 IP = 127.0.0.1 (localhost)
  AND: 올바른 비밀번호 입력
When: POST /api/auth/login { password: "correct" }
Then: 202 Accepted 반환 (2FA 진행)
  AND: JWT 즉시 미발급
```

#### AC-602: localhostPasswordOnly = true — localhost에서 2FA 건너뜀
```
Given: auth.localhostPasswordOnly = true
  AND: twoFactor.enabled = true
  AND: 요청 IP = 127.0.0.1 (localhost)
  AND: 올바른 비밀번호 입력
When: POST /api/auth/login { password: "correct" }
Then: 200 OK 반환 (즉시 JWT 발급)
  AND: { success: true, token, expiresIn }
  AND: requires2FA = undefined 또는 false
```

#### AC-603: localhostPasswordOnly = true — 원격에서는 2FA 강제 적용
```
Given: auth.localhostPasswordOnly = true
  AND: twoFactor.enabled = true
  AND: 요청 IP = 192.168.1.100 (원격)
  AND: 올바른 비밀번호 입력
When: POST /api/auth/login { password: "correct" }
Then: 202 Accepted 반환 (2FA 진행)
  AND: JWT 즉시 미발급
```

---

### 7.7 FR-7xx: TOTP 재등록

#### AC-701: 파일 삭제 후 재시작으로 재등록
```
Given: data/totp.secret 파일이 존재함 (기존 secret)
  AND: 관리자가 data/totp.secret 파일을 삭제함
When: 서버를 재시작함
Then: 새 data/totp.secret 파일이 생성됨
  AND: 새 QR 코드가 콘솔에 출력됨
  AND: 이전 secret으로 생성된 TOTP 코드로 로그인 불가 (새 secret 사용)
  AND: 새 QR 코드를 앱에 등록하면 로그인 가능
```

---

### 7.8 FR-8xx: 다단계 tempToken 플로우

#### AC-801: stage 불일치 요청 거부
```
Given: COMBO-3 플로우 진행 중 (nextStage = 'totp')
When: POST /api/auth/verify { tempToken, otpCode: "123456", stage: 'email' }
Then: 400 Bad Request 반환
  AND: "Unexpected verification stage" 메시지
```

#### AC-802: stage 미입력 시 현재 stage 자동 사용 (하위 호환)
```
Given: COMBO-2 플로우 진행 중 (OTPData.stage = 'email')
  AND: 이메일로 받은 올바른 OTP 코드
When: POST /api/auth/verify { tempToken, otpCode: "<이메일 코드>" } (stage 미입력)
Then: 200 OK 반환
  AND: { success: true, token, expiresIn }
```

#### AC-803: TOTP 코드 재사용 방지 (NFR-105)
```
Given: COMBO-3 플로우 진행 중
  AND: 현재 유효한 TOTP 코드로 1회 성공적 검증

When: 동일 TOTP 코드를 30초 내에 다시 사용하여 새 tempToken으로 시도
Then: 401 Unauthorized 반환 또는 시간 창이 이미 다음으로 넘어가 코드가 유효하지 않음
```
> [자동 보완] 코드 재사용 방지는 tempToken별로 추적하므로, 성공 후 tempToken이 삭제되면 자연히 방지된다.

---

### 7.9 NFR 인수 조건

#### AC-NFR-101: Timing-safe 비교
```
Given: TOTP 검증 코드 리뷰
When: TOTPService.verifyTOTP() 구현을 확인함
Then: 코드 비교에 단순 === 대신 crypto.timingSafeEqual 또는 otplib의 check() 사용
  AND: 직접 문자열 비교 코드가 없음
```

#### AC-NFR-201: TOTP 검증 성능
```
Given: 유효한 tempToken과 TOTP 코드 준비
When: POST /api/auth/verify { stage: 'totp', ... } 요청 100회 측정
Then: 서버 내부 처리 시간 p95 < 100ms
```

#### AC-NFR-301~303: 앱 호환성
```
Given: Google Authenticator 앱에 QR 코드 등록 완료
When: 현재 표시된 6자리 코드를 TOTP 검증에 입력
Then: 200 OK 반환 (로그인 성공)
  AND: Microsoft Authenticator, Authy 앱 등록 코드도 동일하게 성공
```

#### AC-NFR-304: 시간 오차 허용 (±30초)
```
Given: 서버와 클라이언트 시계가 25초 차이남
  AND: 클라이언트의 Google Authenticator가 이전 타임스텝 코드를 표시 중
When: 해당 코드로 TOTP 검증
Then: 200 OK 반환 (window: 1 설정으로 허용)
```

---

### 7.10 Zod Schema 수정 인수 조건

#### AC-SCHEMA-1: TOTP-only 설정 허용
```
Given: config.json5에
  twoFactor: {
    enabled: true,
    totp: { enabled: true }
  }
  (email, smtp 없음)
When: 서버가 config를 로드함
Then: Zod 유효성 검사 통과
  AND: "2FA enabled requires email and smtp" 오류 미발생
```

#### AC-SCHEMA-2: 기존 이메일-only 설정 유지
```
Given: config.json5에
  twoFactor: {
    enabled: true,
    email: "user@example.com",
    smtp: { ... }
  }
  (totp 없음)
When: 서버가 config를 로드함
Then: Zod 유효성 검사 통과 (기존 동작 유지)
```

#### AC-SCHEMA-3: enabled=true 이지만 이메일/TOTP 모두 없으면 실패
```
Given: config.json5에
  twoFactor: {
    enabled: true
    (email 없음, smtp 없음, totp 없음)
  }
When: 서버가 config를 로드함
Then: Zod 유효성 검사 실패
  AND: "2FA enabled requires either email+smtp or totp configuration" 오류 발생
```

---

## 부록

### A. 구현 우선순위 제안

| 우선순위 | 작업 | FR/NFR |
|---------|------|--------|
| 1 | Zod schema 수정 (TOTP-only 허용) | AC-SCHEMA-1 |
| 2 | TwoFactorConfig, TOTPConfig 타입 추가 | FR-4xx 선결 |
| 3 | TOTPService 신규 구현 | FR-101~203 |
| 4 | index.ts에서 TOTPService 초기화 | FR-101~102 |
| 5 | OTPData에 stage 필드 추가 | FR-305 |
| 6 | authRoutes 다단계 플로우 구현 | FR-3xx, FR-4xx, FR-5xx, FR-6xx |
| 7 | 응답 타입 변경 | FR-8xx |
| 8 | AuthState, AuthContext 변경 | FR-5.2.x |
| 9 | TwoFactorForm 확장 | FR-5.3.x |
| 10 | 인수 조건 기반 통합 테스트 | 전체 |

### B. 에러 코드 신규 추가

| 에러 코드 | HTTP 상태 | 설명 |
|----------|---------|------|
| `TOTP_NOT_REGISTERED` | 503 | TOTP 활성화되었으나 secret 미등록 |
| `TOTP_REUSED` | 400 | 동일 TOTP 코드 재사용 시도 |
| `INVALID_STAGE` | 400 | 예상과 다른 인증 단계 |
| `EMAIL_OTP_FAILED` | - | 이메일 발송 실패 (폴백 처리) |

### C. 설정 예시

#### COMBO-3 설정 (TOTP 전용)
```json5
// server/config.json5
{
  twoFactor: {
    enabled: true,
    otpLength: 6,
    otpExpiryMs: 300000,
    totp: {
      enabled: true,
      issuer: "BuilderGate",
      accountName: "admin"
    }
    // smtp 없음 → TOTP-only
  }
}
```

#### COMBO-4 설정 (이메일 + TOTP)
```json5
{
  twoFactor: {
    enabled: true,
    email: "admin@example.com",
    otpLength: 6,
    otpExpiryMs: 300000,
    smtp: {
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: "...", password: "enc(...)" }
    },
    totp: {
      enabled: true
    }
  }
}
```

#### localhostPasswordOnly 설정
```json5
{
  auth: {
    password: "enc(...)",
    durationMs: 1800000,
    maxDurationMs: 86400000,
    jwtSecret: "",
    localhostPasswordOnly: true  // localhost에서 2FA 건너뜀
  }
}
```

---

## 후속 파이프라인

- **다음 단계**: `snoworca-implementation-planner`
- **입력 인자**:
  - `SPEC_PATH`: `docs/archive/srs/step6.srs.totp-google-authenticator-인증.2026-04-08.md`
  - `CODE_PATH`: `/mnt/c/Work/git/_Snoworca/ProjectMaster`
  - `LANGUAGE`: TypeScript
  - `FRAMEWORK`: React + Express + xterm.js
  - `PRIORITY_ORDER`: Zod schema → Types → TOTPService → index.ts → authRoutes → AuthContext → TwoFactorForm

---

*문서 끝*
