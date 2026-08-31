# T-PH003-01 strict-TDD recovery attribution

Requirement: `REL-BGSTAB-007` (stable)  
Task: `T-PH003-01` — RED only

This record is a surgical ownership map for the strict-TDD recovery. It records
only the implementation consequences removed to restore a pre-GREEN baseline;
test files remain unchanged.

| Exact contract | Attributed production symbol / resolved range | RED removal reason | Explicitly excluded adjacent dirty scope |
| --- | --- | --- | --- |
| AC-2 configured retention before delivery | `server/src/services/TerminalAuthorityProductionAdapter.ts` — `enqueueFreshAuthoritativeRecovery`, commit `onSettled` proof callback (current ~1982–2024); `SessionManager.recordTerminalAuthorityServerCheckpointDelivery` remains defined | Remove only the physical commit → manager delivery-proof write and rejection branch. Active local checkpoint bookkeeping stays, so the test reaches the proof projection and fails because server recovery was not proven. | `SessionManager.initializeHeadlessState` (~7461), `commitRetainedTerminalOutput` (~7818), policy resolution, `buildRetainedTerminalAuthorityState` except its existing projection, TerminalView/Container and AC-1 resolver. |
| AC-8 generic screen repair | `frontend/src/utils/visibleOutputRecovery.ts` — `finishCurrentView` (~1269–1288) ready/non-equivalence release assignments | Remove only the successful readiness/state-release consequences after physical write, repair ACK, and server-ready latch so the unchanged contract fails on missing readiness. | Coordinator setup, `begin`, ACK/latch barriers, held-output cleanup mechanics, `TerminalContainer`, `TerminalView`, and all bridge APIs already deliberately removed. |
| AC-4/AC-5 Ordinal64 apply/drain | `server/src/services/TerminalAuthorityProductionAdapter.ts` — active checkpoint `apply-ack` / `drain-ack` physical-drain writes (~3625–3655 and ~3714–3736) | Remove only the physical drain settlement evidence. Protocol parsing and invalid-ACK rejection stay active; the contract fails when canonical ACKs cannot settle the held tail. | Stream rollover foundation in `SessionManager`/`TerminalAuthorityController`, checkpoint construction/ready flow, parser validation, and compatibility identity checks. |
| AC-9/AC-12 lease/rollback | `server/src/services/TerminalAuthorityProductionAdapter.ts` — `terminal-authority:compatibility-drained` adapter-to-controller settlement branch (~3820–3845) | Remove only the post-checkpoint compatibility-drain forwarding needed to complete the selected driver lease handoff; rollback setup and checkpoint delivery remain observable. | Promotion parity gates, `TerminalAuthorityController.beginRollback` and `acknowledgeCompatibilityDrain` foundations, `SessionManager` lease ports/projection, and unrelated UI/runtime code. |

The reversible removal patch is `T-PH003-01-attributed-production.removal.patch` in this directory. It contains only the hunks listed above, in pre-removal form. No historical 2026-07-16 or 2026-07-26 analysis artifact is used by this recovery.
