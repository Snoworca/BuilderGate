# SRS: BuilderGate 네이티브 기본 데몬 모드 - Step 8

## 메타데이터

| 항목 | 값 |
| --- | --- |
| 문서 ID | SRS-BUILDERGATE-NATIVE-DAEMON-2026-04-27 |
| 프로젝트 | BuilderGate |
| 버전 | step8 |
| 작성일 | 2026-04-27 |
| 기반 PRD | `docs/archive/srs/step8.prd.buildergate-native-daemon-mode.2026-04-25.md` |
| 선행 분석 | `docs/analysis/2026-04-25.buildergate-native-daemon-mode-prd-analysis.md` |
| 이전 SRS | `docs/archive/srs/step7.srs-plan.equal-모드-무브버튼-드래그-영역-복원.2026-04-22.md` |
| 대상 코드 | `tools/start-runtime.js`, `stop.js`, `tools/build-daemon-exe.js`, `server/src/index.ts`, `server/src/services/TOTPService.ts`, `server/src/services/twoFactorRuntime.ts`, `README.md` |
| 상태 | Final (3인 전문가 평가 No findings, 7개 기준 A+) |
| 평가 라운드 | 4회 |

---

## 1. 개요

### 1.1 목적

BuilderGate의 빌드 실행파일과 source production 런처를 PM2 없는 네이티브 데몬 구조로 전환한다. 빌드된 `BuilderGate.exe` 또는 OS별 실행파일은 인자 없이 실행하면 기본적으로 백그라운드 데몬으로 동작해야 하며, 사용자가 `--foreground` 또는 호환 alias `--forground`를 지정한 경우에만 현재 콘솔에서 포그라운드로 동작해야 한다.

TOTP가 활성화된 환경에서는 데몬 모드로 실행하더라도 사용자 콘솔에 2D 바코드(QR)와 manual entry key를 먼저 출력한 뒤 백그라운드로 전환해야 한다. 이 요구사항은 PM2 로그나 백그라운드 child stdout에 의존해서는 충족된 것으로 보지 않는다.

### 1.2 범위

이번 SRS는 다음 범위를 포함한다.

| 범위 | 포함 내용 |
| --- | --- |
| 런처 실행 모드 | 기본 daemon, 명시 foreground, `--forground` alias, 기존 `-p`/`--reset-password`/`--bootstrap-allow-ip`/`--help` 보존 |
| PM2 제거 | start, stop, build, README, 배포본 문서에서 PM2 의존 및 안내 제거 |
| 네이티브 데몬 | parent launcher, app child, sentinel child, readiness 확인, 진단 로그 |
| TOTP QR preflight | detach 전 QR 출력, manual key 출력, secret path 고정, 중복 QR 억제 |
| native stop | `BuilderGateStop.exe` 기반 graceful shutdown, sentinel 중지, state/PID 검증 |
| 런타임 경로 | packaged runtime과 source production runtime의 config/server/node/state/log 경로 계약 |
| 빌드 산출물 | 단일 기본 빌드는 `dist/bin` 유지, ARM64 전체 빌드는 `dist/bin/{win-arm64,linux-arm64,macos-arm64}` 생성, macOS는 `BuilderGate.app` 포함, 실행파일 옆 `config.json5`/`config.json5.example` 유지 |
| 테스트 | CLI parser, daemon/foreground smoke, QR, stop, state/PID, sentinel, fatal startup, build output 회귀 |

이번 SRS는 다음 범위를 제외한다.

| 제외 항목 | 사유 |
| --- | --- |
| OS service/systemd/launchd 등록 | 이번 요구는 packaged executable 자체의 데몬 동작이다. |
| 개발 서버 `dev.js` 데몬화 | source production `node tools/start-runtime.js`만 대상이다. |
| TOTP 웹 등록 UI 신규 개발 | 기존 콘솔 QR 출력 보존과 preflight 안정화가 범위다. |
| PM2 fallback 또는 PM2 호환 모드 | PM2는 제거 대상이다. |
| 다중 인스턴스 관리 UI | 단일 BuilderGate 인스턴스의 시작/중지 안정화가 우선이다. |

### 1.3 현재 코드 기준

현재 BuilderGate는 다음 상태다.

| 영역 | 현재 상태 | SRS 목표 |
| --- | --- | --- |
| `tools/start-runtime.js` | PM2 설치 확인, 글로벌 설치, `pm2 start`, `pm2 status`를 수행한다. | PM2 경로를 제거하고 native daemon/foreground를 직접 수행한다. |
| `stop.js` | `pm2 jlist`, `pm2 stop`, `pm2 delete`로 종료한다. | daemon state와 internal graceful shutdown protocol로 종료한다. |
| `tools/build-daemon-exe.js` | `dist/bin`에 EXE를 만들지만 production runtime에 `pm2@latest`를 설치한다. | `dist/bin` 기본 빌드는 유지하되 PM2 설치를 제거하고, ARM64 대상별 빌드와 대상 bundled Node runtime을 지원한다. |
| `server/src/index.ts` | SIGINT/SIGTERM에서 workspace/CWD flush를 수행한다. | stop utility가 이 graceful shutdown 경로를 반드시 타도록 한다. |
| `TOTPService` | 기본 secret path는 `process.cwd()/data/totp.secret`이고 initialize 시 QR과 manual key를 출력한다. | preflight/app child가 같은 canonical secret path를 사용하고 daemon child QR 중복을 억제한다. |
| `server/src/utils/config.ts` | config load 실패 시 일부 오류에서 default config로 계속 실행할 수 있다. | daemon/production에서는 config parse/schema/cert/TOTP fatal 오류를 fallback 없이 실패로 처리한다. |
| `WorkspaceService` | `config.workspace.dataPath ?? './data/workspaces.json'`에 `{ version, lastUpdated, state.tabs[].lastCwd }`를 저장한다. | graceful shutdown 테스트는 이 JSON 파일의 `lastUpdated`와 `state.tabs[].lastCwd`를 완료 증거로 사용한다. |
| `README.md` | PM2 기반 source 실행과 EXE 설명이 남아 있다. | 기본 daemon, foreground, stop, QR 정책으로 갱신한다. |

### 1.4 요구사항 분류 결과

| 분류 | 결과 |
| --- | --- |
| 기존 기능과 모순 | 없음. PM2 경로는 명시적 제거 대상이며, 기존 config/build output 계약은 유지 대상이다. |
| 큰 구멍 | 없음. PRD가 QR, stop, state, source runtime, build output, 테스트 계약을 충분히 정의한다. |
| 자동 보완 | 문서 수준에서 startup/stop timeout, state schema, negative test, 로그 정책을 SRS 형식으로 구체화한다. |

---

## 2. 용어와 런타임 모델

### 2.1 용어

| 용어 | 정의 |
| --- | --- |
| daemon mode | launcher parent가 app child와 sentinel child를 detached로 시작하고 readiness 확인 후 종료하는 기본 실행 모드 |
| foreground mode | app server를 현재 콘솔 lifecycle에 연결해 실행하는 명시 실행 모드 |
| launcher parent | CLI 파싱, 경로 결정, QR preflight, child spawn, readiness 확인을 담당하는 `BuilderGate.exe` 또는 `tools/start-runtime.js` 프로세스 |
| app child | `server/dist/index.js`를 production 환경으로 실행하는 실제 BuilderGate 서버 프로세스 |
| sentinel child | daemon mode에서 app child를 감시하고 제한된 정책으로 재시작하는 watchdog 프로세스 |
| stop utility | `BuilderGateStop.exe` 또는 source stop entry가 native daemon을 graceful shutdown하는 실행파일 |
| daemon state | app/sentinel PID, 실행 경로, shutdown token, heartbeat, restart 상태를 담은 JSON 상태 파일 |
| QR preflight | daemon detach 전에 parent가 TOTP secret을 생성/로드하고 콘솔 QR/manual key를 출력하는 단계 |

### 2.2 Packaged Runtime Path Contract

packaged runtime은 `pkg`로 빌드된 실행파일 또는 OS별 동등 실행파일 기준이다.

| 이름 | 값 | 요구사항 |
| --- | --- | --- |
| `BIN_DIR` | `path.dirname(process.execPath)` | 실행파일이 있는 디렉터리다. |
| `SERVER_DIR` | `<BIN_DIR>/server` | app child의 cwd다. |
| `SERVER_ENTRY` | `<SERVER_DIR>/dist/index.js` | app child의 서버 엔트리다. |
| `NODE_BIN` | `<SERVER_DIR>/node_modules/.bin/node(.exe)` | app child 실행에 사용하는 bundled Node runtime이다. |
| `CONFIG_PATH` | `<BIN_DIR>/config.json5` | preflight, app child, settings 저장이 공유하는 설정 파일이다. |
| `TOTP_SECRET_PATH` | `<SERVER_DIR>/data/totp.secret` | preflight와 app child가 공유하는 canonical TOTP secret 파일이다. |
| `STATE_PATH` | `<BIN_DIR>/runtime/buildergate.daemon.json` | native daemon state 파일이다. |
| `LOG_PATH` | `<BIN_DIR>/runtime/buildergate-daemon.log` | app/sentinel 진단 로그 파일이다. |
| `SENTINEL_ENTRY` | `<BIN_DIR>/tools/daemon/sentinel-entry.js` | packaged sentinel child가 bundled Node로 실행하는 물리 엔트리 파일이다. |

`NODE_BIN`, `SERVER_ENTRY`, `CONFIG_PATH`가 누락되면 launcher는 daemon child를 남기지 않고 startup failure로 종료해야 한다.

### 2.3 Source Production Runtime Path Contract

source production runtime은 `node tools/start-runtime.js` 또는 `start.bat`/`start.sh`가 호출하는 런처 기준이다. `dev.js` 개발 실행에는 적용하지 않는다.

| 이름 | 값 | 요구사항 |
| --- | --- | --- |
| `SOURCE_ROOT` | `BUILDERGATE_ROOT` env가 있으면 그 값, 없으면 repository root | source runtime root다. |
| `BIN_DIR` | `<SOURCE_ROOT>` | source daemon state/log root의 기준이다. |
| `SERVER_DIR` | `<SOURCE_ROOT>/server` | app child의 cwd다. |
| `SERVER_ENTRY` | `<SERVER_DIR>/dist/index.js` | app child의 서버 엔트리다. |
| `NODE_BIN` | `process.execPath` | 현재 Node 실행파일이다. |
| `CONFIG_PATH` | `BUILDERGATE_CONFIG_PATH` env가 있으면 그 값, 없으면 `<SERVER_DIR>/config.json5` | source production 설정 파일이다. |
| `TOTP_SECRET_PATH` | `<SERVER_DIR>/data/totp.secret` | preflight와 app child가 공유하는 canonical TOTP secret 파일이다. |
| `STATE_PATH` | `<BIN_DIR>/runtime/buildergate.daemon.json` | source daemon state 파일이다. |
| `LOG_PATH` | `<BIN_DIR>/runtime/buildergate-daemon.log` | source daemon 진단 로그 파일이다. |

### 2.4 프로세스 구조

| 프로세스 | 실행 조건 | 책임 |
| --- | --- | --- |
| launcher parent | daemon/foreground 공통 진입점 | CLI 파싱, runtime path 결정, config port 해석, reset password, bootstrap allowlist env 구성 |
| app child | daemon 또는 foreground | HTTPS/HTTP redirect/WebSocket/static assets, 인증, 세션, workspace/CWD flush 제공 |
| sentinel child | daemon 전용 | app PID 감시, bounded restart, heartbeat/state 갱신, fatal state 기록 |
| stop utility | 사용자가 중지 명령 실행 시 | daemon state 검증, sentinel 종료, internal shutdown 호출, stop 결과와 exit code 반환 |

---

## 3. 기능 요구사항

### FR-8-001: 기본 네이티브 데몬 모드

- 설명: 빌드 실행파일과 source production 런처는 인자 없이 실행될 때 PM2 없이 daemon mode로 동작해야 한다.
- 입력: `BuilderGate.exe`, `buildergate`, `node tools/start-runtime.js`, `start.bat`, `start.sh` 무인자 실행 또는 기존 옵션 조합.
- 처리: launcher는 runtime path를 결정하고 config/port를 로드한 뒤 app child와 sentinel child를 detached로 시작한다. parent는 readiness 확인 후 종료한다.
- 출력: 콘솔에는 daemon start 결과, HTTPS URL, config path, stop 명령이 출력된다. parent exit code는 성공 시 0이다.
- 예외: 필수 파일 누락, port invalid, config parse 실패, QR preflight 실패, readiness timeout은 startup failure로 0이 아닌 exit code를 반환한다.
- 우선순위: Must.

상세 요구사항:

- `--daemon`은 기본 실행법에 필요하지 않다.
- PM2 설치, PM2 조회, PM2 start/status/delete를 호출하지 않는다.
- parent 종료 후에도 app child는 `/health`를 제공해야 한다.
- source production runtime도 packaged runtime과 동일하게 기본 daemon mode다.
- `dev.js` 개발 실행은 이 요구사항 대상이 아니다.
- daemon start 전 launcher는 `STATE_PATH`를 먼저 읽고 기존 state를 검증해야 한다.
- 검증 가능한 active daemon이 있고 `configPath`, `serverEntryPath`, `port`, `argvHash`가 현재 요청과 같으면 새 child를 띄우지 않고 idempotent success로 처리한다. 이때 현재 실행 중인 app PID와 HTTPS URL을 출력하고 0 exit code로 종료한다.
- 검증 가능한 active daemon이 있으나 현재 요청과 `configPath`, `serverEntryPath`, `port`, `argvHash` 중 하나라도 다르면 자동 stop-and-replace를 수행하지 않는다. launcher는 기존 daemon 정보와 `BuilderGateStop` 실행 안내를 출력하고 0이 아닌 exit code로 종료한다.
- state가 존재하지만 PID 검증에 실패하거나 heartbeat가 stale이고 해당 PID가 BuilderGate runtime과 일치하지 않으면 stale state로 표시하거나 정리한 뒤 새 start를 진행할 수 있다. 단, 무관 프로세스는 종료하지 않는다.
- target port에 이미 `/health`가 응답하더라도 현재 `STATE_PATH`의 active daemon과 새 `startAttemptId`/`appPid`가 일치하지 않으면 start 성공으로 판정하면 안 된다.
- `--replace` 또는 자동 교체 옵션은 이번 SRS 범위 밖이다. 기존 daemon 교체는 사용자가 stop을 먼저 실행하는 절차로만 허용한다.

### FR-8-002: 명시적 포그라운드 모드

- 설명: 사용자가 `--foreground` 또는 `--forground`를 전달하면 현재 콘솔에서 서버를 실행해야 한다.
- 입력: `BuilderGate.exe --foreground`, `BuilderGate.exe --forground`, `node tools/start-runtime.js --foreground`, `node tools/start-runtime.js --forground`.
- 처리: launcher는 sentinel을 시작하지 않고 app server를 현재 콘솔 lifecycle에 연결한다.
- 출력: app stdout/stderr, TOTP QR, server banner, 종료 로그가 현재 콘솔에 그대로 출력된다.
- 예외: app startup failure는 현재 프로세스 exit code와 stderr/stdout으로 관측 가능해야 한다.
- 우선순위: Must.

상세 요구사항:

- `--foreground`는 canonical flag다.
- `--forground`는 사용자 원문 호환 alias로 허용한다.
- foreground mode는 daemon state를 active daemon으로 기록하지 않는다.
- foreground process는 `BuilderGateStop.exe`의 종료 대상이 아니다.
- foreground 종료는 Ctrl+C, SIGINT, SIGTERM, 부모 콘솔 lifecycle로 수행한다.

### FR-8-003: 기존 CLI 옵션 보존

- 설명: 기존 runtime CLI 옵션은 daemon/foreground 양쪽에서 동일하게 동작해야 한다.
- 입력: `-p <port>`, `--port <port>`, `--reset-password`, `--bootstrap-allow-ip <ip[,ip]>`, `--help`.
- 처리: launcher는 기존 우선순위와 검증 규칙을 유지한다.
- 출력: 유효 옵션은 실행 결과에 반영되고, invalid 옵션은 명확한 오류와 0이 아닌 exit code를 반환한다.
- 예외: port는 1024-65535 범위를 벗어나면 거부한다. `--bootstrap-allow-ip` 값 누락은 오류다.
- 우선순위: Must.

상세 요구사항:

- port 우선순위는 CLI, config, 기본값 순이다.
- `--reset-password`는 child 시작 전에 `CONFIG_PATH`의 `auth.password`를 빈 문자열로 수정한다.
- `--bootstrap-allow-ip`는 해당 실행의 `BUILDERGATE_BOOTSTRAP_ALLOWED_IPS` env로만 전달하고 config에 저장하지 않는다.
- `--help`는 기본 daemon, `--foreground`, `--forground`, stop 명령, `dist/bin`/config path 정책을 안내한다.

### FR-8-004: 데몬 모드 TOTP QR preflight

- 설명: TOTP가 활성화된 경우 daemon detach 전에 QR과 manual entry key를 현재 콘솔에 출력해야 한다.
- 입력: `CONFIG_PATH`의 `twoFactor.enabled === true`.
- 처리: launcher parent가 app child와 같은 config, CryptoService 정책, `TOTP_SECRET_PATH`로 TOTP secret을 생성/로드하고 QR/manual key를 출력한다.
- 출력: parent 종료 전 콘솔에 QR, manual entry key, issuer, accountName이 표시된다.
- 예외: secret 생성/로드/복호화/QR 출력 실패는 startup failure다. 실패를 무시하거나 daemon만 계속 띄우면 안 된다.
- 우선순위: Must.

상세 요구사항:

- QR 출력 조건은 현재 코드 계약인 `config.twoFactor.enabled === true`다.
- legacy 중첩 schema인 `twoFactor.totp.enabled`를 새 조건으로 도입하지 않는다.
- manual entry key는 QR 대체물이 아니라 보조 출력이다.
- secret이 이미 존재해도 기존 정책과 동일하게 등록 확인용 QR과 manual key를 출력한다.
- preflight와 app child는 `BUILDERGATE_TOTP_SECRET_PATH=<TOTP_SECRET_PATH>`를 공유한다.
- daemon app child에는 `BUILDERGATE_SUPPRESS_TOTP_QR=1` 또는 동등한 명시 env를 전달해 QR 중복 출력을 막는다.
- foreground mode에서는 QR을 suppress하지 않는다.
- daemon/foreground initial startup 중 TOTP secret corruption, decrypt failure, BASE32 validation failure, QR generation failure는 fatal startup failure다.
- Settings 화면에서 실행 중 `twoFactor.*` 변경으로 TOTP runtime을 재구성하다 실패한 경우에만 기존 runtime 유지와 warning 반환을 허용한다. initial startup 실패와 settings hot-swap 실패는 같은 정책으로 처리하면 안 된다.

### FR-8-005: TOTP runtime 중복 억제와 secret path 고정

- 설명: QR preflight와 app child 초기화가 서로 다른 secret 파일을 만들거나 QR을 중복 출력하면 안 된다.
- 입력: daemon mode, TOTP enabled, 기존 secret 유무.
- 처리: TOTPService 또는 twoFactorRuntime은 명시 secret path와 QR suppress 옵션을 수용해야 한다.
- 출력: daemon 실행 1회당 사용자 콘솔 QR 출력은 parent preflight 1회로 제한된다.
- 예외: app child가 `BUILDERGATE_SUPPRESS_TOTP_QR=1`인데도 QR을 출력하면 실패다.
- 우선순위: Must.

상세 요구사항:

- `TOTP_SECRET_PATH`는 packaged/source production 모두 `<SERVER_DIR>/data/totp.secret`로 고정한다.
- app child cwd는 `<SERVER_DIR>`로 고정해 기존 static asset, data, relative path 계약을 보존한다.
- `server/src/index.ts`의 TOTP 초기화는 `BUILDERGATE_TOTP_SECRET_PATH`를 우선 사용해야 한다.
- `TOTPService.initialize()`의 corrupt secret failure는 fatal startup으로 취급되어야 한다.
- `applyTwoFactorRuntime()` 또는 동등한 TOTP 초기화 경계는 `BUILDERGATE_TOTP_SECRET_PATH`와 `BUILDERGATE_SUPPRESS_TOTP_QR`를 읽어 `TOTPService`에 명시적으로 전달해야 한다.
- `TOTPService`는 `suppressConsoleQr` 같은 명시 옵션을 제공해야 하며, suppress 상태에서도 secret 생성/로드와 QR data URL API 동작은 유지해야 한다.
- `reconcileTotpRuntime()`은 initial startup 호출과 settings hot-swap 호출을 구분할 수 있어야 한다. initial startup에서는 TOTP init failure를 throw/fatal로 전달하고, settings hot-swap에서는 기존 서비스 유지/경고 정책을 유지한다.

### FR-8-006: PM2 제거

- 설명: BuilderGate production 실행과 중지, 빌드 산출물은 PM2에 의존하지 않아야 한다.
- 입력: source production 실행, packaged 실행, stop 실행, `npm run build`, `npm run build:daemon-exe`.
- 처리: PM2 관련 설치/조회/시작/삭제 코드와 문서 안내를 native daemon 로직으로 대체한다.
- 출력: 배포본 `dist/bin`에는 PM2 dependency가 포함되지 않는다.
- 예외: PM2가 로컬/글로벌에 존재하더라도 BuilderGate 런처는 이를 사용하지 않는다.
- 우선순위: Must.

상세 요구사항:

- `tools/start-runtime.js`는 `pm2 -v`, `npm install -g pm2`, `pm2 jlist`, `pm2 start`, `pm2 status`, `pm2 delete`를 호출하지 않는다.
- `stop.js`는 `pm2 jlist`, `pm2 stop`, `pm2 delete`를 호출하지 않는다.
- `tools/build-daemon-exe.js`는 runtime production dependency에 `pm2@latest`를 설치하지 않는다.
- README와 배포본 README는 PM2 기반 실행법을 제거한다.
- legacy `projectmaster` PM2 앱 정리는 새 native stop 범위에 포함하지 않는다. PM2 제거 이후 남은 legacy PM2 정리는 별도 운영 안내로만 둘 수 있다.

### FR-8-007: native daemon state

- 설명: daemon mode는 stop, stale PID 방지, sentinel 감시를 위해 검증 가능한 JSON state를 유지해야 한다.
- 입력: daemon start, app restart, heartbeat, stop.
- 처리: launcher/sentinel/stop utility가 `STATE_PATH`를 원자적으로 읽고 쓴다.
- 출력: state 파일에는 현재 daemon의 app/sentinel/경로/token/heartbeat/restart 정보가 기록된다.
- 예외: state write 실패는 startup failure다. state parse 실패는 stop에서 명확한 오류로 보고하고 임의 PID를 종료하지 않는다.
- 우선순위: Must.

state schema는 상태별 union으로 해석한다. 공통 필드는 모든 상태에서 필수이며, PID/heartbeat 필드는 app 또는 sentinel을 실제로 생성한 상태에서만 필수다.

공통 필드:

| 필드 | 타입 | 요구사항 |
| --- | --- | --- |
| `version` | string | schema version. 초기값은 `1`. |
| `mode` | string | active daemon은 `daemon`. |
| `status` | string | `starting`, `running`, `stopping`, `stopped`, `fatal` 중 하나. |
| `launcherPath` | string | 실행파일 또는 launcher script 절대 경로. |
| `serverEntryPath` | string | `SERVER_ENTRY` 절대 경로. |
| `serverCwd` | string | `SERVER_DIR` 절대 경로. |
| `nodeBinPath` | string | app child 실행 Node 절대 경로. |
| `configPath` | string | 사용 중인 `CONFIG_PATH`. |
| `totpSecretPath` | string | 사용 중인 `TOTP_SECRET_PATH`. |
| `port` | number or null | HTTPS port. active state와 port 해석 이후 fatal에서는 number다. config parse/schema failure처럼 port 해석 전 `fatalStage=preflight`인 경우에만 null 허용. |
| `startedAt` | string | ISO timestamp. |
| `argvHash` | string | mode와 주요 옵션 hash. |
| `shutdownToken` | string | internal shutdown protocol token. |
| `startAttemptId` | string | launcher가 이번 start 시도에 생성한 난수 ID. readiness identity와 state generation 검증에 사용한다. |
| `stateGeneration` | number | start/restart마다 증가하는 state generation. 기존 `/health` false-positive 방지에 사용한다. |
| `restartCount` | number | sentinel restart count. |
| `lastRestartAt` | string or null | 마지막 재시작 timestamp. |
| `lastExitCode` | number or string or null | 마지막 app exit code 또는 signal. |
| `fatalReason` | string or null | fatal 상태 원인. |
| `fatalStage` | string or null | `preflight`, `app-startup`, `sentinel-runtime`, `shutdown`, `unknown` 중 하나. |

active state 필드:

| 필드 | 적용 상태 | 타입 | 요구사항 |
| --- | --- | --- | --- |
| `appPid` | `starting`, `running`, `stopping` | number | app child PID. app spawn 전 `starting`에서는 null 허용. |
| `sentinelPid` | `starting`, `running`, `stopping` | number | sentinel child PID. sentinel spawn 전 `starting`에서는 null 허용. |
| `appProcessStartedAt` | `running`, `stopping` | string | OS process creation time 또는 start tick. |
| `heartbeatAt` | `running`, `stopping` | string | sentinel/app heartbeat timestamp. |

fatal state 필드 규칙:

- `status=fatal`이고 `fatalStage=preflight`이면 `appPid`, `sentinelPid`, `appProcessStartedAt`, `heartbeatAt`은 null 또는 생략할 수 있다.
- `status=fatal`이고 `fatalStage=preflight`이며 config parse/schema failure가 port 해석 전에 발생하면 `port`는 null이어야 한다. 이 경우 default port를 임의로 기록하면 안 된다.
- `status=fatal`이고 `fatalStage=app-startup`이면 `appPid`는 존재할 수 있으나 `appProcessStartedAt`과 `heartbeatAt`은 null 또는 생략할 수 있다.
- `status=fatal`이고 `fatalStage=sentinel-runtime`이면 마지막으로 관측한 `appPid`, `sentinelPid`, `lastExitCode`, `lastRestartAt`, `heartbeatAt`을 가능한 범위에서 기록한다.
- stop utility는 `status=fatal` state를 active daemon으로 간주해 kill을 시도하지 않는다. 단, 실제 PID가 남아 있고 PID 검증이 통과하는 경우에만 cleanup 안내 또는 별도 cleanup 경로를 제공할 수 있다.

### FR-8-008: PID와 프로세스 검증

- 설명: stop utility와 launcher는 stale PID 또는 PID 재사용으로 무관한 프로세스를 종료하면 안 된다.
- 입력: `STATE_PATH`, OS process query 결과, stop 요청.
- 처리: 종료 전 PID, executable/command line, cwd/server entry, process start time 또는 start tick을 검증한다.
- 출력: 검증 성공 시에만 sentinel/app 종료를 진행한다.
- 예외: 검증 실패 시 kill을 수행하지 않고 사용자에게 수동 확인 가능한 오류를 출력한다.
- 우선순위: Must.

상세 요구사항:

- state의 `appPid`와 실제 프로세스 command line은 `SERVER_ENTRY` 또는 BuilderGate runtime 경로와 일치해야 한다.
- state의 `sentinelPid`와 실제 프로세스 command line은 sentinel 실행 경로 또는 sentinel mode 인자와 일치해야 한다.
- process creation time/start tick 검증이 불가능한 OS에서는 executable/command/cwd 검증과 heartbeat freshness를 모두 통과해야 한다.
- heartbeat는 기본 10초 주기로 갱신해야 하며, stop에서는 stale heartbeat를 경고하되 PID 검증 없이 kill fallback으로 넘어가면 안 된다.

### FR-8-009: native stop utility

- 설명: `BuilderGateStop.exe`는 PM2 없이 native daemon을 graceful하게 종료해야 한다.
- 입력: `BuilderGateStop.exe`, `buildergate-stop`, source stop entry.
- 처리: stop utility는 state를 읽고 sentinel을 먼저 중지한 뒤 app child에 localhost-only internal shutdown 요청을 보낸다.
- 출력: 성공 시 0 exit code, app/sentinel 종료, `/health` 비응답, state `stopped` 또는 state 정리.
- 예외: state 없음은 “실행 중인 daemon 없음”으로 0 exit code를 반환할 수 있다. 검증 실패, shutdown timeout, kill fallback은 명확한 경고와 0이 아닌 exit code를 반환한다.
- 우선순위: Must.

상세 요구사항:

- sentinel을 먼저 종료해 app 자동 재시작을 막는다.
- app 종료는 OS signal만으로 정의하지 않고 internal graceful shutdown protocol을 우선 사용한다.
- graceful timeout은 10초다.
- timeout 이후 kill fallback이 실행되면 stop은 graceful failure로 표시한다.
- stop 완료 판정에는 `/health` 비응답과 workspace/CWD flush 완료가 포함되어야 한다.
- foreground process는 stop utility 대상이 아니다.
- workspace/CWD flush 완료 증거는 `<SERVER_DIR>/data/workspaces.json` 또는 `config.workspace.dataPath`가 지정한 파일의 JSON `lastUpdated`가 shutdown 시작 이후로 갱신되고, 대상 tab의 `state.tabs[].lastCwd`가 shutdown 직전 fixture CWD와 일치하는 것이다.
- 테스트 fixture는 active tab/session의 CWD tracking temp file `os.tmpdir()/buildergate-cwd-<sessionId>.txt` 또는 실제 shell `cd`를 통해 shutdown 직전 CWD를 변경한 뒤 stop을 실행해야 한다.
- stop 성공 로그에는 workspace data file path와 flush 완료 marker `[Shutdown] Workspace state + CWDs saved` 또는 동등한 structured result가 포함되어야 한다.

### FR-8-010: localhost-only graceful shutdown protocol

- 설명: stop utility는 서버의 기존 graceful shutdown 경로를 타도록 내부 shutdown endpoint 또는 동등한 IPC를 사용해야 한다.
- 입력: shutdown token, loopback 요청, HTTPS port.
- 처리: 서버는 loopback remote address와 token을 모두 검증한 뒤 `setupGracefulShutdown()`과 동등한 workspace/CWD flush 절차를 실행한다.
- 출력: flush 완료 후 shutdown accepted/success 응답 또는 연결 종료가 관측된다.
- 예외: missing token, invalid token, non-loopback remote address, spoofed forwarding header는 모두 거부한다.
- 우선순위: Must.

권장 HTTP 인터페이스:

| 항목 | 값 |
| --- | --- |
| Method | `POST` |
| URL | `https://127.0.0.1:<port>/api/internal/shutdown` |
| Auth | daemon state의 `shutdownToken` |
| Remote restriction | TCP remote address가 loopback이어야 한다. |
| Forwarding header | `X-Forwarded-For`, `Forwarded`, `X-Real-IP`를 loopback 판단에 사용하지 않는다. |

상세 요구사항:

- 서버는 signal handler와 internal shutdown route가 공통으로 호출하는 `performGracefulShutdown(reason)` 또는 동등한 재사용 함수를 제공해야 한다.
- `performGracefulShutdown()`은 `sessionManager.stopAllCwdWatching()`, `workspaceService.snapshotAllCwds()`, `workspaceService.forceFlush()`, timer cleanup을 순서대로 수행하고 `{ workspaceDataPath, lastUpdated, flushedTabCount }` 또는 동등한 structured result를 반환해야 한다.
- internal shutdown route는 flush 완료 후 success response를 보낸 다음 process exit를 예약해야 한다. flush 전에 `202 Accepted`만 반환하고 실제 완료 판정을 stop utility에 숨기면 안 된다.
- stop utility는 shutdown response의 flush result와 `/health` 비응답을 모두 확인해야 graceful success로 판정한다.

### FR-8-011: sentinel watchdog

- 설명: daemon mode는 PM2의 프로세스 감시를 대체하는 sentinel child를 제공해야 한다.
- 입력: app child PID, app exit event, health/heartbeat 상태.
- 처리: sentinel은 app이 비정상 종료되면 제한된 backoff 정책으로 재시작하고 state를 갱신한다.
- 출력: `restartCount`, `lastRestartAt`, `lastExitCode`, `heartbeatAt`이 state에 기록된다.
- 예외: fatal startup failure는 재시작 루프를 시작하지 않고 `status=fatal`로 기록한다.
- 우선순위: Must.

상세 요구사항:

- backoff 정책은 `initialBackoff=1s`, `maxBackoff=30s`, `maxRestarts=5 within 10min`이다.
- config/schema/certificate/TOTP secret corruption은 fatal startup failure다.
- fatal 상태에서는 sentinel이 무한 재시작하지 않는다.
- sentinel 로그는 `LOG_PATH` 또는 sentinel 전용 로그에 남아야 한다.
- 정상 stop 중에는 sentinel이 app을 재시작하지 않는다.
- packaged runtime의 sentinel은 `<BIN_DIR>/server/node_modules/.bin/node(.exe)`로 `<BIN_DIR>/tools/daemon/sentinel-entry.js`를 실행한다. `pkg` self-reexec에서 발생할 수 있는 argument/bootstrap 해석 차이를 피하기 위한 명시적 물리 엔트리 계약이다.
- source production runtime의 sentinel은 `process.execPath tools/start-runtime.js --internal-sentinel` 또는 동등한 Node 실행으로 시작한다.
- sentinel 실행 시 env에는 `BUILDERGATE_DAEMON_STATE_PATH`, `BUILDERGATE_DAEMON_START_ID`, `BUILDERGATE_RUNTIME_ROOT`, `BUILDERGATE_CONFIG_PATH`가 포함되어야 한다.
- sentinel command line 또는 env 검증 문자열은 PID 검증에서 사용할 수 있을 만큼 안정적이어야 한다. stop utility는 source의 `--internal-sentinel`, packaged의 `tools/daemon/sentinel-entry.js`, 또는 `BUILDERGATE_INTERNAL_MODE=sentinel`가 없는 무관 프로세스를 sentinel로 간주하면 안 된다.
- stop utility는 state를 `stopping`으로 원자 갱신한 뒤 sentinel 종료를 요청한다. sentinel은 `status=stopping`을 감지하면 app을 재시작하지 않고 종료해야 한다.
- build script는 packaged sentinel entry와 그 runtime dependency 파일이 `dist/bin/tools/daemon` 또는 ARM64 대상별 `dist/bin/<target>/tools/daemon`에 포함되어 있음을 검증하고, source mode에는 별도 누락 파일이 없음을 검증해야 한다.

### FR-8-012: readiness 확인

- 설명: daemon parent는 child를 시작했다는 사실만으로 성공 처리하면 안 되며, 서버 readiness를 확인해야 한다.
- 입력: daemon start, resolved HTTPS port.
- 처리: launcher는 `/health` polling 또는 동등한 ready signal을 확인한다.
- 출력: readiness 성공 후 parent는 0 exit code로 종료한다.
- 예외: readiness timeout은 startup failure로 처리하고 가능한 child/sentinel을 정리한다.
- 우선순위: Must.

상세 요구사항:

- 기본 readiness timeout은 30초다.
- `/health` 확인은 자체 서명 인증서를 허용해야 한다.
- 실패 로그에는 port, config path, server entry, log path가 포함되어야 한다.
- launcher는 start 시마다 `startAttemptId`를 생성하고 app child env와 daemon state에 기록해야 한다.
- readiness 성공 조건은 다음 중 하나를 만족해야 한다.
- 조건 A: app child가 parent/sentinel에 IPC ready message를 보내고, message의 `pid`, `startAttemptId`, `serverEntryPath`, `configPath`, `port`가 현재 state와 일치한다.
- 조건 B: loopback `/health` 응답 body 또는 response header에 `pid`, `startAttemptId` 또는 `stateGeneration`이 포함되고, 이 값이 새로 spawn한 `appPid`와 현재 state와 일치한다.
- 단순히 target port의 `/health`가 200을 반환하는 것은 readiness 성공 조건이 아니다.
- readiness 확인이 실패하면 launcher는 방금 시작한 app/sentinel만 정리해야 하며, 기존에 무관하게 떠 있던 프로세스는 종료하지 않는다.

### FR-8-013: 빌드 산출물과 배포 구조

- 설명: build script는 단일 기본 산출물을 `dist/bin`에 생성하고, ARM64 대상별 산출물은 `dist/bin/<target>`에 생성하며 실행파일 옆 config 정책을 유지해야 한다.
- 입력: `npm run build`, `npm run build:daemon-exe`, `npm run build:daemon-win-arm64`, `npm run build:daemon-linux-arm64`, `npm run build:daemon-mac-arm64`, `node tools/build-daemon-exe.js`.
- 처리: frontend/server build, public asset staging, runtime file copy, 대상 OS/CPU용 bundled Node 준비, launcher/stop executable build, 실행파일 아이콘 자산 staging을 수행한다.
- 출력: 단일 기본 빌드는 `dist/bin/BuilderGate.exe`, `dist/bin/BuilderGateStop.exe`, `dist/bin/server`, `dist/bin/config.json5`, `dist/bin/config.json5.example`, `dist/bin/README.md`를 생성한다. ARM64 전체 빌드는 `dist/bin/win-arm64`, `dist/bin/linux-arm64`, `dist/bin/macos-arm64`에 동일한 배포 구조를 생성하고, macOS ARM64에는 `BuilderGate.app`을 추가 생성한다.
- 예외: frontend/server build artifact, bundled Node, `SERVER_ENTRY` 누락은 build failure다.
- 우선순위: Must.

상세 요구사항:

- 기본 output은 `dist/bin`이다.
- `npm run build`는 Windows ARM64, Linux ARM64, macOS ARM64 배포본을 모두 생성한다.
- ARM64 대상별 script는 `build:daemon-win-arm64`, `build:daemon-linux-arm64`, `build:daemon-mac-arm64` 또는 `build:daemon-macos-arm64`를 제공한다.
- ARM64 대상별 output은 `dist/bin/win-arm64`, `dist/bin/linux-arm64`, `dist/bin/macos-arm64`이다.
- macOS ARM64 output은 터미널용 raw `buildergate`/`buildergate-stop`과 Finder용 `BuilderGate.app`을 함께 제공한다.
- `BuilderGate.app`은 `Contents/Info.plist`, `Contents/MacOS/BuilderGate`, `Contents/Resources/BuilderGate.icns`, `Contents/Resources/runtime` 구조를 가져야 한다.
- Finder에서 `BuilderGate.app`을 실행한 경우 QR 출력이 보이도록 Terminal을 열어 내부 runtime `buildergate`를 실행해야 한다.
- `dist/daemon`은 새 기본 경로로 사용하지 않는다.
- `BuilderGate.exe`만 단독 배포하는 사용법을 허용하지 않는다. `dist/bin` 폴더 전체 배포가 원칙이다.
- `server/node_modules/.bin/node(.exe)`는 app child 실행을 위해 포함한다.
- PM2는 runtime dependency에 포함하지 않는다.
- 브라우저 탭 아이콘(`frontend/public/logo.svg`)은 배포본에 `BuilderGate.svg`로 포함하고, Windows 배포본은 동일한 아이콘에서 생성한 `BuilderGate.ico`를 `BuilderGate.exe`와 `BuilderGateStop.exe`에 임베딩한다. macOS 배포본은 동일한 아이콘에서 생성한 `BuilderGate.icns`를 `BuilderGate.app`에 적용한다.

### FR-8-014: 설정 파일 위치 보존

- 설명: 실행 설정 파일은 실행파일과 같은 위치 또는 source production 규칙의 `CONFIG_PATH`를 사용해야 한다.
- 입력: packaged runtime, source production runtime, `BUILDERGATE_CONFIG_PATH`.
- 처리: launcher는 결정된 `CONFIG_PATH`를 app child env에 명시적으로 전달한다.
- 출력: preflight, app child, settings 저장은 같은 config 파일을 사용한다.
- 예외: packaged runtime에서 EXE 옆 config가 없으면 기존 서버 config 생성 정책을 따르되, 생성 위치는 EXE 옆이어야 한다.
- 우선순위: Must.

상세 요구사항:

- packaged runtime 기본값은 `<BIN_DIR>/config.json5`다.
- source production 기본값은 `<SERVER_DIR>/config.json5`이며, `BUILDERGATE_CONFIG_PATH`가 있으면 이를 우선한다.
- `config.json5.example`은 `dist/bin/config.json5.example`에 제공한다.

### FR-8-017: production fatal configuration policy

- 설명: daemon/foreground production 실행은 의미 있는 설정 오류를 default fallback으로 숨기지 않아야 한다.
- 입력: `NODE_ENV=production`인 packaged runtime 또는 source production runtime.
- 처리: config loader와 launcher는 production strict mode로 동작해 parse/schema/certificate/TOTP 초기화 오류를 startup failure 또는 fatal state로 전달한다.
- 출력: parent 또는 foreground process는 0이 아닌 exit code와 원인 로그를 반환한다. daemon start 중이면 state에 `status=fatal`과 `fatalReason`을 기록한다.
- 예외: config 파일이 아예 없는 최초 실행은 기존 정책처럼 built-in bootstrap template 생성이 허용된다. 단, 이미 존재하는 config의 JSON5 parse 실패, schema validation 실패, 읽기 권한 실패, certificate load/generate 실패는 default config fallback을 허용하지 않는다.
- 우선순위: Must.

상세 요구사항:

- `server/src/utils/config.ts`의 “load 실패 시 default configuration 사용” 경로는 daemon/foreground production에서는 비활성화되어야 한다.
- `dev.js` 개발 실행은 기존 개발 편의 fallback을 유지할 수 있다.
- source production `node tools/start-runtime.js`는 packaged runtime과 동일한 strict config policy를 적용한다.
- launcher preflight에서 감지된 config fatal과 app child startup 중 감지된 config fatal은 동일하게 fatal state로 귀결된다.
- config fatal은 sentinel restart 대상이 아니다.

### FR-8-015: 진단 로그

- 설명: daemon child stdout/stderr는 버려지면 안 되며, 장애 분석 가능한 로그에 남아야 한다.
- 입력: app child stdout/stderr, sentinel stdout/stderr, launcher startup failure.
- 처리: daemon mode에서는 stdout/stderr를 `LOG_PATH` 또는 날짜/프로세스별 로그 파일로 redirect한다.
- 출력: 로그에는 PID, port, config path, mode, startup/shutdown/restart/fatal 원인이 남는다.
- 예외: 비밀번호, JWT, OTP code, shutdown token, TOTP secret 평문은 로그에 남기지 않는다.
- 우선순위: Must.

### FR-8-016: 문서 갱신

- 설명: README와 배포본 README는 native daemon 실행법을 안내해야 한다.
- 입력: root README, `dist/bin/README.md`.
- 처리: PM2 기반 안내를 제거하고 새 실행/중지/foreground/QR/config/build 방법을 기록한다.
- 출력: 사용자가 문서만 보고 daemon/foreground/stop/build/config 위치를 구분할 수 있다.
- 예외: `--daemon`을 기본 실행법으로 안내하면 안 된다.
- 우선순위: Must.

상세 요구사항:

- root README와 배포본 README에는 필수 키워드 `--foreground`, `--forground`, `BuilderGateStop`, `config.json5`, `QR`, `dist/bin`, `native daemon` 또는 `네이티브 데몬`이 포함되어야 한다.
- root README와 배포본 README의 production 실행 안내에는 금지 패턴 `pm2`, `PM2`, `pm2 start`, `pm2 stop`, `pm2 delete`, `npm install -g pm2`가 남아 있으면 안 된다.
- TOTP/2FA 섹션에서는 daemon mode에서도 QR과 manual entry key가 parent detach 전에 콘솔에 출력된다는 점을 명시해야 한다.
- source production 실행 문서에는 `node tools/start-runtime.js`가 기본 daemon이고 `--foreground`/`--forground`가 foreground라는 점을 명시해야 한다.

---

## 4. 비기능 요구사항

| ID | 요구사항 | 검증 |
| --- | --- | --- |
| NFR-8-001 | native daemon은 PM2 설치 여부와 무관하게 동작해야 한다. | PM2 미설치 환경 smoke test |
| NFR-8-002 | daemon startup failure는 0이 아닌 exit code, 원인 로그, log path 안내로 추적 가능해야 한다. | missing `SERVER_ENTRY`, invalid config 테스트 |
| NFR-8-003 | daemon parent readiness timeout은 기본 30초이며 성공 전 parent가 성공 종료하면 안 된다. | readiness timeout 테스트 |
| NFR-8-004 | stop graceful timeout은 10초이며 timeout 후 결과를 graceful failure로 보고해야 한다. | shutdown hang 테스트 |
| NFR-8-005 | sentinel restart는 10분 내 5회로 제한하고 backoff는 1초에서 최대 30초까지 증가한다. | sentinel restart 테스트 |
| NFR-8-006 | shutdown protocol은 token과 loopback을 모두 검증하고 forwarding header를 신뢰하지 않는다. | negative security 테스트 |
| NFR-8-007 | TOTP secret, JWT, password, shutdown token은 daemon 로그에 평문으로 남기지 않는다. | 로그 grep 테스트 |
| NFR-8-008 | 기존 UI, 인증 API, WebSocket/SSE payload, session status 계약은 변경하지 않는다. | 기존 회귀 테스트 |
| NFR-8-009 | `dist/bin` 구조와 EXE 옆 config 정책은 기존 배포 자동화와 호환되어야 한다. | build output 테스트 |
| NFR-8-010 | source production과 packaged runtime은 실행 모드 정책이 동일해야 한다. | source/package smoke 테스트 |
| NFR-8-011 | daemon state write는 partial/corrupt write를 피하기 위해 temp file + atomic rename 또는 동등한 안전 쓰기를 사용해야 한다. | state corruption 테스트 |
| NFR-8-012 | stop은 state 검증 실패 시 임의 PID를 종료하지 않아야 한다. | stale PID/PID reuse negative 테스트 |

---

## 5. 데이터 요구사항

### DR-8-001: daemon state schema

고정 위치는 `<BIN_DIR>/runtime/buildergate.daemon.json`이다.

```json
{
  "version": "1",
  "mode": "daemon",
  "status": "running",
  "appPid": 12345,
  "sentinelPid": 12346,
  "launcherPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\BuilderGate.exe",
  "serverEntryPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server\\dist\\index.js",
  "serverCwd": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server",
  "nodeBinPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server\\node_modules\\.bin\\node.exe",
  "configPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\config.json5",
  "totpSecretPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server\\data\\totp.secret",
  "port": 2002,
  "startedAt": "2026-04-27T00:00:00.000Z",
  "appProcessStartedAt": "2026-04-27T00:00:01.000Z",
  "argvHash": "sha256:...",
  "shutdownToken": "base64url-random-token",
  "startAttemptId": "base64url-random-start-id",
  "stateGeneration": 1,
  "restartCount": 0,
  "lastRestartAt": null,
  "lastExitCode": null,
  "heartbeatAt": "2026-04-27T00:00:05.000Z",
  "fatalReason": null,
  "fatalStage": null
}
```

preflight fatal 예시는 다음과 같다.

```json
{
  "version": "1",
  "mode": "daemon",
  "status": "fatal",
  "launcherPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\BuilderGate.exe",
  "serverEntryPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server\\dist\\index.js",
  "serverCwd": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server",
  "nodeBinPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server\\node_modules\\.bin\\node.exe",
  "configPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\config.json5",
  "totpSecretPath": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\dist\\bin\\server\\data\\totp.secret",
  "port": null,
  "startedAt": "2026-04-27T00:00:00.000Z",
  "argvHash": "sha256:...",
  "shutdownToken": "base64url-random-token",
  "startAttemptId": "base64url-random-start-id",
  "stateGeneration": 1,
  "restartCount": 0,
  "lastRestartAt": null,
  "lastExitCode": null,
  "fatalReason": "Configuration validation failed: ...",
  "fatalStage": "preflight"
}
```

제약:

- `shutdownToken`은 최소 32바이트 이상의 암호학적 난수에서 생성한다.
- state 파일 권한은 가능한 OS에서 owner read/write로 제한한다.
- state 파일을 로그에 그대로 출력하면 안 된다.
- token이 필요한 오류 분석은 token 값을 마스킹해야 한다.

### DR-8-002: runtime directory

`<BIN_DIR>/runtime`은 daemon state와 로그를 저장한다.

| 파일 | 용도 |
| --- | --- |
| `buildergate.daemon.json` | active/stopped/fatal daemon state |
| `buildergate-daemon.log` | app child stdout/stderr |
| `buildergate-sentinel.log` | sentinel stdout/stderr, 재시작/fatal 원인 |
| `buildergate-launcher.log` | parent startup failure 또는 readiness 진단 로그 |

로그 파일명은 구현에서 rotation을 추가할 수 있으나 기본 경로는 문서와 테스트에서 안정적으로 찾을 수 있어야 한다.

### DR-8-003: environment variables

| 변수 | daemon app child | foreground app | 설명 |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` | `production` | static assets production mode |
| `PORT` | resolved HTTPS port | resolved HTTPS port | CLI/config/default 우선순위 결과 |
| `BUILDERGATE_CONFIG_PATH` | `CONFIG_PATH` | `CONFIG_PATH` | 설정 파일 위치 고정 |
| `BUILDERGATE_BOOTSTRAP_ALLOWED_IPS` | 옵션 전달 시만 | 옵션 전달 시만 | 실행 한정 bootstrap allowlist |
| `BUILDERGATE_TOTP_SECRET_PATH` | `TOTP_SECRET_PATH` | `TOTP_SECRET_PATH` | TOTP secret 위치 고정 |
| `BUILDERGATE_SUPPRESS_TOTP_QR` | `1` if QR preflight executed | 미설정 | daemon QR 중복 출력 방지 |
| `BUILDERGATE_SHUTDOWN_TOKEN` | `shutdownToken` 또는 안전한 IPC 전달 | 미설정 | internal shutdown protocol 검증 |
| `BUILDERGATE_DAEMON_START_ID` | `startAttemptId` | 미설정 | daemon readiness identity 검증 |
| `BUILDERGATE_DAEMON_STATE_PATH` | `STATE_PATH` | 미설정 | app/sentinel state 참조 |
| `BUILDERGATE_INTERNAL_MODE` | `app` 또는 `sentinel` | 미설정 | internal child role 식별 |

`BUILDERGATE_SHUTDOWN_TOKEN`은 프로세스 목록에서 노출될 수 있는 CLI 인자로 전달하면 안 된다. env 또는 IPC 등 구현 선택은 가능하지만 로그와 command line 노출을 피해야 한다.

---

## 6. 인터페이스 요구사항

### IR-8-001: start CLI

| 명령 | 결과 |
| --- | --- |
| `BuilderGate.exe` | daemon mode로 실행 |
| `BuilderGate.exe --foreground` | foreground mode로 실행 |
| `BuilderGate.exe --forground` | foreground mode로 실행 |
| `BuilderGate.exe -p 2002` | HTTPS port 2002로 daemon 실행 |
| `BuilderGate.exe --reset-password` | config의 `auth.password`를 비우고 daemon 실행 |
| `BuilderGate.exe --bootstrap-allow-ip 127.0.0.1` | 해당 실행에 bootstrap allowlist env 전달 |
| `BuilderGate.exe --help` | 새 daemon/foreground/stop 사용법 출력 후 종료 |

source production도 `node tools/start-runtime.js` 기준으로 동일한 옵션을 제공한다.

### IR-8-002: stop CLI

| 명령 | 결과 |
| --- | --- |
| `BuilderGateStop.exe` | packaged daemon stop |
| `buildergate-stop` | non-Windows packaged daemon stop |
| `node stop.js` | source production daemon stop |

출력 요구사항:

- 실행 중인 daemon이 없으면 명확히 “not running”을 출력한다.
- graceful stop 성공 시 app/sentinel PID와 `/health` 종료 확인을 출력한다.
- graceful failure 시 timeout, state 검증 실패, protocol rejection 등 원인을 출력한다.

### IR-8-003: internal shutdown API

권장 Express route:

```http
POST /api/internal/shutdown HTTP/1.1
Host: 127.0.0.1:<port>
X-BuilderGate-Shutdown-Token: <shutdownToken>
```

응답:

| 상태 | 의미 |
| --- | --- |
| `200 OK` | `performGracefulShutdown()`이 workspace/CWD flush를 완료했고 response body에 flush result가 포함됨 |
| `401 Unauthorized` | token 누락 또는 invalid |
| `403 Forbidden` | non-loopback remote address |
| `404 Not Found` | daemon shutdown route 비활성 또는 production 조건 불일치 |
| `500` | flush 실패 또는 shutdown 준비 실패 |

route는 외부 인증용 JWT와 별개로 internal shutdown token을 사용한다. token은 Settings API나 일반 클라이언트 API에 노출하지 않는다.

---

## 7. 제약사항

| ID | 제약 |
| --- | --- |
| CON-8-001 | PM2 fallback은 구현하지 않는다. |
| CON-8-002 | `dist/bin` 기본 출력 위치와 ARM64 대상별 `dist/bin/<target>` 출력 위치, 실행파일 옆 `config.json5` 정책은 유지한다. |
| CON-8-003 | `--foreground`가 canonical이고 `--forground`는 alias다. 문서의 대표 명령은 `--foreground`를 사용한다. |
| CON-8-004 | TOTP 설정 schema는 현재 평탄화 계약인 `twoFactor.enabled`, `twoFactor.issuer`, `twoFactor.accountName`을 사용한다. |
| CON-8-005 | `dev.js` 개발 실행은 daemon mode로 바꾸지 않는다. |
| CON-8-006 | stop utility는 foreground process를 종료하지 않는다. |
| CON-8-007 | UI 시각 요소, 로그인 UX, WebSocket/SSE payload, session status flow를 변경하지 않는다. |
| CON-8-008 | invalid config, corrupted TOTP secret, missing runtime artifact 같은 의미 있는 오류를 safe default로 숨기지 않는다. |
| CON-8-009 | Windows에서 POSIX signal만으로 graceful shutdown 완료를 정의하지 않는다. localhost-only protocol 또는 동등한 IPC가 필수다. |
| CON-8-010 | macOS ARM64 cross-build 산출물과 `BuilderGate.app`은 빌드 호스트에서 서명되지 않을 수 있으므로, macOS 배포/실행 전 ad-hoc signing 또는 macOS 호스트 빌드가 필요하다는 운영 안내를 문서화한다. |

---

## 8. 인수 조건

### AC-8-001: packaged 기본 daemon 실행

- Given: `dist/bin`에 `BuilderGate.exe`, `server/dist/index.js`, bundled Node, `config.json5`가 있다.
- When: 사용자가 `dist/bin/BuilderGate.exe`를 인자 없이 실행한다.
- Then: parent는 30초 이내 readiness를 확인하고 0 exit code로 종료한다.
- And: parent 종료 후 `https://localhost:<port>/health`가 정상 응답한다.
- And: PM2 프로세스 또는 PM2 명령 호출이 관측되지 않는다.

### AC-8-002: source 기본 daemon 실행

- Given: repository source production build artifact가 준비되어 있다.
- When: 사용자가 `node tools/start-runtime.js`를 인자 없이 실행한다.
- Then: source runtime path contract로 daemon이 시작되고 parent 종료 후 `/health`가 응답한다.
- And: `CONFIG_PATH`는 기본 `<SERVER_DIR>/config.json5` 또는 env override를 따른다.

### AC-8-016: existing daemon start idempotency

- Given: 검증 가능한 active daemon state가 있고 app child가 `/health`에 응답한다.
- When: 사용자가 같은 `configPath`, `serverEntryPath`, `port`, `argvHash`로 다시 start를 실행한다.
- Then: launcher는 새 child를 만들지 않고 already running/idempotent success를 출력한다.
- And: 기존 appPid/sentinelPid가 유지된다.
- And: parent는 0 exit code로 종료한다.

### AC-8-017: conflicting daemon start rejection

- Given: 검증 가능한 active daemon state가 있다.
- When: 사용자가 다른 port, config path, server entry, 주요 argv로 start를 실행한다.
- Then: launcher는 자동 교체하지 않는다.
- And: 기존 daemon 정보를 출력하고 stop 후 재시작 안내를 제공한다.
- And: parent는 0이 아닌 exit code로 종료한다.

### AC-8-018: readiness identity false-positive 방지

- Given: target port에 무관한 서버 또는 이전 BuilderGate instance가 `/health` 200을 반환하고 있다.
- When: 새 daemon start가 실행된다.
- Then: launcher는 새로 spawn한 `appPid`와 `startAttemptId` 또는 `stateGeneration`이 일치하지 않는 `/health` 응답을 성공으로 판정하지 않는다.
- And: readiness timeout 또는 port conflict로 startup failure를 반환한다.

### AC-8-003: foreground 실행

- Given: runtime artifact가 준비되어 있다.
- When: 사용자가 `BuilderGate.exe --foreground` 또는 `BuilderGate.exe --forground`를 실행한다.
- Then: sentinel은 시작되지 않는다.
- And: 서버 stdout/stderr와 banner가 현재 콘솔에 보인다.
- And: Ctrl+C 또는 SIGTERM 시 workspace/CWD flush 후 종료한다.

### AC-8-004: daemon QR preflight

- Given: `config.twoFactor.enabled === true`이고 TOTP secret이 없거나 존재한다.
- When: 사용자가 daemon mode로 BuilderGate를 실행한다.
- Then: parent detach 전에 콘솔 QR과 manual entry key가 출력된다.
- And: app child는 같은 `TOTP_SECRET_PATH`를 사용한다.
- And: daemon 실행 1회당 QR은 중복 출력되지 않는다.

### AC-8-005: QR failure는 startup failure

- Given: TOTP secret 파일이 손상되어 복호화 또는 BASE32 검증에 실패한다.
- When: 사용자가 daemon mode로 BuilderGate를 실행한다.
- Then: launcher는 0이 아닌 exit code로 종료한다.
- And: app/sentinel child를 남기지 않는다.
- And: 원인 로그는 남기되 secret 평문은 남기지 않는다.

### AC-8-006: native stop 성공

- Given: BuilderGate가 daemon mode로 실행 중이다.
- When: 사용자가 `BuilderGateStop.exe`를 실행한다.
- Then: stop utility는 state를 검증하고 sentinel을 먼저 중지한다.
- And: internal shutdown protocol로 app graceful shutdown을 요청한다.
- And: 10초 이내 shutdown response의 flush result, workspace JSON `lastUpdated`, 대상 tab `state.tabs[].lastCwd`, `/health` 비응답을 확인한다.
- And: state를 `stopped`로 기록하거나 정리한다.

### AC-8-019: foreground process는 stop 대상 아님

- Given: BuilderGate가 `--foreground` 또는 `--forground`로 실행 중이고 daemon state는 active가 아니다.
- When: 사용자가 `BuilderGateStop.exe`를 실행한다.
- Then: stop utility는 foreground process를 종료하지 않는다.
- And: stop은 “daemon not running” 또는 동등한 메시지를 출력한다.
- And: foreground `/health`는 계속 응답한다.

### AC-8-007: stale PID 거부

- Given: state 파일의 appPid가 무관한 프로세스를 가리키도록 조작되어 있다.
- When: 사용자가 stop utility를 실행한다.
- Then: stop utility는 프로세스 검증 실패를 출력한다.
- And: 해당 PID를 종료하지 않는다.
- And: 0이 아닌 exit code를 반환한다.

### AC-8-008: PID reuse 거부

- Given: state의 PID 값은 존재하지만 process creation time 또는 command/cwd가 state와 다르다.
- When: 사용자가 stop utility를 실행한다.
- Then: stop utility는 PID reuse 또는 state mismatch로 판단한다.
- And: 해당 프로세스를 종료하지 않는다.

### AC-8-009: shutdown protocol negative

- Given: daemon이 실행 중이다.
- When: token 누락, invalid token, non-loopback remote, spoofed `X-Forwarded-For`/`Forwarded`/`X-Real-IP` 요청을 보낸다.
- Then: server는 shutdown을 거부한다.
- And: `/health`는 계속 응답한다.
- And: shutdown token은 로그에 남지 않는다.

### AC-8-010: sentinel restart 제한

- Given: app child가 비정상 종료된다.
- When: sentinel이 종료를 감지한다.
- Then: sentinel은 1초부터 최대 30초 backoff로 app을 재시작한다.
- And: 10분 내 5회를 초과하면 fatal 또는 stopped 상태로 더 이상 재시작하지 않는다.
- And: state의 restart 관련 필드가 갱신된다.

### AC-8-011: fatal startup은 재시작하지 않음

- Given: config schema 오류, certificate 오류, corrupted TOTP secret 같은 fatal startup failure가 있다.
- When: daemon start 또는 sentinel restart가 발생한다.
- Then: sentinel은 무한 재시작하지 않는다.
- And: state에 `status=fatal`과 `fatalReason`을 기록한다.

### AC-8-020: production config fallback 금지

- Given: packaged runtime 또는 source production runtime에서 `config.json5`가 존재하지만 JSON5 parse 또는 schema validation에 실패한다.
- When: 사용자가 daemon 또는 foreground로 실행한다.
- Then: default config로 조용히 대체하지 않는다.
- And: startup은 0이 아닌 exit code로 실패한다.
- And: daemon mode에서는 state에 `status=fatal`, `fatalStage=preflight`, `fatalReason`이 기록된다.
- And: app/sentinel spawn 전 실패한 경우 `appPid`, `sentinelPid`, `appProcessStartedAt`, `heartbeatAt`은 null 또는 생략되어도 schema valid로 처리된다.
- And: port 해석 전 config parse/schema 실패라면 `port=null`이 schema valid이며 default port를 기록하지 않는다.

### AC-8-012: build output

- Given: 사용자가 `npm run build`를 실행한다.
- When: build가 성공한다.
- Then: Windows ARM64, Linux ARM64, macOS ARM64 산출물은 각각 `dist/bin/win-arm64`, `dist/bin/linux-arm64`, `dist/bin/macos-arm64`에 생성된다.
- And: Windows ARM64 배포본에는 `BuilderGate.exe`, `BuilderGateStop.exe`, `server/`, `config.json5`, `config.json5.example`, `README.md`, `BuilderGate.svg`, `BuilderGate.ico`가 존재한다.
- And: Linux ARM64 배포본에는 `buildergate`, `buildergate-stop`, `server/`, `config.json5`, `config.json5.example`, `README.md`, `BuilderGate.svg`, `BuilderGate.ico`, `BuilderGate.icns`가 존재한다.
- And: macOS ARM64 배포본에는 `buildergate`, `buildergate-stop`, `BuilderGate.app`, `server/`, `config.json5`, `config.json5.example`, `README.md`, `BuilderGate.svg`, `BuilderGate.ico`, `BuilderGate.icns`가 존재한다.
- And: `BuilderGate.app`에는 `Contents/Info.plist`, `Contents/MacOS/BuilderGate`, `Contents/Resources/BuilderGate.icns`, `Contents/Resources/runtime/buildergate`가 존재한다.
- And: Finder에서 `BuilderGate.app`을 실행하면 Terminal을 통해 내부 `buildergate`가 실행되어 daemon QR 출력이 보일 수 있다.
- And: runtime dependency에 PM2가 포함되지 않는다.
- And: 각 배포본에는 대상 OS/CPU용 bundled Node runtime이 존재한다.
- And: Windows 실행파일과 macOS app bundle에는 브라우저 탭 아이콘과 동일한 실행파일/app 아이콘이 적용된다.

### AC-8-012A: single target build output

- Given: 사용자가 `npm run build:daemon-exe` 또는 `node tools/build-daemon-exe.js`를 실행한다.
- When: build가 성공한다.
- Then: 단일 기본 산출물은 기존 호환 경로인 `dist/bin`에 생성된다.
- And: `dist/daemon`은 사용하지 않는다.

### AC-8-013: config path 보존

- Given: `dist/bin/config.json5`의 server port를 특정 값으로 설정한다.
- When: packaged daemon 또는 foreground를 실행한다.
- Then: app child는 해당 port로 실행된다.
- And: settings 저장도 같은 `dist/bin/config.json5`에 반영된다.

### AC-8-014: 기존 옵션 보존

- Given: runtime artifact가 준비되어 있다.
- When: `-p`, `--reset-password`, `--bootstrap-allow-ip`, `--help`를 daemon/foreground와 조합해 실행한다.
- Then: 기존 옵션의 의미와 검증 규칙이 유지된다.

### AC-8-015: 문서 검증

- Given: README와 배포본 README가 갱신되어 있다.
- When: 사용자가 빌드, 실행, foreground, stop, config 위치, QR 정책을 확인한다.
- Then: PM2 기반 안내 없이 native daemon 흐름만으로 필요한 절차를 이해할 수 있다.

---

## 9. 테스트 요구사항

| 테스트 ID | 유형 | 대상 | 시나리오 | 필수 |
| --- | --- | --- | --- | --- |
| TEST-8-001 | unit | CLI parser | `--foreground`, `--forground`, `-p`, invalid port, reset password, bootstrap allowlist, help | Yes |
| TEST-8-002 | unit | runtime path resolver | packaged/source path contract, config override, server entry/node missing | Yes |
| TEST-8-003 | unit | daemon state | atomic write/read, corrupt state, schema validation, token masking | Yes |
| TEST-8-004 | unit | PID validator | stale PID, PID reuse, command/cwd mismatch, missing process | Yes |
| TEST-8-005 | integration | daemon launch | parent exits, app remains, `/health` OK, PM2 not invoked | Yes |
| TEST-8-006 | integration | foreground | console stdout/stderr, no sentinel, Ctrl+C/SIGTERM graceful flush | Yes |
| TEST-8-007 | integration | source daemon | `node tools/start-runtime.js` default daemon with source path contract | Yes |
| TEST-8-008 | integration | source foreground | `node tools/start-runtime.js --foreground` with current Node and source config | Yes |
| TEST-8-009 | integration | QR daemon | TOTP enabled, QR/manual key printed before detach, no duplicate QR | Yes |
| TEST-8-010 | integration | TOTP secret path | preflight/app child share `<SERVER_DIR>/data/totp.secret` | Yes |
| TEST-8-011 | integration | QR failure | corrupted secret causes startup failure and no orphan child | Yes |
| TEST-8-012 | integration | stop | native stop shuts down sentinel/app and `/health` fails | Yes |
| TEST-8-013 | integration | shutdown negative | missing/invalid token, non-loopback, spoofed headers rejected | Yes |
| TEST-8-014 | integration | workspace/CWD flush | stop updates workspace JSON `lastUpdated` and target `state.tabs[].lastCwd` after writing fixture CWD to `buildergate-cwd-<sessionId>.txt` or performing shell `cd` | Yes |
| TEST-8-015 | integration | sentinel restart | abnormal app exit restarts with backoff and updates state | Yes |
| TEST-8-016 | integration | fatal startup | config/cert/TOTP fatal does not restart-loop | Yes |
| TEST-8-017 | build | build output | `dist/bin` default output, `dist/bin/{win-arm64,linux-arm64,macos-arm64}` ARM64 outputs, macOS `BuilderGate.app`, PM2 absence, target bundled Node existence, icon asset existence/Windows icon embedding/macOS ICNS bundle icon | Yes |
| TEST-8-018 | docs | README | root and dist README include required native daemon keywords and reject forbidden PM2 patterns | Yes |
| TEST-8-019 | integration | existing daemon | same state/options start is idempotent success; different port/config/argv is rejected without auto replace | Yes |
| TEST-8-020 | integration | readiness identity | unrelated `/health` on target port does not satisfy readiness without matching `appPid` and `startAttemptId`/`stateGeneration` | Yes |
| TEST-8-021 | integration | foreground stop negative | `BuilderGateStop` does not terminate foreground process and reports daemon not running | Yes |
| TEST-8-022 | integration | production config strict | existing invalid JSON5/schema config fails production daemon/foreground without default fallback and records valid `fatalStage=preflight` state without PID fields; parse/schema failure before port resolution records `port=null` | Yes |
| TEST-8-023 | unit | TOTP runtime policy | initial startup TOTP failure throws/fatal; settings hot-swap failure preserves previous service with warning | Yes |

검증 명령은 구현 단계에서 실제 테스트 파일명에 맞춰 확정하되, 최종 완료 시 관련 unit/integration/build/docs 테스트를 재실행해야 한다.

---

## 10. 추적성 매트릭스

| PRD 항목 | SRS 요구사항 | 인수 조건 | 테스트 |
| --- | --- | --- | --- |
| 기본 데몬 실행 | FR-8-001, FR-8-012 | AC-8-001, AC-8-002, AC-8-016, AC-8-017, AC-8-018 | TEST-8-005, TEST-8-007, TEST-8-019, TEST-8-020 |
| 포그라운드 실행 | FR-8-002 | AC-8-003, AC-8-019 | TEST-8-006, TEST-8-008, TEST-8-021 |
| QR 출력 보장 | FR-8-004, FR-8-005 | AC-8-004, AC-8-005 | TEST-8-009, TEST-8-010, TEST-8-011, TEST-8-023 |
| PM2 제거 | FR-8-006 | AC-8-001, AC-8-012 | TEST-8-005, TEST-8-017, TEST-8-018 |
| native stop | FR-8-008, FR-8-009, FR-8-010 | AC-8-006, AC-8-007, AC-8-008, AC-8-009 | TEST-8-004, TEST-8-012, TEST-8-013, TEST-8-014 |
| daemon state | FR-8-007 | AC-8-006, AC-8-007, AC-8-010 | TEST-8-003, TEST-8-015 |
| sentinel watchdog | FR-8-011 | AC-8-010, AC-8-011, AC-8-020 | TEST-8-015, TEST-8-016, TEST-8-022 |
| build output | FR-8-013 | AC-8-012 | TEST-8-017 |
| config path/strict config | FR-8-014, FR-8-017 | AC-8-013, AC-8-020 | TEST-8-002, TEST-8-010, TEST-8-022 |
| 기존 CLI 옵션 | FR-8-003 | AC-8-014 | TEST-8-001 |
| 문서 | FR-8-016 | AC-8-015 | TEST-8-018 |

---

## 11. 구현 영향 범위

| 파일 | 변경 방향 |
| --- | --- |
| `tools/start-runtime.js` | PM2 제거, native daemon/foreground parser, runtime path resolver, QR preflight, app/sentinel spawn, readiness, state/log 관리 |
| `stop.js` | PM2 제거, state 읽기, PID 검증, sentinel stop, internal shutdown 호출, health 종료 확인 |
| `tools/build-daemon-exe.js` | PM2 install 제거, 대상별 bundled Node 유지, `dist/bin` 기본 output과 ARM64 대상별 output 유지, macOS `BuilderGate.app` 생성, README/config/icon copy 유지 |
| `server/src/index.ts` | internal shutdown route 또는 IPC adapter, graceful shutdown 재사용, `BUILDERGATE_TOTP_SECRET_PATH`/QR suppress 전달 |
| `server/src/services/TOTPService.ts` | secret path 주입 유지, QR suppress 옵션 또는 preflight helper 지원, secret 평문 로그 정책 검토 |
| `server/src/services/twoFactorRuntime.ts` | `BUILDERGATE_TOTP_SECRET_PATH`와 suppress QR 옵션을 반영하도록 runtime 초기화 경계 조정 |
| `server/src/utils/config.ts` | `BUILDERGATE_CONFIG_PATH` 계약 유지 및 source/package config path 검증 |
| `README.md` | native daemon build/run/stop/foreground/config/QR 정책 문서화 |
| tests | CLI/unit/integration/build/docs 회귀 추가 |

---

## 부록 A. 평가 기준

이번 SRS의 전문가 평가는 다음 7개 기준으로 수행한다.

| 기준 | 체크포인트 |
| --- | --- |
| 요구사항 완전성 | 기능/비기능/데이터/인터페이스/예외가 모두 구현 가능한 수준인가 |
| 구현 명확성 | 개발자가 추론 없이 파일과 동작을 매핑할 수 있는가 |
| 이전 버전 일관성 | 기존 config/build/TOTP/workspace/CWD 계약을 보존하는가 |
| 데몬 아키텍처 적합성 | PM2 대체 수준의 start/stop/watchdog/readiness/state가 닫혀 있는가 |
| 보안성 | shutdown token, loopback, PID 검증, secret/log 정책이 충분한가 |
| 테스트 가능성 | 정상/실패/엣지/회귀 테스트가 실행 가능한 단위로 정의되었는가 |
| 사용자 의도 적합성 | 기본 daemon, `--forground`, QR 출력, PM2 제거, `dist/bin`/config 위치 의도가 직접 반영되었는가 |

### 전문가 평가 요약

최종 라운드에서 기술 아키텍트, QA/테스트 전략, 사용자 의도/비즈니스 분석 3개 관점 모두 `No findings`를 반환했다.

| 기준 | 기술 아키텍트 | QA/테스트 전략 | 사용자 의도/비즈니스 분석 |
| --- | --- | --- | --- |
| 요구사항 완전성 | A+ | A+ | A+ |
| 구현 명확성 | A+ | A+ | A+ |
| 이전 버전 일관성 | A+ | A+ | A+ |
| 데몬 아키텍처 적합성 | A+ | A+ | A+ |
| 보안성 | A+ | A+ | A+ |
| 테스트 가능성 | A+ | A+ | A+ |
| 사용자 의도 적합성 | A+ | A+ | A+ |

평가 중 발견된 주요 개선사항은 SRS에 반영 완료했다.

| 개선 영역 | 반영 내용 |
| --- | --- |
| existing daemon/start 정책 | 동일 실행 계약은 idempotent success, 다른 계약은 stop 선행 요구로 명시 |
| readiness identity | `appPid`, `startAttemptId`, `stateGeneration` 기반 false-positive 방지 추가 |
| production strict config | daemon/foreground production에서 parse/schema/cert/TOTP fatal fallback 금지 |
| sentinel entrypoint | packaged physical sentinel entry와 source internal sentinel 실행 계약 명시 |
| shutdown 완료 판정 | `performGracefulShutdown()`과 workspace JSON `lastUpdated`, `state.tabs[].lastCwd` 검증 명시 |
| TOTP initial failure | initial startup fatal과 settings hot-swap warning 정책 분리 |
| fatal state schema | 상태별 union, `fatalStage`, preflight PID/heartbeat 생략, port 해석 전 `port=null` 허용 |
| docs/test 회귀 | README required/forbidden pattern, foreground stop negative, strict config tests 추가 |
