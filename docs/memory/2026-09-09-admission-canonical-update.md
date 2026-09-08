# Admission canonical source update

Requirement: N/A operational provenance; related PERF-BGSTAB-010 AC-3 validation support.

Trigger: authoring HEAD and dedicated canonical HEAD differ. Proposed action after three independent consents: non-forced checkout of exactly bbf59ed57025012834c284dbbca75497f5baa467 in the clean canonical worktree only, preserving every listed ignored/user file; then read back HEAD, status and hashes. No user-owned import, forced checkout, Node termination, runtime startup, capture, actual test run or requirement promotion is included in this first decision. Subsequent capture/execution requires its own input and safety review. Prior main/inert evidence is observation, not canonical execution proof. Workflow identifiers are N/A because this is a direct local operational update, not a workflow event repair.

## Raw facts

```json
{
  "at": "2026-09-08T21:18:03.607669+00:00",
  "main": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
  "canonical": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
  "mainHead": "bbf59ed57025012834c284dbbca75497f5baa467",
  "oldCanonicalHead": "333e5e28adba53384d580386ab8672c8a5dd13b1",
  "newTree": "9a446e187e8bde5c9f0a73481ddcb080aa58f045",
  "mainBranch": "work/mcp-session-orchestration-20260709",
  "canonicalBranch": "",
  "mainCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "canonicalCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "mainStatus": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/worklog/2026-09-09.jsonl\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "canonicalStatus": "",
  "changes": [
    "A\tdocs/memory/2026-09-09-admission-contract-adoption.md",
    "A\tdocs/memory/2026-09-09-admission-successor-boundary.md",
    "A\tdocs/memory/2026-09-09-hardening-canonical-update.md",
    "A\tdocs/memory/2026-09-09-parent-wiring-pending-run.md",
    "M\tdocs/plan/2026-09-08.remaining-work-autonomous.plan.md",
    "A\tdocs/plan/2026-09-09.admission-events-tdd.md",
    "A\tdocs/plan/2026-09-09.admission-fixture-ownership.md",
    "A\tdocs/plan/2026-09-09.admission-gate-wiring.md",
    "A\tdocs/plan/2026-09-09.admission-observer-tdd.md",
    "A\tdocs/plan/2026-09-09.admission-transcript-decoder.md",
    "A\tdocs/plan/2026-09-09.admission-worker-ownership.md",
    "M\tdocs/plan/2026-09-09.hardening-checkout-root.md",
    "M\tdocs/plan/2026-09-09.native-probe-program-cost.md",
    "A\tdocs/report/2026-09-09.native-probe-physical-validation.md",
    "M\tdocs/spec/steps/2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor/design.md",
    "A\tdocs/spec/steps/2026-09-09.admission-lifecycle-successor/design.md",
    "A\tdocs/spec/steps/2026-09-09.admission-lifecycle-successor/intent.md",
    "M\tdocs/spec/steps/state.md",
    "A\ttools/wave3/admission-event-reporter.mjs",
    "A\ttools/wave3/admission-event-reporter.test.mjs",
    "A\ttools/wave3/admission-event-validation.mjs",
    "A\ttools/wave3/admission-fixture-ownership.mjs",
    "A\ttools/wave3/admission-fixture-root.test.mjs",
    "A\ttools/wave3/admission-fixture-seed.test.mjs",
    "A\ttools/wave3/admission-fixture-wiring.test.mjs",
    "A\ttools/wave3/admission-gate-wiring.test.mjs",
    "A\ttools/wave3/admission-process-observer.mjs",
    "A\ttools/wave3/admission-process-observer.test.mjs",
    "A\ttools/wave3/admission-source-read-wiring.test.mjs",
    "A\ttools/wave3/admission-transcript-decoder.test.mjs",
    "A\ttools/wave3/admission-worker-lifecycle.mjs",
    "A\ttools/wave3/admission-worker-lifecycle.test.mjs",
    "A\ttools/wave3/admission-worker-parent-wiring.test.mjs",
    "A\ttools/wave3/admission-worker-wiring.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.admission.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.boundary.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.ingress.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.lexical.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.remediation.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.seal-race.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.seal.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.snapshot.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.strict.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.trust-race.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.trust.test.mjs",
    "M\ttools/wave3/fair-readmission-closure-v3.wave.test.mjs",
    "M\ttools/wave3/fixture-actor-cleanup.mjs",
    "A\ttools/wave3/internal/admission-fixture-test-harness.mjs"
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
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b"
    }
  ],
  "workflow": {
    "mode": "sdd",
    "target": "wave-5",
    "workspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "mcpVersion": "3.0.0",
    "requirement": "PERF-BGSTAB-010",
    "status": "in_progress",
    "stability": "evolving",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null
  }
}
```

## Decisions

All three roles independently returned CONSENT, Critical0/High0, before circulation: audit/tool integrity, preservation/provenance, and SRS/integration. Each confirmed the exact Git identities and restricted consent to non-forced checkout plus preserved18/HEAD/status read-back. No capture, actual test, runtime operation, user-file adoption or SRS promotion is covered. Proceed only with the proposed exact checkout; execution evidence remains pending.


## Checkout read-back

```json
{
  "head": "bbf59ed57025012834c284dbbca75497f5baa467",
  "status": "",
  "preservedCount": 18,
  "mismatches": []
}
```

Independent preservation read-back: No findings. Exact HEAD/tree/common-dir, clean status and all18 hashes confirmed; no user7 import. No capture or test executed at this checkpoint.

## Preservation count clarification

The original raw packet above is preserved unchanged. Its18 preservation rows represent17 unique paths because canonical server/config.json5 was appended a second time. See the [three-role correction decision](2026-09-09-admission-capture-count-correction.md). No original protected path was omitted, and the earlier phrase18 files must not be used as a unique-file count.
