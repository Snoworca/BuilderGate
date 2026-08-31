# T-PH003-02 scoped attribution record

**Requirement:** `REL-BGSTAB-007`  
**Task:** `T-PH003-02`  
**Recorded:** 2026-07-30  
**Purpose:** provide a narrow, independently checkable scope map before the
next formal review. This is a provenance record, not a claim that every
current dirty-worktree line was authored by this task.

## Evidence and interpretation rules

- The task runtime record at
  `.kiwi/sessions/2026-07-28.pm.wave3-completion/tasks/T-PH003-02.json`
  records the Phase 1 test work and the bounded Phase 2 restoration anchors
  below. This record claims neither original authorship nor ownership of an
  entire current file or dirty-worktree delta.
- [T-PH003-01-attributed-production.removal.patch](T-PH003-01-attributed-production.removal.patch)
  is a historical semantic preservation map only. Its invalid `@@` placeholders
  do not form applicable unified-diff hunk headers, so it is not mechanical
  patch-application evidence and must not be used for `git apply`.
- [T-PH003-02-restoration.red-to-green.patch](T-PH003-02-restoration.red-to-green.patch)
  is the narrow mechanical red-to-green reproduction evidence for the four
  production anchors in this matrix. Against the current green tree,
  `git apply --reverse --check --verbose docs/analysis/kiwi-coder-2026-07-28.pm.wave3-completion/T-PH003-02-restoration.red-to-green.patch`
  exited `0`. The check was reverse-only: it did not apply the patch or modify
  source, tests, SRS, PM state, or lifecycle state. Neither artifact transfers
  ownership of an entire current file or of an untracked file to T-PH003-02.
- “Recorded test hunk” means the T-PH003-02 Phase 1 draft log names that test
  edit. “Acceptance anchor” means the test is within this task's four-contract
  gate but the task record does not claim a local edit to it.
- Current line numbers are rereview anchors, not baseline diff ranges. A
  reviewer should re-search the named test or symbol if another concurrent
  edit moves a line.

## Scoped-hunk matrix

| Contract | Current test anchor | T-PH003-02 attribution | Allowed production anchor and patch evidence | Limit |
|---|---|---|---|---|
| AC-2 | `server/src/services/TerminalAuthorityController.test.ts:10868-11021` — `REL-BGSTAB-007 applies configured retained policy before delivery` | Acceptance anchor only; no Phase 1 local test hunk is recorded. | **Bounded Phase 2 restoration anchor:** `TerminalAuthorityProductionAdapter.ts:1974-2018` (`onSettled`, delivery proof at `:1982`). `SessionManager.ts:2499` is a referenced callee, not a claimed change. The historical T-PH003-01 file is a semantic map; the new reproduction patch supplies the reverse-checkable hunk. | Do not attribute the rest of either server file to this task. |
| AC-8 | `frontend/tests/unit/terminalContainerRecoveryContract.test.ts:389-478` — recovery readiness ordering fixture and assertions | **Recorded test hunk:** Phase 1 iterations 1-3. It covers physical `onWritten`, generic repair acknowledgement, server-ready latch, and the final non-checkpoint assertion. | **Bounded Phase 2 restoration anchor:** the ready-state reset sub-hunk in `visibleOutputRecovery.ts:1273-1280` (`finishCurrentView`). The historical T-PH003-01 file is a semantic map; the new reproduction patch supplies the reverse-checkable hunk. | The surrounding REL-BGSTAB-009 recovery function remains excluded. |
| AC-4 / AC-5 | `server/src/services/TerminalAuthorityController.test.ts:11435-11722`; the maximum legal Ordinal64 transaction is `:11437-11531` | **Recorded test hunk:** Phase 1 iteration 4 is limited to the maximum legal apply/drain transaction before the pre-existing rollover and max-plus-one coverage. | **Bounded Phase 2 restoration anchors:** `TerminalAuthorityProductionAdapter.ts:3587-3653` (apply ACK and physical-drain ledger) and `:3657-3733` (drain ACK counterpart). The historical T-PH003-01 file is a semantic map; the new reproduction patch supplies the reverse-checkable hunks. | Do not attribute other adapter or controller hunks to this task. |
| AC-9 / AC-12 | `server/src/services/TerminalAuthorityController.test.ts:11724-11950` — retained-stream rollback/recovery contract, ending before `activateRealAdapterCheckpoint` | Acceptance anchor only; no Phase 1 local test hunk is recorded. | **Bounded Phase 2 restoration anchor:** `TerminalAuthorityProductionAdapter.ts:3820-3850`, especially `acknowledgeCompatibilityDrain` at `:3821`. The historical T-PH003-01 file is a semantic map; the new reproduction patch supplies the reverse-checkable hunk. | Do not attribute the complete compatibility router, controller, or untracked adapter file to this task. |
| Test stability | `server/src/services/TerminalAuthorityController.test.ts:846-870` — `promoteProductionViews` | **Recorded Phase 2 test-only hunk:** call the existing settlement primitive, boundedly observe `retainedStateParity`, and fail with the snapshot; `retained-state-parity-mismatch` is never retried as promotion success. | `SessionManager.ts:5146` (`settleTerminalAuthorityPromotionEvidence`) and `:2769` (`readTerminalAuthorityPromotionParitySnapshot`) are existing referenced primitives, not claimed production changes. | This hunk guards only successful integration promotion setup; it neither changes production behavior nor widens REL-BGSTAB-007 completion claims. |

## Explicit exclusions

- **Adjacent `REL-BGSTAB-009` recovery hunks are excluded.** In particular,
  `frontend/src/utils/visibleOutputRecovery.ts:906`
  (`createTerminalContainerRestoreAdapter`) and all of `finishCurrentView`
  outside its exact `:1273-1280` AC-8 ready-state reset remain outside this
  task. The named reset is a bounded restoration anchor, not ownership of the
  surrounding recovery function.
- **Adjacent `MIG-BGSTAB-002` hunk(s) are excluded.** This includes the
  `MIG-BGSTAB-002` source/identity cases in
  `frontend/tests/unit/terminalContainerRecoveryContract.test.ts` outside the
  scoped AC-8 range (including the case beginning at `:90`), plus every other
  recovery-contract test outside `:389-478`.
- All other hunks in `visibleOutputRecovery.ts`,
  `terminalContainerRecoveryContract.test.ts`,
  `TerminalAuthorityController.test.ts`,
  `TerminalAuthorityProductionAdapter.ts`, and `SessionManager.ts` are
  excluded unless they are an exact matrix anchor above. This is especially
  important because the worktree contains broad pre-existing tracked changes
  and untracked server files.
- This record does not claim ownership for any file merely because it is
  untracked, modified, mentioned by a test, or appears in an import graph.

## Rereview procedure

1. Reconfirm the four named test anchors and the three recorded T-PH003-02 test
   hunks against the task record.
2. Treat the T-PH003-01 patch as a non-applicable semantic map, then use only
   the named hunks in the T-PH003-02 red-to-green reproduction patch for a
   mechanical reverse check; treat all other production changes as outside
   this task's scope.
3. Verify the explicit Phase 2 `impl_iters` record against only the matrix
   anchors and their preservation provenance.

This artifact changes neither production behavior nor tests, and it makes no
SRS, sidecar, PM, or worklog update.
