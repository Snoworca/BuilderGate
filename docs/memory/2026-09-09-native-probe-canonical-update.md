# Native probe canonical update raw provenance

Requirement: N/A operational audit; related PERF-BGSTAB-011.

Proposed action: non-force exact 6bd484b70fbb94ff9f0a2c0b1a2cc1051693add7 checkout in the clean dedicated canonical worktree, followed by fresh native controls and supported capture bound to the new collector. Physical parent execution requires independent verification of the new input set first. Preserve previous manifests and listed bytes. No original user7/config copying, adoption, force/reset/clean, SRS promotion or completion. No committee decisions are recorded here.

Target hashes are predicted committed checkout bytes, not execution evidence; re-read actual bytes after switching. Untracked canonical-owned configuration is preserved in place and never sourced from main. Collector fingerprint changes invalidate reuse of old manifests as new execution evidence.

## Raw facts

```json
{
  "at": "2026-09-08T16:57:49.169Z",
  "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
  "canonical": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
  "mainHead": "6bd484b70fbb94ff9f0a2c0b1a2cc1051693add7",
  "canonicalHead": "150df8022f04ade35a46eb48238892fa3ce63d81",
  "mainTree": "20aab8c9fa9a3c48bae3afea7e8c2f07319f1b12",
  "canonicalTree": "b4e22ee1ea3058214bf96239e4a1f186d4f4b6c2",
  "mainCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "canonicalCommonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "mainBranch": "work/mcp-session-orchestration-20260709",
  "canonicalBranch": "",
  "mainStatus": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? docs/worklog/2026-09-09.jsonl\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "canonicalStatus": "",
  "changes": [
    "M\tAGENTS.md",
    "A\tdocs/memory/2026-09-08-actor-canonical-update.md",
    "A\tdocs/memory/2026-09-09-native-probe-candidate-boundary.md",
    "M\tdocs/plan/2026-09-08.fixture-actor-cleanup.md",
    "M\tdocs/plan/2026-09-08.remaining-work-autonomous.plan.md",
    "A\tdocs/plan/2026-09-09.native-probe-program-cost.md",
    "A\tdocs/report/2026-09-09.capture-cost-profile.md",
    "A\tdocs/report/2026-09-09.physical-race-timing.md",
    "M\ttools/wave3/fair-readmission-closure-v3.mjs",
    "A\ttools/wave3/native-probe-program.test.mjs"
  ],
  "dependencyPaths": [
    "server/package.json",
    "server/package-lock.json",
    "frontend/package.json",
    "frontend/package-lock.json",
    "server/tools/ensure-node-pty-windows-hide.cjs",
    "frontend/tools/ensure-react-mosaic-patch.cjs",
    "frontend/patches"
  ],
  "dependencyChanges": [],
  "newPathCollisions": [],
  "preserved": [
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\.codex\\config.toml",
      "sha256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
      "priorSHA256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
      "currentSHA256": "9c4e94ebfb2c21dfdd42d182c6553c6091e056d34e0b67bfc455cf7724254c38",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\CLAUDE.local.md",
      "sha256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
      "priorSHA256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
      "currentSHA256": "fd40aee3b18144cf006e832e51caaa477ca6699382f621d86c7355c03e4e840f",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_1.txt",
      "sha256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
      "priorSHA256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
      "currentSHA256": "ef518fb6cb14622a076e822c7b7cbfc9aa4f03736985f9bcbfe3e4fc4e158553",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t1_verdict_2.txt",
      "sha256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
      "priorSHA256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
      "currentSHA256": "23ae8a2ea5f706ef5011254322a6faf0f7d54056b8687f68cfe4e9184efe7ff6",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_1.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "priorSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "currentSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_2.txt",
      "sha256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
      "priorSHA256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
      "currentSHA256": "a29ac5218346f15d3bae8c56bc780afc52222fce1c449ed84d13343d32b68807",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster\\t2_verdict_incomplete_True.txt",
      "sha256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "priorSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "currentSHA256": "6f4327b7b890491ec6c3269153f4dc1577997635d8a19dd614a7d1dca4f11ec4",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "priorSHA256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "currentSHA256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\agent-command-profiles.json",
      "sha256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde",
      "priorSHA256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde",
      "currentSHA256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\command-presets.json",
      "sha256": "eb3cfb090d56e3dce9e32e2f4a86ecb2901fbbfb3530e6b988ecb5ce7de25b89",
      "priorSHA256": "eb3cfb090d56e3dce9e32e2f4a86ecb2901fbbfb3530e6b988ecb5ce7de25b89",
      "currentSHA256": "eb3cfb090d56e3dce9e32e2f4a86ecb2901fbbfb3530e6b988ecb5ce7de25b89",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\command-presets.json.bak",
      "sha256": "e3a2cf5fca5a96541c1c1176c50ec00caa74dedace75a2dc860c6ad60663ada6",
      "priorSHA256": "e3a2cf5fca5a96541c1c1176c50ec00caa74dedace75a2dc860c6ad60663ada6",
      "currentSHA256": "e3a2cf5fca5a96541c1c1176c50ec00caa74dedace75a2dc860c6ad60663ada6",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\mcp-control-config.json",
      "sha256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0",
      "priorSHA256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0",
      "currentSHA256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\recovery-options.json",
      "sha256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f",
      "priorSHA256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f",
      "currentSHA256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\terminal-shortcuts.json",
      "sha256": "848810d0dd371e538f390e582cef320371e5fe8c370fb6b786f21c8a976f3171",
      "priorSHA256": "848810d0dd371e538f390e582cef320371e5fe8c370fb6b786f21c8a976f3171",
      "currentSHA256": "848810d0dd371e538f390e582cef320371e5fe8c370fb6b786f21c8a976f3171",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\terminal-shortcuts.json.bak",
      "sha256": "ca4c24880d09c5ddadb55664a522a0a17c3da487602b4755186d5cd42c3e99e5",
      "priorSHA256": "ca4c24880d09c5ddadb55664a522a0a17c3da487602b4755186d5cd42c3e99e5",
      "currentSHA256": "ca4c24880d09c5ddadb55664a522a0a17c3da487602b4755186d5cd42c3e99e5",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.crt",
      "sha256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9",
      "priorSHA256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9",
      "currentSHA256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9",
      "unchanged": true
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.key",
      "sha256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6",
      "priorSHA256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6",
      "currentSHA256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6",
      "unchanged": true
    }
  ],
  "inputs": [
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/FontSizeToast.tsx",
      "sha256": "8ac5849856d81a714e2d59f039c2e6b522bfebe5f3a463dcbe0ea6e5d943c9dc",
      "oldSHA256": "8ac5849856d81a714e2d59f039c2e6b522bfebe5f3a463dcbe0ea6e5d943c9dc",
      "currentSHA256": "8ac5849856d81a714e2d59f039c2e6b522bfebe5f3a463dcbe0ea6e5d943c9dc",
      "targetExpectedCheckoutSHA256": "8ac5849856d81a714e2d59f039c2e6b522bfebe5f3a463dcbe0ea6e5d943c9dc",
      "targetBlob": "de320f1c43dddd59d8af9c8d66e0ef0376d2c19e",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalContainer.tsx",
      "sha256": "875811cacadb59e3202a7721f08c7a9c3fc1f0bc7cab9b1d88afa7dfc7408da5",
      "oldSHA256": "875811cacadb59e3202a7721f08c7a9c3fc1f0bc7cab9b1d88afa7dfc7408da5",
      "currentSHA256": "875811cacadb59e3202a7721f08c7a9c3fc1f0bc7cab9b1d88afa7dfc7408da5",
      "targetExpectedCheckoutSHA256": "875811cacadb59e3202a7721f08c7a9c3fc1f0bc7cab9b1d88afa7dfc7408da5",
      "targetBlob": "ed0bbc40a98d8e99a7ff22157c3323868f7c1d32",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalRuntimeContext.tsx",
      "sha256": "4c368104cf11e8c44e1dc81cec4073f33db2c9496c53e3bd58c31639d01885df",
      "oldSHA256": "4c368104cf11e8c44e1dc81cec4073f33db2c9496c53e3bd58c31639d01885df",
      "currentSHA256": "4c368104cf11e8c44e1dc81cec4073f33db2c9496c53e3bd58c31639d01885df",
      "targetExpectedCheckoutSHA256": "4c368104cf11e8c44e1dc81cec4073f33db2c9496c53e3bd58c31639d01885df",
      "targetBlob": "e098d1446c96c2e20c4f89d10440b212cb3c2828",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalView.css",
      "sha256": "ac708b3bc8d5e2b0a1e81c3fd4a6e90ef9f926d5037268c87b90ca2906c5acb4",
      "oldSHA256": "ac708b3bc8d5e2b0a1e81c3fd4a6e90ef9f926d5037268c87b90ca2906c5acb4",
      "currentSHA256": "ac708b3bc8d5e2b0a1e81c3fd4a6e90ef9f926d5037268c87b90ca2906c5acb4",
      "targetExpectedCheckoutSHA256": "ac708b3bc8d5e2b0a1e81c3fd4a6e90ef9f926d5037268c87b90ca2906c5acb4",
      "targetBlob": "f796dd8d6f1b8d84d65258156166a69348e5339b",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalView.tsx",
      "sha256": "a91221bc76981d0dc62c1b0b23d4342584757887af0f73d1c5fcdfba3f28ace1",
      "oldSHA256": "a91221bc76981d0dc62c1b0b23d4342584757887af0f73d1c5fcdfba3f28ace1",
      "currentSHA256": "a91221bc76981d0dc62c1b0b23d4342584757887af0f73d1c5fcdfba3f28ace1",
      "targetExpectedCheckoutSHA256": "a91221bc76981d0dc62c1b0b23d4342584757887af0f73d1c5fcdfba3f28ace1",
      "targetBlob": "b3fe9a8f7ca79bda07c4ae474c567f739eaad2b8",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/contexts/WebSocketContext.tsx",
      "sha256": "b8dc4b36dd20c2b89ed0bb740a4148731a255e596b3280099f879bbd003b2621",
      "oldSHA256": "b8dc4b36dd20c2b89ed0bb740a4148731a255e596b3280099f879bbd003b2621",
      "currentSHA256": "b8dc4b36dd20c2b89ed0bb740a4148731a255e596b3280099f879bbd003b2621",
      "targetExpectedCheckoutSHA256": "b8dc4b36dd20c2b89ed0bb740a4148731a255e596b3280099f879bbd003b2621",
      "targetBlob": "20f94a49db931f3564cf75b40f2580ad2e03caab",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/hooks/usePinchZoom.ts",
      "sha256": "3c421a165b8fbcf45b81b29536c38018feaa661e38afcf5765711ce0d2f37757",
      "oldSHA256": "3c421a165b8fbcf45b81b29536c38018feaa661e38afcf5765711ce0d2f37757",
      "currentSHA256": "3c421a165b8fbcf45b81b29536c38018feaa661e38afcf5765711ce0d2f37757",
      "targetExpectedCheckoutSHA256": "3c421a165b8fbcf45b81b29536c38018feaa661e38afcf5765711ce0d2f37757",
      "targetBlob": "542e16419aca2a681f015534c62443b644a5dcec",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/hooks/useResponsive.ts",
      "sha256": "cc9f04aba12f03eaf46acd63dacd7e6adb87e041e8441f820a91650c059299ba",
      "oldSHA256": "cc9f04aba12f03eaf46acd63dacd7e6adb87e041e8441f820a91650c059299ba",
      "currentSHA256": "cc9f04aba12f03eaf46acd63dacd7e6adb87e041e8441f820a91650c059299ba",
      "targetExpectedCheckoutSHA256": "cc9f04aba12f03eaf46acd63dacd7e6adb87e041e8441f820a91650c059299ba",
      "targetBlob": "6b2a349b7e3d103199ee88b0779aa194e88751a2",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/services/api.ts",
      "sha256": "c2e4a70705d3cbc39561cfba3bcf4ad4c72b84b35052a2528b3047183771354c",
      "oldSHA256": "c2e4a70705d3cbc39561cfba3bcf4ad4c72b84b35052a2528b3047183771354c",
      "currentSHA256": "c2e4a70705d3cbc39561cfba3bcf4ad4c72b84b35052a2528b3047183771354c",
      "targetExpectedCheckoutSHA256": "c2e4a70705d3cbc39561cfba3bcf4ad4c72b84b35052a2528b3047183771354c",
      "targetBlob": "395a0c36fe8d6872668b450925865e721d7cc905",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/services/apiError.ts",
      "sha256": "89478e5eb18637b29667808d827d89c066992bf035ef7109b0e2c1e75f1590ee",
      "oldSHA256": "89478e5eb18637b29667808d827d89c066992bf035ef7109b0e2c1e75f1590ee",
      "currentSHA256": "89478e5eb18637b29667808d827d89c066992bf035ef7109b0e2c1e75f1590ee",
      "targetExpectedCheckoutSHA256": "89478e5eb18637b29667808d827d89c066992bf035ef7109b0e2c1e75f1590ee",
      "targetBlob": "6ca11fbdd7b41828925918a776d87cc5dc6d674b",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/services/tokenStorage.ts",
      "sha256": "cded9fb62ddfb171b3ebfce45a1bb9c32ae6967b4df46e62a8c62c36e1be748f",
      "oldSHA256": "cded9fb62ddfb171b3ebfce45a1bb9c32ae6967b4df46e62a8c62c36e1be748f",
      "currentSHA256": "cded9fb62ddfb171b3ebfce45a1bb9c32ae6967b4df46e62a8c62c36e1be748f",
      "targetExpectedCheckoutSHA256": "cded9fb62ddfb171b3ebfce45a1bb9c32ae6967b4df46e62a8c62c36e1be748f",
      "targetBlob": "424f3f68334829cc7cd774261e9867134bf1c679",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/commandPreset.ts",
      "sha256": "dff8112b28de9f64131c7896fffb01fd640b9ef880a6bf78c4c43856c6d3285e",
      "oldSHA256": "dff8112b28de9f64131c7896fffb01fd640b9ef880a6bf78c4c43856c6d3285e",
      "currentSHA256": "dff8112b28de9f64131c7896fffb01fd640b9ef880a6bf78c4c43856c6d3285e",
      "targetExpectedCheckoutSHA256": "dff8112b28de9f64131c7896fffb01fd640b9ef880a6bf78c4c43856c6d3285e",
      "targetBlob": "fc5d92c6400bc9decc92c7dc56385232260ea4c1",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/index.ts",
      "sha256": "a97c75ae467bd3eca5a549e0d75f6cb48b0f20a30b239628a46d0fbcd5a2fab2",
      "oldSHA256": "a97c75ae467bd3eca5a549e0d75f6cb48b0f20a30b239628a46d0fbcd5a2fab2",
      "currentSHA256": "a97c75ae467bd3eca5a549e0d75f6cb48b0f20a30b239628a46d0fbcd5a2fab2",
      "targetExpectedCheckoutSHA256": "a97c75ae467bd3eca5a549e0d75f6cb48b0f20a30b239628a46d0fbcd5a2fab2",
      "targetBlob": "33abc782b217494faeb978179002744322befec5",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/mcpControl.ts",
      "sha256": "18e3c7702317b6fcd844fad47886590b0d76cc22a8b927ac2d1307497abb0392",
      "oldSHA256": "18e3c7702317b6fcd844fad47886590b0d76cc22a8b927ac2d1307497abb0392",
      "currentSHA256": "18e3c7702317b6fcd844fad47886590b0d76cc22a8b927ac2d1307497abb0392",
      "targetExpectedCheckoutSHA256": "18e3c7702317b6fcd844fad47886590b0d76cc22a8b927ac2d1307497abb0392",
      "targetBlob": "00a4c5c1025740a066f728388b4216b10cf96025",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/recoveryOption.ts",
      "sha256": "aa3913fdd3a5e0c0f509193d54e2222e644014081956f363dfcddf2aecd188da",
      "oldSHA256": "aa3913fdd3a5e0c0f509193d54e2222e644014081956f363dfcddf2aecd188da",
      "currentSHA256": "aa3913fdd3a5e0c0f509193d54e2222e644014081956f363dfcddf2aecd188da",
      "targetExpectedCheckoutSHA256": "aa3913fdd3a5e0c0f509193d54e2222e644014081956f363dfcddf2aecd188da",
      "targetBlob": "cc05e7c0f99563411bdf799dd6bde9f0b92cd123",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/settings.ts",
      "sha256": "018d741374af3356cb6ae83faf551b8df92a2635ed77e68700727f4504dc3303",
      "oldSHA256": "018d741374af3356cb6ae83faf551b8df92a2635ed77e68700727f4504dc3303",
      "currentSHA256": "018d741374af3356cb6ae83faf551b8df92a2635ed77e68700727f4504dc3303",
      "targetExpectedCheckoutSHA256": "018d741374af3356cb6ae83faf551b8df92a2635ed77e68700727f4504dc3303",
      "targetBlob": "127ed081981bc6aaaa5bd60e3550ec4d4512ac67",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/terminalShortcut.ts",
      "sha256": "036e30c301b9df172fddb50caf204691e1ce0aa24521f2f019e3307bf7b06125",
      "oldSHA256": "036e30c301b9df172fddb50caf204691e1ce0aa24521f2f019e3307bf7b06125",
      "currentSHA256": "036e30c301b9df172fddb50caf204691e1ce0aa24521f2f019e3307bf7b06125",
      "targetExpectedCheckoutSHA256": "036e30c301b9df172fddb50caf204691e1ce0aa24521f2f019e3307bf7b06125",
      "targetBlob": "73f82582759296c9d33049f45bac1d71eff019ba",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/workspace.ts",
      "sha256": "0f5e25616afa067959e95ccc2f90a73066d4033e51b004b70325050e8c0a2005",
      "oldSHA256": "0f5e25616afa067959e95ccc2f90a73066d4033e51b004b70325050e8c0a2005",
      "currentSHA256": "0f5e25616afa067959e95ccc2f90a73066d4033e51b004b70325050e8c0a2005",
      "targetExpectedCheckoutSHA256": "0f5e25616afa067959e95ccc2f90a73066d4033e51b004b70325050e8c0a2005",
      "targetBlob": "d65b55f9bbcd6ddc64f62b05fb3931635c73a269",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/types/ws-protocol.ts",
      "sha256": "0ab0d3a165fc9b9b37b0f9be5943ede38117424c204300ff7caf1a9879fd213b",
      "oldSHA256": "0ab0d3a165fc9b9b37b0f9be5943ede38117424c204300ff7caf1a9879fd213b",
      "currentSHA256": "0ab0d3a165fc9b9b37b0f9be5943ede38117424c204300ff7caf1a9879fd213b",
      "targetExpectedCheckoutSHA256": "0ab0d3a165fc9b9b37b0f9be5943ede38117424c204300ff7caf1a9879fd213b",
      "targetBlob": "0dc35c00bc5e620dd3e9f131e7924abcac42c40a",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/binaryFrameCodec.ts",
      "sha256": "78a01ec6fdf29434f2f9448c6437cce40c21c202842b06dac4dac35c6a22a15f",
      "oldSHA256": "78a01ec6fdf29434f2f9448c6437cce40c21c202842b06dac4dac35c6a22a15f",
      "currentSHA256": "78a01ec6fdf29434f2f9448c6437cce40c21c202842b06dac4dac35c6a22a15f",
      "targetExpectedCheckoutSHA256": "78a01ec6fdf29434f2f9448c6437cce40c21c202842b06dac4dac35c6a22a15f",
      "targetBlob": "4a35d835b5db8a389266b444d9ec6b5aa52acbbb",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/binaryFrameIntake.ts",
      "sha256": "9262d51028b5c4bea7970f81339e7a2b55eb5899e7ffd9fc4beab8f43ca52e3b",
      "oldSHA256": "9262d51028b5c4bea7970f81339e7a2b55eb5899e7ffd9fc4beab8f43ca52e3b",
      "currentSHA256": "9262d51028b5c4bea7970f81339e7a2b55eb5899e7ffd9fc4beab8f43ca52e3b",
      "targetExpectedCheckoutSHA256": "9262d51028b5c4bea7970f81339e7a2b55eb5899e7ffd9fc4beab8f43ca52e3b",
      "targetBlob": "e73d6538d3fa425fe016e160233039002b57e287",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/imeTransaction.ts",
      "sha256": "1dcb72e9024be10f6c57ef0fa6932837eac6319f72d52ae86bb678971a7c8611",
      "oldSHA256": "1dcb72e9024be10f6c57ef0fa6932837eac6319f72d52ae86bb678971a7c8611",
      "currentSHA256": "1dcb72e9024be10f6c57ef0fa6932837eac6319f72d52ae86bb678971a7c8611",
      "targetExpectedCheckoutSHA256": "1dcb72e9024be10f6c57ef0fa6932837eac6319f72d52ae86bb678971a7c8611",
      "targetBlob": "b2d63cc5df9e27cffc0d50900eb8c9f4c7c69a0f",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/inputReliabilityMode.ts",
      "sha256": "587f007c8cece2be44446eb02513b14c16b4cd4614632927d22abf8e27f142ad",
      "oldSHA256": "587f007c8cece2be44446eb02513b14c16b4cd4614632927d22abf8e27f142ad",
      "currentSHA256": "587f007c8cece2be44446eb02513b14c16b4cd4614632927d22abf8e27f142ad",
      "targetExpectedCheckoutSHA256": "587f007c8cece2be44446eb02513b14c16b4cd4614632927d22abf8e27f142ad",
      "targetBlob": "439cd1b6d71f4267a193ad6aaff07f7ce7bfd250",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/liveOutputTokens.ts",
      "sha256": "50097ec94d1f051337f058d2d9f79d78ae5ea973fc692cc4726452e193774245",
      "oldSHA256": "50097ec94d1f051337f058d2d9f79d78ae5ea973fc692cc4726452e193774245",
      "currentSHA256": "50097ec94d1f051337f058d2d9f79d78ae5ea973fc692cc4726452e193774245",
      "targetExpectedCheckoutSHA256": "50097ec94d1f051337f058d2d9f79d78ae5ea973fc692cc4726452e193774245",
      "targetBlob": "c89ac4c1802568d7675318615aed7d9ca987f401",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/sessionCloseClassification.ts",
      "sha256": "35ba20128eed597ae613e0f87c5876052bd2477eac8a0a92a60b4e2e879399ed",
      "oldSHA256": "35ba20128eed597ae613e0f87c5876052bd2477eac8a0a92a60b4e2e879399ed",
      "currentSHA256": "35ba20128eed597ae613e0f87c5876052bd2477eac8a0a92a60b4e2e879399ed",
      "targetExpectedCheckoutSHA256": "35ba20128eed597ae613e0f87c5876052bd2477eac8a0a92a60b4e2e879399ed",
      "targetBlob": "24e183c381b8fbb31a924e3387425dfd55e2565c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalBinaryNegotiationClient.ts",
      "sha256": "37ad4a2e1a92eba0941291af6c5c2872c12c4a86f9b60e17718a0f5702e13c79",
      "oldSHA256": "37ad4a2e1a92eba0941291af6c5c2872c12c4a86f9b60e17718a0f5702e13c79",
      "currentSHA256": "37ad4a2e1a92eba0941291af6c5c2872c12c4a86f9b60e17718a0f5702e13c79",
      "targetExpectedCheckoutSHA256": "37ad4a2e1a92eba0941291af6c5c2872c12c4a86f9b60e17718a0f5702e13c79",
      "targetBlob": "849cd95089a267201aea9ff00308b2420c59a6bc",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalChannelRegistry.ts",
      "sha256": "9cf6fe4be26512b2104ae4647bcdb407cef3e4dd67a9e06ffafb03684025fc9b",
      "oldSHA256": "9cf6fe4be26512b2104ae4647bcdb407cef3e4dd67a9e06ffafb03684025fc9b",
      "currentSHA256": "9cf6fe4be26512b2104ae4647bcdb407cef3e4dd67a9e06ffafb03684025fc9b",
      "targetExpectedCheckoutSHA256": "9cf6fe4be26512b2104ae4647bcdb407cef3e4dd67a9e06ffafb03684025fc9b",
      "targetBlob": "ffc3098ee2386466553b1fcc6a6a918d6cb8ae5f",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalCheckpointRuntime.ts",
      "sha256": "23c6fe4a10d17071ed19085935c51450ec8b3aea3578fb28c2d10ecc8ebe9227",
      "oldSHA256": "23c6fe4a10d17071ed19085935c51450ec8b3aea3578fb28c2d10ecc8ebe9227",
      "currentSHA256": "23c6fe4a10d17071ed19085935c51450ec8b3aea3578fb28c2d10ecc8ebe9227",
      "targetExpectedCheckoutSHA256": "23c6fe4a10d17071ed19085935c51450ec8b3aea3578fb28c2d10ecc8ebe9227",
      "targetBlob": "1911138023901082a1e54fc078271681696eec6b",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalClipboardCoordinator.ts",
      "sha256": "1b191401c1bce6e46decf4aaea2eef432f156d723f43152dccdc98242c8fdf0a",
      "oldSHA256": "1b191401c1bce6e46decf4aaea2eef432f156d723f43152dccdc98242c8fdf0a",
      "currentSHA256": "1b191401c1bce6e46decf4aaea2eef432f156d723f43152dccdc98242c8fdf0a",
      "targetExpectedCheckoutSHA256": "1b191401c1bce6e46decf4aaea2eef432f156d723f43152dccdc98242c8fdf0a",
      "targetBlob": "3154f6793a1222d7b06f93624ce326dcc4c70a20",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalDebugCapture.ts",
      "sha256": "499a21cb250e74562c0e4e318729f5dc371005414ecd80d405c20848cf138ae7",
      "oldSHA256": "499a21cb250e74562c0e4e318729f5dc371005414ecd80d405c20848cf138ae7",
      "currentSHA256": "499a21cb250e74562c0e4e318729f5dc371005414ecd80d405c20848cf138ae7",
      "targetExpectedCheckoutSHA256": "499a21cb250e74562c0e4e318729f5dc371005414ecd80d405c20848cf138ae7",
      "targetBlob": "05b9d5db5421fed22b213f210cdb949912e185f3",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalHiddenOutput.ts",
      "sha256": "494402a0efced1a5bda48cd6ab36126c58be0e62f32798a1cdd88c5cc3d275ec",
      "oldSHA256": "494402a0efced1a5bda48cd6ab36126c58be0e62f32798a1cdd88c5cc3d275ec",
      "currentSHA256": "494402a0efced1a5bda48cd6ab36126c58be0e62f32798a1cdd88c5cc3d275ec",
      "targetExpectedCheckoutSHA256": "494402a0efced1a5bda48cd6ab36126c58be0e62f32798a1cdd88c5cc3d275ec",
      "targetBlob": "d9ecec671685b5a648c61c9dac2f11770b35a4f0",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalInputSequencer.ts",
      "sha256": "3231be45ab59366ab471565cf6851748741c701f1ee6dff1344974ab766f3589",
      "oldSHA256": "3231be45ab59366ab471565cf6851748741c701f1ee6dff1344974ab766f3589",
      "currentSHA256": "3231be45ab59366ab471565cf6851748741c701f1ee6dff1344974ab766f3589",
      "targetExpectedCheckoutSHA256": "3231be45ab59366ab471565cf6851748741c701f1ee6dff1344974ab766f3589",
      "targetBlob": "e227f3d63bbcd75bbda21f2a52f7300182b38e61",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalOutputDelivery.ts",
      "sha256": "ed4646386e57f4ffe5b5bb706e5ecdfd33ab8a9933c687d4a26af0828ebf72a8",
      "oldSHA256": "ed4646386e57f4ffe5b5bb706e5ecdfd33ab8a9933c687d4a26af0828ebf72a8",
      "currentSHA256": "ed4646386e57f4ffe5b5bb706e5ecdfd33ab8a9933c687d4a26af0828ebf72a8",
      "targetExpectedCheckoutSHA256": "ed4646386e57f4ffe5b5bb706e5ecdfd33ab8a9933c687d4a26af0828ebf72a8",
      "targetBlob": "87d77e9d25a4525a285f81960db28e0d98cc0222",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalOutputHotPath.ts",
      "sha256": "76738388df0731eeff1dda394bef945d93fe4e0ac5b4a4c467dccaf45561b46a",
      "oldSHA256": "76738388df0731eeff1dda394bef945d93fe4e0ac5b4a4c467dccaf45561b46a",
      "currentSHA256": "76738388df0731eeff1dda394bef945d93fe4e0ac5b4a4c467dccaf45561b46a",
      "targetExpectedCheckoutSHA256": "76738388df0731eeff1dda394bef945d93fe4e0ac5b4a4c467dccaf45561b46a",
      "targetBlob": "d9e96b0c17b3635bcc62ec082badfb3d33546494",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalOutputScheduler.ts",
      "sha256": "13db348f2c98618f7b8246754c8fa6ac4def493e2a7d43c461fcea58b614df40",
      "oldSHA256": "13db348f2c98618f7b8246754c8fa6ac4def493e2a7d43c461fcea58b614df40",
      "currentSHA256": "13db348f2c98618f7b8246754c8fa6ac4def493e2a7d43c461fcea58b614df40",
      "targetExpectedCheckoutSHA256": "13db348f2c98618f7b8246754c8fa6ac4def493e2a7d43c461fcea58b614df40",
      "targetBlob": "de4cd970c72c63c6c2dc308549f379c852f2ea70",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalQueryReply.ts",
      "sha256": "77375496b5ec7f0998c8fb1663fdd44e3a0720f1b3db0b1125fae92014e9b2e6",
      "oldSHA256": "77375496b5ec7f0998c8fb1663fdd44e3a0720f1b3db0b1125fae92014e9b2e6",
      "currentSHA256": "77375496b5ec7f0998c8fb1663fdd44e3a0720f1b3db0b1125fae92014e9b2e6",
      "targetExpectedCheckoutSHA256": "77375496b5ec7f0998c8fb1663fdd44e3a0720f1b3db0b1125fae92014e9b2e6",
      "targetBlob": "4f06ee8c0cd0e6dba69623773bc0f1995cfbe29e",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalRawMutationAdapter.ts",
      "sha256": "ebace0848b1962f9e20abd6d1611a1766ded098ac0c311ea2bae38074476d4b2",
      "oldSHA256": "ebace0848b1962f9e20abd6d1611a1766ded098ac0c311ea2bae38074476d4b2",
      "currentSHA256": "ebace0848b1962f9e20abd6d1611a1766ded098ac0c311ea2bae38074476d4b2",
      "targetExpectedCheckoutSHA256": "ebace0848b1962f9e20abd6d1611a1766ded098ac0c311ea2bae38074476d4b2",
      "targetBlob": "1d6f0ebb12ab543f6e4ccb44e6631a64a19826a6",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalReplayGuard.ts",
      "sha256": "4b20b0d2106e18017e81350edc58dc64588b249a90e5ca48538270011e0493e2",
      "oldSHA256": "4b20b0d2106e18017e81350edc58dc64588b249a90e5ca48538270011e0493e2",
      "currentSHA256": "4b20b0d2106e18017e81350edc58dc64588b249a90e5ca48538270011e0493e2",
      "targetExpectedCheckoutSHA256": "4b20b0d2106e18017e81350edc58dc64588b249a90e5ca48538270011e0493e2",
      "targetBlob": "97c3b23f9bad98dd31c0acea2704a59ab5a88a94",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalRetainedState.ts",
      "sha256": "1f2d3739fe18d20dc53cc231eabad9d021651d40aeb34a72b1083404ce4bebfc",
      "oldSHA256": "1f2d3739fe18d20dc53cc231eabad9d021651d40aeb34a72b1083404ce4bebfc",
      "currentSHA256": "1f2d3739fe18d20dc53cc231eabad9d021651d40aeb34a72b1083404ce4bebfc",
      "targetExpectedCheckoutSHA256": "1f2d3739fe18d20dc53cc231eabad9d021651d40aeb34a72b1083404ce4bebfc",
      "targetBlob": "1abf553057fe99fe73ec53d733114394d9eb24fc",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalShortcutBindings.ts",
      "sha256": "b5ea932ebf9de6a1c7f9030e7621f5e4378f4e15c06d57b6c223e46336e48a32",
      "oldSHA256": "b5ea932ebf9de6a1c7f9030e7621f5e4378f4e15c06d57b6c223e46336e48a32",
      "currentSHA256": "b5ea932ebf9de6a1c7f9030e7621f5e4378f4e15c06d57b6c223e46336e48a32",
      "targetExpectedCheckoutSHA256": "b5ea932ebf9de6a1c7f9030e7621f5e4378f4e15c06d57b6c223e46336e48a32",
      "targetBlob": "58df5a958f0587895b0ac6503db1657b0630a7bd",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalSnapshot.ts",
      "sha256": "e28e0f6634dac5db52ce492099dac03ae5f482833f6d01667ffe3c40d44a1ffc",
      "oldSHA256": "e28e0f6634dac5db52ce492099dac03ae5f482833f6d01667ffe3c40d44a1ffc",
      "currentSHA256": "e28e0f6634dac5db52ce492099dac03ae5f482833f6d01667ffe3c40d44a1ffc",
      "targetExpectedCheckoutSHA256": "e28e0f6634dac5db52ce492099dac03ae5f482833f6d01667ffe3c40d44a1ffc",
      "targetBlob": "1ccd05af8647e207ffad81044f250f41ec83e25d",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalStaleKeyRepeat.ts",
      "sha256": "480a0337113367f22e44abf295c35956cdd367e18defc4ee2fc052a1a5640ddd",
      "oldSHA256": "480a0337113367f22e44abf295c35956cdd367e18defc4ee2fc052a1a5640ddd",
      "currentSHA256": "480a0337113367f22e44abf295c35956cdd367e18defc4ee2fc052a1a5640ddd",
      "targetExpectedCheckoutSHA256": "480a0337113367f22e44abf295c35956cdd367e18defc4ee2fc052a1a5640ddd",
      "targetBlob": "561d959302e4a89f0cc5ff539e10a08fc290d377",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalTransportQueueDecision.ts",
      "sha256": "9ebb15d0b9ba76487e041888bd5d51c71ad5377c75670e10d9aa9f7949dfb859",
      "oldSHA256": "9ebb15d0b9ba76487e041888bd5d51c71ad5377c75670e10d9aa9f7949dfb859",
      "currentSHA256": "9ebb15d0b9ba76487e041888bd5d51c71ad5377c75670e10d9aa9f7949dfb859",
      "targetExpectedCheckoutSHA256": "9ebb15d0b9ba76487e041888bd5d51c71ad5377c75670e10d9aa9f7949dfb859",
      "targetBlob": "7a9d1a113c4e28aa9fb7ab2b9c127d22e6f76257",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalViewAttributes.ts",
      "sha256": "d4511b4b187097a5aaf383298ba7948ac39c5df26955611123aa9072e0b84147",
      "oldSHA256": "d4511b4b187097a5aaf383298ba7948ac39c5df26955611123aa9072e0b84147",
      "currentSHA256": "d4511b4b187097a5aaf383298ba7948ac39c5df26955611123aa9072e0b84147",
      "targetExpectedCheckoutSHA256": "d4511b4b187097a5aaf383298ba7948ac39c5df26955611123aa9072e0b84147",
      "targetBlob": "cc68b39932ce2ddeb1c73208b755a5ac9434ad37",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalWriteCoordinator.ts",
      "sha256": "b0d334d9d2dbb406d169fb83c93d18c3cd6f5fbe295ee968768036f40bbe4a1f",
      "oldSHA256": "b0d334d9d2dbb406d169fb83c93d18c3cd6f5fbe295ee968768036f40bbe4a1f",
      "currentSHA256": "b0d334d9d2dbb406d169fb83c93d18c3cd6f5fbe295ee968768036f40bbe4a1f",
      "targetExpectedCheckoutSHA256": "b0d334d9d2dbb406d169fb83c93d18c3cd6f5fbe295ee968768036f40bbe4a1f",
      "targetBlob": "da286bc8c02d2622990ab88d616f32c81ed8b709",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalWriteCoordinatorRuntime.ts",
      "sha256": "f4ea3f2dc67f02a0a47d4bc43b8552843d81f4cf8910c702990309c59e2f9952",
      "oldSHA256": "f4ea3f2dc67f02a0a47d4bc43b8552843d81f4cf8910c702990309c59e2f9952",
      "currentSHA256": "f4ea3f2dc67f02a0a47d4bc43b8552843d81f4cf8910c702990309c59e2f9952",
      "targetExpectedCheckoutSHA256": "f4ea3f2dc67f02a0a47d4bc43b8552843d81f4cf8910c702990309c59e2f9952",
      "targetBlob": "5f4b3deeab5b6100e289563407139458d8296c8d",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/visibleOutputRecovery.ts",
      "sha256": "b19b3c2215089785260e1cc8a835bc66101161fd2fd999ca3db308ed282b2ffd",
      "oldSHA256": "b19b3c2215089785260e1cc8a835bc66101161fd2fd999ca3db308ed282b2ffd",
      "currentSHA256": "b19b3c2215089785260e1cc8a835bc66101161fd2fd999ca3db308ed282b2ffd",
      "targetExpectedCheckoutSHA256": "b19b3c2215089785260e1cc8a835bc66101161fd2fd999ca3db308ed282b2ffd",
      "targetBlob": "6f6aba76df689a7e40f916dcfc46ecd5b6cb408f",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/webSocketBackpressure.ts",
      "sha256": "5551d8def447eb8e3573685d6fe055739c80c7efc1509d0b50531bbdff4e8ba8",
      "oldSHA256": "5551d8def447eb8e3573685d6fe055739c80c7efc1509d0b50531bbdff4e8ba8",
      "currentSHA256": "5551d8def447eb8e3573685d6fe055739c80c7efc1509d0b50531bbdff4e8ba8",
      "targetExpectedCheckoutSHA256": "5551d8def447eb8e3573685d6fe055739c80c7efc1509d0b50531bbdff4e8ba8",
      "targetBlob": "d48bae299ef923dec63646726a3eb7147bb94c85",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/webSocketUrl.ts",
      "sha256": "9fb24fd4d92453d0a6ac90ed29c8410a11be6c107c75ffe9dcb96e0a2c1dfa37",
      "oldSHA256": "9fb24fd4d92453d0a6ac90ed29c8410a11be6c107c75ffe9dcb96e0a2c1dfa37",
      "currentSHA256": "9fb24fd4d92453d0a6ac90ed29c8410a11be6c107c75ffe9dcb96e0a2c1dfa37",
      "targetExpectedCheckoutSHA256": "9fb24fd4d92453d0a6ac90ed29c8410a11be6c107c75ffe9dcb96e0a2c1dfa37",
      "targetBlob": "fcab1ac56b562cb85a56234631b22f34269f9d15",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/wsFrameDispatch.ts",
      "sha256": "a89197b391df0e7ade3e51497628d9c17cf6659acc8d6f6d6d222d1acf41089f",
      "oldSHA256": "a89197b391df0e7ade3e51497628d9c17cf6659acc8d6f6d6d222d1acf41089f",
      "currentSHA256": "a89197b391df0e7ade3e51497628d9c17cf6659acc8d6f6d6d222d1acf41089f",
      "targetExpectedCheckoutSHA256": "a89197b391df0e7ade3e51497628d9c17cf6659acc8d6f6d6d222d1acf41089f",
      "targetBlob": "57d3ee8bfb7a9eac0691df9571c4894e50131672",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/tests/e2e/helpers.ts",
      "sha256": "4060d593d4d3738873c8f5cd74da32ffc887056491ea78d796542db28257325f",
      "oldSHA256": "4060d593d4d3738873c8f5cd74da32ffc887056491ea78d796542db28257325f",
      "currentSHA256": "4060d593d4d3738873c8f5cd74da32ffc887056491ea78d796542db28257325f",
      "targetExpectedCheckoutSHA256": "4060d593d4d3738873c8f5cd74da32ffc887056491ea78d796542db28257325f",
      "targetBlob": "de5ed2d7edd3ea58e60826193d004e3c07a643dd",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts",
      "sha256": "ddf64f62eaf29cf2c8fb65c79664242f067e981a419dd0aeeac1f825b5108d27",
      "oldSHA256": "ddf64f62eaf29cf2c8fb65c79664242f067e981a419dd0aeeac1f825b5108d27",
      "currentSHA256": "ddf64f62eaf29cf2c8fb65c79664242f067e981a419dd0aeeac1f825b5108d27",
      "targetExpectedCheckoutSHA256": "ddf64f62eaf29cf2c8fb65c79664242f067e981a419dd0aeeac1f825b5108d27",
      "targetBlob": "4b37537888d5b0e6481678a23f056d3c3d7e4bfd",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/tests/helpers/visibleOutputRecoveryContract.ts",
      "sha256": "93269dfcdb91de7f8530a7751c2cd67c9445324341dc7e17e17b3eea52159b60",
      "oldSHA256": "93269dfcdb91de7f8530a7751c2cd67c9445324341dc7e17e17b3eea52159b60",
      "currentSHA256": "93269dfcdb91de7f8530a7751c2cd67c9445324341dc7e17e17b3eea52159b60",
      "targetExpectedCheckoutSHA256": "93269dfcdb91de7f8530a7751c2cd67c9445324341dc7e17e17b3eea52159b60",
      "targetBlob": "f0c66e6f1e6bf8e2f0315369fd1fbc2215205dd4",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/perfBgstab010Ac9IsolatedE2EContract.test.ts",
      "sha256": "35510371e3a2e98f268c1c20585081d1835e19d15343f252e9196849bfc87e06",
      "oldSHA256": "35510371e3a2e98f268c1c20585081d1835e19d15343f252e9196849bfc87e06",
      "currentSHA256": "35510371e3a2e98f268c1c20585081d1835e19d15343f252e9196849bfc87e06",
      "targetExpectedCheckoutSHA256": "35510371e3a2e98f268c1c20585081d1835e19d15343f252e9196849bfc87e06",
      "targetBlob": "c11e9fe65e6bd1cd759b137296efff44bddc3fab",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/terminalContainerRecoveryContract.test.ts",
      "sha256": "1fdf39884da7a5fe29a0aa994a6c67ebddfd790d73a7514ef954073293757196",
      "oldSHA256": "1fdf39884da7a5fe29a0aa994a6c67ebddfd790d73a7514ef954073293757196",
      "currentSHA256": "1fdf39884da7a5fe29a0aa994a6c67ebddfd790d73a7514ef954073293757196",
      "targetExpectedCheckoutSHA256": "1fdf39884da7a5fe29a0aa994a6c67ebddfd790d73a7514ef954073293757196",
      "targetBlob": "06270381b194b9e2eab66bc17df81a046896cd4f",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/terminalDebugCapture.test.ts",
      "sha256": "6d4a6d7115801537be7d97c301ccbc813541b8e6959f2562f3333515de024113",
      "oldSHA256": "6d4a6d7115801537be7d97c301ccbc813541b8e6959f2562f3333515de024113",
      "currentSHA256": "6d4a6d7115801537be7d97c301ccbc813541b8e6959f2562f3333515de024113",
      "targetExpectedCheckoutSHA256": "6d4a6d7115801537be7d97c301ccbc813541b8e6959f2562f3333515de024113",
      "targetBlob": "372947e1212b513c74f9f039e7e194acb2e1bc66",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/webSocketBackpressure.test.ts",
      "sha256": "9d1ba339d79914a8b69f70a70ea1405bc8791cc68b7f9fede58746631594b321",
      "oldSHA256": "9d1ba339d79914a8b69f70a70ea1405bc8791cc68b7f9fede58746631594b321",
      "currentSHA256": "9d1ba339d79914a8b69f70a70ea1405bc8791cc68b7f9fede58746631594b321",
      "targetExpectedCheckoutSHA256": "9d1ba339d79914a8b69f70a70ea1405bc8791cc68b7f9fede58746631594b321",
      "targetBlob": "8a07c8192b4807a0e41cc7fab52a6233fb560c66",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/benchmarks/fairSchedulerAuthorityLocator.ts",
      "sha256": "f8672347e293926b3291ef35238cc5b2da29ec76f30475e8110ed97ad30071ad",
      "oldSHA256": "f8672347e293926b3291ef35238cc5b2da29ec76f30475e8110ed97ad30071ad",
      "currentSHA256": "f8672347e293926b3291ef35238cc5b2da29ec76f30475e8110ed97ad30071ad",
      "targetExpectedCheckoutSHA256": "f8672347e293926b3291ef35238cc5b2da29ec76f30475e8110ed97ad30071ad",
      "targetBlob": "fefddd91ba2e4e4499f297aa6ba519b9e60ba608",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/benchmarks/terminalFairnessCharacterization.ts",
      "sha256": "99dc6d06a1d498db5b31bfc7ab013916f05f9cc541da7eaf5642ae34d4bda341",
      "oldSHA256": "99dc6d06a1d498db5b31bfc7ab013916f05f9cc541da7eaf5642ae34d4bda341",
      "currentSHA256": "99dc6d06a1d498db5b31bfc7ab013916f05f9cc541da7eaf5642ae34d4bda341",
      "targetExpectedCheckoutSHA256": "99dc6d06a1d498db5b31bfc7ab013916f05f9cc541da7eaf5642ae34d4bda341",
      "targetBlob": "a2769efe0ef1fb2ca339ad863049474e808fedd9",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/schemas/config.schema.ts",
      "sha256": "49063e28ec9a61767db2fcc871cc08b6e813f5b1aeadd31e7003a553e63f7f0f",
      "oldSHA256": "49063e28ec9a61767db2fcc871cc08b6e813f5b1aeadd31e7003a553e63f7f0f",
      "currentSHA256": "49063e28ec9a61767db2fcc871cc08b6e813f5b1aeadd31e7003a553e63f7f0f",
      "targetExpectedCheckoutSHA256": "49063e28ec9a61767db2fcc871cc08b6e813f5b1aeadd31e7003a553e63f7f0f",
      "targetBlob": "161918ef695e59f33c637dda78c22919ad5148d5",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/AuthService.ts",
      "sha256": "139539f6d5172b5df8136c597bcd92b6b01bb1c1a869fe441744cb38562f11f2",
      "oldSHA256": "139539f6d5172b5df8136c597bcd92b6b01bb1c1a869fe441744cb38562f11f2",
      "currentSHA256": "139539f6d5172b5df8136c597bcd92b6b01bb1c1a869fe441744cb38562f11f2",
      "targetExpectedCheckoutSHA256": "139539f6d5172b5df8136c597bcd92b6b01bb1c1a869fe441744cb38562f11f2",
      "targetBlob": "c5938250808c6a773e8cdf515037884699798318",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/ConfigFileRepository.ts",
      "sha256": "cd4bb0c05d9ccff5a7ed9947bf98b6ed96c2b1a8521cfc026feddebe1aa5ee53",
      "oldSHA256": "cd4bb0c05d9ccff5a7ed9947bf98b6ed96c2b1a8521cfc026feddebe1aa5ee53",
      "currentSHA256": "cd4bb0c05d9ccff5a7ed9947bf98b6ed96c2b1a8521cfc026feddebe1aa5ee53",
      "targetExpectedCheckoutSHA256": "cd4bb0c05d9ccff5a7ed9947bf98b6ed96c2b1a8521cfc026feddebe1aa5ee53",
      "targetBlob": "503a089ba8924bfa49dd87a09084feb98113ce3c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/CryptoService.ts",
      "sha256": "f52aa4205f7d6c26e8a9a6fcf803bafd04294df778f2d91f06bf155f1af165ef",
      "oldSHA256": "f52aa4205f7d6c26e8a9a6fcf803bafd04294df778f2d91f06bf155f1af165ef",
      "currentSHA256": "f52aa4205f7d6c26e8a9a6fcf803bafd04294df778f2d91f06bf155f1af165ef",
      "targetExpectedCheckoutSHA256": "f52aa4205f7d6c26e8a9a6fcf803bafd04294df778f2d91f06bf155f1af165ef",
      "targetBlob": "206000d3690d0c552a7198fb7343ef5a1e79efb5",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/ForegroundAppDetector.ts",
      "sha256": "c4cf05169859b1e3903715716365daa4442e4d30336faae8e07b34bf0ee28eed",
      "oldSHA256": "c4cf05169859b1e3903715716365daa4442e4d30336faae8e07b34bf0ee28eed",
      "currentSHA256": "c4cf05169859b1e3903715716365daa4442e4d30336faae8e07b34bf0ee28eed",
      "targetExpectedCheckoutSHA256": "c4cf05169859b1e3903715716365daa4442e4d30336faae8e07b34bf0ee28eed",
      "targetBlob": "3e6b6a077a826b857afadf027e56bd5f472f5abb",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/HermesForegroundDetector.ts",
      "sha256": "e3ffdd3f1c62fc9150d326306d5f9370687c0630511b811576a9590d8fd4c3b7",
      "oldSHA256": "e3ffdd3f1c62fc9150d326306d5f9370687c0630511b811576a9590d8fd4c3b7",
      "currentSHA256": "e3ffdd3f1c62fc9150d326306d5f9370687c0630511b811576a9590d8fd4c3b7",
      "targetExpectedCheckoutSHA256": "e3ffdd3f1c62fc9150d326306d5f9370687c0630511b811576a9590d8fd4c3b7",
      "targetBlob": "79a74f6d52579fb8c053d5845ac0d6fe71490c1d",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/McpSecurityContract.ts",
      "sha256": "f07f81694fb7709c7be6bd4e56fe325a0f35828bd609159f4cd09c1e6197959d",
      "oldSHA256": "f07f81694fb7709c7be6bd4e56fe325a0f35828bd609159f4cd09c1e6197959d",
      "currentSHA256": "f07f81694fb7709c7be6bd4e56fe325a0f35828bd609159f4cd09c1e6197959d",
      "targetExpectedCheckoutSHA256": "f07f81694fb7709c7be6bd4e56fe325a0f35828bd609159f4cd09c1e6197959d",
      "targetBlob": "3fd5c717aff600200735f185777934c8141a0d61",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/OscDetector.ts",
      "sha256": "142c33655b3fac5b4bf0dd0280e8f5088237cb955444debf2662365ce4adb8f4",
      "oldSHA256": "142c33655b3fac5b4bf0dd0280e8f5088237cb955444debf2662365ce4adb8f4",
      "currentSHA256": "142c33655b3fac5b4bf0dd0280e8f5088237cb955444debf2662365ce4adb8f4",
      "targetExpectedCheckoutSHA256": "142c33655b3fac5b4bf0dd0280e8f5088237cb955444debf2662365ce4adb8f4",
      "targetBlob": "a4dc57d2388bea94df399686f0290c7bcd5a1e6a",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/RuntimeConfigStore.ts",
      "sha256": "8d766bdbe1e3e4c72c3f582f3ab9234aa9371280a4bc978307635f1d553d6e48",
      "oldSHA256": "8d766bdbe1e3e4c72c3f582f3ab9234aa9371280a4bc978307635f1d553d6e48",
      "currentSHA256": "8d766bdbe1e3e4c72c3f582f3ab9234aa9371280a4bc978307635f1d553d6e48",
      "targetExpectedCheckoutSHA256": "8d766bdbe1e3e4c72c3f582f3ab9234aa9371280a4bc978307635f1d553d6e48",
      "targetBlob": "3c2f31a432ba1f3d4d4103cdf68913b115b64c20",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/SessionInputGateway.ts",
      "sha256": "02445c4a717d14a9c04c0ad10575b4e7d7667fa1d7a781d41356f67bf4887a50",
      "oldSHA256": "02445c4a717d14a9c04c0ad10575b4e7d7667fa1d7a781d41356f67bf4887a50",
      "currentSHA256": "02445c4a717d14a9c04c0ad10575b4e7d7667fa1d7a781d41356f67bf4887a50",
      "targetExpectedCheckoutSHA256": "02445c4a717d14a9c04c0ad10575b4e7d7667fa1d7a781d41356f67bf4887a50",
      "targetBlob": "6a5c44d127b340bc72ff2ffa77e7b9b3f831273b",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/SessionManager.ts",
      "sha256": "c1d53a7aa160c042ee4a0b04d2a1b31929eae03f5ea13aa9776f1a3c39422fc1",
      "oldSHA256": "c1d53a7aa160c042ee4a0b04d2a1b31929eae03f5ea13aa9776f1a3c39422fc1",
      "currentSHA256": "c1d53a7aa160c042ee4a0b04d2a1b31929eae03f5ea13aa9776f1a3c39422fc1",
      "targetExpectedCheckoutSHA256": "c1d53a7aa160c042ee4a0b04d2a1b31929eae03f5ea13aa9776f1a3c39422fc1",
      "targetBlob": "d383ed8536a3fbd2dd00b2bda143f35337f7eaf4",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalAuthorityController.ts",
      "sha256": "b2529bf9a67d286efa964bd0c09042fea7513dcf6cc6830a42fb3055882faa84",
      "oldSHA256": "b2529bf9a67d286efa964bd0c09042fea7513dcf6cc6830a42fb3055882faa84",
      "currentSHA256": "b2529bf9a67d286efa964bd0c09042fea7513dcf6cc6830a42fb3055882faa84",
      "targetExpectedCheckoutSHA256": "b2529bf9a67d286efa964bd0c09042fea7513dcf6cc6830a42fb3055882faa84",
      "targetBlob": "b96671c66140dd3701ae27454e003010caea8427",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicy.test.ts",
      "sha256": "b8b5fb12913d839bd35868384d15c110d0e08a8f6f5d6afee7b661704e7050ac",
      "oldSHA256": "b8b5fb12913d839bd35868384d15c110d0e08a8f6f5d6afee7b661704e7050ac",
      "currentSHA256": "b8b5fb12913d839bd35868384d15c110d0e08a8f6f5d6afee7b661704e7050ac",
      "targetExpectedCheckoutSHA256": "b8b5fb12913d839bd35868384d15c110d0e08a8f6f5d6afee7b661704e7050ac",
      "targetBlob": "3e0fdd7754a00315b874411121fb3446afa57531",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicy.ts",
      "sha256": "110ce608ab9a0f73347f0d164960142a104169e9177dd9160302080a1851d425",
      "oldSHA256": "110ce608ab9a0f73347f0d164960142a104169e9177dd9160302080a1851d425",
      "currentSHA256": "110ce608ab9a0f73347f0d164960142a104169e9177dd9160302080a1851d425",
      "targetExpectedCheckoutSHA256": "110ce608ab9a0f73347f0d164960142a104169e9177dd9160302080a1851d425",
      "targetBlob": "5834721f469984ecf9610851b05437fafda7fd37",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyCanary.test.ts",
      "sha256": "8f225430cebf5d76c10322d6ecfebd4c79be1fd76c1e6374831be0439ecfae04",
      "oldSHA256": "8f225430cebf5d76c10322d6ecfebd4c79be1fd76c1e6374831be0439ecfae04",
      "currentSHA256": "8f225430cebf5d76c10322d6ecfebd4c79be1fd76c1e6374831be0439ecfae04",
      "targetExpectedCheckoutSHA256": "8f225430cebf5d76c10322d6ecfebd4c79be1fd76c1e6374831be0439ecfae04",
      "targetBlob": "271d2b81168dd27d2bfc0683674ff413bbd0c428",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyCanary.ts",
      "sha256": "f8d79247bf47b03a5f9613134cea7b5c9516caccdea41b694c55e3870767a2f1",
      "oldSHA256": "f8d79247bf47b03a5f9613134cea7b5c9516caccdea41b694c55e3870767a2f1",
      "currentSHA256": "f8d79247bf47b03a5f9613134cea7b5c9516caccdea41b694c55e3870767a2f1",
      "targetExpectedCheckoutSHA256": "f8d79247bf47b03a5f9613134cea7b5c9516caccdea41b694c55e3870767a2f1",
      "targetBlob": "710d66a86e4a5ff23cbbf020ae79080150b2ea5c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyInventory.ts",
      "sha256": "e472f6c4ba52ef9084aa26a71c8364dcba2b4fbbc003028fcbaf5c8161e4b467",
      "oldSHA256": "e472f6c4ba52ef9084aa26a71c8364dcba2b4fbbc003028fcbaf5c8161e4b467",
      "currentSHA256": "e472f6c4ba52ef9084aa26a71c8364dcba2b4fbbc003028fcbaf5c8161e4b467",
      "targetExpectedCheckoutSHA256": "e472f6c4ba52ef9084aa26a71c8364dcba2b4fbbc003028fcbaf5c8161e4b467",
      "targetBlob": "2aa1ac59da09951aa82b014263200e693594d771",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyObservations.ts",
      "sha256": "e28700007cb438be48a7f12362974ab84d3c2a04aec2823c3ba74ed3cfcd5fe2",
      "oldSHA256": "e28700007cb438be48a7f12362974ab84d3c2a04aec2823c3ba74ed3cfcd5fe2",
      "currentSHA256": "e28700007cb438be48a7f12362974ab84d3c2a04aec2823c3ba74ed3cfcd5fe2",
      "targetExpectedCheckoutSHA256": "e28700007cb438be48a7f12362974ab84d3c2a04aec2823c3ba74ed3cfcd5fe2",
      "targetBlob": "d5ca61785d3c81aa59fd8132679fe2630a8461ea",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyRuntime.ts",
      "sha256": "48425c4da95efd05eebaecd85c08691bb558b0398d5d54a4fd1efe8ffb581edb",
      "oldSHA256": "48425c4da95efd05eebaecd85c08691bb558b0398d5d54a4fd1efe8ffb581edb",
      "currentSHA256": "48425c4da95efd05eebaecd85c08691bb558b0398d5d54a4fd1efe8ffb581edb",
      "targetExpectedCheckoutSHA256": "48425c4da95efd05eebaecd85c08691bb558b0398d5d54a4fd1efe8ffb581edb",
      "targetBlob": "d097c2dcefacad770fd30d5f2177bf3414e6d8a4",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/types/auth.types.ts",
      "sha256": "44a44d4c87cf758c884c3bab5ce647417ce1065b139e813ee8bc54a7d5d58355",
      "oldSHA256": "44a44d4c87cf758c884c3bab5ce647417ce1065b139e813ee8bc54a7d5d58355",
      "currentSHA256": "44a44d4c87cf758c884c3bab5ce647417ce1065b139e813ee8bc54a7d5d58355",
      "targetExpectedCheckoutSHA256": "44a44d4c87cf758c884c3bab5ce647417ce1065b139e813ee8bc54a7d5d58355",
      "targetBlob": "45d5d12e289dd4eb3c26917e552623df3f73a6d6",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/types/config.types.ts",
      "sha256": "8d23f319ee07ebd70e7ddd633b9538ce2f3d8a662effe164664e53d3e2e26a26",
      "oldSHA256": "8d23f319ee07ebd70e7ddd633b9538ce2f3d8a662effe164664e53d3e2e26a26",
      "currentSHA256": "8d23f319ee07ebd70e7ddd633b9538ce2f3d8a662effe164664e53d3e2e26a26",
      "targetExpectedCheckoutSHA256": "8d23f319ee07ebd70e7ddd633b9538ce2f3d8a662effe164664e53d3e2e26a26",
      "targetBlob": "25a78484d95d37411be97f15e653e934b8405474",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/types/file.types.ts",
      "sha256": "6a1fea9ba0544f5f165bfe7aab9d384e08230f467c48ef96e0415f6af52bfb45",
      "oldSHA256": "6a1fea9ba0544f5f165bfe7aab9d384e08230f467c48ef96e0415f6af52bfb45",
      "currentSHA256": "6a1fea9ba0544f5f165bfe7aab9d384e08230f467c48ef96e0415f6af52bfb45",
      "targetExpectedCheckoutSHA256": "6a1fea9ba0544f5f165bfe7aab9d384e08230f467c48ef96e0415f6af52bfb45",
      "targetBlob": "8dba81aefc422749dee209681eb47286750a823b",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/types/index.ts",
      "sha256": "1e0dcf85d991f7b770b52f9ea92e78c75b08fbefcc16d3ec71bf249adb0dd461",
      "oldSHA256": "1e0dcf85d991f7b770b52f9ea92e78c75b08fbefcc16d3ec71bf249adb0dd461",
      "currentSHA256": "1e0dcf85d991f7b770b52f9ea92e78c75b08fbefcc16d3ec71bf249adb0dd461",
      "targetExpectedCheckoutSHA256": "1e0dcf85d991f7b770b52f9ea92e78c75b08fbefcc16d3ec71bf249adb0dd461",
      "targetBlob": "ac38f350887009f8135671578b9d6b00e127751f",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/types/settings.types.ts",
      "sha256": "5e8312d13835f3d585b9eed5889145d95b6c8830f6de69506c387d688c1fb1ad",
      "oldSHA256": "5e8312d13835f3d585b9eed5889145d95b6c8830f6de69506c387d688c1fb1ad",
      "currentSHA256": "5e8312d13835f3d585b9eed5889145d95b6c8830f6de69506c387d688c1fb1ad",
      "targetExpectedCheckoutSHA256": "5e8312d13835f3d585b9eed5889145d95b6c8830f6de69506c387d688c1fb1ad",
      "targetBlob": "60d139d0b8bbd56af708f69fbefd806558d09ac9",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/types/ws-protocol.ts",
      "sha256": "0f9337d2a287a09c401b4a44c5a1e2325f645cc5246b827e183736aa190a3ebb",
      "oldSHA256": "0f9337d2a287a09c401b4a44c5a1e2325f645cc5246b827e183736aa190a3ebb",
      "currentSHA256": "0f9337d2a287a09c401b4a44c5a1e2325f645cc5246b827e183736aa190a3ebb",
      "targetExpectedCheckoutSHA256": "0f9337d2a287a09c401b4a44c5a1e2325f645cc5246b827e183736aa190a3ebb",
      "targetBlob": "a81cc74e91a404eab78dae30cc8f44ced1ae9f7c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/boundedByteDeque.ts",
      "sha256": "2061918c1830d06dfa90bdf4ef7e3a162bd09dcb80e181ca8428fd4f072cc8d1",
      "oldSHA256": "2061918c1830d06dfa90bdf4ef7e3a162bd09dcb80e181ca8428fd4f072cc8d1",
      "currentSHA256": "2061918c1830d06dfa90bdf4ef7e3a162bd09dcb80e181ca8428fd4f072cc8d1",
      "targetExpectedCheckoutSHA256": "2061918c1830d06dfa90bdf4ef7e3a162bd09dcb80e181ca8428fd4f072cc8d1",
      "targetBlob": "9d5becb67afbcf48879a27f5546317acd45b3019",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/config.ts",
      "sha256": "5b50505c5093188c8f612d906fa3a310f24fefe6b6e0ca4879a70ed6c3770e61",
      "oldSHA256": "5b50505c5093188c8f612d906fa3a310f24fefe6b6e0ca4879a70ed6c3770e61",
      "currentSHA256": "5b50505c5093188c8f612d906fa3a310f24fefe6b6e0ca4879a70ed6c3770e61",
      "targetExpectedCheckoutSHA256": "5b50505c5093188c8f612d906fa3a310f24fefe6b6e0ca4879a70ed6c3770e61",
      "targetBlob": "163911772ca3b5f362a2f6b8dc4b4cebf004939f",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/configStrictLoader.ts",
      "sha256": "87abf4cff18440392856720c7b834f743a9f4d49f3f727da0e05da10e6eda379",
      "oldSHA256": "87abf4cff18440392856720c7b834f743a9f4d49f3f727da0e05da10e6eda379",
      "currentSHA256": "87abf4cff18440392856720c7b834f743a9f4d49f3f727da0e05da10e6eda379",
      "targetExpectedCheckoutSHA256": "87abf4cff18440392856720c7b834f743a9f4d49f3f727da0e05da10e6eda379",
      "targetBlob": "d74fbe784e4edecf1d2dfd58b34bd286b82c117c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/configTemplate.ts",
      "sha256": "5e0ca1e52fe5e5594e32b44dc21d05a3fdc63740f7f1303717960bd24976be35",
      "oldSHA256": "5e0ca1e52fe5e5594e32b44dc21d05a3fdc63740f7f1303717960bd24976be35",
      "currentSHA256": "5e0ca1e52fe5e5594e32b44dc21d05a3fdc63740f7f1303717960bd24976be35",
      "targetExpectedCheckoutSHA256": "5e0ca1e52fe5e5594e32b44dc21d05a3fdc63740f7f1303717960bd24976be35",
      "targetBlob": "1d2b7369b0b687fce1328e8520f5b3fb5e5096db",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/constants.ts",
      "sha256": "8579012f3f24e83dae7d5b31525d2da724948350fb4266050626b9152f0a4d7f",
      "oldSHA256": "8579012f3f24e83dae7d5b31525d2da724948350fb4266050626b9152f0a4d7f",
      "currentSHA256": "8579012f3f24e83dae7d5b31525d2da724948350fb4266050626b9152f0a4d7f",
      "targetExpectedCheckoutSHA256": "8579012f3f24e83dae7d5b31525d2da724948350fb4266050626b9152f0a4d7f",
      "targetBlob": "b930f698b4a1cdc0664f3f4c9dd88961187913a7",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/errors.ts",
      "sha256": "f769560cf53bee93439ea03d523de8d1cc159c84587be205bd70045ae35aaedc",
      "oldSHA256": "f769560cf53bee93439ea03d523de8d1cc159c84587be205bd70045ae35aaedc",
      "currentSHA256": "f769560cf53bee93439ea03d523de8d1cc159c84587be205bd70045ae35aaedc",
      "targetExpectedCheckoutSHA256": "f769560cf53bee93439ea03d523de8d1cc159c84587be205bd70045ae35aaedc",
      "targetBlob": "3a476853d067f67d1cffe858c90b609e85497c03",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/headlessOutputQueue.ts",
      "sha256": "be190bd28ff2dca559a05f7c7c68e1c15399a4656de3b145e95d6fb4cf7776ef",
      "oldSHA256": "be190bd28ff2dca559a05f7c7c68e1c15399a4656de3b145e95d6fb4cf7776ef",
      "currentSHA256": "be190bd28ff2dca559a05f7c7c68e1c15399a4656de3b145e95d6fb4cf7776ef",
      "targetExpectedCheckoutSHA256": "be190bd28ff2dca559a05f7c7c68e1c15399a4656de3b145e95d6fb4cf7776ef",
      "targetBlob": "b84187f2ddee2f213306e4181a089a2b151ce36c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/headlessTerminal.ts",
      "sha256": "873dd9f04f678b644e4bff8631af7fdf3a77b7e1ef3545be1b94fcfa24b5c637",
      "oldSHA256": "873dd9f04f678b644e4bff8631af7fdf3a77b7e1ef3545be1b94fcfa24b5c637",
      "currentSHA256": "873dd9f04f678b644e4bff8631af7fdf3a77b7e1ef3545be1b94fcfa24b5c637",
      "targetExpectedCheckoutSHA256": "873dd9f04f678b644e4bff8631af7fdf3a77b7e1ef3545be1b94fcfa24b5c637",
      "targetBlob": "4ebd4e574bf1552ca01bf9705be45e2522c06220",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/inputDebugMetadata.ts",
      "sha256": "fd885a33b443abb8f63ffb0fc3ff7ea9b119f3ac76a68b5d4a7e31e4775e2cd6",
      "oldSHA256": "fd885a33b443abb8f63ffb0fc3ff7ea9b119f3ac76a68b5d4a7e31e4775e2cd6",
      "currentSHA256": "fd885a33b443abb8f63ffb0fc3ff7ea9b119f3ac76a68b5d4a7e31e4775e2cd6",
      "targetExpectedCheckoutSHA256": "fd885a33b443abb8f63ffb0fc3ff7ea9b119f3ac76a68b5d4a7e31e4775e2cd6",
      "targetBlob": "b4077513779a83ffbdd55984e94d004643745a33",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/inputReliabilityMode.ts",
      "sha256": "31fb73ab70a2d0d6f5edd165a19c546853b98436572cf86bc508a6f7dfa51623",
      "oldSHA256": "31fb73ab70a2d0d6f5edd165a19c546853b98436572cf86bc508a6f7dfa51623",
      "currentSHA256": "31fb73ab70a2d0d6f5edd165a19c546853b98436572cf86bc508a6f7dfa51623",
      "targetExpectedCheckoutSHA256": "31fb73ab70a2d0d6f5edd165a19c546853b98436572cf86bc508a6f7dfa51623",
      "targetBlob": "b3e68dee72d1ec6105db6ef19818beb8f2a2221c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/processTreeTerminator.ts",
      "sha256": "1f2f5e09926e02ba549af4cb60f8ebc8cda6216642f992a15bf2420463a0e27c",
      "oldSHA256": "1f2f5e09926e02ba549af4cb60f8ebc8cda6216642f992a15bf2420463a0e27c",
      "currentSHA256": "1f2f5e09926e02ba549af4cb60f8ebc8cda6216642f992a15bf2420463a0e27c",
      "targetExpectedCheckoutSHA256": "1f2f5e09926e02ba549af4cb60f8ebc8cda6216642f992a15bf2420463a0e27c",
      "targetBlob": "cd428d3b43b342f71755719461dc85caabb0defd",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/ptyPlatformPolicy.ts",
      "sha256": "a616cffdfd3536e36cc5aa78cd3e2c6b4db85c28ae7f697470a4cdd3a1aabb4d",
      "oldSHA256": "a616cffdfd3536e36cc5aa78cd3e2c6b4db85c28ae7f697470a4cdd3a1aabb4d",
      "currentSHA256": "a616cffdfd3536e36cc5aa78cd3e2c6b4db85c28ae7f697470a4cdd3a1aabb4d",
      "targetExpectedCheckoutSHA256": "a616cffdfd3536e36cc5aa78cd3e2c6b4db85c28ae7f697470a4cdd3a1aabb4d",
      "targetBlob": "0db4f630f550ce8cf1792b7e3b83279f9f5cb765",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/recoveryCommand.ts",
      "sha256": "c5ba9080f6dbd2d6c85c2707c7c8ab833c557209f03566c00f238aac57404739",
      "oldSHA256": "c5ba9080f6dbd2d6c85c2707c7c8ab833c557209f03566c00f238aac57404739",
      "currentSHA256": "c5ba9080f6dbd2d6c85c2707c7c8ab833c557209f03566c00f238aac57404739",
      "targetExpectedCheckoutSHA256": "c5ba9080f6dbd2d6c85c2707c7c8ab833c557209f03566c00f238aac57404739",
      "targetBlob": "c5590ed5104a064fc80ecba3a3c584615fb1641c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalPartialEscapeTail.ts",
      "sha256": "e977b1f1a0636f2b5f1c08bbcddfb7b4401de20e27357e95bbe68efca974936b",
      "oldSHA256": "e977b1f1a0636f2b5f1c08bbcddfb7b4401de20e27357e95bbe68efca974936b",
      "currentSHA256": "e977b1f1a0636f2b5f1c08bbcddfb7b4401de20e27357e95bbe68efca974936b",
      "targetExpectedCheckoutSHA256": "e977b1f1a0636f2b5f1c08bbcddfb7b4401de20e27357e95bbe68efca974936b",
      "targetBlob": "929198a23ad8b1b395bc54d62aa65277b922a5f1",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalPayload.ts",
      "sha256": "9a12384dd4d1fccd45ea5c877f67580ce25cbb2db91375052067c8f28a2e1705",
      "oldSHA256": "9a12384dd4d1fccd45ea5c877f67580ce25cbb2db91375052067c8f28a2e1705",
      "currentSHA256": "9a12384dd4d1fccd45ea5c877f67580ce25cbb2db91375052067c8f28a2e1705",
      "targetExpectedCheckoutSHA256": "9a12384dd4d1fccd45ea5c877f67580ce25cbb2db91375052067c8f28a2e1705",
      "targetBlob": "0d059092fe4f9045e8f24aed72301c79dc34eba7",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalQueryResponder.ts",
      "sha256": "4cdabf44879ef8e01a6c190d70a6f3e62d6adfe1d48eef3213a2971ac2ec36cf",
      "oldSHA256": "4cdabf44879ef8e01a6c190d70a6f3e62d6adfe1d48eef3213a2971ac2ec36cf",
      "currentSHA256": "4cdabf44879ef8e01a6c190d70a6f3e62d6adfe1d48eef3213a2971ac2ec36cf",
      "targetExpectedCheckoutSHA256": "4cdabf44879ef8e01a6c190d70a6f3e62d6adfe1d48eef3213a2971ac2ec36cf",
      "targetBlob": "b903556283d5fb0b891fbdc8a51e661225914140",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalTitle.ts",
      "sha256": "5bf92c10d2c69b17ecfd1cbae130fd083ed3d66e3b9a6ffe2b479a9aa3bb3e11",
      "oldSHA256": "5bf92c10d2c69b17ecfd1cbae130fd083ed3d66e3b9a6ffe2b479a9aa3bb3e11",
      "currentSHA256": "5bf92c10d2c69b17ecfd1cbae130fd083ed3d66e3b9a6ffe2b479a9aa3bb3e11",
      "targetExpectedCheckoutSHA256": "5bf92c10d2c69b17ecfd1cbae130fd083ed3d66e3b9a6ffe2b479a9aa3bb3e11",
      "targetBlob": "6dbd3f7390869e892aa2993de74e9a41b7111aef",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/FairTerminalDeliveryScheduler.test.ts",
      "sha256": "786ab1a9e849ba88cb1dd976b081ddedccf95add0f2bb476a6ff6b55251d5863",
      "oldSHA256": "786ab1a9e849ba88cb1dd976b081ddedccf95add0f2bb476a6ff6b55251d5863",
      "currentSHA256": "786ab1a9e849ba88cb1dd976b081ddedccf95add0f2bb476a6ff6b55251d5863",
      "targetExpectedCheckoutSHA256": "786ab1a9e849ba88cb1dd976b081ddedccf95add0f2bb476a6ff6b55251d5863",
      "targetBlob": "65c4ecabc00757aa31d154f58820783163cc76c2",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/WsRouter.ts",
      "sha256": "e2ae4af70060376e8083078d435dac7248f5aa45f53146eff83811f1123c46ae",
      "oldSHA256": "e2ae4af70060376e8083078d435dac7248f5aa45f53146eff83811f1123c46ae",
      "currentSHA256": "e2ae4af70060376e8083078d435dac7248f5aa45f53146eff83811f1123c46ae",
      "targetExpectedCheckoutSHA256": "e2ae4af70060376e8083078d435dac7248f5aa45f53146eff83811f1123c46ae",
      "targetBlob": "c896148945ce46053425e77937ab9e7ef7620404",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/WsRouterSendPriority.test.ts",
      "sha256": "d0355b94974a7e6fdcda9093d251c9c3197166c72566177d3fa34f736dcad019",
      "oldSHA256": "d0355b94974a7e6fdcda9093d251c9c3197166c72566177d3fa34f736dcad019",
      "currentSHA256": "d0355b94974a7e6fdcda9093d251c9c3197166c72566177d3fa34f736dcad019",
      "targetExpectedCheckoutSHA256": "d0355b94974a7e6fdcda9093d251c9c3197166c72566177d3fa34f736dcad019",
      "targetBlob": "91b69c149957a45c29f23df07894196af00904ba",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/binaryFrameCodec.ts",
      "sha256": "d2d28f6e190a82fc9c4944a857978e6c850618233577591e473a0f7872ab6c6c",
      "oldSHA256": "d2d28f6e190a82fc9c4944a857978e6c850618233577591e473a0f7872ab6c6c",
      "currentSHA256": "d2d28f6e190a82fc9c4944a857978e6c850618233577591e473a0f7872ab6c6c",
      "targetExpectedCheckoutSHA256": "d2d28f6e190a82fc9c4944a857978e6c850618233577591e473a0f7872ab6c6c",
      "targetBlob": "7a0f45864c1be079c3fe14190206e77920a24fa8",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalBinaryGroupSession.ts",
      "sha256": "b53aca3967b4a7928dc28f71bed5e3a6900bfbaa7952ce25b35280219cf4e11a",
      "oldSHA256": "b53aca3967b4a7928dc28f71bed5e3a6900bfbaa7952ce25b35280219cf4e11a",
      "currentSHA256": "b53aca3967b4a7928dc28f71bed5e3a6900bfbaa7952ce25b35280219cf4e11a",
      "targetExpectedCheckoutSHA256": "b53aca3967b4a7928dc28f71bed5e3a6900bfbaa7952ce25b35280219cf4e11a",
      "targetBlob": "523ab0e4639fe8b7f9df1bf4fcb54691a25c982e",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalBinaryNegotiation.ts",
      "sha256": "e27205a895e5cc336fa208a40d343906774f061b2814fd8fa3fd89f86759df72",
      "oldSHA256": "e27205a895e5cc336fa208a40d343906774f061b2814fd8fa3fd89f86759df72",
      "currentSHA256": "e27205a895e5cc336fa208a40d343906774f061b2814fd8fa3fd89f86759df72",
      "targetExpectedCheckoutSHA256": "e27205a895e5cc336fa208a40d343906774f061b2814fd8fa3fd89f86759df72",
      "targetBlob": "1d3b220ff1ca8cd41c1169b1faa37dc526030407",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalChannelAllocator.ts",
      "sha256": "cb9be6a63afcd91a1ec9c6a0dd154897321ed1c21e7a6d26516c092a5d15ca2a",
      "oldSHA256": "cb9be6a63afcd91a1ec9c6a0dd154897321ed1c21e7a6d26516c092a5d15ca2a",
      "currentSHA256": "cb9be6a63afcd91a1ec9c6a0dd154897321ed1c21e7a6d26516c092a5d15ca2a",
      "targetExpectedCheckoutSHA256": "cb9be6a63afcd91a1ec9c6a0dd154897321ed1c21e7a6d26516c092a5d15ca2a",
      "targetBlob": "356136336aec1719a6417856fdfec45cbafeffae",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalStreamEpoch.ts",
      "sha256": "5746acc8739574606553ea40afdfa754a84a1565365b55665f5e620bf39f953a",
      "oldSHA256": "5746acc8739574606553ea40afdfa754a84a1565365b55665f5e620bf39f953a",
      "currentSHA256": "5746acc8739574606553ea40afdfa754a84a1565365b55665f5e620bf39f953a",
      "targetExpectedCheckoutSHA256": "5746acc8739574606553ea40afdfa754a84a1565365b55665f5e620bf39f953a",
      "targetBlob": "0e50500e06e74073d2eaa06d1761e049306eeb9c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalWireFormat.ts",
      "sha256": "d65065ed7a1fc7a9031b88f958d35db14b22c9fc3f4970ba948f874cd5fbfe3f",
      "oldSHA256": "d65065ed7a1fc7a9031b88f958d35db14b22c9fc3f4970ba948f874cd5fbfe3f",
      "currentSHA256": "d65065ed7a1fc7a9031b88f958d35db14b22c9fc3f4970ba948f874cd5fbfe3f",
      "targetExpectedCheckoutSHA256": "d65065ed7a1fc7a9031b88f958d35db14b22c9fc3f4970ba948f874cd5fbfe3f",
      "targetBlob": "a4a51fa10ddbd63d6b0b00b150b2aa0c3569b259",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/wirePayload.ts",
      "sha256": "68261b994ecfa57762a417b58ba81d0e33a42f0d34f399bf4f856b259d391c1c",
      "oldSHA256": "68261b994ecfa57762a417b58ba81d0e33a42f0d34f399bf4f856b259d391c1c",
      "currentSHA256": "68261b994ecfa57762a417b58ba81d0e33a42f0d34f399bf4f856b259d391c1c",
      "targetExpectedCheckoutSHA256": "68261b994ecfa57762a417b58ba81d0e33a42f0d34f399bf4f856b259d391c1c",
      "targetBlob": "0357fe6f4e6edf38977161e94304ad76a92faa20",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/wsSendPolicy.ts",
      "sha256": "d8161ec40992dfaabc0285fa39d29299b933133931e5be05197eefa7fc258939",
      "oldSHA256": "d8161ec40992dfaabc0285fa39d29299b933133931e5be05197eefa7fc258939",
      "currentSHA256": "d8161ec40992dfaabc0285fa39d29299b933133931e5be05197eefa7fc258939",
      "targetExpectedCheckoutSHA256": "d8161ec40992dfaabc0285fa39d29299b933133931e5be05197eefa7fc258939",
      "targetBlob": "6021238fbd7f0f6d9113e8d244ba4a6a3c24d2a4",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/wsSendPolicyRestoreMetadata.test.ts",
      "sha256": "4670ed60715f827aa9c6e6d90371dacedc17d7c1a51f9083e4bcba681f9419cc",
      "oldSHA256": "4670ed60715f827aa9c6e6d90371dacedc17d7c1a51f9083e4bcba681f9419cc",
      "currentSHA256": "4670ed60715f827aa9c6e6d90371dacedc17d7c1a51f9083e4bcba681f9419cc",
      "targetExpectedCheckoutSHA256": "4670ed60715f827aa9c6e6d90371dacedc17d7c1a51f9083e4bcba681f9419cc",
      "targetBlob": "0126045f60b06b1128633a4b522b0399e54012d2",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "server/src/ws/wsTransportMode.ts",
      "sha256": "737db8d84ef8f445d5deb1843885684d7136eff654c5482cc272d7f57d3da103",
      "oldSHA256": "737db8d84ef8f445d5deb1843885684d7136eff654c5482cc272d7f57d3da103",
      "currentSHA256": "737db8d84ef8f445d5deb1843885684d7136eff654c5482cc272d7f57d3da103",
      "targetExpectedCheckoutSHA256": "737db8d84ef8f445d5deb1843885684d7136eff654c5482cc272d7f57d3da103",
      "targetBlob": "791d341237d891ba8937b56aa1aeb0dc55c6bfd7",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "tools/wave3/fair-scheduler-decision.test.mjs",
      "sha256": "e4dc5c195bc13aa2e15bbec7ba6c90dd425727f5af59e0bfbfa4d6f9d88997c6",
      "oldSHA256": "e4dc5c195bc13aa2e15bbec7ba6c90dd425727f5af59e0bfbfa4d6f9d88997c6",
      "currentSHA256": "e4dc5c195bc13aa2e15bbec7ba6c90dd425727f5af59e0bfbfa4d6f9d88997c6",
      "targetExpectedCheckoutSHA256": "e4dc5c195bc13aa2e15bbec7ba6c90dd425727f5af59e0bfbfa4d6f9d88997c6",
      "targetBlob": "438892c867234bf952bbc34bdb9b8757ba28fd24",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "source",
      "path": "tools/wave3/internal/fair-readmission-closure-v3-internal-core.mjs",
      "sha256": "19525f372d51167c3ae4ea090721e1b8edb3dcbc6fda994ca975b86426fcebe0",
      "oldSHA256": "19525f372d51167c3ae4ea090721e1b8edb3dcbc6fda994ca975b86426fcebe0",
      "currentSHA256": "19525f372d51167c3ae4ea090721e1b8edb3dcbc6fda994ca975b86426fcebe0",
      "targetExpectedCheckoutSHA256": "19525f372d51167c3ae4ea090721e1b8edb3dcbc6fda994ca975b86426fcebe0",
      "targetBlob": "d3534050bf44e31a67a1549332d0edc4aee3a2d8",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json",
      "sha256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "oldSHA256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "currentSHA256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "targetExpectedCheckoutSHA256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "targetBlob": "06d7663d4be7515db472f85f62f1fc5ea39451fc",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json.publication.json",
      "sha256": "5033ce755efc1c9b4d291621bc725520dec0cba305fe2ff212c8d20a170c8cf3",
      "oldSHA256": "5033ce755efc1c9b4d291621bc725520dec0cba305fe2ff212c8d20a170c8cf3",
      "currentSHA256": "5033ce755efc1c9b4d291621bc725520dec0cba305fe2ff212c8d20a170c8cf3",
      "targetExpectedCheckoutSHA256": "5033ce755efc1c9b4d291621bc725520dec0cba305fe2ff212c8d20a170c8cf3",
      "targetBlob": "f26d2c380bd449728b75ff103605b80730308115",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json.raw.json",
      "sha256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "oldSHA256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "currentSHA256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "targetExpectedCheckoutSHA256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "targetBlob": "859305fd88145cac8f77db1a32fac722ada262b7",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-decision.json",
      "sha256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "oldSHA256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "currentSHA256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "targetExpectedCheckoutSHA256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c",
      "targetBlob": "06d7663d4be7515db472f85f62f1fc5ea39451fc",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-decision.raw.json",
      "sha256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "oldSHA256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "currentSHA256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "targetExpectedCheckoutSHA256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735",
      "targetBlob": "859305fd88145cac8f77db1a32fac722ada262b7",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-0.json",
      "sha256": "91842e2bc17c77d2d1144f21fb80587248fbae54786b7d6cabac34f01958e9ab",
      "oldSHA256": "91842e2bc17c77d2d1144f21fb80587248fbae54786b7d6cabac34f01958e9ab",
      "currentSHA256": "91842e2bc17c77d2d1144f21fb80587248fbae54786b7d6cabac34f01958e9ab",
      "targetExpectedCheckoutSHA256": "91842e2bc17c77d2d1144f21fb80587248fbae54786b7d6cabac34f01958e9ab",
      "targetBlob": "1038fd17f90e0cef68e658707be7514bde406f72",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-1.json",
      "sha256": "65b262ff95367d81f244d6873f83cb55028dc334ba7c0a0a27208d2cf2c12e2d",
      "oldSHA256": "65b262ff95367d81f244d6873f83cb55028dc334ba7c0a0a27208d2cf2c12e2d",
      "currentSHA256": "65b262ff95367d81f244d6873f83cb55028dc334ba7c0a0a27208d2cf2c12e2d",
      "targetExpectedCheckoutSHA256": "65b262ff95367d81f244d6873f83cb55028dc334ba7c0a0a27208d2cf2c12e2d",
      "targetBlob": "0b374aa9d05952fa1bc937d944adcd19103b3f27",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-2.json",
      "sha256": "7c122181385a050e2f800d784314d18bc49b69a1b9ea3f776c750ed1cba9a9ab",
      "oldSHA256": "7c122181385a050e2f800d784314d18bc49b69a1b9ea3f776c750ed1cba9a9ab",
      "currentSHA256": "7c122181385a050e2f800d784314d18bc49b69a1b9ea3f776c750ed1cba9a9ab",
      "targetExpectedCheckoutSHA256": "7c122181385a050e2f800d784314d18bc49b69a1b9ea3f776c750ed1cba9a9ab",
      "targetBlob": "f7f229149e192901e107274bced7a31274a49db3",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-3.json",
      "sha256": "62e2743a1a93438a08d8f7807c39c7aaced78eb691f3e3b4de7e635dc3d7be77",
      "oldSHA256": "62e2743a1a93438a08d8f7807c39c7aaced78eb691f3e3b4de7e635dc3d7be77",
      "currentSHA256": "62e2743a1a93438a08d8f7807c39c7aaced78eb691f3e3b4de7e635dc3d7be77",
      "targetExpectedCheckoutSHA256": "62e2743a1a93438a08d8f7807c39c7aaced78eb691f3e3b4de7e635dc3d7be77",
      "targetBlob": "6d81bebc44fa1c8ef0f505a850f5015101d30264",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-4.json",
      "sha256": "280fa7e2eb96522404a291f31378bfcb848d8a4e5d151400d6ac5e6c9fd9b353",
      "oldSHA256": "280fa7e2eb96522404a291f31378bfcb848d8a4e5d151400d6ac5e6c9fd9b353",
      "currentSHA256": "280fa7e2eb96522404a291f31378bfcb848d8a4e5d151400d6ac5e6c9fd9b353",
      "targetExpectedCheckoutSHA256": "280fa7e2eb96522404a291f31378bfcb848d8a4e5d151400d6ac5e6c9fd9b353",
      "targetBlob": "f58be68dd988e97e1973ac480390a176891ef46b",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-0.json",
      "sha256": "65b73ebe2dfa8503706eb0d61bf0d60bb79f73b5ea03d7c79f52c218c03aa1a2",
      "oldSHA256": "65b73ebe2dfa8503706eb0d61bf0d60bb79f73b5ea03d7c79f52c218c03aa1a2",
      "currentSHA256": "65b73ebe2dfa8503706eb0d61bf0d60bb79f73b5ea03d7c79f52c218c03aa1a2",
      "targetExpectedCheckoutSHA256": "65b73ebe2dfa8503706eb0d61bf0d60bb79f73b5ea03d7c79f52c218c03aa1a2",
      "targetBlob": "90f4459b356a3a872e890c2ef4414e9a1aa43ee1",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-1.json",
      "sha256": "dc4ba1f92764dd3791d36aa0641aeabde7aafb56b337a0a5010d4f828c4dd8b9",
      "oldSHA256": "dc4ba1f92764dd3791d36aa0641aeabde7aafb56b337a0a5010d4f828c4dd8b9",
      "currentSHA256": "dc4ba1f92764dd3791d36aa0641aeabde7aafb56b337a0a5010d4f828c4dd8b9",
      "targetExpectedCheckoutSHA256": "dc4ba1f92764dd3791d36aa0641aeabde7aafb56b337a0a5010d4f828c4dd8b9",
      "targetBlob": "8345776cc04e766561118222dc4398d7cc4eac6e",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-2.json",
      "sha256": "6e05c18bc8e914d8bb8981493b4f19779cb60883548507c71d02376c0661fba3",
      "oldSHA256": "6e05c18bc8e914d8bb8981493b4f19779cb60883548507c71d02376c0661fba3",
      "currentSHA256": "6e05c18bc8e914d8bb8981493b4f19779cb60883548507c71d02376c0661fba3",
      "targetExpectedCheckoutSHA256": "6e05c18bc8e914d8bb8981493b4f19779cb60883548507c71d02376c0661fba3",
      "targetBlob": "e5947e0f6109d101bea03f0b7c74b840fdc6b8e7",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-3.json",
      "sha256": "195185785181d57ab84c4343ed6fb819bad2076ea4c1b8e402f5a126c7d35dac",
      "oldSHA256": "195185785181d57ab84c4343ed6fb819bad2076ea4c1b8e402f5a126c7d35dac",
      "currentSHA256": "195185785181d57ab84c4343ed6fb819bad2076ea4c1b8e402f5a126c7d35dac",
      "targetExpectedCheckoutSHA256": "195185785181d57ab84c4343ed6fb819bad2076ea4c1b8e402f5a126c7d35dac",
      "targetBlob": "061ec7caec64ff2009f7634bf7b632ef43d09408",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-4.json",
      "sha256": "8791685e61d39e97155d98a7f0132288d228b6e5ca98ac6a177900c0aa883bf0",
      "oldSHA256": "8791685e61d39e97155d98a7f0132288d228b6e5ca98ac6a177900c0aa883bf0",
      "currentSHA256": "8791685e61d39e97155d98a7f0132288d228b6e5ca98ac6a177900c0aa883bf0",
      "targetExpectedCheckoutSHA256": "8791685e61d39e97155d98a7f0132288d228b6e5ca98ac6a177900c0aa883bf0",
      "targetBlob": "c19e0e96678c892481b0c2d0515f1511f4449982",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-0.json",
      "sha256": "6d9cc261c55f03a95daa967b7e7f9b57e5fef920a8af690bf442a90cfdc873c7",
      "oldSHA256": "6d9cc261c55f03a95daa967b7e7f9b57e5fef920a8af690bf442a90cfdc873c7",
      "currentSHA256": "6d9cc261c55f03a95daa967b7e7f9b57e5fef920a8af690bf442a90cfdc873c7",
      "targetExpectedCheckoutSHA256": "6d9cc261c55f03a95daa967b7e7f9b57e5fef920a8af690bf442a90cfdc873c7",
      "targetBlob": "d78f2291576f9cb3ab1d6b71877bc2dea51a1115",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-1.json",
      "sha256": "b052a6509827423038cf452383212433dcba0dd36b1480cfe67166fd2ca1161c",
      "oldSHA256": "b052a6509827423038cf452383212433dcba0dd36b1480cfe67166fd2ca1161c",
      "currentSHA256": "b052a6509827423038cf452383212433dcba0dd36b1480cfe67166fd2ca1161c",
      "targetExpectedCheckoutSHA256": "b052a6509827423038cf452383212433dcba0dd36b1480cfe67166fd2ca1161c",
      "targetBlob": "f96ca873398c121ad6c80624bd57c6ee768423a6",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-2.json",
      "sha256": "5d8b3adc455fdcab34344a9cd614b5fb990043182901ff8cf42799b08ecdfd62",
      "oldSHA256": "5d8b3adc455fdcab34344a9cd614b5fb990043182901ff8cf42799b08ecdfd62",
      "currentSHA256": "5d8b3adc455fdcab34344a9cd614b5fb990043182901ff8cf42799b08ecdfd62",
      "targetExpectedCheckoutSHA256": "5d8b3adc455fdcab34344a9cd614b5fb990043182901ff8cf42799b08ecdfd62",
      "targetBlob": "2c9648474bc6aa480e7317eb8da23242a144ec74",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-3.json",
      "sha256": "b909787ab77bb91a5df58f5f3736233f32e26b0d85214537b6ccce5a7978e3a0",
      "oldSHA256": "b909787ab77bb91a5df58f5f3736233f32e26b0d85214537b6ccce5a7978e3a0",
      "currentSHA256": "b909787ab77bb91a5df58f5f3736233f32e26b0d85214537b6ccce5a7978e3a0",
      "targetExpectedCheckoutSHA256": "b909787ab77bb91a5df58f5f3736233f32e26b0d85214537b6ccce5a7978e3a0",
      "targetBlob": "e973dd093f47493b2032fb9c804d55668b4dedfc",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-4.json",
      "sha256": "e48a4ba536cb97798c46ca70b609eafb41106e478ac911a593e2fe8a736a473f",
      "oldSHA256": "e48a4ba536cb97798c46ca70b609eafb41106e478ac911a593e2fe8a736a473f",
      "currentSHA256": "e48a4ba536cb97798c46ca70b609eafb41106e478ac911a593e2fe8a736a473f",
      "targetExpectedCheckoutSHA256": "e48a4ba536cb97798c46ca70b609eafb41106e478ac911a593e2fe8a736a473f",
      "targetBlob": "be46b291d352a30ba90cb3faa2051877f19f74a3",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/package-lock.json",
      "sha256": "41b63b94b65ee1f501f7008a3198e02dbcf775c41399c73feae3ac795d0913ab",
      "oldSHA256": "41b63b94b65ee1f501f7008a3198e02dbcf775c41399c73feae3ac795d0913ab",
      "currentSHA256": "41b63b94b65ee1f501f7008a3198e02dbcf775c41399c73feae3ac795d0913ab",
      "targetExpectedCheckoutSHA256": "41b63b94b65ee1f501f7008a3198e02dbcf775c41399c73feae3ac795d0913ab",
      "targetBlob": "be20110f074ea5653a35a718fb9860257c7bdc25",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/package.json",
      "sha256": "e0e65ab4f55e6e62e133c22493bf5df6cf1486d5c792e81d6b71fecdb6ccaabc",
      "oldSHA256": "e0e65ab4f55e6e62e133c22493bf5df6cf1486d5c792e81d6b71fecdb6ccaabc",
      "currentSHA256": "e0e65ab4f55e6e62e133c22493bf5df6cf1486d5c792e81d6b71fecdb6ccaabc",
      "targetExpectedCheckoutSHA256": "e0e65ab4f55e6e62e133c22493bf5df6cf1486d5c792e81d6b71fecdb6ccaabc",
      "targetBlob": "80814ae143c0a5c5fde02c9a9890b67c2b9ce3f7",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/playwright.config.ts",
      "sha256": "b4bba5c168d8975ef8940bacb3abee6299f428fd949fa7823e2a607be19ff39d",
      "oldSHA256": "b4bba5c168d8975ef8940bacb3abee6299f428fd949fa7823e2a607be19ff39d",
      "currentSHA256": "b4bba5c168d8975ef8940bacb3abee6299f428fd949fa7823e2a607be19ff39d",
      "targetExpectedCheckoutSHA256": "b4bba5c168d8975ef8940bacb3abee6299f428fd949fa7823e2a607be19ff39d",
      "targetBlob": "dbfa08e1125691014b7a3632c6db0e06f2b68b83",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/pnpm-lock.yaml",
      "sha256": "dc0a943caa8d8b463470cc81418a14a0901d27476927ea1b155a370df8ea3c73",
      "oldSHA256": "dc0a943caa8d8b463470cc81418a14a0901d27476927ea1b155a370df8ea3c73",
      "currentSHA256": "dc0a943caa8d8b463470cc81418a14a0901d27476927ea1b155a370df8ea3c73",
      "targetExpectedCheckoutSHA256": "dc0a943caa8d8b463470cc81418a14a0901d27476927ea1b155a370df8ea3c73",
      "targetBlob": "4808ec11b6950e67ee73c7dd6251ab6873e16d57",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/tsconfig.app.json",
      "sha256": "185c585aa92b2cbe0df1918e999d9a6bc4fec6762a6d80de7d2d155d56369aed",
      "oldSHA256": "185c585aa92b2cbe0df1918e999d9a6bc4fec6762a6d80de7d2d155d56369aed",
      "currentSHA256": "185c585aa92b2cbe0df1918e999d9a6bc4fec6762a6d80de7d2d155d56369aed",
      "targetExpectedCheckoutSHA256": "185c585aa92b2cbe0df1918e999d9a6bc4fec6762a6d80de7d2d155d56369aed",
      "targetBlob": "a9b5a59ca647ca0102d2501b56cedd83ad7b6818",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/tsconfig.json",
      "sha256": "ad28d132ee48d6e23917cf5827cace785d0fc01a44ca68b0dda51cc8c3fd3f52",
      "oldSHA256": "ad28d132ee48d6e23917cf5827cace785d0fc01a44ca68b0dda51cc8c3fd3f52",
      "currentSHA256": "ad28d132ee48d6e23917cf5827cace785d0fc01a44ca68b0dda51cc8c3fd3f52",
      "targetExpectedCheckoutSHA256": "ad28d132ee48d6e23917cf5827cace785d0fc01a44ca68b0dda51cc8c3fd3f52",
      "targetBlob": "1ffef600d959ec9e396d5a260bd3f5b927b2cef8",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/tsconfig.node.json",
      "sha256": "a6d49d645590cac21c235a0548605d867321b2e1750e99176d2153d702dfa842",
      "oldSHA256": "a6d49d645590cac21c235a0548605d867321b2e1750e99176d2153d702dfa842",
      "currentSHA256": "a6d49d645590cac21c235a0548605d867321b2e1750e99176d2153d702dfa842",
      "targetExpectedCheckoutSHA256": "a6d49d645590cac21c235a0548605d867321b2e1750e99176d2153d702dfa842",
      "targetBlob": "8a67f62f4ceebff3424e6e8cd4b3c25b17347546",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "frontend/vite.config.ts",
      "sha256": "493c33475bf32ee67e0e97e681b5c5ddb893440093bb9922ae2eb3b185f7b4a4",
      "oldSHA256": "493c33475bf32ee67e0e97e681b5c5ddb893440093bb9922ae2eb3b185f7b4a4",
      "currentSHA256": "493c33475bf32ee67e0e97e681b5c5ddb893440093bb9922ae2eb3b185f7b4a4",
      "targetExpectedCheckoutSHA256": "493c33475bf32ee67e0e97e681b5c5ddb893440093bb9922ae2eb3b185f7b4a4",
      "targetBlob": "92aa1b7e0de124a3c439aff4a877ed009490c16d",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "server/config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "oldSHA256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "currentSHA256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "targetExpectedCheckoutSHA256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b",
      "targetBlob": null,
      "targetBasis": "untracked canonical-owned input preserved, not copied from main",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "server/package-lock.json",
      "sha256": "463ad51dd7102ce9fc97da73e90226f8581e8cc521c90c8de32085dbcdeb594a",
      "oldSHA256": "463ad51dd7102ce9fc97da73e90226f8581e8cc521c90c8de32085dbcdeb594a",
      "currentSHA256": "463ad51dd7102ce9fc97da73e90226f8581e8cc521c90c8de32085dbcdeb594a",
      "targetExpectedCheckoutSHA256": "463ad51dd7102ce9fc97da73e90226f8581e8cc521c90c8de32085dbcdeb594a",
      "targetBlob": "712173c8c68c7698b4d6f04ffdee05b6245a738e",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "server/package.json",
      "sha256": "9c0d9dec2f86ee85709b7865ff46899ebadca5f48b9aef0a9f3a124ca7961200",
      "oldSHA256": "9c0d9dec2f86ee85709b7865ff46899ebadca5f48b9aef0a9f3a124ca7961200",
      "currentSHA256": "9c0d9dec2f86ee85709b7865ff46899ebadca5f48b9aef0a9f3a124ca7961200",
      "targetExpectedCheckoutSHA256": "9c0d9dec2f86ee85709b7865ff46899ebadca5f48b9aef0a9f3a124ca7961200",
      "targetBlob": "c62611e137696deca505a11e8f567f4ea9666909",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "kind": "config_lock",
      "path": "server/tsconfig.json",
      "sha256": "0390c1de164283f9fb55956b0fc2d207609c107422e123014411f78f66ccb336",
      "oldSHA256": "0390c1de164283f9fb55956b0fc2d207609c107422e123014411f78f66ccb336",
      "currentSHA256": "0390c1de164283f9fb55956b0fc2d207609c107422e123014411f78f66ccb336",
      "targetExpectedCheckoutSHA256": "0390c1de164283f9fb55956b0fc2d207609c107422e123014411f78f66ccb336",
      "targetBlob": "f44baa9ff8dd8193482337d164d63dc324f5706c",
      "targetBasis": "committed blob with current checkout filters",
      "changed": false
    },
    {
      "path": "tools/wave3/fair-readmission-closure-v3.mjs",
      "sha256": "dc78fb2d980f72e11322ebc8514286673f591b85ebe7544fdc0424c64c27816e",
      "oldSHA256": "dc78fb2d980f72e11322ebc8514286673f591b85ebe7544fdc0424c64c27816e",
      "currentSHA256": "dc78fb2d980f72e11322ebc8514286673f591b85ebe7544fdc0424c64c27816e",
      "targetExpectedCheckoutSHA256": "572742093b106470e422ff396f31ef8f6b4b75e5440903af7ce0bd1b13980059",
      "targetBlob": "00af3339abda4aa6bdbe4c42f6c6ffbecdb18177",
      "targetBasis": "committed blob with current checkout filters",
      "changed": true
    }
  ],
  "inputChanges": [
    "tools/wave3/fair-readmission-closure-v3.mjs"
  ],
  "oldManifest": {
    "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-fixture-canonical-manifest.json",
    "sha256": "ea4b3589aa66a47f6c727c8b6916804ee0eac9bbc670218071486a8966a214d0"
  },
  "workflow": {
    "mcpWorkspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "source": "prior MCP workspace read-back; no MCP mutation",
    "run": "N/A",
    "task": "N/A",
    "event": "N/A",
    "idempotency": "N/A"
  },
  "collectionNote": "First read-only Git cat-file collection hit default maxBuffer ENOBUFS on a large tracked artifact; no document was written. Retried with explicit128MiB capture bound. Git child only; no Node termination or workspace mutation."
}
```

## Independent decisions

Collected independently before circulation: audit/tool integrity CONSENT C0/H0; preservation/provenance CONSENT C0/H0; SRS/integration CONSENT C0/H0. Each checked current raw state. Consent covers only exact non-force checkout, actual byte read-back, fresh native controls and supported capture. Physical execution requires independent new-manifest validation, archive and exact nonce cleanup first. No prior evidence relabelling, deadline change or SRS promotion. The temporary observation runner also received independent No findings; its exit code alone does not prove preservation.

## Fresh canonical result

Non-force checkout reached exact6bd484b with clean status and expected149/preserved17 hashes unchanged. Independent fresh native controls collected17:16pass1fail, exit1/signalnull. The hardening fixture path case supplies a hard-coded original checkout root and fails collector-derived workspace equality in W. Native semantics3 pass. Log C:/Users/beom/AppData/Local/Temp/buildergate-native-6bd-canonical-independent.log SHA256 d997d5b7e51d68855d9db08d2e2584ce348674c6842eae3b91dfcf4ceefe5320. Capture and physical execution were not started. Next repair the test's workspace derivation while preserving the production equality guard; repeat independent validation before new capture.
