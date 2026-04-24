# BuilderGate

> ⚠️ **이 프로젝트는 현재 활발히 개발 중입니다.** API, 설정 구조, UI가 예고 없이 변경될 수 있습니다.

코딩 에이전트 병렬 운용을 위한 웹 기반 통합 개발 환경.  
브라우저 하나로 다수의 셸 세션을 관리하고, 파일 탐색/편집하며, 세션 간 에이전트 명령을 중계합니다.

## 주요 기능

- **웹 터미널** — 다중 세션/탭, PTY 기반 (xterm.js)
- **그리드 레이아웃** — 모자익 분할로 여러 터미널 동시 표시, 드래그 크기 조절
- **워크스페이스** — 세션 그룹 관리, 탭/그리드 모드 전환
- **파일 매니저** — Mdir 스타일 파일 탐색, 마크다운/코드 뷰어
- **보안** — HTTPS + JWT 인증 + 2단계 인증(OTP) + 자동 SSL 인증서

## 기술 스택

| 영역 | 기술 |
|------|------|
| Backend | Node.js, Express, TypeScript, node-pty |
| Frontend | React 18, TypeScript, Vite, xterm.js |
| 통신 | WebSocket (양방향) + HTTP REST API |
| 설정 | JSON5 + Zod validation |
| 보안 | AES-256-GCM 암호화, JWT (HS256), OTP 2FA |

---

## 빠른 시작

### 사전 요구사항

- Node.js 18 이상
- npm

### 설치 및 실행

```bash
# 의존성 설치
cd server && npm install && cd ..
cd frontend && npm install && cd ..

# 개발 모드 실행
node dev.js
```

브라우저에서 `https://localhost:4242` 접속합니다. 자체 서명 인증서를 사용하므로 브라우저 보안 경고가 표시될 수 있습니다.

- **초기 비밀번호**: 첫 접속 시 브라우저에서 관리자 비밀번호를 직접 설정합니다.

### 포트 변경

```bash
node dev.js                            # 기본: 서버 4242, 프론트 4545
node dev.js --port 5000                # 서버 5000, 프론트 5303
node dev.js --port 5000 --fport 3000   # 서버 5000, 프론트 3000
```

`--fport`를 생략하면 서버 포트 + 303으로 자동 계산됩니다.

---

## 설정 파일

소스 실행 시 서버 설정은 `server/config.json5`에서 관리합니다. EXE 배포본은 `BuilderGate.exe`와 같은 위치의 `config.json5`를 사용합니다. JSON5 형식이므로 주석을 지원합니다.

> **비밀번호 자동 암호화**: 설정 파일에 평문으로 입력한 비밀번호는 서버 시작 시 자동으로 `enc(...)` 형식으로 암호화됩니다. 암호화 키는 머신 고유 정보(hostname + platform + arch)에서 유도됩니다.

### 서버 기본 설정

```json5
{
  server: {
    port: 4242,              // 서버 포트 (기본 4242)
  },
}
```

### PTY (터미널) 설정

설정 파일이 없으면 첫 실행 시 현재 OS에 맞는 기본값으로 자동 생성됩니다. 소스 실행은 `server/config.json5`, EXE 실행은 `dist/bin/config.json5`가 생성됩니다.

- Windows: `useConpty: true`, `windowsPowerShellBackend: "inherit"`, `shell: "auto"`
- macOS/Linux: `useConpty: false`, `windowsPowerShellBackend: "inherit"`, `shell: "auto"`

```json5
{
  pty: {
    termName: "xterm-256color",  // 터미널 타입
    defaultCols: 80,             // 기본 열 수
    defaultRows: 24,             // 기본 행 수
    useConpty: false,            // 저장소 예시는 cross-platform 중립값
    windowsPowerShellBackend: "inherit", // PowerShell 전용 backend override (Windows only)
    maxSnapshotBytes: 2097152,   // authoritative snapshot 최대 크기
    scrollbackLines: 1000,       // headless scrollback logical lines
    shell: "auto",               // 셸 종류: auto, powershell, wsl, bash, cmd
  },
}
```

`maxBufferSize`는 기존 설정 파일 호환용 legacy alias이며, 현재 런타임 기준 필드는 `maxSnapshotBytes`입니다.

| shell 값 | 동작 | 사용 시나리오 |
|----------|------|--------------|
| `auto` | OS 기본 셸 (Windows → PowerShell, macOS → 가능하면 zsh, 그 외 → bash 또는 sh) | 대부분의 경우 권장 |
| `powershell` | PowerShell 강제 (Windows 전용) | Windows 스크립트 개발 시 |
| `wsl` | WSL bash (Windows 전용, WSL 설치 필요) | Windows에서 Linux 환경 필요 시 |
| `bash` | bash (Linux/macOS 네이티브) | Linux/macOS 셸 스크립트 개발 시 |
| `zsh` | zsh (macOS/Linux) | Oh My Zsh 등 zsh 플러그인 사용 시 |
| `sh` | POSIX sh | 이식성 높은 스크립트 실행 시 |
| `cmd` | Windows 명령 프롬프트 | 레거시 배치 파일 실행 시 |

### 인증 설정

```json5
{
  bootstrap: {
    allowedIps: [],             // 기본값: localhost 만 초기 비밀번호 설정 허용
  },

  auth: {
    password: "",                // 빈 값이면 브라우저에서 초기 관리자 비밀번호 설정
    durationMs: 1800000,         // 세션 유지 시간 (기본 30분)
    maxDurationMs: 86400000,     // 최대 세션 시간 (기본 24시간)
    jwtSecret: "",               // JWT 서명 키 (빈 값이면 자동 생성)
  },
}
```

- `auth.password`가 비어 있으면 로그인 폼 대신 초기 비밀번호 설정 화면이 표시됩니다.
- 비밀번호를 변경하려면 `password` 필드에 새 평문을 입력하고 서버를 재시작하면 자동 암호화됩니다.
- `jwtSecret`을 빈 값으로 두면 서버 시작마다 새 키가 생성되어, 재시작 시 기존 세션이 무효화됩니다.

### 초기 비밀번호 bootstrap

- 기본 정책은 `localhost` 전용입니다.
- 원격 장치에서 최초 설정이 필요하면 `bootstrap.allowedIps` 또는 실행 옵션 `--bootstrap-allow-ip`로 허용 IP를 명시합니다.
- 비밀번호가 한 번 설정되면 bootstrap API는 더 이상 열리지 않습니다.

### SSL/TLS 설정

```json5
{
  ssl: {
    certPath: "",    // 인증서 경로 (빈 값 = 자체 서명 인증서 자동 생성)
    keyPath: "",     // 개인 키 경로
    caPath: "",      // CA 체인 경로 (선택)
  },
}
```

- 경로를 비워두면 `server/certs/` 디렉토리에 자체 서명 인증서가 자동 생성됩니다 (유효기간 365일).
- 자체 인증서를 사용하려면 `certPath`와 `keyPath`에 PEM 파일 경로를 지정합니다.

### 세션 설정

```json5
{
  session: {
    idleDelayMs: 200,   // 마지막 출력 후 idle 상태 전환까지 대기 시간 (ms)
  },
}
```

### 파일 매니저 설정

```json5
{
  fileManager: {
    maxFileSize: 1048576,          // 파일 읽기 최대 크기 (기본 1MB)
    maxCodeFileSize: 524288,       // 코드 파일 최대 크기 (기본 500KB)
    maxDirectoryEntries: 10000,    // 디렉토리 항목 최대 수
    blockedExtensions: [".exe", ".dll", ".so", ".bin"],
    blockedPaths: [".ssh", ".gnupg", ".aws"],
    cwdCacheTtlMs: 1000,           // CWD 캐시 TTL (ms)
  },
}
```

### 워크스페이스 설정

```json5
{
  workspace: {
    dataPath: "./data/workspaces.json",  // 워크스페이스 데이터 저장 경로
    maxWorkspaces: 10,                   // 최대 워크스페이스 수
    maxTabsPerWorkspace: 8,              // 워크스페이스당 최대 탭 수
    maxTotalSessions: 32,                // 전체 세션 최대 수
    flushDebounceMs: 5000,               // 데이터 저장 디바운싱 (ms)
  },
}
```

---

## 2단계 인증 (2FA) 설정

BuilderGate는 TOTP(Time-based One-Time Password) 기반 2단계 인증을 지원합니다. Google Authenticator, 1Password, Authy 같은 표준 인증 앱을 사용할 수 있습니다.

### 설정 방법

`server/config.json5`의 `twoFactor` 섹션을 수정합니다:

```json5
{
  twoFactor: {
    enabled: true,                 // TOTP 2FA 활성화
    externalOnly: false,           // true: localhost 접속은 2FA 생략
    issuer: "BuilderGate",         // QR issuer
    accountName: "admin",          // QR account label
  },
}
```

### 등록 절차

1. `twoFactor.enabled: true`로 저장합니다.
2. Settings 페이지에서 QR 코드와 `otpauth://` URI를 확인합니다.
3. 인증 앱으로 QR을 스캔하거나 수동 키를 등록합니다.
4. 다음 로그인부터 비밀번호 뒤에 TOTP 코드가 추가로 요구됩니다.

### 로그인 흐름 (2FA 활성화 시)

```
1. 비밀번호 입력 → 서버 검증
2. 인증 앱의 6자리 TOTP 코드 입력
3. TOTP 코드 검증
4. 검증 성공 → JWT 토큰 발급 → 로그인 완료
```

### 제한 사항

- TOTP 입력 시도는 **최대 3회**입니다. 초과 시 새로 로그인해야 합니다.
- `externalOnly: true`이면 localhost 접속은 비밀번호만으로 통과하고, 외부 접속만 2FA를 요구합니다.
- TOTP secret은 서버 데이터 디렉토리에 저장되며, 손상되면 재등록이 필요합니다.

### 런타임 설정 변경

서버 실행 중에도 Settings 페이지(`⚙` 아이콘)에서 2FA 설정을 변경할 수 있습니다. QR 미리보기는 저장 직후 즉시 갱신되고, 변경된 2FA 요구 여부는 **다음 로그인부터** 적용됩니다.

---

## CORS 설정

Cross-Origin 요청 정책을 설정합니다. 개발 환경에서는 비워두고, 프로덕션에서는 신뢰된 도메인만 명시합니다.

```json5
{
  security: {
    cors: {
      allowedOrigins: [],    // 허용할 오리진 (빈 배열 = 모두 허용)
      credentials: true,     // 인증 정보 포함 허용
      maxAge: 86400,         // Preflight 캐시 시간 (초, 0~86400)
    },
  },
}
```

---

## 로깅 설정

서버 로깅 및 보안 감사 로깅을 설정합니다. 개발 시 `debug`, 운영 시 `info` 또는 `warn` 권장.

```json5
{
  logging: {
    level: "info",       // error(오류만) < warn(경고) < info(일반) < debug(상세)
    audit: true,         // 보안 감사 로깅 (인증, 접근 제어 이벤트)
    directory: "logs",   // 로그 저장 디렉토리
    maxSize: "10m",      // 파일 로테이션 크기
    maxFiles: 14,        // 보관할 로그 파일 수 (14개 ≈ 2주)
  },
}
```

---

## 라이선스

이 프로젝트는 비공개 프로젝트입니다.
---

## 프로덕션 실행

개발용 `dev.js` 대신 실제 배포와 가까운 방식으로 실행하려면 루트 디렉토리에서 `start.sh` 또는 `start.bat`을 사용합니다. 이 방식은 필요한 빌드 산출물을 준비한 뒤 PM2 백그라운드 프로세스로 서버를 실행합니다.

Windows:

```bat
start.bat
start.bat -p 2002
start.bat --reset-password
start.bat --reset-password --bootstrap-allow-ip 192.168.0.50
```

Linux/macOS:

```bash
./start.sh
./start.sh -p 2002
./start.sh --reset-password
./start.sh --reset-password --bootstrap-allow-ip 192.168.0.50
```

포트는 다음 순서로 결정됩니다.

1. `-p`
2. `--port`
3. `server/config.json5`의 `server.port`
4. 기본값 `2222`

실행 스크립트가 수행하는 작업은 다음과 같습니다.

1. `frontend`와 `server`의 빌드 산출물이 있는지 확인합니다.
2. 산출물이 없으면 `frontend`와 `server`에서 `npm install`을 실행합니다.
3. `frontend`를 빌드하고, `server`를 빌드합니다.
4. 프론트엔드 산출물을 `server/dist/public`으로 복사합니다.
5. PM2가 없으면 설치하고, `buildergate` 앱을 백그라운드로 시작합니다.

추가 실행 옵션:

- `--reset-password`: `server/config.json5`의 `auth.password`만 비워 브라우저 초기 비밀번호 설정 모드로 되돌립니다.
- `--bootstrap-allow-ip <ip[,ip]>`: 지정한 IP에서만 초기 비밀번호 설정을 임시 허용합니다.

상태 확인:

```bash
curl -k https://localhost:2002/health
```

중지:

```bash
node stop.js
```

## 데몬 EXE 빌드와 실행

Windows 배포용 데몬 런처 EXE는 루트 디렉토리에서 다음 명령으로 빌드합니다.

```bash
npm run build:daemon-exe
```

빌드 결과는 `dist/bin/`에 생성됩니다.

- `BuilderGate.exe`: 항상 PM2 데몬/백그라운드 모드로 BuilderGate를 시작합니다.
- `BuilderGateStop.exe`: PM2로 실행 중인 `buildergate` 프로세스를 중지하고 제거합니다.
- `config.json5`: EXE와 같은 위치에서 읽는 런타임 설정 파일입니다. 빌드 시 기존 `server/config.json5`가 있으면 이 위치로 복사됩니다.
- `config.json5.example`: 설정 예시 파일입니다.
- `server/`: 실행에 필요한 서버 빌드 산출물, 프로덕션 의존성, 로컬 PM2, 번들 Node 런타임을 포함합니다.

`BuilderGate.exe`만 단독으로 복사하지 말고 `dist/bin/` 폴더 전체를 함께 배포해야 합니다. EXE는 같은 폴더의 `config.json5`와 `server/` 런타임을 기준으로 동작합니다.

EXE 실행:

```bat
dist\bin\BuilderGate.exe
dist\bin\BuilderGate.exe -p 2002
dist\bin\BuilderGate.exe --reset-password
dist\bin\BuilderGate.exe --reset-password --bootstrap-allow-ip 192.168.0.50
```

EXE 중지:

```bat
dist\bin\BuilderGateStop.exe
```

EXE 상태 확인:

```bash
curl -k https://localhost:2002/health
```

빌드 대상 플랫폼을 명시하려면 `pkg` target을 전달합니다.

```bash
node tools/build-daemon-exe.js --target node18-win-x64
```
