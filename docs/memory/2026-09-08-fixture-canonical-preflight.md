# Canonical preflight for physical fixture validation

Requirement: N/A operational provenance; related PERF-BGSTAB-011 validation support.

Trigger: the selected physical test copies config-lock rows including server/config.json5. It must not copy the original user config. Proposed action after independent3/3 consent: advance only the clean dedicated canonical checkout to the exact committed HEAD, preserve the listed data/certs/user bytes, and prepare a supported collector capture in a unique canonical-owned manifest leaf to inventory source/fixture/config rows. That capture reads the canonical-owned encrypted test config and writes only its new nonce manifest, not user source/config. The manifest must be independently checked before any fixture copying or test execution. No full admission, process startup/shutdown, timeout/list alteration, raw secret display, arbitrary restoration or SRS promotion is proposed.

The later physical test may copy canonical-owned config bytes into its isolated owned fixture only after that exact input inventory is verified. Original user settings must never be used as fallback. Canonical config is from the separately prepared test workspace; this does not authorize adoption of any user untracked path.

## Raw facts

```json
{
  "at": "2026-09-08T09:30:08.264325+00:00",
  "main": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
  "canonical": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
  "mainHead": "fd876f22bde2e1b77a0c95f532d65e0114a420f3",
  "oldCanonicalHead": "3f3a81434bac389598c3e864b9c0442e012eefb9",
  "newTree": "386d90fb210554f28ecc40899266fe5542ddb0d9",
  "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "mainStatus": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "canonicalStatus": "",
  "changes": [
    "A\tdocs/memory/2026-09-08-ac11-canonical-update.md",
    "A\tdocs/memory/2026-09-08-admission-contract-boundary.md",
    "A\tdocs/memory/2026-09-08-boot-managed-data-boundary.md",
    "A\tdocs/plan/2026-09-08.admission-lifecycle-preflight.md",
    "A\tdocs/plan/2026-09-08.binary-rollback-contract-proposal.md",
    "A\tdocs/plan/2026-09-08.fixture-subtest-settlement.md",
    "A\tdocs/plan/2026-09-08.lexical-edge-accounting.md",
    "M\tdocs/plan/2026-09-08.remaining-work-autonomous.plan.md",
    "A\tdocs/plan/2026-09-08.split-test-accounting.md",
    "A\tdocs/report/2026-09-08.binary-negotiation-boot-validation.md",
    "M\tdocs/report/2026-09-08.binary-negotiation-request.md",
    "M\tdocs/report/2026-09-08.production-boot-validation.md",
    "A\tdocs/research/2026-09-08.binary-rollback-integration-gaps.md",
    "M\tdocs/spec/30.buildergate-stability.srs.md",
    "M\tfrontend/src/utils/terminalBinaryNegotiationClient.ts",
    "M\tserver/src/ws/WsRouterSplitHandshake.test.ts",
    "M\ttools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.lexical.test.mjs",
    "A\ttools/wave3/runtime-import-observation.mjs",
    "A\ttools/wave3/settled-subtest.mjs",
    "A\ttools/wave3/settled-subtest.test.mjs"
  ],
  "addedPathCollisions": [],
  "dependencyChanges": [],
  "preserved": [
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\.codex\\config.toml",
      "sha256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\CLAUDE.local.md",
      "sha256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_1.txt",
      "sha256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_2.txt",
      "sha256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_1.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_2.txt",
      "sha256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_incomplete_True.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\agent-command-profiles.json",
      "sha256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\command-presets.json",
      "sha256": "eb3cfb090d56e3dce9e32e2f4a86ecb2901fbbfb3530e6b988ecb5ce7de25b89"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\command-presets.json.bak",
      "sha256": "e3a2cf5fca5a96541c1c1176c50ec00caa74dedace75a2dc860c6ad60663ada6"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\mcp-control-config.json",
      "sha256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\recovery-options.json",
      "sha256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\terminal-shortcuts.json",
      "sha256": "848810d0dd371e538f390e582cef320371e5fe8c370fb6b786f21c8a976f3171"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\terminal-shortcuts.json.bak",
      "sha256": "ca4c24880d09c5ddadb55664a522a0a17c3da487602b4755186d5cd42c3e99e5"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.crt",
      "sha256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.key",
      "sha256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6"
    }
  ],
  "workflow": {
    "mode": "sdd",
    "target": "wave-5",
    "workspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null
  }
}
```

## Decisions

All three decisions were collected independently before circulation:

- Audit: CONSENT, Critical0/High0. Packet/Git/protected17 hashes match; canonical-owned config provenance and direct workflow N/A are valid.
- Preservation: CONSENT, Critical0/High0. Clean target, zero new-path collisions/dependency changes and17/17 preserved hashes match.
- SRS/integration: CONSENT, Critical0/High0. PERF011 remains in_progress/evolving. Only exact non-forced checkout and capture through the target checkout's own collector are permitted.

Proceed with the exact checkout and one supported nonce capture. Independently inspect every captured input before any fixture copying or physical test. No original-user config fallback, gate execution, lifecycle promotion or contract change is authorized.

## Input inventory and selected execution

The exact switch tofd876f22 completed non-forced; preserved17 hashes stayed unchanged and tracked status was clean. Target collector capture completed in19976ms using only canonical paths. Source116 + fixture20 + config12 + collector1 produce149 unique copied inputs. The explicit internal-core support entry is already in this set. The earlier148-row summary counted only the three row arrays and excluded collector; it is not the full copied-input count.

Independent audit checked all149 regular-file paths/hashes, tracked HEAD blobs except the canonical-owned config, canonical protected-value fingerprint and absence of the user7 paths. The nonce manifest was copied byte-identically to `C:/Users/beom/AppData/Local/Temp/buildergate-fixture-canonical-manifest.json` and only its known canonical nonce leaf was removed. SHA256 `ea4b3589aa66a47f6c727c8b6916804ee0eac9bbc670218071486a8966a214d0`; canonical tracked/untracked status was then clean. The input arrays' separate148-row inventory is `buildergate-fixture-inputset-615de8e6872147089acb5720d1977616.json` in the same Temp directory.

After those input checks, the first serial fixture parent alone ran from the canonical cwd with the exact name filter, local no-listen preload, no external timeout/abort/watch/forceExit and natural process completion. It created only its own fixtures using the verified canonical seed. Result: parent1 + children5 =6/6, exit0, signalnull, elapsed39030ms, no skips/TODO/cancellations. Independent functional review returned No findings. Raw directory `C:/Users/beom/AppData/Local/Temp/buildergate-physical-serial-RjpJdB/`; raw.log SHA256 `aa87ab60390c7160b95a8520e7ab1ce583ad06f2f5a08113d38271866d96752a`.

The remaining physical race parent and full admission were not executed. This single-file selected-parent result is not the default-concurrency combined gate or three clean118000ms runs. Post-execution preservation review is recorded separately below when available.

Independent post-execution preservation review returned No findings: canonical HEADfd876f22 remains clean, original user/canonical-owned17 hashes and all149 captured input hashes match, and no nonce/analysis leaves or listen log remain. Archived manifest bytes are unchanged. This proves only the selected first parent and its preservation checks.

## Second-parent preflight findings — not executed

- High: releaseWxRaceChild can throw (destroyed stdin assertion or stdin.end). Existing finally blocks release before awaiting actor.exited, so a release exception can skip the exit barrier and reach parent fixture deletion while an actor may still run. Every started actor must be released independently and awaited despite release failures; preserve paths if termination is not established and retain original/release errors. No kill is an acceptable substitute. Controlled failure-before-exit RED is required before changing this path.
- High: the first child of the second parent uses `git reset --quiet -- server/config.json5` to restore its own fixture index. It does not target the original Git root, but the current agent boundary rules still prohibit git reset. A test-first equivalent index-only restoration must preserve the owned ignored config bytes and the original fixture index state without using that prohibited command. No command has been run or silently substituted.

The second parent remains unexecuted. Its junction/backup paths were found to be under verified owned Temp roots, but those checks do not override the two unresolved findings. The successful first-parent result does not waive them.
