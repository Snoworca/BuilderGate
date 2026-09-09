# Per-task execution, verification and resumption

This guide operationalizes current AGENTS. It does not relax SRS, TDD, provenance, review or process gates. Historical Temp directories are evidence, not paths to overwrite.

## 1. Entry gate

1. Read Git status, HEAD, branch and relevant source hashes. Separate existing user changes from task changes.
2. Read docs/spec/00.index.md; MCP get_work_mode, get_active_target, then get_requirement for each task ID.
3. Inspect status/stability/blockers/warnings/newWorkCandidates, open in_progress/blocked/implemented requirements and completed-work. Discover current tool schemas rather than inventing arguments.
4. Resolve anchors using rg -n 'symbol' path. Line numbers are baseline navigation aids. If a symbol disappeared, inspect its replacement and callers before editing.
5. Confirm task files, contract, RED expectations and acceptance criteria. If unfrozen, complete the decision task and independent review first.
6. Record current task and next action in master Resume. Do not create another progress authority.

Some MCP mutations reject workspaceRoot override. For example add_verification_evidence rejected it previously. Confirm response mcpWorkspace points to the intended main root and use supported arguments. Success alone is insufficient: read the actual requirement/evidence back.

## 2. Strict TDD unit

| Stage | Action | Required evidence |
|---|---|---|
| RED authoring | Use the actual target function/callback or existing harness | Failure caused by intended missing/incorrect behavior |
| RED review | Separate reviewer reads original requirement, diff and fixture | Not merely module/import/environment failure |
| RED execution/commit | Preserve original assertions; independently run new cases | UTF-8 raw, counts/exit/hash and test commit |
| Implementation | Reuse helpers/services, keep adapters thin | Only behavior required by reviewed tests/contract |
| GREEN | Reviewer runs relevant full regression selection | Actual counts; failure/cancel/skip/TODO separate |
| Types/integration | Explicit project config and actual callback chain | Source text matching alone is insufficient behavior proof |
| Prickly review | Independent original-plan/SRS/diff review | Fix and re-review until No findings |
| Recording | Exact-path commit, official worklog, necessary evidence | Read-back matches the narrow proven scope |

If implementation was written before RED, remove that new implementation and restart test-first. A newly discovered behavior defect needs additional RED before its fix. A typed fixture may need a new required method, but use the fixture's real semantics and never substitute a success stub for actual behavior verification.

## 3. Commands and working directories

These are verified command forms, not blanket permission to execute every suite. Inspect each selected task's process/fixture behavior first. Do not rerun unchanged tests merely because prose changed.

### Frontend

cwd C:/Work/git/_Snoworca/ProjectMaster/frontend:

```powershell
node --require ../server/tools/require-owned-http-test-pipe.cjs --experimental-strip-types --test tests/unit/terminalCheckpointRuntime.test.ts tests/unit/terminalContainerRecoveryContract.test.ts tests/unit/terminalCheckpointCapabilityScoping.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
```

177 was an observed baseline count, not a required constant after adding cases. tsconfig.test has an allowlist; verify every new test is included. Root tsc with files:[] is not application coverage.

The known hidden failure is tests/unit/terminalHiddenOutput.test.ts, previously11/10pass1fail. Do not repeatedly reproduce unchanged code for design review. After writing real integration tests, include that file in final regression. Never erase its underlying AC merely to get GREEN.

### Selected server checks

cwd C:/Work/git/_Snoworca/ProjectMaster/server:

```powershell
node --require ./tools/require-owned-http-test-pipe.cjs --import ./node_modules/tsx/dist/loader.mjs --test src/schemas/config.schema.test.ts src/services/RuntimeConfigStore.test.ts
node --require ./tools/require-owned-http-test-pipe.cjs --import ./node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 src/utils/configTemplate.test.ts src/services/SettingsService.resourceLimits.test.ts src/services/ConfigFileRepository.resourceLimits.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

For monolithic filters, set BUILDERGATE_TEST_FILTER only in the scoped child environment and execute src/test-runner.ts with the reviewed local loader/guard. Record actual selected count. Missing filter could run the entire unsafe runner. The historical C fixture concurrency1 is not permission to reduce admission concurrency.

### Spec

Use MCP validate_spec({strict:true,failOnWarning:true}) and summarize_target({target:'wave-5'}). If no links tool is exposed, run speckiwi links check --json from root. CLI fallbacks: speckiwi validate --fail-on-warning --json and speckiwi summary --target wave-5 --json. Record only commands actually run. The historical671 links is not a permanent expected count.

## 4. Processes and raw logs

- Reuse tools/wave3/admission-process-observer.mjs observeProcessUntilClose. Deadline records failure; settlement waits for actual child and stdout/stderr close.
- Do not add Node spawnSync timeout, AbortSignal, tree kill or force-exit. Observation timeout is not termination; re-poll the same session or inspect exact OS identity.
- Temporary TCP runtime uses2222 only. Actual app is https://localhost:2222, start.bat --port 2222. Inspect stop.bat before use; only the exact verified2222 listener PID is the fallback exception. Protect2001/2002 and all unrelated Node processes.
- Existing before-bind unit guard rejects arbitrary TCP. Unexpected guard rejection is a fixture problem, not a success criterion.
- Do not silently alter parent environment. Record NODE_TEST_* filtering and reviewed preload propagation. Inspect new NODE_OPTIONS rather than deleting required guards or accepting hidden runner overrides.
- Use a fresh unique Temp directory per execution. Save stdout/stderr as UTF-8 with SHA256. Do not print secrets/config/certificate contents; preserve hashes.
- A new wrapper written by one agent requires another reviewer. Do not build another runner framework when the reviewed observer suffices.

## 5. Canonical integration gate

Canonicalbbf59ed differs from current authoring. Main177 cannot become canonical177 by relabelling. Before actual browser/full integration:

1. Record root/common-dir/branch/HEAD/status, new-path collisions, user-file hashes, canonical-owned config/managed files, source/evidence fingerprints.
2. Apply the AGENTS three-role boundary procedure where triggered. Give identical raw evidence without circulating conclusions first.
3. Perform only the approved exact non-forced checkout. Never copy/adopt user-owned modified/untracked paths.
4. Read back HEAD/status/hashes. If a capture is needed, archive actual bytes and verify disk read-back before owner-only nonce cleanup.
5. Derive the actual unique input set. Past149 and preserved17 are observations, not hardcoded targets. Normalize paths before deduplication; distinguish raw hashes from Git clean/filter blob equivalence.
6. Record before/after source/input/process/owned-file preservation. Do not infer natural exit from intention, a timeout or an unavailable output chunk.

Historical admission3runs prove their exact historical contract. Select fresh checks according to the new diff, keeping all required full gates intact.

## 6. Failure and resumption table

| Event | Next action |
|---|---|
| RED failed for wrong reason | Repair fixture/import/env without weakening behavior; no product implementation yet |
| Old callback releases new owner | Add actual callback RED; fix owner/generation correlation |
| Only prose status stale | Preserve raw evidence, label historical/current correctly; no test repetition |
| MCP success disagrees with durable state | AGENTS committee and official repair; never manually fabricate completed work |
| Provenance mismatch | Preserve originals, committee, fresh canonical evidence |
| Missing required owner answer | Hold only dependent work; continue independent authorized tasks |
| Real release/soak not happened | Do not simulate; prepare other authorized work |
| Context near exhaustion | Persist task/HEAD/changes/raw evidence/unresolved issue/next exact action |

## 7. Commits and durable evidence

Use the official node tools/worklog.mjs add command with actual date, request, analysis, solution, exact file list and full commit SHA. Never hand-edit JSONL completion records. Commit titles describe the change; no Phase/Step/TASK progress markers or tool signatures. Stage exact paths and read git log -1 --format='%H%n%B' afterward.

When relevant, use MCP add_verification_evidence dryRun, apply, then get_requirement read-back. Narrow evidence needs narrow covers/notes. Do not bulk promote status or empty activeTarget. Use the evidence template in verification/ inside the existing task report.
