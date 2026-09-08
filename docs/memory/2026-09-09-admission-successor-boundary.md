# Admission lifecycle successor preparation boundary

## Post-claim preservation read-back

Independent MCP `list_steps` (package3.0.0, main workspace) and disk read-back confirmed the new step active with SDS draft and target wave-5; its state row touches BGSTAB/PERF-BGSTAB-010. The old worker-successor step remains merged and its SDS remains agreed with unchanged bytes. The state.md change is exactly the new active row. User7, old manifest and the clean canonical333e5e28 checkout remain preserved. Draft body authoring was not reviewed here.

The actual claim response reported `{step,touchesScope,touchesReq,overlaps:[],written:true}`; it did not claim a persisted supersedes relationship. Installed CLI resolution is `C:/Users/beom/AppData/Roaming/npm/speckiwi.ps1`, forwarding to `node_modules/speckiwi/bin/speckiwi`. Read-only inspection of that package's `dist/core/mutation/claim-step.js:52-58` shows `input.supersede` is used only to reject a verified/frozen requirement target when found. The appended active state row at :85-87 and returned value at :101-107 contain no supersedes field. Therefore this claim call did not persist a successor relationship; its absence is not evidence of a failed durable write or a repair requirement. No old lifecycle or relationship mutation was performed by this read-back.

Requirement: N/A operational audit; related PERF-BGSTAB-011/PERF-BGSTAB-010 validation support.

Proposed operation after three independent consents: supported claim of the new step and scaffold of a draft only. Preserve the old merged step and agreed SDS unchanged. Drafting is not adoption of20 children, a runner implementation, an agreed-status change or gate completion. The draft must receive independent review before a separate adoption decision.

The draft must reconcile current20 versus agreed21 (the removed wrapper is not replaced by counting the outer gate), retain118000ms as a failure boundary while considering natural settlement rather than Node termination, and address hardcoded original-root filesystem writes. Current High findings: admission-gate.test.mjs:60-65 uses Node spawnSync timeout; trust.test.mjs:187-214 and seal.test.mjs:132-150 create/remove original-root leaves before collector root validation. Other successful native capture fixtures also carry original-root assumptions. These findings prohibit executing the current full gate. The already-corrected actor release/exit cleanup defect is not reported as an open defect.

No step mutation, source edit, runtime action or decision was performed by this packet author. MCP facts below are attributed to the supplied read-back, not invented independent tool responses.

```json
{
  "at": "2026-09-08T17:19:58.843Z",
  "main": {
    "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "head": "a5df95f59fe61653a82c0e53197a65ab33add431",
    "tree": "383d55262d08eb8fc4d2c86424c959a58dcf46c4",
    "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
    "branch": "work/mcp-session-orchestration-20260709",
    "status": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/worklog/2026-09-09.jsonl\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt"
  },
  "canonical": {
    "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
    "head": "333e5e28adba53384d580386ab8672c8a5dd13b1",
    "status": ""
  },
  "oldSDS": {
    "path": "docs/spec/steps/2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor/design.md",
    "sha256": "48a8129b0bc057832cf0dd437b78e89cfa770a033483ad802348dcb66192b631",
    "statusLine": "| Status | agreed |",
    "statePath": "docs/spec/steps/state.md",
    "stateSHA256": "b7085eabbc1894ec022be5d7bc1e8143fff924dc1cca87490e25a23fb7c496eb",
    "stepRow": "| 2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor | merged | - | tools/wave3 fixture Worker evidence allocation and fixed admission timing | PERF-BGSTAB-010 | 2026-07-27 | 2026-07-27 |"
  },
  "gate": {
    "path": "tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs",
    "sha256": "4b54a36f616e94882412930923d477c329a7168970dc7724cf8d17aebd647446",
    "fixedCount": 20,
    "fixed": [
      {
        "path": "tools/wave3/fair-readmission-closure-v3.test.mjs",
        "sha256": "1e8661ca9c683c4c23ba1c6f1e3435b47fc3ecc904581f94f6a264080958a67b"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.remediation.test.mjs",
        "sha256": "01b0dfa22f616001813c24eabd6e2add7d395b017eefbd3d55f3be190f5f1678"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.reparse.test.mjs",
        "sha256": "e8255105eb0c7596550fd387e235100ee90235f04196d74f23eb7fcb6a58b467"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.batch.test.mjs",
        "sha256": "6ccb72c04e5d5c65cb6a5152cd407bf91d46c05b28a67f187d77e23b763d738f"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.hardening.test.mjs",
        "sha256": "025bfdee99b9d60c966751d1c59f6616aaedf2e81ce3fd0731548175c0637460"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.strict.test.mjs",
        "sha256": "981902c124c62b8b30b5510af319bcfb6397c0c55413332b22999986bf9372f1"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.ingress.test.mjs",
        "sha256": "39afbb720c9a2e26ae0f9711d32fb9916fa421585aa7fe1d364bde18fd9d2d57"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs",
        "sha256": "99e956feb525c29695e4bdda8904e0411e3fb3c0e5f53a5c94be517d835ce9ab"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.wave.test.mjs",
        "sha256": "3ead44a0dd4de0216b2bd2cf3aefc38f79472c72a5a6bb4e887378fa7e4440b4"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.boundary.test.mjs",
        "sha256": "830f6f6f8dc00da6c9e4e2d079ad8ea7ba7f32531301456f2d6839d1a1fdcbb6"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.admission.test.mjs",
        "sha256": "9c8037e350a1d56a37d29a03ac9b885589be229fc38e40e412910534f037b8a7"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs",
        "sha256": "cf342fefe092db43873c8ef66a31252db0e03f3c2e6b2c9502400c6ae1bc7bb0"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.trust.test.mjs",
        "sha256": "f23c0fc1eeb81c49a3b1daf946c3dcb661808e739907735e8d246b57b4bad855"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.trust-race.test.mjs",
        "sha256": "6db978544f18ebde25a511a8b0266cd361dae3bbff7b99460fa43ccc46afad94"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.seal.test.mjs",
        "sha256": "003c6a6f64cb57462a3ea20921fa0fc1db3e41ccc5bfb4b2674dc23ab1c95f94"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs",
        "sha256": "53b4e5de65226efcf95346de6a0e17a04673cf60db5df15913f38e6da318d087"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.lexical.test.mjs",
        "sha256": "d8be3bf3f12ca47f27817420c8f1560aa436a091feeb4e2b460f4985e833cd94"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs",
        "sha256": "9df3a659d81015d37f40e7018571997b8c87bc6c3637b1b9b05419f5227065e7"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs",
        "sha256": "32b70b2e2d17c33e7ef722ca8e028e53942fdf8037274be5f24f0706304a2850"
      },
      {
        "path": "tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs",
        "sha256": "329225f179380797d71ecef6d4e197d24c2e3b36ede42d19839479fe72e8be6b"
      }
    ],
    "timeoutMs": 118000
  },
  "deletedWrapper": {
    "blob": "8c3c38262739b0904882c289ebef3120fb6d8dca",
    "blobType": "blob",
    "historyCommit": "2a20b4f073df7d6a9bbf209deaf3cf0a14221183",
    "historyDiff": "diff --git a/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs b/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs\nindex c290cd0..d41b739 100644\n--- a/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs\n+++ b/tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs\n@@ -17,7 +17,6 @@ const fixedClosureTests = [\n   'tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.wave.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.boundary.test.mjs',\n-  'tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.admission.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs',\n   'tools/wave3/fair-readmission-closure-v3.trust.test.mjs',"
  },
  "userPreservation": {
    "inventory": "docs/memory/2026-09-09-native-probe-canonical-update.md",
    "inventorySHA256": "747a8ff73e924e784b37275094161fbe105712d75c18427011c66d289d12fb2e",
    "count": 7,
    "checks": [
      {
        "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\.codex\\config.toml",
        "previousSHA256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
        "currentSHA256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
        "unchanged": true
      },
      {
        "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\CLAUDE.local.md",
        "previousSHA256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
        "currentSHA256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
        "unchanged": true
      },
      {
        "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_1.txt",
        "previousSHA256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
        "currentSHA256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
        "unchanged": true
      },
      {
        "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_2.txt",
        "previousSHA256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
        "currentSHA256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
        "unchanged": true
      },
      {
        "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_1.txt",
        "previousSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
        "currentSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
        "unchanged": true
      },
      {
        "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_2.txt",
        "previousSHA256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
        "currentSHA256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
        "unchanged": true
      },
      {
        "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_incomplete_True.txt",
        "previousSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
        "currentSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
        "unchanged": true
      }
    ]
  },
  "reportedMcpFacts": {
    "source": "root supplied fresh MCP read-back for this packet; not independently rerun by author",
    "packageVersion": "3.0.0",
    "workspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "mode": "sdd",
    "activeTarget": "wave-5",
    "claimStepDryRun": {
      "step": "2026-09-09.admission-lifecycle-successor",
      "supersedes": "2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor",
      "touches": [
        "BGSTAB",
        "PERF-BGSTAB-010"
      ],
      "ok": true,
      "overlaps": [],
      "written": false
    }
  },
  "workflow": {
    "run": "N/A",
    "task": "N/A",
    "event": "N/A",
    "idempotency": "N/A"
  }
}
```

## Independent draft-registration decisions

Audit/tool integrity, preservation/provenance and SRS/integration each independently returned CONSENT, Critical0/High0. Scope is supported new-step claim and wave-5 draft scaffold only, retaining old merged/agreed state and all old evidence. This is not consent to the20-suite contract, old SDS supersession status, code/test execution or completion. Scaffold dry-run also returned written=false and only the new design.md/intent.md paths.
