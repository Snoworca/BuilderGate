# Canonical runtime validation worktree boundary

Requirement: N/A (operational provenance record). Runtime tests remain mapped to REL-BGSTAB-001 and SEC-MCP-001.

Trigger: Establish a clean dedicated worktree for actual runtime validation while preserving original modified and untracked files. No user file adoption or completion promotion is proposed.

Proposed action: create target with git worktree add --detach at the exact recorded HEAD. Inspect clean status/tree/common-dir and tracked blobs before installing independent dependencies via npm ci --include=dev. Never copy original node_modules or untracked files. No listener/start/stop is authorized by this packet; those require the B1 preflight.

Raw evidence:

```json
{
    "at":  "2026-09-08T01:31:11.7654975Z",
    "root":  "C:/Work/git/_Snoworca/ProjectMaster",
    "commonDir":  "C:/Work/git/_Snoworca/ProjectMaster/.git",
    "branch":  "work/mcp-session-orchestration-20260709",
    "head":  "17ff7d4f5024b4b654dbb45f11355b2f4aa92876",
    "tree":  "83eb8fc03e8b8e0b436185837781bdfe92ad00ac",
    "status":  [
                   " M docs/plan/2026-09-01.remaining-work-backlog.plan.md",
                   " M docs/report/2026-09-08.ack-reservation-progress.md",
                   " M docs/report/2026-09-08.exclusive-runtime-port-guard.md",
                   " M docs/worklog/2026-09-08.jsonl",
                   "?? .codex/config.toml",
                   "?? CLAUDE.local.md",
                   "?? t1_verdict_1.txt",
                   "?? t1_verdict_2.txt",
                   "?? t2_verdict_1.txt",
                   "?? t2_verdict_2.txt",
                   "?? t2_verdict_incomplete_True.txt"
               ],
    "worktrees":  [
                      "worktree C:/Work/git/_Snoworca/ProjectMaster",
                      "HEAD 17ff7d4f5024b4b654dbb45f11355b2f4aa92876",
                      "branch refs/heads/work/mcp-session-orchestration-20260709",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster/.claude/worktrees/agent-a3113f66326ff2f27",
                      "HEAD 66500d092740abf8f1f727367e7a96c6c1874d6a",
                      "branch refs/heads/worktree-agent-a3113f66326ff2f27",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-markdown-editor",
                      "HEAD e584c2a4f2216ba689b7f77b8352ac3cde9ac171",
                      "branch refs/heads/feature/markdown-editor",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-revealstep-20260810",
                      "HEAD 14e527aa65f321a3b0b0df3aca83ff810e056a97",
                      "branch refs/heads/work/rel-bgstab-016-admission-20260810",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-baseline",
                      "HEAD 849c3ad0dd232a76aa0713d2cd569f86af8a8a4e",
                      "detached",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-boundary-20260806",
                      "HEAD 32047dd99c44d56297217afc58169517f7b9cf4d",
                      "detached",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-c313-pristine-20260806-r2",
                      "HEAD c3139a0a0ffef060748c94803b608a0b97be2d46",
                      "branch refs/heads/codex/wave3-c313-pristine-20260806-r2",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-closeout-clean",
                      "HEAD c3139a0a0ffef060748c94803b608a0b97be2d46",
                      "branch refs/heads/codex/wave3-closeout-clean-20260806",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-fair-red-20260806",
                      "HEAD ab272be8219e165c7187ec8ebd098ffaff4e3a99",
                      "branch refs/heads/work/wave3-fair-red-20260806",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-final",
                      "HEAD c3139a0a0ffef060748c94803b608a0b97be2d46",
                      "branch refs/heads/codex/wave3-final-20260802",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-hidden-red-20260806",
                      "HEAD ab272be8219e165c7187ec8ebd098ffaff4e3a99",
                      "branch refs/heads/work/wave3-hidden-red-20260806",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-implementation-20260807",
                      "HEAD d9f3257dd1a3d6a2892008d6d93bb35445f9a11e",
                      "branch refs/heads/codex/wave3-closeout-20260807",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-l1-20260812",
                      "HEAD 66e9765670e53397c3a3aa5e6a73f6c2f321fa5c",
                      "branch refs/heads/work/wave3-l1-rel011-20260812",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-rebuild",
                      "HEAD c1157ab5ae42e025064abfc0766893d60ab8c515",
                      "branch refs/heads/codex/wave3-remediation",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-recovery",
                      "HEAD 4c0721d15ef07c326720f54b8645945689bac4c3",
                      "branch refs/heads/codex/wave3-recovery-20260802",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-red-canonical-20260807",
                      "HEAD 849c3ad0dd232a76aa0713d2cd569f86af8a8a4e",
                      "detached",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-reentry",
                      "HEAD ab272be8219e165c7187ec8ebd098ffaff4e3a99",
                      "branch refs/heads/codex/wave3-reentry-prep",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-retained-red-20260806",
                      "HEAD ab272be8219e165c7187ec8ebd098ffaff4e3a99",
                      "branch refs/heads/work/wave3-retained-red-20260806",
                      "",
                      "worktree C:/Work/git/_Snoworca/ProjectMaster-wave3-tdd",
                      "HEAD 0a690fa76e39fd425e955da7c6d4cb4712f22200",
                      "branch refs/heads/codex/wave3-strict-tdd",
                      ""
                  ],
    "target":  "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908",
    "targetExists":  false,
    "preservedUserPaths":  [
                               ".codex/config.toml",
                               "CLAUDE.local.md",
                               "t1_verdict_1.txt",
                               "t1_verdict_2.txt",
                               "t2_verdict_1.txt",
                               "t2_verdict_2.txt",
                               "t2_verdict_incomplete_True.txt"
                           ],
    "hashes":  [
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\.codex\\config.toml",
                       "sha256":  "9C4E94EBFB2C21DFDD42D182C6553C6091E056D34E0B67BFC455CF7724254C38"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\CLAUDE.local.md",
                       "sha256":  "FD40AEE3B18144CF006E832E51CAAA477CA6699382F621D86C7355C03E4E840F"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_1.txt",
                       "sha256":  "EF518FB6CB14622A076E822C7B7CBFC9AA4F03736985F9BCBFE3E4FC4E158553"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_2.txt",
                       "sha256":  "23AE8A2EA5F706EF5011254322A6FAF0F7D54056B8687F68CFE4E9184EFE7FF6"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_1.txt",
                       "sha256":  "6F4327B7B890491EC6C3269153F4DC1577997635D8A19DD614A7D1DCA4F11EC4"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_2.txt",
                       "sha256":  "A29AC5218346F15D3BAE8C56BC780AFC52222FCE1C449ED84D13343D32B68807"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_incomplete_True.txt",
                       "sha256":  "6F4327B7B890491EC6C3269153F4DC1577997635D8A19DD614A7D1DCA4F11EC4"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\src\\test-runner.ts",
                       "sha256":  "CECEF93B6A3715AA366ACFDCCCE5D3DF45A50BB8A5D148C74B1B2D24B2B0DD44"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\tools\\require-exclusive-runtime-port.cjs",
                       "sha256":  "351588B0B33E38E753B8F06280224034DF7C7BA5EB2514BBF8613AEFB176F27C"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\server\\package-lock.json",
                       "sha256":  "447989E8DE20AAEC2532F05622AE27C1993E37937ED51DE0B588C4D6A1342078"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\frontend\\package-lock.json",
                       "sha256":  "41B63B94B65EE1F501F7008A3198E02DBCF775C41399C73FEAE3AC795D0913AB"
                   },
                   {
                       "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\docs\\plan\\2026-09-08.exclusive-runtime-validation.design.md",
                       "sha256":  "CB1E0BBB3CF58F93FDBA259898B8DB11A4D090B74118E6BE5370FDECF456A6F4"
                   }
               ],
    "workflow":  {
                     "workspace":  "C:/Work/git/_Snoworca/ProjectMaster",
                     "run":  "N/A",
                     "task":  "N/A",
                     "event":  "N/A",
                     "idempotency":  "N/A",
                     "reason":  "Operational Git provenance review; no workflow mutation or completion promotion"
                 }
}
```

Decisions: pending three independent roles. No worktree created yet.

## Supplement: original modified-file preservation

```json
[
    {
        "path":  "docs/plan/2026-09-01.remaining-work-backlog.plan.md",
        "sha256":  "C6CE3791B29181109CD9BDFBDBF86AD17F7C91E69871E17E1B4064170449C9FF"
    },
    {
        "path":  "docs/report/2026-09-08.ack-reservation-progress.md",
        "sha256":  "31508DF6D95CBB8B49B81543822940E3804C43F7734910C608ECCF2F64F16A18"
    },
    {
        "path":  "docs/report/2026-09-08.exclusive-runtime-port-guard.md",
        "sha256":  "85A4FE2DB644FED64836EF617A38C422BE34904F91D9B0784F762CA6B96ADB47"
    },
    {
        "path":  "docs/worklog/2026-09-08.jsonl",
        "sha256":  "A6FE9CAAE7FDF80CC4CDD95F72D6C6AE558AC4E1FF5C5E58AE83313249A35126"
    }
]
```

## Checkout representation facts

Git core.autocrlf is true. The fair-source attributes explicitly force LF (for example ws/WsRouter.ts); test-runner.ts and the test preload have unspecified text/eol attributes. Current raw git-hash-object --no-filters values are runner 187f95965fc8d7e62f708d1e3e1c3380620cb362 and preload efe520ae5a064e66ec147fb8ba9cd93c5294fe4a. Committed blobs are runner 582066fd5e3ad96cee8c15eb8f29301249d9dc21 and preload efe520ae5a064e66ec147fb8ba9cd93c5294fe4a. Raw checkout hashes can therefore differ under the configured checkout conversion. Require exact HEAD/tree and blob identity; record new raw hashes and rerun the guard self-tests in the new worktree. Do not claim that the original raw-byte evidence was produced in the new worktree. Any difference beyond the configured representation remains a provenance blocker.

## Creation decision

Three independent roles returned explicit CONSENT with Critical 0 / High 0: analysis_review (audit/tool integrity), baseline_a (preservation/provenance), requirements_mapping (SRS/integration). Each received the same raw packet without peer conclusions. Consent covers exact-HEAD detached creation only. Installation requires independent clean/tree/common-dir/blob and pinned-byte read-back plus original preservation. No runtime or SRS promotion is included.


## Authorized worklog append after creation

At 2026-09-08T01:40:04.382Z the main agent ran the supported tools/worklog.mjs add command for commit17ff7d4, after worktree creation. The command appended exactly one record; it did not alter older records. Current worklog SHA256: 8AF615BBEF218C0A0E81347FD5B84BADAAFA078BC7CFEA50F6857FC602B7EDAF. This is an intentional subsequent original-worktree operational log update, not a worktree-creation side effect. Other preserved paths remain subject to the original comparison.


## Post-creation decision

All three independent roles returned CONSENT with Critical 0 / High 0 for isolated npm ci after read-back. Audit verified clean HEAD/tree/common-dir, pinned source6/current JSON19 exact bytes, tracked blob identity and fresh checkout guard11/11 (Temp buildergate-worktree-audit-readback.json, logSHA a0cbcbb2f48dba799ec73cf637226c54a7216a01bdd794e2c19cf280f128e952). Preservation verified original16 hashes after creation and absence of copied user7/dependencies. SRS/integration verified committed test/plan/lock/patch identity. Runtime/start/stop and completion promotion remain outside this decision.
