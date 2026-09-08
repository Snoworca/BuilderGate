# Actor cleanup canonical update

Requirement: N/A operational provenance; related PERF-BGSTAB-011 validation support.

Proposed action: after three independent decisions, non-force switch the clean dedicated checkout to the exact recorded commit. Preserve original user7 and canonical-owned config/data/certs. The149-input archive is prior evidence only: re-hash current inputs and verify target commit changes before reusing it as an inventory, not as new execution evidence. No original config copying. Run fresh helper/wiring/index/settlement controls on target. Before actual second-parent execution, independently verify source cleanup fixes, input149/preserved17 and canonical status. Use only the exact selected parent and no external timeout/abort/watch/forceExit or process signal. The full admission gate and20/21 contract remain unexecuted/unresolved.

## Raw facts

```json
{
  "at": "2026-09-08T09:59:06.275871+00:00",
  "root": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
  "target": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908",
  "head": "150df8022f04ade35a46eb48238892fa3ce63d81",
  "oldTargetHead": "fd876f22bde2e1b77a0c95f532d65e0114a420f3",
  "newTree": "b4e22ee1ea3058214bf96239e4a1f186d4f4b6c2",
  "commonDir": "C:/Work/git/_Snoworca/ProjectMaster/.git",
  "status": "M docs/plan/2026-09-01.remaining-work-backlog.plan.md\n M docs/report/2026-09-08.ack-reservation-progress.md\n M docs/worklog/2026-09-08.jsonl\n M kiwi/.status.json\n?? .codex/config.toml\n?? CLAUDE.local.md\n?? t1_verdict_1.txt\n?? t1_verdict_2.txt\n?? t2_verdict_1.txt\n?? t2_verdict_2.txt\n?? t2_verdict_incomplete_True.txt",
  "targetStatus": "",
  "changes": [
    "A\tdocs/memory/2026-09-08-fixture-canonical-preflight.md",
    "A\tdocs/plan/2026-09-08.fixture-actor-cleanup.md",
    "A\tdocs/plan/2026-09-08.fixture-index-restoration.md",
    "M\tdocs/plan/2026-09-08.fixture-subtest-settlement.md",
    "M\tdocs/plan/2026-09-08.remaining-work-autonomous.plan.md",
    "M\ttools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs",
    "A\ttools/wave3/fixture-actor-cleanup-wiring.test.mjs",
    "A\ttools/wave3/fixture-actor-cleanup.mjs",
    "A\ttools/wave3/fixture-actor-cleanup.test.mjs",
    "A\ttools/wave3/fixture-index-restoration.test.mjs"
  ],
  "newPathCollisions": [],
  "dependencyChanges": [],
  "preserved": [
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
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\agent-command-profiles.json",
      "sha256": "41a0d3098c3f124989320107086a43c530ecbfa5aba40e799abcd5003cdccdde"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\command-presets.json",
      "sha256": "eb3cfb090d56e3dce9e32e2f4a86ecb2901fbbfb3530e6b988ecb5ce7de25b89"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\command-presets.json.bak",
      "sha256": "e3a2cf5fca5a96541c1c1176c50ec00caa74dedace75a2dc860c6ad60663ada6"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\mcp-control-config.json",
      "sha256": "4bf06b880cb31200ced8c70d7d5e9beff35252ad138a8fe44a26e172f8e4d8c0"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\recovery-options.json",
      "sha256": "a2c754083107c6ff98fd5435b4b23f24682386b5b6b149d05b6e9801f3d1673f"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\terminal-shortcuts.json",
      "sha256": "848810d0dd371e538f390e582cef320371e5fe8c370fb6b786f21c8a976f3171"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\data\\terminal-shortcuts.json.bak",
      "sha256": "ca4c24880d09c5ddadb55664a522a0a17c3da487602b4755186d5cd42c3e99e5"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.crt",
      "sha256": "ba6b0071bed007e77b334d4410eb7f4ffb1ac3110509b9a77b1e44ebfac1b5c9"
    },
    {
      "path": "C:\\Work\\git\\_Snoworca\\ProjectMaster-validation-20260908\\server\\certs\\self-signed.key",
      "sha256": "219887ca56c004d561350242e6cd29da749931127e1022b5c30996b82fc438a6"
    }
  ],
  "inputManifest": {
    "path": "C:\\Users\\beom\\AppData\\Local\\Temp\\buildergate-fixture-canonical-manifest.json",
    "sha256": "ea4b3589aa66a47f6c727c8b6916804ee0eac9bbc670218071486a8966a214d0"
  },
  "inputs": [
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/FontSizeToast.tsx",
      "sha256": "8ac5849856d81a714e2d59f039c2e6b522bfebe5f3a463dcbe0ea6e5d943c9dc"
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalContainer.tsx",
      "sha256": "875811cacadb59e3202a7721f08c7a9c3fc1f0bc7cab9b1d88afa7dfc7408da5"
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalRuntimeContext.tsx",
      "sha256": "4c368104cf11e8c44e1dc81cec4073f33db2c9496c53e3bd58c31639d01885df"
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalView.css",
      "sha256": "ac708b3bc8d5e2b0a1e81c3fd4a6e90ef9f926d5037268c87b90ca2906c5acb4"
    },
    {
      "kind": "source",
      "path": "frontend/src/components/Terminal/TerminalView.tsx",
      "sha256": "a91221bc76981d0dc62c1b0b23d4342584757887af0f73d1c5fcdfba3f28ace1"
    },
    {
      "kind": "source",
      "path": "frontend/src/contexts/WebSocketContext.tsx",
      "sha256": "b8dc4b36dd20c2b89ed0bb740a4148731a255e596b3280099f879bbd003b2621"
    },
    {
      "kind": "source",
      "path": "frontend/src/hooks/usePinchZoom.ts",
      "sha256": "3c421a165b8fbcf45b81b29536c38018feaa661e38afcf5765711ce0d2f37757"
    },
    {
      "kind": "source",
      "path": "frontend/src/hooks/useResponsive.ts",
      "sha256": "cc9f04aba12f03eaf46acd63dacd7e6adb87e041e8441f820a91650c059299ba"
    },
    {
      "kind": "source",
      "path": "frontend/src/services/api.ts",
      "sha256": "c2e4a70705d3cbc39561cfba3bcf4ad4c72b84b35052a2528b3047183771354c"
    },
    {
      "kind": "source",
      "path": "frontend/src/services/apiError.ts",
      "sha256": "89478e5eb18637b29667808d827d89c066992bf035ef7109b0e2c1e75f1590ee"
    },
    {
      "kind": "source",
      "path": "frontend/src/services/tokenStorage.ts",
      "sha256": "cded9fb62ddfb171b3ebfce45a1bb9c32ae6967b4df46e62a8c62c36e1be748f"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/commandPreset.ts",
      "sha256": "dff8112b28de9f64131c7896fffb01fd640b9ef880a6bf78c4c43856c6d3285e"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/index.ts",
      "sha256": "a97c75ae467bd3eca5a549e0d75f6cb48b0f20a30b239628a46d0fbcd5a2fab2"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/mcpControl.ts",
      "sha256": "18e3c7702317b6fcd844fad47886590b0d76cc22a8b927ac2d1307497abb0392"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/recoveryOption.ts",
      "sha256": "aa3913fdd3a5e0c0f509193d54e2222e644014081956f363dfcddf2aecd188da"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/settings.ts",
      "sha256": "018d741374af3356cb6ae83faf551b8df92a2635ed77e68700727f4504dc3303"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/terminalShortcut.ts",
      "sha256": "036e30c301b9df172fddb50caf204691e1ce0aa24521f2f019e3307bf7b06125"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/workspace.ts",
      "sha256": "0f5e25616afa067959e95ccc2f90a73066d4033e51b004b70325050e8c0a2005"
    },
    {
      "kind": "source",
      "path": "frontend/src/types/ws-protocol.ts",
      "sha256": "0ab0d3a165fc9b9b37b0f9be5943ede38117424c204300ff7caf1a9879fd213b"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/binaryFrameCodec.ts",
      "sha256": "78a01ec6fdf29434f2f9448c6437cce40c21c202842b06dac4dac35c6a22a15f"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/binaryFrameIntake.ts",
      "sha256": "9262d51028b5c4bea7970f81339e7a2b55eb5899e7ffd9fc4beab8f43ca52e3b"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/imeTransaction.ts",
      "sha256": "1dcb72e9024be10f6c57ef0fa6932837eac6319f72d52ae86bb678971a7c8611"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/inputReliabilityMode.ts",
      "sha256": "587f007c8cece2be44446eb02513b14c16b4cd4614632927d22abf8e27f142ad"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/liveOutputTokens.ts",
      "sha256": "50097ec94d1f051337f058d2d9f79d78ae5ea973fc692cc4726452e193774245"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/sessionCloseClassification.ts",
      "sha256": "35ba20128eed597ae613e0f87c5876052bd2477eac8a0a92a60b4e2e879399ed"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalBinaryNegotiationClient.ts",
      "sha256": "37ad4a2e1a92eba0941291af6c5c2872c12c4a86f9b60e17718a0f5702e13c79"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalChannelRegistry.ts",
      "sha256": "9cf6fe4be26512b2104ae4647bcdb407cef3e4dd67a9e06ffafb03684025fc9b"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalCheckpointRuntime.ts",
      "sha256": "23c6fe4a10d17071ed19085935c51450ec8b3aea3578fb28c2d10ecc8ebe9227"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalClipboardCoordinator.ts",
      "sha256": "1b191401c1bce6e46decf4aaea2eef432f156d723f43152dccdc98242c8fdf0a"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalDebugCapture.ts",
      "sha256": "499a21cb250e74562c0e4e318729f5dc371005414ecd80d405c20848cf138ae7"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalHiddenOutput.ts",
      "sha256": "494402a0efced1a5bda48cd6ab36126c58be0e62f32798a1cdd88c5cc3d275ec"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalInputSequencer.ts",
      "sha256": "3231be45ab59366ab471565cf6851748741c701f1ee6dff1344974ab766f3589"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalOutputDelivery.ts",
      "sha256": "ed4646386e57f4ffe5b5bb706e5ecdfd33ab8a9933c687d4a26af0828ebf72a8"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalOutputHotPath.ts",
      "sha256": "76738388df0731eeff1dda394bef945d93fe4e0ac5b4a4c467dccaf45561b46a"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalOutputScheduler.ts",
      "sha256": "13db348f2c98618f7b8246754c8fa6ac4def493e2a7d43c461fcea58b614df40"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalQueryReply.ts",
      "sha256": "77375496b5ec7f0998c8fb1663fdd44e3a0720f1b3db0b1125fae92014e9b2e6"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalRawMutationAdapter.ts",
      "sha256": "ebace0848b1962f9e20abd6d1611a1766ded098ac0c311ea2bae38074476d4b2"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalReplayGuard.ts",
      "sha256": "4b20b0d2106e18017e81350edc58dc64588b249a90e5ca48538270011e0493e2"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalRetainedState.ts",
      "sha256": "1f2d3739fe18d20dc53cc231eabad9d021651d40aeb34a72b1083404ce4bebfc"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalShortcutBindings.ts",
      "sha256": "b5ea932ebf9de6a1c7f9030e7621f5e4378f4e15c06d57b6c223e46336e48a32"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalSnapshot.ts",
      "sha256": "e28e0f6634dac5db52ce492099dac03ae5f482833f6d01667ffe3c40d44a1ffc"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalStaleKeyRepeat.ts",
      "sha256": "480a0337113367f22e44abf295c35956cdd367e18defc4ee2fc052a1a5640ddd"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalTransportQueueDecision.ts",
      "sha256": "9ebb15d0b9ba76487e041888bd5d51c71ad5377c75670e10d9aa9f7949dfb859"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalViewAttributes.ts",
      "sha256": "d4511b4b187097a5aaf383298ba7948ac39c5df26955611123aa9072e0b84147"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalWriteCoordinator.ts",
      "sha256": "b0d334d9d2dbb406d169fb83c93d18c3cd6f5fbe295ee968768036f40bbe4a1f"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/terminalWriteCoordinatorRuntime.ts",
      "sha256": "f4ea3f2dc67f02a0a47d4bc43b8552843d81f4cf8910c702990309c59e2f9952"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/visibleOutputRecovery.ts",
      "sha256": "b19b3c2215089785260e1cc8a835bc66101161fd2fd999ca3db308ed282b2ffd"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/webSocketBackpressure.ts",
      "sha256": "5551d8def447eb8e3573685d6fe055739c80c7efc1509d0b50531bbdff4e8ba8"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/webSocketUrl.ts",
      "sha256": "9fb24fd4d92453d0a6ac90ed29c8410a11be6c107c75ffe9dcb96e0a2c1dfa37"
    },
    {
      "kind": "source",
      "path": "frontend/src/utils/wsFrameDispatch.ts",
      "sha256": "a89197b391df0e7ade3e51497628d9c17cf6659acc8d6f6d6d222d1acf41089f"
    },
    {
      "kind": "source",
      "path": "frontend/tests/e2e/helpers.ts",
      "sha256": "4060d593d4d3738873c8f5cd74da32ffc887056491ea78d796542db28257325f"
    },
    {
      "kind": "source",
      "path": "frontend/tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts",
      "sha256": "ddf64f62eaf29cf2c8fb65c79664242f067e981a419dd0aeeac1f825b5108d27"
    },
    {
      "kind": "source",
      "path": "frontend/tests/helpers/visibleOutputRecoveryContract.ts",
      "sha256": "93269dfcdb91de7f8530a7751c2cd67c9445324341dc7e17e17b3eea52159b60"
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/perfBgstab010Ac9IsolatedE2EContract.test.ts",
      "sha256": "35510371e3a2e98f268c1c20585081d1835e19d15343f252e9196849bfc87e06"
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/terminalContainerRecoveryContract.test.ts",
      "sha256": "1fdf39884da7a5fe29a0aa994a6c67ebddfd790d73a7514ef954073293757196"
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/terminalDebugCapture.test.ts",
      "sha256": "6d4a6d7115801537be7d97c301ccbc813541b8e6959f2562f3333515de024113"
    },
    {
      "kind": "source",
      "path": "frontend/tests/unit/webSocketBackpressure.test.ts",
      "sha256": "9d1ba339d79914a8b69f70a70ea1405bc8791cc68b7f9fede58746631594b321"
    },
    {
      "kind": "source",
      "path": "server/src/benchmarks/fairSchedulerAuthorityLocator.ts",
      "sha256": "f8672347e293926b3291ef35238cc5b2da29ec76f30475e8110ed97ad30071ad"
    },
    {
      "kind": "source",
      "path": "server/src/benchmarks/terminalFairnessCharacterization.ts",
      "sha256": "99dc6d06a1d498db5b31bfc7ab013916f05f9cc541da7eaf5642ae34d4bda341"
    },
    {
      "kind": "source",
      "path": "server/src/schemas/config.schema.ts",
      "sha256": "49063e28ec9a61767db2fcc871cc08b6e813f5b1aeadd31e7003a553e63f7f0f"
    },
    {
      "kind": "source",
      "path": "server/src/services/AuthService.ts",
      "sha256": "139539f6d5172b5df8136c597bcd92b6b01bb1c1a869fe441744cb38562f11f2"
    },
    {
      "kind": "source",
      "path": "server/src/services/ConfigFileRepository.ts",
      "sha256": "cd4bb0c05d9ccff5a7ed9947bf98b6ed96c2b1a8521cfc026feddebe1aa5ee53"
    },
    {
      "kind": "source",
      "path": "server/src/services/CryptoService.ts",
      "sha256": "f52aa4205f7d6c26e8a9a6fcf803bafd04294df778f2d91f06bf155f1af165ef"
    },
    {
      "kind": "source",
      "path": "server/src/services/ForegroundAppDetector.ts",
      "sha256": "c4cf05169859b1e3903715716365daa4442e4d30336faae8e07b34bf0ee28eed"
    },
    {
      "kind": "source",
      "path": "server/src/services/HermesForegroundDetector.ts",
      "sha256": "e3ffdd3f1c62fc9150d326306d5f9370687c0630511b811576a9590d8fd4c3b7"
    },
    {
      "kind": "source",
      "path": "server/src/services/McpSecurityContract.ts",
      "sha256": "f07f81694fb7709c7be6bd4e56fe325a0f35828bd609159f4cd09c1e6197959d"
    },
    {
      "kind": "source",
      "path": "server/src/services/OscDetector.ts",
      "sha256": "142c33655b3fac5b4bf0dd0280e8f5088237cb955444debf2662365ce4adb8f4"
    },
    {
      "kind": "source",
      "path": "server/src/services/RuntimeConfigStore.ts",
      "sha256": "8d766bdbe1e3e4c72c3f582f3ab9234aa9371280a4bc978307635f1d553d6e48"
    },
    {
      "kind": "source",
      "path": "server/src/services/SessionInputGateway.ts",
      "sha256": "02445c4a717d14a9c04c0ad10575b4e7d7667fa1d7a781d41356f67bf4887a50"
    },
    {
      "kind": "source",
      "path": "server/src/services/SessionManager.ts",
      "sha256": "c1d53a7aa160c042ee4a0b04d2a1b31929eae03f5ea13aa9776f1a3c39422fc1"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalAuthorityController.ts",
      "sha256": "b2529bf9a67d286efa964bd0c09042fea7513dcf6cc6830a42fb3055882faa84"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicy.test.ts",
      "sha256": "b8b5fb12913d839bd35868384d15c110d0e08a8f6f5d6afee7b661704e7050ac"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicy.ts",
      "sha256": "110ce608ab9a0f73347f0d164960142a104169e9177dd9160302080a1851d425"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyCanary.test.ts",
      "sha256": "8f225430cebf5d76c10322d6ecfebd4c79be1fd76c1e6374831be0439ecfae04"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyCanary.ts",
      "sha256": "f8d79247bf47b03a5f9613134cea7b5c9516caccdea41b694c55e3870767a2f1"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyInventory.ts",
      "sha256": "e472f6c4ba52ef9084aa26a71c8364dcba2b4fbbc003028fcbaf5c8161e4b467"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyObservations.ts",
      "sha256": "e28700007cb438be48a7f12362974ab84d3c2a04aec2823c3ba74ed3cfcd5fe2"
    },
    {
      "kind": "source",
      "path": "server/src/services/TerminalResourcePolicyRuntime.ts",
      "sha256": "48425c4da95efd05eebaecd85c08691bb558b0398d5d54a4fd1efe8ffb581edb"
    },
    {
      "kind": "source",
      "path": "server/src/types/auth.types.ts",
      "sha256": "44a44d4c87cf758c884c3bab5ce647417ce1065b139e813ee8bc54a7d5d58355"
    },
    {
      "kind": "source",
      "path": "server/src/types/config.types.ts",
      "sha256": "8d23f319ee07ebd70e7ddd633b9538ce2f3d8a662effe164664e53d3e2e26a26"
    },
    {
      "kind": "source",
      "path": "server/src/types/file.types.ts",
      "sha256": "6a1fea9ba0544f5f165bfe7aab9d384e08230f467c48ef96e0415f6af52bfb45"
    },
    {
      "kind": "source",
      "path": "server/src/types/index.ts",
      "sha256": "1e0dcf85d991f7b770b52f9ea92e78c75b08fbefcc16d3ec71bf249adb0dd461"
    },
    {
      "kind": "source",
      "path": "server/src/types/settings.types.ts",
      "sha256": "5e8312d13835f3d585b9eed5889145d95b6c8830f6de69506c387d688c1fb1ad"
    },
    {
      "kind": "source",
      "path": "server/src/types/ws-protocol.ts",
      "sha256": "0f9337d2a287a09c401b4a44c5a1e2325f645cc5246b827e183736aa190a3ebb"
    },
    {
      "kind": "source",
      "path": "server/src/utils/boundedByteDeque.ts",
      "sha256": "2061918c1830d06dfa90bdf4ef7e3a162bd09dcb80e181ca8428fd4f072cc8d1"
    },
    {
      "kind": "source",
      "path": "server/src/utils/config.ts",
      "sha256": "5b50505c5093188c8f612d906fa3a310f24fefe6b6e0ca4879a70ed6c3770e61"
    },
    {
      "kind": "source",
      "path": "server/src/utils/configStrictLoader.ts",
      "sha256": "87abf4cff18440392856720c7b834f743a9f4d49f3f727da0e05da10e6eda379"
    },
    {
      "kind": "source",
      "path": "server/src/utils/configTemplate.ts",
      "sha256": "5e0ca1e52fe5e5594e32b44dc21d05a3fdc63740f7f1303717960bd24976be35"
    },
    {
      "kind": "source",
      "path": "server/src/utils/constants.ts",
      "sha256": "8579012f3f24e83dae7d5b31525d2da724948350fb4266050626b9152f0a4d7f"
    },
    {
      "kind": "source",
      "path": "server/src/utils/errors.ts",
      "sha256": "f769560cf53bee93439ea03d523de8d1cc159c84587be205bd70045ae35aaedc"
    },
    {
      "kind": "source",
      "path": "server/src/utils/headlessOutputQueue.ts",
      "sha256": "be190bd28ff2dca559a05f7c7c68e1c15399a4656de3b145e95d6fb4cf7776ef"
    },
    {
      "kind": "source",
      "path": "server/src/utils/headlessTerminal.ts",
      "sha256": "873dd9f04f678b644e4bff8631af7fdf3a77b7e1ef3545be1b94fcfa24b5c637"
    },
    {
      "kind": "source",
      "path": "server/src/utils/inputDebugMetadata.ts",
      "sha256": "fd885a33b443abb8f63ffb0fc3ff7ea9b119f3ac76a68b5d4a7e31e4775e2cd6"
    },
    {
      "kind": "source",
      "path": "server/src/utils/inputReliabilityMode.ts",
      "sha256": "31fb73ab70a2d0d6f5edd165a19c546853b98436572cf86bc508a6f7dfa51623"
    },
    {
      "kind": "source",
      "path": "server/src/utils/processTreeTerminator.ts",
      "sha256": "1f2f5e09926e02ba549af4cb60f8ebc8cda6216642f992a15bf2420463a0e27c"
    },
    {
      "kind": "source",
      "path": "server/src/utils/ptyPlatformPolicy.ts",
      "sha256": "a616cffdfd3536e36cc5aa78cd3e2c6b4db85c28ae7f697470a4cdd3a1aabb4d"
    },
    {
      "kind": "source",
      "path": "server/src/utils/recoveryCommand.ts",
      "sha256": "c5ba9080f6dbd2d6c85c2707c7c8ab833c557209f03566c00f238aac57404739"
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalPartialEscapeTail.ts",
      "sha256": "e977b1f1a0636f2b5f1c08bbcddfb7b4401de20e27357e95bbe68efca974936b"
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalPayload.ts",
      "sha256": "9a12384dd4d1fccd45ea5c877f67580ce25cbb2db91375052067c8f28a2e1705"
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalQueryResponder.ts",
      "sha256": "4cdabf44879ef8e01a6c190d70a6f3e62d6adfe1d48eef3213a2971ac2ec36cf"
    },
    {
      "kind": "source",
      "path": "server/src/utils/terminalTitle.ts",
      "sha256": "5bf92c10d2c69b17ecfd1cbae130fd083ed3d66e3b9a6ffe2b479a9aa3bb3e11"
    },
    {
      "kind": "source",
      "path": "server/src/ws/FairTerminalDeliveryScheduler.test.ts",
      "sha256": "786ab1a9e849ba88cb1dd976b081ddedccf95add0f2bb476a6ff6b55251d5863"
    },
    {
      "kind": "source",
      "path": "server/src/ws/WsRouter.ts",
      "sha256": "e2ae4af70060376e8083078d435dac7248f5aa45f53146eff83811f1123c46ae"
    },
    {
      "kind": "source",
      "path": "server/src/ws/WsRouterSendPriority.test.ts",
      "sha256": "d0355b94974a7e6fdcda9093d251c9c3197166c72566177d3fa34f736dcad019"
    },
    {
      "kind": "source",
      "path": "server/src/ws/binaryFrameCodec.ts",
      "sha256": "d2d28f6e190a82fc9c4944a857978e6c850618233577591e473a0f7872ab6c6c"
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalBinaryGroupSession.ts",
      "sha256": "b53aca3967b4a7928dc28f71bed5e3a6900bfbaa7952ce25b35280219cf4e11a"
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalBinaryNegotiation.ts",
      "sha256": "e27205a895e5cc336fa208a40d343906774f061b2814fd8fa3fd89f86759df72"
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalChannelAllocator.ts",
      "sha256": "cb9be6a63afcd91a1ec9c6a0dd154897321ed1c21e7a6d26516c092a5d15ca2a"
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalStreamEpoch.ts",
      "sha256": "5746acc8739574606553ea40afdfa754a84a1565365b55665f5e620bf39f953a"
    },
    {
      "kind": "source",
      "path": "server/src/ws/terminalWireFormat.ts",
      "sha256": "d65065ed7a1fc7a9031b88f958d35db14b22c9fc3f4970ba948f874cd5fbfe3f"
    },
    {
      "kind": "source",
      "path": "server/src/ws/wirePayload.ts",
      "sha256": "68261b994ecfa57762a417b58ba81d0e33a42f0d34f399bf4f856b259d391c1c"
    },
    {
      "kind": "source",
      "path": "server/src/ws/wsSendPolicy.ts",
      "sha256": "d8161ec40992dfaabc0285fa39d29299b933133931e5be05197eefa7fc258939"
    },
    {
      "kind": "source",
      "path": "server/src/ws/wsSendPolicyRestoreMetadata.test.ts",
      "sha256": "4670ed60715f827aa9c6e6d90371dacedc17d7c1a51f9083e4bcba681f9419cc"
    },
    {
      "kind": "source",
      "path": "server/src/ws/wsTransportMode.ts",
      "sha256": "737db8d84ef8f445d5deb1843885684d7136eff654c5482cc272d7f57d3da103"
    },
    {
      "kind": "source",
      "path": "tools/wave3/fair-scheduler-decision.test.mjs",
      "sha256": "e4dc5c195bc13aa2e15bbec7ba6c90dd425727f5af59e0bfbfa4d6f9d88997c6"
    },
    {
      "kind": "source",
      "path": "tools/wave3/internal/fair-readmission-closure-v3-internal-core.mjs",
      "sha256": "19525f372d51167c3ae4ea090721e1b8edb3dcbc6fda994ca975b86426fcebe0"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json",
      "sha256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json.publication.json",
      "sha256": "5033ce755efc1c9b4d291621bc725520dec0cba305fe2ff212c8d20a170c8cf3"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json.raw.json",
      "sha256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-decision.json",
      "sha256": "724f7fea3ff919b9480a050d5398919950d4dd329e524f65b19c0f1accd5970c"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-decision.raw.json",
      "sha256": "c59e4dd5d523effa57e4f1a0a1b8cf46cec43af7f53fc01064770f31f11ab735"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-0.json",
      "sha256": "91842e2bc17c77d2d1144f21fb80587248fbae54786b7d6cabac34f01958e9ab"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-1.json",
      "sha256": "65b262ff95367d81f244d6873f83cb55028dc334ba7c0a0a27208d2cf2c12e2d"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-2.json",
      "sha256": "7c122181385a050e2f800d784314d18bc49b69a1b9ea3f776c750ed1cba9a9ab"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-3.json",
      "sha256": "62e2743a1a93438a08d8f7807c39c7aaced78eb691f3e3b4de7e635dc3d7be77"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-1/trial-4.json",
      "sha256": "280fa7e2eb96522404a291f31378bfcb848d8a4e5d151400d6ac5e6c9fd9b353"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-0.json",
      "sha256": "65b73ebe2dfa8503706eb0d61bf0d60bb79f73b5ea03d7c79f52c218c03aa1a2"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-1.json",
      "sha256": "dc4ba1f92764dd3791d36aa0641aeabde7aafb56b337a0a5010d4f828c4dd8b9"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-2.json",
      "sha256": "6e05c18bc8e914d8bb8981493b4f19779cb60883548507c71d02376c0661fba3"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-3.json",
      "sha256": "195185785181d57ab84c4343ed6fb819bad2076ea4c1b8e402f5a126c7d35dac"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-2/trial-4.json",
      "sha256": "8791685e61d39e97155d98a7f0132288d228b6e5ca98ac6a177900c0aa883bf0"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-0.json",
      "sha256": "6d9cc261c55f03a95daa967b7e7f9b57e5fef920a8af690bf442a90cfdc873c7"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-1.json",
      "sha256": "b052a6509827423038cf452383212433dcba0dd36b1480cfe67166fd2ca1161c"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-2.json",
      "sha256": "5d8b3adc455fdcab34344a9cd614b5fb990043182901ff8cf42799b08ecdfd62"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-3.json",
      "sha256": "b909787ab77bb91a5df58f5f3736233f32e26b0d85214537b6ccce5a7978e3a0"
    },
    {
      "kind": "fixture",
      "path": "docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-publications/c3e50f1caf1a9e0da72c819e4e80b77bc04a7a58cdfdadd84d03ecf4a330883e/fair-scheduler-runs/c7b44d3af478b67816de007d16d3076bcbad17c1835bf65ee46b3037c0174abe/clients-8/trial-4.json",
      "sha256": "e48a4ba536cb97798c46ca70b609eafb41106e478ac911a593e2fe8a736a473f"
    },
    {
      "kind": "config_lock",
      "path": "frontend/package-lock.json",
      "sha256": "41b63b94b65ee1f501f7008a3198e02dbcf775c41399c73feae3ac795d0913ab"
    },
    {
      "kind": "config_lock",
      "path": "frontend/package.json",
      "sha256": "e0e65ab4f55e6e62e133c22493bf5df6cf1486d5c792e81d6b71fecdb6ccaabc"
    },
    {
      "kind": "config_lock",
      "path": "frontend/playwright.config.ts",
      "sha256": "b4bba5c168d8975ef8940bacb3abee6299f428fd949fa7823e2a607be19ff39d"
    },
    {
      "kind": "config_lock",
      "path": "frontend/pnpm-lock.yaml",
      "sha256": "dc0a943caa8d8b463470cc81418a14a0901d27476927ea1b155a370df8ea3c73"
    },
    {
      "kind": "config_lock",
      "path": "frontend/tsconfig.app.json",
      "sha256": "185c585aa92b2cbe0df1918e999d9a6bc4fec6762a6d80de7d2d155d56369aed"
    },
    {
      "kind": "config_lock",
      "path": "frontend/tsconfig.json",
      "sha256": "ad28d132ee48d6e23917cf5827cace785d0fc01a44ca68b0dda51cc8c3fd3f52"
    },
    {
      "kind": "config_lock",
      "path": "frontend/tsconfig.node.json",
      "sha256": "a6d49d645590cac21c235a0548605d867321b2e1750e99176d2153d702dfa842"
    },
    {
      "kind": "config_lock",
      "path": "frontend/vite.config.ts",
      "sha256": "493c33475bf32ee67e0e97e681b5c5ddb893440093bb9922ae2eb3b185f7b4a4"
    },
    {
      "kind": "config_lock",
      "path": "server/config.json5",
      "sha256": "ecbd8ad8d6a086b642188008239c6cde317be5ce9ea62d4d14d0d0b637a8b36b"
    },
    {
      "kind": "config_lock",
      "path": "server/package-lock.json",
      "sha256": "463ad51dd7102ce9fc97da73e90226f8581e8cc521c90c8de32085dbcdeb594a"
    },
    {
      "kind": "config_lock",
      "path": "server/package.json",
      "sha256": "9c0d9dec2f86ee85709b7865ff46899ebadca5f48b9aef0a9f3a124ca7961200"
    },
    {
      "kind": "config_lock",
      "path": "server/tsconfig.json",
      "sha256": "0390c1de164283f9fb55956b0fc2d207609c107422e123014411f78f66ccb336"
    },
    {
      "path": "tools/wave3/fair-readmission-closure-v3.mjs",
      "sha256": "dc78fb2d980f72e11322ebc8514286673f591b85ebe7544fdc0424c64c27816e"
    }
  ],
  "inputChanges": [],
  "currentInputMismatches": [],
  "workflow": {
    "workspace": "C:\\Work\\git\\_Snoworca\\ProjectMaster",
    "mode": "sdd",
    "target": "wave-5",
    "run": null,
    "task": null,
    "event": null,
    "idempotency": null
  }
}
```

## Decisions

All three decisions were collected independently before circulation:

- Audit: CONSENT, Critical0/High0. Packet/Git/preserved17/input149 hashes match; old archive is inventory only.
- Preservation: CONSENT, Critical0/High0. Clean target, dependency/input changes0 and new-path collisions0 verified.
- SRS/integration: CONSENT, Critical0/High0. PERF011 evolving permits the bounded test-only update; no SRS or full-gate promotion.

Proceed only with the exact non-forced switch and fresh canonical controls/input read-back. A separate current cleanup/source review is required before second-parent execution. No original-user config copying or process signals are permitted.

## Follow-through on 2026-09-09

Canonical switched non-forced to150df8022f04ade35a46eb48238892fa3ce63d81 and remained clean with input149/preserved17 unchanged. Fresh canonical helper/wiring/index/settlement controls passed29/29, exit0; log `C:/Users/beom/AppData/Local/Temp/buildergate-actor-canonical-independent-20260909.log`, SHA256 `2b49082f56106133738c0a7258b996e2257bec6410e893742f087cccbe5e0bf3`. Independent source review found the two prior cleanup/index High issues resolved in the canonical code and allowed the selected second parent under the no-external-timeout/no-signal conditions.

The selected second parent then ran but failed its existing115000ms timeout. It naturally exited after131082ms with7pass/2cancelled, exit1, signalnull. Input149/preserved17 remained unchanged; canonical was clean and the runner was absent. Current protected ports2001/2002 belonged to PID12992, not the historical44944; its executable/command/creation identity matched the fresh start record. Ports2221/2222 stayed empty. See [the failure report](../report/2026-09-09.physical-race-timing.md). This result does not establish admission success or completion of the cancelled child.
