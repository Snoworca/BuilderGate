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

**Two directions, two specs.** Sections up to and including "Static evidence
rerun (r4)" cover the *lower* direction — configured pairs below the shipped
defaults 10 / 8. The *raise* direction, which is the symptom issue #34 lists
first, is covered by a separate spec and a separate run, documented in
["The raise direction (r5, r6)"](#the-raise-direction-r5-r6--the-other-half-of-the-issue)
at the end of this file.

## Three capture generations

`raw/` holds three generations, all real, all retained.

- **r1** — the `final-*.log` / `final-*.txt` files, captured 2026-09-16T02:05Z–02:13Z
  (the stamps are in the filenames; these logs carry no header of their own).
  Real runs, but thin: the pass logs recorded only the asserted env pair, so the
  claim "the server was configured 4/3" rested on the filename and on prose. The
  `/proc` kill-identity and the `BUILDERGATE_*`-count were asserted in prose with
  no artifact, and the static reruns had no committed log at all.
- **r2** — the `r2-*` files, captured 2026-09-16T02:06:26Z–02:19:26Z with full
  instrumentation. r2 answered r1's gaps: each load-bearing run became
  self-describing, and the `/proc`, port and static-rerun claims acquired
  artifacts. **r2 is superseded as primary evidence but not withdrawn.** It
  captured the spec in its *module-load* guard form, where a bad env pair threw
  during collection and Playwright reported `Error: No tests found`. The
  subsequent blast-radius fix moved both guards into a per-test `resolveLimits()`,
  and the second test was relabelled `AC-7` → `AC-4`. Both are behavioural
  changes to the spec, so the r2 transcripts no longer describe this tree.
- **r3** — the `r3-*` files, captured **2026-09-16T02:39:02Z–02:53:55Z** against
  the current working tree. **This is the primary evidence.** Same instrumented
  sections [1]–[8b] as r2, re-run after the guards moved, plus a sixth guard
  control (C6) that exercises the cross-paired property directly.

  That window is the range of the `utc=` stamps on the first line of each
  `r3-*` artifact that carries one, read from the files themselves:

  | Artifact | First-line `utc=` |
  | --- | --- |
  | `raw/r3-guard-controls.log` | `2026-09-16T02:39:02Z` |
  | `raw/r3-config-4-3.log` | `2026-09-16T02:42:56Z` |
  | `raw/r3-config-6-2.log` | `2026-09-16T02:43:58Z` |
  | `raw/r3-final-ports.txt` | `2026-09-16T02:45:01Z` |
  | `raw/r3-static-reruns.log` | `2026-09-16T02:53:55Z` |

  The two server-stdout files, `raw/r3-config-4-3-server.log` and
  `raw/r3-config-6-2-server.log`, have no such header — their first line is the
  server's own `[Config] All passwords already encrypted` — so they contribute
  no stamp of their own; they are the stdout of the two runs stamped 02:42:56Z
  and 02:43:58Z. Unlike r2, the guard controls were captured **first** in r3,
  before the two load-bearing runs.

r1 and r2 are kept because they are genuine captures of genuine runs, not
because anything below rests on them.

## What the code does now

| Hop | Location |
| --- | --- |
| Operator setting | `server/config.json5` → `workspace.maxWorkspaces`, `workspace.maxTabsPerWorkspace` |
| Enforcement | `server/src/services/WorkspaceService.ts:454`, `:560`, `:726` |
| Publication | `server/src/routes/workspaceRoutes.ts:36` — `res.json({ ...state, limits: workspaceService.getLimits() })` (authenticated `GET /api/workspaces`) |
| Client validation | `frontend/src/services/api.ts:360-374` — rejects a missing/typed-wrong/out-of-range pair as `invalid-workspace-limits` |
| Client state | `frontend/src/hooks/useWorkspaceManager.ts:211` — `setLimits(state.limits)` |
| UI | `frontend/src/App.tsx:606`, `:607`, `:662`, `:842` — all four props read `wm.limits.*` |

(Every line number in that table was re-read against the current working tree
while writing this revision.)

The two values are **not** in the public `/runtime-config` snapshot, and are not
registered keys of `RuntimeConfigStore` at all (no `applyScope`). FR-BGSTAB-026
AC-5 makes that deliberate: the limits ride the already-authenticated workspace
endpoint instead. Given #37's finding that `/runtime-config` is intentionally
unauthenticated (`OPS-BGSTAB-004`), keeping them off it is the safer of the two
shapes the issue proposed.

Because they are not `RuntimeConfigStore` keys, the two limits are read once at
startup: changing them takes a server restart, which is how both r3 runs below
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

The spec does not merely discourage 10 / 8 — it **refuses** them.
`resolveLimits()` at `spec.ts:62-73` throws at `spec.ts:66` when
`ISSUE34_MAX_WORKSPACES` is `10` **or** `ISSUE34_MAX_TABS` is `8`, because those
are exactly the constants `da0e347` removed and also the pre-snapshot fallback in
`useWorkspaceManager.ts:175`. A pass at that pair would be satisfied by a
re-hardcoded `App.tsx`, or by a client that never received the server's limits at
all. A refusal was chosen over a skip because a skip reads as "nobody configured
this run", while 10 / 8 is a configuration that destroys the evidence.

**The check is cross-paired, not "10 or 8 anywhere in the pair."** `10` was only
ever the `maxWorkspaces` constant and `8` only ever the `maxTabsPerWorkspace`
constant, so the guard rejects `maxWorkspaces === 10` and
`maxTabsPerWorkspace === 8` at their own positions and nothing else.
`ISSUE34_MAX_WORKSPACES=8 ISSUE34_MAX_TABS=10` is therefore **accepted**: neither
value sits where the removed constant sat, so a pass at that pair is not
satisfied by the constant the fix removed. It is the position, not the digit,
that destroys the evidence. Control **C6** below is that property observed rather
than argued.

**Where the guards run.** Both the env validation (`readLimit`, whose throw is at
`spec.ts:37`) and the anti-constant check run inside `resolveLimits()`, which
each test calls at its own top (`spec.ts:85` and `spec.ts:130`) — not at module
load. The base `frontend/playwright.config.ts:7` sets `testDir: './tests/e2e'`
with no `testIgnore`, so a plain `npx playwright test` loads this file along with
every other spec in that directory; a throw during file load would fail
collection for the whole run, so a single stale env export in an operator's shell
would abort every unrelated spec too. Scoped this way the failures stay hard and
stay inside this file, and they occur after collection has completed. The one
thing still evaluated at module load is `test.skip(UNCONFIGURED, …)` at
`spec.ts:77-78`, which only ever skips.

Control **C1** below demonstrates the refusal, and it is a hard error, not a
skip. A half-set (`C3`) or malformed (`C2`) pair is likewise a hard failure; only
the fully unset case (`C4`) skips.

## Runtime evidence (r3)

External runtime owned by each run: this checkout's `server/dist/index.js`,
started directly with `NODE_ENV=production PORT=2222`, no daemon and no
`start.bat`. Playwright ran under
`frontend/playwright.issue34-capacity.config.ts`, which sets `webServer: undefined`
so a run can never start or stop a server.

| Run | Log | Configured (§1, from `config.json5`) | Published `limits` (§5, from the server) | Asserted (§6, env pair) | Result |
| --- | --- | --- | --- | --- | --- |
| R1 | `raw/r3-config-4-3.log` | 4 / 3 | `{'maxWorkspaces': 4, 'maxTabsPerWorkspace': 3}` | `ISSUE34_MAX_WORKSPACES=4 ISSUE34_MAX_TABS=3` | **2 passed** (22.4s), playwright exit 0 |
| R2 | `raw/r3-config-6-2.log` | 6 / 2 | `{'maxWorkspaces': 6, 'maxTabsPerWorkspace': 2}` | `ISSUE34_MAX_WORKSPACES=6 ISSUE34_MAX_TABS=2` | **2 passed** (22.6s), playwright exit 0 |

R1 and R2 are the load-bearing pair, and they are self-describing: each log
states its own configured pair in section [1], the `limits` the running server
actually published in section [5], and the env pair echoed in the section [6]
header. The three values agree within each log and differ between the two logs.
So the UI limit *tracks* the configuration rather than coinciding with one
constant, and neither pair is the removed 10 / 8 — and none of that rests on a
filename or on this document's prose.

Both runs exercised the same two tests, which the Playwright output names in
full:

- `issue34-capacity-ratify.spec.ts:80:1 › issue34 AC-3: the workspace create control reports the configured maxWorkspaces` (7.7s in R1, 7.9s in R2)
- `issue34-capacity-ratify.spec.ts:125:1 › issue34 AC-4: the add-terminal control reports the configured maxTabsPerWorkspace` (7.4s in both)

**Title correction, now visible in the logs.** The second test was originally
titled `AC-7`, but AC-7 is FR-BGSTAB-026's preserve-visuals and preserve-data
criterion; what this test actually verifies — that the add-terminal control uses
the *received* `maxTabsPerWorkspace` — is **AC-4**. The title was corrected to
`issue34 AC-4` and the file header narrowed from "AC-3~7" to "AC-3, AC-4"; only
the title string and the comment changed, no assertion was touched. **Every r3
log prints the corrected `AC-4` title**, verified above. The stale `AC-7` title
appears only in the r1 and r2 logs, which were captured before the rename.

Server stdout for the two runs: `raw/r3-config-4-3-server.log`,
`raw/r3-config-6-2-server.log`. Each contains nine `[Auth] Token issued: jti=…`
lines. A `jti` is an opaque identifier, not token material, and the issuing
servers are gone; no password, secret or bearer value appears in any file here.

### Guard controls

`raw/r3-guard-controls.log` (23289 bytes, complete) — **six** controls against
**one** server configured 6 / 2. The log's own header states why it was
re-captured: the r2 controls exercised the module-load form, which aborted
collection, and "the guards now run per-test, so the observable shape changes and
the old capture no longer describes this tree." It then records that
`config.json5` workspace block and the listener identity
`cmdline=node dist/index.js`,
`cwd=/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/server`,
`exe=/home/beom/.nvm/versions/node/v24.21.0/bin/node`,
`inherited_BUILDERGATE=0`. Each control ends with its own `[exit: N]` line.

| Control | Env | Expected | Observed | Exit |
| --- | --- | --- | --- | --- |
| C1 | `ISSUE34_MAX_WORKSPACES=10 ISSUE34_MAX_TABS=8` | hard **error**, not skip | `2 failed`; both failures are `Error: Issue #34 ratification cannot use the removed hardcoded pair: configure the server to a maxWorkspaces other than 10 and a maxTabsPerWorkspace other than 8 (got 10 / 8). At those two values a passing assertion is satisfied by the constant the fix removed.` thrown `at resolveLimits (…spec.ts:66:11)`, reached from `spec.ts:85` and `spec.ts:130` | `1` |
| C2 | `ISSUE34_MAX_WORKSPACES=4x ISSUE34_MAX_TABS=3` | hard failure naming the variable and value | `2 failed`; both are `Error: ISSUE34_MAX_WORKSPACES must be a positive integer matching the server's configured limit, got "4x"` thrown `at readLimit (…spec.ts:37:11)` via `resolveLimits (…spec.ts:63:25)` | `1` |
| C3 | `ISSUE34_MAX_WORKSPACES=6` only | hard failure naming the **missing** variable | `2 failed`; both are `Error: ISSUE34_MAX_TABS must be a positive integer matching the server's configured limit, got undefined` thrown `at readLimit (…spec.ts:37:11)` via `resolveLimits (…spec.ts:64:31)` | `1` |
| C4 | *(none)* | skip | `2 skipped` | `0` |
| C5 | `ISSUE34_MAX_WORKSPACES=4 ISSUE34_MAX_TABS=3` against a 6 / 2 server | both tests fail, on the real mismatch | `2 failed` — see below | `1` |
| C6 | `ISSUE34_MAX_WORKSPACES=8 ISSUE34_MAX_TABS=10` against a 6 / 2 server | guard **accepts** the pair, run then fails on the real mismatch | `2 failed`, and neither failure is the guard — see below | `1` |

C5's two failures are recorded in full, and they fail at two different
assertions, not one:

- Test 1 (`spec.ts:93`) — `expect(state.limits).toEqual(...)`: expected
  `maxWorkspaces: 4, maxTabsPerWorkspace: 3`, received `maxWorkspaces: 6,
  maxTabsPerWorkspace: 2`. The server told the truth; the assertion was wrong.
- Test 2 (`spec.ts:145`) — `tab 3 is within the configured limit`,
  `Expected: < 400`, `Received: 409`. Creating a third tab was rejected by the
  server, whose real configured limit is 2.

C6 is the cross-paired property, observed. The pair `8 / 10` uses both removed
digits but in the opposite positions, and the guard lets it through: the run
proceeds to the browser and then fails at exactly the same two assertions as C5 —
`spec.ts:93` with expected `maxWorkspaces: 8, maxTabsPerWorkspace: 10` against
received `6 / 2`, and `spec.ts:145` with `Expected: < 400 / Received: 409`.
Neither failure mentions the anti-constant guard. That is the proof that the
guard rejects a *position*, not a digit.

C5 and C6 are the negative controls: the assertions are falsifiable, and
falsifiable against the *actual* configured value rather than against a generic
mismatch. C1 is what makes the two passing runs mean anything — the one pair at
which a pass would be vacuous is refused outright rather than quietly skipped.

**C1–C3 changed shape between r2 and r3, and that is the point of the
re-capture.** In r2 those three controls ended with `Error: No tests found`,
because the guards threw while Playwright was still loading the file and
collection never completed. In r3 the same three controls report `2 failed` —
this file's two tests, and nothing else. The error text, the variable names and
the exit codes are identical across the two generations; only the blast radius
changed. The two transcripts disagreeing here is the observable evidence that the
fix works, not an inconsistency between them.

**Not captured in r3:** the guard-control server's pid and its teardown. r2's
`r2-final-ports.txt` named that server's pid (`/proc/108143 after kill: no`);
`r3-final-ports.txt` instead records, after all r3 runs, that "no capture.sh or
'node dist/index.js' process remains: (none)", that WSL-side 2221/2222 are free,
and that TCP 2001/2002 are still `LISTENING` under PID 30596. The end state is
recorded; the individual guard-server pid is not.

### Process identity, environment and ports

These are things the logs **contain**, not assertions this document makes.

Both R1 and R2 record, in section [4], the started server's identity read from
`/proc/<pid>/` — never from the `netstat.exe` PID column, which for a WSL-hosted
listener reports the WSL relay's Windows PID:

| | R1 (r3, config 4/3) | R2 (r3, config 6/2) |
| --- | --- | --- |
| listener pid (WSL `ss`) | 112634 | 113428 |
| `/proc/<pid>/cmdline` | `node dist/index.js` | `node dist/index.js` |
| `/proc/<pid>/cwd` | `/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/server` | same |
| `/proc/<pid>/exe` | `/home/beom/.nvm/versions/node/v24.21.0/bin/node` | same |
| inherited `BUILDERGATE_*` in the child environ | **0** | **0** |
| `NODE_ENV` / `PORT` in the child environ | `production` / `2222` | `production` / `2222` |
| section [7] teardown | "kill ONLY pid 112634"; `/proc/112634 exists after kill: no` | "kill ONLY pid 113428"; `/proc/113428 exists after kill: no` |

Ports, bracketed in sections [2]/[2b] and [8]/[8b] of each run and again in
`raw/r3-final-ports.txt`:

- WSL `ss` before each start: none of 2001/2002/2221/2222 on the WSL side.
- Windows `netstat` before and after **every** r3 run, and in the final
  observation: TCP 2001 and 2002 `LISTENING` under PID **30596**, unchanged. The
  production instance was never touched.
- WSL `ss` after each teardown: 2221/2222 free.

## Static evidence rerun (r4)

`raw/r4-static-reruns.log` is the current one, and `raw/r3-static-reruns.log`
(2026-09-16T02:53:55Z) is retained as the earlier capture.

r3 is superseded for a reason worth stating. Its line 2 reads `HEAD=c442948 plus
the uncommitted review-round changes listed below; the next commit freezes exactly
this content` — and that promise turned out false: documentation edits followed the
capture, so the commit contained more than the inlined `git status --porcelain`
listing described. r4 does not make that class of claim at all. It records the tree
it ran on — `HEAD` at capture, the uncommitted file list, and the `git hash-object`
content hash of each of the three test inputs (`issue34-capacity-ratify.spec.ts`,
`playwright.issue34-capacity.config.ts`, `tsconfig.e2e-ownership.json`) — and says
nothing about any later commit. The hashes are what let a reader confirm the counts
below describe the test inputs as committed, without relying on a promise.

| Rerun | Counts (r4) |
| --- | --- |
| frontend capacity unit tests (`workspaceCapacity{Api,Hook,Ui}`) | `tests 26 / pass 26 / fail 0 / skipped 0 / todo 0` |
| `tests/unit/e2eOwnershipTypecheck.test.ts` | `tests 15 / pass 15 / fail 0 / skipped 0 / todo 0` |
| `npx tsc --noEmit -p tsconfig.e2e-ownership.json` | `tsc exit: 0` |

r3 recorded the same three results (26/26 in 682.30ms, 15/15 in 8275.66ms,
`tsc exit: 0`) on its own tree.

The capacity unit tests already drive the real `App` at non-default capacities;
the log names `CAP-07 App through Sidebar to actual Item menu applies creation
capacity 4.5` and `CAP-07 TabBar keeps the independent 32-session creation
guard` among them. The typecheck guard's named case is
`REL-BGSTAB-001 AC-3: tsconfig.e2e-ownership.json typechecks with zero errors`.

The log records that tree as uncommitted at capture time and says the next
commit would freeze it. That commit is `6458953`, which also carries
documentation edits made after the capture — so the inlined status listing
describes the moment of capture, not the commit's final contents. The test input
it names, `frontend/tests/e2e/issue34-capacity-ratify.spec.ts`, was last modified
before the capture and was committed unchanged.

`raw/r2-static-reruns.log` is retained as the earlier generation, on the same
footing as the other r2 artifacts. Its header names a different tree —
`HEAD=9c37cf4 (+ uncommitted review fixes)` — and its counts are identical
(26/26, 15/15, `tsc exit: 0`) with different durations.

## Screenshots — and overwrites across all three generations

Screenshots land under `.playwright-mcp/`, which root `.gitignore:82` excludes,
so only hashes can be recorded here.

**The r3 runs overwrote all four of r2's images.** The spec names each file after
the configured value (`spec.ts:114` and `spec.ts:157`:
`issue34-max-workspaces-${CONFIGURED_MAX_WORKSPACES}.png`,
`issue34-max-tabs-${CONFIGURED_MAX_TABS}.png`), and r3 used the same two pairs as
r2 — 4 / 3 and 6 / 2 — so every path collided. The same thing had already
happened once: r2 used pairs 4/3 and 6/2 against r1's 4/3 and 5/2 and overwrote
three of r1's images. **Only `issue34-max-workspaces-5.png` has never been
overwritten**, because no later generation used a 5-workspace configuration.

Current on-disk state, verified with `sha256sum` while writing this revision:

| File | Generation now on disk | SHA256 |
| --- | --- | --- |
| `.playwright-mcp/issue34-max-workspaces-4.png` | **r3** (config 4 / 3) | `d9db3f227d23b13839f4d6644c6a3cebd00afc33136b1d1fe5cf60df08cb937c` |
| `.playwright-mcp/issue34-max-tabs-3.png` | **r3** (config 4 / 3) | `71acbfe9c4a856f5636b40728553ed9752090ff6351d85b42fb6fcb21598b83b` |
| `.playwright-mcp/issue34-max-workspaces-6.png` | **r3** (config 6 / 2) | `ecc6dca9a72239dedf4aba1a54db675f6fd80525d07cc7f0c90e0543fa962e7e` |
| `.playwright-mcp/issue34-max-tabs-2.png` | **r3** (config 6 / 2) | `81bea055e887f9870697b93d3c9f969abdecc450176a8b09bbce2d6e283fbe15` |
| `.playwright-mcp/issue34-max-workspaces-5.png` | **r1** (config 5 / 2), survives | `64f836cad093760ce4ea39f6579380efe4069523430e031b395892c62df2c2c0` |

Superseded and now unmatchable, recorded so each swap is visible rather than
silent. Every hash in this table was recorded by an earlier revision of this
document and matches no file on disk today:

| File | Generation | SHA256 recorded when it was current | Status |
| --- | --- | --- | --- |
| `.playwright-mcp/issue34-max-workspaces-4.png` | r2 | `3341aa17df5c213c67f54a0938a9fdc5f3fde934d732a0dd3d0d60304b2a9bed` | overwritten by r3, image lost |
| `.playwright-mcp/issue34-max-tabs-3.png` | r2 | `dba3a4399f977880d4c83b4689377615150b5d081973c0057d1191d7c834440b` | overwritten by r3, image lost |
| `.playwright-mcp/issue34-max-workspaces-6.png` | r2 | `0edfbac7ff08bc5f434f060ccbf5e52f5c9ec1913f2cb63208260c70e22fedd0` | overwritten by r3, image lost |
| `.playwright-mcp/issue34-max-tabs-2.png` | r2 | `ecbe15c43c49fb6dd774ff571250fdc901a4cbdd4d2d6732b9842c52f06dd128` | overwritten by r3, image lost |
| `.playwright-mcp/issue34-max-workspaces-4.png` | r1 | `fbb282832238ff07cdc8d3dcaa46734b25c77b2f4d187a2b2f56379f81eaab62` | overwritten by r2, image lost |
| `.playwright-mcp/issue34-max-tabs-3.png` | r1 | `ee96fba4d6e7a613b4971ccb67599b399237082b554027f4084233427f92bd31` | overwritten by r2, image lost |
| `.playwright-mcp/issue34-max-tabs-2.png` | r1 | `66ef836ebee508f1dcaf47234360132b89b25ad6fdf711e00898ae5c2ebd8485` | overwritten by r2, image lost |

`issue34-max-workspaces-5.png` shows five workspaces in the sidebar with the `+`
control greyed out; under the removed hardcoded `10` that control would still be
enabled.

**Lesson, now observed twice: value-named screenshot paths collide across capture
generations.** The filename encodes the configured limit, not the run, so any
re-capture at a previously used pair silently replaces the earlier image — and
because `.playwright-mcp/` is gitignored, there is no version history to fall
back on. A generation or run-id segment in the path would have prevented this.
The screenshots were never the load-bearing evidence (the logs are), but the loss
is real and is recorded rather than papered over.

## Workspace ownership

Every workspace created here came from that run's own successful `POST
/api/workspaces`, registered through `tests/e2e/workspaceLeakGuard.ts`, and was
released by the same owner id. Both r3 runs recorded a single pre-existing
workspace (section [5]: `pre-existing workspaces = ['Workspace-1']`) and it was
never deleted. Every r3 run and every one of the six guard controls ended with
the global teardown reporting `deleted=0, absent=0, failed=0`.

## The raise direction (r5, r6) — the other half of the issue

Everything above verifies a **mechanism**: the two constants are gone from
`App.tsx` and the four props read `wm.limits.*`. That is not the same as
verifying the **outcome the issue describes**. Issue #34 names two symptoms, and
they are not symmetric:

- **raise** the configured limit → the UI blocks first, so the setting looks ignored;
- **lower** it → the UI permits an action the server then rejects.

Every configured pair used above is **below** the shipped defaults 10 / 8 — r1
used 4/3 and 5/2, r2 and r3 used 4/3 and 6/2. At those pairs only the second
symptom is exercised. A `App.tsx` still hardcoded to `10` and `8` would keep
every one of those assertions passing, because a control hardcoded to allow ten
workspaces is not what stops you at four; the server's 409 is. So the raise
direction was untested, and it is the direction the issue lists first.

### What the raise spec asserts, and why "at 10 and 8" is the sharp test

`frontend/tests/e2e/issue34-capacity-raise.spec.ts` is the new spec. It runs
against a server configured **above** the removed pair and asserts **at the
removed constants themselves**:

| Step | Workspaces test (`spec.ts:80`) | Tabs test (`spec.ts:148`) |
| --- | --- | --- |
| Fill to exactly the removed constant | to 10 workspaces (`spec.ts:98-107`) | to 8 tabs (`spec.ts:167-170`) |
| **The assertion** | `New Workspace` is **still enabled**, and no `Maximum 10 workspaces` control exists (`spec.ts:111-113`) | `Add Terminal` is **still enabled**, and no `Maximum 8 tabs` control exists (`spec.ts:176-178`) |
| Then fill to the configured number | to 14 (`spec.ts:119-131`) | to 12, and one past it is refused with ≥400 (`spec.ts:182-187`) |
| And it finally stops | `Maximum 14 workspaces`, visible **and disabled** (`spec.ts:134-136`) | `Maximum 12 tabs`, visible **and disabled** (`spec.ts:192-194`) |

Ten workspaces and eight tabs is the precise point at which a UI hardcoded to
10 / 8 would block. Asserting *at* it — rather than merely at the configured
number — is what makes the test fail on the raise symptom rather than pass
through it. The last row is the complement: the limit is followed upward, not
simply ignored upward.

`resolveLimits()` (`spec.ts:59-75`) **refuses** any configured pair at or below
10 / 8, throwing at `spec.ts:68`. This is the mirror image of the sibling spec's
anti-constant guard and it exists for the same reason: at or below the removed
pair the "still enabled at 10 / 8" assertion is unreachable or vacuous, so a pass
would mean nothing. It refuses rather than skips, because a skip reads as "nobody
configured this run" while this is a configuration that cannot express the claim.
Like the sibling, both guards run **per test** (`spec.ts:81`, `spec.ts:149`),
never at module load, so a stale env export cannot abort collection for the whole
`tests/e2e` testDir.

The headroom exists: `server/src/schemas/config.schema.ts:253-254` caps
`maxWorkspaces` at 50 (default 10) and `maxTabsPerWorkspace` at 16 (default 8),
so 14 / 12 is a legal configuration with room above both constants.

### r6 — the passing run

`raw/r6-raise-14-12.log`, header `utc=2026-09-16T03:16:21Z`. Same external-runtime
discipline as r3: this checkout's `server/dist/index.js` started directly with
`NODE_ENV=production PORT=2222`, no daemon and no `start.bat`; Playwright under
`frontend/playwright.issue34-raise.config.ts`, which sets `webServer: undefined`
and scopes `testMatch` to this one spec.

| Section | What the log records |
| --- | --- |
| [1] configured | `maxWorkspaces: 14`, `maxTabsPerWorkspace: 12` — **both above** the removed pair |
| [4] identity | pid `126693`; `cmdline: node dist/index.js`; `cwd: /mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/server`; `exe: /home/beom/.nvm/versions/node/v24.21.0/bin/node`; `inherited BUILDERGATE_* in the child environ: 0`; `NODE_ENV=production`, `PORT=2222` |
| [5] published | `GET /api/workspaces limits = {'maxWorkspaces': 14, 'maxTabsPerWorkspace': 12}`; `pre-existing workspaces = ['Workspace-1']` |
| [6] asserted | `ISSUE34_MAX_WORKSPACES=14 ISSUE34_MAX_TABS=12`; **2 passed (30.2s)**, `playwright exit: 0` |
| [7] teardown | "kill ONLY pid 126693"; `/proc/126693 exists after kill: no` |
| [8] ports | WSL-side 2221/2222 free; TCP 2001 and 2002 still `LISTENING` under PID **30596** |

The two tests and their durations, as the Playwright output names them:

- `issue34-capacity-raise.spec.ts:80:1 › issue34 raise AC-4: the workspace create control is still enabled at the removed constant 10` — 11.3s
- `issue34-capacity-raise.spec.ts:148:1 › issue34 raise AC-4: the add-terminal control is still enabled at the removed constant 8` — 11.8s

Ownership: the run ended `[e2e] workspaces: deleted=0, absent=0, failed=0`, and
the single pre-existing `Workspace-1` recorded in section [5] was not deleted.
Server stdout is `raw/r6-raise-14-12-server.log`; the final teardown and port
observation is `raw/r6-final-ports.txt` (`utc=2026-09-16T03:17:35Z`), which
records that no capture or server process remains, 2221/2222 free on the WSL
side, and 2001/2002 unchanged under PID 30596.

### r5 — the earlier failing run, and what actually caused it

`raw/r5-raise-14-12.log` (`utc=2026-09-16T03:10:38Z`) is the same spec at the
same 14 / 12 configuration, and it is retained. **Test 1 failed, test 2 passed,
`playwright exit: 1`.** It is kept because the way it failed is instructive.

It was **the test's own bug, not a product defect.** The draft named its
workspaces `issue34-raise-ws-${Date.now()}-${i}`. That prefix is 17 characters;
`Date.now()` is 13 digits; plus the separator that is 31, so the name is exactly
**32** characters while `i` is one digit and **33** once `i` reaches 10. And
`server/src/services/WorkspaceService.ts:459` rejects a trimmed name longer than
32 characters, throwing `ErrorCode.INVALID_NAME` at `:460`.

The run therefore created nine workspaces and failed on its tenth creation call —
and that call is the *first one past ten total workspaces*, which is to say the
failure landed exactly where the capacity defect this spec exists to detect would
land. Worse, it was unreadable: the ownership helper only inspects
`status !== 201`, so
`frontend/tests/e2e/workspaceLeakGuard.ts:127` reported the opaque
`Error: Invalid workspace creation response proof` with no mention of names,
counts or limits. An invalid name and a quota rejection are indistinguishable
there.

The r5 stack names draft `spec.ts:111:7`. The current file is offset from that
draft by +7 lines before test 1 (the added comment at `spec.ts:38-44`) and a
further +12 inside it (the added diagnostic), which places draft line 111 at the
**second** loop's first creation, `i = 10` — the first name that is 33 characters
long. The draft's screenshot call precedes that line, so r5 had already passed
the "still enabled at 10" assertion before it broke.

The fix was two changes to the test, and none to the product:

1. Names shortened to `i34r-ws-${i}-${uuid8}` — 18 characters while `i` is one
   digit, 19 at two (`spec.ts:101`, `spec.ts:122`).
2. A diagnostic at `spec.ts:119-131`: every creation past the removed constant is
   preceded by a count read, and a rejection now re-reads the count and reports
   `creation N of 14 was rejected while the server's configured limit is {…}:
   count before X, after Y` with the underlying error appended, instead of the
   helper's opaque string.

`spec.ts:38-44` carries a comment recording the whole episode so the next author
does not rediscover the 32-character limit the same way.

The brief for this round also reports a direct `curl` probe at the same 14 / 12
configuration, showing creations succeeding to a total of 14 and the next
returning `409 WORKSPACE_LIMIT_EXCEEDED`. **No artifact of that probe was
retained** in `raw/`, and the server stdout logs contain no per-request lines, so
it is recorded here as an unretained manual observation rather than as evidence.
The server's correctness at 14 is separately visible in r6, where the same spec
created all fourteen and only then observed the disabled control.

### Screenshots (raise direction)

`.playwright-mcp/` is excluded by root `.gitignore:82`, so only hashes can be
recorded. Verified with `sha256sum` while writing this section:

| File | SHA256 |
| --- | --- |
| `.playwright-mcp/issue34-raise-enabled-at-10-of-14.png` | `77aaa53ba2f93278c98503df6190b857a1c37e704308bca5959a5205f77b1bae` |
| `.playwright-mcp/issue34-raise-disabled-at-14.png` | `7a61057069e9b6413a7b4d6d221915d65ca1b8a3f96e34c97498ac279f8b4370` |
| `.playwright-mcp/issue34-raise-tabs-enabled-at-8-of-12.png` | `4affe37db183843a2a8cfd6c589fea4126e23f851b9ffbf908c86eccaccbc394` |
| `.playwright-mcp/issue34-raise-tabs-disabled-at-12.png` | `4fc8567563f2c32f8231fc267bf264b0abfb1c02a66504454ca7405b92568184` |

**The value-named-screenshot hazard recorded above recurred.** This spec also
names its files after configured values (`spec.ts:114`, `:137`, `:179`, `:195`),
and r5 and r6 ran at the same 14 / 12 pair, so every path r5 reached collided
with r6's. `issue34-raise-enabled-at-10-of-14.png` is the concrete case: r5 wrote
it before failing at the next line, and r6 re-wrote it — the bytes above are
r6's, and r5's image is gone. The two tab images were overwritten the same way,
because r5's test 2 passed and so produced both. Only
`issue34-raise-disabled-at-14.png` has no r5 predecessor: its call
(`spec.ts:137`) sits after the loop that r5 died in. Nothing load-bearing rests
on the images; the logs do.

### Both directions are now covered

| Direction | Symptom | Spec | Evidence |
| --- | --- | --- | --- |
| **Lower** the configured limit below the shipped defaults | the UI permits an action the server then rejects | `frontend/tests/e2e/issue34-capacity-ratify.spec.ts` | r3 — `raw/r3-config-4-3.log` (4/3), `raw/r3-config-6-2.log` (6/2), plus six guard controls in `raw/r3-guard-controls.log` |
| **Raise** it above the shipped defaults | the UI blocks first, so the setting looks ignored | `frontend/tests/e2e/issue34-capacity-raise.spec.ts` | r6 — `raw/r6-raise-14-12.log` (14/12), with the instructive failure `raw/r5-raise-14-12.log` retained |

The two specs are complementary and neither subsumes the other: the lower spec's
anti-constant guard refuses 10 or 8 at their own positions, and the raise spec
refuses anything at or below 10 / 8 outright. Between them no configuration the
issue describes is left unexercised.

Both remain **manual-procedure guards, not CI coverage**, for the same reason:
the two limits are not `RuntimeConfigStore` keys, so they are read once at server
startup and exercising them requires an operator to edit `server/config.json5`
and restart. Left alone, both skip.
