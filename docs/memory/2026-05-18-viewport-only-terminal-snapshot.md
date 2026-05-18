# 2026-05-18 Viewport-Only Terminal Snapshot Work Memory

## Summary

긴 Codex/AI TUI 대화가 쌓인 터미널에서 브라우저 새로고침, WebSocket 재연결, session 재구독 시 과거 scrollback 전체가 다시 주입되며 오래 스크롤되는 문제를 줄이기 위해 viewport-only snapshot 복원 구조를 설계하고 구현했다.

이번 작업은 current viewport 복원에 한정한다. 서버 scrollback lazy loading, 과거 scrollback range 조회, 사용자가 올려둔 scroll 위치까지의 복원은 구현하지 않았다.

## Requirements And Plan Artifacts

- SRS 업데이트: `docs/srs/buildergate.srs.md`
- 구현 계획: `docs/plan/2026-05-15.viewport-only-terminal-snapshot.plan.md`
- 계획 sidecar: `docs/plan/2026-05-15.viewport-only-terminal-snapshot.plan.md.json`
- Dew 실행 가드: `.snoworca/dew/planner/plan-20260515-viewport-only-snapshot/`

핵심 요구사항은 `FR-SESS-007`, `FR-SESS-008`, `FR-SESS-015`, `FR-SESS-016`, `FR-SESS-017`, `FR-SESS-018`, `FR-WS-005`, `FR-WS-006`, `FR-WS-007`, `AC-009`, `AC-017`, `AC-020`, `AC-023`이다.

## Implementation Notes

### Server

- `server/src/utils/headlessTerminal.ts`
  - `VIEWPORT_ONLY_SERIALIZE_OPTIONS = { scrollback: 0 }`를 추가했다.
  - `serializeHeadlessTerminal()` 기본 동작을 `serialize({ scrollback: 0 })`로 변경했다.
  - snapshot 크기 제한은 `Buffer.byteLength(data, 'utf8')` 기준으로 판정한다.

- `server/src/services/SessionManager.ts`
  - snapshot cache에 `scope: 'viewport-only'`를 추가했다.
  - cache hit은 scope, seq, cols, rows가 모두 맞을 때만 인정한다.
  - degraded snapshot은 더 이상 `degradedReplayBuffer`를 `screen-snapshot.data`로 보내지 않는다.
  - degraded fallback은 placeholder/empty 중심으로 유지하고, 기존 degraded buffer는 진단용으로만 남긴다.
  - snapshot observability byte count도 UTF-8 byte 기준으로 맞췄다.

- `server/src/ws/WsRouter.ts`
  - `refreshReplaySnapshots()`에서 fallback/empty/truncated snapshot이 큐된 output을 대체한다고 가정하지 않도록 수정했다.
  - refreshed snapshot이 authoritative이고 non-empty일 때만 `pending.queuedOutput`을 비운다.
  - fallback/empty refresh 후 ACK가 오면 큐된 output을 한 번 flush한다.

- `server/src/test-runner.ts`
  - headless long scrollback viewport-only 직렬화 테스트를 추가했다.
  - UTF-8 byte cap 테스트를 추가했다.
  - degraded fallback이 오래된 payload를 보내지 않는 테스트 기대값을 갱신했다.
  - subscribe/resubscribe wire payload가 old marker를 제외하고 latest marker를 포함하는지 검사한다.
  - fallback replay refresh가 queued output을 drop하지 않는 회귀 테스트를 추가했다.

### Frontend

- `frontend/src/utils/terminalSnapshot.ts`
  - terminal snapshot schema v2를 추가했다.
  - `payloadKind: 'viewport-only'`, `cols`, `rows`, `bufferType`, `savedAt` 검증을 추가했다.
  - schema v1, corrupt JSON, wrong session, empty content, oversized content, invalid geometry, invalid buffer type, line-budget 초과 payload는 복원하지 않는다.

- `frontend/src/components/Terminal/TerminalView.tsx`
  - localStorage 저장 시 `serialize({ scrollback: 0 })`만 저장한다.
  - in-flight output이나 buffered output을 snapshot content에 문자열로 덧붙이지 않는다.
  - restore 전 `cols`/`rows`가 현재 xterm geometry와 다르면 저장소를 지우고 복원하지 않는다.
  - fresh xterm은 normal buffer에서 시작하므로 `bufferType` mismatch만으로 alternate-buffer snapshot을 거부하지 않는다.
  - 서버 snapshot 적용 후에도 localStorage에 legacy/corrupt snapshot이 남지 않도록, dedupe 전에 현재 저장소가 유효한 v2인지 확인한다.

- `frontend/src/components/Terminal/TerminalContainer.tsx`
  - fallback + empty data일 때만 validated local fallback restore를 시도한다.
  - local fallback restore debug event에 `snapshotScope: 'viewport-only'`를 기록한다.
  - snapshot/repair/live output debug `byteLength`는 `TextEncoder().encode(data).length` 기준으로 맞췄다.

### E2E Coverage

- `frontend/tests/e2e/header-context-menu-regression.spec.ts`
  - reload 후 localStorage schema v2 viewport-only payload를 검사한다.
  - old marker가 localStorage/visible viewport에 남지 않는지 검사한다.
  - schema v1 poison과 geometry-mismatched v2 poison을 복원하지 않는지 검사한다.
  - empty fallback에서 valid v2 alternate-buffer local snapshot이 실제 browser/xterm 경로로 복원되는지 검사한다.

- `frontend/tests/e2e/terminal-authority.spec.ts`
  - WebSocket capture helper를 추가했다.
  - hidden workspace/reconnect/resubscribe 경로의 inbound `screen-snapshot.data`가 latest marker를 포함하고 old marker를 제외하는지 검사한다.
  - raw WS unsubscribe/subscribe로 same-session resubscribe snapshot 관측을 강제한다.

- `frontend/tests/e2e/grid-equal-mode.spec.ts`
  - screen repair payload가 latest marker를 포함하고 old marker를 제외하는지 검사한다.
  - repair 후 `screen-snapshot` full replay로 fallback하지 않는 기존 검사를 유지한다.

## Verification Performed

Passed:

- `npm --prefix server run build`
- `npm --prefix server run test` with 222 tests passing at the time of execution
- `npm --prefix frontend run typecheck`
- `npm --prefix frontend run build`
- `node --experimental-strip-types --test frontend/tests/unit/terminalSnapshot.test.ts`
- 2222-targeted Playwright checks using a temporary config:
  - `TC-7004`, `TC-7005`, `TC-7006`
  - `TC-7101`
  - `TC-6620`

Review:

- Strict reviewer sub-agent found two issues:
  - server snapshot restore could leave legacy/corrupt localStorage because `lastSnapshotRef` dedupe skipped schema v2 rewrite.
  - authority E2E allowed missing resubscribe `screen-snapshot` to pass.
- Both were fixed.
- Re-review result: `No findings`.

Known caveats:

- Full `npm --prefix frontend run lint` failed due to pre-existing unrelated lint errors in other files, including React Compiler ref access, memoization preservation, `no-control-regex`, and unused variables.
- A scoped eslint run on touched files still reports pre-existing `TerminalView` React ref access warnings/errors around `imeTransactionRef` render-time configuration; this was not introduced by the viewport-only snapshot change.
- Full header E2E file on port 2222 had an unrelated existing `TC-7001` failure where `.header-cwd-path` was absent in the current workspace state. The changed viewport snapshot tests were run separately and passed.
- Some Playwright runs showed retry-based flakiness before test stabilization. After stabilization, `TC-7006` passed in a focused run.

## Local Dev Server Note

During validation, a dev server was started on:

- HTTPS: `https://localhost:2222`
- HTTP redirect: `http://localhost:2221`
- Vite: `http://localhost:2223`

It was started with `node dev.js --port 2222` under `NODE_ENV=development` so the server proxies to the current Vite source instead of packaged static assets. Logs were written to:

- `.snoworca/dev-2222.out.log`
- `.snoworca/dev-2222.err.log`

Check whether it is still running before assuming availability:

```powershell
curl.exe -k https://localhost:2222/health
Get-NetTCPConnection -LocalPort 2222 -State Listen
```

## Important Boundaries

- Do not add server scrollback lazy loading as part of this work unless a new requirement/plan explicitly asks for it.
- Do not change UI visuals, labels, icons, or layout for this feature.
- Do not restore legacy schema v1 `terminal_snapshot_*` payloads.
- Do not append raw pending output into localStorage snapshot content.
- Do not make `ScreenSnapshotMessage` require new fields for this feature; current implementation preserves wire compatibility.

