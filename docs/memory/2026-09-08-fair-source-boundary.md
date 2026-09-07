# Fair source provenance boundary audit

- Date: 2026-09-08 KST.
- Requirement ID: N/A (operational audit only; not SRS verification evidence).
- Trigger: observed source-digest mismatch during P2b admission regression.
- Decision: three independent roles returned CONSENT, Critical/High 0 for the controlled recovery sequence. Intermediate publication is authorized; P2b completion still requires actual rerun success.
- No imported worktree evidence or pre-existing user file adoption is requested. Current changes are this thread's authorized work; original untracked files stay untouched.

## Raw facts supplied identically to all roles

```json
{
  "requirementId": "N/A (operational boundary audit, not requirement evidence)",
  "trigger": "P2b admission tests returned decision-artifact-source-digest-mismatch",
  "workspaceRoot": "C:/Work/git/_Snoworca/ProjectMaster",
  "gitCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "branch": "work/mcp-session-orchestration-20260709",
  "head": "ed037694735e113ac40d0bf5c8c2ea167a330cfc",
  "mcp": {
    "workspaceRoot": "C:/Work/git/_Snoworca/ProjectMaster",
    "packageVersion": "2.13.1",
    "mode": "sdd",
    "activeTarget": "wave-5",
    "runId": null,
    "task": "P2b in docs/plan/2026-09-08.remaining-work-autonomous.plan.md",
    "event": "local test stdout diagnostic",
    "idempotencyKey": null,
    "note": "No workflow pipeline emit/mutation was used for this test run; no missing durable workflow response is alleged."
  },
  "test": {
    "command": "node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 src/ws/FairTerminalDeliveryScheduler.test.ts src/ws/WsRouterSendPriority.test.ts src/ws/wsSendPolicyRestoreMetadata.test.ts",
    "cwd": "C:/Work/git/_Snoworca/ProjectMaster/server",
    "exit": 1,
    "tests": 68,
    "pass": 55,
    "fail": 13,
    "log": "C:/Users/beom/AppData/Local/Temp/buildergate-p2b-final-suites.log",
    "sha256": "14208BACD4BBCCB486F58692769F00B4C10F9951E4EAA1DDBA9D9CEE5981F5FD",
    "tscExit": 0
  },
  "artifact": {
    "root": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority",
    "generation": "2c8814a3e9a8f430987da1b0abad1bf31ca11a6a64e25fd3437e2ac8068441b4",
    "pointerSha256": "6f7e45da8189e2fddfcb984489b3b085f9f919843d137848950ea0028729474e",
    "decisionSha256": "dffa6feec3c6dc2c18896b36ca0590e6cfa8262f199898a358027f8799666a94",
    "provenanceSha256": "906f12a8f77ad6a59d42cb12ecde005b16d07c6d55903ba662db6ad7e45f7436",
    "recordedSourceDigest": "f0e1a674c6305a56c9a8bb63411eee980bf6307dbf01c904eb3bcc7ae538f229",
    "currentSourceDigest": "78c951ac5b80067538270e8b52bf89fc5f2079aa76ba9703589555af23361236"
  },
  "sources": [
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\benchmarks\\terminalFairnessCharacterization.ts",
      "sha256": "99dc6d06a1d498db5b31bfc7ab013916f05f9cc541da7eaf5642ae34d4bda341"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\benchmarks\\fairSchedulerAuthorityLocator.ts",
      "sha256": "f8672347e293926b3291ef35238cc5b2da29ec76f30475e8110ed97ad30071ad"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\ws\\wsSendPolicy.ts",
      "sha256": "a5e619ca8bf58f2ecec77413736c1a8eef5dcb74b346b41eef5a1e64880d76a7"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\ws\\WsRouter.ts",
      "sha256": "e1587c0a911f77bebdd14cbd8ec2831f1b04c02a86b9549dc7b937b3baf732fa"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\services\\TerminalResourcePolicy.ts",
      "sha256": "110ce608ab9a0f73347f0d164960142a104169e9177dd9160302080a1851d425"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\services\\TerminalResourcePolicyCanary.ts",
      "sha256": "f8d79247bf47b03a5f9613134cea7b5c9516caccdea41b694c55e3870767a2f1"
    }
  ],
  "preexistingUntracked": {
    ".codex/config.toml": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
    "CLAUDE.local.md": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
    "t1_verdict_1.txt": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
    "t1_verdict_2.txt": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
    "t2_verdict_1.txt": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
    "t2_verdict_2.txt": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
    "t2_verdict_incomplete_True.txt": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4"
  }
}
```

## Working-tree status at capture

- Modified: master plan, ACK progress report, BGSTAB SRS, current worklog, tool-generated kiwi/.status.json, C4 RuntimeConfigStore/product tests/test-runner, P2b WsRouter/wsSendPolicy and their tests.
- New thread-owned reports: C-telemetry-capability and remaining-test-inventory.
- Pre-existing untracked files: exact seven paths/hashes above; none imported or staged.
- docs/analysis authority artifacts were not modified before this incident capture.

## Required independent decisions

- Audit/tool integrity (analysis_review): CONSENT; validator correctly rejects the actual changed source digest; no forged artifact or missing workflow response observed; no workflow repair applicable.
- Preservation/provenance (baseline_a): CONSENT; Git/source/untracked/pointer/artifact hashes independently match capture; supported publisher preserves prior generations and promotes pointer atomically.
- SRS/integration (requirements_mapping): CONSENT; PERF-BGSTAB-010 AC-3/4 and PERF-BGSTAB-011 AC-7/9 allow intermediate JSON publication; final A-5 and binary adoption gates remain mandatory.
- Each role must state consent/veto, unresolved Critical/High findings and safe next action. Do not circulate role conclusions until all three have returned.
- Possible operations for review: supported authority-generation publication followed by server build writers and full failed-suite rerun, or completion of remaining source edits before that publication. Existing original plan defers final publication to A-5; per-Phase regression gate is also mandatory. Choose a safe order without weakening gates.

## Recovery and read-back

- Approved sequence: freeze current source/policy/workload; supported new authority generation; server provenance/evidence build; independent integrity/read-back and exact 68-test rerun. Preserve old generations and original user files. Never patch digests, relax thresholds or declare the 13 failures solved from build success alone.
- All three conclusions were collected independently before circulation. Each role reported unresolved Critical/High 0 for this recovery operation only.
- Supported publisher created generation d77cef68372a6a4d1354b2e537b9adf116a433db40339b0067352574408f57ee with unchanged workload/runtime profile; source digest78c951ac5b80067538270e8b52bf89fc5f2079aa76ba9703589555af23361236. Script evidence: C:/Users/beom/AppData/Local/Temp/buildergate-p2b-republish-evidence.json.
- npm run build exited0 (original tool process62849 completion e9329f), provenance/evidence writers produced the current19-file bundle. Subsequent build after LF attributes also exited0 (process10310 completion d9655f).
- Audit post-check CONSENT: source/built/decision digests match; current19 source/built JSON bytes equal; raw15/sample1650 hashes valid; all thresholds accept and unchanged from prior policy.
- Preservation post-check CONSENT: source6/user7 unchanged; old2c8814 generation intact; only newd77 generation and pointer changed.
- Integration post-check No findings: identical68-test command passed68/68, all13 former failure names each passed once, no fail/skip/todo/cancelled; tsc0. Log C:/Users/beom/AppData/Local/Temp/buildergate-p2b-republished-suites.log SHA2560E2A5B143A262CF552FD68847D9CBFC97C177DAC49B56B6F843BFD00CA2A7C7D.
- Separate checkout byte-conversion issue discovered and handled in 2026-09-08-checkout-provenance-boundary.md. P3/P4 and finalA5 remain open.
