# Admission capture preservation count correction

Requirement: N/A operational provenance; related PERF-BGSTAB-010 AC-3.

Trigger: the new capture observer reports that the18-row preservation list has one duplicate canonical config path. Earlier wording said18 files. The original17-row list already included that config; preparing the new packet appended it again. No original row was removed. Preserve the original packet and results; do not edit raw evidence to make the count appear different. Three independent decisions are required before admitting the corrected bounded observation or proceeding to input-dependent execution.

```json
{
  "artifactRoot": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-admission-canonical-4eo_nnbk",
  "rows": 18,
  "uniquePaths": 17,
  "duplicates": {
    "c:\\work\\git\\_snoworca\\projectmaster-validation-20260908\\server\\config.json5": 2
  },
  "artifacts": {
    "preserved.json": "788ce47d37ab84fd9cff72ece6049f6c0a25af8ccefd29689db36a3dbea6ad3f",
    "capture.mjs": "783eec7b2658ca1e8346071e9b67a6ecaf93f905ce5094857cdeaaffd241bd76",
    "run-capture.mjs": "a7bc3f4b342f41e31c4e532ac5cd3e5d5d203c9fc60cd7346f25eca24ee1cdf0",
    "capture-started.json": "3b61b3e308d8635bf6a130476a5f4d94e50eb501a4f2448167c13ace621f0c82",
    "capture-result.json": "a3947d7dc144162098f085f58b605b3ebc2a940dc027124e6b6df23c065d7f0a",
    "captured-manifest.json": "831a14390e567e825c8e74957e1f4aadbb7c9e7db42e49111e8820dcc4e0907d",
    "observer-before.json": "4acbf2917552801a7d606b7b298aa27e835ef7a5c0959f89df5a9ee213f26432",
    "observer-after.json": "54d7881e87396037b6acbd04b06a4d0ffa7cab3b38e5ece1a124375db2516d63",
    "observer-process.json": "271c28e4b1c8256571b7ea7701d039c2e23f7d16e7bedce450efb1e532e9d79e",
    "observer-result.json": "4c09c51e3e0d5c5d1fed7a4fc6e26dc79ffc9ae60b4f53a388ae955588308e02",
    "observer-raw.log": "fae311a81d9ab73cc4b07caa238e2a3ae42f37e34cfdccacbc503f25786e89f4"
  },
  "proposedDisposition": "Keep all raw artifacts unchanged. Correct preservation statements to 18 rows / 17 unique paths. Admit only the observed one owned capture and preservation facts, subject to independent complete input inventory; no Worker/full-gate execution or SRS promotion."
}
```

## Decisions

All three independent roles returned CONSENT, Critical0/High0: audit/tool integrity (fresh reviewer), preservation/provenance, and SRS/integration. They verified the11 raw artifact hashes and18 rows/17 unique paths; preservation additionally confirmed equality with the original17-path set, current hashes, user7 non-import and protected process identity. The SRS role also checked the appended operational metadata. No raw artifact was changed. The earlier wording "18 files" was incorrect; the correct statement is18 preservation rows representing17 unique paths. The single capture and its observed preservation are admitted only in this corrected scope. Full input inventory is still unverified and no actual Worker/full-gate or SRS promotion is admitted.

## Current operational context

Source-update provenance is retained in [canonical update](2026-09-09-admission-canonical-update.md). Worklog/MCP lifecycle mutation is not involved in this direct capture observation.

```json
{
  "mainRoot": "C:/Work/git/_Snoworca/ProjectMaster",
  "canonicalRoot": "C:/Work/git/_Snoworca/ProjectMaster-validation-20260908",
  "mainHead": "8ab7756c2c18693ae4d8926f2e3bb26d129269e0",
  "canonicalHead": "bbf59ed57025012834c284dbbca75497f5baa467",
  "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "mainBranch": "work/mcp-session-orchestration-20260709",
  "canonicalBranch": "",
  "mainStatus": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/memory/2026-09-09-admission-capture-count-correction.md\n?? docs/worklog/2026-09-09.jsonl\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "canonicalStatus": "",
  "workflow": {
    "mcpVersion": "3.0.0",
    "workspaceRoot": "C:/Work/git/_Snoworca/ProjectMaster",
    "mode": "sdd",
    "activeTarget": "wave-5",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null
  }
}
```
