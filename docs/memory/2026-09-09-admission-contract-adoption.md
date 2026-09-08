# Admission contract adoption boundary ? raw packet

Requirement: N/A operational audit; related PERF-BGSTAB-010/PERF-BGSTAB-011.

Proposed operation after3/3 independent consent: use supported set_sds_status to mark the final new draft agreed and predecessor SDS superseded, then read back both. Preserve the predecessor body, historical21 contract and AC-1/2 text; its step remains merged. The new step remains active and targets wave-5. No source implementation, gate execution, SRS Requirement lifecycle promotion or completion is included.

The proposed new contract explicitly selects20 children with explicit reporter argv, retains strict118000ms acceptance with failure followed by natural settlement and no Node kill, confines operations to canonical-owned paths, and requires three clean runs with preservation. This is an explicit contract change proposal, not a claim that current code or earlier runs satisfy it. Current draft changes are authored task files listed below; user7 and old evidence are not adopted. No committee conclusions are recorded.

```json
{
  "at": "2026-09-08T17:33:08.349Z",
  "main": {
    "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "head": "ffff5fc7d993a18451cae50c1372479ee7779008",
    "tree": "050470fc3708deaa4b41e3944cf9d3cf106f643c",
    "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
    "branch": "work/mcp-session-orchestration-20260709",
    "status": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/spec/steps/2026-09-09.admission-lifecycle-successor/design.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/worklog/2026-09-09.jsonl\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt"
  },
  "canonical": {
    "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
    "head": "333e5e28adba53384d580386ab8672c8a5dd13b1",
    "tree": "c7079279ad8c8348ad50a2873369b2789428e05c",
    "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
    "status": ""
  },
  "files": [
    {
      "path": "docs/spec/steps/2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor/design.md",
      "sha256": "48a8129b0bc057832cf0dd437b78e89cfa770a033483ad802348dcb66192b631"
    },
    {
      "path": "docs/spec/steps/2026-09-09.admission-lifecycle-successor/design.md",
      "sha256": "cabd1271b242c920d260b525f1b9a20c80cca596f678fc433be5d2e9c75bfca1"
    },
    {
      "path": "docs/spec/steps/2026-09-09.admission-lifecycle-successor/intent.md",
      "sha256": "855fe63d9f4ce4400b92a5857d537287fdee0453174c3a310461595be7d82b8e"
    },
    {
      "path": "docs/spec/steps/state.md",
      "sha256": "22f53c7d88d66746ae69d98aece841d92dd9213ebdd5e97049a7431ccfca806a"
    },
    {
      "path": "tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs",
      "sha256": "4b54a36f616e94882412930923d477c329a7168970dc7724cf8d17aebd647446"
    }
  ],
  "oldSDSstatus": "| Status | agreed |",
  "newSDSstatus": "| Status | draft |",
  "stepRows": [
    "| 2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor | merged | - | tools/wave3 fixture Worker evidence allocation and fixed admission timing | PERF-BGSTAB-010 | 2026-07-27 | 2026-07-27 |",
    "| 2026-09-09.admission-lifecycle-successor | active | - | BGSTAB | PERF-BGSTAB-010 | 2026-09-09 | 2026-09-09 |"
  ],
  "reference": {
    "path": "docs/memory/2026-09-09-admission-successor-boundary.md",
    "sha256": "f2dbf64ea7d806e617916db81f666ca5909b5a1ff75da2697f80ef637cdda8a9"
  },
  "userFiles": [
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\.codex\\config.toml",
      "previousSHA256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
      "currentSHA256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\CLAUDE.local.md",
      "previousSHA256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
      "currentSHA256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_1.txt",
      "previousSHA256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
      "currentSHA256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_2.txt",
      "previousSHA256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
      "currentSHA256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_1.txt",
      "previousSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "currentSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_2.txt",
      "previousSHA256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
      "currentSHA256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_incomplete_True.txt",
      "previousSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "currentSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "unchanged": true
    }
  ],
  "authoredDraftChanges": [
    "docs/spec/steps/2026-09-09.admission-lifecycle-successor/design.md"
  ],
  "oldSDSdiff": "",
  "reportedMCP": {
    "source": "root supplied fresh official dry-run/read-back; not independently executed by packet author",
    "packageVersion": "3.0.0",
    "workspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "mode": "sdd",
    "activeTarget": "wave-5",
    "requirement": {
      "id": "PERF-BGSTAB-010",
      "status": "in_progress",
      "stability": "evolving"
    },
    "dryRuns": [
      {
        "operation": "set_sds_status",
        "step": "2026-09-09.admission-lifecycle-successor",
        "from": "draft",
        "to": "agreed",
        "ok": true,
        "written": false
      },
      {
        "operation": "set_sds_status",
        "step": "2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor",
        "from": "agreed",
        "to": "superseded",
        "ok": true,
        "written": false
      }
    ],
    "validateStep": {
      "step": "2026-09-09.admission-lifecycle-successor",
      "errors": 0,
      "warnings": 0
    }
  },
  "workflow": {
    "run": "N/A",
    "task": "N/A",
    "event": "N/A",
    "idempotency": "N/A"
  }
}
```

## Independent contract decisions

Audit/tool integrity (analysis_review), preservation/provenance (baseline_a), and independent SRS/integration (admission_contract_srs, separate from the draft author) each returned CONSENT with Critical0/High0 before circulation. They reviewed the same final draft and raw packet. Scope: supported new SDS draft-to-agreed then old SDS agreed-to-superseded, preserving predecessor body/history/merged step and requiring read-back. Explicit20/reporting argv replacement is adopted as the new contract;118000ms/default concurrency/three fresh nonempty runs, old AC1/2 and no-kill/canonical ownership remain required. This does not establish implementation, actual admission success or Requirement completion.

## Official transitions and read-back

Supported MCP3.0.0 set_sds_status first wrote new draft-to-agreed; list_steps confirmed it before the predecessor agreed-to-superseded mutation. Independent MCP/disk read-back confirmed new active/agreed and old merged/superseded, with old design changed only at its Status row. Both validate_step checks reported errors0/warnings0. Independent review found one Medium stale present-tense draft description; the separate author corrected only historical/current-state prose in new design/intent. Re-review returned No findings (C0/H0/M0/L0), with acceptance contracts,20-file list and interfaces unchanged by that correction. Contract adoption is complete; test-first implementation and all three real admission runs remain incomplete.
