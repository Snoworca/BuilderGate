# FRR source provenance boundary

- Requirement ID: N/A operational audit. Product scope: PERF-BGSTAB-010 AC-1/7/8, reproduced JSON compatibility recovery loss with an active peer.
- MCP workspace same ProjectMaster root, package2.13.1, sdd/wave-5. Direct publication has no workflow run/event/idempotency; no workflow repair proposed.
- Reviewed RED: four original cases2pass2fail; with accessor/lifecycle/hidden/continuity controls16tests9pass7fail. Independent minimal product review No findings; accessor4/4 passes. Admitted runtime regression awaits source-boundary recovery.
- Freeze current source6/HEAD/profile; supported same-workload JSON publication clients[1,2,8], latency150,jitter20,loss0,seed20260723,repeats5,samples30. Preserve all old generations/user7. Build, independent hashes/thresholds/checkout and full relevant ACK/FRR tests must follow.
- B0 HTTP test-helper work is separate and must not change these pinned inputs or HEAD during publication. This recovery does not prove binary ledger resumption, full P4/P9 or finalA5.

## Raw facts

```json
{
  "root": "C:/Work/git/_Snoworca/ProjectMaster",
  "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "branch": "work/mcp-session-orchestration-20260709",
  "head": "3a0addf83c5fab3fc62e58ce23d8dd83fe7183d2",
  "status": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/plan/2026-09-08.fair-recovery-resumption.design.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M server/src/ws/FairTerminalDeliveryScheduler.test.ts\n M server/src/ws/WsRouter.ts\n M server/src/ws/WsRouterSendPriority.test.ts\n M server/src/ws/wsSendPolicy.ts\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/plan/2026-09-08.safe-test-transports.design.md\n?? server/src/testing/\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "sourceDigest": "541eafcdeecb388a919107b6f3b1fc31b60fbfc16346df86fe6c04dcd6a93958",
  "validation": {
    "accepted": false,
    "reason": "decision-artifact-source-digest-mismatch"
  },
  "sources": [
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/server/src/benchmarks/terminalFairnessCharacterization.ts",
      "sha256": "99dc6d06a1d498db5b31bfc7ab013916f05f9cc541da7eaf5642ae34d4bda341"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/server/src/benchmarks/fairSchedulerAuthorityLocator.ts",
      "sha256": "f8672347e293926b3291ef35238cc5b2da29ec76f30475e8110ed97ad30071ad"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/server/src/ws/wsSendPolicy.ts",
      "sha256": "d8161ec40992dfaabc0285fa39d29299b933133931e5be05197eefa7fc258939"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/server/src/ws/WsRouter.ts",
      "sha256": "4b23dfee023c337c77b7158e6e729f52c49ccc403a9372a023fd840da1b095c9"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/server/src/services/TerminalResourcePolicy.ts",
      "sha256": "110ce608ab9a0f73347f0d164960142a104169e9177dd9160302080a1851d425"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/server/src/services/TerminalResourcePolicyCanary.ts",
      "sha256": "f8d79247bf47b03a5f9613134cea7b5c9516caccdea41b694c55e3870767a2f1"
    }
  ],
  "userFiles": [
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
    }
  ],
  "pointer": {
    "decision_artifact": "fair-scheduler-decision.json",
    "decision_sha256": "8f85aaaec22dce4840c84ba19a6680fa9f7152c9addf8a0722d3bfd1c9bb245b",
    "generation_id": "ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a",
    "provenance_artifact": "provenance.json",
    "provenance_sha256": "e4a3c741e59419749f9b50f8adf1161769edbe8b62d31c47b6d358293fd19fe0",
    "publication_generation": "ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a",
    "raw_manifest_sha256": "129bee7bf0b242fe1bee3f015c837b007555c6fdfc79434fbbfa2ebed81ff92c",
    "raw_root": "raw/",
    "schema_version": "fair-scheduler-current-authority/v1"
  },
  "pointerHash": {
    "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/current.json",
    "sha256": "ed2303d8a27a28f837357b5706ac519e8c2954c3945fa351048445aac2d14844"
  },
  "oldGeneration": [
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/fair-scheduler-decision.json",
      "sha256": "8f85aaaec22dce4840c84ba19a6680fa9f7152c9addf8a0722d3bfd1c9bb245b"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/provenance.json",
      "sha256": "e4a3c741e59419749f9b50f8adf1161769edbe8b62d31c47b6d358293fd19fe0"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-1/trial-0.json",
      "sha256": "02e66b03485100d717c7060059f9b9e22c7e78ddc1ee2ebd96d24e510d3624d9"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-1/trial-1.json",
      "sha256": "3f9af58d61a734ae9bc47e751920b3075273173e9d4fa92f58c2d68725c24d3c"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-1/trial-2.json",
      "sha256": "f5c50aadf8b4c903a6300e73c99c5f18c7d741d818dc23b475a1837bad1777c3"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-1/trial-3.json",
      "sha256": "ee62af8e33c957f17e9b2dfb0383d8c2e5b15e9308063c9ff30b5bcd8db7a61d"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-1/trial-4.json",
      "sha256": "d8020020a416b2f9040920218b8ce33c4ec0b2e282d550946dc858ce294c9696"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-2/trial-0.json",
      "sha256": "4752db3512749e87c6f7a7fcd50c0481866259719a11a1e91906e12832eac6e7"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-2/trial-1.json",
      "sha256": "a85eebf906cf887a59d8efdf698f67233cf0a67f2e93d40326b067ef1bd0fd1e"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-2/trial-2.json",
      "sha256": "d2daa82584cc838e89a37f913d4b3dd1db26bbaa6d6f1bc889fe1a71037cc442"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-2/trial-3.json",
      "sha256": "c11c982d5a87bdcbbcb438f99a6d630a17564bbf66f43f3f8db61b8415eeff1e"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-2/trial-4.json",
      "sha256": "44f04f789f97fcb08b705c871963998b5d65325ae0b6541ddb46e916f3e43286"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-8/trial-0.json",
      "sha256": "d6862a01e58654b5578dd1eda3af2b3771dac01cddad2d1d981c5a04ebbd72ff"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-8/trial-1.json",
      "sha256": "c7b455eb20e109addbcdf65db47625a53a396f8a1d00e9f58fbf4367b3dd5718"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-8/trial-2.json",
      "sha256": "1c090ca031f4c8dcf0008b7e18f6ca1d90fa55142003633cedf904a8dd77d4d1"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-8/trial-3.json",
      "sha256": "3451764be2b5b72f0fdadb98cd9c2790370e2fbd0c6fa5d4c9185d1342af4ff7"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/fair-scheduler-raw/clients-8/trial-4.json",
      "sha256": "36de85d8510d6254a97304d56b7e4179f83469ff647441f3a3ff739cfe58ca0c"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a/raw/manifest.json",
      "sha256": "129bee7bf0b242fe1bee3f015c837b007555c6fdfc79434fbbfa2ebed81ff92c"
    }
  ],
  "runtimePolicy": {
    "schemaVersion": "fair-scheduler-runtime-policy-profile/v1",
    "authority": "runtime-config-store/v1",
    "policy": {
      "strategy": {
        "value": "deficit-round-robin",
        "source": "fair-scheduler-decision.json#candidate"
      },
      "socketSoftGateBytes": {
        "value": 8388608,
        "source": "resourceLimits.ws.serverBufferedHighWaterBytes"
      },
      "bulkSliceBytes": {
        "value": 131072,
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes"
      },
      "smallOutputBypassBytes": {
        "value": 32768,
        "source": "resourceLimits.ws.perClientControlQueueMaxBytes"
      },
      "visibilityWeight": {
        "value": 8,
        "source": "resourceLimits.ws.perClientControlQueueMaxBytes"
      },
      "driverWeight": {
        "value": 16,
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes"
      },
      "creditWindowBytes": {
        "value": 2097152,
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes"
      },
      "ackTimeoutMs": {
        "value": 5000,
        "source": "ws.terminal-delivery.ack-timeout"
      },
      "queueMaxBytes": {
        "value": 2097152,
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes"
      }
    },
    "policyHash": "fd56393442325f3a45291eb8fa0d7eea03616717a49f93269f8e774d9e91f7db",
    "profileHash": "e1160f612b59281a25c7604823ba3cc48e1512e89d89ef155301b5cdb85ba5b5"
  }
}
```

## Decisions and recovery

- Audit analysis_review: CONSENT, Critical/High0; MCP/Git/current digest and32 source/user/artifact hashes independently match. The old-generation rejection is the normal gate.
- Preservation baseline_a: CONSENT, Critical/High0; source6/user7/oldab86 generation18/pointer and root/common-dir/HEAD match. No authority changes preceded the decision.
- SRS/integration requirements_mapping: CONSENT, Critical/High0; bounded JSON correction and supported publication align with existing evolving requirements. Full related regressions are mandatory; binary/P4/P9/A5 and broader retained-recovery claims remain open.
- All three independent decisions were collected before circulation. Supported same-workload publication/build is authorized with source6/HEAD/profile frozen; B0 remains outside these inputs.
- Supported publication created93a160c75253061188449ca6bc90ca7d1f3bb456e07f34adc833c65614164f24 with frozen source541e.../profile; npm build exited0. Evidence: C:/Users/beom/AppData/Local/Temp/buildergate-frr-republish-evidence.json and buildergate-frr-build.log.
- Independent audit post-check CONSENT: source/built/decision hashes agree, raw15/1650 samples and19-file byte equality validate, unchanged thresholds pass. Preservation post-check CONSENT: source6/user7/HEAD/oldab86gen18 unchanged; checkout27/27. Integration No findings:123/123 with original4 and hidden/lifecycle cases passing, no fail/skip/todo/cancelled.
- Full final logs/hashes and scope are in docs/report/2026-09-08.fair-recovery-compatibility.md. Operational recovery is complete for the JSON compatibility defect; binary resumption/full P4/P9/A5 remain open.
