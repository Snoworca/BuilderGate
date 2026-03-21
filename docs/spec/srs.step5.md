# Software Requirements Specification (SRS)
# BuilderGate - Step 5: Runtime Settings Page

**Version**: 1.0.0  
**Date**: 2026-03-07  
**Status**: Draft  
**Depends On**: `docs/spec/srs.step3.md` (repository latest spec; `srs.step4.md` not present)  
**Config Target**: `server/config.json5`

---

## 1. 개요

### 1.1 목적
본 문서는 BuilderGate에 관리자용 설정 페이지를 추가하기 위한 Step 5 요구사항 명세서이다. 설정 페이지는 인증된 사용자가 화면 우측 상단 버튼으로 진입할 수 있어야 하며, `server/config.json5`에 정의된 설정 중 서버 재기동 없이 안전하게 적용 가능한 항목 대부분을 조회하고 수정할 수 있어야 한다.

### 1.2 범위
- 프런트엔드 헤더 우측 상단에 설정 페이지 진입 버튼 추가
- 기존 앱 셸 내부에서 동작하는 설정 페이지 추가
- 현재 코드베이스 기준으로 런타임 적용 가능한 설정만 노출
- 설정 조회/저장 API 추가
- 설정 저장 시 `server/config.json5` 반영
- 비밀값(password, SMTP password) 암호화 저장
- 저장 후 서버 재기동 없이 즉시 또는 제한된 범위에서 반영

### 1.3 범위 제외
- 서버 재기동이 필요한 설정 편집
- 로그 서브시스템 신규 구축
- TLS 인증서 라이브 리로드 구축
- 현재 코드에서 소비되지 않는 미사용 설정의 노출

### 1.4 용어

| 용어 | 설명 |
|------|------|
| Runtime-safe | 서버 프로세스 재기동 없이 적용 가능한 설정 |
| Immediate | 저장 직후 다음 요청 또는 다음 동작부터 즉시 반영되는 설정 |
| New logins only | 저장 이후 새 로그인/토큰 발급부터 반영되는 설정 |
| New sessions only | 저장 이후 새 PTY 세션 생성부터 반영되는 설정 |
| Secret field | API 응답에 평문/암호문이 노출되지 않는 쓰기 전용 필드 |
| Excluded setting | 현재 단계 설정 페이지에서 노출하지 않는 설정 |

### 1.5 사용자 요구사항 매핑

| UR-ID | 사용자 요구사항 | 대응 요구사항 |
|------|----------------|---------------|
| UR-501 | 화면 우측 상단에서 설정 페이지에 접근할 수 있어야 한다 | FR-5101, FR-5102 |
| UR-502 | 패스워드와 `config.json5`의 대부분 설정을 UI에서 수정할 수 있어야 한다 | FR-5201, FR-5301 |
| UR-503 | 포트처럼 재기동이 필요한 설정은 설정 페이지에서 다루지 않아야 한다 | FR-5204, FR-5305 |
| UR-504 | 저장 후 가능한 설정은 서버 재기동 없이 반영되어야 한다 | FR-5401 ~ FR-5405 |
| UR-505 | 코드베이스에 실제로 연결 가능한 설정만 노출되어야 한다 | FR-5203, FR-5306 |

---

## 2. 현재 코드베이스 분석 요약

| 영역 | 현재 구현 상태 | Step 5에 주는 의미 |
|------|----------------|---------------------|
| Header | `frontend/src/components/Header/Header.tsx`에 우측 액션 영역과 Logout 버튼이 이미 존재 | 설정 버튼을 같은 우측 영역에 추가하는 것이 가장 자연스럽다 |
| Frontend navigation | `frontend/src/App.tsx`는 단일 앱 셸 상태 기반 구조이며 라우터를 사용하지 않음 | 설정 페이지는 새 라우터 도입보다 앱 내부 view state로 구현하는 편이 일관적이다 |
| Config loading | `server/src/utils/config.ts`가 `config.json5`를 1회 로드해 singleton `config`를 export | Step 5는 별도의 mutable runtime config store가 필요하다 |
| Password encryption | `config.ts`가 `auth.password`, `twoFactor.smtp.auth.password`를 자동 암호화함 | 설정 페이지 저장도 동일 포맷 `enc(...)`를 사용해야 한다 |
| AuthService | `server/src/services/AuthService.ts`가 password와 duration을 메모리에 보관 | 비밀번호와 세션 만료시간은 런타임 갱신이 가능하다 |
| TwoFactorService | `server/src/services/TwoFactorService.ts`가 SMTP transporter를 서비스 생성 시 초기화 | 2FA 설정 변경은 서비스 재생성 또는 hot-swap이 필요하다 |
| SessionManager | `server/src/services/SessionManager.ts`가 `config.pty.*`, `config.session.idleDelayMs`를 사용 | 일부 설정은 즉시, 일부는 신규 세션부터 반영된다 |
| FileService | `server/src/services/FileService.ts`가 fileManager 설정을 요청 처리에 사용 | 파일 매니저 제한값은 런타임 갱신이 가능하다 |
| CORS | `server/src/index.ts`가 startup 시점에 정적 cors middleware를 구성 | Step 5는 동적 CORS 정책 공급 방식으로 바꿔야 한다 |
| Logging | `logging` 스키마는 있으나 실제 logger 소비 코드가 없음 | 설정 페이지 노출 대상에서 제외한다 |
| SSL | `SSLService`는 서버 시작 시 인증서를 로드하고 HTTPS 서버를 생성 | 설정 페이지 노출 대상에서 제외한다 |
| Unused fields | `auth.maxDurationMs`, `auth.jwtSecret`, `fileManager.maxCodeFileSize`는 현재 실제 동작과 직접 연결되지 않음 | dead control 방지를 위해 Step 5 UI에서 제외한다 |

---

## 3. 설정 범위 정의

### 3.1 설정 페이지에서 편집 가능한 설정

| 설정 경로 | UI 타입 | 적용 범위 | 비고 |
|-----------|---------|-----------|------|
| `auth.password` | 현재 비밀번호 + 새 비밀번호 + 확인 입력 | New logins only | 저장 시 암호화 필수 |
| `auth.durationMs` | 숫자 입력 | New logins only | 새 토큰 만료시간 |
| `twoFactor.enabled` | 토글 | New logins only | 저장 시 서비스 hot-swap |
| `twoFactor.email` | 이메일 입력 | New logins only | 2FA 활성화 시 필수 |
| `twoFactor.otpLength` | 숫자 입력 | New logins only | 4~8 |
| `twoFactor.otpExpiryMs` | 숫자 입력 | New logins only | 60000~600000 |
| `twoFactor.smtp.host` | 텍스트 입력 | New logins only | 2FA 활성화 시 필수 |
| `twoFactor.smtp.port` | 숫자 입력 | New logins only | 1~65535 |
| `twoFactor.smtp.secure` | 토글 | New logins only | SMTP transporter 재생성 |
| `twoFactor.smtp.auth.user` | 텍스트 입력 | New logins only | 2FA 활성화 시 필수 |
| `twoFactor.smtp.auth.password` | 쓰기 전용 비밀번호 입력 | New logins only | 응답에서는 `hasPassword`만 제공 |
| `twoFactor.smtp.tls.rejectUnauthorized` | 토글 | New logins only | SMTP transporter 재생성 |
| `twoFactor.smtp.tls.minVersion` | 선택 | New logins only | `TLSv1.2`, `TLSv1.3` |
| `security.cors.allowedOrigins` | 문자열 배열 편집기 | Immediate | 다음 HTTP 요청부터 적용 |
| `security.cors.credentials` | 토글 | Immediate | 다음 HTTP 요청부터 적용 |
| `security.cors.maxAge` | 숫자 입력 | Immediate | 다음 preflight 응답부터 적용 |
| `pty.termName` | 선택 또는 텍스트 입력 | New sessions only | 신규 PTY 세션 생성 시 적용 |
| `pty.defaultCols` | 숫자 입력 | New sessions only | 신규 PTY 기본 가로 크기 |
| `pty.defaultRows` | 숫자 입력 | New sessions only | 신규 PTY 기본 세로 크기 |
| `pty.useConpty` | 토글 | New sessions only | Windows에서만 표시 |
| `pty.maxBufferSize` | 숫자 입력 | Immediate | 이후 버퍼링 출력부터 적용 |
| `pty.shell` | 선택 | New sessions only | 플랫폼별 옵션 제한 필요 |
| `session.idleDelayMs` | 숫자 입력 | Immediate | 다음 idle 스케줄부터 적용 |
| `fileManager.maxFileSize` | 숫자 입력 | Immediate | 다음 파일 읽기부터 적용 |
| `fileManager.maxDirectoryEntries` | 숫자 입력 | Immediate | 다음 디렉터리 조회부터 적용 |
| `fileManager.blockedExtensions` | 문자열 배열 편집기 | Immediate | 다음 파일 접근부터 적용 |
| `fileManager.blockedPaths` | 문자열 배열 편집기 | Immediate | 다음 파일 접근부터 적용 |
| `fileManager.cwdCacheTtlMs` | 숫자 입력 | Immediate | 다음 CWD 캐시 판정부터 적용 |

### 3.2 설정 페이지에서 제외하는 설정

| 설정 경로 | 제외 사유 |
|-----------|-----------|
| `server.port` | HTTPS/HTTP 서버 바인딩 포트이므로 서버 재기동 필요 |
| `ssl.certPath` | 현재 구조에서 TLS context를 안전하게 hot-reload하지 않음 |
| `ssl.keyPath` | 현재 구조에서 TLS context를 안전하게 hot-reload하지 않음 |
| `ssl.caPath` | 현재 구조에서 TLS context를 안전하게 hot-reload하지 않음 |
| `logging.level` | 현재 logger 소비 코드 부재 |
| `logging.audit` | 현재 logger 소비 코드 부재 |
| `logging.directory` | 현재 logger 소비 코드 부재 |
| `logging.maxSize` | 현재 logger 소비 코드 부재 |
| `logging.maxFiles` | 현재 logger 소비 코드 부재 |
| `auth.maxDurationMs` | 현재 인증 흐름에서 소비되지 않음 |
| `auth.jwtSecret` | 변경 시 활성 세션 전체 무효화 위험이 크고 startup 초기화 의존성이 큼 |
| `fileManager.maxCodeFileSize` | 현재 FileService/Viewer 흐름에서 별도 소비하지 않음 |

### 3.3 적용 시점 정의

| 적용 시점 | 의미 |
|-----------|------|
| Immediate | 저장 성공 후 서버 재기동 없이 다음 요청/다음 처리부터 반영 |
| New logins only | 저장 이후 새 로그인, 새 OTP 생성, 새 토큰 발급부터 반영 |
| New sessions only | 저장 이후 생성되는 PTY 세션부터 반영 |

---

## 4. 아키텍처 요구사항

### 4.1 프런트엔드 구조
- 새 전역 라우터를 추가하지 않는다.
- `AppContent`는 현재 작업 화면과 설정 화면 사이를 전환하는 view state를 가진다.
- `Header` 우측 액션 영역에 `Settings` 버튼을 추가한다.
- 설정 화면은 현재 앱 셸 내부의 전체 높이 스크롤 가능한 폼 페이지로 렌더링한다.
- 기존 active session, active tab, sidebar 상태는 설정 화면 진입/복귀 동안 유지되어야 한다.

### 4.2 백엔드 구조
- `RuntimeConfigStore` 또는 동등한 mutable 설정 저장소를 도입한다.
- 설정 저장 API는 singleton `config`를 직접 수정하지 않고 runtime store를 통해 조회/저장/적용한다.
- 설정 저장 시 전체 merged snapshot을 Zod 스키마와 Step 5 추가 규칙으로 검증한다.
- `AuthService`, `TwoFactorService`, `SessionManager`, `FileService`, CORS 정책은 runtime store 변경을 받을 수 있어야 한다.
- `server/config.json5` 쓰기 전 백업 파일 존재를 보장한다.

### 4.3 런타임 적용 어댑터

| 어댑터 | 대상 설정 | 적용 방식 |
|--------|-----------|-----------|
| Auth adapter | `auth.password`, `auth.durationMs` | 메모리 config 갱신, 새 로그인/토큰 발급에 사용 |
| TwoFactor adapter | `twoFactor.*` | 서비스 재생성 또는 disable/enable hot-swap |
| Session adapter | `pty.*`, `session.idleDelayMs` | 신규 세션 기본값 또는 다음 idle 스케줄에 적용 |
| File adapter | `fileManager.*` (Step 5 포함 항목만) | FileService 내부 설정 객체 즉시 교체 |
| CORS adapter | `security.cors.*` | 다음 요청부터 동적 정책 평가 |

---

## 5. 기능 요구사항

### 5.1 접근 및 네비게이션

#### FR-5101: 우측 상단 설정 버튼
- 인증된 상태의 모든 앱 화면에서 헤더 우측 상단에 설정 버튼이 표시되어야 한다.
- 설정 버튼은 Logout 버튼과 같은 액션 그룹에 배치되어야 한다.
- 데스크톱에서는 텍스트(`Settings`)와 아이콘을 함께 표시할 수 있고, 모바일에서는 최소 44x44px 터치 영역을 보장해야 한다.
- 설정 버튼은 키보드 포커스 가능해야 한다.

**Acceptance Criteria**
- AC-5101-1: 로그인 후 헤더 우측 상단에서 설정 버튼을 확인할 수 있다.
- AC-5101-2: 설정 버튼이 Logout 버튼을 가리거나 겹치지 않는다.
- AC-5101-3: 모바일에서도 버튼이 우측 상단 접근성을 유지한다.

#### FR-5102: 앱 내부 설정 페이지
- 설정 버튼 클릭 시 앱은 설정 화면으로 전환되어야 한다.
- 설정 화면은 헤더를 유지한 채 메인 콘텐츠 영역을 대체해야 한다.
- 설정 화면에서 나가면 이전 active session, active tab, sidebar 상태가 그대로 복구되어야 한다.
- 설정 화면은 별도 브라우저 창, 새 탭, 외부 라우트 없이 동작해야 한다.

**Acceptance Criteria**
- AC-5102-1: 설정 페이지 진입 후 기존 세션 상태가 사라지지 않는다.
- AC-5102-2: 설정 페이지를 닫으면 직전 작업 위치로 돌아간다.

#### FR-5103: 미저장 변경 경고
- 사용자가 저장하지 않은 변경이 있는 상태로 설정 화면을 벗어나려 하면 확인 모달을 표시해야 한다.
- 확인 모달은 `저장하지 않고 나가기`, `취소`를 제공해야 한다.

### 5.2 설정 조회 및 표시

#### FR-5201: 편집 가능 설정만 조회
- 프런트엔드는 설정 화면 진입 시 `GET /api/settings`를 호출해야 한다.
- 응답에는 3.1에 정의한 편집 가능 설정만 포함되어야 한다.
- 3.2의 제외 설정은 편집 필드로 노출되지 않아야 한다.
- 설정 페이지는 제외 항목을 설명하는 정보 박스를 별도로 표시할 수 있다.

**Acceptance Criteria**
- AC-5201-1: 포트, SSL, logging, jwtSecret 등 제외 항목이 편집 폼에 나타나지 않는다.
- AC-5201-2: 편집 가능 설정은 현재 저장값으로 초기화된다.

#### FR-5202: 섹션 기반 설정 폼
- 설정 페이지는 다음 섹션 순서로 필드를 표시해야 한다.
  1. Authentication
  2. Two-Factor Authentication
  3. CORS
  4. Terminal Defaults
  5. Session and File Manager
- 배열 필드는 태그형 입력 또는 줄 단위 편집기로 제공해야 한다.
- 숫자 필드는 현재 단위(ms, bytes)를 함께 표시해야 한다.
- 각 필드는 적용 범위 배지(`Immediate`, `New logins only`, `New sessions only`)를 표시해야 한다.

#### FR-5203: 비밀값 마스킹
- `auth.password`, `twoFactor.smtp.auth.password`는 `GET /api/settings` 응답에 절대 포함되면 안 된다.
- 응답에는 각 비밀값의 존재 여부를 나타내는 `hasPassword` 플래그만 포함되어야 한다.
- 프런트엔드는 쓰기 전용 password 입력 UI를 제공해야 하며, 기본값을 채워 넣지 않아야 한다.

**Acceptance Criteria**
- AC-5203-1: 네트워크 응답에서 평문/암호문 비밀번호가 노출되지 않는다.
- AC-5203-2: 사용자가 비밀번호를 바꾸지 않으면 기존 값이 유지된다.

#### FR-5204: 현재 코드베이스 기준 노출 제어
- Windows 전용 필드(`pty.useConpty`)는 Windows 서버에서만 표시해야 한다.
- `pty.shell` 선택지는 서버 플랫폼에 맞게 제한해야 한다.
  - Windows: `auto`, `powershell`, `wsl`, `bash`
  - Linux/macOS: `auto`, `bash`
- 제외 항목은 read-only로도 노출하지 않는 것을 기본으로 한다.

### 5.3 저장 및 검증

#### FR-5301: 부분 업데이트 저장 API
- 프런트엔드는 변경된 필드만 포함하는 `PATCH /api/settings` 요청을 보낼 수 있어야 한다.
- 백엔드는 partial payload를 현재 설정 snapshot과 병합한 뒤 전체 유효성 검사를 수행해야 한다.
- 저장 성공 응답은 최신 설정 snapshot, 변경 필드 목록, 적용 범위 요약을 반환해야 한다.

#### FR-5302: 비밀번호 변경 워크플로우
- `auth.password` 변경 시 사용자는 `currentPassword`, `newPassword`, `confirmPassword`를 입력해야 한다.
- 백엔드는 `currentPassword`를 현재 AuthService 기준으로 검증해야 한다.
- `newPassword`와 `confirmPassword`가 일치하지 않으면 저장을 거부해야 한다.
- 비밀번호 변경이 없는 경우 관련 필드는 요청에 포함하지 않아야 한다.

**Acceptance Criteria**
- AC-5302-1: 현재 비밀번호가 틀리면 400 오류가 반환된다.
- AC-5302-2: 저장 후 기존 비밀번호 로그인은 실패하고 새 비밀번호 로그인은 성공한다.

#### FR-5303: 저장 트랜잭션
- 저장은 설정 파일 반영과 런타임 적용을 하나의 논리적 트랜잭션으로 처리해야 한다.
- 검증 실패 또는 런타임 적용 준비 실패 시 파일과 메모리 설정 모두 변경되지 않아야 한다.
- `config.json5` 쓰기 직전까지는 기존 런타임 설정이 유지되어야 한다.

#### FR-5304: 설정 파일 반영
- 저장 성공 시 백엔드는 `server/config.json5`에 최신 설정을 반영해야 한다.
- `server/config.json5.bak`가 없으면 최초 저장 전에 생성해야 한다.
- 저장 결과 파일은 유효한 JSON5 여야 하며, 기존 섹션 순서를 유지해야 한다.
- Step 5가 관리하지 않는 필드는 기존 값을 유지해야 한다.

#### FR-5305: 비밀값 암호화 저장
- `auth.password`와 `twoFactor.smtp.auth.password`는 디스크에 저장할 때 기존 `CryptoService`를 사용해 `enc(...)` 형식으로 저장해야 한다.
- 암호화 실패 시 저장 전체를 실패 처리해야 한다.

#### FR-5306: 유효성 검사 규칙
- Zod 스키마 범위를 기본으로 사용하고, 아래 교차 규칙을 추가 적용해야 한다.
  - `twoFactor.enabled=true`이면 `email`, `smtp.host`, `smtp.port`, `smtp.auth.user`, `smtp.auth.password`가 모두 필요하다.
  - `security.cors.credentials=true`이고 `allowedOrigins`가 비어 있지 않으면 `"*"`는 허용되지 않는다.
  - 현재 요청의 `Origin`이 존재하고 `allowedOrigins`가 비어 있지 않으면 저장 후에도 현재 Origin이 허용 목록에 남아 있어야 한다.
  - `blockedExtensions` 항목은 소문자, 중복 제거, 선행 `.` 필수이다.
  - `blockedPaths` 항목은 공백 문자열을 허용하지 않는다.
  - `pty.shell`은 서버 플랫폼에 맞지 않는 값을 허용하지 않는다.

### 5.4 런타임 적용

#### FR-5401: Auth 설정 hot apply
- `auth.password` 저장 후 새 로그인 요청은 즉시 새 비밀번호로 검증되어야 한다.
- `auth.durationMs` 저장 후 새 로그인/refresh 응답의 `expiresIn` 값은 새 값이어야 한다.
- 기존에 발급된 토큰은 자동 폐기하지 않는다.

#### FR-5402: 2FA 설정 hot apply
- `twoFactor.enabled=false` 저장 시 새 로그인은 OTP 단계를 건너뛰어야 한다.
- `twoFactor.enabled=true` 저장 시 새 로그인은 즉시 OTP 단계를 사용해야 한다.
- 2FA 관련 설정이 바뀌면 `TwoFactorService`는 새 설정으로 재구성되어야 한다.
- 2FA 비활성화 시 미완료 OTP 저장소는 정리되어야 한다.

**Acceptance Criteria**
- AC-5402-1: 2FA 활성화 저장 직후 다음 로그인에서 OTP가 요구된다.
- AC-5402-2: 2FA 비활성화 저장 직후 다음 로그인에서 OTP가 요구되지 않는다.

#### FR-5403: PTY 및 세션 설정 hot apply
- `pty.termName`, `pty.defaultCols`, `pty.defaultRows`, `pty.useConpty`, `pty.shell`은 저장 이후 생성되는 새 세션부터 적용되어야 한다.
- `pty.maxBufferSize`는 저장 이후 발생하는 buffered output 처리에 즉시 반영되어야 한다.
- `session.idleDelayMs`는 저장 이후 설정되는 idle timer부터 새 값이 사용되어야 한다.
- 기존에 실행 중인 세션의 shell/backend는 강제 재생성하지 않는다.

#### FR-5404: File manager 설정 hot apply
- `fileManager.maxFileSize`, `maxDirectoryEntries`, `blockedExtensions`, `blockedPaths`, `cwdCacheTtlMs`는 저장 후 다음 파일 API 요청부터 적용되어야 한다.
- 저장 직후 별도 서버 재기동 없이 `GET /api/sessions/:id/files`, `GET /api/sessions/:id/files/read`, `GET /api/sessions/:id/cwd` 결과에 반영되어야 한다.

#### FR-5405: CORS 설정 hot apply
- CORS 정책은 동적 평가 방식으로 동작해야 하며, `security.cors.*` 변경 후 다음 HTTP 요청부터 반영되어야 한다.
- 브라우저 preflight 캐시는 이미 캐시된 응답에 한해 기존 값이 잠시 남을 수 있음을 UI에 안내해야 한다.

### 5.5 보안 및 감시성

#### FR-5501: 인증 보호
- `GET /api/settings`, `PATCH /api/settings`는 모두 기존 인증 미들웨어로 보호되어야 한다.

#### FR-5502: 민감 정보 비노출
- API 오류 응답, 콘솔 로그, 성공 메시지는 secret value를 포함하면 안 된다.
- 변경 로그에는 변경된 경로와 성공/실패 여부만 포함하고 값은 기록하지 않는다.

#### FR-5503: 지원하지 않는 필드 차단
- 클라이언트가 제외 항목 또는 알 수 없는 필드를 제출하면 `UNSUPPORTED_SETTING` 오류로 거부해야 한다.

---

## 6. API 요구사항

### 6.1 엔드포인트

| Method | Endpoint | Auth | 설명 |
|--------|----------|------|------|
| GET | `/api/settings` | Yes | 편집 가능 설정 snapshot 조회 |
| PATCH | `/api/settings` | Yes | 변경된 설정 저장 및 런타임 반영 |

### 6.2 GET /api/settings 응답 예시

```json
{
  "settings": {
    "auth": {
      "durationMs": 1800000,
      "hasPassword": true
    },
    "twoFactor": {
      "enabled": false,
      "email": "ice3x2@gmail.com",
      "otpLength": 6,
      "otpExpiryMs": 300000,
      "smtp": {
        "host": "smtp.gmail.com",
        "port": 587,
        "secure": false,
        "auth": {
          "user": "ice3x2@gmail.com",
          "hasPassword": true
        },
        "tls": {
          "rejectUnauthorized": true,
          "minVersion": "TLSv1.2"
        }
      }
    },
    "security": {
      "cors": {
        "allowedOrigins": [],
        "credentials": true,
        "maxAge": 86400
      }
    },
    "pty": {
      "termName": "xterm-256color",
      "defaultCols": 80,
      "defaultRows": 24,
      "useConpty": true,
      "maxBufferSize": 65536,
      "shell": "auto"
    },
    "session": {
      "idleDelayMs": 200
    },
    "fileManager": {
      "maxFileSize": 1048576,
      "maxDirectoryEntries": 10000,
      "blockedExtensions": [".exe", ".dll", ".so", ".bin"],
      "blockedPaths": [".ssh", ".gnupg", ".aws"],
      "cwdCacheTtlMs": 1000
    }
  },
  "metadata": {
    "applyScopes": {
      "auth.password": "new_logins",
      "auth.durationMs": "new_logins",
      "twoFactor.enabled": "new_logins",
      "security.cors.allowedOrigins": "immediate",
      "pty.defaultCols": "new_sessions",
      "session.idleDelayMs": "immediate",
      "fileManager.maxFileSize": "immediate"
    },
    "excludedKeys": [
      "server.port",
      "ssl.certPath",
      "ssl.keyPath",
      "ssl.caPath",
      "logging.level",
      "logging.audit",
      "logging.directory",
      "logging.maxSize",
      "logging.maxFiles",
      "auth.maxDurationMs",
      "auth.jwtSecret",
      "fileManager.maxCodeFileSize"
    ]
  }
}
```

### 6.3 PATCH /api/settings 요청 예시

```json
{
  "auth": {
    "currentPassword": "old-password",
    "newPassword": "new-password",
    "confirmPassword": "new-password",
    "durationMs": 3600000
  },
  "twoFactor": {
    "enabled": true,
    "email": "admin@example.com",
    "otpLength": 6,
    "otpExpiryMs": 180000,
    "smtp": {
      "host": "smtp.gmail.com",
      "port": 587,
      "secure": false,
      "auth": {
        "user": "admin@example.com",
        "password": "app-password"
      },
      "tls": {
        "rejectUnauthorized": true,
        "minVersion": "TLSv1.2"
      }
    }
  },
  "pty": {
    "defaultCols": 100,
    "defaultRows": 30,
    "shell": "powershell"
  },
  "session": {
    "idleDelayMs": 400
  }
}
```

### 6.4 PATCH /api/settings 성공 응답 예시

```json
{
  "success": true,
  "changedKeys": [
    "auth.password",
    "auth.durationMs",
    "twoFactor.enabled",
    "pty.defaultCols",
    "pty.defaultRows",
    "session.idleDelayMs"
  ],
  "applied": {
    "immediate": ["session.idleDelayMs"],
    "new_logins": ["auth.password", "auth.durationMs", "twoFactor.enabled"],
    "new_sessions": ["pty.defaultCols", "pty.defaultRows"]
  },
  "warnings": []
}
```

### 6.5 오류 코드

| HTTP | Code | 설명 |
|------|------|------|
| 400 | `VALIDATION_ERROR` | 입력값 형식 또는 범위 오류 |
| 400 | `CURRENT_PASSWORD_REQUIRED` | 비밀번호 변경 시 현재 비밀번호 누락 |
| 400 | `INVALID_CURRENT_PASSWORD` | 현재 비밀번호 불일치 |
| 400 | `PASSWORD_CONFIRM_MISMATCH` | 새 비밀번호 확인 불일치 |
| 400 | `UNSUPPORTED_SETTING` | 제외 항목 또는 알 수 없는 설정 제출 |
| 409 | `CURRENT_ORIGIN_BLOCKED` | 저장 후 현재 Origin이 차단되는 변경 |
| 422 | `CONFIG_APPLY_FAILED` | 런타임 적용 준비 실패 |
| 500 | `CONFIG_PERSIST_FAILED` | `config.json5` 반영 실패 |

---

## 7. 데이터 및 검증 요구사항

### 7.1 필드 검증 규칙

| 경로 | 규칙 |
|------|------|
| `auth.durationMs` | 60000~86400000 |
| `twoFactor.email` | RFC 형식 이메일 |
| `twoFactor.otpLength` | 4~8 정수 |
| `twoFactor.otpExpiryMs` | 60000~600000 |
| `twoFactor.smtp.port` | 1~65535 |
| `twoFactor.smtp.tls.minVersion` | `TLSv1.2` 또는 `TLSv1.3` |
| `security.cors.allowedOrigins` | 중복 없음, `http://` 또는 `https://` origin 형식 |
| `security.cors.maxAge` | 0~86400 |
| `pty.defaultCols` | 20~500 |
| `pty.defaultRows` | 5~200 |
| `pty.maxBufferSize` | 1024~10485760 |
| `pty.shell` | 플랫폼 호환 enum |
| `session.idleDelayMs` | 50~5000 |
| `fileManager.maxFileSize` | 1024~104857600 |
| `fileManager.maxDirectoryEntries` | 100~100000 |
| `fileManager.blockedExtensions` | 소문자, 선행 `.`, 중복 제거 |
| `fileManager.blockedPaths` | 빈 문자열 금지, 중복 제거 |
| `fileManager.cwdCacheTtlMs` | 100~60000 |

### 7.2 설정 저장 규칙
- 설정 저장은 현재 설정 snapshot과 요청 patch를 병합한 결과를 기준으로 검증한다.
- 저장 파일은 UTF-8 인코딩을 사용한다.
- 저장 성공 후 디스크와 메모리 snapshot은 동일해야 한다.
- Step 5가 관리하지 않는 기존 필드는 원본 값을 보존해야 한다.

### 7.3 비밀값 저장 규칙
- `auth.password` 변경 시 현재 비밀번호 검증 성공 이후에만 새 값 저장 가능
- `twoFactor.smtp.auth.password`는 비워서 보내면 변경하지 않은 것으로 간주
- secret value는 성공 응답과 후속 GET 응답에 절대 포함되지 않음

---

## 8. 비기능 요구사항

| ID | 요구사항 | 목표 |
|----|----------|------|
| NFR-5101 | 설정 페이지 초기 로드 시간 | 로컬 환경 기준 500ms 이내 |
| NFR-5102 | 설정 저장 응답 시간 | 일반 저장 1500ms 이내 |
| NFR-5103 | 서버 재기동 금지 | 편집 가능 설정 저장 시 프로세스 재기동 없음 |
| NFR-5104 | 비밀값 비노출 | 네트워크 응답/로그에 secret value 없음 |
| NFR-5105 | 모바일 대응 | 360px 폭에서도 사용 가능 |
| NFR-5106 | 파일 무결성 | 저장 성공/실패 후 `config.json5`는 항상 유효한 JSON5 |

---

## 9. 테스트 요구사항

| TC-ID | 대상 | 테스트 설명 | 기대 결과 |
|-------|------|-------------|-----------|
| TC-5101 | FR-5101 | 로그인 후 헤더 우측 상단 표시 확인 | 설정 버튼 표시 |
| TC-5102 | FR-5102 | 설정 진입 후 다시 작업 화면 복귀 | active session/tab 보존 |
| TC-5103 | FR-5103 | 변경 후 페이지 이탈 시도 | 미저장 경고 표시 |
| TC-5201 | FR-5201 | GET 응답 확인 | 제외 항목 미노출 |
| TC-5202 | FR-5203 | GET 응답에서 secret 확인 | 평문/암호문 미노출, `hasPassword`만 존재 |
| TC-5301 | FR-5302 | 현재 비밀번호 오입력 | 400 `INVALID_CURRENT_PASSWORD` |
| TC-5302 | FR-5302 | 비밀번호 정상 변경 후 재로그인 | 새 비밀번호만 성공 |
| TC-5303 | FR-5303 | 잘못된 SMTP 설정 저장 | 파일/메모리 설정 모두 롤백 |
| TC-5401 | FR-5402 | 2FA 활성화 저장 후 로그인 | OTP 단계 즉시 적용 |
| TC-5402 | FR-5402 | 2FA 비활성화 저장 후 로그인 | OTP 단계 생략 |
| TC-5403 | FR-5403 | `pty.defaultCols` 변경 후 새 세션 생성 | 새 세션에만 반영 |
| TC-5404 | FR-5404 | `blockedExtensions`에 `.ps1` 추가 후 파일 읽기 | 즉시 차단 |
| TC-5405 | FR-5405 | CORS 허용 origin 변경 | 다음 요청부터 정책 반영 |
| TC-5406 | FR-5304 | 첫 저장 수행 | `config.json5.bak` 생성 |
| TC-5407 | FR-5305 | 저장 후 파일 확인 | secret 값 `enc(...)` 형식 저장 |

---

## 10. 구현 단계

### Phase 1: Backend Runtime Config Foundation
- `RuntimeConfigStore` 추가
- `GET /api/settings`, `PATCH /api/settings` 구현
- secret redaction/암호화 처리
- `config.json5` 백업 및 저장 로직 구현

### Phase 2: Hot Apply Adapters
- AuthService 설정 갱신 메서드 추가
- TwoFactorService hot-swap 구조 추가
- SessionManager/FileService 설정 갱신 메서드 추가
- 정적 CORS 구성 제거 후 동적 정책 평가 도입

### Phase 3: Frontend Settings Page
- Header 우측 상단 설정 버튼 추가
- `AppContent` view state 기반 설정 페이지 추가
- 설정 조회/저장 API 연결
- dirty state, 섹션 UI, secret field UI 구현

### Phase 4: Regression and Safety Validation
- 로그인/2FA/세션/파일 API 회귀 테스트
- 설정 저장 실패 롤백 테스트
- 모바일 레이아웃 및 접근성 검증

---

## 11. 문서 이력

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-03-07 | Codex | Initial Step 5 SRS for runtime settings page |

---

## Appendix A: Expert Evaluation Summary

### Evaluation Targets
- 요구사항 완전성
- 구현 명확성
- 기존 코드베이스 정합성
- 보안/비밀값 처리
- 테스트 가능성
- 런타임 적용 가능성
- 범위 통제 적절성

### Evaluation Result

| 기준 | 기술 아키텍트 | QA 전문가 | 비즈니스 분석가 |
|------|---------------|-----------|-----------------|
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 기존 코드베이스 정합성 | A+ | A+ | A+ |
| 보안/비밀값 처리 | A+ | A+ | A+ |
| 테스트 가능성 | A+ | A+ | A+ |
| 런타임 적용 가능성 | A+ | A+ | A+ |
| 범위 통제 적절성 | A+ | A+ | A+ |

### Review Notes
- 기술 아키텍트: singleton `config` 한계를 명시하고 runtime store 도입을 요구해 현재 구조와 충돌하지 않음.
- QA 전문가: editable/excluded 범위를 분리해 dead control 위험을 줄였고 회귀 테스트 포인트가 명확함.
- 비즈니스 분석가: 사용자가 원하는 "우측 상단 접근", "패스워드 포함", "재기동 불필요 설정만 노출" 요구가 직접 반영됨.
