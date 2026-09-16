# Issue #34 — UI workspace/tab capacity follows the server configuration (ratification)

Issue Snoworca/BuilderGate#34 reported that `frontend/src/App.tsx` hardcoded
`maxWorkspaces={10}` and `maxTabsPerWorkspace={8}` while the server enforced the
same two concepts from `config.json5`.

**The premise no longer holds at HEAD.** Commit `da0e347` (2026-09-08,
"fix: 워크스페이스와 탭 UI에 서버 한도 적용", requirement FR-BGSTAB-026 AC-3~7)
removed both constants three days after the 2026-09-05 survey the issue cites.
This directory is the runtime ratification of that fix, which the existing
evidence row VE-2 explicitly did not cover ("Unit/actual function-render
evidence, not HTTPS E2E").

## What the code does now

| Hop | Location |
| --- | --- |
| Operator setting | `server/config.json5` → `workspace.maxWorkspaces`, `workspace.maxTabsPerWorkspace` |
| Enforcement | `server/src/services/WorkspaceService.ts:454`, `:560`, `:726` |
| Publication | `server/src/routes/workspaceRoutes.ts:36` — `res.json({ ...state, limits: workspaceService.getLimits() })` (authenticated `GET /api/workspaces`) |
| Client validation | `frontend/src/services/api.ts:354-375` — rejects a missing/typed-wrong/out-of-range pair as `invalid-workspace-limits` |
| Client state | `frontend/src/hooks/useWorkspaceManager.ts:211` — `setLimits(state.limits)` |
| UI | `frontend/src/App.tsx:606`, `:607`, `:662`, `:842` — all four props read `wm.limits.*` |

The two values are **not** in the public `/runtime-config` snapshot, and are not
registered keys of `RuntimeConfigStore` at all (no `applyScope`). FR-BGSTAB-026
AC-5 makes that deliberate: the limits ride the already-authenticated workspace
endpoint instead. Given #37's finding that `/runtime-config` is intentionally
unauthenticated (`OPS-BGSTAB-004`), keeping them off it is the safer of the two
shapes the issue proposed.

Because they are not `RuntimeConfigStore` keys, the two limits are read once at
startup: changing them takes a server restart, which is how both runs below were
performed.

## Runtime evidence

External runtime owned by this run: this checkout's `server/dist/index.js`,
started directly with `NODE_ENV=production PORT=2222`, every inherited
`BUILDERGATE_*` stripped (verified `0` matches in `/proc/<pid>/environ`), no
daemon and no `start.bat`. Playwright ran under
`frontend/playwright.issue34-capacity.config.ts`, which sets `webServer: undefined`
so a run can never start or stop a server.

| Run | Server config | Asserted | Result | Log |
| --- | --- | --- | --- | --- |
| A | — | (no env) | 2 skipped | `final-run-skip-20260916T0205Z.log` |
| B | 4 / 3 | 4 / 3 | 2 passed | `final-run-a-4-3-20260916T0205Z.log` |
| C | 5 / 2 | 5 / 2 | 2 passed | `final-run-b-5-2-20260916T0210Z.log` |
| D | 5 / 2 | 4 / 3 | 2 failed | `final-run-negative-20260916T0210Z.log` |

B and C are the load-bearing pair: the same spec, against two different
configured pairs, observed the UI report `Maximum 4 workspaces` / `Maximum 3 tabs`
and then `Maximum 5 workspaces` / `Maximum 2 tabs`. The limit *tracks* the
configuration rather than coinciding with one constant, and neither pair is the
old hardcoded 10/8. D is the negative control: the assertions are falsifiable.

Server stdout for the two runs: `final-server-a-4-3-…log`, `final-server-b-5-2-…log`.
These contain `[Auth] Token issued: jti=…` lines. A `jti` is an opaque
identifier, not token material, and the issuing server is gone; no password,
secret or bearer value appears in any file here.

### Screenshots

Under `.playwright-mcp/`, which root `.gitignore:82` excludes, so the hashes are
recorded here instead.

| File | SHA256 |
| --- | --- |
| `.playwright-mcp/issue34-max-workspaces-4.png` | `fbb282832238ff07cdc8d3dcaa46734b25c77b2f4d187a2b2f56379f81eaab62` |
| `.playwright-mcp/issue34-max-tabs-3.png` | `ee96fba4d6e7a613b4971ccb67599b399237082b554027f4084233427f92bd31` |
| `.playwright-mcp/issue34-max-workspaces-5.png` | `64f836cad093760ce4ea39f6579380efe4069523430e031b395892c62df2c2c0` |
| `.playwright-mcp/issue34-max-tabs-2.png` | `66ef836ebee508f1dcaf47234360132b89b25ad6fdf711e00898ae5c2ebd8485` |

`issue34-max-workspaces-5.png` shows five workspaces in the sidebar with the `+`
control greyed out. Under the removed hardcoded `10` that control would still be
enabled.

## Static evidence rerun at this tree

- `frontend`: `node --experimental-strip-types --test tests/unit/workspaceCapacityApi.test.ts tests/unit/workspaceCapacityHook.test.ts tests/unit/workspaceCapacityUi.test.ts` → 26/26 pass. These already drive the real `App` against capacities 3, 20, 3.5, 10, 2, 12 and 4.5.
- `frontend`: `node --experimental-strip-types --test tests/unit/e2eOwnershipTypecheck.test.ts` → 15/15 pass, with the new spec and config added to `tsconfig.e2e-ownership.json`.
- `frontend`: `npx tsc --noEmit -p tsconfig.e2e-ownership.json` → exit 0.

## Workspace ownership

Every workspace created here came from this run's own successful `POST
/api/workspaces`, registered through `tests/e2e/workspaceLeakGuard.ts`, and was
released by the same owner id in a `finally`. The pre-existing `Workspace-1` was
never deleted. Every run ended with the global teardown reporting
`deleted=0, absent=0, failed=0`.

## Port observations

`final-netstat-pre-20260916T0205Z.txt` and `final-netstat-post-20260916T0213Z.txt`
bracket runs A–D. TCP 2001 and 2002 are `LISTENING` under PID 30596 in both,
before and after — the production instance was never touched. WSL-side
`ss -ltn` showed 2221/2222 free after each teardown. Teardown killed only the
single PID whose `/proc/<pid>/cmdline` was `node dist/index.js` and whose
`/proc/<pid>/cwd` was this checkout's `server/`; the `netstat.exe` PID column was
never used to identify it, since for a WSL-hosted listener it reports the WSL
relay's Windows PID.
