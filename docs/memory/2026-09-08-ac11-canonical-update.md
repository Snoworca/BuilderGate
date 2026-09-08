# Canonical update for distinct negotiation boot validation

Requirement: N/A operational provenance. Runtime scope: REL-BGSTAB-001 and IR-BGSTAB-001.

Proposed action: after three independent consents, switch only the clean dedicated canonical worktree from the recorded old HEAD to the exact committed new HEAD. No force/reset/clean/copy/import or main-worktree change. Preserve user/config/data/cert/runtime bytes. Dependency reuse requires unchanged locks/patches and existing independently installed canonical dependencies. Rebuild server/frontend and verify new source/authority/built artifacts and no-bind guard controls before any separate runtime-start gate. This decision does not approve start/stop, actual E2E, AC promotion or completion.

## Raw facts

```json
{
  "at": "2026-09-08T06:53:24.823291+00:00",
  "source": "C:/Work/git/_Snoworca/ProjectMaster",
  "target": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908",
  "sourceHead": "3f3a81434bac389598c3e864b9c0442e012eefb9",
  "targetHead": "ed5af82905e7273e1a3bb0441db44294ed5512dd",
  "newTree": "b939c58c091f056e8b0dc502a75bcb90cd24526b",
  "sourceCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "targetCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "sourceBranch": "work/mcp-session-orchestration-20260709",
  "sourceStatus": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "targetStatus": "",
  "changes": [
    "M\tdocs/analysis/terminal-fairness-authority/current.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/fair-scheduler-decision.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/provenance.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-1/trial-0.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-1/trial-1.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-1/trial-2.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-1/trial-3.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-1/trial-4.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-2/trial-0.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-2/trial-1.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-2/trial-2.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-2/trial-3.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-2/trial-4.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-8/trial-0.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-8/trial-1.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-8/trial-2.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-8/trial-3.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/fair-scheduler-raw/clients-8/trial-4.json",
    "A\tdocs/analysis/terminal-fairness-authority/generations/0d7495d52e21c4666a0b5c0f7471a67772df115e274c61b61f2000aa6358461b/raw/manifest.json",
    "A\tdocs/memory/2026-09-08-ac11-source-boundary.md",
    "A\tdocs/memory/2026-09-08-runtime-worktree-guard-update.md",
    "A\tdocs/plan/2026-09-08.binary-negotiation-request.design.md",
    "A\tdocs/plan/2026-09-08.e2e-workspace-ownership.design.md",
    "M\tdocs/plan/2026-09-08.exclusive-runtime-validation.design.md",
    "M\tdocs/plan/2026-09-08.remaining-work-autonomous.plan.md",
    "A\tdocs/report/2026-09-08.binary-negotiation-request.md",
    "A\tdocs/report/2026-09-08.e2e-workspace-ownership-foundation.md",
    "A\tdocs/report/2026-09-08.e2e-workspace-ownership-migration.md",
    "M\tdocs/report/2026-09-08.native-worker-test-guard.md",
    "A\tdocs/report/2026-09-08.production-boot-validation.md",
    "M\tdocs/spec/30.buildergate-stability.srs.md",
    "A\tfrontend/playwright.ownership-validation.config.ts",
    "M\tfrontend/src/types/ws-protocol.ts",
    "M\tfrontend/src/utils/terminalBinaryNegotiationClient.ts",
    "M\tfrontend/tests/e2e/busy-agent-workspace-bounce.spec.ts",
    "M\tfrontend/tests/e2e/grid-equal-mode.spec.ts",
    "M\tfrontend/tests/e2e/header-context-menu-regression.spec.ts",
    "M\tfrontend/tests/e2e/helpers.ts",
    "M\tfrontend/tests/e2e/terminal-authority.spec.ts",
    "M\tfrontend/tests/e2e/terminal-clipboard.spec.ts",
    "M\tfrontend/tests/e2e/terminal-keyboard-regression.spec.ts",
    "M\tfrontend/tests/e2e/terminal-korean-ime.spec.ts",
    "M\tfrontend/tests/e2e/terminal-mobile-scroll.spec.ts",
    "M\tfrontend/tests/e2e/terminal-shortcut-manager.spec.ts",
    "M\tfrontend/tests/e2e/terminal-title-auto-tab-name.spec.ts",
    "M\tfrontend/tests/e2e/wave1-retained-state-characterization.spec.ts",
    "M\tfrontend/tests/e2e/wave3-terminal-authority-fairness.spec.ts",
    "M\tfrontend/tests/e2e/wave3-terminal-authority-promotion.spec.ts",
    "A\tfrontend/tests/e2e/workspace-ownership-validation.spec.ts",
    "M\tfrontend/tests/e2e/workspaceLeakGuard.ts",
    "A\tfrontend/tests/e2e/workspaceOwnershipFixture.ts",
    "M\tfrontend/tests/e2e/workspaceTeardown.ts",
    "A\tfrontend/tests/e2e/workspaceWsCaptureTypes.ts",
    "M\tfrontend/tests/support/terminalSoleWriterInventory.ts",
    "M\tfrontend/tests/unit/terminalBinaryNegotiationClient.test.ts",
    "M\tfrontend/tests/unit/workspaceLeakGuard.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipCleanupMigration.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipDiagnosticDetails.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipExternalConfig.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipFixture.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipMigration.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipPromotionMigration.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipRegistry.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipSpecCleanup.test.ts",
    "A\tfrontend/tests/unit/workspaceOwnershipValidationControl.test.ts",
    "A\tfrontend/tsconfig.e2e-ownership.json",
    "M\tfrontend/tsconfig.test.json",
    "M\tserver/src/ws/WsRouter.ts",
    "M\tserver/src/ws/WsRouterBinaryChannels.test.ts",
    "M\tserver/src/ws/WsRouterWireCodecSend.test.ts",
    "M\tserver/src/ws/terminalBinaryGroupSession.test.ts",
    "M\tserver/src/ws/terminalBinaryNegotiation.test.ts",
    "M\tserver/src/ws/terminalBinaryNegotiation.ts",
    "M\tserver/src/ws/terminalWireFormatBoot.test.ts"
  ],
  "newPathCollisions": [],
  "dependencyChanges": [],
  "preserved": [
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/.codex/config.toml",
      "sha256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/CLAUDE.local.md",
      "sha256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t1_verdict_1.txt",
      "sha256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t1_verdict_2.txt",
      "sha256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t2_verdict_1.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t2_verdict_2.txt",
      "sha256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t2_verdict_incomplete_True.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/plan/2026-09-01.remaining-work-backlog.plan.md",
      "sha256": "c6ce3791b29181109cd9bdfbdbf86ad17f7c91e69871e17e1b4064170449c9ff"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/report/2026-09-08.ack-reservation-progress.md",
      "sha256": "31508df6d95cbb8b49b81543822940e3804c43f7734910c608eccf2f64f16a18"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/worklog/2026-09-08.jsonl",
      "sha256": "57f7477746b247e01c111234b524af52369381ba9621cdb8d8aa784b8a432ea2"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/agent-command-profiles.json",
      "sha256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/command-presets.json",
      "sha256": "4ad92a74f5157bbc026268f84fde7511709a94723a27f76851120161e5dc5064"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/command-presets.json.bak",
      "sha256": "5c3658f3ebddbcf32e23282892af0a6c0ab7f8eb65a301021d0855ee79c5bd50"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/mcp-control-config.json",
      "sha256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/recovery-options.json",
      "sha256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/terminal-shortcuts.json",
      "sha256": "b5be49522bb1c63e055dd42cff1c8eeedac414b90b8d7562611117a709f23f11"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/terminal-shortcuts.json.bak",
      "sha256": "01957c11a490971ed1286d6ac904b3edc4c9cc073917fa69086efa355e9a03ae"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/certs/self-signed.crt",
      "sha256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/certs/self-signed.key",
      "sha256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6"
    }
  ],
  "ports": [
    {
      "port": 2002,
      "address": "::",
      "pid": 44944,
      "exe": "C:\\Work\\agent-tools\\builder-gate__\\node\\node.exe",
      "command": "C:\\Work\\agent-tools\\builder-gate__\\node\\node.exe C:\\Work\\agent-tools\\builder-gate__\\server\\dist\\index.js",
      "created": "2026-09-02T08:35:29.4929520Z"
    },
    {
      "port": 2001,
      "address": "::",
      "pid": 44944,
      "exe": "C:\\Work\\agent-tools\\builder-gate__\\node\\node.exe",
      "command": "C:\\Work\\agent-tools\\builder-gate__\\node\\node.exe C:\\Work\\agent-tools\\builder-gate__\\server\\dist\\index.js",
      "created": "2026-09-02T08:35:29.4929520Z"
    }
  ],
  "workflow": {
    "workspaceRoot": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "mode": "sdd",
    "activeTarget": "wave-5",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null,
    "reason": "direct operational canonical checkout, no workflow repair"
  },
  "dependencyPaths": [
    "server/package.json",
    "server/package-lock.json",
    "frontend/package.json",
    "frontend/package-lock.json",
    "server/tools/ensure-node-pty-windows-hide.cjs",
    "frontend/tools/ensure-react-mosaic-patch.cjs",
    "frontend/patches"
  ]
}
```

## Decisions

All three independent decisions were collected before sharing conclusions:

- Audit (analysis_review): CONSENT, Critical0/High0. Packet/Git/source-artifact identity and preserved20/dependency facts match.
- Preservation (baseline_a): CONSENT, Critical0/High0. Clean target,74 changed paths, collision0, preserved20/20, independent dependencies and protected port identity match.
- SRS/integration (requirements_mapping): CONSENT, Critical0/High0. REL001 stable and IR001 evolving permit the bounded canonical update; current-code runtime and broader gates remain incomplete.

Only the non-forced detached switch to the recorded exact commit is approved. Preserve all recorded bytes, then independently check HEAD/tree/source/provenance and fresh builds/guard tests. Runtime start/stop and completion are not approved by this decision.

## Canonical update and fresh validation

The exact switch to3f3a81434bac389598c3e864b9c0442e012eefb9 completed without force/reset/copy. Independent post-check found target clean, correct tree/common-dir and20/20 preserved bytes. Both canonical builds exited0 with unchanged locks. Fresh canonical source/built authority checks accepted generation0d7495d5, sourcefd5c46ee and profilee116; docs/dist19 bytes match. Independent server124/124, frontend69/69 and guard50/50 (39+11) passed in this worktree. These are new canonical runs, not relabelled authoring-tree results.

Build evidence: `C:/Users/beom/AppData/Local/Temp/buildergate-canonical-server-build-ac11-3f3a814.json` and corresponding frontend result/logs. Independent logs: `buildergate-ac11-canonical-independent-server.log`, `buildergate-ac11-canonical-independent-frontend.log`, `buildergate-canonical-guards-3f3a814-independent.log` in the same Temp directory.

Subsequent runtime validation used a separately reviewed fresh harness. Its result and the later managed-data byte changes are recorded in [the runtime report](../report/2026-09-08.binary-negotiation-boot-validation.md) and [the managed-data incident](2026-09-08-boot-managed-data-boundary.md). The20/20 statement above applies to checkout/build, not the later boot sequence.
