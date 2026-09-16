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

## Two capture generations

`raw/` holds two generations, both real, both retained.

- **r1** — the `final-*.log` / `final-*.txt` files, captured 2026-09-16T02:05Z–02:13Z.
  Real runs, but thin: the pass logs recorded only the asserted env pair, so the
  claim "the server was configured 4/3" rested on the filename and on prose. The
  `/proc` kill-identity and the `BUILDERGATE_*`-count were asserted in prose with
  no artifact, and the static reruns had no committed log at all.
- **r2** — the `r2-*` files, captured 2026-09-16T02:06Z–02:11Z with full
  instrumentation. **This is the primary evidence.** Each load-bearing run is
  self-describing: the log itself carries the `server/config.json5` block in
  force, the process identity, the `limits` the server actually published, and
  the env pair — so no claim depends on a filename.

r1 is kept because it is a genuine capture of genuine runs, not because anything
below rests on it.

## What the code does now

| Hop | Location |
| --- | --- |
| Operator setting | `server/config.json5` → `workspace.maxWorkspaces`, `workspace.maxTabsPerWorkspace` |
| Enforcement | `server/src/services/WorkspaceService.ts:454`, `:560`, `:726` |
| Publication | `server/src/routes/workspaceRoutes.ts:36` — `res.json({ ...state, limits: workspaceService.getLimits() })` (authenticated `GET /api/workspaces`) |
| Client validation | `frontend/src/services/api.ts:360-374` — rejects a missing/typed-wrong/out-of-range pair as `invalid-workspace-limits` |
| Client state | `frontend/src/hooks/useWorkspaceManager.ts:211` — `setLimits(state.limits)` |
| UI | `frontend/src/App.tsx:606`, `:607`, `:662`, `:842` — all four props read `wm.limits.*` |

(Every line number in that table was re-read against the working tree at
`9c37cf4` while writing this revision.)

The two values are **not** in the public `/runtime-config` snapshot, and are not
registered keys of `RuntimeConfigStore` at all (no `applyScope`). FR-BGSTAB-026
AC-5 makes that deliberate: the limits ride the already-authenticated workspace
endpoint instead. Given #37's finding that `/runtime-config` is intentionally
unauthenticated (`OPS-BGSTAB-004`), keeping them off it is the safer of the two
shapes the issue proposed.

Because they are not `RuntimeConfigStore` keys, the two limits are read once at
startup: changing them takes a server restart, which is how both r2 runs below
were performed.

## How to reproduce (manual procedure, not CI)

This bundle is a **manual-procedure guard, not CI coverage.** Nothing in the repo
configures a server for `frontend/tests/e2e/issue34-capacity-ratify.spec.ts`, and
no default suite runs it — left alone it skips. Because the two limits are not
`RuntimeConfigStore` keys, the server reads them once at startup, so exercising
them genuinely requires an operator to:

1. set `workspace.maxWorkspaces` / `workspace.maxTabsPerWorkspace` in
   `server/config.json5` to a pair **other than the shipped defaults 10 / 8**,
2. restart the server so that pair is in force at `https://localhost:2222`,
3. pass the same pair in the two env vars:

```bash
cd frontend && ISSUE34_MAX_WORKSPACES=4 ISSUE34_MAX_TABS=3 \
  npm run test:e2e:issue34-capacity
```

### The anti-constant guard

The spec does not merely discourage 10 / 8 — it **refuses** them. `spec.ts:55-61`
throws at module load when either configured value is `10` or `8`, because those
are exactly the constants `da0e347` removed and also the pre-snapshot fallback in
`useWorkspaceManager.ts:175`. A pass at that pair would be satisfied by a
re-hardcoded `App.tsx`, or by a client that never received the server's limits at
all. A refusal was chosen over a skip because a skip reads as "nobody configured
this run", while 10 / 8 is a configuration that destroys the evidence.

Control **C1** below demonstrates the refusal, and it is a hard error
(`Error: No tests found`), not a skip. A half-set (`C3`) or malformed (`C2`) pair
is likewise a hard failure; only the fully unset case (`C4`) skips.

## Runtime evidence (r2)

External runtime owned by each run: this checkout's `server/dist/index.js`,
started directly with `NODE_ENV=production PORT=2222`, no daemon and no
`start.bat`. Playwright ran under
`frontend/playwright.issue34-capacity.config.ts`, which sets `webServer: undefined`
so a run can never start or stop a server.

| Run | Log | Configured (§1, from `config.json5`) | Published `limits` (§5, from the server) | Asserted (§6, env pair) | Result |
| --- | --- | --- | --- | --- | --- |
| R1 | `raw/r2-config-4-3.log` | 4 / 3 | `{'maxWorkspaces': 4, 'maxTabsPerWorkspace': 3}` | `ISSUE34_MAX_WORKSPACES=4 ISSUE34_MAX_TABS=3` | **2 passed** (24.4s), playwright exit 0 |
| R2 | `raw/r2-config-6-2.log` | 6 / 2 | `{'maxWorkspaces': 6, 'maxTabsPerWorkspace': 2}` | `ISSUE34_MAX_WORKSPACES=6 ISSUE34_MAX_TABS=2` | **2 passed** (23.0s), playwright exit 0 |

R1 and R2 are the load-bearing pair, and they are now self-describing: each log
states its own configured pair in section [1], the `limits` the running server
actually published in section [5], and the env pair echoed in the section [6]
header. The three values agree within each log and differ between the two logs.
So the UI limit *tracks* the configuration rather than coinciding with one
constant, and neither pair is the removed 10 / 8 — and none of that rests on a
filename or on this document's prose.

Both runs exercised the same two tests, which the Playwright output names in
full:

- `issue34-capacity-ratify.spec.ts:68:1 › issue34 AC-3: the workspace create control reports the configured maxWorkspaces`
- `issue34-capacity-ratify.spec.ts:112:1 › issue34 AC-7: the add-terminal control reports the configured maxTabsPerWorkspace`

**Title correction, recorded because the logs now disagree with the source.** The
second test was titled `AC-7`, but AC-7 is FR-BGSTAB-026's preserve-visuals and
preserve-data criterion; what this test actually verifies — that the add-terminal
control uses the *received* `maxTabsPerWorkspace` — is **AC-4**. The title has
since been corrected to `issue34 AC-4`, and the file header narrowed from
"AC-3~7" to "AC-3, AC-4". Only the title string and the comment changed; no
assertion was touched. Every r2 log above was captured before that rename and so
still prints the old `AC-7` title for the test at `spec.ts:112`. The runs and
their results are unaffected.

Server stdout for the two runs: `raw/r2-config-4-3-server.log`,
`raw/r2-config-6-2-server.log`. Each contains nine `[Auth] Token issued: jti=…`
lines. A `jti` is an opaque identifier, not token material, and the issuing
servers are gone; no password, secret or bearer value appears in any file here.

### Guard controls

`raw/r2-guard-controls.log` (8406 bytes, complete) — five controls against
**one** server configured 6 / 2. The log opens with that `config.json5` workspace
block and the listener identity `cmdline=node dist/index.js`,
`cwd=…/ProjectMaster-issue2-20260916/server`,
`exe=/home/beom/.nvm/versions/node/v24.21.0/bin/node`,
`inherited_BUILDERGATE=0`. Each control ends with its own `[exit: N]` line.

| Control | Env | Expected | Observed | Exit |
| --- | --- | --- | --- | --- |
| C1 | `ISSUE34_MAX_WORKSPACES=10 ISSUE34_MAX_TABS=8` | hard **error**, not skip | `Error: Issue #34 ratification cannot use the removed hardcoded pair: configure the server to a maxWorkspaces other than 10 and a maxTabsPerWorkspace other than 8 (got 10 / 8). At those two values a passing assertion is satisfied by the constant the fix removed.` at `spec.ts:56`, then `Error: No tests found` | `1` |
| C2 | `ISSUE34_MAX_WORKSPACES=4x ISSUE34_MAX_TABS=3` | hard failure naming the variable and value | `Error: ISSUE34_MAX_WORKSPACES must be a positive integer matching the server's configured limit, got "4x"` at `spec.ts:37`, then `Error: No tests found` | `1` |
| C3 | `ISSUE34_MAX_WORKSPACES=6` only | hard failure naming the **missing** variable | `Error: ISSUE34_MAX_TABS must be a positive integer matching the server's configured limit, got undefined` at `spec.ts:37`, then `Error: No tests found` | `1` |
| C4 | *(none)* | skip | `2 skipped` | `0` |
| C5 | `ISSUE34_MAX_WORKSPACES=4 ISSUE34_MAX_TABS=3` against a 6 / 2 server | both tests fail | `2 failed` — see below | `1` |

C5's two failures are recorded in full, and they fail at two different
assertions, not one:

- Test 1 (`spec.ts:80`) — `expect(state.limits).toEqual(...)`: expected
  `maxWorkspaces: 4, maxTabsPerWorkspace: 3`, received `maxWorkspaces: 6,
  maxTabsPerWorkspace: 2`. The server told the truth; the assertion was wrong.
- Test 2 (`spec.ts:131`) — `tab 3 is within the configured limit`,
  `Expected: < 400`, `Received: 409`. Creating a third tab was rejected by the
  server, whose real configured limit is 2.

C5 is the negative control: the assertions are falsifiable, and falsifiable
against the *actual* configured value rather than against a generic mismatch.
C1 is what makes the two passing runs mean anything — the one pair at which a
pass would be vacuous is refused outright rather than quietly skipped.

**Capture-history note.** The first capture of these five controls was truncated
at 4615 bytes, mid-way through C5's first expect diff. The truncation was in the
capture command, not in the runs. All five controls were re-run against a freshly
started server at the same 6 / 2 configuration and the complete transcript
replaced the file; the version described above and on disk is that complete
re-run. `raw/r2-final-ports.txt` records the re-run server's teardown.

### Process identity, environment and ports

These are now things the logs **contain**, not assertions this document makes.

Both R1 and R2 record, in section [4], the started server's identity read from
`/proc/<pid>/` — never from the `netstat.exe` PID column, which for a WSL-hosted
listener reports the WSL relay's Windows PID:

| | R1 | R2 |
| --- | --- | --- |
| listener pid (WSL `ss`) | 105868 | 106569 |
| `/proc/<pid>/cmdline` | `node dist/index.js` | `node dist/index.js` |
| `/proc/<pid>/cwd` | `…/ProjectMaster-issue2-20260916/server` | same |
| `/proc/<pid>/exe` | `/home/beom/.nvm/versions/node/v24.21.0/bin/node` | same |
| inherited `BUILDERGATE_*` in the child environ | **0** | **0** |
| `NODE_ENV` / `PORT` in the child environ | `production` / `2222` | `production` / `2222` |
| section [7] teardown | "kill ONLY pid 105868"; `/proc/105868 exists after kill: no` | "kill ONLY pid 106569"; `/proc/106569 exists after kill: no` |

Ports, bracketed in sections [2]/[2b] and [8]/[8b] of each run and again in
`raw/r2-final-ports.txt`:

- WSL `ss` before each start: none of 2001/2002/2221/2222 on the WSL side.
- Windows `netstat` before and after **every** r2 run, and in the final
  observation: TCP 2001 and 2002 `LISTENING` under PID **30596**, unchanged. The
  production instance was never touched.
- WSL `ss` after each teardown: 2221/2222 free.

`raw/r2-final-ports.txt` records the guard-control server's teardown
(`/proc/108143 after kill: no`), WSL-side 2221/2222 free, and TCP 2001/2002
still `LISTENING` under PID 30596.

## Static evidence rerun at this tree

`raw/r2-static-reruns.log`, header `HEAD=9c37cf4 (+ uncommitted review fixes)`:

| Rerun | Counts |
| --- | --- |
| frontend capacity unit tests (`workspaceCapacity{Api,Hook,Ui}`) | `tests 26 / pass 26 / fail 0 / skipped 0 / todo 0`, 704.96ms |
| `tests/unit/e2eOwnershipTypecheck.test.ts` | `tests 15 / pass 15 / fail 0 / skipped 0 / todo 0`, 8571.75ms |
| `npx tsc --noEmit -p tsconfig.e2e-ownership.json` | `tsc exit: 0` |

The capacity unit tests already drive the real `App` at non-default capacities;
the log names `CAP-07 App through Sidebar to actual Item menu applies creation
capacity 4.5` and `CAP-07 TabBar keeps the independent 32-session creation
guard` among them. The typecheck guard's named case is
`REL-BGSTAB-001 AC-3: tsconfig.e2e-ownership.json typechecks with zero errors`.

## Screenshots — and an overwrite that lost three r1 images

Screenshots land under `.playwright-mcp/`, which root `.gitignore:82` excludes,
so only hashes can be recorded here.

**The r2 runs wrote to the same value-named paths as r1 and overwrote three of
r1's images.** The spec names each file after the configured value
(`spec.ts:101`, `spec.ts:143`: `issue34-max-workspaces-${CONFIGURED_MAX_WORKSPACES}.png`,
`issue34-max-tabs-${CONFIGURED_MAX_TABS}.png`). r1 used pairs 4/3 and 5/2; r2
used 4/3 and 6/2. The three paths the two generations share — `…-workspaces-4.png`,
`…-tabs-3.png`, `…-tabs-2.png` — now hold r2's images. **The r1 hashes previously
recorded for those three files no longer match any file on disk. Those images are
gone.** The r1 *logs* are unaffected and remain in `raw/`.

Current on-disk state (verified with `sha256sum` at the time of writing):

| File | Generation | SHA256 |
| --- | --- | --- |
| `.playwright-mcp/issue34-max-workspaces-4.png` | r2 (config 4 / 3) | `3341aa17df5c213c67f54a0938a9fdc5f3fde934d732a0dd3d0d60304b2a9bed` |
| `.playwright-mcp/issue34-max-tabs-3.png` | r2 (config 4 / 3) | `dba3a4399f977880d4c83b4689377615150b5d081973c0057d1191d7c834440b` |
| `.playwright-mcp/issue34-max-workspaces-6.png` | r2 (config 6 / 2) | `0edfbac7ff08bc5f434f060ccbf5e52f5c9ec1913f2cb63208260c70e22fedd0` |
| `.playwright-mcp/issue34-max-tabs-2.png` | r2 (config 6 / 2) | `ecbe15c43c49fb6dd774ff571250fdc901a4cbdd4d2d6732b9842c52f06dd128` |
| `.playwright-mcp/issue34-max-workspaces-5.png` | **r1** (config 5 / 2), survives | `64f836cad093760ce4ea39f6579380efe4069523430e031b395892c62df2c2c0` |

Superseded and now unmatchable, recorded so the change is visible rather than
silently swapped:

| File | Generation | SHA256 recorded by the previous revision | Status |
| --- | --- | --- | --- |
| `.playwright-mcp/issue34-max-workspaces-4.png` | r1 | `fbb282832238ff07cdc8d3dcaa46734b25c77b2f4d187a2b2f56379f81eaab62` | overwritten by r2, image lost |
| `.playwright-mcp/issue34-max-tabs-3.png` | r1 | `ee96fba4d6e7a613b4971ccb67599b399237082b554027f4084233427f92bd31` | overwritten by r2, image lost |
| `.playwright-mcp/issue34-max-tabs-2.png` | r1 | `66ef836ebee508f1dcaf47234360132b89b25ad6fdf711e00898ae5c2ebd8485` | overwritten by r2, image lost |

`issue34-max-workspaces-5.png` survives only because r2 used 6 / 2 instead of
5 / 2, so nothing collided with it. It shows five workspaces in the sidebar with
the `+` control greyed out; under the removed hardcoded `10` that control would
still be enabled.

**Lesson: value-named screenshot paths collide across capture generations.** The
filename encodes the configured limit, not the run, so any re-capture at a
previously used pair silently replaces the earlier image — and because
`.playwright-mcp/` is gitignored, there is no version history to fall back on.
A generation or run-id segment in the path would have prevented this. The
screenshots were never the load-bearing evidence (the logs are), but the loss is
real and is recorded rather than papered over.

## Workspace ownership

Every workspace created here came from that run's own successful `POST
/api/workspaces`, registered through `tests/e2e/workspaceLeakGuard.ts`, and was
released by the same owner id. Both r2 runs recorded a single pre-existing
workspace (section [5]: `pre-existing workspaces = ['Workspace-1']`) and it was
never deleted. Every r2 run and every guard control ended with the global
teardown reporting `deleted=0, absent=0, failed=0`.
