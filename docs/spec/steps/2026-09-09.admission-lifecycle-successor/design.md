# SDS: 2026-09-09.admission-lifecycle-successor

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-09-09.admission-lifecycle-successor |
| Target | wave-5 |
| Status | draft |
| Date | 2026-09-09 |

## 1. Context & Scope

PERF-BGSTAB-010 AC-3 provenance validation support, continuing a wave-3 prerequisite within active wave-5; PERF-BGSTAB-011 AC-7 remains downstream bundle/build validation.
The [predecessor](../2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor/design.md) is merged/agreed and requires21 children; current code has20 after commit2a20b4f073df7d6a9bbf209deaf3cf0a14221183 removed a wrapper.
The [preparation boundary](../../../memory/2026-09-09-admission-successor-boundary.md) permits this draft only. It does not supersede the predecessor or approve execution.
Current full execution is unsafe: outer spawnSync timeout can signal Node; trust/seal perform original-root filesystem writes before collector validation.
The selected physical9/9 is limited evidence, not the full gate or three clean118000ms runs.

## 2. Goals / Non-goals

- Goal: Preserve predecessor SDS-AC-1/2 physical provenance and Worker SSOT while proposing an explicit replacement for SDS-AC-3's suite and process-lifecycle contract.
- Goal: Make every real filesystem fixture canonical-owned and settle all started work before root reuse/deletion.
- Non-goal: Change collector/runtime protocol, evidence structure, native freshness, batch64/8192 bounds,115000ms child limits,118000ms acceptance deadline, or default Node file concurrency.
- Non-goal: Adopt20 by counting the outer gate, select an arbitrary replacement suite, rewrite historical RED/evidence, promote SRS, or authorize original user-file adoption.

## 3. Architecture Decisions

- **Decision (proposed)**: Retain predecessor AC-1/2 unchanged in meaning / basis: sibling fixture provenance and seal-race Worker proofs remain necessary / trade-off: physical adversaries remain costly / rejected: deleting duplicate-looking semantic checks.
- **Decision (proposed)**: Replace only predecessor AC-3's21-child wording with the exact20-file list below / basis: deleted boundary-gate wrapper reran9 existing children / trade-off: retire that wrapper's separate120s and boundary-exclusion policy explicitly / rejected: outer-gate counting or retaining a vacuous wrapper. Its underlying9 and boundary remain in20; coverage correspondence must be reviewed before agreement.
- **Decision (proposed)**: Keep the same Node executable, `['--test', ...fixedClosureTests]` order and default file concurrency; observe118000ms without signalling / basis: user process protection / trade-off: an overdue process may finish later and still fails / rejected: timeout relaxation, early success, forced termination or serializing files.
- **Decision (proposed)**: Derive real fixture roots from module location and validate owned paths before writes / basis: canonical isolation / trade-off: audit each actual I/O path / rejected: blanket string replacement in fake-filesystem fixtures or fallback to main checkout.
- **Decision (proposed)**: Preserve shared analysis parent until all owning activities settle; remove only proven owned leaves unless exclusive parent ownership is established / basis: default-concurrency races / trade-off: explicit ownership evidence / rejected: recursive deletion merely because a directory name matches.

Exact proposed child list, in existing argv order (the outer admission gate is excluded):

```text
tools/wave3/fair-readmission-closure-v3.test.mjs
tools/wave3/fair-readmission-closure-v3.remediation.test.mjs
tools/wave3/fair-readmission-closure-v3.reparse.test.mjs
tools/wave3/fair-readmission-closure-v3.batch.test.mjs
tools/wave3/fair-readmission-closure-v3.hardening.test.mjs
tools/wave3/fair-readmission-closure-v3.strict.test.mjs
tools/wave3/fair-readmission-closure-v3.ingress.test.mjs
tools/wave3/fair-readmission-closure-v3.snapshot.test.mjs
tools/wave3/fair-readmission-closure-v3.wave.test.mjs
tools/wave3/fair-readmission-closure-v3.boundary.test.mjs
tools/wave3/fair-readmission-closure-v3.admission.test.mjs
tools/wave3/fair-readmission-closure-v3.manifest-race.test.mjs
tools/wave3/fair-readmission-closure-v3.trust.test.mjs
tools/wave3/fair-readmission-closure-v3.trust-race.test.mjs
tools/wave3/fair-readmission-closure-v3.seal.test.mjs
tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs
tools/wave3/fair-readmission-closure-v3.lexical.test.mjs
tools/wave3/fair-readmission-closure-v3.lexical-race.test.mjs
tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs
tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs
```

## 4. Interfaces

- Proposed test-only `observeProcessUntilClose(executable, args, { cwd, env, deadlineMs, onDeadline }) -> Promise<{ code, signal, elapsedMs, deadlineExceeded, stdout, stderr, spawnError, observationErrors }>` — preserve errors and wait for natural close plus output completion, including when deadline notification fails.
- Existing `runSettledSubtest(context, name, options, body)` and `settleActorCleanup(entries, release, priorFailure?)` — reuse body/actor settlement; neither is a process deadline runner.
- Existing `cleanupExitedActors(actors, paths, cleanup, priorFailure?)` — reuse confirmed-exit deletion authority; no new general recursive-delete API.
- Existing `captureFrozenProvenance({ workspaceRoot, manifestPath, phase })` — unchanged supported native capture; current collector bytes bind fresh evidence.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the sibling retained-FD fixture race completes THE SYSTEM SHALL prove both manifests bind copied collector/internal-core bytes, use distinct owned leaves, publish no same-basename original-root leaf, and leave reset/Git invariants clean, preserving predecessor SDS-AC-1.
- SDS-AC-2: WHEN the combined gate collects its children THE SYSTEM SHALL retain the seal-race physical two-Worker ready/release/distinct-capture/error/cleanup proof, preserving predecessor SDS-AC-2 without a replacement mock or skipped transcript.
- SDS-AC-3: WHEN the successor gate is executed THE SYSTEM SHALL invoke the exact proposed20-file argv above with the existing Node executable/default file concurrency, compare the unique ordered fixed list and discovery set, and retain every underlying semantic suite from the removed9-child wrapper including the boundary suite elsewhere in the20; the wrapper's separate120s/boundary-exclusion policy SHALL NOT remain an implicit requirement of this proposed successor.
- SDS-AC-4: WHEN elapsed time reaches118000ms before natural child close THE SYSTEM SHALL record irrevocable deadline failure, issue no kill/abort/process signal, continue collecting stdout/stderr and await natural close; callback/observation errors SHALL also be retained without bypassing settlement, and exit0 after the boundary SHALL NOT turn failure into success.
- SDS-AC-5: WHEN any native fixture performs filesystem I/O THE SYSTEM SHALL derive its checkout from module location, use only verified canonical-owned source/config inputs, reject foreign/escaping/reparse paths before mutation, and preserve shared parents/unconfirmed actor-owned paths until ownership and settlement permit exact cleanup; synthetic fake-fs path strings SHALL NOT grant real I/O authority.
- SDS-AC-6: WHEN admission completion is proposed THE SYSTEM SHALL provide three fresh clean runs on the same approved tree/input contract, each nonempty and strictly below118000ms with successful natural close, zero failed/cancelled/skipped/TODO cases, all20 children actually executed and all required semantic transcripts/cleanup assertions checked; predecessor or selected-parent results SHALL NOT be relabelled as these runs.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | Retain sibling source binding, original-root nonpublication and reset assertions; existing RED stays historical, new regressions precede behavior edits. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs | Preserve real two-Worker barrier and failure/cleanup outcomes. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | Exact list/order/discovery, duplicate/missing/extra controls, documentary correspondence with deleted wrapper9; no arbitrary count substitution. |
| SDS-AC-4 | tools/wave3/admission-process-observer.test.mjs (proposed) | Controlled child events and clock: N-1/N/N+1, late exit0, signal/spawn/output errors, throwing deadline callback, close after exit, no signal and no early settlement. |
| SDS-AC-5 | tools/wave3/admission-fixture-root.test.mjs (proposed); existing trust/seal/wave/lexical/admission and race tests | Actual source/callback controls for pre-write ownership; concurrent shared-parent sibling preservation; canonical config only; retain fake-fs negative path corpus. |
| SDS-AC-6 | tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | Counterfeit empty/partial/skipped/cancelled/TODO success rejection, exact per-child execution evidence, three fresh full runs after safety/provenance review. |

Source review scope includes trust.test.mjs:187-214 and seal.test.mjs:132-150 pre-validation writes; lexical/wave native capture roots; admission root-reading paths; and shared analysis-parent cleanup across concurrent files. Enumerate actual reads/writes before changing roots; do not mechanically rewrite harmless fake-fs constants. This draft changes the future AC-3 contract only if later agreed/superseded through supported workflow. Existing predecessor tests/evidence remain intact; proposed runner/root behavior requires new RED before implementation.

## 7. Open Questions

- Blocking: review the removed wrapper at commit2a20b4f against each of its9 children and current20 before adopting list reconciliation. Old merged/agreed lifecycle remains unchanged while this draft is reviewed.
- Blocking: choose a nonvacuous per-file accounting mechanism compatible with unchanged child argv. Installed Node24.16.0 internal/test_runner/utils sets the default reporter to spec (:139/:309); tap is selected for NODE_TEST_CONTEXT=child (:280/:301-302), while this gate removes NODE_TEST_* environment keys. Verify the actual installed reporter/output contract rather than assuming default TAP; define nested-test versus file counts and reject missing summaries, empty files, partial output and tolerated TODO failures. No fixed aggregate number alone is proof.
- Blocking: inventory every real shared-parent writer/remover under default concurrency and decide precise ownership/cleanup guards; module-relative roots alone do not prove race safety.
- Blocking: finalize runner error/stream-close ordering and deadline clock origin, including a failure before any child is started; natural settlement must not be replaced by a killing timeout. Select safe RED fixtures before physical execution.
- Supporting records: [contract discrepancy](../../../memory/2026-09-08-admission-contract-boundary.md), [Node lifecycle observation](../../../plan/2026-09-08.admission-lifecycle-preflight.md), [selected physical result](../../../report/2026-09-09.native-probe-physical-validation.md). These do not waive any remaining full-gate requirement.
