# Hardening fixture canonical update - raw delta

Requirement: N/A operational audit; related PERF-BGSTAB-011.

Proposed action: non-force exact 333e5e28adba53384d580386ab8672c8a5dd13b1 checkout in the clean canonical worktree, followed by fresh17 controls and supported collector capture. Actual physical execution requires independent verification of the new manifest first. Preserve the referenced input inventory, old manifest, user7 and canonical-owned configuration/data/certificates; no original user config copying or adoption. No conclusions or committee decisions are included.

The prior inventory is referenced by file hash rather than duplicated. Current149 comparisons use its target checkout hash predictions (canonical6bd); differences from the older150 bytes are reported separately. Hardening is a test fixture change, not an automatic change to the149 capture input set.

```json
{
  "at": "2026-09-08T17:05:28.811Z",
  "main": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
  "canonical": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
  "mainHead": "333e5e28adba53384d580386ab8672c8a5dd13b1",
  "canonicalHead": "6bd484b70fbb94ff9f0a2c0b1a2cc1051693add7",
  "mainTree": "c7079279ad8c8348ad50a2873369b2789428e05c",
  "canonicalTree": "20aab8c9fa9a3c48bae3afea7e8c2f07319f1b12",
  "mainCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "canonicalCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "mainStatus": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/worklog/2026-09-09.jsonl\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "canonicalStatus": "",
  "inventoryReference": {
    "path": "docs/memory/2026-09-09-native-probe-canonical-update.md",
    "sha256": "747a8ff73e924e784b37275094161fbe105712d75c18427011c66d289d12fb2e",
    "inputField": "inputs",
    "preservedField": "preserved"
  },
  "inputChecks": {
    "count": 149,
    "expectedBasis": "previous targetExpectedCheckoutSHA256 at canonical6bd",
    "mismatches": [],
    "differencesFromPrevious150Inventory": [
      {
        "path": "tools/wave3/fair-readmission-closure-v3.mjs",
        "oldInventorySHA256": "dc78fb2d980f72e11322ebc8514286673f591b85ebe7544fdc0424c64c27816e",
        "expectedCanonicalSHA256": "572742093b106470e422ff396f31ef8f6b4b75e5440903af7ce0bd1b13980059",
        "actualSHA256": "572742093b106470e422ff396f31ef8f6b4b75e5440903af7ce0bd1b13980059"
      }
    ],
    "targetCommitInputChanges": []
  },
  "preservationChecks": {
    "count": 17,
    "mismatches": []
  },
  "changes": [
    "A\tdocs/memory/2026-09-09-native-probe-canonical-update.md",
    "M\tdocs/plan/2026-09-08.remaining-work-autonomous.plan.md",
    "A\tdocs/plan/2026-09-09.hardening-checkout-root.md",
    "M\ttools/wave3/fair-readmission-closure-v3.hardening.test.mjs"
  ],
  "newPathCollisions": [],
  "dependencyChanges": [],
  "oldManifest": {
    "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-fixture-canonical-manifest.json",
    "sha256": "ea4b3589aa66a47f6c727c8b6916804ee0eac9bbc670218071486a8966a214d0",
    "currentSHA256": "ea4b3589aa66a47f6c727c8b6916804ee0eac9bbc670218071486a8966a214d0"
  },
  "hardening": {
    "path": "tools/wave3/fair-readmission-closure-v3.hardening.test.mjs",
    "listedIn149": false,
    "canonicalSHA256": "a6ff40c8cbea7db59a786f758283a8531dd025e9d9035ba09c27565f10ed78cc",
    "targetMainSHA256": "025bfdee99b9d60c966751d1c59f6616aaedf2e81ce3fd0731548175c0637460",
    "targetBlob": "3c3f66fb97e50b367a3c9366fff556273a4fbab6"
  },
  "workflow": {
    "mcpWorkspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "run": "N/A",
    "task": "N/A",
    "event": "N/A",
    "idempotency": "N/A"
  }
}
```

## Independent decisions

Audit/tool integrity, preservation/provenance and SRS/integration independently returned CONSENT with Critical0/High0 before circulation. Scope: exact non-force333 checkout, fresh17 controls and supported capture. New-manifest validation remains required before physical execution; no old-evidence relabelling or SRS promotion.

## Follow-through

Exact333 checkout remained clean and fresh canonical controls passed17/17 (independent log SHA25683b5c01339c5431186a1dd01f1dd4a911235ec71ebcf289b18f62f6361e6f67e). Supported capture naturally exited0 after11736.9ms. Independent validation checked unique149 inputs, preserved17, collector/runtime/Git binding. Manifest SHA256d736c6276389d9b519fc41818e9bc21a2db4763d0a5701ee8e7ce048cfc2f51a was archived byte-exactly in Temp/buildergate-native-canonical-observer-370a31528e4b4a47b064bb117e35fa9f/capture/captured-manifest.json; only the exact generated nonce was removed. Independent post-archive read-back confirmed input/preservation/HEAD/clean state before physical execution.

The selected physical second parent then naturally exited0/signalnull in65151.6ms: parent1+children8 all passed, cancelled/skipped/TODO0, unchanged115000ms limit. Independent result review returned No findings. Final preservation and the bounded result report are recorded separately; no full admission/three-run completion or SRS promotion.
