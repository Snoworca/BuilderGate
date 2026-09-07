# P4a source provenance boundary

- Requirement ID: N/A (operational audit). Task requirements: PERF-BGSTAB-011 AC-7/10 subset, PERF-BGSTAB-010 AC-5/6.
- MCP workspace: C:/Work/git/_Snoworca/ProjectMaster; package 2.13.1; mode sdd; active target wave-5. No workflow run/event/idempotency is used by this direct publication; no workflow repair is proposed.
- P4a protocol/router/rejection code is test-first; independent protocol9 and frontend15 passed. Router RED16=7pass9fail before its changes. Broader admitted runtime verification remains pending.
- Proposed recovery: freeze source6/HEAD/profile, supported publisher with clients[1,2,8], latency150,jitter20,loss0,seed20260723,repeats5,samples30; preserve every old generation and user file. Build and independent provenance/checkout/regression follow publication.
- This intermediate JSON publication does not complete P4b, binary convergence, finalA5 or any broad AC. Three independent committee consents with C/H0 are required before publication.

## Raw facts

```json
{
  "root": "C:/Work/git/_Snoworca/ProjectMaster",
  "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "branch": "work/mcp-session-orchestration-20260709",
  "head": "ca75443b21f736381b4ae24a220b52714cc77456",
  "status": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/plan/2026-09-08.ack-domain.design.md\n M docs/plan/2026-09-08.remaining-work-autonomous.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M frontend/src/contexts/WebSocketContext.tsx\n M frontend/src/types/ws-protocol.ts\n M frontend/tests/unit/terminalContainerRecoveryContract.test.ts\n M server/src/types/ws-protocol.ts\n M server/src/ws/WsRouter.ts\n M server/src/ws/WsRouterSendPriority.test.ts\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/report/2026-09-08.remaining-test-inventory.md\n?? frontend/tests/unit/terminalAckRejectionDispatch.test.ts\n?? server/src/types/wsProtocolParityAck.test.ts\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "sourceDigest": "65fc9118c75776a9eed7acb51174c6d8355deabd934b9c84ae35455bf5a0c534",
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
      "sha256": "6b080464ef1818bd5ba876cec04f82c73a36f41df366984b90456bc22a5d4727"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/server/src/ws/WsRouter.ts",
      "sha256": "c10d1859a62de00542b6eafe1892e5ebe75d75a364b9f49351df29221164bd3e"
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
    "decision_sha256": "59c9aeb01d0d913280e84c2723147854ea634a26d1fdc93eb64a257333a81eac",
    "generation_id": "a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c",
    "provenance_artifact": "provenance.json",
    "provenance_sha256": "7ddb0e3509aef199740bba835dc0e56d86863549e0385ee5b7666909739cb5ba",
    "publication_generation": "a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c",
    "raw_manifest_sha256": "83debe405d6bbf21050458ed2cd27b84c4704f3c9172d3bf13cf8196954f91fd",
    "raw_root": "raw/",
    "schema_version": "fair-scheduler-current-authority/v1"
  },
  "pointerHash": {
    "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/current.json",
    "sha256": "bde780d6989ca08ff17d33e4a17f63598600f4a4ac4320b91e689b1d0be11af4"
  },
  "oldGeneration": [
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/fair-scheduler-decision.json",
      "sha256": "59c9aeb01d0d913280e84c2723147854ea634a26d1fdc93eb64a257333a81eac"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/provenance.json",
      "sha256": "7ddb0e3509aef199740bba835dc0e56d86863549e0385ee5b7666909739cb5ba"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-1/trial-0.json",
      "sha256": "02e66b03485100d717c7060059f9b9e22c7e78ddc1ee2ebd96d24e510d3624d9"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-1/trial-1.json",
      "sha256": "3f9af58d61a734ae9bc47e751920b3075273173e9d4fa92f58c2d68725c24d3c"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-1/trial-2.json",
      "sha256": "f5c50aadf8b4c903a6300e73c99c5f18c7d741d818dc23b475a1837bad1777c3"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-1/trial-3.json",
      "sha256": "ee62af8e33c957f17e9b2dfb0383d8c2e5b15e9308063c9ff30b5bcd8db7a61d"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-1/trial-4.json",
      "sha256": "d8020020a416b2f9040920218b8ce33c4ec0b2e282d550946dc858ce294c9696"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-2/trial-0.json",
      "sha256": "4752db3512749e87c6f7a7fcd50c0481866259719a11a1e91906e12832eac6e7"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-2/trial-1.json",
      "sha256": "a85eebf906cf887a59d8efdf698f67233cf0a67f2e93d40326b067ef1bd0fd1e"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-2/trial-2.json",
      "sha256": "d2daa82584cc838e89a37f913d4b3dd1db26bbaa6d6f1bc889fe1a71037cc442"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-2/trial-3.json",
      "sha256": "c11c982d5a87bdcbbcb438f99a6d630a17564bbf66f43f3f8db61b8415eeff1e"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-2/trial-4.json",
      "sha256": "44f04f789f97fcb08b705c871963998b5d65325ae0b6541ddb46e916f3e43286"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-8/trial-0.json",
      "sha256": "d6862a01e58654b5578dd1eda3af2b3771dac01cddad2d1d981c5a04ebbd72ff"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-8/trial-1.json",
      "sha256": "c7b455eb20e109addbcdf65db47625a53a396f8a1d00e9f58fbf4367b3dd5718"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-8/trial-2.json",
      "sha256": "1c090ca031f4c8dcf0008b7e18f6ca1d90fa55142003633cedf904a8dd77d4d1"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-8/trial-3.json",
      "sha256": "3451764be2b5b72f0fdadb98cd9c2790370e2fbd0c6fa5d4c9185d1342af4ff7"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/fair-scheduler-raw/clients-8/trial-4.json",
      "sha256": "36de85d8510d6254a97304d56b7e4179f83469ff647441f3a3ff739cfe58ca0c"
    },
    {
      "path": "C:/Work/git/_Snoworca/ProjectMaster/docs/analysis/terminal-fairness-authority/generations/a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c/raw/manifest.json",
      "sha256": "83debe405d6bbf21050458ed2cd27b84c4704f3c9172d3bf13cf8196954f91fd"
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

- Audit (analysis_review): CONSENT, Critical/High0. MCP/Git/source/artifact hashes and normal source-digest rejection independently confirmed.
- Preservation (baseline_a): CONSENT, Critical/High0. Source6/user7/current pointer/old generation18 unchanged and matching packet/previous audit.
- SRS/integration (requirements_mapping): CONSENT, Critical/High0. Intermediate JSON subset is allowed with unchanged scope, workload and verification gates; broad ACs remain open.
- All three decisions were collected independently before circulation. Supported publication/build and independent final read-back are now authorized. No workflow repair, hash override or policy relaxation is involved.
- Supported publisher created ab86a84b1a1aea93b53ab101af75047f47142158106afa77606ecf093cd3079a with the frozen source/profile/workload; npm run build exited0. Raw evidence: C:/Users/beom/AppData/Local/Temp/buildergate-p4a-republish-evidence.json and buildergate-p4a-build.log.
- Independent audit post-check CONSENT: raw15/sample1650 hashes, source/built19-file equality and all unchanged thresholds passed; source/built/decision digests match. Preservation post-check CONSENT: source6/user7/HEAD/old generation18 unchanged, only authorized current/new generation changed; checkout27/27.
- Independent integration No findings: server108/108, frontend96/96, no fail/cancelled/skipped/todo; server/frontend local tsc0. Final logs/hashes are recorded in docs/report/2026-09-08.A-source-ack-protocol.md. P4a operational recovery is complete; P4b, binary convergence and finalA5 remain open.
