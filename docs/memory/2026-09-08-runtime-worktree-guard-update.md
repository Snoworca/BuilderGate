# Canonical test-guard update boundary

Requirement: N/A (operational provenance). Runtime scope remains REL-BGSTAB-001 and IR-BGSTAB-001.

Trigger: controlled adoption of committed Worker guard changes into the dedicated canonical worktree, currently at the previous tested HEAD. Proposed action: git switch --detach to the exact new HEAD only after 3/3 independent consent. No reset/clean/force/copy/import. Preserve owned config/data/certs/runtime and all original user files. Reuse independently installed dependencies because locks and patches are unchanged. Require post-switch clean HEAD/tree/common-dir/blob/pinned-byte read-back and fresh39+11 no-bind tests before any boot retry. Existing dist build provenance must be checked before reuse or refreshed by the normal build. No runtime start/stop, evidence promotion or completion is approved by this record itself.

Git core.autocrlf=true; expected checkout representation differences must be recorded separately from identical tracked blobs. Do not substitute authoring-checkout raw evidence for canonical execution.

```json
{
    "at":  "2026-09-08T02:34:14.3216242Z",
    "source":  "C:/Work/git/_Snoworca/ProjectMaster",
    "target":  "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908",
    "sourceHead":  "ed5af82905e7273e1a3bb0441db44294ed5512dd",
    "targetHead":  "17ff7d4f5024b4b654dbb45f11355b2f4aa92876",
    "oldHead":  "17ff7d4f5024b4b654dbb45f11355b2f4aa92876",
    "newHead":  "ed5af82905e7273e1a3bb0441db44294ed5512dd",
    "newTree":  "da396c657abe26c0dd446edbe10660f80b484ca0",
    "commonDir":  "C:/Work/git/_Snoworca/ProjectMaster/.git",
    "targetStatus":  [

                     ],
    "changes":  [
                    "A\tdocs/memory/2026-09-08-runtime-worktree-boundary.md",
                    "M\tdocs/plan/2026-09-08.remaining-work-autonomous.plan.md",
                    "A\tdocs/report/2026-09-08.exclusive-peer-ip-and-tls.md",
                    "M\tdocs/report/2026-09-08.exclusive-runtime-port-guard.md",
                    "A\tdocs/report/2026-09-08.native-worker-test-guard.md",
                    "A\tserver/tools/exclusive-runtime-worker-test-preload.cjs",
                    "M\tserver/tools/require-exclusive-runtime-port.cjs",
                    "A\tserver/tools/test-exclusive-runtime-worker.cjs"
                ],
    "newPathCollisions":  [

                          ],
    "preserved":  [
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
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\docs\\plan\\2026-09-01.remaining-work-backlog.plan.md",
                          "sha256":  "C6CE3791B29181109CD9BDFBDBF86AD17F7C91E69871E17E1B4064170449C9FF"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\docs\\report\\2026-09-08.ack-reservation-progress.md",
                          "sha256":  "31508DF6D95CBB8B49B81543822940E3804C43F7734910C608ECCF2F64F16A18"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster\\docs\\worklog\\2026-09-08.jsonl",
                          "sha256":  "8AF615BBEF218C0A0E81347FD5B84BADAAFA078BC7CFEA50F6857FC602B7EDAF"
                      },
                      {
                          "path":  "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/config.json5",
                          "sha256":  "ECBD8AD8D6A086B642188008239C6CDE317BE5CE9EA62D4D14D0D0B637A8B36B"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\agent-command-profiles.json",
                          "sha256":  "41A0D3098C3F124989320107086A43C530ECBFA5ABA40E799ABCD5003CDCCDDE"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\command-presets.json",
                          "sha256":  "F3F41942310680BF81906D8E12A625C162E2079FEE718B71D19F18F77A6A2D7D"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\mcp-control-config.json",
                          "sha256":  "4BF06B880CB31200CED8C70D7D5E9BEFF35252AD138A8FE44A26E172F8E4D8C0"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\recovery-options.json",
                          "sha256":  "A2C754083107C6FF98FD5435B4B23F24682386B5B6B149D05B6E9801F3D1673F"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\terminal-shortcuts.json",
                          "sha256":  "B191F39A5A6984AB4D089BEE18AA5890138E2D793A4F83FC486CD43BCF1C517A"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.crt",
                          "sha256":  "BA6B0071BED007E77B334D4410EB7F4FFB1AC3110509B9A77B1E44EBFAC1B5C9"
                      },
                      {
                          "path":  "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.key",
                          "sha256":  "219887CA56C004D561350242E6CD29DA749931127E1022B5C30996B82FC438A6"
                      }
                  ],
    "workflow":  {
                     "workspace":  "C:/Work/git/_Snoworca/ProjectMaster",
                     "run":  "N/A",
                     "task":  "N/A",
                     "event":  "N/A",
                     "idempotency":  "N/A"
                 }
}
```

Decisions: pending.

## Switch decision

All three independent roles returned explicit CONSENT, Critical0/High0: analysis_review audit, baseline_a preservation, requirements_mapping SRS/integration. No peer conclusions were supplied before decisions. Approval covers only the exact nonforced detached switch; post-switch read-back, new39+11 tests and build provenance remain required before boot.

## Post-switch read-back

Independent audit and preservation checks found clean exact ed5 HEAD/tree/common-dir, pinned source bytes unchanged, and all18 preservation hashes unchanged. Canonical Worker39/39 and TCP11/11 passed (logs Temp/buildergate-postswitch-independent-worker.log SHA e57d30abb7a4368d3cd5a5b18cadd94f12c68b306a71bb357a5b5c1d37fc75f1 and buildergate-postswitch-independent-port.log SHA0827a0fb66b4d60f1d98d532d11cd3086d3be76da5d634551b7007f58586bd38). The normal server build at ed5 exited0 with unchanged lock; native logs/result use Temp/buildergate-canonical-server-build-ed5af82.*. Runtime retry is a separate reviewed harness action.

Functional review correction: Worker PID need not equal app PID because the availability probe uses a separate node child. The proposed equality restriction was withdrawn after source and original19448/34000 evidence recheck. Worker ownership claims remain limited to guard-validated context/entry/pipe, not a separately measured parent-PID chain.
