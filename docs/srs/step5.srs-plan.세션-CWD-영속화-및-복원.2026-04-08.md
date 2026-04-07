---
title: 세션 CWD 영속화 및 복원
project: BuilderGate
date: 2026-04-08
type: feature
tech_stack: Node.js + Express + TypeScript (server), React 18 + TypeScript (frontend), node-pty, WebSocket
code_path: server/src, frontend/src
request_doc: docs/srs/request/2026-04-08.request.srs-plan.세션-CWD-영속화-및-복원.md
---

# 세션 CWD 영속화 및 복원

---

# Part 1: SRS (무엇을)

## 1.1 목적

서버 재시작(정상/비정상 종료) 후 각 터미널 탭이 마지막 작업 디렉토리(CWD)에서 자동 복원되어 사용자의 작업 연속성을 보장한다.

## 1.2 배경

현재 SessionManager는 인메모리 전용이며, 서버 종료 시 모든 PTY 프로세스와 CWD 정보가 소멸한다. workspaces.json에 탭 메타데이터(id, sessionId, name, shellType 등)는 저장되지만, 각 탭의 마지막 CWD는 저장되지 않는다. 서버 재시작 후 고아 탭(orphan tab)이 감지되지만 복구되지 않아 사용자가 수동으로 세션을 재생성해야 하고, 이전 작업 디렉토리로 다시 이동해야 한다.

CWD 추적은 이미 구현되어 있다: 셸 프롬프트 훅이 `os.tmpdir()/buildergate-cwd-{sessionId}.txt`에 PWD를 기록하고, `fs.watchFile(1s)`로 변경을 감지하여 `sessionData.lastCwd`에 저장 및 WebSocket으로 프론트엔드에 브로드캐스트한다. 이 메커니즘을 활용하여 CWD를 영속화하면 된다.

## 1.3 기능 요구사항

- **FR-1**: `WorkspaceTab` 타입에 `lastCwd?: string` 필드를 추가하여 workspaces.json에 영속화한다.
- **FR-2**: SessionManager의 CWD 변경 감지 시 WorkspaceService에 콜백하여 해당 탭의 `lastCwd`를 업데이트하고 디바운스된 저장을 트리거한다.
- **FR-3**: 주기적(30초)으로 모든 활성 세션의 CWD를 스냅샷하여 비정상 종료에 대비한다.
- **FR-4**: 서버 정상 종료(SIGINT/SIGTERM) 시, CWD watchFile 중지 → 최종 CWD 스냅샷 → forceFlush 순서로 실행하여 레이스 컨디션 없이 최신 CWD를 저장한다.
- **FR-5**: 서버 재시작 시 `checkOrphanTabs()`가 고아 탭을 감지하면, 저장된 `lastCwd`를 사용하여 새 PTY 세션을 자동 생성하고 `tab.sessionId`를 갱신한다. CWD 디렉토리가 존재하지 않으면 홈 디렉토리로 폴백한다.

## 1.4 비기능 요구사항

- **NFR-1 (보안)**: CWD 값 읽기 시 제어문자(\x00-\x1f), 널바이트, 개행 거부. 최대 4096자 제한. PowerShell BOM 제거. `resolveSpawnCwd()`에 `fs.existsSync()` 검증 추가.
- **NFR-2 (데이터 무결성)**: workspaces.json 로드 시 `lastCwd` 필드를 검증하여 제어문자가 포함된 값은 `undefined`로 초기화.
- **NFR-3 (데이터 손실 허용치)**: 비정상 종료 시 CWD 데이터 손실 최대 30초. 정상 종료 시 손실 0.
- **NFR-4 (sessionId 동기화)**: 고아 탭 복구 후 새 sessionId가 REST 응답(`GET /api/workspaces/state`)에 포함되어 프론트엔드가 올바른 sessionId로 WebSocket subscribe할 수 있어야 한다. 프론트엔드는 `useWorkspaceManager` 초기화 시 `workspaceApi.getAll()`을 호출하여 최신 탭 상태를 fetch하므로 이 흐름이 보장된다.

## 1.5 제약사항

- 기존 workspaces.json 원자적 쓰기 패턴(temp → backup → rename) 유지
- 기존 CWD 추적 메커니즘(임시파일 + watchFile) 변경 없이 확장
- 최대 32세션 제한 유지
- Node.js 단일 스레드 이벤트 루프에서 동작 (동시성 문제 없음)

## 1.6 현행 코드 분석

### 영향 범위

| 파일 | 변경 유형 | 설명 |
|------|----------|------|
| `server/src/types/workspace.types.ts` | 수정 | `WorkspaceTab`에 `lastCwd?: string` 추가 |
| `server/src/services/SessionManager.ts` | 수정 | CWD 변경 콜백, `stopAllCwdWatching()`, CWD 위생처리 |
| `server/src/services/WorkspaceService.ts` | 수정 | CWD 콜백 등록, 주기 스냅샷, 고아 탭 복구, `restartTab` 수정 |
| `server/src/index.ts` | 수정 | 셧다운 시퀀스 변경, 주기 스냅샷 타이머 |
| `frontend/src/types/workspace.ts` | 수정 | `WorkspaceTab`에 `lastCwd?: string` 추가 |
| `frontend/src/hooks/useWorkspaceManager.ts` | 수정 | 탭 초기 CWD 설정, `restartTab`에 CWD 전달 |

### 재사용 가능 코드

- `SessionManager.getLastCwd(sessionId)` — 이미 세션별 마지막 CWD 반환 메서드 존재
- `SessionManager.getInitialCwd(sessionId)` — 초기 CWD 반환 메서드 존재
- `WorkspaceService.save(immediate?)` — 디바운스/즉시 저장 메서드 존재
- `WorkspaceService.forceFlush()` — 강제 플러시 메서드 존재
- `WorkspaceService.flushToDisk()` — 원자적 쓰기(temp → backup → rename) 구현 존재
- `resolveSpawnCwd()` — CWD 경로 변환 로직 존재 (여기에 검증 추가)

### 주의사항

- `restartTab()`이 구 세션을 `deleteSession()` 하지 않는 **기존 버그** 존재 — 이번에 함께 수정 (동시성 분석 Finding #5)
- 프론트엔드는 WebSocket 재연결 시 REST로 workspace 상태를 먼저 fetch하므로 새 sessionId 동기화에 문제 없음 (`useWorkspaceManager` 초기화 흐름 확인됨)
- CWD 임시파일 심링크 공격은 localhost 전용 환경에서 LOW 위험이나, `lstat` 검증을 권장 사항으로 둠

---

# Part 2: 구현 계획 (어떻게)

## Phase 1: 타입 확장 + CWD 위생처리 유틸리티
- [ ] Phase 1-1: `server/src/types/workspace.types.ts` — `WorkspaceTab`에 `lastCwd?: string` 필드 추가 `FR-1`
- [ ] Phase 1-2: `frontend/src/types/workspace.ts` — `WorkspaceTab`에 `lastCwd?: string` 필드 추가 `FR-1`
- [ ] Phase 1-3: `server/src/services/SessionManager.ts` — CWD 위생처리 함수 `sanitizeCwd(raw: string): string | null` 추가. 제어문자(\x00-\x1f), 개행, 4096자 초과 거부. PowerShell BOM(`\uFEFF`) 제거. `trim()` 적용. `NFR-1`
- [ ] Phase 1-4: `server/src/services/SessionManager.ts` — 기존 `injectCwdHook`의 `watchFile` 콜백에서 `readFileSync` 후 `sanitizeCwd()`를 적용하여 `sessionData.lastCwd`에 저장하도록 수정 `NFR-1`
- [ ] Phase 1-5: `server/src/services/SessionManager.ts` — `resolveSpawnCwd()`에 `fs.existsSync(cwd)` 검증 추가, 존재하지 않으면 폴백 디렉토리 반환 `NFR-1`
- **재사용:** 기존 `resolveSpawnCwd()` 함수에 검증 로직 삽입, 기존 `injectCwdHook()` 콜백에 위생처리 삽입
- **테스트:**
  - 정상: `sanitizeCwd("/home/user/project")` → 반환값 `"/home/user/project"`
  - 예외: `sanitizeCwd("/home/\x00bad")` → 반환값 `null` (널바이트 거부)
  - 예외: `sanitizeCwd("a".repeat(4097))` → 반환값 `null` (길이 초과)
  - 예외: `sanitizeCwd("\uFEFFC:\\Users")` → 반환값 `"C:\\Users"` (BOM 제거)
  - 예외: `resolveSpawnCwd("/no/such/dir", "bash")` → `fs.existsSync` false → 홈 디렉토리 반환

## Phase 2: CWD 변경 콜백 + 주기 스냅샷
- [ ] Phase 2-1: `server/src/services/SessionManager.ts` — CWD 변경 시 호출할 외부 콜백 등록 메서드 추가. 단일 콜백 방식(현재 사용처는 WorkspaceService 하나뿐이므로): `private cwdChangeCallback: ((sessionId: string, cwd: string) => void) | null = null;` 필드 + `onCwdChange(cb: (sessionId: string, cwd: string) => void): void { this.cwdChangeCallback = cb; }` 메서드 `FR-2`
- [ ] Phase 2-2: `server/src/services/SessionManager.ts` — `injectCwdHook`의 `watchFile` 콜백에서 CWD 변경 감지 시 등록된 콜백 호출 `FR-2`
- [ ] Phase 2-3: `server/src/services/WorkspaceService.ts` — 생성자에서 `sessionManager.onCwdChange()` 등록. 콜백 내부: `const tab = this.state.tabs.find(t => t.sessionId === sessionId);`로 탭 검색 → `if (tab) { tab.lastCwd = cwd; this.save(); }` `FR-2`
- [ ] Phase 2-4: `server/src/services/WorkspaceService.ts` — `snapshotAllCwds()` 메서드 추가. 모든 탭을 순회하며 `sessionManager.getLastCwd(tab.sessionId)`로 CWD를 읽어 `tab.lastCwd`에 저장 `FR-3`
- [ ] Phase 2-5: `server/src/index.ts` — 서버 시작 후 30초 간격으로 `workspaceService.snapshotAllCwds()` 호출하는 `setInterval` 설정 `FR-3`
- **재사용:** 기존 `SessionManager.getLastCwd()`, `WorkspaceService.save()` 메서드 활용
- **테스트:**
  - 정상: CWD `/home/a` → `/home/b` 변경 → 콜백 호출 → `tab.lastCwd === "/home/b"` (서버 콘솔에 `[CWD] Tab {id} cwd updated: /home/b` 로그 출력으로 확인)
  - 예외: 존재하지 않는 sessionId `"nonexistent"` → 콜백 내 `tabs.find()` 반환 `undefined` → 아무 동작 없음, 에러 없음

## Phase 3: Graceful Shutdown 시퀀스 개선
- [ ] Phase 3-1: `server/src/services/SessionManager.ts` — `stopAllCwdWatching()` 메서드 추가. 모든 세션의 `cwdFilePath`에 대해 `unwatchFile()` 호출 `FR-4`
- [ ] Phase 3-2: `server/src/index.ts` — 셧다운 핸들러(`setupGracefulShutdown` 내 `shutdown` 함수) 수정. 의사코드: `FR-4`
  ```typescript
  const shutdown = async (signal: string) => {
    console.log(`[Shutdown] ${signal} received`);
    sessionManager.stopAllCwdWatching();          // (1) watchFile 중지
    workspaceService.snapshotAllCwds();            // (2) 최종 CWD 스냅샷
    await workspaceService.forceFlush();           // (3) 디스크 플러시 (await)
    if (snapshotTimer) clearInterval(snapshotTimer); // (4) 주기 타이머 정리
    process.exit(0);                               // (5) 종료
  };
  ```
- **재사용:** 기존 `forceFlush()`, Phase 2에서 추가한 `snapshotAllCwds()` 활용
- **테스트:**
  - 정상: SIGINT 발생 → 로그 확인: watchFile 중지 → 스냅샷 완료 → 플러시 완료
  - 예외: watchFile 이미 중지된 상태 → 에러 없이 진행

## Phase 4: 고아 탭 복구 + restartTab 수정
- [ ] Phase 4-1: `server/src/services/WorkspaceService.ts` — `checkOrphanTabs()` 확장: 고아 탭을 감지하면 `tab.lastCwd`(없으면 undefined)를 사용하여 `sessionManager.createSession(tab.name, tab.shellType, tab.lastCwd)` 호출. 반환된 새 sessionId로 `tab.sessionId` 갱신. 즉시 저장 `FR-5`
- [ ] Phase 4-2: `server/src/services/WorkspaceService.ts` — `restartTab()` 수정: (1) `this.sessionManager.deleteSession(tab.sessionId)` 호출하여 구 세션 정리, (2) `createSession(tab.name, tab.shellType, tab.lastCwd)` 로 새 세션 생성 `FR-5` + 기존 버그 수정
- [ ] Phase 4-3: `server/src/services/WorkspaceService.ts` — `initialize()` 메서드 내 `this.state = loaded.state;` 직후에 탭 CWD 검증 루프 삽입: `this.state.tabs.forEach(tab => { if (tab.lastCwd && /[\x00-\x1f]/.test(tab.lastCwd)) { tab.lastCwd = undefined; } });` `NFR-2`
- **재사용:** 기존 `createSession()` (이미 cwd 파라미터 지원), `deleteSession()`, `resolveSpawnCwd()` (Phase 1에서 검증 추가됨)
- **테스트:**
  - 정상: 서버 재시작 → 고아 탭 감지 → 저장된 CWD로 세션 재생성 → 새 sessionId 할당
  - 예외: lastCwd가 없는 고아 탭 → 홈 디렉토리에서 세션 생성
  - 예외: lastCwd 디렉토리 삭제됨 → resolveSpawnCwd가 홈 디렉토리 폴백

## Phase 5: 프론트엔드 CWD 활용 + sessionId 동기화 검증
- [ ] Phase 5-1: `frontend/src/hooks/useWorkspaceManager.ts` — 초기 로드 `useEffect` (라인 83-117) 내 `runtimeTabs` 변환부(`state.tabs.map(t => ({ ...t, status: 'idle', cwd: '' }))`)에서 `cwd: ''`를 `cwd: t.lastCwd || ''`로 변경 `FR-5`
- [ ] Phase 5-2: `frontend/src/hooks/useWorkspaceManager.ts` — `restartTab()` (라인 366-373) 호출 시 반환된 탭의 `lastCwd`를 `cwd` 초기값으로 설정: `{ ...t, ...tab, status: 'idle', cwd: tab.lastCwd || '' }` `FR-5`
- [ ] Phase 5-3: sessionId 동기화 E2E 검증 — 서버 재시작 후 프론트엔드가 `workspaceApi.getAll()`로 최신 상태를 fetch하여 새 sessionId로 WebSocket subscribe하는 흐름이 정상 동작하는지 확인 `NFR-4`
- **재사용:** 기존 `workspaceApi.getAll()` → 서버가 `lastCwd` 포함하여 반환, 기존 `updateTabCwd()` 콜백 활용
- **테스트:**
  - 정상: 서버 재시작 후 브라우저 접속 → `GET /api/workspaces/state` 응답에 새 sessionId + lastCwd 포함 → 탭 CWD 표시가 이전 디렉토리
  - 예외: lastCwd 없는 탭 → CWD 빈 문자열 (기존 동작 동일)
  - 정상: 고아 복구 후 프론트엔드가 새 sessionId로 WebSocket subscribe 성공 → 터미널 출력 수신 확인

## 단위 테스트 계획

### 테스트 실행 환경
- 프로젝트에 자동화 테스트 프레임워크 미구축 → **수동 검증** 방식 사용
- 빌드 검증: `cd server && npx tsc --noEmit` + `cd frontend && npx tsc --noEmit`
- E2E 수동 검증: `node dev.js` 실행 후 브라우저에서 시나리오 수행

### 테스트 대상 및 Pass 기준

| 대상 | 테스트 유형 | 시나리오 | Pass 기준 |
|------|------------|----------|-----------|
| `sanitizeCwd()` | 단위 (코드 리뷰) | 정상: `"/home/user/proj"` 입력 | 반환값 === `"/home/user/proj"` |
| `sanitizeCwd()` | 단위 (코드 리뷰) | 예외: `"/home/\x00bad"` 입력 | 반환값 === `null` |
| `sanitizeCwd()` | 단위 (코드 리뷰) | 예외: `"\uFEFFC:\\Users\\beom"` 입력 | 반환값 === `"C:\\Users\\beom"` (BOM 제거) |
| `sanitizeCwd()` | 단위 (코드 리뷰) | 예외: 4097자 문자열 입력 | 반환값 === `null` |
| `resolveSpawnCwd()` | 단위 (코드 리뷰) | 비존재 경로 `"/no/such/dir"` | `fs.existsSync` false → 홈 디렉토리 반환 |
| `onCwdChange` 콜백 | 통합 (수동) | CWD 변경 `/home/a` → `/home/b` | `tab.lastCwd === "/home/b"`, 서버 콘솔에 `[CWD] Tab {id} cwd updated: /home/b` 로그 출력 확인 |
| `snapshotAllCwds()` | 통합 (수동) | 탭 3개, 각 CWD 다름 | 3개 탭 모두 `tab.lastCwd` === `sessionManager.getLastCwd(tab.sessionId)` |
| `checkOrphanTabs()` 복구 | E2E (수동) | 서버 재시작 후 고아 탭 존재 | 새 sessionId 할당됨, PTY 프로세스 생성됨, CWD === 저장된 lastCwd |
| `restartTab()` | E2E (수동) | 탭 재시작 | 구 session deleteSession 호출(로그 확인), 새 session CWD === tab.lastCwd |

### 기존 테스트 영향
- 기존 테스트 파일: 없음 (프로젝트에 자동화 테스트 미구축)
- 회귀 위험: WorkspaceTab 타입 확장은 optional 필드이므로 기존 코드에 영향 없음
- 추가 필요 테스트: 9개 시나리오 (상기 표)

## 검증 기준

### 자동 검증
- [ ] 타입 검증: `cd server && npx tsc --noEmit` 에러 없음
- [ ] 타입 검증: `cd frontend && npx tsc --noEmit` 에러 없음
- [ ] 빌드 성공: `npm run build` (server + frontend) 에러 없음

### 수동 E2E 검증 절차

**시나리오 1: 정상 종료 복원**
1. `node dev.js`로 서버 시작
2. 브라우저에서 터미널 탭 2개 열기
3. 각 탭에서 다른 디렉토리로 `cd` (예: `cd /tmp`, `cd /home`)
4. `Ctrl+C`로 서버 종료
5. 콘솔에 `[Shutdown] Workspace state saved` 출력 확인
6. `cat server/data/workspaces.json | grep lastCwd` → 두 탭 모두 lastCwd 필드 존재
7. `node dev.js`로 서버 재시작
8. 브라우저 접속 → 두 탭 모두 자동 재생성, 각각 이전 디렉토리에서 시작 (`pwd` 명령으로 확인)

**시나리오 2: 비정상 종료 복원**
1. `node dev.js`로 서버 시작
2. 터미널에서 `cd /tmp` 실행
3. 30초 대기 후 `ls -la server/data/workspaces.json`로 타임스탬프가 갱신되었는지 확인 (스냅샷 실행 증거)
4. 서버 프로세스를 `kill -9`로 강제 종료
5. `node dev.js`로 서버 재시작
6. 탭이 `/tmp`에서 시작하는지 확인

**시나리오 3: 폴백 동작**
1. 터미널에서 `mkdir /tmp/testdir && cd /tmp/testdir` 실행
2. 서버 정상 종료
3. `rm -rf /tmp/testdir`로 디렉토리 삭제
4. 서버 재시작
5. 탭이 홈 디렉토리에서 시작하는지 확인 (`pwd` === `$HOME`)

- [ ] 시나리오 1 통과
- [ ] 시나리오 2 통과
- [ ] 시나리오 3 통과
- [ ] 요구사항 전수 매핑: FR-1 → Phase 1, FR-2 → Phase 2, FR-3 → Phase 2, FR-4 → Phase 3, FR-5 → Phase 4+5, NFR-4 → Phase 5

## 후속 파이프라인

- 다음 단계: `snoworca-plan-driven-coder`
- 입력 인자:
  - PLAN_PATH: `docs/srs/step5.srs-plan.세션-CWD-영속화-및-복원.2026-04-08.md`
  - LANGUAGE: TypeScript 5.x
  - FRAMEWORK: Node.js + Express (server), React 18 (frontend)
  - CODE_PATH: `server/src`, `frontend/src`
