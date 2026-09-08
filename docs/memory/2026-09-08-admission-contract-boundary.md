# Admission contract boundary

Requirement: N/A operational audit. Related work: PERF-BGSTAB-011 and the agreed worker-successor SDS-AC-3.

Trigger: current fixed child suite list has20 entries, while the agreed SDS still requires21. Git records the removal of the ineffective boundary gate from the child list. Counting the outer gate as the twenty-first does not restore the historical contract. Separately, the gate uses spawnSync(timeout118000), which may signal a Node child contrary to the current user process restrictions. No gate was executed.

Proposed safe resolution for this turn: preserve source/SDS and all old evidence; record the discrepancy without claiming gate completion or selecting a replacement contract. Gather nested subprocess safety facts before even a separate no-kill timing observation. Such an observation would not prove the existing timeout gate. No source/timeout/list/concurrency/SRS mutation or old-file restoration is proposed.

## Raw facts

```json
{
  "at": "2026-09-08T09:04:48.378578+00:00",
  "root": "C:/Work/git/_Snoworca/ProjectMaster",
  "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "branch": "work/mcp-session-orchestration-20260709",
  "head": "13e3b7597344614a7416b10466d0e9c9f08c38de",
  "status": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "fixed": [
    "tools/wave3/fair-readmission-closure-v3.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.remediation.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.reparse.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.batch.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.hardening.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.strict.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.ingress.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.wave.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.boundary.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.admission.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.trust.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.trust-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.seal.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.lexical.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs"
  ],
  "discovered": [
    "tools/wave3/fair-readmission-closure-v3.admission.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.batch.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.boundary.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.hardening.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.ingress.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.lexical.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.remediation.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.reparse.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.seal.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.strict.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.trust-race.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.trust.test.mjs",
    "tools/wave3/fair-readmission-closure-v3.wave.test.mjs"
  ],
  "sourceFiles": [
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\tools\\wave3\\fair-readmission-closure-v3.admission-gate.test.mjs",
      "sha256": "4b54a36f616e94882412930923d477c329a7168970dc7724cf8d17aebd647446"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\docs\\spec\\steps\\2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor\\design.md",
      "sha256": "48a8129b0bc057832cf0dd437b78e89cfa770a033483ad802348dcb66192b631"
    }
  ],
  "userFiles": [
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
    }
  ],
  "historyCommit": "2a20b4f073df7d6a9bbf209deaf3cf0a14221183",
  "historyDiff": "commit 2a20b4f073df7d6a9bbf209deaf3cf0a14221183\nAuthor:     beom <ice3x2@gmail.com>\nAuthorDate: Thu Sep 3 20:13:04 2026 +0900\nCommit:     beom <ice3x2@gmail.com>\nCommitDate: Thu Sep 3 20:13:04 2026 +0900\n\n    test(wave3): retire the vacuous boundary gate for the admission gate\n    \n    The boundary gate spawned nine sibling suites but passed no env, so the child\n    inherited NODE_TEST_CONTEXT, node's recursion guard skipped every file, and the\n    child exited 0 with empty stdout. The gate finished in 126ms and asserted\n    status 0 against nothing.\n    \n    Filtering the variable makes it run the siblings for real and then blow its own\n    120-second contract: the nine take 181.7s, of which one captureFrozenProvenance\n    call takes 88.7s. There is no version of this gate that both runs and passes.\n    \n    The admission SDS already replaced it - \"Replace the nine-file gate with one\n    nonrecursive fixed gate covering every functional suite but excluding only\n    itself\", basis \"a gate must cover its contracts\" - and the boundary SDS Status\n    is superseded. The two gates also asserted opposite contracts about\n    boundary.test.mjs: one that it is excluded, the other that it is included.\n    \n    Removing the file makes the admission gate's directory scan disagree with its\n    fixed list, so the list drops the entry too. That edit is required, not\n    optional: the scan excludes only the gate itself.\n    \n    This does not turn the admission gate green. It still exceeds its 118-second\n    budget, a separate and pre-existing problem, and the repository now has no\n    green closure-set gate at all - which was already true, only hidden.\n\ndiff --git a/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs b/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs\nindex c290cd0..d41b739 100644\n--- a/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs\n+++ b/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs\n@@ -17,7 +17,6 @@ const fixedClosureTests = [\n   'tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.wave.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.boundary.test.mjs',\n-  'tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.admission.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.trust.test.mjs',",
  "workflow": {
    "workspaceRoot": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "mode": "sdd",
    "activeTarget": "wave-5",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null
  }
}
```

## Decisions

All three independent decisions were collected before sharing conclusions:

- Audit (analysis_review): CONSENT, Critical0/High0. Packet/Git/source/SDS/user hashes and removal history match. The outer gate does not satisfy the missing historical child count.
- Preservation (baseline_a): CONSENT, Critical0/High0. Preserve existing files and evidence; no execution, restoration or contract mutation is approved.
- SRS/integration (requirements_mapping): CONSENT, Critical0/High0. The agreed21/118000/default-concurrency contract remains unresolved against code20. PERF011 stays in_progress/evolving; a no-kill timing observation would not prove the existing timeout gate.

Resolution: keep gate execution unperformed and the admission checklist unchecked. Record the exact discrepancy and retain all source/SDS/evidence. No thresholds, list entries or concurrency were changed.

## Nested execution preflight findings

Read-only investigation found no explicit process.kill/child.kill/Worker.terminate in the fixed child suites, but this alone does not prove their lifecycle safe. Internal-core-race spawns actual Node actors (:805); explicit waits reject on timeout and the suite uses node:test timeouts. Trust-race (:81), seal-race (:77), lexical-race (:98) and several internal-core-race tests use115000ms Node test timeouts. Their cancellation/descendant lifecycle must be understood before execution under the user's process rule.

The collector's native reparse timeout targets a fixed PowerShell executable (:243), not a Node process; fixed Git calls do not set an explicit timeout. Internal-core-race also copies sources into independent fixture Git roots and restores/removes verified Temp leaves/junctions (:720–760). The combined suite is therefore not read-only, even if the outer observation harness only records timing. No suite or fixture mutation was executed during this audit.

Follow-up must distinguish a failing deadline observation from process termination, preserve the registered118000ms/default-concurrency semantics, and reconcile the actual suite inventory through the requirement workflow before claiming admission completion. This record authorizes none of those implementation choices by itself.
