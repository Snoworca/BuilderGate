# 회귀 기준선 S-1 — Playwright / E2E 부분 (그룹 P / 그룹 E′)

바이너리 전환 코드 작업 **이전**의 "이미 깨져 있는 것" 기록.
**측정 전용 — 아무것도 고치지 않았다.** 추적 파일 수정 0건, 커밋 0건.

이 문서는 S-1 기준선의 마지막 갈래다. 나머지는
[`backend-baseline.md`](./backend-baseline.md) · [`frontend-baseline.md`](./frontend-baseline.md) · [`wave3-baseline.md`](./wave3-baseline.md) 에 있다.

---

## 0. 측정 메타

| 항목 | 값 |
|---|---|
| 측정 시각 (그룹 P) | 2026-08-19T01:01:17+09:00 ~ 2026-08-19T01:08:23+09:00 (KST), 벽시계 7분 06초 |
| 측정 시각 (그룹 E′) | 2026-08-19T01:10:23+09:00 ~ 2026-08-19T01:10:23+09:00 (KST), 1초 미만 |
| `git rev-parse HEAD` | `eb2f4f89b7a40c0461d11866b0a36f5bc2b4b8a9` |
| 브랜치 | `work/mcp-session-orchestration-20260709` |
| 워킹트리 | `git status --porcelain` 349행 — 추적 수정(` M`) 121 / 삭제(`D`) 1 / 미추적(`??`) 227 엔트리 |
| Node | v24.16.0 |
| Playwright | 1.61.1 |
| 셸 | Git Bash (Bash 도구) |

---

## 1. 측정 대상 서버 — **프로덕션 빌드** (dev 번들 아님)

**판정: 프로덕션 빌드.** 근거는 아래 4가지 관측이다.

1. 측정 시작 전 `curl -k https://localhost:2222/health` → **HTTP 000 (연결 실패)**. 즉 2222 에 dev.js 든 무엇이든 **떠 있는 것이 없었다.**
2. `reuseExistingServer: true` 는 재사용할 대상이 없으므로 발동하지 않았고, Playwright 가 `webServer.command` = `cd .. && start.bat --port 2222` 를 **직접 기동**했다.
3. `server/dist/**` (2026-08-19 00:14:40) 와 `frontend/dist/**` (2026-08-13 02:10:40) 가 **이미 존재**했고, `find <src> -newer <dist>` 결과 **server/src·frontend/src 어느 파일도 dist 보다 새롭지 않았다**. 따라서 `start.bat` 은 재빌드 없이 기존 dist 산출물을 그대로 서빙했다.
4. 실행 중 브라우저가 로드한 번들 경로가 실패 스택에 남아 있다 — `https://localhost:2222/assets/index-CujOT3Uk.js` (해시 포함 = Vite 프로덕션 산출물). dev 번들이면 `/src/main.tsx` 형태가 된다.

> **주의**: 이 dist 는 **미커밋 워킹트리 상태로 빌드된 산출물**이다 (HEAD 기준 아님). 워킹트리에 추적 수정 121 / 미추적 227 이 있으므로, 여기서 관측된 red 상당수는 "HEAD 의 red" 가 아니라 "현재 워킹트리의 red" 다.

### 1.1 서버 기동에서 먼저 막혔던 것 (측정 자체의 함정 — 기록해 둠)

첫 시도는 `webServer` 기동 실패로 **1초 만에 죽었다**:

```
[WebServer] 'start.bat'은(는) 내부 또는 외부 명령, 실행할 수 있는 프로그램, 또는 배치 파일이 아닙니다.
Error: Process from config.webServer was not able to start. Exit code: 1
```

원인은 `start.bat` 부재가 아니다 (파일은 존재한다). **Git Bash 가 `NoDefaultCurrentDirectoryInExePath=1` 을 설정**하기 때문에, Playwright 가 띄운 `cmd.exe` 가 `cd ..` 이후에도 **현재 디렉터리에서 `start.bat` 을 찾지 않는다.**

또한 이 셸에는 다음이 설정되어 있었다:

- `NODE_ENV=production`
- `BUILDERGATE_CONFIG_PATH` 등 **`BUILDERGATE_*` 15개** — 전부 `C:\Work\agent-tools\builder-gate__` (**다른 런타임 루트**)를 가리킨다. 그대로 두면 저장소 `server/config.json5` 가 아니라 남의 config 로 서버가 뜬다.

→ 본 측정은 이 **17개 변수를 전부 `env -u` 로 제거**하고 실행했다 (§5 커맨드 전문 참조).

### 1.2 서버 노후 징후 — **있었다. 다만 "오래 떠 있어서"가 아니다**

`server/data/workspaces.json` (gitignored) 관측:

- **측정 시작 시점에 이미 고아 워크스페이스 2개**가 남아 있었다 — `Codexp-Recovery-1779495869600`, `PH5A-mrwzjthr-1784779376171` (타임스탬프상 각각 2026-05, 2026-07 산). 즉 **이전 세션이 흘린 것**이다.
- `server/config.json5` 의 `workspace.maxWorkspaces = 10`.
- Playwright 는 `Running 155 tests using 16 workers` — **16 워커가 동시에** 워크스페이스를 만든다. 고아 2개가 슬롯을 먹은 상태에서 10 슬롯을 16 워커가 다투므로 **한도 초과가 구조적으로 보장된다.**
- 실제로 `WORKSPACE_LIMIT_EXCEEDED` 가 3건, 그 외 워크스페이스/탭 API 의 **500 이 32건, 409 가 8건** 관측됐다.
- 측정 종료 후에도 고아가 **7개** 남았다 (`E2E Equal Reorder…`, `KBD-E2E-…`, `W3-SOLE-WRITER-…` ×2, `PH5A-msyuq662-…` + 기존 2개).

**즉 "장시간 dev 인스턴스 노후" 가 아니라 "고아 잔재 + 병렬도 16 vs 한도 10" 이 관측된 형태다.** 서버는 방금 기동한 프로덕션 인스턴스였다.

**재측정 권고 (실행하지 않음, 권고만)**: `server/data/workspaces.json` 의 고아를 비운 뒤 `--workers=1` 또는 `--workers=2` 로 재측정하면 W-API 클러스터 39건이 얼마나 줄어드는지 분리할 수 있다. 임의로 프로세스를 죽이거나 데이터를 지우지 않았다.

### 1.3 측정 후 서버 상태

Playwright 종료 후에도 `curl -k https://localhost:2222/health` → **200**. 즉 `start.bat` 이 띄운 **프로덕션 서버가 아직 살아 있다** (Playwright 가 회수하지 않았다). 그룹 E′ 는 이 인스턴스를 대상으로 돌았고, 이후 누가 E2E 를 다시 돌리면 `reuseExistingServer: true` 때문에 **고아 7개가 남은 이 인스턴스를 그대로 재사용**한다. **죽이지 않았다.**

---

## 2. 요약표

| 그룹 | 대상 | spec 파일 수 | 테스트 수 | pass | fail | flaky | skip | exit | 소요 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **P** | `npx playwright test --project "Desktop Chrome"` | 30 | 155 | 55 | **84** | 9 | 7 | **1** | 7.1m (Playwright 집계) / 벽시계 7m06s |
| **E′** | `tools/wave3/authority-promotion-evidence.test.mjs` | — | 0 (게이트에서 중단) | 0 | **1** (스크립트 자체) | — | — | **1** | <1s |

- 그룹 P 는 **중단 없이 완주**했다 (25분 예산 대비 7분). 미측정 항목 없음.
- flaky 9건은 재시도(`retries: 1`)에서 통과한 것이라 fail 로 세지 않았다. 다만 **1차 시도는 red 였다** — 기준선 비교 시 이 9건은 "안정적 green" 이 아니다.
- exit code 만으로는 판단할 수 없는 사례가 이번에도 있었다: 첫 시도에서 `PW_EXIT=1` 이었지만 **배경 실행 래퍼는 exit 0** 으로 보고됐다 (마지막 `echo`/`tee` 의 코드가 잡혔다). 실행 건수·실패 목록으로 대조해 확정했다.

### 2.1 그룹 P — spec 파일별 내역 (30개 전수)

| spec 파일 (`frontend/tests/e2e/`) | 테스트 | pass | fail | flaky | skip | 소요 |
|---|---:|---:|---:|---:|---:|---:|
| `auth-bootstrap.spec.ts` | 7 | 7 | 0 | 0 | 0 | 25s |
| `command-management-dialog.spec.ts` | 3 | 1 | 2 | 0 | 0 | 78s |
| `grid-equal-mode.spec.ts` | 24 | 11 | 9 | 4 | 0 | 382s |
| `header-context-menu-regression.spec.ts` | 7 | 1 | 5 | 1 | 0 | 156s |
| `mcp-control-dialog.spec.ts` | 6 | 5 | 0 | 1 | 0 | 31s |
| `pane-keyboard.spec.ts` | 3 | 0 | 3 | 0 | 0 | 56s |
| `pane-persistence.spec.ts` | 2 | 0 | 2 | 0 | 0 | 52s |
| `pane-split.spec.ts` | 5 | 0 | 5 | 0 | 0 | 129s |
| `perf-bgstab-010-ac6-server-ack-fault.spec.ts` | 1 | 1 | 0 | 0 | 0 | 5s |
| `perf-bgstab-010-ac9-isolated.spec.ts` | 2 | 1 | 1 | 0 | 0 | 4s |
| `recovery-options.spec.ts` | 3 | 3 | 0 | 0 | 0 | 22s |
| `settings-2fa-qr.spec.ts` | 1 | 1 | 0 | 0 | 0 | 9s |
| `settings-password-policy.spec.ts` | 1 | 0 | 1 | 0 | 0 | 25s |
| `settings-resource-limits.spec.ts` | 4 | 4 | 0 | 0 | 0 | 16s |
| `terminal-authority.spec.ts` | 4 | 1 | 2 | 1 | 0 | 86s |
| `terminal-clipboard.spec.ts` | 6 | 0 | 6 | 0 | 0 | 72s |
| `terminal-context-menu-registered-items.spec.ts` | 19 | 7 | 6 | 1 | 5 | 216s |
| `terminal-keyboard-regression.spec.ts` | 14 | 1 | 13 | 0 | 0 | 214s |
| `terminal-korean-ime.spec.ts` | 6 | 1 | 4 | 1 | 0 | 74s |
| `terminal-mobile-scroll.spec.ts` | 2 | 0 | 0 | 0 | 2 | 0s |
| `terminal-paste.spec.ts` | 2 | 0 | 2 | 0 | 0 | 57s |
| `terminal-right-click-policy.spec.ts` | 2 | 2 | 0 | 0 | 0 | 7s |
| `terminal-shortcut-manager.spec.ts` | 2 | 0 | 2 | 0 | 0 | 32s |
| `terminal-title-auto-tab-name.spec.ts` | 1 | 0 | 1 | 0 | 0 | 12s |
| `wave1-retained-state-characterization.spec.ts` | 7 | 5 | 2 | 0 | 0 | 268s |
| `wave1-split-characterization.spec.ts` | 2 | 1 | 1 | 0 | 0 | 5s |
| `wave2-screen-repair-resync.spec.ts` | 2 | 0 | 2 | 0 | 0 | 43s |
| `wave2-terminal-restore.spec.ts` | 2 | 0 | 2 | 0 | 0 | 27s |
| `wave3-terminal-authority-fairness.spec.ts` | 8 | 2 | 6 | 0 | 0 | 97s |
| `wave3-terminal-authority-promotion.spec.ts` | 7 | 0 | 7 | 0 | 0 | 107s |
| **합계** | **155** | **55** | **84** | **9** | **7** | |

- 실패 0건인 파일: **8개** (`auth-bootstrap`, `mcp-control-dialog`, `perf-…-ac6`, `recovery-options`, `settings-2fa-qr`, `settings-resource-limits`, `terminal-right-click-policy`, `terminal-mobile-scroll`(전부 skip)).
- 실패 1건 이상인 파일: **22개**.
- 파일별 소요는 재시도 포함 누적이며 16 워커 병렬이라 **합계가 벽시계와 일치하지 않는다.**

### 2.2 `wave1-characterization-artifacts.test.ts` 관련 관측 (사전 고지 항목의 보강)

이 파일은 `node:test` 파일이라 Playwright 가 **테스트 0건 수집**하는 것이 맞다. 다만 로그 최상단에 아래가 찍혔다:

```
✔ REL-BGSTAB-006 AC-1 RED contract (19.4384ms)
✔ REL-BGSTAB-006 AC-4 RED contract (1.6166ms)
✔ REL-BGSTAB-006 AC-5 RED contract (0.7667ms)
```

`testDir: './tests/e2e'` 이므로 Playwright 가 **수집 단계에서 이 파일을 import 하고, 그 과정에서 `node:test` 의 `test()` 가 실제로 실행된다.** 수집 결과는 0건이지만 **부작용은 발생한다.** (별도 측정에서 3/3 pass 로 이미 기록된 그 3건과 동일하다.)

### 2.3 그룹 P — 원인 클러스터 분포

| 클러스터 | 건수 | 추정 원인 분류 |
|---|---:|---|
| **W-API** — 워크스페이스/탭 API precondition 실패 (500 32건 / 409 8건, 그중 `WORKSPACE_LIMIT_EXCEEDED` 3건) | **39** | **서버 노후**(고아 잔재) + **환경**(워커 16 vs `maxWorkspaces` 10) |
| **OTHER** — 도메인 어서션 불일치 | **25** | 대부분 **미커밋 작업**, 일부 **불명** (개별 표 참조) |
| **PANE** — `.pane-leaf` / `.status-prefix` 미존재 | **10** | **구조적 RED** (사전 고지 항목, 그대로 재현) |
| **TUI** — 터미널에 셸 프롬프트 대신 **Claude Code TUI** 가 렌더 | **7** | **환경** (§3.2) |
| **PS-EMPTY** — 시드 마커가 소실되고 빈 `PS C:\Users\beom>` 만 남음 | **3** | **서버 노후** 유력 / 일부 **불명** |
| **합계** | **84** | |

---

## 3. 그룹 P — 실패 목록 (84건 전수)

`ATT` = 시도 횟수 (2 = 재시도 후에도 실패, 1 = `retries` 소진 전 다른 이유로 1회만).
분류 코드: `W-API`(서버 노후/환경) · `PANE`(구조적 RED) · `TUI`(환경) · `PS`(서버 노후 유력) · `UNC`(미커밋 작업) · `?`(불명)

### 3.1 W-API 클러스터 — 39건 · 분류 **서버 노후 + 환경**

전부 **테스트 본문에 도달하기 전 precondition 단계**에서 죽었다. 즉 이 39건은 제품 로직에 대해 아무것도 말해주지 않는다.

| # | spec 파일 | 테스트명 | 실패 요지 | ATT |
|---|---|---|---|---|
| 3 | `grid-equal-mode.spec.ts:1362` | TC-6617 wide Equal insertion keeps up to three tabs in a single row | `Failed to delete stale E2E workspace 74ca98ea…: 500` | 2 |
| 4 | `grid-equal-mode.spec.ts:1381` | TC-6618 tall Equal insertion keeps up to three tabs in a single column | `Failed to delete stale E2E workspace f2f688a8…: 500` | 2 |
| 5 | `grid-equal-mode.spec.ts:1400` | TC-6619 wide Equal layouts use 4-8 logical row baselines | `Failed to delete stale E2E workspace 351262c0…: 500` | 2 |
| 6 | `grid-equal-mode.spec.ts:1435` | TC-6621 ultrawide Equal insertion chooses a single row for four tabs | `Failed to delete stale E2E workspace 63681e17…: 500` | 2 |
| 7 | `grid-equal-mode.spec.ts:1460` | TC-6620 tall Equal layouts use 4-8 transposed column baselines | `Failed to delete stale E2E workspace e978f629…: 500` | 2 |
| 8 | `grid-equal-mode.spec.ts:1497` | TC-6599 equal drag start keeps source geometry stable before drop | `Failed to delete stale E2E workspace 198f7cdc…: 500` | 2 |
| 9 | `grid-equal-mode.spec.ts:1607` | TC-6605 move button shell padding and edge remain draggable | `Failed to delete stale E2E workspace 452242d6…: 500` | 2 |
| 13 | `header-context-menu-regression.spec.ts:581` | TC-7004 reload should keep the active session visible… | `owned workspace create failed: 409` | 2 |
| 14 | `header-context-menu-regression.spec.ts:670` | TC-OWNERSHIP-7004 cleanup guard refuses an exact-ID name/token mismatch | `owned workspace create failed: 409` | 2 |
| 27 | `perf-bgstab-010-ac9-isolated.spec.ts:264` | visible fair-delivery ACK preserves idle through the real HTTPS WebSocket | `isolated AC-9 reusable idle W3-SOLE-WRITER workspace is unavailable` | 1 |
| 30 | `terminal-authority.spec.ts:410` | TC-7103 rapid workspace bounce should preserve output generated during handoff | `workspace delete failed: 500` | 2 |
| 31 | `terminal-clipboard.spec.ts:34` | unselected Ctrl+C sends exactly one SIGINT through the native xterm path | `clipboard workspace create failed: 500` | 2 |
| 32 | `terminal-clipboard.spec.ts:53` | selected Ctrl+C preserves selection when clipboard write fails | `stale clipboard workspace cleanup failed: 500` | 2 |
| 33 | `terminal-clipboard.spec.ts:97` | tab context copy and paste use one clipboard admission each and restore focus | `stale clipboard workspace cleanup failed: 500` | 2 |
| 34 | `terminal-clipboard.spec.ts:148` | Grid context copy rejection and paste use one clipboard admission each | `stale clipboard workspace cleanup failed: 500` | 2 |
| 36 | `terminal-clipboard.spec.ts:258` | late Grid clipboard read rejects when another tile becomes active | `clipboard workspace create failed: 409` | 2 |
| 43 | `terminal-keyboard-regression.spec.ts:336` | TC-7201 repeated space auto-repeat events should visibly advance the prompt line | `tab create failed: 500` | 2 |
| 44 | `terminal-keyboard-regression.spec.ts:363` | TC-7202 plain backspace should echo without newline-like output corruption | `workspace create failed: 500` | 2 |
| 45 | `terminal-keyboard-regression.spec.ts:382` | TC-7204 clicking the terminal surface should focus the xterm helper textarea | `workspace delete failed: 500` | 2 |
| 46 | `terminal-keyboard-regression.spec.ts:411` | TC-7203 debug capture start should expose browser-side input transport events | `workspace delete failed: 500` | 2 |
| 47 | `terminal-keyboard-regression.spec.ts:499` | TC-7209 server input rejection is routed into terminal debug capture | `workspace delete failed: 500` | 2 |
| 50 | `terminal-keyboard-regression.spec.ts:629` | TC-7212 stale WebSocket send failure queues during reconnect grace and flushes | `workspace create failed: 500` | 2 |
| 51 | `terminal-keyboard-regression.spec.ts:663` | TC-7213 socket.send exception queues, retries, and redacts input debug payloads | `workspace create failed: 500` | 2 |
| 56 | `terminal-korean-ime.spec.ts:225` | TC-IME-01 compositionend 직전 Space race… | `workspace create failed: 500` | 2 |
| 57 | `terminal-korean-ime.spec.ts:282` | TC-IME-03 IME 조합 중 Backspace… | `workspace create failed: 500` | 2 |
| 58 | `terminal-korean-ime.spec.ts:307` | TC-IME-04 IME 조합 중 transient capture close… | `tab create failed: 500` | 2 |
| 59 | `terminal-korean-ime.spec.ts:440` | TC-IME-06 compositionend 이후 xterm delayed textarea read… | `workspace delete failed: 500` | 2 |
| 62 | `terminal-shortcut-manager.spec.ts:32` | opens from tools menu and captures Escape and Tab through WindowDialog capture mode | `workspace create failed: 409` | 2 |
| 63 | `terminal-shortcut-manager.spec.ts:72` | applies ai-tui-compat profile and sends Shift+Enter… | `tab create failed: 500` | 2 |
| 64 | `terminal-title-auto-tab-name.spec.ts:209` | updates default tab name from terminal title and preserves manual rename lock | `workspace cleanup failed: 500` | 2 |
| 69 | `wave2-screen-repair-resync.spec.ts:551` | Frontend stale/resync barrier RED 계약 — AC-8 | `E2E precondition failed: temporary tab create returned 500; rollback verified` | 2 |
| 72 | `wave3-terminal-authority-fairness.spec.ts:2887` | REL-BGSTAB-012 preserves AI idle and mounted renderer residency during hidden recovery | `E2E precondition failed: workspace create returned 500` | 2 |
| 75 | `wave3-terminal-authority-fairness.spec.ts:1342` | sole writer remount — stale snapshot and early-ready frames stay fenced… | `E2E precondition failed: workspace create returned 409` | 1 |
| 78 | `wave3-terminal-authority-promotion.spec.ts:4141` | positional all-view handoff | `409 {"code":"WORKSPACE_LIMIT_EXCEEDED","message":"Maximum workspaces exceeded"}` | 1 |
| 79 | `wave3-terminal-authority-promotion.spec.ts:5049` | query byte parity and seed silence | `409 WORKSPACE_LIMIT_EXCEEDED` | 1 |
| 80 | `wave3-terminal-authority-promotion.spec.ts:5275` | connection replacement retargets output policy without recreating xterm | `authority workspace tab create returned 500` | 1 |
| 81 | `wave3-terminal-authority-promotion.spec.ts:5324` | poisoned no-cache reload | `500 {"code":"INTERNAL_ERROR","message":"Internal server error"}` | 1 |
| 82 | `wave3-terminal-authority-promotion.spec.ts:7307` | compatibility-drain rollback | `authority workspace tab create returned 500` | 1 |
| 83 | `wave3-terminal-authority-promotion.spec.ts:8073` | stale reconnect no-replay | `409 WORKSPACE_LIMIT_EXCEEDED` | 1 |

### 3.2 TUI 클러스터 — 7건 · 분류 **환경**

터미널 화면에 PowerShell 프롬프트 대신 **Claude Code 의 폴더 신뢰 확인 화면**이 렌더돼 기대 마커를 찾지 못했다. 실제 수신 문자열 예:

```
Accessing workspace: C:\Users\beom
Quick safety check: Is this a project you created or one you trust? …
Claude Code'll be able to read, edit, and execute files here.
```
```
__parse_error__: no PowerShell prompt in visible terminal rows:
  ["", " ❯ 1. Yes, I trust this folder", "   2. No, exit", "", " Enter to confirm · Esc to cancel", …]
```

이 시그니처는 전체 로그에서 **21회** 나타난다 (실패 84건 중 7건이 이것 때문에 최종 실패).

**관측된 근거**: `server/data/recovery-options.json` (gitignored, 머신 로컬) 에 `"command": "claude"` 와 `"command": "claudep"` 항목이 등록돼 있다. `server/config.json5` 자체에는 `claude` 문자열이 없고 `pty.shell` 은 `"auto"` 다. **이 이상은 진단하지 않았다** — 어떤 경로로 그 커맨드가 PTY 에 들어갔는지는 이 측정의 범위 밖이다.

| # | spec 파일 | 테스트명 | ATT |
|---|---|---|---|
| 1 | `command-management-dialog.spec.ts:90` | supports CRUD, copy toast, tab persistence, and terminal execute rules | 2 |
| 15 | `header-context-menu-regression.spec.ts:713` | TC-7005 reload should prefer server history over a poisoned local snapshot | 2 |
| 16 | `header-context-menu-regression.spec.ts:755` | TC-7006 empty fallback should restore only validated local viewport snapshots | 2 |
| 37 | `terminal-context-menu-registered-items.spec.ts:75` | pastes a registered command without sending Enter on desktop | 2 |
| 39 | `terminal-context-menu-registered-items.spec.ts:127` | pastes a registered directory without generating cd command on desktop | 2 |
| 40 | `terminal-context-menu-registered-items.spec.ts:147` | pastes a registered prompt as a single-line value on desktop | 2 |
| 41 | `terminal-context-menu-registered-items.spec.ts:275` | pastes a registered command from the Grid Mode terminal context menu | 2 |

### 3.3 PANE 클러스터 — 10건 · 분류 **구조적 RED** (사전 고지 항목, 그대로 재현)

`pane-split` 5 + `pane-keyboard` 3 + `pane-persistence` 2 = **정확히 10건**. 세 spec 파일 모두 `git status` 상 **깨끗**(수정 없음)하다. 실패 형태는 전부 "DOM 에 해당 엘리먼트가 아예 없음" 이다 — `locator('.pane-leaf')` 0개, `locator('.status-prefix')` not found. `CLAUDE.md` 가 기록한 "`Sidebar/`·`StatusBar/` 등이 `App.tsx` 렌더 트리에 연결돼 있지 않다" 와 일치한다.

| # | spec 파일 | 테스트명 | 실패 요지 | ATT |
|---|---|---|---|---|
| 17 | `pane-keyboard.spec.ts:10` | TC-6601 Ctrl+B enters prefix mode | `.status-prefix` element(s) not found (2s) | 2 |
| 18 | `pane-keyboard.spec.ts:16` | TC-6606 prefix mode auto-exits after 1500ms | `.status-prefix` element(s) not found (5s) | 2 |
| 19 | `pane-keyboard.spec.ts:23` | TC-6602 Ctrl+B, % splits vertically | `.pane-leaf` Expected 2 / Received 0 | 2 |
| 20 | `pane-persistence.spec.ts:5` | TC-6401 should restore layout after refresh | `locator.click` timeout, `.pane-leaf` 없음 | 2 |
| 21 | `pane-persistence.spec.ts:27` | TC-6403 should work without IndexedDB | `.pane-leaf` Expected 1 / Received 0 | 2 |
| 22 | `pane-split.spec.ts:10` | TC-6101 should split pane vertically | `.pane-leaf` 대기 timeout | 2 |
| 23 | `pane-split.spec.ts:17` | TC-6103 should close pane and expand sibling | `.pane-leaf` 대기 timeout | 2 |
| 24 | `pane-split.spec.ts:31` | TC-6105 should resize pane by dragging border | `.pane-leaf` 대기 timeout | 2 |
| 25 | `pane-split.spec.ts:46` | TC-6107 should zoom and unzoom pane | `.pane-leaf` 대기 timeout | 2 |
| 26 | `pane-split.spec.ts:61` | TC-6104 last pane close should be disabled | `.pane-leaf` 대기 timeout | 2 |

### 3.4 PS-EMPTY 클러스터 — 3건 · 분류 **서버 노후 유력**

터미널이 살아 있고 프롬프트도 정상(`PS C:\Users\beom>`)인데, **테스트가 심어 둔 마커 출력이 화면에서 사라졌다.** 스냅샷/복구 경로가 대상인 테스트들이라 워크스페이스 오염과 구분이 어렵다.

| # | spec 파일 | 테스트명 | 실패 요지 | ATT |
|---|---|---|---|---|
| 29 | `terminal-authority.spec.ts:287` | TC-7101 hidden workspace should recover through server snapshots after refresh | 기대 `hidden-latest-1787068912959` 미출력, 화면은 빈 프롬프트 (30s) | 2 |
| 65 | `wave1-retained-state-characterization.spec.ts:1820` | AC-1~7 executes the six-case matrix through real browser refresh | 기대 `W1-logical-lines-24-FINAL` 미출력 (120s) | 1 |
| 66 | `wave1-retained-state-characterization.spec.ts:1854` | REL-BGSTAB-012 preserves local terminal snapshot cache through authority recovery | 기대 `W1-legacy-2mib-before-FINAL` 미출력 (120s) | 1 |

### 3.5 OTHER 클러스터 — 25건 · 도메인 어서션 불일치

| # | spec 파일 | 테스트명 | 실패 요지 | ATT | 분류 |
|---|---|---|---|---|---|
| 2 | `command-management-dialog.spec.ts:199` | keeps delete confirmation open when the server rejects deletion | 기대 `/Request failed\|delete failed\|삭제/`, 실제 `"HTTP 500: Internal Server Error"` | 2 | **서버 노후** (500 이 원인, 문구만 불일치) |
| 10 | `grid-equal-mode.spec.ts:1660` | TC-6611 middle mouse repair performs resize before screen repair | predicate 10s timeout, `true` 기대 `false` | 2 | `?` |
| 11 | `grid-equal-mode.spec.ts:1677` | TC-6616 middle mouse repair preserves focused grid terminal | predicate 10s timeout, `true` 기대 `false` | 2 | `?` |
| 12 | `header-context-menu-regression.spec.ts:540` | TC-7003 closing a tab should not resurrect its deleted terminal snapshot | deep equality — `snapshot: null` 기대인데 값이 남음 | 2 | `?` |
| 28 | `settings-password-policy.spec.ts:172` | TC-2401 password rotation enforces FR-AUTH-015… | `.settings-card` (Authentication) `input[type=password]` fill 10s timeout | 2 | `?` |
| 35 | `terminal-clipboard.spec.ts:213` | late clipboard read during IME target switch rejects the old target… | `.xterm-helper-textarea:focus` Expected 1 / Received 0 | 2 | `?` |
| 38 | `terminal-context-menu-registered-items.spec.ts:97` | routes a registered command through the clipboard coordinator exactly once | Expected 1 / Received 0 (10s) | 2 | **환경** (동 파일 TUI 클러스터와 동반) |
| 42 | `terminal-context-menu-registered-items.spec.ts:336` | rejects a registered multiline prompt when the terminal lacks paste-safe multiline mode | `true` 기대 `false` (5s) | 2 | **환경** (동상) |
| 48 | `terminal-keyboard-regression.spec.ts:547` | TC-7210 printable input is coalesced while Enter remains an ordered boundary | `enterSeq`/`printableRange` 등 5개 필드 부재 | 2 | **미커밋 작업** |
| 49 | `terminal-keyboard-regression.spec.ts:596` | TC-7211 queue mode retries a transient WebSocket send failure without losing input | `flushed/forced/queued` 4필드 불일치 | 2 | **미커밋 작업** |
| 52 | `terminal-keyboard-regression.spec.ts:702` | TC-7214 Hangul insertText followed by Space stays observable… | `hangulSeen: true` 기대 `false` | 2 | **미커밋 작업** |
| 53 | `terminal-keyboard-regression.spec.ts:733` | TC-7206 queue mode preserves printable input across a transient transport barrier | `barrierReason: "repair-server-not-ready"` 불일치 | 2 | **미커밋 작업** |
| 54 | `terminal-keyboard-regression.spec.ts:847` | TC-7208 queued input is rejected when session generation changes before flush | `true` 기대 `false` (5s) | 2 | **미커밋 작업** |
| 55 | `terminal-keyboard-regression.spec.ts:890` | TC-7205 rapid PowerShell A+Enter repeats should render sequential command-not-found output | `>= 3` 기대 `0` (15s) | 2 | `?` |
| 60 | `terminal-paste.spec.ts:24` | TC-PASTE-01 Ctrl+V 붙여넣기 시 단 한 번만 전송 | `page.click` 10s timeout — `.xterm-screen` 이 **9개** 로 해석, 첫 요소가 unstable | 2 | **환경** (워크스페이스 오염으로 잔여 터미널 다수) |
| 61 | `terminal-paste.spec.ts:70` | TC-PASTE-02 연속 Ctrl+V 는 각각 한 번씩만 전송 | 동일. `.xterm-screen` **11개** | 2 | **환경** (동상) |
| 67 | `wave1-split-characterization.spec.ts:351` | REL-BGSTAB-006 AC-2 RED contract | 소스 텍스트 스캔 — `WebSocketContext.tsx` 에 ``return `${protocol}//${host}/ws?token=`` 패턴 없음 | 1 | **미커밋 작업** (`WebSocketContext.tsx` = ` M`, spec 자체 = `??`) |
| 68 | `wave2-screen-repair-resync.spec.ts:406` | Frontend stale/resync barrier RED 계약 — AC-4 | restore-needed 가 stale barrier 를 걸지 않음 / prefix·tail 손실·중복·재정렬 | 2 | **미커밋 작업** 유력 |
| 70 | `wave2-terminal-restore.spec.ts:163` | Remount adapter RED — same-session remount fence | `current transaction or injected old snapshot was not observed` | 1 | **미커밋 작업** (spec = `??`) |
| 71 | `wave2-terminal-restore.spec.ts:269` | Remount adapter RED — bounded retries and ownership | `debug capture toggle failed: 404` | 1 | `?` (404 = 라우트 부재. 500/409 클러스터와 성격이 다름) |
| 73 | `wave3-terminal-authority-fairness.spec.ts:2988` | REL-BGSTAB-012 routes hidden dataGap to only its browser view | `[data-session-id=fbdc679c…] .xterm-helper-textarea` hidden (15s) | 2 | `?` |
| 74 | `wave3-terminal-authority-fairness.spec.ts:1284` | sole writer refresh — no-cache hard refresh restores the same live session | `terminal command did not complete after marker W3-SOLE-WRITER-REFRESH-…` | 1 | **서버 노후** 유력 |
| 76 | `wave3-terminal-authority-fairness.spec.ts:2576` | sole writer refresh remount faults — wire capability and coordinator faults fail closed | `flushed: 3/sent: 1` 기대, 실제 `flushed: 0/sent: 0` | 1 | `?` |
| 77 | `wave3-terminal-authority-fairness.spec.ts:2760` | PERF-BGSTAB-010 fair delivery browser ACK follows a visible write and preserves idle | `PH-003 evidence guard rejected: {"executed":6,"expected":6,…}` — **모든 하위 플래그가 통과값인데 가드가 거부** | 1 | `?` (가드 판정 로직 자체를 봐야 함) |
| 84 | `wave3-terminal-authority-promotion.spec.ts:8317` | fault PTY/AI idle | `MIG-BGSTAB-002 AC-6 fault abort/PTY continuity/AI idle contract is absent` (22필드 기대 / 6필드 수신) | 1 | **미커밋 작업** |

### 3.6 flaky 9건 (1차 red → 재시도 green). fail 로 세지 않았으나 green 도 아니다

| spec 파일 | 테스트명 |
|---|---|
| `grid-equal-mode.spec.ts:1577` | TC-6604 right-click and non-primary pointer do not trigger reorder |
| `grid-equal-mode.spec.ts:1637` | TC-6609 move button follows toolbar hover visibility |
| `grid-equal-mode.spec.ts:1722` | TC-6613 running to idle does not request grid repair |
| `grid-equal-mode.spec.ts:1794` | TC-6620 long scrollback grid repair does not full replay |
| `header-context-menu-regression.spec.ts:471` | TC-7001 grid pane focus should update header cwd to the clicked terminal |
| `mcp-control-dialog.spec.ts:159` | discards a fixed access key response completed after leaving the security tab |
| `terminal-authority.spec.ts:377` | TC-7102 restart should invalidate old session snapshot lineage |
| `terminal-context-menu-registered-items.spec.ts:166` | opens desktop submenu by keyboard activation |
| `terminal-korean-ime.spec.ts:377` | TC-IME-05 IME 조합 중 repair layout은 최신 composition settle 이후에만 실행된다 |

### 3.7 skip 7건

| spec 파일 | 테스트명 |
|---|---|
| `terminal-context-menu-registered-items.spec.ts:471` | renders mobile dialog with focus entry and button-list ARIA contract |
| `terminal-context-menu-registered-items.spec.ts:487` | uses mobile dialog path navigation with header and browser back |
| `terminal-context-menu-registered-items.spec.ts:508` | closes child mobile dialog with backdrop and restores previous focus |
| `terminal-context-menu-registered-items.spec.ts:533` | pastes a registered mobile leaf exactly once |
| `terminal-context-menu-registered-items.spec.ts:550` | reopens mobile context menu at the root after nested close |
| `terminal-mobile-scroll.spec.ts:337` | TC-MOBILE-01 single-touch vertical drag should move terminal scrollback |
| `terminal-mobile-scroll.spec.ts:374` | TC-MOBILE-02 two-touch pinch should keep changing terminal font size |

모두 모바일 전용 케이스로, `Desktop Chrome` project 에서 skip 되는 것이 정상이다.

---

## 4. 그룹 E′ — `tools/wave3/authority-promotion-evidence.test.mjs`

| 항목 | 값 |
|---|---|
| exit | **1** |
| 소요 | **1초 미만** |
| Playwright E2E 실행 여부 | **아니오 — 실행되지 않았다** |

**사전 경고와 달리 이 스크립트는 이번 실행에서 Playwright 를 돌리지 않았다.** `main()` 이 `validateSourceIdentity()` (`authority-promotion-evidence.test.mjs:1676`) 에서 즉시 throw 하며, 그 지점은 E2E spawn 보다 **앞**이다.

실패 내용:

```
AssertionError [ERR_ASSERTION]: source test identity mismatch:
  server/src/services/TerminalAuthorityController.test.ts
```

동결된 테스트명 목록에 없는 **9개 테스트명이 추가로 발견**됐다:

- `REL-BGSTAB-007 applies configured retained policy before delivery`
- `REL-BGSTAB-007 fences active server recovery at an Ordinal64 retained-stream rollover until a fresh checkpoint settles`
- `REL-BGSTAB-007 invalidates a settled delivery proof synchronously when split output is replaced`
- `REL-BGSTAB-007 invalidates a settled delivery proof when split output re-pairs on the same view generation`
- `REL-BGSTAB-007 isolates driver lease ledger and rollback epoch`
- `REL-BGSTAB-007 preserves unaffected settled view proof across another split output re-pair`
- `REL-BGSTAB-007 rekeys active server authority for every retained-stream rollover`
- `REL-BGSTAB-007 validates Ordinal64 checkpoint apply and drain`
- `REL-BGSTAB-012 preserves retained authority across peer disconnect and recovery rollback`

**추정 원인 분류: 미커밋 작업.** 근거: `git status --porcelain server/src/services/TerminalAuthorityController.test.ts` → **`??` (미추적)**. 즉 HEAD 에 존재하지 않는 파일이 동결 목록과 대조되고 있다.

JSON 산출도 `contractSatisfied: false` 로 나왔다 (`schemaVersion: "authority-promotion-evidence/v2"`).

**플래그는 하나도 주지 않았다** (`--expect-red` / `--regenerate-green` 모두 미사용). 아티팩트 재생성 없음.

---

## 5. 실행 커맨드 전문

### 5.1 그룹 P

cwd = `C:\Work\git\_Snoworca\ProjectMaster\frontend`, Git Bash.

```bash
cd /c/Work/git/_Snoworca/ProjectMaster/frontend
SP="<scratchpad>"
env -u NODE_ENV -u NoDefaultCurrentDirectoryInExePath \
  -u BUILDERGATE_CONFIG_PATH -u BUILDERGATE_SHELL_INTEGRATION_ROOT -u BUILDERGATE_RUNTIME_ROOT \
  -u BUILDERGATE_SUPPRESS_TOTP_QR -u BUILDERGATE_INTERNAL_MODE -u BUILDERGATE_DAEMON_STATE_GENERATION \
  -u BUILDERGATE_SERVER_ROOT -u BUILDERGATE_ROOT -u BUILDERGATE_WEB_ROOT -u BUILDERGATE_DAEMON_START_ID \
  -u BUILDERGATE_DAEMON_STATE_PATH -u BUILDERGATE_EXECUTABLE_NAME -u BUILDERGATE_DAEMON_LOG_PATH \
  -u BUILDERGATE_TOTP_SECRET_PATH -u BUILDERGATE_SHUTDOWN_TOKEN \
  PLAYWRIGHT_JSON_OUTPUT_NAME="$SP/pw-desktop-chrome.json" \
  npx playwright test --project "Desktop Chrome" --reporter=list,json > "$SP/pw-list.log" 2>&1
echo "PW_EXIT=$?"      # → PW_EXIT=1
```

`NoDefaultCurrentDirectoryInExePath` 를 빼지 않으면 §1.1 대로 `webServer` 가 1초 만에 죽는다.

### 5.2 그룹 E′

cwd = `C:\Work\git\_Snoworca\ProjectMaster` (저장소 루트). 환경변수 제거 목록은 §5.1 과 **동일**(`PLAYWRIGHT_JSON_OUTPUT_NAME` 만 제외).

```bash
cd /c/Work/git/_Snoworca/ProjectMaster
env -u NODE_ENV -u NoDefaultCurrentDirectoryInExePath -u BUILDERGATE_… (동일 15개) \
  node tools/wave3/authority-promotion-evidence.test.mjs > "$SP/ep.log" 2>&1
echo "EP_EXIT=$?"      # → EP_EXIT=1
```

그룹 P 완료 **후** 실행했다 (동시 실행 없음).

### 5.3 실행하지 않은 것

- `--regenerate-green` 등 아티팩트 재생성 플래그 — 사용 안 함
- `Mobile Safari` / `Tablet` project — 시간 예산 때문에 제외 (저장소 `test:e2e:*` 스크립트도 `Desktop Chrome` 고정)
- `frontend/tests/e2e/wave1-characterization-artifacts.test.ts` 의 직접 실행 — 별도 측정에서 완료됨
- 프로세스 kill / `taskkill` / 데이터 정리 — 일절 하지 않음

---

## 6. 측정 무결성

- 추적 파일 수정 **0건**. 이 문서(`docs/research/binary-comms/baseline/e2e-baseline.md`) 만 신규 생성.
- 커밋 **0건**.
- 실행으로 변경된 파일은 전부 **gitignored** 다: `server/data/workspaces.json` (`.gitignore:52`), `server/data/recovery-options.json` (`.gitignore:60`), `server/config.json5` (`.gitignore:48`).
- 루트에 png 생성 없음. Playwright 는 실패 스크린샷을 `frontend/test-results/` 에 남긴다 (Playwright 기본 경로, 본 측정이 지정한 것이 아님).
- **중단 없음** — 그룹 P·E′ 모두 끝까지 측정했다. 미측정 항목 없음.
