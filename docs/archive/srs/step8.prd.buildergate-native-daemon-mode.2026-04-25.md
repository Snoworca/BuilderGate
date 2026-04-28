# PRD: BuilderGate 네이티브 기본 데몬 모드 전환

**문서 ID**: PRD-BUILDERGATE-NATIVE-DAEMON-2026-04-25  
**프로젝트**: BuilderGate  
**작성일**: 2026-04-25  
**버전**: 1.0.0  
**상태**: Final (PRD 평가 2인 No findings)  
**기반 분석**: `docs/analysis/2026-04-25.buildergate-native-daemon-mode-prd-analysis.md`  
**참고 프로젝트**: `C:\Work\git\_Snoworca\TTTGate`

---

## 1. Executive Summary

### Problem Statement

현재 BuilderGate의 빌드 실행파일은 PM2를 통해 서버를 백그라운드 실행하는 런처에 가깝다. 이 구조는 `dist/bin` 배포본 안에 PM2 설치와 PM2 프로세스 상태를 끌고 들어오며, 빌드된 실행파일이 독립적인 네이티브 데몬처럼 동작해야 한다는 운영 의도와 맞지 않는다.

또한 BuilderGate는 TOTP가 활성화된 경우 서버 시작 시 콘솔에 2D 바코드(QR)를 출력해야 한다. 단순히 TTTGate처럼 detached child의 표준 입출력을 버리는 방식으로 데몬화하면 사용자가 QR을 보지 못해 최초 등록 또는 재등록 흐름이 깨진다.

### Proposed Solution

빌드된 BuilderGate 실행파일은 별도 `--daemon` 없이 기본적으로 PM2 없는 네이티브 데몬 모드로 실행한다. 명시적으로 `--foreground` 또는 호환 alias `--forground`를 전달한 경우에만 현재 콘솔에서 포그라운드 서버로 실행한다.

데몬 모드에서는 parent 런처가 설정을 로드하고 TOTP QR 출력이 필요한 경우 detach 전에 QR과 수동 입력 키를 현재 콘솔에 출력한 뒤, app child와 sentinel child를 백그라운드로 분리한다. 기존 PM2 기반 시작, 중지, 빌드 의존성은 native PID state, graceful stop, watchdog 구조로 대체한다.

### Success Criteria

| 지표 | 목표 | 측정 방법 |
| --- | --- | --- |
| 기본 데몬 실행 성공률 | `BuilderGate.exe` 무인자 실행 10회 중 10회 parent 종료 후 `/health` 정상 응답 | packaged smoke test |
| QR 출력 보장 | TOTP enabled 상태에서 데몬 실행 시 parent 종료 전 콘솔 QR이 반드시 출력되고 manual entry key가 추가 출력됨 | captured stdout smoke test |
| PM2 제거 | 배포본 `dist/bin`에 PM2 의존성, PM2 설치 로직, `pm2 start/stop/delete` 실행 경로가 0개 | `rg "pm2|PM2" dist/bin tools stop.js` 및 의존성 검증 |
| graceful stop | `BuilderGateStop.exe` 실행 후 10초 이내 app/sentinel 종료, workspace/CWD flush 완료가 관측됨 | pid state + `/health` 실패 + flush artifact 확인 |
| 설정 경로 보존 | EXE 옆 `config.json5`가 데몬/포그라운드 모두에서 동일하게 적용 | 포트 override 및 config path integration test |

---

## 2. User Experience & Functionality

### User Personas

| Persona | 설명 | 핵심 니즈 |
| --- | --- | --- |
| 로컬 운영자 | BuilderGate를 Windows 또는 각 OS별 실행파일로 실행하는 사용자 | 실행파일 더블클릭 또는 CLI 실행만으로 서버가 백그라운드 유지 |
| 보안 설정 사용자 | TOTP를 켜고 Google Authenticator 등록을 수행하는 사용자 | 데몬 실행이어도 콘솔에서 QR을 반드시 확인하고 manual key를 보조로 확인 |
| 자동화 사용자 | 배포본을 스크립트에서 시작/중지하는 사용자 | PM2 설치 없이 결정적인 start/stop 상태와 종료 코드 확보 |
| 개발자/디버거 | 서버 로그와 stdout을 직접 보며 문제를 분석하는 사용자 | `--foreground`로 현재 콘솔에서 실행 가능 |

### User Stories

#### US-1: 기본 데몬 실행

As a BuilderGate 운영자, I want to run `BuilderGate.exe` without `--daemon` so that the server continues in the background without requiring PM2.

**Acceptance Criteria**

- 인자 없이 실행한 빌드 실행파일은 기본 데몬 모드로 동작한다.
- parent 런처는 daemon child 시작과 readiness 확인 후 종료한다.
- parent 종료 후에도 HTTPS 서버는 설정된 포트에서 `/health`를 제공한다.
- 기존 `--daemon` 플래그는 필수가 아니며 문서의 기본 실행법에 등장하지 않는다.

#### US-2: 명시적 포그라운드 실행

As a developer, I want to run `BuilderGate.exe --foreground` so that I can see server stdout/stderr and stop it with the current console lifecycle.

**Acceptance Criteria**

- `--foreground`는 canonical foreground 플래그다.
- 사용자 원문 호환을 위해 `--forground`도 alias로 허용한다.
- 두 플래그가 모두 서버를 현재 프로세스 또는 현재 콘솔에 연결된 child로 실행한다.
- foreground 실행에서는 sentinel을 띄우지 않는다.
- foreground 실행에서는 stdout/stderr가 현재 콘솔에 그대로 보인다.

#### US-3: 데몬 모드에서도 2D 바코드 확인

As a TOTP user, I want the 2D barcode to be printed even when BuilderGate runs as a daemon so that I can register or re-register the authenticator without using PM2 logs.

**Acceptance Criteria**

- `config.twoFactor.enabled === true`인 경우, 데몬 detach 전 콘솔 QR을 반드시 출력하고 manual entry key를 추가로 출력한다.
- QR 출력은 데몬 모드에서 숨겨지거나 로그 파일에만 남으면 안 된다.
- 이미 secret이 존재해도 기존 정책과 동일하게 등록 확인용 QR과 manual key를 출력한다.
- parent preflight와 app child 초기화가 동시에 secret 파일을 생성하거나 QR을 중복 출력하지 않는다.

#### US-4: PM2 없는 중지

As an automation user, I want `BuilderGateStop.exe` to stop BuilderGate without PM2 so that the packaged runtime is self-contained.

**Acceptance Criteria**

- stop utility는 PM2 명령을 호출하지 않는다.
- stop utility는 native daemon state를 읽고 sentinel을 먼저 중지한 뒤 app에 내부 graceful shutdown 요청을 보낸다.
- stale PID 또는 무관한 프로세스를 종료하지 않도록 PID state를 검증한다.
- 종료 후 PID state는 정리되거나 stopped 상태로 기록된다.

#### US-5: 배포 구조 보존

As a packager, I want build output and runtime config locations to stay stable so that existing deployment scripts do not break.

**Acceptance Criteria**

- 빌드 산출물은 `dist/bin`에 생성된다.
- 실행 설정 파일은 실행파일과 같은 위치의 `config.json5`를 사용한다.
- `config.json5.example`도 같은 위치에 제공한다.
- 기존 `PORT`, `BUILDERGATE_CONFIG_PATH`, `BUILDERGATE_BOOTSTRAP_ALLOWED_IPS`, `NODE_ENV=production` 계약을 유지한다.

### Non-Goals

| 항목 | 제외 사유 |
| --- | --- |
| OS 서비스 등록 | 이번 요구는 OS service/launchd/systemd 등록이 아니라 packaged executable의 자체 daemon 동작이다. |
| 다중 인스턴스 관리 UI | 단일 BuilderGate 인스턴스의 start/stop 안정화가 우선이다. |
| TOTP 등록 웹 UI | 이번 범위는 기존 콘솔 QR 출력 보존이며 신규 등록 UI는 별도 기능이다. |
| PM2 호환 모드 | PM2 기반 구현은 제거 대상이므로 fallback PM2 경로를 유지하지 않는다. |
| 개발 서버 `dev.js` 데몬화 | Vite 개발 서버와 HTTPS reverse proxy 개발 흐름은 이번 native production daemon 범위 밖이다. |
| legacy `twoFactor.totp.*` schema | 현재 BuilderGate는 평탄화된 `twoFactor.enabled`, `twoFactor.issuer`, `twoFactor.accountName` 계약을 사용하므로 중첩 TOTP schema를 새로 도입하지 않는다. |

---

## 3. AI System Requirements

해당 없음. 본 PRD는 AI 모델 기능이 아니라 BuilderGate 실행파일의 런타임 프로세스 관리 기능을 정의한다.

---

## 4. Technical Specifications

### Architecture Overview

#### 목표 프로세스 구조

| 프로세스 | 실행 조건 | 책임 |
| --- | --- | --- |
| launcher parent | `BuilderGate.exe` 기본 실행 | CLI 파싱, config path 결정, reset-password 처리, QR preflight, 기존 daemon state 검증, app/sentinel 시작, readiness 확인 후 종료 |
| app child | daemon 또는 foreground | bundled Node로 `server/dist/index.js` 실행, HTTPS/HTTP redirect/WebSocket/static assets 제공 |
| sentinel child | daemon 전용 | app PID 감시, 비정상 종료 시 수치화된 backoff와 restart limit 안에서 재시작 |
| stop utility | `BuilderGateStop.exe` | daemon state 검증, sentinel 중지, localhost-only graceful shutdown protocol 호출, state 정리 |

#### 데몬 기본 실행 흐름

1. `BuilderGate.exe`가 실행된다.
2. CLI parser가 `--foreground` 또는 `--forground` 부재를 확인하고 daemon mode로 판정한다.
3. launcher가 EXE 옆 `config.json5` 경로와 `SERVER_DIR=dist/bin/server`를 결정하고 `BUILDERGATE_CONFIG_PATH`로 고정한다.
4. `--reset-password`, `--bootstrap-allow-ip`, `-p/--port` 등 기존 옵션을 적용한다.
5. `config.twoFactor.enabled === true`이면 `BUILDERGATE_TOTP_SECRET_PATH=<SERVER_DIR>/data/totp.secret`로 QR preflight를 수행한다.
6. launcher가 검증 가능한 daemon state를 작성하고 app child를 detached로 시작한다.
7. launcher가 sentinel child를 detached로 시작한다.
8. launcher가 `/health` 또는 child ready signal로 readiness를 확인한다.
9. launcher가 사용자에게 실행 상태와 중지 명령을 출력한 뒤 종료한다.

#### Runtime Path Contract

packaged runtime 기준 경로는 다음과 같다.

| 이름 | packaged runtime 기준값 | 설명 |
| --- | --- | --- |
| `BIN_DIR` | `path.dirname(process.execPath)` | `BuilderGate.exe` 또는 OS별 실행파일이 위치한 디렉터리 |
| `SERVER_DIR` | `<BIN_DIR>/server` | app child의 고정 cwd |
| `SERVER_ENTRY` | `<SERVER_DIR>/dist/index.js` | app child가 실행할 서버 엔트리 |
| `NODE_BIN` | `<SERVER_DIR>/node_modules/.bin/node(.exe)` | app child 실행에 사용하는 bundled Node runtime |
| `CONFIG_PATH` | `<BIN_DIR>/config.json5` | 서버와 preflight가 공유하는 설정 파일 |
| `TOTP_SECRET_PATH` | `<SERVER_DIR>/data/totp.secret` | QR preflight와 app child가 공유하는 canonical TOTP secret 파일 |

`NODE_BIN`, `SERVER_ENTRY`, `CONFIG_PATH`가 누락되면 startup failure로 처리한다. 이 경우 daemon child를 부분적으로 남기지 않고 parent가 0이 아닌 exit code와 원인 로그를 반환해야 한다.

source production runtime, 즉 `node tools/start-runtime.js` 기준 경로는 다음과 같다. 이 경로 계약은 `dev.js` 개발 실행에는 적용하지 않는다.

| 이름 | source production 기준값 | 설명 |
| --- | --- | --- |
| `SOURCE_ROOT` | `BUILDERGATE_ROOT` env가 있으면 그 값, 없으면 repository root | source runtime root |
| `BIN_DIR` | `<SOURCE_ROOT>` | source daemon state/log root의 기준 디렉터리 |
| `SERVER_DIR` | `<SOURCE_ROOT>/server` | app child의 고정 cwd |
| `SERVER_ENTRY` | `<SERVER_DIR>/dist/index.js` | app child가 실행할 서버 엔트리 |
| `NODE_BIN` | `process.execPath` | 현재 `node` 실행파일 |
| `CONFIG_PATH` | `BUILDERGATE_CONFIG_PATH` env가 있으면 그 값, 없으면 `<SERVER_DIR>/config.json5` | source production 설정 파일 |
| `TOTP_SECRET_PATH` | `<SERVER_DIR>/data/totp.secret` | QR preflight와 app child가 공유하는 canonical TOTP secret 파일 |

source production runtime도 기본 실행은 daemon mode이며, `--foreground` 또는 `--forground`를 전달한 경우에만 foreground mode로 실행한다.

### Functional Requirements

#### FR-DAEMON-001: 기본 데몬 모드

빌드된 BuilderGate 실행파일은 인자 없이 실행할 때 기본 데몬 모드로 동작해야 한다.

**상세 요구사항**

- `--daemon` 없이 daemon mode가 기본값이어야 한다.
- daemon mode는 PM2 없이 app child와 sentinel child를 시작해야 한다.
- parent launcher는 daemon child 시작 후 계속 점유되지 않고 종료해야 한다.
- daemon 실행 실패 시 parent는 0이 아닌 exit code와 원인 로그를 남겨야 한다.
- `node tools/start-runtime.js`로 실행하는 production runtime도 packaged executable과 동일하게 기본 daemon mode로 동작해야 한다.
- `dev.js` 개발 실행은 이 요구사항의 대상이 아니다.

#### FR-DAEMON-002: 포그라운드 모드

`--foreground` 실행 시 현재 콘솔에서 서버를 실행해야 한다.

**상세 요구사항**

- `--foreground`는 canonical flag다.
- `--forground`는 사용자 원문 호환 alias로 허용한다.
- foreground mode에서는 sentinel을 시작하지 않는다.
- foreground mode에서는 app stdout/stderr를 현재 콘솔에 연결한다.
- foreground mode에서도 EXE 옆 config와 기존 환경변수 계약은 daemon mode와 동일하다.

#### FR-DAEMON-003: 2D 바코드 출력 보장

데몬 모드에서도 TOTP 2D 바코드와 manual entry key는 사용자 콘솔에 출력되어야 한다.

**상세 요구사항**

- QR 출력 조건은 현재 코드 계약인 `config.twoFactor.enabled === true`다.
- legacy 중첩 설정인 `twoFactor.totp.enabled`를 새 조건으로 도입하지 않는다.
- QR preflight는 daemon detach 전에 완료되어야 한다.
- QR preflight는 콘솔 QR을 반드시 출력해야 하며, manual entry key는 QR 출력의 대체물이 아니라 보조 출력이다.
- QR preflight와 app child는 모두 `BUILDERGATE_TOTP_SECRET_PATH=<SERVER_DIR>/data/totp.secret`를 사용해야 한다.
- QR preflight는 secret 생성/로드와 CryptoService 암복호화 정책을 서버와 동일하게 따라야 한다.
- daemon mode의 app child에는 `BUILDERGATE_SUPPRESS_TOTP_QR=1` 또는 동등한 명시 계약을 전달하여 preflight 이후 QR 중복 출력을 막아야 한다.
- foreground mode에서는 QR을 suppress하지 않으며 현재 콘솔에 서버의 QR 출력이 그대로 보여야 한다.
- QR 출력 실패는 TOTP enabled 상태에서는 의미 있는 startup failure로 처리해야 하며, 조용히 무시하면 안 된다.

#### FR-DAEMON-004: PM2 제거

빌드 실행, runtime 시작, 중지 경로에서 PM2 구현을 제거해야 한다.

**상세 요구사항**

- `tools/start-runtime.js`는 PM2 설치 확인, 글로벌 설치, `pm2 start`, `pm2 delete`를 수행하지 않는다.
- `stop.js`는 `pm2 jlist`, `pm2 stop`, `pm2 delete`를 수행하지 않는다.
- `tools/build-daemon-exe.js`는 배포본 production dependency에 `pm2`를 설치하지 않는다.
- README와 배포본 README는 PM2 기반 실행법을 안내하지 않는다.

#### FR-DAEMON-005: native stop utility

`BuilderGateStop.exe`는 PM2 없이 native daemon을 종료해야 한다.

**상세 요구사항**

- stop utility는 daemon state 파일을 읽어 app PID와 sentinel PID를 식별한다.
- sentinel을 먼저 종료하여 app 자동 재시작을 막는다.
- app 종료는 OS signal만으로 정의하지 않고 localhost-only graceful shutdown protocol로 정의한다.
- graceful shutdown protocol은 daemon state에 저장된 랜덤 `shutdownToken`을 사용해야 하며, loopback 주소에서 온 요청과 token이 모두 유효할 때만 허용한다.
- 권장 인터페이스는 `POST https://127.0.0.1:<port>/api/internal/shutdown` 또는 동등한 named pipe/IPC다.
- shutdown 요청은 서버의 기존 graceful shutdown 경로와 workspace/CWD flush를 완료한 뒤 성공으로 판정되어야 한다.
- POSIX에서는 `SIGTERM`을 보조 경로로 사용할 수 있으나, Windows에서도 동일한 완료 판정을 얻을 수 있는 protocol이 필수다.
- graceful timeout은 10초다. timeout 후 kill fallback이 실행되면 stop은 이를 graceful failure로 표시하고 0이 아닌 exit code 또는 명확한 경고 상태를 반환해야 한다.
- stop 완료 후 `/health`가 더 이상 응답하지 않아야 한다.
- foreground process는 stop utility의 대상이 아니다. foreground 실행은 현재 콘솔의 Ctrl+C, SIGINT, SIGTERM 또는 부모 프로세스 lifecycle로 종료한다.

#### FR-DAEMON-006: daemon state와 PID 검증

native daemon은 stale PID 또는 PID 재사용으로 무관한 프로세스를 종료하면 안 된다.

**상세 요구사항**

- state 파일은 단순 PID append 파일이 아니라 JSON 상태 파일이어야 한다.
- state 파일 위치는 `<BIN_DIR>/runtime/buildergate.daemon.json`으로 고정한다.
- state에는 app PID, sentinel PID, 실행파일 경로, server entry path, cwd, argv hash 또는 mode, config path, shutdown token, heartbeat timestamp, OS process creation time 또는 start tick을 포함해야 한다.
- stop 전 대상 프로세스의 실행파일 또는 command line이 BuilderGate runtime과 일치하는지 검증해야 한다.
- 검증 실패 시 강제 종료하지 않고 사용자에게 수동 확인 가능한 오류를 출력해야 한다.

#### FR-DAEMON-007: 설정 파일 위치 보존

실행 설정 파일은 실행파일과 같은 위치의 `config.json5`를 사용해야 한다.

**상세 요구사항**

- packaged runtime에서 config path 기본값은 `path.dirname(process.execPath)/config.json5`다.
- `node tools/start-runtime.js` source production runtime의 config path는 기존 호환 규칙을 따르되, 실행 모드는 packaged runtime과 동일하게 기본 daemon, `--foreground`/`--forground` foreground다.
- `BUILDERGATE_CONFIG_PATH`는 app child에 명시적으로 전달한다.
- config example은 `dist/bin/config.json5.example`에 유지한다.

#### FR-DAEMON-008: 기존 CLI 옵션 보존

기존 runtime CLI 옵션은 daemon/foreground 양쪽에서 동작해야 한다.

**보존 대상**

- `-p`, `--port`
- `--reset-password`
- `--bootstrap-allow-ip`
- `--help`

**상세 요구사항**

- `--help`에는 기본 daemon, `--foreground`, `--forground` alias, stop 명령을 명시한다.
- `--reset-password`는 daemon child 시작 전에 config 파일을 수정해야 한다.
- `--bootstrap-allow-ip`는 해당 실행에만 `BUILDERGATE_BOOTSTRAP_ALLOWED_IPS`로 전달한다.

#### FR-DAEMON-009: 빌드 산출물 위치

daemon 실행파일과 관련 산출물은 `dist/bin`에 생성되어야 한다.

**상세 요구사항**

- `BuilderGate.exe` 또는 OS별 실행파일은 `dist/bin`에 생성된다.
- `BuilderGateStop.exe` 또는 OS별 stop 실행파일은 `dist/bin`에 생성된다.
- `server/`, `config.json5`, `config.json5.example`, README 배포 문서는 기존 배포 구조와 호환되어야 한다.
- packaged app child는 `<SERVER_DIR>/node_modules/.bin/node(.exe)`로 `<SERVER_DIR>/dist/index.js`를 `cwd=<SERVER_DIR>`에서 실행해야 한다.
- bundled Node runtime이 누락되면 daemon을 시작하지 않고 startup failure로 처리해야 한다.
- `dist/daemon` 또는 기타 legacy 출력 경로를 새 기본 경로로 사용하지 않는다.

### Non-Functional Requirements

| ID | 요구사항 | 검증 |
| --- | --- | --- |
| NFR-DAEMON-001 | native daemon은 PM2 없이 동작해야 한다. | 배포본 의존성 및 실행 로그 검증 |
| NFR-DAEMON-002 | daemon child stdout/stderr는 `<BIN_DIR>/runtime/buildergate-daemon.log` 또는 동등한 진단 로그 파일로 남아야 한다. | 로그 파일 생성 및 오류 출력 smoke test |
| NFR-DAEMON-003 | app child 반복 실패 시 sentinel은 `initialBackoff=1s`, `maxBackoff=30s`, `maxRestarts=5 within 10min` 정책으로 무한 재시작 루프를 제한해야 한다. | 실패 config integration test |
| NFR-DAEMON-004 | stop은 서버의 graceful shutdown protocol을 우선 실행하고 workspace/CWD flush 완료를 검증해야 한다. | flush artifact 확인 |
| NFR-DAEMON-005 | QR preflight는 app child와 같은 `BUILDERGATE_TOTP_SECRET_PATH`를 사용해야 한다. | secret path regression test |
| NFR-DAEMON-006 | daemon startup failure는 exit code와 로그로 추적 가능해야 한다. | 실패 케이스 CLI test |
| NFR-DAEMON-007 | 기존 UI, 인증 플로우, WebSocket/SSE payload 계약을 변경하지 않는다. | 기존 테스트 회귀 |
| NFR-DAEMON-008 | sentinel은 app 재시작 시 state의 `appPid`, `restartCount`, `lastRestartAt`, `lastExitCode`, `heartbeatAt`을 갱신해야 한다. | sentinel restart state test |
| NFR-DAEMON-009 | config/schema/certificate/TOTP secret corruption 같은 fatal startup failure는 재시작 루프를 시작하지 않고 fatal state로 기록해야 한다. | fatal startup test |
| NFR-DAEMON-010 | internal shutdown protocol은 missing/invalid token, non-loopback remote address, spoofed forwarding header를 모두 거부해야 한다. | shutdown protocol negative test |

### Integration Points

| 영역 | 현재 파일 | 변경 방향 |
| --- | --- | --- |
| runtime launcher | `tools/start-runtime.js` | PM2 제거, native daemon/foreground parser, QR preflight, pid state, app/sentinel spawn |
| stop utility | `stop.js` | PM2 stop/delete 제거, native pid state 기반 graceful stop |
| packaging | `tools/build-daemon-exe.js` | PM2 설치 제거, `dist/bin` 산출물 유지 |
| TOTP | `server/src/services/TOTPService.ts`, `server/src/services/twoFactorRuntime.ts` | launcher preflight에서 재사용 가능한 secret/QR 출력 경계 추출 또는 옵션화 |
| config | `server/src/utils/config.ts` | EXE 옆 config path와 child env 전달 유지 |
| shutdown | `server/src/index.ts` 또는 internal route/IPC adapter | localhost-only graceful shutdown protocol과 workspace/CWD flush 완료 응답 추가 |
| docs | `README.md`, 배포본 README | 기본 daemon, foreground, stop, QR 출력 정책 갱신 |

### Data Requirements

#### daemon state

고정 파일 위치: `<BIN_DIR>/runtime/buildergate.daemon.json`. 구현 단계에서 OS별 파일 잠금과 쓰기 권한을 확인하되, 배포본 자체 실행 경험을 해치지 않아야 한다.

필수 필드:

| 필드 | 설명 |
| --- | --- |
| `version` | state schema version |
| `mode` | `daemon` |
| `appPid` | server app child PID |
| `sentinelPid` | sentinel child PID |
| `launcherPath` | 실행파일 또는 launcher script 경로 |
| `serverEntryPath` | 실행 중인 `server/dist/index.js` 절대 경로 |
| `serverCwd` | app child cwd |
| `configPath` | 사용 중인 `config.json5` 절대 경로 |
| `totpSecretPath` | 사용 중인 TOTP secret 절대 경로 |
| `port` | HTTPS port |
| `startedAt` | ISO timestamp |
| `appProcessStartedAt` | OS가 제공하는 process creation time 또는 start tick |
| `argvHash` | 주요 실행 옵션 hash |
| `shutdownToken` | localhost-only graceful shutdown protocol 검증용 랜덤 토큰 |
| `restartCount` | sentinel restart count |
| `lastRestartAt` | 마지막 재시작 timestamp |
| `lastExitCode` | 마지막 app child exit code 또는 signal |
| `heartbeatAt` | sentinel/app 상태 갱신 timestamp |

### Security & Privacy

| 항목 | 요구사항 |
| --- | --- |
| TOTP secret | QR preflight와 app child가 동일한 암호화/복호화 정책과 `BUILDERGATE_TOTP_SECRET_PATH`를 사용하며 secret을 로그 파일에 평문으로 남기지 않는다. 단, 기존 정책상 현재 콘솔의 manual entry key 출력은 사용자 등록을 위해 허용한다. |
| PID 종료 | state 검증 없이 임의 PID를 종료하지 않는다. |
| 로그 | daemon 로그에는 config path, port, PID, 오류는 남기되 비밀번호, JWT, OTP 코드는 남기지 않는다. |
| bootstrap allowlist | `--bootstrap-allow-ip`는 해당 실행의 env로만 전달되고 config에 영구 저장되지 않는다. |
| shutdown token | `shutdownToken`은 state 파일에만 저장하고 로그에 출력하지 않는다. internal shutdown 요청은 loopback과 token을 모두 검증해야 한다. |
| forwarding header | internal shutdown protocol은 `X-Forwarded-For`, `Forwarded`, `X-Real-IP` 같은 헤더를 신뢰해 loopback 여부를 판단하면 안 된다. |

---

## 5. Risks & Roadmap

### Phased Rollout

| Phase | 목표 | 산출물 |
| --- | --- | --- |
| MVP | PM2 제거와 기본 daemon/foreground/stop 구현 | native launcher, stop utility, build script, README 갱신 |
| v1.1 | QR preflight 안정화와 secret path 명시화 | TOTP helper 추출, `BUILDERGATE_TOTP_SECRET_PATH`, no-duplicate QR test |
| v1.2 | watchdog 품질 강화 | sentinel backoff, restart limit, daemon log rotation |
| v2.0 | OS service 선택 지원 검토 | Windows Service/systemd/launchd는 별도 PRD |

### Technical Risks

| 리스크 | 영향 | 완화 |
| --- | --- | --- |
| QR preflight와 app child의 TOTP 초기화 중복 | QR 중복 출력, secret race | shared helper와 `BUILDERGATE_SUPPRESS_TOTP_QR=1`로 idempotent 처리 |
| cwd 변경에 따른 `data/totp.secret` 위치 변경 | 기존 등록 secret 유실처럼 보임 | app child cwd를 `<SERVER_DIR>`로 고정하고 `BUILDERGATE_TOTP_SECRET_PATH=<SERVER_DIR>/data/totp.secret` 전달 |
| Windows process tree 종료 차이 | app child 잔존 또는 graceful hook 미실행 | localhost-only shutdown protocol, PID 검증, 10초 graceful timeout, fallback failure 표시 |
| sentinel 무한 재시작 | CPU/log 폭주 | `initialBackoff=1s`, `maxBackoff=30s`, `maxRestarts=5 within 10min` 정책 |
| parent readiness 판정 오류 | parent는 종료했지만 서버가 뜨지 않음 | `/health` polling timeout과 실패 exit code |
| 배포본 쓰기 권한 | state/log/config 쓰기 실패 | EXE dir 쓰기 실패 시 명확한 오류와 문서화된 권한 요구 |

### Testing Strategy

| 테스트 | 범위 | 필수 여부 |
| --- | --- | --- |
| CLI parser unit | `--foreground`, `--forground`, `-p`, `--reset-password`, `--bootstrap-allow-ip`, `--help` | 필수 |
| daemon launch smoke | parent 종료 후 background app `/health` 응답 | 필수 |
| foreground smoke | current console stdout/stderr 및 SIGINT/SIGTERM 종료 | 필수 |
| source daemon smoke | `node tools/start-runtime.js` 기본 실행 시 source path contract로 background app `/health` 응답 | 필수 |
| source foreground smoke | `node tools/start-runtime.js --foreground` 실행 시 `NODE_BIN=process.execPath`, `CONFIG_PATH=<SERVER_DIR>/config.json5` 계약 확인 | 필수 |
| QR daemon smoke | `config.twoFactor.enabled === true` 상태에서 daemon 실행 시 QR과 manual key가 모두 출력 | 필수 |
| QR no-duplicate | preflight와 app child QR 중복 출력 없음 | 필수 |
| config path integration | EXE 옆 `config.json5`가 app child에 적용 | 필수 |
| TOTP secret path regression | preflight와 app child가 모두 `<SERVER_DIR>/data/totp.secret`를 사용 | 필수 |
| stop smoke | native stop 후 app/sentinel 종료 및 workspace/CWD flush artifact 변화 확인 | 필수 |
| shutdown protocol negative | missing/invalid token, non-loopback remote, spoofed forwarding header를 거부하고 `/health`가 유지되며 token이 로그에 남지 않음 | 필수 |
| stale PID negative | 무관 PID state 조작 시 종료 거부 | 필수 |
| PID reuse negative | PID는 같지만 process creation time 또는 command line이 다른 경우 종료 거부 | 필수 |
| sentinel restart | app 비정상 종료 후 backoff 정책과 state 갱신 확인 | 필수 |
| fatal startup | config/schema/certificate/TOTP secret corruption 시 restart loop 없이 fatal state 기록 | 필수 |
| bundled Node | `NODE_BIN` 존재와 `<SERVER_DIR>/dist/index.js` 실행 가능 확인 | 필수 |
| build output | `npm run build:daemon-exe` 후 `dist/bin` 산출물, bundled Node, PM2 부재 | 필수 |

### Open Decisions

| 결정 항목 | PRD 결정 |
| --- | --- |
| `--forground` 오탈자 | alias로 허용한다. canonical 문서는 `--foreground`다. |
| PM2 fallback | 허용하지 않는다. PM2는 제거 대상이다. |
| TTTGate 방식 직접 복사 | 허용하지 않는다. detached stdio ignore는 QR 출력 요구와 충돌한다. |
| source production 실행 | `node tools/start-runtime.js`는 기본 daemon, `--foreground`/`--forground`는 foreground로 packaged runtime과 동일하게 동작한다. |
| source 개발 실행 | `dev.js` 개발 흐름은 범위 밖이다. |
| foreground stop | `BuilderGateStop.exe`는 foreground process를 종료하지 않는다. foreground는 현재 콘솔 lifecycle로 종료한다. |

### Intent Alignment Checklist

| 사용자 의도 | PRD 반영 |
| --- | --- |
| `--daemon` 없이 기본 데몬으로 동작 | FR-DAEMON-001 |
| `--forground`에서는 포그라운드로 동작 | FR-DAEMON-002에서 `--forground` alias 허용 |
| 데몬이어도 2D 바코드 출력 후 백그라운드 동작 | FR-DAEMON-003 |
| 빌드된 EXE 또는 OS별 실행파일에서 기본 동작 | FR-DAEMON-001, FR-DAEMON-009 |
| 기존 PM2 데몬 구현 제거 및 대체 | FR-DAEMON-004, FR-DAEMON-005 |
| `dist/bin`과 EXE 옆 설정 파일 정책 유지 | FR-DAEMON-007, FR-DAEMON-009 |
