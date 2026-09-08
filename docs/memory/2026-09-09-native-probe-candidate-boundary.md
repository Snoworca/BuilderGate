# Native probe candidate adoption boundary

Requirement: N/A operational provenance; product-validation scope PERF-BGSTAB-011.

Trigger: collector bytes change with the candidate program. Old collector-bound manifests are not evidence for the new bytes. Proposed bounded adoption is a source commit after semantic/paired-code review; preserve prior manifests, no authority/SRS/AC promotion. Follow with a separately verified canonical checkout and a fresh capture binding the new collector bytes before physical validation. No unrelated fair-scheduler generation republish is proposed because the six fairness source inputs are unchanged.

Existing performance RED is the115000ms physical timeout, not a semantic regression. Native baseline and candidate semantics are recorded; independent17/17 controls pass. Paired20 calls keep identical inputs/executable/options and all valid outcomes, with observed median improvements near18%. The result is small-sample local evidence, not full timing-gate success. Strong-name assembly selection is validated only on this fixed Windows PowerShell5.1 host. Limits/freshness/parent115000/gate118000 are unchanged.

## Raw facts

```json
{
  "at": "2026-09-08T16:44:52.949871+00:00",
  "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
  "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "head": "ac40cf0a0502e7d4abe78a7d1dad6209c92d7024",
  "branch": "work/mcp-session-orchestration-20260709",
  "status": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/plan/2026-09-08.remaining-work-autonomous.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n M tools/wave3/fair-readmission-closure-v3.mjs\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/plan/2026-09-09.native-probe-program-cost.md\n?? docs/worklog/2026-09-09.jsonl\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt\n?? tools/wave3/native-probe-program.test.mjs",
  "canonical": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
  "canonicalHead": "150df8022f04ade35a46eb48238892fa3ce63d81",
  "canonicalStatus": "",
  "candidateFiles": [
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\tools\\wave3\\fair-readmission-closure-v3.mjs",
      "sha256": "820a077dce5d40391d42ab3e7b516bb8ffd26965186878b83f2d4dbe141f9ca6"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\tools\\wave3\\native-probe-program.test.mjs",
      "sha256": "04683b61bd5bb72edd20395479dc7e86eac32db6c0807bfef0c172a155f37540"
    }
  ],
  "canonicalOldCollector": {
    "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\tools\\wave3\\fair-readmission-closure-v3.mjs",
    "sha256": "dc78fb2d980f72e11322ebc8514286673f591b85ebe7544fdc0424c64c27816e"
  },
  "evidence": [
    {
      "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-native-program-baseline.log",
      "sha256": "79b2a047fff00f2bd32f5e576001701b4e3c3993853d20ec703d83ba0488324b"
    },
    {
      "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-native-candidate-independent.log",
      "sha256": "c1bc2024672ed4016ddf15dce8f590ae69652e84930255cf99ecf5913a5c029e"
    },
    {
      "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-paired-native-prep-6080f746a6eb43799c8b19791ef3b2da\\result.json",
      "sha256": "6a83e0cd22865b287090aaf173bb61eea8c039aeaf81889417329a8d6fb4864c"
    },
    {
      "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-native-probe-original-invocation.json",
      "sha256": "3677914bc0511d7e360571ca3ffde00284b4baac0062daf46ad58a17c068c50b"
    },
    {
      "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-fixture-canonical-manifest.json",
      "sha256": "ea4b3589aa66a47f6c727c8b6916804ee0eac9bbc670218071486a8966a214d0"
    }
  ],
  "userFiles": [
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\.codex\\config.toml",
      "sha256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\CLAUDE.local.md",
      "sha256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_1.txt",
      "sha256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_2.txt",
      "sha256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_1.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_2.txt",
      "sha256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_incomplete_True.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4"
    }
  ],
  "workflow": {
    "workspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "mode": "sdd",
    "target": "wave-5",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null
  },
  "diff": "diff --git a/tools/wave3/fair-readmission-closure-v3.mjs b/tools/wave3/fair-readmission-closure-v3.mjs\nindex a543245..00af333 100644\n--- a/tools/wave3/fair-readmission-closure-v3.mjs\n+++ b/tools/wave3/fair-readmission-closure-v3.mjs\n@@ -209,8 +209,8 @@ const REPARSE_BATCH_PROGRAM = [\n   `  $inputBase64 = $env:${REPARSE_BATCH_ENV_KEY}`,\n   '  if ([string]::IsNullOrWhiteSpace($inputBase64)) { exit 1 }',\n   '  $inputJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($inputBase64))',\n-  '  Add-Type -AssemblyName System.Web.Extensions',\n-  '  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer',\n+  \"  [void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')\",\n+  '  $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()',\n   '  $paths = $serializer.DeserializeObject($inputJson)',\n   '  if ($paths -isnot [System.Array]) { exit 1 }',\n   '  foreach ($candidate in $paths) {',\n@@ -219,7 +219,7 @@ const REPARSE_BATCH_PROGRAM = [\n   '    if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }',\n   '  }',\n   '  $hash = [System.Security.Cryptography.SHA256]::Create()',\n-  '  try { $digest = -join ($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($inputJson)) | ForEach-Object { $_.ToString(\"x2\") }) } finally { $hash.Dispose() }',\n+  '  try { $digest = [System.BitConverter]::ToString($hash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($inputJson))).Replace(\"-\", \"\").ToLowerInvariant() } finally { $hash.Dispose() }',\n   '  [Console]::Out.Write((\"FRRPB1:{0}:{1}`n\" -f $paths.Count, $digest))',\n   '} catch {',\n   '  exit 1',"
}
```

## Decisions

All three independent decisions were collected before circulation:

- Audit: CONSENT, Critical0/High0. Packet/candidate2/evidence5/user7/old-collector hashes and current MCP workspace match; fairness source6 unchanged.
- Preservation: CONSENT, Critical0/High0. Only the three-line candidate and its regression source may be committed. Canonical remains clean150df802; old evidence is preserved.
- SRS/integration: CONSENT, Critical0/High0. PERF011 evolving, existing performance RED and limited semantic/paired evidence support bounded source adoption without changing limits or claiming gate completion.

Resolution: adopt the candidate as a source-level optimization for the verified host. Follow with a separately checked canonical update, new collector-bound capture and physical regression. Prior manifests are not new-source evidence, and no SRS/AC/default/whole-goal completion is promoted.
