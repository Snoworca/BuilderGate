# BuilderGate

> 이 프로젝트는 현재 활발히 개발 중입니다. API, 설정 구조, UI가 예고 없이 변경될 수 있습니다.

BuilderGate는 코딩 에이전트 병렬 운용을 위한 웹 기반 통합 개발 환경입니다. 브라우저 하나로 다수의 셸 세션을 관리하고, 파일 탐색/편집, 워크스페이스, 분할 터미널, JWT 인증, TOTP 2FA를 제공합니다.

## 주요 기능

- 웹 터미널: 다중 세션/탭, PTY 기반 xterm.js 터미널
- 그리드 레이아웃: 여러 터미널 동시 표시와 드래그 크기 조절
- 워크스페이스: 세션 그룹, 탭, 그리드 상태 관리
- 파일 매니저: 파일 탐색, 마크다운/코드 뷰어
- 보안: HTTPS, JWT, 초기 비밀번호 bootstrap, 선택적 TOTP 2FA
- 배포 실행 파일: Windows EXE, Linux/macOS 실행 파일, macOS app bundle

## 지원 배포 파일

GitHub Release asset 또는 `npm run build` 결과물은 단일 top-level 폴더를 포함합니다. 폴더 전체를 같은 위치에 유지해야 하며 실행 파일만 따로 복사하면 안 됩니다.

| 대상 | Release asset | 실행 파일 |
|------|---------------|-----------|
| Windows amd64 | `BuilderGate-win-amd64-<version>.zip` | `BuilderGate.exe` |
| Windows ARM64 | `BuilderGate-win-arm64-<version>.zip` | `BuilderGate.exe` |
| Linux amd64 | `BuilderGate-linux-amd64-<version>.tar.gz` | `buildergate` |
| Linux ARM64 | `BuilderGate-linux-arm64-<version>.tar.gz` | `buildergate` |
| macOS ARM64 | `BuilderGate-macos-arm64-<version>.zip` | `buildergate`, `BuilderGate.app` |

배포 폴더에는 보통 다음 항목이 있습니다.

- `BuilderGate.exe` 또는 `buildergate`: BuilderGate 런처입니다.
- `BuilderGate.app`: macOS ARM64 앱 번들입니다.
- `config.json5`: 실행 파일 옆의 런타임 설정 파일입니다.
- `web/`: 프론트엔드 정적 파일입니다.
- `shell-integration/`: 터미널 셸 통합 스크립트입니다.
- `runtime/`: 실행 중 생성되는 daemon state, 로그, TOTP secret 저장 위치입니다.
- `README.md`: 이 문서의 배포본 복사본입니다.

## 빌드

로컬에서 배포 실행 파일을 만들 때만 Node.js와 npm이 필요합니다. 실행만 하는 사용자는 Release asset을 내려받아 압축을 풀면 됩니다.

전체 지원 대상 빌드:

```bash
npm run build
```

대상별 빌드:

```bash
npm run build:windows-amd64
npm run build:windows-arm64
npm run build:linux-amd64
npm run build:linux-arm64
npm run build:macos-arm64
```

빌드 결과는 `dist/bin/<target>-<version>/` 아래에 생성됩니다. 예: `dist/bin/win-amd64-0.4.0/BuilderGate.exe`.

## 빠른 실행

배포 파일을 새 폴더에 압축 해제한 뒤 OS에 맞는 실행 파일을 실행합니다. 기본 모드는 네이티브 데몬입니다. 런처가 BuilderGate app process와 sentinel watchdog을 백그라운드로 띄운 뒤 콘솔을 반환합니다.

Windows:

```bat
BuilderGate.exe
BuilderGate.exe -p 2002
BuilderGate.exe --port 24443
BuilderGate.exe --foreground -p 2002
BuilderGate.exe stop
```

Linux:

```bash
chmod +x ./buildergate
./buildergate
./buildergate -p 2002
./buildergate --port 24443
./buildergate --foreground -p 2002
./buildergate stop
```

macOS ARM64:

```bash
chmod +x ./buildergate
./buildergate
./buildergate -p 2002
./buildergate --foreground -p 2002
./buildergate stop
open ./BuilderGate.app
```

브라우저 접속:

```text
https://localhost:2002
```

자체 서명 인증서를 사용하면 브라우저 보안 경고가 표시될 수 있습니다.

상태 확인:

```bash
curl -k https://localhost:2002/health
```

## 실행 모드

| 모드 | 명령 | 동작 |
|------|------|------|
| daemon | `BuilderGate.exe`, `./buildergate` | 기본값입니다. 백그라운드 app process와 sentinel watchdog을 시작합니다. |
| foreground | `BuilderGate.exe --foreground`, `./buildergate --foreground` | 현재 콘솔에 서버를 붙여 실행합니다. 종료는 `Ctrl+C`입니다. |
| legacy foreground alias | `--forground` | 기존 오타 호환 alias입니다. `--foreground`와 같습니다. |
| stop | `BuilderGate.exe stop`, `./buildergate stop` | 실행 중인 daemon을 내부 shutdown protocol로 종료합니다. |
| help | `BuilderGate.exe --help`, `./buildergate --help` | 실행 옵션을 출력합니다. |

`stop`은 daemon state를 기준으로 종료합니다. Foreground로 실행한 프로세스는 `stop` 대상이 아니며 해당 콘솔에서 `Ctrl+C`로 종료해야 합니다.

## 포트 변경

HTTPS 포트는 다음 우선순위로 결정됩니다.

1. `-p <port>`
2. `--port <port>` 또는 `--port=<port>`
3. `config.json5`의 `server.port`
4. 새 `config.json5`가 생성될 때의 기본값 `2002`

예시:

```bat
BuilderGate.exe -p 2002
BuilderGate.exe --port 24443
```

```bash
./buildergate -p 2002
./buildergate --port 24443
```

HTTP redirect port는 HTTPS 포트보다 1 작은 값입니다. 예를 들어 HTTPS가 `2002`이면 redirect port는 `2001`입니다.

## 최초 실행과 비밀번호

배포본의 `config.json5`는 기본적으로 bootstrap-ready 상태입니다.

```json5
auth: {
  password: "",
  jwtSecret: "",
}
```

`auth.password`가 비어 있으면 첫 접속 시 로그인 화면 대신 초기 관리자 비밀번호 설정 화면이 표시됩니다. 최초 password setup은 localhost에서만 허용됩니다. 원격 장치에서 최초 설정해야 할 때는 임시 allowlist를 사용합니다.

```bat
BuilderGate.exe --bootstrap-allow-ip 192.168.0.50
```

```bash
./buildergate --bootstrap-allow-ip 192.168.0.50
```

여러 IP는 쉼표로 구분합니다.

```bash
./buildergate --bootstrap-allow-ip 192.168.0.50,10.0.0.8
```

초기 비밀번호 규칙:

- 길이: 4자 이상 128자 이하
- 허용 문자: `A-Z`, `a-z`, `0-9`, `!@#$%^&*()_+=/-`
- 금지 문자: 공백, 한글, 이모지, 기타 특수문자
- 유효한 비밀번호는 trim 또는 truncate하지 않고 그대로 암호화 저장됩니다.

## 비밀번호 리셋

비밀번호를 초기 설정 상태로 되돌리려면 먼저 실행 중인 daemon을 종료한 뒤 `--reset-password`로 다시 시작합니다.

Windows:

```bat
BuilderGate.exe stop
BuilderGate.exe --reset-password
```

Linux/macOS:

```bash
./buildergate stop
./buildergate --reset-password
```

원격 장치에서 다시 초기 설정을 해야 한다면 allowlist를 함께 지정합니다.

```bash
./buildergate --reset-password --bootstrap-allow-ip 192.168.0.50
```

`--reset-password`는 실행 파일 옆 `config.json5`의 `auth.password`만 비웁니다. 이미 실행 중인 daemon에는 적용되지 않으므로 먼저 `stop`을 실행해야 합니다.

## 종료

Daemon 종료:

```bat
BuilderGate.exe stop
```

```bash
./buildergate stop
```

`stop`은 daemon state와 PID identity를 검증하고 sentinel을 먼저 멈춘 뒤, loopback 내부 shutdown route로 workspace/CWD 저장 완료를 확인합니다. 종료 실패는 숨기지 않고 non-zero exit로 반환됩니다.

Foreground 종료:

```text
Ctrl+C
```

## 설정 파일

실행 파일은 같은 폴더의 `config.json5`를 읽습니다. `BUILDERGATE_CONFIG_PATH` 환경 변수가 있으면 그 경로가 우선합니다. JSON5 형식이므로 주석을 사용할 수 있습니다.

최소 설정 예:

```json5
{
  server: {
    port: 2002,
  },

  auth: {
    password: "",
    durationMs: 1800000,
    maxDurationMs: 86400000,
    jwtSecret: "",
    localhostPasswordOnly: false,
  },

  bootstrap: {
    allowedIps: [],
  },

  twoFactor: {
    enabled: false,
    externalOnly: false,
    issuer: "BuilderGate",
    accountName: "admin",
  },
}
```

설정 파일에 평문 비밀번호를 직접 넣으면 서버 시작 시 `enc(...)` 형식으로 자동 암호화됩니다. 암호화 키는 실행 머신의 정보에서 유도되므로 다른 머신으로 `config.json5`를 그대로 옮기면 암호화된 secret을 복호화하지 못할 수 있습니다.

주요 경로:

- `config.json5`: 포트, 인증, 2FA, PTY, CORS, 파일 매니저, 워크스페이스 설정
- `runtime/buildergate-daemon.log`: daemon 로그
- `runtime/buildergate-sentinel.log`: sentinel 로그
- `runtime/buildergate.daemon.json`: daemon state
- `runtime/totp.secret`: packaged runtime의 TOTP secret
- `data/workspaces.json`: 기본 워크스페이스 데이터 파일

## 2FA

BuilderGate는 TOTP(Time-based One-Time Password) 기반 2FA를 지원합니다. Google Authenticator, 1Password, Authy 같은 표준 인증 앱을 사용할 수 있습니다.

활성화 방법:

1. 로그인 후 Settings 화면에서 Two-Factor Authentication을 켭니다.
2. QR 코드 또는 `otpauth://` URI를 인증 앱에 등록합니다.
3. 다음 로그인부터 비밀번호 입력 후 6자리 TOTP 코드를 입력합니다.

설정 파일로 활성화할 수도 있습니다.

```json5
twoFactor: {
  enabled: true,
  externalOnly: false,
  issuer: "BuilderGate",
  accountName: "admin",
}
```

Daemon 모드에서 2FA가 활성화되어 있고 secret 등록이 필요한 경우, parent launcher가 detach 전 콘솔에 QR과 manual entry key를 1회 출력합니다. 백그라운드 app child는 같은 secret path를 사용하지만 QR을 중복 출력하지 않습니다. Foreground 모드에서는 현재 콘솔에서 서버가 직접 QR을 출력합니다.

2FA 동작:

- TOTP 입력 시도는 최대 3회입니다. 초과하면 다시 로그인해야 합니다.
- `externalOnly: true`이면 localhost 접속은 비밀번호만 요구하고 외부 접속만 2FA를 요구합니다.
- QR 미리보기와 issuer/accountName 변경은 Settings 저장 직후 갱신됩니다.
- 변경된 2FA 요구 여부는 다음 로그인부터 적용됩니다.

TOTP secret을 다시 등록해야 하면 daemon을 종료한 뒤 `runtime/totp.secret`을 삭제하고 다시 시작합니다.

```bash
./buildergate stop
rm ./runtime/totp.secret
./buildergate
```

Windows:

```bat
BuilderGate.exe stop
del runtime\totp.secret
BuilderGate.exe
```

## macOS 참고

macOS에서 인터넷에서 받은 ZIP을 풀면 Gatekeeper quarantine이 붙을 수 있습니다. 신뢰한 배포본이라면 압축 해제 폴더에서 다음 명령으로 제거할 수 있습니다.

```bash
xattr -dr com.apple.quarantine .
```

서명되지 않은 로컬 빌드 app bundle은 필요 시 ad-hoc 서명합니다.

```bash
codesign --force --deep --sign - ./BuilderGate.app
codesign --sign - ./buildergate
```

## 라이선스

이 프로젝트는 비공개 프로젝트입니다.
