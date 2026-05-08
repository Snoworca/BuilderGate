# BuilderGate 소프트웨어 요구사항 명세서

## 문서 메타데이터

| 항목 | 값 |
|---|---|
| 문서 유형 | Software Requirements Specification, SRS |
| 표준 형식 | ISO/IEC/IEEE 29148:2018 기반 한국어 통합 SRS |
| 제품명 | BuilderGate |
| 기준 버전 | 통합 v1.2 |
| 기준일 | 2026-05-08 |
| 기준 언어 | 한국어 |
| 기준 문서 상태 | Draft, 통합 기준안 |
| 기준 원칙 | 현재 코드 우선, 최신 SRS 우선, 과거 단계 문서는 추적성 근거로 보존 |

## 1. 개요

### 1.1 목적

본 문서는 `docs/spec`와 `docs/srs`에 분산되어 있던 BuilderGate 요구사항을 하나의 한국어 SRS로 통합한다. 기존 단계별 문서는 삭제하지 않고 이 문서의 입력 근거로 취급한다. 구현, 검증, 회귀 테스트, 후속 계획은 본 문서를 기준 요구사항으로 삼는다.

본 문서는 다음 독자를 대상으로 한다.

- BuilderGate를 수정하는 개발자와 코딩 에이전트
- 기능 구현 계획을 작성하는 기획자와 아키텍트
- 회귀 테스트와 수동 검증을 수행하는 QA 담당자
- 인증, 배포, 런타임 정책을 검토하는 보안 및 운영 담당자

### 1.2 범위

BuilderGate는 브라우저에서 다중 셸 세션을 워크스페이스와 탭 단위로 운용하고, 필요 시 그리드로 동시에 표시하는 HTTPS 기반 개발 작업 환경이다. 본 SRS는 다음 제품 범위를 포함한다.

- HTTPS 서버, HTTP 리다이렉트 서버, Vite 개발 서버 프록시
- 네이티브 데몬 기반 production 런처와 stop 유틸리티
- JWT 기반 로그인, 최초 비밀번호 bootstrap, 선택적 TOTP 2FA
- WebSocket 기반 터미널 입출력, 세션 구독, 스냅샷 재생, 상태 이벤트
- node-pty 기반 셸 세션 생성, 입력, resize, 종료, CWD 추적
- Workspace, Tab, Grid, React Mosaic 기반 레이아웃과 상태 영속화
- 공용 Dialog shell, modal/modeless 확장 인터페이스, 브라우저별 dialog geometry 영속화
- 파일 작업 REST API와 CWD 조회
- 런타임 설정 조회 및 제한적 PATCH
- 관찰성, 오류 응답, 디버그 캡처, 회귀 테스트 정책

### 1.3 범위 제외

다음 항목은 기존 문서 또는 코드 흔적에 존재하더라도 본 통합 SRS의 현 범위에서 제외한다.

| ID | 제외 항목 | 사유 |
|---|---|---|
| OOS-001 | 다중 사용자, 권한별 ACL, 조직 계정 | 현재 단일 관리자 모델이다. |
| OOS-002 | 이메일 OTP 기반 2FA | 현재 인증 흐름은 TOTP 중심이다. |
| OOS-003 | MCP 통합, 태스크 보드, 에이전트 간 메시지 버스 | 장기 비전이나 현재 필수 제품 계약이 아니다. |
| OOS-004 | 외부 인터넷 공개 SaaS 배포 모델 | 기본 가정은 로컬 또는 신뢰 네트워크 자가 호스팅이다. |
| OOS-005 | 오래된 SplitPane 또는 tmux prefix mode 계약 | 현재 제품 기준은 Workspace, Tab, Grid, React Mosaic이다. |
| OOS-006 | 활성 FileManager/Mdir 화면과 viewer 탭 | 컴포넌트와 일부 훅은 남아 있으나 현재 `App.tsx`의 Workspace/Grid/Terminal 화면에 마운트되지 않는다. 파일 REST API는 범위에 포함한다. |
| OOS-007 | 빈 Grid cell 추가 UI | `EmptyCell` 컴포넌트는 남아 있으나 현재 Mosaic 화면의 활성 흐름에 연결되어 있지 않다. 빈 Workspace의 터미널 추가 흐름은 범위에 포함한다. |

### 1.4 문서 우선순위

요구사항 충돌 시 다음 순서를 적용한다.

1. 현재 코드와 테스트
2. 최신 문서: `docs/archive/srs/step8.srs.buildergate-native-daemon-mode.2026-04-27.md`
3. 코드 역산출 SRS: `docs/archive/srs/srs-fromCode-2026-04-24.buildergate.md`
4. 승인된 단계 SRS: `docs/archive/spec/srs.step7.pivot.md`, `docs/archive/spec/srs.step6.md`
5. 기타 `docs/spec`, `docs/srs`의 과거 단계 문서와 request 원문

### 1.5 입력 문서

| 구분 | 경로 | 통합 반영 방식 |
|---|---|---|
| 초기 SRS | `docs/archive/spec/srs.startup.md` | HTTPS, 기본 구조, 초기 실행 요구사항 근거 |
| 보안 SRS | `docs/archive/spec/srs.step2.md` | 인증, TLS, 보안 헤더, CORS 요구사항 근거 |
| UX 및 파일 SRS | `docs/archive/spec/srs.step3.md` | 터미널 UX, 파일 매니저, API 근거 |
| Runtime Settings SRS | `docs/archive/spec/srs.step5.md` | 설정 화면과 런타임 적용 범위 근거 |
| Pane/Grid SRS | `docs/archive/spec/srs.step6.md` | 그리드와 레이아웃 요구사항의 과거 근거 |
| Workspace Pivot SRS | `docs/archive/spec/srs.step7.pivot.md` | 현재 Workspace, Tab, Grid 제품 모델 근거 |
| React Mosaic PRD/SRS | `docs/archive/srs/step0.*`, `docs/archive/srs/step1.*`, `docs/archive/srs/step2.*`, `docs/archive/srs/step3.*` | Mosaic, 탭/그리드 UX, 이동/드래그 요구사항 근거 |
| TOTP SRS | `docs/archive/srs/step6.srs.totp-google-authenticator-인증.2026-04-08.md` | TOTP 인증 요구사항 근거 |
| CWD 및 설정 계획 | `docs/archive/srs/step5.*`, `docs/archive/srs/step6.srs-plan.*` | CWD 영속화, twoFactor 설정 구조 근거 |
| Equal mode DnD 계획 | `docs/archive/srs/step7.srs-plan.equal-모드-무브버튼-드래그-영역-복원.2026-04-22.md` | 그리드 DnD 회귀 요구사항 근거 |
| Native daemon PRD/SRS | `docs/archive/srs/step8.prd.*`, `docs/archive/srs/step8.srs.*` | 최신 production 런처와 데몬 요구사항 근거 |
| 코드 역산출 SRS | `docs/archive/srs/srs-fromCode-2026-04-24.buildergate.md` | 현재 코드 기반 요구사항의 광역 인덱스 |

## 2. 제품 설명

### 2.1 제품 관점

BuilderGate는 로컬 또는 신뢰 가능한 네트워크의 단일 호스트에서 실행되는 웹 애플리케이션이다. 브라우저는 HTTPS로 접속하고, 실시간 터미널 이벤트는 WebSocket으로 송수신한다. 백엔드는 Express, node-pty, WebSocket, JSON5 설정, TLS 인증서, 런타임 상태 저장소를 관리한다. 프런트엔드는 React, xterm.js, React Mosaic 기반 UI를 제공한다.

### 2.2 주요 사용자

| 사용자 | 설명 | 핵심 요구 |
|---|---|---|
| 개발자 | BuilderGate의 주 사용자 | 브라우저에서 여러 셸과 코딩 에이전트를 안정적으로 운용 |
| 운영자 | 런처, 배포본, 설정 파일을 관리하는 사용자 | PM2 없는 결정적 start/stop, 로그와 상태 확인 |
| QA/리뷰어 | 회귀 테스트와 수동 검증 담당 | 명확한 수용 기준, HTTPS 2002 검증 규칙 |
| 코딩 에이전트 | 터미널에서 실행되는 Codex, Claude, Hermes 등 | 사용자 입력 중 idle invariant 보장 |

### 2.3 운영 환경

| 항목 | 요구사항 |
|---|---|
| 서버 런타임 | Node.js, TypeScript 빌드 산출물 |
| 프런트엔드 | 최신 Chromium 계열 브라우저 권장 |
| 기본 HTTPS 포트 | `https://localhost:2002` |
| HTTP 리다이렉트 포트 | `http://localhost:2001` |
| Vite 개발 서버 포트 | `http://localhost:2003` |
| 수동 검증 대상 | 반드시 `https://localhost:2002` |
| 설정 파일 | source runtime은 `server/config.json5`, packaged runtime은 실행파일 옆 `config.json5` |
| 상태 파일 | Workspace 상태, daemon state, TOTP secret 등은 UTF-8 JSON 또는 암호화 파일로 저장 |

### 2.4 제품 제약

| ID | 요구사항 |
|---|---|
| CON-001 | 모든 프로젝트 파일 읽기와 쓰기는 UTF-8을 사용해야 한다. |
| CON-002 | 인증과 설정의 의미 있는 오류는 숨기지 않고 응답, 로그, 디버그 캡처, 테스트 중 하나로 추적 가능해야 한다. |
| CON-003 | 기존 API, WebSocket payload, session status 흐름은 명시적 의도 없이는 깨지지 않아야 한다. |
| CON-004 | 개발 실행 `dev.js`는 daemon mode로 변경하지 않아야 한다. |
| CON-005 | UI 시각, 레이블, 아이콘, 레이아웃은 기능 구현에 필수인 경우가 아니면 임의 변경하지 않아야 한다. |
| CON-006 | 보안이 약한 동작은 기본값이 되어서는 안 된다. legacy 또는 compatibility 예외는 명시적으로 관찰 가능해야 한다. |
| CON-007 | 신규 재사용 dialog/modal 컴포넌트는 `frontend/src/components/dialog` 디렉터리에 작성해야 한다. 기존 `frontend/src/components/Modal` 디렉터리는 legacy 전용으로 유지하며, 새 기능이 이 legacy 모달 패턴에 직접 의존하려면 구현 계획에 사유를 명시해야 한다. |

## 3. 용어

| 용어 | 정의 |
|---|---|
| Workspace | 여러 터미널 탭과 그리드 레이아웃을 묶는 최상위 작업 단위 |
| Tab | Workspace 안의 터미널 세션 표현 단위 |
| Grid Mode | 여러 탭을 React Mosaic 기반 타일 레이아웃으로 동시에 표시하는 모드 |
| Tab Mode | 한 번에 하나의 활성 탭을 표시하는 기본 모드 |
| PTY | pseudo terminal. node-pty로 생성되는 셸 프로세스 입출력 채널 |
| CWD | current working directory. 세션의 현재 작업 디렉터리 |
| TOTP | 시간 기반 일회용 비밀번호. Google Authenticator 호환 |
| Native daemon | PM2 없이 launcher가 app child와 sentinel child를 detached로 실행하는 production 모드 |
| Sentinel | daemon mode에서 app child를 감시하고 제한적으로 재시작하는 watchdog 프로세스 |
| Screen snapshot | 서버 headless terminal이 생성하는 재구독/재연결용 권위적 전체 터미널 화면 복원 payload |
| Screen repair | Grid/workspace layout 변화 후 현재 viewport만 비파괴적으로 보정하는 row patch 기반 화면 교정 흐름. scrollback 재작성, `term.reset()`, full snapshot write, 강제 bottom scroll은 사용할 수 없다. |
| Replay | WebSocket 재구독이나 재연결 후 누락 출력을 전체 스냅샷 또는 큐로 복구하는 흐름. Grid/workspace 화면 교정은 Replay와 분리된 Screen repair로 처리해야 한다. |
| AI TUI | Codex, Claude, Hermes처럼 터미널 UI 안에서 사용자 입력을 기다리는 대화형 AI 앱 |
| SessionExecutionStatus | 서버 세션 실행 상태. 현재 값은 `idle`, `running`이다. |
| WorkspaceTabRuntimeStatus | 프런트엔드 탭 표시 상태. 현재 값은 `idle`, `running`, `disconnected`이다. |
| Dialog | 화면 위에 떠서 특정 작업을 수행하는 재사용 UI window shell. 본 SRS에서는 `frontend/src/components/dialog` 아래의 새 공용 컴포넌트 계층을 의미한다. |
| Modal Dialog | 표시 중 배경의 다른 UI 요소와 상호작용할 수 없고, 명시적 닫기 조작으로만 종료되는 Dialog mode. |
| Modeless Dialog | 배경 UI와 병행 상호작용이 가능한 Dialog mode. 현재 구현 대상은 아니지만 공용 Dialog 인터페이스는 추후 modeless 확장을 막지 않아야 한다. |
| Dialog Geometry | Dialog의 브라우저 viewport 내 `x`, `y`, `width`, `height` 위치와 크기 정보. |
| MessageBox | 공용 Dialog shell을 감싸 제목, 메시지, OK/Cancel 같은 명시적 결정 버튼을 제공하는 확인/알림용 모달 컴포넌트. |
| Command Preset | 사용자가 서버에 저장해 반복 사용할 수 있는 커맨드 라인, 디렉터리 이동, 프롬프트 항목. 각 항목은 `kind`, `label`, `value`, `sortOrder`를 가진다. |
| Command Management Dialog | 상단 도구 모음 메뉴에서 여는 Command Preset 관리용 Modal Dialog. |

## 4. 시스템 기능 요구사항

### 4.1 런타임 및 배포

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-RUN-001 | P0 | 시스템은 HTTPS 서버를 기본 `2002` 포트에서 실행해야 한다. | Health check |
| FR-RUN-002 | P0 | 시스템은 HTTP `2001` 포트 요청을 HTTPS로 리다이렉트해야 한다. | 통합 테스트 |
| FR-RUN-003 | P0 | 개발 모드에서 Vite dev server는 HTTPS 서버 뒤에서 프록시되어야 한다. | 개발 서버 수동 검증 |
| FR-RUN-004 | P0 | production source runtime과 packaged executable은 인자 없이 실행될 때 native daemon mode로 동작해야 한다. | daemon integration test |
| FR-RUN-005 | P0 | `--foreground`와 legacy alias `--forground`는 현재 콘솔에서 foreground mode를 실행해야 한다. | CLI 테스트 |
| FR-RUN-006 | P0 | native daemon mode는 PM2 설치 여부와 무관하게 app child와 sentinel child를 시작해야 한다. | PM2 미설치 smoke |
| FR-RUN-007 | P0 | daemon start는 동일 실행 계약의 기존 daemon이 살아 있으면 idempotent success로 처리해야 한다. | integration test |
| FR-RUN-008 | P0 | daemon start는 다른 포트, 다른 config, 다른 argv hash의 daemon과 충돌하면 stop 선행 요구를 반환해야 한다. | integration test |
| FR-RUN-009 | P0 | daemon readiness는 단순 `/health` 200이 아니라 state와 실행 identity를 검증해야 한다. | readiness test |
| FR-RUN-010 | P0 | packaged `BuilderGate.exe stop` 또는 source stop entry는 실행 중인 native daemon을 PM2 없이 graceful shutdown해야 한다. app child가 이미 종료된 edge case의 flush 증빙 부족은 GAP-008로 추적한다. | stop-client test |
| FR-RUN-011 | P1 | daemon mode stdout/stderr는 runtime 로그 파일에 기록되어야 한다. | log test |
| FR-RUN-012 | P1 | build output은 Windows amd64와 Linux amd64 배포본을 필수 지원해야 하며, 각 배포본은 실행파일, 실행파일의 `stop` subcommand, EXE에 내장된 server runtime, `web/` frontend assets, 외부 셸용 `shell-integration/`, README를 포함해야 한다. 외부 `node.exe`, `server/`, `node_modules/`는 배포하지 않아야 한다. ARM64 배포본은 추가 지원 대상으로 제공할 수 있다. | build output test |
| FR-RUN-013 | P1 | 기존 단일 기본 output인 `dist/bin`은 호환 경로로 유지하되, 대상별 배포본은 `dist/bin/<target>-<package-version>` 구조를 사용해야 한다. `<package-version>`은 루트 `package.json`의 `version` 값이어야 한다. 필수 대상은 `win-amd64`와 `linux-amd64`이고, 추가 ARM64 대상은 `win-arm64`, `linux-arm64`, `macos-arm64`이다. macOS는 ARM64만 지원 대상이며, `macos-arm64` 배포본은 raw 실행파일과 `BuilderGate.app` 번들을 함께 포함해야 한다. | build output test |
| FR-RUN-014 | P0 | release/package build는 기본적으로 로컬 `server/config.json5`를 배포본에 복사하지 않아야 한다. 배포본 루트 `config.json5`는 `auth.password: ""`와 `auth.jwtSecret: ""`를 포함한 bootstrap-ready config여야 하며, 로컬 user config 포함은 명시적 opt-in일 때만 허용해야 한다. 배포본에는 `server/config.json5`가 노출되면 안 된다. | build/workflow test |
| FR-RUN-015 | P0 | GitHub Actions release workflow는 GitHub Release asset 업로드 전에 각 배포본의 `config.json5`가 bootstrap-safe 상태인지 검사하고, `server/config.json5` 노출 또는 non-empty `auth.password`/`auth.jwtSecret`이 있으면 실패해야 한다. | CI workflow test |
| FR-RUN-016 | P0 | packaged executable의 internal app/sentinel child는 `--internal-app`/`--internal-sentinel` argv가 아니라 `BUILDERGATE_INTERNAL_MODE=app|sentinel` 환경 변수로 진입해야 한다. Windows packaged child spawn은 빈 args에서 `Start-Process -ArgumentList @()`를 사용하지 않아야 하며, packaged parent spawn은 `PKG_EXECPATH`를 spawn 순간 neutralize해야 한다. | launcher test/smoke |
| FR-RUN-017 | P0 | packaged first-run smoke는 HTTPS port와 HTTP redirect port를 모두 사전 검사하고, `BUILDERGATE_*`와 `PKG_EXECPATH` 환경 오염을 제거한 상태로 foreground와 daemon mode를 검증해야 한다. smoke는 지정 port를 실제 EXE 실행 인자로 전달하고 `/api/auth/bootstrap-status`가 localhost 기준 `setupRequired: true`, `requesterAllowed: true`를 반환하는지 확인해야 한다. | packaged smoke |

### 4.2 인증과 보안

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-AUTH-001 | P0 | 시스템은 비밀번호 로그인 성공 시 서명된 JWT를 발급해야 한다. | server test |
| FR-AUTH-002 | P0 | 로그아웃은 현재 JWT를 revoke하여 재사용을 막아야 한다. | server test |
| FR-AUTH-003 | P0 | 인증이 필요한 REST API와 WebSocket은 유효한 JWT 없이는 접근할 수 없어야 한다. | API/WS test |
| FR-AUTH-004 | P0 | `auth.password`가 비어 있으면 bootstrap password flow를 제공해야 한다. | server/E2E |
| FR-AUTH-005 | P0 | bootstrap password 설정은 localhost 또는 명시 allowlist IP에서만 허용해야 한다. | server test |
| FR-AUTH-006 | P0 | `auth.password`는 평문 입력 시 자동 암호화되어 저장되어야 하고, TOTP secret은 암호화된 secret 파일로 저장되어야 한다. `auth.jwtSecret`은 빈 값이면 메모리에서 생성되어 재시작 시 기존 세션을 무효화하며, 설정값이 있으면 encrypted/plain legacy 값을 모두 읽을 수 있다. | config test |
| FR-AUTH-007 | P0 | TOTP enabled 상태에서는 비밀번호 검증 후 6자리 TOTP 검증을 요구해야 한다. 단, `auth.localhostPasswordOnly` 또는 `twoFactor.externalOnly`에 의해 명시된 localhost 예외는 이 요구사항보다 우선한다. | auth test |
| FR-AUTH-008 | P0 | TOTP pending auth tempToken은 만료, 최대 시도 횟수, 같은 pending auth 안의 replay 방지를 적용해야 한다. 계정/서비스 단위 TOTP timestep replay 방지는 GAP-011로 추적한다. | auth test |
| FR-AUTH-009 | P0 | TOTP secret이 미등록 또는 손상된 상태에서는 의미 있는 startup/login failure를 제공해야 한다. | auth test |
| FR-AUTH-010 | P1 | `twoFactor.externalOnly`가 true이면 localhost 요청에 한해 2FA를 건너뛰어야 한다. | auth test |
| FR-AUTH-011 | P1 | Settings 페이지는 TOTP QR data URL과 `otpauth://` URI를 표시할 수 있어야 한다. 구조화된 manual key 필드 제공은 현재 활성 UI/API 계약이 아니다. | E2E |
| FR-AUTH-012 | P0 | daemon mode에서 TOTP QR preflight는 parent detach 전에 QR과 manual key를 콘솔에 출력해야 한다. | daemon smoke |
| FR-AUTH-013 | P1 | `auth.localhostPasswordOnly`가 true이면 localhost 요청은 비밀번호 검증 성공 후 2FA를 건너뛰고 JWT를 발급받아야 한다. | auth test |
| FR-AUTH-014 | P0 | `config.json5`가 없으면 시스템은 기본 bootstrap config를 UTF-8 JSON5로 생성하고 `auth.password`를 빈 문자열로 둔 뒤 최초 접속에서 password setup flow를 표시해야 한다. | config/E2E |
| FR-AUTH-015 | P0 | 최초 password setup은 4자 이상 128자 이하의 password만 허용해야 한다. 허용 문자는 영문 대소문자(`A-Z`, `a-z`), 숫자(`0-9`), 특수문자 `!@#$%^&*()_+=/-`로 제한하며, 공백 문자, 한글, 이모지, 기타 특수문자는 거부해야 한다. 유효한 password는 trim 또는 truncate하지 않고 그대로 암호화 저장하고 이후 로그인 검증에 사용해야 한다. | server/E2E |
| FR-AUTH-016 | P0 | 브라우저가 `cws_auth_token` 또는 `cws_auth_expires`를 저장할 때 localStorage quota 오류가 발생하면, 시스템은 `terminal_snapshot_*` 정리 정책을 실행한 뒤 1회 재시도해야 한다. 재시도도 실패하면 `cws_auth_token`과 `cws_auth_expires` partial auth state를 제거하고 오류를 관측 가능하게 전파해야 한다. quota 복구는 unrelated localStorage key를 삭제하지 않아야 한다. | E2E/unit |

### 4.3 세션과 터미널

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-SESS-001 | P0 | 시스템은 Workspace Tab 생성 시 node-pty 셸 세션을 생성해야 한다. | server test |
| FR-SESS-002 | P0 | 셸 타입의 표준 값은 `auto`, `powershell`, `wsl`, `bash`, `zsh`, `sh`, `cmd`이다. `/api/sessions`는 사용 가능한 셸 목록 기준으로 입력을 검증해야 하며, Workspace tab 생성 경로는 현재 알 수 없는 셸 값을 session spawn 단계에서 `auto` 계열로 fallback할 수 있다. | type/API test |
| FR-SESS-003 | P0 | Windows 전용 shell/backend 옵션은 비Windows에서 안전하게 정규화되거나 거부되어야 한다. | server test |
| FR-SESS-004 | P0 | 세션 삭제 시 PTY, 타이머, CWD watcher, WebSocket subscription, replay state를 정리해야 한다. | server test |
| FR-SESS-005 | P0 | 사용자의 터미널 입력은 해당 PTY에 순서대로 전달되어야 한다. | E2E |
| FR-SESS-006 | P0 | resize 요청은 PTY와 headless terminal 상태를 모두 갱신해야 한다. | server/E2E |
| FR-SESS-007 | P0 | 서버는 세션별 screen snapshot을 생성하고 WebSocket 재구독 시 replay handshake를 수행해야 한다. | WS test |
| FR-SESS-008 | P0 | snapshot payload는 설정된 최대 바이트를 초과하지 않도록 truncate해야 한다. | server test |
| FR-SESS-009 | P0 | 서버 세션 실행 상태는 `idle` 또는 `running`으로 전파되어야 한다. 프런트엔드 탭 표시 상태는 세션 종료 또는 복구 실패 시 `disconnected`를 추가로 사용할 수 있다. | WS test |
| FR-SESS-010 | P0 | Codex, Claude, Hermes 등 interactive AI TUI에서 사용자 키보드 입력, local echo, prompt redraw, cursor movement, ticker output, waiting-for-input repaint는 세션을 `running`으로 전환해서는 안 된다. | regression test |
| FR-SESS-011 | P0 | semantic command execution 또는 substantive agent output만 세션을 `running`으로 전환할 수 있다. | regression test |
| FR-SESS-012 | P1 | OSC 133 marker가 감지되면 heuristic idle detection에서 osc133 mode로 승격해야 한다. | server test |
| FR-SESS-013 | P1 | CWD 추적 hook은 셸별로 주입되어 세션의 최신 작업 디렉터리를 추적해야 한다. | server/E2E |
| FR-SESS-014 | P1 | 서버 종료 전 WorkspaceService는 모든 탭의 CWD를 스냅샷으로 저장해야 한다. | shutdown test |
| FR-SESS-015 | P0 | 프런트엔드 terminal snapshot localStorage key는 `terminal_snapshot_*` namespace를 사용하고 전체 저장 budget을 초과하지 않도록 관리해야 한다. budget 초과 또는 quota 복구 시 오래된 snapshot을 LRU 순서로 제거하되 현재 session snapshot은 우선 보존해야 하며, 손상된 snapshot entry는 정리 대상으로 처리해야 한다. snapshot 저장 중 quota 오류가 발생하면 정리 후 1회 재시도해야 한다. | unit/E2E |
| FR-SESS-016 | P0 | 서버와 클라이언트는 full screen snapshot restore와 Screen repair를 구분해야 한다. WebSocket 신규 subscribe, 재구독, 재연결 복원은 full `screen-snapshot` handshake를 사용할 수 있으나, workspace 이동, Grid surface 가시화, Grid tile resize, 수동 Grid repair는 scrollback 전체 snapshot replay를 사용해서는 안 된다. | WS/unit/E2E |
| FR-SESS-017 | P0 | Screen repair payload는 headless terminal의 active viewport row patch와 geometry, active buffer type, cursor metadata, repair token만 포함해야 하며 scrollback, localStorage snapshot, full snapshot write를 포함하지 않아야 한다. payload는 headless pending write drain 이후 생성해야 하고, geometry mismatch, active buffer mismatch 또는 degraded headless state에서는 복구를 묵시 fallback하지 말고 관측 가능한 reject/failure로 종료해야 한다. | server/WS test |

### 4.4 WebSocket

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-WS-001 | P0 | 시스템은 `/ws` 단일 WebSocket 엔드포인트로 터미널 출력, 입력, resize, 구독, workspace event를 처리해야 한다. | WS test |
| FR-WS-002 | P0 | WebSocket 연결은 `/ws?token=<JWT>` query token을 검증해야 한다. 현재 header 또는 subprotocol token 인증은 지원하지 않는다. | WS auth test |
| FR-WS-003 | P0 | 클라이언트는 세션 ID 목록을 subscribe/unsubscribe할 수 있어야 한다. | WS test |
| FR-WS-004 | P0 | 서버는 구독 성공 시 세션 ready 상태, status, cwd를 포함한 `subscribed` payload를 반환해야 한다. | WS test |
| FR-WS-005 | P0 | 서버는 `screen-snapshot` 전송 후 client ack가 올 때까지 해당 세션의 output을 큐잉해야 한다. | replay test |
| FR-WS-006 | P0 | stale ack는 무시되고 새 snapshot/replay 흐름을 깨지 않아야 한다. | replay test |
| FR-WS-007 | P1 | 클라이언트는 연결 끊김 시 지수 백오프로 재연결하고 기존 subscription을 복원해야 한다. | E2E |
| FR-WS-008 | P1 | 클라이언트는 `connected.clientId`를 REST 요청의 `x-client-id`에 포함하여 자기 이벤트 중복 반영을 피해야 한다. | frontend test |
| FR-WS-009 | P1 | Workspace, Tab, Grid 변경 이벤트는 WebSocket으로 다른 클라이언트에 전파되어야 한다. | integration test |
| FR-WS-010 | P1 | ping/pong heartbeat로 죽은 WebSocket 연결을 정리해야 한다. | WS test |
| FR-WS-011 | P0 | `repair-replay`는 legacy 호환 입력으로만 유지할 수 있으며 신규 Grid/workspace repair 호출 경로의 기본값이 되어서는 안 된다. legacy 경로가 남아 있는 동안에도 중복 pending replay, stale ACK, output 순서 깨짐은 허용되지 않는다. | WS replay test |
| FR-WS-012 | P0 | 서버는 `screen-repair` request를 수신하면 해당 WebSocket client가 대상 session을 subscribe 중이고 동일 session repair가 pending이 아니며 headless terminal geometry와 buffer type이 유효할 때만 `screen-repair` response를 전송해야 한다. 클라이언트는 적용 성공 후 `screen-repair:ready` ACK를 보내고, 적용 실패 후 `screen-repair:failed`를 보내야 한다. | WS repair test |
| FR-WS-013 | P0 | `screen-repair` pending 중 발생한 output은 repair ACK, failure, 또는 ACK timeout 경계 뒤에 순서대로 flush되어야 하며, repair pending queue는 기존 replay queue의 tail-trim 방식을 재사용해 output을 묵시 손실시켜서는 안 된다. queue hard cap을 초과하면 repair pending을 관측 가능한 overflow로 abort하고, 이미 queued된 output과 overflow를 유발한 output은 순서를 보존해 일반 output 경로로 전달해야 한다. stale repair token, 중복 pending repair, geometry mismatch, buffer mismatch, payload 생성 실패는 관측 가능한 reject 또는 ignored ACK로 처리해야 한다. 이 처리는 기존 `screen-snapshot` replay pending 상태와 섞여 output 순서를 깨뜨려서는 안 된다. | WS repair test |

### 4.5 Workspace와 Tab

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-WSP-001 | P0 | 최초 실행 또는 workspace state 부재 시 기본 Workspace 1개를 생성해야 한다. | server test |
| FR-WSP-002 | P0 | Workspace는 생성, 이름 변경, 삭제, 순서 변경을 지원해야 한다. | API/E2E |
| FR-WSP-003 | P0 | 마지막 Workspace는 삭제할 수 없어야 한다. | API test |
| FR-WSP-004 | P0 | 서버는 Workspace 수가 `workspace.maxWorkspaces`를 초과하지 않게 해야 한다. 현재 프런트엔드는 기본값 `10`을 UI 제한으로 표시한다. | API test |
| FR-WSP-005 | P0 | Tab은 생성, 이름 변경, 삭제, 순서 변경, restart를 지원해야 한다. | API/E2E |
| FR-WSP-006 | P0 | 서버는 Workspace별 최대 탭 수와 전체 세션 수가 각각 `workspace.maxTabsPerWorkspace`, `workspace.maxTotalSessions`를 초과하지 않게 해야 한다. 현재 프런트엔드는 기본값 `8`, `32`를 UI 제한으로 표시한다. | API test |
| FR-WSP-007 | P0 | Tab 생성 시 8색 팔레트 기반 colorIndex를 순환 할당해야 한다. | UI/API test |
| FR-WSP-008 | P0 | Tab 삭제 시 연결된 PTY 세션도 종료해야 한다. | server test |
| FR-WSP-009 | P0 | 서버 재시작 후 orphan tab은 저장된 CWD로 새 PTY 세션을 생성해 복구해야 한다. | integration test |
| FR-WSP-010 | P1 | activeWorkspaceId는 클라이언트 로컬 상태로 유지하고 서버 canonical state에 저장하지 않아야 한다. | frontend test |
| FR-WSP-011 | P1 | Workspace state는 JSON 파일에 atomic write와 backup을 사용해 저장해야 한다. | server test |

### 4.6 Grid와 레이아웃

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-GRID-001 | P0 | 데스크톱은 Tab Mode와 Grid Mode 전환을 지원해야 한다. | E2E |
| FR-GRID-002 | P0 | 모바일은 항상 Tab Mode로 동작하고 Grid toggle을 노출하지 않아야 한다. | E2E |
| FR-GRID-003 | P0 | Grid Mode는 React Mosaic 기반 tree layout을 사용해야 한다. | frontend test |
| FR-GRID-004 | P0 | Grid tile은 terminal runtime을 안정적으로 mount/unmount하고 session subscription을 보존해야 한다. | E2E |
| FR-GRID-005 | P0 | React Mosaic Grid tile 이동은 drag source 영역 회귀 없이 동작해야 한다. Workspace/Tab reorder의 별도 drag 위험은 GAP-001로 추적한다. | E2E regression |
| FR-GRID-006 | P0 | Equal mode, focus mode, auto mode 등 layout mode는 기존 resize와 DnD 흐름을 깨지 않아야 한다. | E2E regression |
| FR-GRID-007 | P1 | 현재 활성 프런트엔드는 Grid layout을 Workspace별 localStorage key로 저장하고 복원한다. 서버에는 `gridLayouts` 모델과 `PUT /api/workspaces/:id/grid` API가 남아 있으나 현재 Mosaic 화면의 주 저장 경로는 아니다. | frontend test |
| FR-GRID-008 | P1 | 빈 Workspace는 새 터미널 추가 흐름을 제공해야 한다. 빈 Grid cell 추가 흐름은 현재 활성 UI 범위가 아니다. | E2E |
| FR-GRID-009 | P0 | Grid repair는 Grid surface에서만 호출되어야 한다. Grid surface 판정은 terminal host class가 `grid-cell`을 포함하는지로 결정한다. Tab Mode, 모바일 Tab Mode, disconnected tab, hidden terminal, 0-size terminal은 Grid repair를 호출하지 않아야 한다. | E2E regression |
| FR-GRID-010 | P0 | 사용자가 Grid Mode 터미널 영역에서 마우스 휠 버튼을 누르면, 브라우저 `wheel` 스크롤 이벤트가 아니라 `pointerdown`/`mousedown`/`auxclick`의 `button === 1` 입력으로 수동 Grid repair를 호출해야 한다. 이 입력은 기본 동작과 전파를 차단하고 `manual` reason으로 처리해야 한다. | E2E regression |
| FR-GRID-011 | P0 | Grid surface가 보이지 않는 상태에서 보이는 상태로 전환되면 짧은 안정화 지연 후 `workspace` reason의 Grid repair를 1회 호출해야 한다. 단, session status의 `running -> idle` 전환은 본 SRS의 Grid repair 트리거가 아니며 자동 idle repair 요구사항으로 취급하지 않는다. | E2E regression |
| FR-GRID-012 | P0 | Grid repair 실행은 HostSlot layout invalidation, layout 안정화 대기, xterm `FitAddon.fit()`, terminal resize emission, WebSocket `resize`, WebSocket `screen-repair` 순서를 보장해야 한다. 동일 cols/rows resize는 클라이언트에서 전송하지 않아야 하며, 서버 resize no-op은 방어선으로 유지해야 한다. repair 중 입력 gate, cursor 상태, output queue 경계를 깨뜨려서는 안 된다. | E2E/WS repair test |
| FR-GRID-013 | P0 | Equal mode에서 visible Grid container의 가로 길이가 세로 길이보다 길고 target tab 수가 3개 이하이면 새 탭은 가로 방향 단일 행으로 추가되어야 한다. visible Grid container의 세로 길이가 가로 길이보다 길고 target tab 수가 3개 이하이면 새 탭은 세로 방향 단일 열로 추가되어야 한다. 가로와 세로가 같으면 기존 Equal arrangement를 유지하고, 기존 arrangement가 없으면 가로 방향을 기본값으로 사용한다. | frontend unit/E2E |
| FR-GRID-014 | P0 | Equal mode에서 target tab 수가 4개 이상이면 화면 방향과 실제 pane 사용성을 함께 평가해야 한다. 후보는 (1) visible Grid container의 가로 길이가 세로 길이보다 긴 경우에만 허용되는 단일 행 후보(`columns=targetTabCount`, `rows=1`)와 (2) `columns * rows >= targetTabCount`, `columns > 1`, `rows > 1`을 만족하는 격자 후보로 구성된다. visible Grid container가 세로형 또는 정사각형이면 4개 이상 단일 행 후보를 선택하지 않고 격자 후보만 평가한다. 격자 후보 점수는 각 후보의 tile aspect ratio가 터미널 기준 비율에 가까운지, 빈 logical slot 수가 적은지, screen 장축 방향과 columns/rows 관계가 일치하는지를 순서대로 평가해야 한다. 터미널 기준 비율은 xterm 80x24 기본 viewport와 측정 가능한 character cell width/height에서 산출하고, 측정값이 없으면 1.6을 사용한다. | frontend unit/E2E |
| FR-GRID-015 | P0 | Equal mode의 4개 이상 격자 baseline은 다음 연구 결론을 기본값으로 삼아야 한다. 가로형 화면은 4개=`2x2`, 5~6개=`3x2`, 7~8개=`3x3 logical grid`를 목표로 하고, 세로형 화면은 이를 전치해 4개=`2x2`, 5~6개=`2x3`, 7~8개=`3x3 logical grid`를 목표로 한다. 단, 가로형 화면에서는 `singleRowPaneWidth = visibleGridContainerWidth / targetTabCount`와 `baselineGridPaneHeight = visibleGridContainerHeight / baselineGridRows`를 비교하여 `singleRowPaneWidth > baselineGridPaneHeight`이면 단일 행 후보를 선택해야 한다. `singleRowPaneWidth <= baselineGridPaneHeight`이거나 필요한 container 치수를 측정할 수 없으면 격자 baseline을 선택해야 한다. React Mosaic 구현은 visible 빈 cell을 만들지 않아야 하며, logical grid의 빈 slot은 마지막 band의 span 또는 불균등 leaf 분배로 흡수할 수 있다. | frontend unit/E2E |
| FR-GRID-016 | P0 | Grid/workspace Screen repair는 xterm scrollback과 사용자의 scroll position을 보존해야 한다. repair 요청/적용 경로는 `term.reset()`, full snapshot write, `scrollToBottom()`을 호출해서는 안 되며, 사용자가 scrollback을 보고 있거나 IME composition 또는 터미널 입력이 진행 중이면 server request 전 단계에서 defer하고, request 이후 상태가 바뀌면 적용을 reject/failure로 종료해야 한다. | frontend unit/E2E |
| FR-GRID-017 | P0 | workspace 이동 또는 창 크기 변경으로 인해 같은 cols/rows가 반복 계산되는 경우, 클라이언트는 중복 WebSocket `resize`와 `screen-repair` 요청을 suppress해야 한다. suppress 여부는 테스트 가능한 debug 이벤트 또는 WebSocket capture로 관측 가능해야 한다. | frontend unit/E2E |

#### 4.6.1 Equal mode 배치 방향 연구 기록

현재 Workspace별 기본 탭 상한은 8개이므로 Equal mode의 자동 배치 연구 범위는 1~8개 tab이다. 1~3개는 사용자가 화면 장축을 따라 빠르게 비교하는 흐름이 중요하므로, 가로형 화면에서는 좌우 확장, 세로형 화면에서는 상하 확장을 기본으로 한다.

4개 이상부터는 단일 행 또는 단일 열이 한쪽 치수를 과도하게 압축할 수 있다. 특히 터미널은 기본 80 column x 24 row viewport를 기준으로 command line 폭과 TUI row 수가 모두 필요하므로, 장축으로만 계속 추가하는 방식은 일반 화면비에서 4번째 tab부터 읽기성과 입력 안정성을 떨어뜨린다. 다만 ultrawide 또는 높이가 낮은 가로형 화면에서는 4개 이상이라도 격자 행 높이가 더 큰 병목이 될 수 있으므로, 가로형 화면의 단일 행 후보는 별도 사용성 비교를 거쳐 허용한다.

따라서 4개 이상은 다음 기준으로 후보를 평가한다.

| 기준 | 설명 |
|---|---|
| 가로 단일 행 후보 | visible Grid container가 가로형(`width > height`)인 경우에만 `columns=targetTabCount`, `rows=1` 후보를 포함한다. 세로형 또는 정사각형 화면에서는 4개 이상 단일 행 후보를 선택하지 않는다. |
| 단일 행 폭 대 격자 행 높이 | 가로형 화면에서 `visibleGridContainerWidth / targetTabCount`가 baseline grid의 `visibleGridContainerHeight / baselineGridRows`보다 크면 단일 행을 선택한다. 같거나 작으면 격자를 선택한다. |
| 터미널 기준 비율 | xterm 80x24 기본 viewport와 character cell 측정값으로 tile 목표 aspect ratio를 계산한다. 측정 불가 시 1.6을 사용한다. |
| 빈 logical slot 최소화 | `columns * rows - targetTabCount`가 작은 후보를 선호하되, 터미널 기준 비율을 심하게 깨는 후보보다 우선하지 않는다. |
| 장축 정렬 | 가로형 화면에서는 `columns >= rows`, 세로형 화면에서는 `rows >= columns`인 후보를 선호한다. |
| Mosaic 실현성 | React Mosaic tree에서는 visible 빈 cell을 만들지 않고, 마지막 band의 span 또는 leaf 분배로 logical grid를 표현한다. |
| 동률 안정성 | 단일 행 폭과 격자 행 높이가 같거나 container 치수를 측정할 수 없으면 격자 baseline을 선택해 layout 전환 흔들림을 방지한다. |

연구 결론: 격자 baseline으로는 4개 `2x2`, 5~6개 가로형 `3x2`/세로형 `2x3`, 7~8개 `3x3 logical grid`가 안정적이다. 그러나 가로형 화면에서는 4개 이상이라도 단일 행 각 pane의 폭이 baseline grid 각 pane의 높이보다 크면 단일 행이 더 나은 사용성을 제공할 수 있으므로 단일 행을 선택한다. 반대로 단일 행 각 pane의 폭이 baseline grid 각 pane의 높이보다 작거나 같으면, terminal row 수 확보를 위해 격자 baseline을 선택한다. `3x3 logical grid` 구현은 visible 빈 cell 없이 마지막 band를 흡수한다.

### 4.7 파일 관리

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-FILE-001 | P1 | 세션 CWD 기준 디렉터리 목록을 조회할 수 있어야 한다. `targetPath`가 있는 list 요청은 경로 검증을 거쳐야 하며, `targetPath`가 없을 때 session CWD의 blocked path 재검증 누락은 GAP-014로 추적한다. | API test |
| FR-FILE-002 | P1 | 디렉터리 목록은 상위 경로, 디렉터리, 파일 순서로 정렬되어야 한다. | API test |
| FR-FILE-003 | P1 | 파일 읽기는 크기 제한, blocked path, blocked extension 정책을 적용해야 한다. | API test |
| FR-FILE-004 | P1 | copy, move, delete API는 요청 경로 검증을 통과한 요청만 수행해야 한다. mkdir API는 base path와 directory name traversal을 검증해야 하며, 최종 생성 경로의 blocked path 재검증 누락은 GAP-014로 추적한다. | API test |

활성 FileManager/Mdir 화면과 viewer 탭은 OOS-006으로 관리한다. 코드에 남은 viewer 확장자 유틸은 현재 활성 제품 계약이 아니다.

### 4.8 런타임 설정

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-SET-001 | P0 | `GET /api/settings`는 편집 가능 설정값, capability, secret state, excluded section을 반환해야 한다. | API test |
| FR-SET-002 | P0 | `PATCH /api/settings`는 strict schema와 필드별 validation을 통과한 설정만 저장해야 한다. | API test |
| FR-SET-003 | P0 | 설정 저장은 변경 대상 key의 값만 교체하고, 기존 줄 순서, 주석, 후행 쉼표, 변경 대상 밖의 텍스트를 유지해야 한다. 지원하지 않거나 편집 불가한 key는 쓰기 전에 `UNSUPPORTED_SETTING`으로 실패해야 하며, 허용된 patch의 렌더링/검증/쓰기 실패는 `CONFIG_PERSIST_FAILED`로 실패해야 한다. | repository test |
| FR-SET-004 | P0 | 설정 적용 실패 시 runtime state는 이전 설정으로 롤백되어야 한다. config write는 사전 백업을 만들고 실패를 명확히 반환해야 하며, 현재 구현은 write 실패 시 백업 자동 복원 또는 atomic rename까지 보장하지 않는다. | server test |
| FR-SET-005 | P0 | password 변경은 current password, new password, confirm password를 검증해야 하며, new password와 confirm password에는 FR-AUTH-015와 동일한 길이/문자 정책을 적용해야 한다. | server test |
| FR-SET-006 | P1 | `twoFactor.enabled`, `issuer`, `accountName` 변경은 런타임 TOTP service 재구성 대상이다. `twoFactor.externalOnly` 변경은 TOTP secret/runtime 재생성 없이 다음 로그인 우회 정책에 반영되어야 한다. | server/E2E |
| FR-SET-007 | P1 | PTY shell/backend capability는 플랫폼과 probe 결과에 따라 available/options/reason으로 노출되어야 한다. | server test |
| FR-SET-008 | P1 | Settings UI는 dirty state에서 Back 시 discard 확인 모달을 표시해야 한다. | E2E |

### 4.9 Dialog 인프라와 모달 컴포넌트 규칙

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-DLG-001 | P0 | 신규 재사용 dialog/modal 컴포넌트는 `frontend/src/components/dialog` 디렉터리에 작성해야 한다. 디렉터리명은 소문자 `dialog`를 사용하고, 새 기능 전용 모달도 공용 shell을 조합하는 방식으로 구현해야 한다. | code review |
| FR-DLG-002 | P0 | `frontend/src/components/dialog`는 최소한 공용 window shell 컴포넌트, MessageBox wrapper, 타입 정의, geometry 저장/복원 유틸, barrel export를 제공해야 한다. 계획 기준 파일은 `WindowDialog.tsx`, `WindowDialog.css`, `MessageBox.tsx`, `MessageBox.css`, `dialogGeometry.ts`, `types.ts`, `index.ts`이며, 실제 파일명 변경 시 구현 계획에 동등한 역할을 명시해야 한다. | code review/frontend build |
| FR-DLG-003 | P0 | 공용 Dialog shell은 `dialogId`, `title`, `mode`, `defaultRect`, `minSize`, `onClose`, `children`을 포함하는 명시적 인터페이스를 가져야 한다. Feature-specific business logic, API 호출, form state는 shell이 직접 소유하지 않고 feature 컴포넌트 또는 hook에 위임해야 한다. | type/review |
| FR-DLG-004 | P0 | `mode="modal"` Dialog가 표시된 동안 사용자는 배경의 다른 UI 요소를 선택하거나 조작할 수 없어야 한다. Overlay click과 `Escape` key는 modal을 닫지 않아야 하며, 닫기는 title bar의 `X` 버튼 또는 MessageBox의 `Cancel`/`OK`처럼 컴포넌트가 명시적으로 제공하는 닫기/결정 조작으로만 수행해야 한다. | E2E |
| FR-DLG-005 | P0 | Dialog는 title bar를 drag handle로 사용해 브라우저 viewport 안에서 이동할 수 있어야 한다. 이동 중과 저장된 위치 복원 시 Dialog의 어떤 부분도 viewport 밖으로 벗어나면 안 되며, viewport 변경 후에도 geometry는 clamp되어야 한다. | E2E |
| FR-DLG-006 | P0 | Dialog는 크기 조절을 지원해야 하며 최소 크기를 강제해야 한다. 최대화, 최소화, 별도 taskbar dock 동작은 지원하지 않는다. 크기 조절 결과도 viewport 안에 clamp되어야 한다. | E2E |
| FR-DLG-007 | P0 | 각 Dialog는 안정적인 고유 `dialogId`를 가져야 한다. Dialog가 닫힐 때 마지막 `x`, `y`, `width`, `height`를 브라우저 localStorage에 저장하고, 다시 열 때 같은 `dialogId`의 geometry를 복원해야 한다. 손상되었거나 현재 viewport에 맞지 않는 저장값은 안전한 기본값으로 대체하거나 clamp해야 한다. | unit/E2E |
| FR-DLG-008 | P1 | 공용 Dialog 인터페이스는 추후 `mode="modeless"` 구현을 수용할 수 있어야 한다. 단, 현재 구현 범위에서 modal은 modal답게 동작해야 하며 modeless 준비 코드가 modal overlay, focus, 배경 차단 계약을 약화해서는 안 된다. | review/E2E |
| FR-DLG-009 | P1 | Drag/resize 구현에는 React 19와 호환되고 controlled position/size, title-bar drag handle, resize stop callback, bounds 또는 동등한 viewport 제한을 지원하는 검증된 라이브러리를 사용할 수 있다. 라이브러리 선정 사유와 대체 불가 구현 범위는 구현 계획에 기록해야 한다. | dependency review |
| FR-DLG-010 | P1 | 기존 `ContextMenu`는 context menu 용도로 계속 재사용한다. Dialog shell은 context menu를 대체하지 않으며, toolbar dropdown, 우클릭 메뉴, long-press 메뉴는 기존 `ContextMenu` 계약을 우선 검토해야 한다. | code review |
| FR-DLG-011 | P0 | `frontend/src/components/dialog`는 공용 `MessageBox` 컴포넌트를 제공해야 한다. `MessageBox`는 기존 `WindowDialog`를 감싸는 wrapper이며 `dialogId`, `title`, `message`, `okLabel`, `cancelLabel`, `okVariant`, `busy`, `error`, `onOk`, `onCancel`에 준하는 명시적 인터페이스를 가져야 한다. Feature-specific 삭제/저장 API 호출 자체는 MessageBox가 직접 소유하지 않고 호출자가 callback으로 제공해야 한다. | type/review |
| FR-DLG-012 | P0 | MessageBox는 title과 message를 화면에 표시하고 하단에 `Cancel`, `OK` 두 decision button을 제공해야 한다. destructive confirmation에서 기본 focus는 `Cancel`에 두어야 하며, `OK`는 danger variant로 표시할 수 있어야 한다. 삭제 확인 MessageBox는 title bar `X`, overlay click, Escape로 닫히면 안 되고 `Cancel` 또는 `OK` 조작으로만 종료되어야 한다. | component/E2E |
| FR-DLG-013 | P0 | 기존 modal Dialog 위에 MessageBox가 열릴 수 있어야 한다. 이때 MessageBox가 topmost modal이 되어 keyboard focus trap과 pointer event를 소유하고, 아래에 있는 Dialog와 배경 UI는 MessageBox가 닫힐 때까지 선택되거나 조작되어서는 안 된다. 중첩 modal 처리 때문에 기존 modal의 focus trap, inert 복원, z-index, geometry 저장 계약이 깨져서는 안 된다. | component/E2E |
| FR-DLG-014 | P1 | MessageBox는 접근성 목적상 `role="alertdialog"` 또는 동등한 ARIA 역할을 사용할 수 있어야 하며 title과 message가 각각 accessible name/description으로 연결되어야 한다. 오류가 발생해 MessageBox 내부에 error를 표시하는 경우 `role="alert"` 또는 동등한 live feedback으로 관측 가능해야 한다. | ARIA/E2E |

#### 4.9.1 계획된 프런트엔드 구조

```text
frontend/src/components/dialog/
  WindowDialog.tsx       # 공용 draggable/resizable dialog shell
  WindowDialog.css       # dialog shell, overlay, title bar, resize affordance 스타일
  MessageBox.tsx         # WindowDialog wrapper 기반 확인/알림 모달
  MessageBox.css         # MessageBox body, message, footer, OK/Cancel button 스타일
  dialogGeometry.ts      # localStorage read/write, validation, viewport clamp 유틸
  types.ts               # DialogMode, DialogRect, WindowDialogProps, MessageBoxProps 등 공용 타입
  index.ts               # public exports
```

이 디렉터리는 앞으로 많은 기능에서 재사용하는 dialog 계층이다. 특정 기능의 내용 컴포넌트는 해당 기능 디렉터리에 둘 수 있으나, window shell, MessageBox, modal/modeless mode, 위치/크기 영속화, viewport clamp, overlay 차단 규칙은 이 공용 계층에 집중해야 한다.

### 4.10 명령줄 관리

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| FR-CMD-001 | P0 | 데스크톱 상단 네비게이션 오른쪽 action group은 Tab/Grid mode toggle, hammer icon 도구 버튼, Settings, Logout 순서로 표시해야 한다. 도구 버튼은 텍스트 `Tools`를 노출하지 않고 Settings icon button과 동일한 폭을 사용해야 하며, 클릭 시 기존 ContextMenu 계약을 따르는 도구 메뉴를 버튼 아래에 표시해야 한다. 메뉴에는 `명령줄 관리` 항목이 있어야 한다. | UI/E2E |
| FR-CMD-002 | P0 | `명령줄 관리`를 선택하면 공용 `WindowDialog` 기반 Modal Dialog가 열려야 한다. 이 Dialog는 overlay click 또는 Escape로 닫히지 않고 X 버튼으로만 닫히며, 표시 중 배경 UI 조작을 차단하고, `command-preset-manager`처럼 안정적인 `dialogId`로 마지막 위치와 크기를 localStorage에 저장/복원해야 한다. | Dialog/E2E |
| FR-CMD-003 | P0 | Dialog는 `커맨드 라인`, `디렉토리`, `프롬프트` 세 탭을 제공해야 한다. 마지막으로 선택한 탭은 브라우저 localStorage에 저장되어 Dialog를 다시 열 때 복원되어야 한다. | unit/E2E |
| FR-CMD-004 | P0 | 각 탭의 등록 폼은 `라벨`과 항목 값을 입력받아 서버에 저장해야 한다. 커맨드 라인과 디렉토리 값은 한 줄 입력을 사용하고, 프롬프트 값은 여러 줄 textarea를 사용해야 한다. 프롬프트 등록 폼의 값 placeholder는 `프롬프트`여야 하며, 라벨 입력은 textarea 상단과 같은 높이에 배치되어야 한다. | UI/E2E |
| FR-CMD-005 | P0 | Command Preset은 서버에 영속 저장되어야 하며 `command`, `directory`, `prompt` kind별 CRUD와 순서 변경을 지원해야 한다. 저장 모델은 라벨, 값, kind별 sort order, 생성/수정 시각을 보존해야 하고 동시 mutation은 순서가 깨지지 않도록 직렬화해야 한다. | server test |
| FR-CMD-006 | P0 | 각 preset 항목은 현재 위치에서 inline 수정되어야 한다. 수정 모드에서는 라벨 텍스트가 라벨 입력창으로, 값 표시가 한 줄 입력 또는 textarea로 바뀌어야 하며 저장/취소 조작은 같은 항목 안에 있어야 한다. 상단 등록 폼은 신규 등록 전용이어야 하고, 탭 전환 시 미저장 inline 수정 draft는 취소되어야 한다. | UI/E2E |
| FR-CMD-007 | P0 | 복사, 실행, 수정, 삭제, 위, 아래, 저장, 취소 조작은 icon-only 버튼으로 제공해야 하며 같은 action group 안에서 동일한 폭과 높이를 가져야 한다. 모든 icon-only 버튼은 접근 가능한 이름을 가져야 한다. | ARIA/E2E |
| FR-CMD-008 | P0 | 복사 버튼은 preset의 원본 값을 clipboard에 복사하고 화면 하단 toast로 복사 완료를 알려야 한다. 커맨드 라인 실행은 현재 선택된 세션/터미널에 command 값과 Enter를 전송해야 한다. 디렉토리 실행은 현재 shell에 맞는 `cd`/`Set-Location` 형태와 Enter를 전송해야 한다. 프롬프트 preset은 실행 버튼을 표시해서는 안 되며, prompt 값에 대해 Enter 또는 CR을 터미널로 전송하는 action을 제공해서는 안 된다. | unit/E2E |
| FR-CMD-009 | P0 | 커맨드 라인, 디렉토리, 프롬프트 preset의 삭제 버튼을 누르면 서버 삭제 요청 전에 공용 MessageBox 기반 삭제 확인 모달을 표시해야 한다. MessageBox는 제목과 대상 preset 라벨을 포함한 메시지를 표시하고 `Cancel`, `OK` 버튼을 제공해야 한다. `Cancel`은 어떤 서버 mutation도 수행하지 않고 확인 모달만 닫아야 하며, `OK`는 해당 preset 삭제를 실행해야 한다. 삭제 실패 시 확인 모달은 닫히지 않고 오류를 표시해야 한다. | UI/E2E |

## 5. 데이터 요구사항

### 5.1 Workspace state

| 필드 | 요구사항 |
|---|---|
| `version` | 현재 `1`이어야 한다. |
| `lastUpdated` | ISO timestamp여야 한다. |
| `state.workspaces` | Workspace 배열. 최소 1개 유지. |
| `state.tabs` | WorkspaceTab 배열. 각 tab은 유효한 `workspaceId`를 가져야 한다. |
| `state.gridLayouts` | Workspace별 mosaicTree를 저장할 수 있는 서버 모델이다. 현재 활성 프런트엔드는 Mosaic layout을 localStorage에 저장하므로 이 필드는 호환/잔존 모델로 취급한다. |

Workspace 파일은 기본 `./data/workspaces.json`에 UTF-8 JSON으로 저장해야 하며, 저장 중 손상 위험을 줄이기 위해 임시 파일, 백업 파일, atomic rename을 사용해야 한다.

### 5.2 Daemon state

| 필드 | 요구사항 |
|---|---|
| `version` | 문자열 `"1"`이어야 한다. |
| `mode` | daemon state 파일의 active daemon 상태는 `daemon`이어야 한다. `foreground`는 CLI 실행 모드로 존재하지만 active daemon state 대상이 아니다. |
| `status` | `starting`, `running`, `stopping`, `stopped`, `fatal` 중 하나여야 한다. |
| `appPid`, `sentinelPid` | daemon `running`과 `stopping` 상태에서는 양수 PID여야 한다. foreground mode는 sentinel PID를 만들지 않는다. |
| `shutdownToken` | 최소 32 random bytes 기반 base64url token이어야 한다. |
| `argvHash` | 실행 계약 충돌 검사용 hash여야 한다. |
| `fatalStage`, `fatalReason` | fatal 상태의 원인과 단계가 추적 가능해야 한다. |
| `fatalStage` 허용값 | 현재 daemon state 코드는 `preflight`, `totp-preflight`, `app-startup`, `sentinel-runtime`, `shutdown`, `unknown`을 허용한다. |

daemon state는 owner-only 권한을 적용 가능한 플랫폼에서 `0600`으로 저장해야 한다.

### 5.3 Config

설정 파일은 JSON5 형식을 사용한다. 핵심 top-level section은 다음과 같다.

- `server`
- `pty`
- `session`
- `ssl`
- `security.cors`
- `logging`
- `auth`
- `twoFactor`
- `bootstrap`
- `bruteForce`
- `fileManager`
- `workspace`

`server.port`, `ssl.*`, `logging.*`, `auth.jwtSecret`, `auth.maxDurationMs`, `fileManager.maxCodeFileSize`, `bruteForce.*`는 일반 Settings PATCH의 편집 대상이 아니다.

`config.json5`가 존재하지 않는 최초 실행에서는 내장 bootstrap template을 생성해야 한다. 이 template은 `auth.password: ""` 상태로 저장되어야 하며, 브라우저 최초 접속 시 로그인 폼 대신 초기 관리자 비밀번호 설정 화면을 제공해야 한다.

초기 관리자 비밀번호는 4자 이상 128자 이하이어야 한다. 허용 문자는 영문 대소문자(`A-Z`, `a-z`), 숫자(`0-9`), 특수문자 `!@#$%^&*()_+=/-`로 제한한다. 공백 문자, 한글, 이모지, 기타 특수문자는 사용할 수 없다. 유효한 비밀번호는 trim 또는 truncate하지 않고 그대로 암호화 저장되며, 같은 문자열로만 로그인되어야 한다. Settings의 password 변경도 동일한 정책을 적용해야 한다.

release/package build에서 생성되는 packaged runtime의 `config.json5`는 fresh extraction first-run을 위해 bootstrap-ready 상태여야 한다. 기본 build는 source runtime의 로컬 `server/config.json5`를 복사하지 않고, `auth.password: ""`, `auth.jwtSecret: ""`인 루트 `config.json5`를 생성해야 한다. 로컬 user config를 배포본에 포함하는 동작은 명시적 opt-in이어야 하며, GitHub Release asset은 이 opt-in을 사용하지 않아야 한다.

fresh extraction first-run 검증에서는 기존 daemon, 기존 추출 폴더, `BUILDERGATE_CONFIG_PATH`/`BUILDERGATE_ROOT` 등 환경 변수 override를 분리해야 한다. 이러한 기존 상태나 환경 변수 override가 있으면 release asset 자체가 bootstrap-ready여도 `/api/auth/bootstrap-status` 결과가 달라질 수 있다.

### 5.4 Browser localStorage

| Key namespace | 요구사항 |
|---|---|
| `cws_auth_token` | JWT access token 저장 key다. quota recovery 중 partial write 실패가 남으면 제거해야 한다. |
| `cws_auth_expires` | JWT 만료 시각 저장 key다. token 저장과 하나의 auth state로 취급하며 partial write 실패가 남으면 제거해야 한다. |
| `terminal_snapshot_*` | 터미널 화면 복구용 snapshot cache다. auth token quota recovery와 snapshot save retry에서만 정리 대상으로 삼아야 하며, 오래된 entry부터 제거하고 현재 session snapshot은 우선 보존해야 한다. |
| `buildergate.dialog.<dialogId>.geometry` | 공용 Dialog geometry 저장 key다. 값은 JSON object `{ x, y, width, height }` 형태여야 하며, 브라우저별 UI preference로만 취급한다. 서버 canonical state 또는 보안 상태로 취급하지 않는다. |
| `buildergate.commandPresetManager.activeTab` | 명령줄 관리 Dialog에서 마지막으로 선택한 탭을 저장하는 key다. 허용값은 `command`, `directory`, `prompt`이며 브라우저별 UI preference로만 취급한다. |

`terminal_snapshot_*` 저장소는 브라우저 localStorage 전체 quota를 독점하지 않도록 aggregate budget을 가져야 한다. 손상된 JSON entry는 LRU 판단에 앞서 제거 가능한 entry로 취급한다.

Dialog geometry 저장소는 항목별 독립 key를 사용해야 하며, 손상된 JSON, 숫자가 아닌 값, 음수 크기, 현재 viewport와 맞지 않는 값은 복원 시 무시하거나 clamp해야 한다. Dialog geometry quota 오류는 사용자 작업을 실패시키지 않되, 오류는 debug log 또는 테스트 가능한 fallback 경로로 관측 가능해야 한다.

### 5.5 Command preset state

Command Preset 파일은 기본 `./data/command-presets.json`에 UTF-8 JSON으로 저장해야 한다. runtime data 파일과 `.bak`, `.tmp` 파일은 배포 source contract가 아니라 실행 상태로 취급한다.

| 필드 | 요구사항 |
|---|---|
| `version` | 현재 `1`이어야 한다. |
| `lastUpdated` | ISO timestamp여야 한다. |
| `presets` | Command Preset 배열이어야 하며 kind별 `sortOrder` 오름차순으로 정렬 가능해야 한다. |
| `id` | 서버가 생성하는 안정적인 문자열 ID여야 한다. |
| `kind` | `command`, `directory`, `prompt` 중 하나여야 한다. |
| `label` | trim 후 1자 이상 80자 이하여야 한다. |
| `value` | trim 후 비어 있지 않아야 하며 12000자를 초과하거나 NUL 문자를 포함해서는 안 된다. 원본 줄바꿈은 보존해야 한다. |
| `sortOrder` | 같은 kind 안에서 0부터 재색인 가능한 정수 순서여야 한다. |
| `createdAt`, `updatedAt` | ISO timestamp여야 한다. |

Command Preset 저장은 임시 파일, 백업 파일, rename을 사용해 손상 위험을 낮춰야 한다. 기본 파일 load가 실패하면 `.bak` 복구를 시도하고, 백업도 실패하면 관측 가능한 warning 후 빈 목록으로 시작할 수 있다.

### 5.6 WebSocket message model

Client to server message는 다음 유형을 포함해야 한다.

- `subscribe`
- `unsubscribe`
- `screen-snapshot:ready`
- `screen-repair:ready`
- `screen-repair:failed`
- `input`
- `screen-repair`
- `repair-replay` (legacy compatibility only)
- `resize`
- `ping`

Server to client message는 다음 유형을 포함해야 한다.

- `connected`
- `subscribed`
- `screen-snapshot`
- `screen-repair`
- `screen-repair:rejected`
- `output`
- `status`
- `session:ready`
- `cwd`
- `session:error` (현재 타입 예약값이며 일반 오류 송신 경로는 제한적이다)
- `session:exited`
- `workspace:*`
- `tab:*`
- `grid:updated`
- `pong`

## 6. 외부 인터페이스 요구사항

### 6.1 REST API

#### 6.1.1 Public API

| Method | Path | 요구사항 |
|---|---|---|
| GET | `/health` | 인증 없이 서버 상태를 반환해야 한다. |
| GET | `/api/auth/bootstrap-status` | 최초 password setup 필요 여부와 requester 허용 여부를 반환해야 한다. |
| POST | `/api/auth/bootstrap-password` | 최초 password를 설정하고 JWT를 발급해야 한다. |
| POST | `/api/auth/login` | password를 검증하고 JWT 또는 TOTP tempToken을 반환해야 한다. |
| POST | `/api/auth/verify` | TOTP tempToken과 OTP code를 검증해야 한다. |

#### 6.1.2 Protected API

| Method | Path | 요구사항 |
|---|---|---|
| POST | `/api/auth/logout` | JWT를 revoke해야 한다. |
| POST | `/api/auth/refresh` | JWT를 refresh해야 한다. |
| GET | `/api/auth/status` | 인증 상태를 반환해야 한다. |
| GET | `/api/auth/totp-qr` | TOTP QR data URL과 setup 정보를 반환해야 한다. |
| GET | `/api/settings` | editable settings snapshot을 반환해야 한다. |
| PATCH | `/api/settings` | 설정 patch를 검증, 저장, 적용해야 한다. |
| GET | `/api/command-presets` | 인증된 사용자의 전체 Command Preset 목록을 kind와 sort order 기준으로 반환해야 한다. |
| POST | `/api/command-presets` | `{ kind, label, value }` 요청을 검증하고 Command Preset을 생성해야 한다. |
| PATCH | `/api/command-presets/:id` | 기존 Command Preset의 `label` 또는 `value`를 검증 후 갱신해야 한다. |
| DELETE | `/api/command-presets/:id` | Command Preset을 삭제하고 같은 kind의 sort order를 재색인해야 한다. |
| PUT | `/api/command-presets/order` | `{ kind, presetIds }` 요청으로 해당 kind의 모든 preset ID를 포함한 순서를 저장해야 하며, 누락/중복/다른 kind ID는 거부해야 한다. |
| GET | `/api/sessions` | 세션 목록을 반환해야 한다. |
| POST | `/api/sessions` | 새 세션을 생성해야 한다. |
| GET | `/api/sessions/shells` | 사용 가능한 shell 목록을 반환해야 한다. |
| GET | `/api/sessions/:id` | 단일 세션 정보를 반환해야 한다. |
| PATCH | `/api/sessions/:id` | 세션 이름 또는 정렬 정보를 갱신해야 한다. |
| DELETE | `/api/sessions/:id` | 세션을 종료하고 삭제해야 한다. |
| POST | `/api/sessions/:id/reorder` | `{ direction: "up" | "down" }` 요청으로 legacy session 목록 순서를 변경해야 하며, 성공 시 `204`를 반환해야 한다. |
| GET | `/api/sessions/:id/cwd` | 세션 CWD를 반환해야 한다. |
| GET | `/api/sessions/:id/files` | 디렉터리 목록을 반환해야 한다. |
| GET | `/api/sessions/:id/files/read` | 파일 내용을 반환해야 한다. |
| POST | `/api/sessions/:id/files/copy` | 파일 또는 디렉터리를 복사해야 한다. |
| POST | `/api/sessions/:id/files/move` | 파일 또는 디렉터리를 이동해야 한다. |
| DELETE | `/api/sessions/:id/files` | 파일 또는 디렉터리를 삭제해야 한다. |
| POST | `/api/sessions/:id/files/mkdir` | 디렉터리를 생성해야 한다. |
| GET | `/api/sessions/debug-capture/:id` | localhost protected debug capture 상태와 server/replay event 목록을 반환해야 한다. |
| POST | `/api/sessions/debug-capture/:id/enable` | localhost protected debug capture를 활성화하고 성공 시 `204`를 반환해야 한다. |
| DELETE | `/api/sessions/debug-capture/:id` | localhost protected debug capture와 replay event를 비활성화/삭제하고 성공 시 `204`를 반환해야 한다. |
| GET | `/api/workspaces` | 전체 Workspace state를 반환해야 한다. |
| POST | `/api/workspaces` | Workspace를 생성해야 한다. |
| PUT | `/api/workspaces/order` | Workspace 순서를 저장해야 한다. |
| PATCH | `/api/workspaces/:id` | Workspace 이름, viewMode, activeTabId를 갱신해야 한다. |
| DELETE | `/api/workspaces/:id` | Workspace와 소속 세션을 삭제해야 한다. |
| POST | `/api/workspaces/:id/tabs` | Workspace에 Tab과 PTY 세션을 추가해야 한다. |
| PUT | `/api/workspaces/:id/tab-order` | Tab 순서를 저장해야 한다. |
| PATCH | `/api/workspaces/:wid/tabs/:tid` | Tab 이름을 갱신해야 한다. |
| DELETE | `/api/workspaces/:wid/tabs/:tid` | Tab과 연결 세션을 삭제해야 한다. |
| POST | `/api/workspaces/:wid/tabs/:tid/restart` | Tab의 PTY 세션을 재생성해야 한다. |
| PUT | `/api/workspaces/:id/grid` | Workspace grid layout을 서버 state에 저장하는 호환 API다. 현재 활성 프런트엔드의 Mosaic layout 주 저장 경로는 localStorage이다. |
| GET | `/api/sessions/telemetry` | 세션과 WebSocket 관찰성 snapshot을 반환해야 한다. |

### 6.2 Internal API

| Method | Path | 요구사항 |
|---|---|---|
| POST | `/api/internal/shutdown` | localhost-only, valid shutdown token 조건에서 graceful shutdown을 수행해야 한다. |

Internal shutdown API는 외부 요청, 누락 token, 잘못된 token을 거부해야 한다.

### 6.3 CLI

| 명령 또는 옵션 | 요구사항 |
|---|---|
| 무인자 실행 | 기본 daemon mode로 실행해야 한다. |
| `--foreground` | foreground mode로 실행해야 한다. |
| `--forground` | legacy alias로 `--foreground`와 동일해야 한다. |
| `-p`, `--port` | HTTPS port를 1024에서 65535 사이 정수로 override해야 한다. |
| `--reset-password` | app child spawn 전에 resolved config의 auth password를 비워야 한다. |
| `--bootstrap-allow-ip` | bootstrap 허용 IP를 app child 환경에 전달하되 영구 config에는 저장하지 않아야 한다. |
| `--help` | mode, stop command, config policy, dist/bin 정보를 출력해야 한다. |
| Stop utility | state를 읽고 sentinel과 app을 안전하게 중지해야 한다. |

## 7. 비기능 요구사항

### 7.1 보안

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| NFR-SEC-001 | P0 | 모든 앱 트래픽은 HTTPS 또는 WSS를 사용해야 한다. | inspection/test |
| NFR-SEC-002 | P0 | password와 TOTP secret은 암호화 저장되어야 한다. JWT secret은 빈 값일 때 안전한 난수로 메모리 생성되어 재시작 시 세션을 무효화하며, 설정값이 있을 때는 encrypted/plain legacy 값을 모두 읽을 수 있다. | security test |
| NFR-SEC-003 | P0 | 비밀번호 비교는 timing-safe 방식이어야 한다. | unit test |
| NFR-SEC-004 | P0 | 파일 API는 요청 경로 검증에서 path traversal을 차단해야 한다. blocked path는 read/list `targetPath`, copy/move/delete 요청 경로, mkdir base path에 적용된다. session CWD list와 mkdir 최종 경로의 blocked path 적용 누락은 GAP-014로 추적한다. blocked extension은 현재 read/view 경로에 적용된다. | unit test |
| NFR-SEC-005 | P0 | Settings PATCH와 런타임 설정 저장 경로는 CORS credentials와 wildcard origin 조합을 거부해야 한다. config 파일 startup load 단계의 동일 검증 누락은 GAP-010으로 추적한다. | unit test |
| NFR-SEC-006 | P0 | shutdown token은 충분한 entropy를 가져야 하며 로그에 평문 노출되어서는 안 된다. | daemon test |

### 7.2 신뢰성

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| NFR-REL-001 | P0 | 서버 재시작 후 Workspace, Tab, lastCwd는 저장된 workspace JSON과 CWD snapshot을 기준으로 복구되어야 한다. Grid layout의 현재 활성 프런트엔드 저장소는 localStorage이다. | integration test |
| NFR-REL-002 | P0 | WebSocket 재연결과 세션 재구독은 replay handshake 후 screen snapshot, queued output, degraded output 중 하나를 전송해야 하며, 복구 불가 상태는 명시 metadata로 알려야 한다. | replay test |
| NFR-REL-003 | P0 | daemon sentinel은 restart storm을 제한하고 fatal 상태를 기록해야 한다. | sentinel test |
| NFR-REL-004 | P1 | Workspace state와 daemon state 저장은 atomic write를 사용해야 한다. Settings config write는 현재 백업 후 직접 write 방식이며 GAP-012로 hardening을 추적한다. | unit test |
| NFR-REL-005 | P1 | graceful shutdown은 CWD와 workspace state를 flush해야 한다. | shutdown test |

### 7.3 성능

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| NFR-PERF-001 | P1 | 터미널 output routing은 8개 활성 탭과 기본 snapshot 크기 설정에서 입력 echo와 resize replay가 기능적으로 누락되지 않아야 한다. 정량 latency 목표는 별도 성능 계획에서 정의한다. | E2E/perf |
| NFR-PERF-002 | P1 | screen snapshot은 maxSnapshotBytes 설정을 준수해야 한다. | unit test |
| NFR-PERF-003 | P1 | Workspace state 저장은 `workspace.flushDebounceMs` 설정값을 기준으로 연속 save 요청을 하나의 delayed flush로 병합해야 한다. | unit test |
| NFR-PERF-004 | P2 | 파일 목록은 maxDirectoryEntries 제한을 적용해야 한다. | unit test |

### 7.4 사용성 및 접근성

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| NFR-UX-001 | P1 | 폭 900px 이상에서는 Workspace sidebar, tab bar, terminal viewport가 페이지 가로 스크롤 없이 표시되어야 하고, 폭 900px 미만에서는 Grid toggle 없이 활성 terminal과 tab 전환 흐름이 유지되어야 한다. | E2E |
| NFR-UX-002 | P1 | terminal 입력은 keyboard focus를 제공해야 하고, Workspace/Tab 추가·닫기와 선택 흐름은 pointer 조작을 제공해야 한다. Workspace/Tab 선택 항목, context menu item, icon-only 버튼의 완전한 keyboard/ARIA 보강은 GAP-015로 추적한다. | E2E |
| NFR-UX-003 | P1 | Settings 변경 저장 후 UI는 API가 반환한 `applySummary.immediate`, `new_logins`, `new_sessions`, `warnings`를 구분해 표시해야 하며, dirty 상태에서 Back 시 discard 확인 모달을 표시해야 한다. | E2E |
| NFR-UX-004 | P2 | `prefers-reduced-motion: reduce` 환경에서는 선택적 transition/animation을 비활성화하거나 0.01s 이하로 줄여야 한다. 현재 CSS 적용 누락은 GAP-013으로 추적한다. | CSS inspection |
| NFR-UX-005 | P1 | 신규 Dialog shell은 접근 가능한 이름을 제공해야 하며, modal mode에서는 focus가 Dialog 내부 작업 흐름에서 벗어나 배경 UI를 조작하는 결과를 만들면 안 된다. Icon-only close button은 명확한 accessible name을 가져야 한다. | E2E/ARIA inspection |

### 7.5 유지보수성

| ID | 우선순위 | 요구사항 | 검증 |
|---|---|---|---|
| NFR-MAINT-001 | P0 | adapter, route, context layer는 복잡한 비즈니스 로직을 직접 소유하지 않고 service/domain에 위임해야 한다. | review |
| NFR-MAINT-002 | P0 | 새 helper나 service 추가 전 기존 구현을 검색하고 재사용 가능성을 확인해야 한다. | review |
| NFR-MAINT-003 | P0 | 버그 수정은 재현 케이스, 성공 케이스, 경계 케이스 테스트를 포함해야 한다. | test review |
| NFR-MAINT-004 | P0 | 모든 관련 테스트는 작업 완료 시점에 재실행해야 한다. | final verification |
| NFR-MAINT-005 | P0 | 신규 modal/dialog 요구사항은 공용 `frontend/src/components/dialog` 계층을 우선 사용해야 하며, 각 feature 컴포넌트는 dialog window shell, geometry persistence, viewport clamp 로직을 복제해서는 안 된다. | review |

## 8. 수용 기준

| ID | 기준 |
|---|---|
| AC-001 | `curl -k https://localhost:2002/health`가 정상 응답을 반환한다. |
| AC-002 | `http://localhost:2001` 접근은 HTTPS로 리다이렉트된다. |
| AC-003 | 로그인, TOTP enabled login, logout, refresh가 요구사항대로 동작한다. |
| AC-004 | 최초 password bootstrap은 localhost 또는 허용 IP에서만 가능하다. |
| AC-004A | `config.json5` 부재 최초 실행은 bootstrap config를 생성하고 초기 password setup 화면을 표시한다. |
| AC-004B | 최초 password setup과 Settings password 변경은 4자 미만, 128자 초과, 공백 문자, 한글, 이모지, 허용 목록 밖 특수문자를 거부한다. 4자 이상 128자 이하이며 영문 대소문자, 숫자, `!@#$%^&*()_+=/-`만 포함한 입력은 trim/truncate 없이 그대로 저장 및 검증한다. |
| AC-005 | Workspace 생성, 이름 변경, 삭제, 정렬, 마지막 Workspace 삭제 차단이 동작한다. |
| AC-006 | Tab 생성, 이름 변경, 삭제, restart, 정렬이 동작한다. |
| AC-007 | Tab Mode와 Grid Mode 전환, React Mosaic tile 이동과 resize가 동작한다. Equal mode는 3개 이하 tab에서 화면 장축 방향으로 새 tab을 추가하고, 4개 이상 tab에서 가로형 단일 행 후보와 연구 기준 격자 baseline을 비교해 더 유리한 배치를 선택한다. Grid Mode에서 휠 버튼 수동 repair와 Grid surface 가시화 repair는 resize 후 `screen-repair` 순서를 지키며, Tab Mode에서는 Grid repair를 요청하지 않는다. |
| AC-008 | Codex, Claude, Hermes 같은 AI TUI 입력 중 session status는 idle invariant를 지킨다. |
| AC-009 | WebSocket 끊김 후 재연결 시 active subscription과 replay가 복구된다. |
| AC-010 | 서버 재시작 후 Workspace state와 lastCwd 기반 tab 복구가 수행된다. |
| AC-011 | Settings PATCH는 검증 실패, 적용 실패, 저장 실패를 명확한 오류로 반환한다. |
| AC-012 | native daemon 무인자 실행, foreground alias, 실행 중 daemon stop command, stale PID 거부, PID reuse 방지가 검증된다. |
| AC-013 | TOTP enabled daemon start는 detach 전에 QR과 manual key를 출력한다. |
| AC-014 | README와 배포본 README는 native daemon, `--foreground`, `--forground`, `BuilderGate.exe stop`, `buildergate stop`, `config.json5`, `QR`, `dist/bin`을 설명한다. |
| AC-015 | `npm run build`는 전체 지원 대상인 `dist/bin/win-amd64-<package-version>`, `dist/bin/linux-amd64-<package-version>`, `dist/bin/win-arm64-<package-version>`, `dist/bin/linux-arm64-<package-version>`, `dist/bin/macos-arm64-<package-version>`를 생성한다. `<package-version>`은 루트 `package.json`의 `version` 값이어야 한다. 각 배포본은 실행파일, 실행파일의 `stop` subcommand, `web/index.html`, `shell-integration/bash-osc133.sh`, config 파일, README, EXE 내장 server runtime, 외부 `node.exe`/`server`/`node_modules` 부재, PM2 dependency 부재, 대상별 아이콘 산출물을 충족해야 한다. `macos-arm64` 배포본은 `BuilderGate.app` 번들과 `BuilderGate.icns`를 포함해야 한다. |
| AC-016 | localStorage가 오래된 `terminal_snapshot_*`로 가득 차 있어도 bootstrap/login token 저장은 snapshot 정리 후 성공하거나, 복구 불가 시 `cws_auth_token`/`cws_auth_expires` partial state를 남기지 않는다. |
| AC-017 | terminal snapshot 저장은 aggregate budget, LRU 제거, current session 우선 보존, 손상 entry 제거, quota retry를 충족한다. |
| AC-018 | GitHub Release 또는 packaged build fresh extraction은 bootstrap-ready `config.json5`를 포함하고 `server/config.json5`를 노출하지 않는다. packaged foreground와 daemon smoke는 환경 변수 오염 제거, HTTPS/redirect port 사전 검사, 지정 port 전달, `/api/auth/bootstrap-status` bootstrap 응답 검증을 수행한다. |
| AC-019 | 신규 Dialog 인프라는 `frontend/src/components/dialog` 아래에 공용 shell, MessageBox, geometry 유틸, 타입, export를 제공한다. Modal mode Dialog는 overlay click과 Escape로 닫히지 않고 X 버튼으로만 닫히며, 배경 UI 조작을 차단하고, title bar drag와 resize를 viewport 안에서 수행하며, 닫은 뒤 재오픈 시 마지막 위치와 크기를 localStorage에서 복원한다. MessageBox는 title, message, Cancel, OK를 표시하고 기존 modal 위에 topmost modal로 표시되어 아래 Dialog와 배경 조작을 차단한다. |
| AC-020 | Codex처럼 scrollback이 긴 interactive AI TUI 세션에서 workspace 이동, Grid surface 가시화, 창 크기 변경, 수동 Grid repair를 수행해도 처음부터 마지막까지 전체 scrollback이 재출력되지 않는다. xterm scrollback과 사용자의 scroll position은 보존되고, 현재 viewport만 보정되며 full `screen-snapshot` replay는 재구독/재연결 복원에서만 발생한다. |
| AC-021 | 상단 hammer 도구 버튼의 `명령줄 관리` 메뉴에서 Modal Dialog를 열 수 있다. Dialog는 마지막 탭, 위치, 크기를 복원하고 배경 조작을 차단한다. 사용자는 커맨드 라인, 디렉토리, 프롬프트 preset을 서버에 등록, inline 수정, 삭제, 순서 변경, 복사할 수 있다. preset 삭제는 MessageBox 확인을 요구하며 Cancel은 삭제하지 않고 OK만 서버 삭제를 실행한다. 커맨드 라인과 디렉토리는 현재 선택된 터미널에서 실행할 수 있고, 프롬프트는 실행 버튼을 표시하지 않는다. |

### 8.1 AC별 검증 매핑

| AC | 검증 방법 |
|---|---|
| AC-001 | `curl -k https://localhost:2002/health`가 2xx JSON 응답을 반환하는지 확인한다. |
| AC-002 | `curl -k -I http://localhost:2001`이 301 계열 응답과 `Location: https://...:2002/...`를 반환하는지 확인한다. |
| AC-003, AC-004, AC-004A, AC-004B, AC-011 | `npm --prefix server test`의 auth, settings, bootstrap 관련 테스트와 Playwright 초기 password setup 플로우로 검증한다. 특히 password 정책은 최소/최대 길이, 허용 문자, 공백/비허용 문자 거부, trim/truncate 부재를 포함해야 한다. |
| AC-005, AC-006 | `npm --prefix server test`의 workspace/session route 테스트와 Workspace UI E2E로 검증한다. |
| AC-007, AC-009, AC-020 | Grid/terminal Playwright E2E와 WebSocket replay/repair 테스트로 검증한다. |
| AC-008 | `npm --prefix server test`의 AI TUI idle invariant 회귀 테스트로 검증한다. |
| AC-010 | 서버 재시작 통합 테스트 또는 workspace JSON/CWD snapshot 검증으로 확인한다. |
| AC-012, AC-013, AC-014 | `npm run test:daemon`, `npm run test:integration:native-daemon`, `npm run test:docs`로 검증한다. |
| AC-015 | `npm run build`와 build output inspection으로 전체 지원 대상 5개 디렉터리, `web/` frontend asset, `shell-integration/`, EXE 내장 server runtime, 외부 Node/runtime 디렉터리 부재, PM2 dependency 부재, 대상별 icon artifact, macOS `BuilderGate.app` bundle을 확인한다. |
| AC-016, AC-017 | Playwright auth bootstrap quota 회귀와 terminal snapshot quota unit test로 검증한다. |
| AC-018 | build output bootstrap-safe config 검사, GitHub Actions release asset 검사, packaged bootstrap smoke로 검증한다. |
| AC-019 | Dialog component unit test, MessageBox component unit test, geometry utility unit test, Playwright modal interaction E2E로 검증한다. 배경 클릭/ESC 미닫힘, X 닫힘, viewport clamp, geometry 복원, topmost modal focus trap, 배경 조작 차단을 포함해야 한다. |
| AC-021 | `npm --prefix server test`의 CommandPresetService/route 테스트, `npm --prefix frontend run test:unit:command-management`, `npm --prefix frontend run lint:command-management`, `npm --prefix frontend run test:e2e:command-management`로 검증한다. 삭제 확인 MessageBox의 Cancel/OK 분기, 삭제 실패 표시, command/directory/prompt kind별 확인 흐름을 포함해야 한다. |

## 9. 검증 요구사항

### 9.1 필수 검증 명령

| 범위 | 명령 |
|---|---|
| 서버 테스트 | `npm --prefix server test` |
| 프런트엔드 빌드 | `npm --prefix frontend run build` |
| 프런트엔드 E2E | `npm --prefix frontend exec playwright test` |
| daemon 테스트 | `npm run test:daemon` |
| daemon docs 테스트 | `npm run test:docs` |
| native daemon integration | `npm run test:integration:native-daemon` |
| 배포 빌드 | `npm run build` |
| packaged bootstrap smoke | `node tools/daemon/packaged-bootstrap-smoke.js --runtime dist\bin\win-amd64-<package-version> --port 23002 --timeout-ms 60000` |
| health check | `curl -k https://localhost:2002/health` |

작업 범위가 문서만이면 관련 문서 링크, 요구사항 ID, 금지된 과거 계약 문구를 정적 검증한다. 코드 변경이 있으면 영향을 받은 서버, 프런트엔드, daemon, E2E 테스트를 완료 시점에 다시 실행한다.

### 9.2 회귀 테스트 정책

| ID | 요구사항 |
|---|---|
| VER-001 | 모든 버그 수정은 재현 실패 케이스, 수정 후 성공 케이스, 경계/엣지 케이스를 포함해야 한다. |
| VER-002 | UI 또는 브라우저 동작에 영향을 주는 변경은 Playwright E2E 또는 동등한 브라우저 검증을 포함해야 한다. |
| VER-003 | 수동 검증과 Playwright E2E는 반드시 `https://localhost:2002`를 대상으로 한다. |
| VER-004 | implementation phase 완료 후에는 계획 문서를 기준으로 코드 리뷰를 수행하고, findings가 있으면 수정 후 재검토해야 한다. |

## 10. 추적성 매트릭스

| 통합 요구사항 영역 | 주요 근거 문서/코드 |
|---|---|
| Runtime, HTTPS, dev proxy | `docs/archive/spec/srs.startup.md`, `docs/archive/srs/srs-fromCode-2026-04-24.buildergate.md` |
| Security, JWT, TLS, bootstrap | `docs/archive/spec/srs.step2.md`, `docs/archive/srs/srs-fromCode-2026-04-24.buildergate.md` |
| TOTP | `docs/archive/srs/step6.srs.totp-google-authenticator-인증.2026-04-08.md`, `docs/archive/srs/step6.srs-plan.twoFactor-설정-구조-평탄화.2026-04-09.md` |
| Runtime Settings | `docs/archive/spec/srs.step5.md`, `docs/archive/srs/step6.srs-plan.twoFactor-설정-구조-평탄화.2026-04-09.md` |
| Terminal, file manager, UX | `docs/archive/spec/srs.step3.md`, `docs/archive/srs/srs-fromCode-2026-04-24.buildergate.md` |
| React Mosaic, tab/grid mode | `docs/archive/srs/step0.prd-qna.react-mosaic-grid-layout.2026-04-02.md`, `docs/archive/srs/step1.srs.react-mosaic-grid-layout.2026-04-02.md`, `docs/archive/srs/step2.srs-plan.mosaic-dnd-타일이동.2026-04-03.md` |
| Grid repair call path | `docs/archive/srs/srs-fromCode-2026-04-24.buildergate.md`, `frontend/src/components/Terminal/TerminalRuntimeLayer.tsx`, `frontend/src/components/Terminal/TerminalContainer.tsx`, `frontend/src/components/Terminal/TerminalView.tsx`, `server/src/ws/WsRouter.ts` |
| Terminal Screen Repair V2 research | `docs/research/2026-05-08.terminal-screen-repair-v2-recommended-implementation.md`, `server/src/utils/headlessTerminal.ts`, `server/src/services/SessionManager.ts`, `server/src/ws/WsRouter.ts`, `frontend/src/components/Terminal/TerminalContainer.tsx`, `frontend/src/components/Terminal/TerminalView.tsx` |
| Workspace pivot | `docs/archive/spec/srs.step7.pivot.md` |
| CWD persistence | `docs/archive/srs/step5.srs-plan.세션-CWD-영속화-및-복원.2026-04-08.md` |
| Grid DnD/equal mode regression | `docs/archive/srs/step7.srs-plan.equal-모드-무브버튼-드래그-영역-복원.2026-04-22.md` |
| Grid equal mode direction research | `docs/plan/step7/05.phase-5-grid-mode.md`, `frontend/src/components/Grid/MosaicContainer.tsx`, `frontend/src/utils/mosaic.ts`, 본 SRS 4.6.1 |
| Dialog 인프라와 modal/modeless 확장 준비 | 신규 요구사항 회의 기록, `frontend/src/components/Modal/*` legacy 현황, 본 SRS 4.9 |
| Command Preset 관리 | 신규 요구사항 회의 기록, `frontend/src/components/Header/Header.tsx`, `frontend/src/components/CommandPresetManager/*`, `frontend/src/components/dialog/*`, `server/src/services/CommandPresetService.ts`, `server/src/routes/commandPresetRoutes.ts`, 본 SRS 4.10 |
| Native daemon | `docs/archive/srs/step8.prd.buildergate-native-daemon-mode.2026-04-25.md`, `docs/archive/srs/step8.srs.buildergate-native-daemon-mode.2026-04-27.md` |
| Auth storage quota, terminal snapshot budget, release bootstrap hardening | `docs/plan/2026-04-29.frontend-localstorage-quota-research-plan.md`, `docs/plan/step28.2026-04-29.auth-storage-quota-and-release-bootstrap-hardening/00.index.md` |

### 10.1 요구사항-수용기준-검증 추적성

| 통합 요구사항 ID | 주요 출처 | 수용 기준 | 검증 |
|---|---|---|---|
| FR-RUN-001, FR-RUN-002, FR-RUN-003 | `docs/archive/spec/srs.startup.md`, code-derived SRS | AC-001, AC-002 | health check, HTTP redirect curl, server integration |
| FR-RUN-004 ~ FR-RUN-011 | step8 PRD/SRS | AC-012, AC-013, AC-014 | `npm run test:daemon`, `npm run test:integration:native-daemon`, `npm run test:docs` |
| FR-RUN-012 ~ FR-RUN-017 | step8 PRD/SRS, Step 28 release/bootstrap hardening plan | AC-014, AC-015, AC-018 | `npm run build`, build output inspection, `npm run test:docs`, packaged bootstrap smoke |
| FR-AUTH-001 ~ FR-AUTH-016, NFR-SEC-001 ~ NFR-SEC-003 | `docs/archive/spec/srs.step2.md`, TOTP SRS, code-derived SRS, Step 28 auth quota plan | AC-003, AC-004, AC-004A, AC-004B, AC-013, AC-016 | `npm --prefix server test`, auth E2E, auth quota E2E |
| NFR-SEC-004, FR-FILE-001 ~ FR-FILE-004, GAP-014 | step3 SRS, code-derived SRS | API-level only | file route tests, FileService policy regression |
| NFR-SEC-005, GAP-010 | Runtime Settings SRS, config schema code | AC-011 | settings service tests, config schema/loader tests |
| NFR-SEC-006 | native daemon SRS, code-derived SRS | AC-012 | daemon shutdown token tests |
| FR-SESS-001 ~ FR-SESS-017 | code-derived SRS, CWD plan, idle invariant rule, Step 28 terminal snapshot quota plan, Terminal Screen Repair V2 research | AC-008, AC-009, AC-010, AC-017, AC-020 | `npm --prefix server test`, terminal replay/repair E2E, terminal snapshot quota unit test |
| FR-WS-001 ~ FR-WS-013 | step8 WebSocket plan, code-derived SRS, Terminal Screen Repair V2 research | AC-009, AC-020 | WebSocket route/replay/repair tests, Playwright terminal flow |
| FR-WSP-001 ~ FR-WSP-011 | step7 pivot SRS, CWD plan | AC-005, AC-006, AC-010 | workspace API tests, Workspace UI E2E |
| FR-GRID-001 ~ FR-GRID-017 | React Mosaic SRS/plan, step7 pivot SRS, code-derived grid repair path, Grid equal mode direction research, Terminal Screen Repair V2 research | AC-007, AC-020 | Grid E2E, layout localStorage inspection, Equal mode direction unit/E2E, screen-repair ordering E2E |
| FR-SET-001 ~ FR-SET-008 | step5 Runtime Settings SRS, twoFactor flatten plan, password policy update | AC-004B, AC-011 | settings service tests, Settings UI E2E |
| FR-DLG-001 ~ FR-DLG-014, NFR-UX-005, NFR-MAINT-005 | 신규 Dialog 인프라 요구사항, 기존 Modal/ContextMenu 코드 대조 | AC-019 | component unit, MessageBox unit, geometry utility unit, Playwright modal E2E, code review |
| FR-CMD-001 ~ FR-CMD-009 | 신규 명령줄 관리 요구사항, CommandPresetManager/Header/Dialog/CommandPresetService 코드 | AC-021 | CommandPresetService/route tests, command management unit/lint/E2E |
| NFR-UX-001, NFR-UX-002, GAP-015 | frontend code-derived SRS, Workspace/Grid UI SRS | AC-005, AC-006, AC-007 | Workspace/Grid E2E, ARIA inspection |
| NFR-UX-003 | Runtime Settings SRS, frontend code-derived SRS | AC-011 | Settings UI E2E |
| NFR-UX-004, GAP-013 | accessibility policy | CSS inspection gate | reduced-motion CSS inspection |

## 11. 충돌 해결 기록

| 충돌 | 결정 |
|---|---|
| `docs/spec`는 step7까지, `docs/srs`는 step8까지 존재 | 본 문서는 step8 native daemon을 최신 production runtime 요구사항으로 채택한다. |
| 과거 PM2 기반 production 문구 | native daemon SRS가 이를 대체한다. PM2는 현 기준 요구사항이 아니다. |
| step6 pane split 요구사항과 step7 workspace pivot 요구사항 | 현재 제품 기준은 Workspace, Tab, React Mosaic Grid이다. |
| 이메일 OTP 문구와 TOTP 문구 | 현재 기준은 TOTP이다. 이메일 OTP는 범위 제외다. |
| 과거 Workspace SSE endpoint 계약 | `/api/workspaces/stream` 같은 SSE 계약은 현재 `/ws` 단일 WebSocket 계약으로 대체되었다. legacy SSE endpoint는 현 기준 API가 아니다. |
| code-derived SRS의 일부 stale 항목 | 현재 코드와 최신 step8 SRS가 우선한다. |

## 12. 문서 관리 규칙

| ID | 규칙 |
|---|---|
| DOC-001 | 신규 기능 SRS는 가능하면 본 문서의 요구사항 ID 체계에 추가한다. |
| DOC-002 | 기존 단계별 문서를 삭제하지 않는다. 대신 본 문서의 추적성 매트릭스에 근거로 남긴다. |
| DOC-003 | 요구사항 변경 시 관련 수용 기준과 검증 명령도 함께 갱신한다. |
| DOC-004 | 구현 계획 문서는 이 SRS의 요구사항 ID를 참조해야 한다. |
| DOC-005 | 한국어 본문을 원칙으로 하되, API path, code symbol, CLI option, payload type은 원문 표기를 유지한다. |
| DOC-006 | 신규 Dialog 또는 modal 기능을 문서화할 때는 `dialogId`, modal/modeless mode, 닫기 조건, geometry 영속화 여부, 배경 상호작용 정책을 요구사항에 명시해야 한다. |

## 13. 현재 코드 대조 결과와 구현 격차

이 절은 통합 SRS 작성 시점에 코드와 대조하면서 확인한 격차다. 격차 항목은 현재 코드의 사실을 숨기지 않기 위한 기록이며, 후속 구현 계획에서 닫아야 한다.

| ID | 격차 | 영향 | 후속 방향 |
|---|---|---|---|
| GAP-001 | `useDragReorder`는 현재 X축 중심 계산을 Workspace sidebar와 Tab bar에 공용 사용한다. 세로 Workspace 정렬과 첫 위치 drop에는 회귀 위험이 있다. | Workspace/Tab 재정렬 AC의 UI 검증 리스크 | orientation 기반 DnD 계산과 last-to-first, first-to-last E2E 추가 |
| GAP-002 | FileManager/MdirPanel, viewer 관련 컴포넌트와 훅은 남아 있으나 현재 `App.tsx`에 마운트되지 않는다. | 과거 파일 UI SRS와 현재 제품 화면 불일치 | 파일 UI를 복원할 별도 SRS를 만들거나 legacy dead code 정리 |
| GAP-003 | 서버 `gridLayouts` API와 모델은 남아 있으나 현재 Mosaic 화면은 localStorage 기반 `useMosaicLayout`을 주 저장 경로로 쓴다. | 서버 권위 레이아웃 요구사항과 현재 구현 불일치 | 서버 저장으로 재연결하거나 API/model을 legacy로 축소 |
| GAP-004 | 프런트엔드의 Workspace/Tab/Session 제한 표시가 기본값 `10/8/32`로 하드코딩되어 있다. 서버 설정 변경 시 UI 표시와 서버 제한이 달라질 수 있다. | 설정 기반 제한 UX 불일치 | `/api/workspaces` 또는 settings snapshot에 limit metadata 노출 |
| GAP-005 | `authApi.verify` 프런트엔드 helper에는 legacy `'email'` stage 타입이 일부 남아 있다. | TOTP-only SRS와 타입 표면 불일치 | 프런트 helper 타입 정리 |
| GAP-006 | `auth.jwtSecret`은 encrypted 값을 읽을 수 있지만 자동 암호화/영속 생성 대상은 아니다. 빈 값은 메모리 secret으로 생성되어 재시작 시 기존 세션을 무효화한다. | secret persistence hardening 필요 | JWT secret 자동 암호화 저장 여부를 별도 보안 개선으로 결정 |
| GAP-007 | production strict config fallback 금지는 launcher preflight에는 반영되어 있으나 app child의 `config.ts` fallback 경로까지 완전히 닫혀 있지는 않다. | production misconfig 감지 약화 가능성 | production env에서 fallback 재throw 정책 구현 |
| GAP-008 | stop command의 app already-exited 경로는 workspace/CWD flush evidence 없이 성공을 반환할 수 있다. | graceful stop 판정의 엄격성 부족 | already-exited 상태를 별도 non-graceful 결과로 분리 |
| GAP-009 | `Config` TypeScript 타입에는 `workspace` section이 없고 `WorkspaceService`가 `(config as any).workspace`를 사용한다. | 타입 안전성 부족 | `WorkspaceConfig` 타입을 `Config`에 추가 |
| GAP-010 | CORS wildcard origin과 credentials 조합은 Settings PATCH에서 거부되지만 config schema/startup load에서는 cross-field 검증이 없다. | 잘못된 config 파일이 startup에서 통과할 수 있음 | shared `corsSchema` 또는 strict loader에 cross-field 검증과 회귀 테스트 추가 |
| GAP-011 | TOTP replay 방지는 현재 pending auth tempToken 단위다. 새 password login으로 같은 timestep의 TOTP code를 다시 제출할 수 있다. | 계정 단위 OTP 재사용 차단 약화 | TOTP service/account scope에 last accepted timestep 저장 |
| GAP-012 | Settings config write는 백업 파일 생성 후 직접 write하며 atomic rename 또는 write 실패 시 자동 복원을 보장하지 않는다. | config 저장 중 프로세스/파일시스템 오류 hardening 부족 | temp file + fsync + atomic rename, 실패 시 복원 정책 추가 |
| GAP-013 | 프런트엔드 CSS에는 현재 `prefers-reduced-motion` 분기 처리가 없다. | 움직임 민감 사용자 접근성 미흡 | 주요 transition/animation에 reduced-motion CSS와 브라우저 검증 추가 |
| GAP-014 | FileService는 `listDirectory`의 `targetPath` 미지정 경로에서 session CWD를 blocked path로 재검증하지 않고, `mkdir`은 base path 검증 후 최종 생성 경로를 blocked path로 재검증하지 않는다. | 파일 정책 적용 범위가 작업별로 다르게 보일 수 있음 | CWD와 mkdir final path를 동일 resolver로 검증하고 회귀 테스트 추가 |
| GAP-015 | Workspace item과 Tab item은 `div` 기반 pointer handler이고 context menu item도 `div role="menuitem"` 중심이라 keyboard selection/execution과 icon-only button accessible name이 충분하지 않다. | 키보드 접근성 및 보조기술 사용성 부족 | semantic button 또는 roving tabindex/Enter/Space/Arrow 처리와 `aria-label` 보강 |
| GAP-016 | 현재 `frontend/src/components/Modal`의 Confirm/Rename/ShellSelect 모달은 overlay click과 Escape로 닫히는 legacy 패턴이며 drag, resize, viewport clamp, dialog geometry persistence를 제공하지 않는다. | 신규 공용 Dialog 계약과 기존 legacy 모달 계약이 다름 | 신규 기능은 `frontend/src/components/dialog` 공용 shell을 사용하고, legacy 모달 이전은 별도 호환 계획으로 처리 |
