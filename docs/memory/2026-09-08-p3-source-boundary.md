# P3 source digest boundary

- Date: 2026-09-08 KST; Requirement ID: N/A operational boundary audit only.
- Root/common-dir: C:/Work/git/_Snoworca/ProjectMaster and its .git; branch work/mcp-session-orchestration-20260709.
- MCP workspace same root, package2.13.1, mode sdd, active target wave-5. Workflow run/event/idempotency not used for this direct test/publication work; no workflow repair is alleged.
- Task: P3 A-2/A-3, source ACK accounting. Current changes are this thread's authorized code/test/docs; original user untracked7 remain untouched (their hashes are in prior source boundary audit).
- Trigger observed by actual validatePublishedFairDeliveryCandidateArtifact(): accepted=false, reason=decision-artifact-source-digest-mismatch.
- Current computed source digest: b8b3442b0a9602aaeb3d448f067371da8df8359f141a8eea30034693a2cb95ff.
- Current producer/test bytes are frozen pending this committee and publication. No attribute, threshold or hash-algorithm changes proposed.

## Raw facts supplied identically

```json
{
  "head": "b359b058c78673b7276f04f2bd94dc28909d1544",
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
      "sha256": "6b080464ef1818bd5ba876cec04f82c73a36f41df366984b90456bc22a5d4727"
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
  "pointer": {
    "decision_artifact": "fair-scheduler-decision.json",
    "decision_sha256": "884b367c446b02297562a68c1339772c0be7a14e9f2c20b3f1ca75334d3a5c04",
    "generation_id": "d77cef68372a6a4d1354b2e537b9adf116a433db40339b0067352574408f57ee",
    "provenance_artifact": "provenance.json",
    "provenance_sha256": "001d4b94fd24e591eee950aed71c8153a6633d0d0b4a739731e4a04696dd8004",
    "publication_generation": "d77cef68372a6a4d1354b2e537b9adf116a433db40339b0067352574408f57ee",
    "raw_manifest_sha256": "9d507506018e767683483fe04c9f9e37ea4f60830297b2037d05e4471668025a",
    "raw_root": "raw/",
    "schema_version": "fair-scheduler-current-authority/v1"
  },
  "pointerSha256": "4c96b55bb4ad634379b69aa7399d482d8b5dae1d6f39d9bdff851711b6b1efe2",
  "artifactSourceDigest": "78c951ac5b80067538270e8b52bf89fc5f2079aa76ba9703589555af23361236",
  "profile": {
    "authority": "runtime-config-store/v1",
    "policy": {
      "ackTimeoutMs": {
        "source": "ws.terminal-delivery.ack-timeout",
        "value": 5000
      },
      "bulkSliceBytes": {
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes",
        "value": 131072
      },
      "creditWindowBytes": {
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes",
        "value": 2097152
      },
      "driverWeight": {
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes",
        "value": 16
      },
      "queueMaxBytes": {
        "source": "resourceLimits.ws.perClientOutputQueueMaxBytes",
        "value": 2097152
      },
      "smallOutputBypassBytes": {
        "source": "resourceLimits.ws.perClientControlQueueMaxBytes",
        "value": 32768
      },
      "socketSoftGateBytes": {
        "source": "resourceLimits.ws.serverBufferedHighWaterBytes",
        "value": 8388608
      },
      "strategy": {
        "source": "fair-scheduler-decision.json#candidate",
        "value": "deficit-round-robin"
      },
      "visibilityWeight": {
        "source": "resourceLimits.ws.perClientControlQueueMaxBytes",
        "value": 8
      }
    },
    "policyHash": "fd56393442325f3a45291eb8fa0d7eea03616717a49f93269f8e774d9e91f7db",
    "profileHash": "e1160f612b59281a25c7604823ba3cc48e1512e89d89ef155301b5cdb85ba5b5",
    "schemaVersion": "fair-scheduler-runtime-policy-profile/v1"
  },
  "workload": {
    "clients": [
      1,
      2,
      8
    ],
    "repeats": 5,
    "samples": 30,
    "seed": 20260723,
    "wan": {
      "jitterMs": 20,
      "latencyMs": 150,
      "lossPercent": 0
    }
  }
}
```

## Test and mutation observations

- Strict RED15 tests:1pass14fail before implementation; log C:/Users/beom/AppData/Local/Temp/buildergate-p3-ack-controls-red.log SHA25659456CA794A8154380A1A61E940891CEAE59715F1A303B6624CD58C0E0B92DBD.
- Independent code reviewer analysis_review: No findings; new15+existing18 core tests33/33 exit0. Raw C:/Users/beom/AppData/Local/Temp/buildergate-p3-independent-green.log SHA256FFFA9A7F29646BFDA098C42940B7DD18AB1F1989AD2D432C11ADD6BAD0FC5C2D.
- Mutation tester baseline_a: S0=15/15, harmless S1=15/15, wrong-ceiling S2=9pass6fail, restored15/15. Required large-source test killed; legacy/domain controls survived; original source/test hashes restored.
- Mutation record C:/Users/beom/AppData/Local/Temp/buildergate-p3-mutation-nagqQ1/result.json SHA2564399ECC4B1835A76DDCC57DBFD179C647258C3A67D2E128C1571AAECA620F7FF.
- Local server tsc --noEmit exited0 after input/output type declarations. Full admitted-router regression and publication remain pending.

## Proposed recovery for independent judgement

- Freeze current source6/HEAD/runtime policy and same registered workload.
- Use supported publishFairSchedulerAuthorityGeneration to create a new JSON generation, preserve all prior generations, then npm run build in its registered writer order.
- Independently validate hashes/thresholds/source-dist/checkout27 and rerun the full four ACK-related suites (new15+prior68), preserving every regression failure until proved repaired.
- This is P3 intermediate publication, not P4 wire/browser integration, binary adoption, finalA5 or overall completion.

## Decisions and recovery

- Audit role (analysis_review): CONSENT; MCP/Git/digest/mutation facts independently match, normal gate, no workflow repair; C/H0 for recovery.
- Preservation role (baseline_a): CONSENT; source6/user7 and prior d77 generation intact, restore maintained, LF rules unchanged; C/H0 for recovery.
- SRS/integration role (requirements_mapping): CONSENT; current-source intermediate JSON publication satisfies gate prerequisites; full83/checkout required, broad ACs/P4/binary/A5 remain open; C/H0 for recovery.
- Require independent3/3 explicit consent and C/H0 for recovery before mutation/adoption; do not share this incident's conclusions before all roles return.
- All three independent conclusions were collected before circulation. Supported publisher created a96c770f078577147a7ed985bff7cdbc855e8099a9df2f8bcdb7be98b196575c with sourceb8b3442b0a9602aaeb3d448f067371da8df8359f141a8eea30034693a2cb95ff and unchanged profile/workload. Evidence: C:/Users/beom/AppData/Local/Temp/buildergate-p3-republish-evidence.json.
- npm run build exited0; raw log C:/Users/beom/AppData/Local/Temp/buildergate-p3-build.log records the19-file bundle.
- Audit post-check CONSENT: source/built/decision digest match, raw15/sample1650 hashes and19-file byte equality validated, all unchanged thresholds accept.
- Preservation post-check CONSENT: source6/user7/HEAD unchanged, prior d77 generation intact, newa96/currentpointer only authorized authority changes.
- Integration post-check No findings:83/83 and checkout27/27 exit0 with no fail/cancelled/skipped/todo; localtsc0. Raw suites SHA256B63DD1ECDCC516809FD7504A33C3CDBFFB51B86E239C1D8C610C7994A1DA32E8, checkout SHA2565488281722C7D07735708F554CEAF6E4C758EE59EA26AE328BBF95C9AF4B2C38. Logs buildergate-p3-postcheck-* in systemTemp.
- Current P3 internal accounting recovery is validated. P4/browser/binary/finalA5 remain open; operational audit does not replace per-requirement implementation evidence.
