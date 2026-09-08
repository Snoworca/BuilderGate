# Boot managed-data preservation boundary

Requirement: N/A operational audit. Runtime scope REL-BGSTAB-001 and IR-BGSTAB-001.

Trigger: post-runtime preservation hashes differ for four canonical-owned managed data files. All app/wrapper processes have exited; no further runtime is started. The initial twenty-file guarantee was checked after canonical checkout/build; runtime did not preserve all twenty bytes. Do not claim initial semantic equivalence from hashes alone.

Observed source: server startup calls CommandPresetService.initialize and TerminalShortcutService.initialize; successful loads also flush, set lastUpdated and rotate the prior file to .bak. The final main/backup pairs differ only in lastUpdated, but initial bytes were not archived, so this does not prove initial-to-final content equality. No restoration from guessed data is proposed. Current four changed files are preserved verbatim in a new owned Temp archive.

Proposed bounded resolution: record16/20 byte preservation and all four observed hashes/snapshots; retain the six functional/guard/closure results only in that scope. Original user/config/cert preservation remains separately checked. Require independent audit/preservation/SRS decisions before adopting the runtime report; future boot preparation must explicitly inventory mutable managed stores and snapshot their initial bytes. No status/AC promotion, file rollback or test-result rewriting.

## Raw facts

```json
{
  "at": "2026-09-08T07:25:00.382498+00:00",
  "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
  "target": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
  "mainHead": "3f3a81434bac389598c3e864b9c0442e012eefb9",
  "canonicalHead": "3f3a81434bac389598c3e864b9c0442e012eefb9",
  "canonicalCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "canonicalStatus": "",
  "sourceStatus": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/memory/2026-09-08-ac11-canonical-update.md\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "preservation": [
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/.codex/config.toml",
      "sha256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
      "afterSha256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/CLAUDE.local.md",
      "sha256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
      "afterSha256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t1_verdict_1.txt",
      "sha256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
      "afterSha256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t1_verdict_2.txt",
      "sha256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
      "afterSha256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t2_verdict_1.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "afterSha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t2_verdict_2.txt",
      "sha256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
      "afterSha256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/t2_verdict_incomplete_True.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "afterSha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/plan/2026-09-01.remaining-work-backlog.plan.md",
      "sha256": "c6ce3791b29181109cd9bdfbdbf86ad17f7c91e69871e17e1b4064170449c9ff",
      "afterSha256": "c6ce3791b29181109cd9bdfbdbf86ad17f7c91e69871e17e1b4064170449c9ff",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/report/2026-09-08.ack-reservation-progress.md",
      "sha256": "31508df6d95cbb8b49b81543822940e3804c43f7734910c608eccf2f64f16a18",
      "afterSha256": "31508df6d95cbb8b49b81543822940e3804c43f7734910c608eccf2f64f16a18",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/worklog/2026-09-08.jsonl",
      "sha256": "57f7477746b247e01c111234b524af52369381ba9621cdb8d8aa784b8a432ea2",
      "afterSha256": "57f7477746b247e01c111234b524af52369381ba9621cdb8d8aa784b8a432ea2",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "afterSha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/agent-command-profiles.json",
      "sha256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde",
      "afterSha256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/command-presets.json",
      "sha256": "4ad92a74f5157bbc026268f84fde7511709a94723a27f76851120161e5dc5064",
      "afterSha256": "eb3cfb090d56e3dce9e32e2f4a86ecb2901fbbfb3530e6b988ecb5ce7de25b89",
      "unchanged": false,
      "afterSnapshot": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-ac11-managed-data-94a6ae1062cb449d93c832638be6b139\\command-presets.json",
      "modifiedAt": "2026-09-08T07:17:54.267555+00:00"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/command-presets.json.bak",
      "sha256": "5c3658f3ebddbcf32e23282892af0a6c0ab7f8eb65a301021d0855ee79c5bd50",
      "afterSha256": "e3a2cf5fca5a96541c1c1176c50ec00caa74dedace75a2dc860c6ad60663ada6",
      "unchanged": false,
      "afterSnapshot": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-ac11-managed-data-94a6ae1062cb449d93c832638be6b139\\command-presets.json.bak",
      "modifiedAt": "2026-09-08T07:16:23.176794+00:00"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/mcp-control-config.json",
      "sha256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0",
      "afterSha256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/recovery-options.json",
      "sha256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f",
      "afterSha256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/terminal-shortcuts.json",
      "sha256": "b5be49522bb1c63e055dd42cff1c8eeedac414b90b8d7562611117a709f23f11",
      "afterSha256": "848810d0dd371e538f390e582cef320371e5fe8c370fb6b786f21c8a976f3171",
      "unchanged": false,
      "afterSnapshot": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-ac11-managed-data-94a6ae1062cb449d93c832638be6b139\\terminal-shortcuts.json",
      "modifiedAt": "2026-09-08T07:17:54.271124+00:00"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/data/terminal-shortcuts.json.bak",
      "sha256": "01957c11a490971ed1286d6ac904b3edc4c9cc073917fa69086efa355e9a03ae",
      "afterSha256": "ca4c24880d09c5ddadb55664a522a0a17c3da487602b4755186d5cd42c3e99e5",
      "unchanged": false,
      "afterSnapshot": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-ac11-managed-data-94a6ae1062cb449d93c832638be6b139\\terminal-shortcuts.json.bak",
      "modifiedAt": "2026-09-08T07:16:23.180283+00:00"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/certs/self-signed.crt",
      "sha256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9",
      "afterSha256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9",
      "unchanged": true
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908/server/certs/self-signed.key",
      "sha256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6",
      "afterSha256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6",
      "unchanged": true
    }
  ],
  "unchanged": 16,
  "total": 20,
  "runtimeSummary": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-ac11-boot6-75be49383a0e4b94ba8403380a9cb2c2\\runtime-summary.json",
  "runtimeSummarySha256": "03f067746d1fe6953a05f27f23b257598aed206825dd96b9cc30b75e1246c807",
  "afterArchive": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-ac11-managed-data-94a6ae1062cb449d93c832638be6b139",
  "workflow": {
    "mode": "sdd",
    "activeTarget": "wave-5",
    "workspaceRoot": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null,
    "reason": "direct operational runtime audit, no workflow repair"
  }
}
```

## Decisions

All three independent decisions were collected before sharing conclusions:

- Audit (analysis_review): CONSENT, Critical0/High0. After hashes/snapshots and runtime114 hashes match; source flush path is confirmed. Initial semantic equality is not established.
- Preservation (baseline_a): CONSENT, Critical0/High0. User/config/cert/lock/HEAD and protected PID are preserved; exact16/20 and changed4 snapshots are verified. No file restoration or additional runtime is approved.
- SRS/integration (requirements_mapping): CONSENT, Critical0/High0. Report only the demonstrated functionality/guard/closure result and16/20 byte preservation. Checkout/build preservation must not be extended to runtime, nor must any AC/status be promoted.

Resolution: preserve the observed data and after snapshots, retain the six-case functional/guard/closure evidence with these limitations, and do not claim complete byte or semantic preservation. Future runtime preparation must list mutable stores and preserve their initial raw bytes before starting. No result file was rewritten, no guessed restoration was performed and no further app was started for this resolution.
