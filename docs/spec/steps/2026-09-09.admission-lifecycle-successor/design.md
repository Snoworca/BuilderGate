# SDS: 2026-09-09.admission-lifecycle-successor

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-09-09.admission-lifecycle-successor |
| Target | wave-5 |
| Status | agreed |
| Date | 2026-09-09 |

## 1. Context & Scope

PERF-BGSTAB-010 AC-3 provenance validation support, continuing a wave-3 prerequisite within active wave-5; PERF-BGSTAB-011 AC-7 remains downstream bundle/build validation.
The [predecessor](../2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor/design.md) was merged/agreed and required21 children when this draft was prepared; current code has20 after commit2a20b4f073df7d6a9bbf209deaf3cf0a14221183 removed a wrapper.
The [preparation boundary](../../../memory/2026-09-09-admission-successor-boundary.md) permitted draft preparation only; subsequent [contract adoption](../../../memory/2026-09-09-admission-contract-adoption.md) obtained three independent consents and official read-back of this SDS as agreed and the predecessor SDS as superseded, without claiming execution.
Current full execution is unsafe: outer spawnSync timeout can signal Node; trust/seal perform original-root filesystem writes before collector validation.
The selected physical9/9 is limited evidence, not the full gate or three clean118000ms runs.

## 2. Goals / Non-goals

- Goal: Preserve predecessor SDS-AC-1/2 physical provenance and Worker SSOT while proposing an explicit replacement for SDS-AC-3's suite and process-lifecycle contract.
- Goal: Make every real filesystem fixture canonical-owned and settle all started work before root reuse/deletion.
- Non-goal: Change collector/runtime protocol, evidence structure, native freshness, batch64/8192 bounds,115000ms child limits,118000ms acceptance deadline, or default Node file concurrency.
- Non-goal: Adopt20 by counting the outer gate, select an arbitrary replacement suite, rewrite historical RED/evidence, promote SRS, or authorize original user-file adoption.

## 3. Architecture Decisions

- **Decision**: Retain predecessor AC-1/2 unchanged in meaning / basis: sibling fixture provenance and seal-race Worker proofs remain necessary / trade-off: physical adversaries remain costly / rejected: deleting duplicate-looking semantic checks.
- **Decision**: Replace only predecessor AC-3's21-child wording with the exact20-file list below / basis: deleted boundary-gate wrapper reran9 existing children / trade-off: retire that wrapper's separate120s and boundary-exclusion policy explicitly / rejected: outer-gate counting or retaining a vacuous wrapper. Its underlying9 and boundary remain in20; coverage correspondence was reviewed before agreement.
- **Decision**: Keep the same Node executable,20-file order and default file concurrency; explicitly propose `['--test', '--test-reporter=./tools/wave3/admission-event-reporter.mjs', ...fixedClosureTests]` and observe118000ms without signalling / basis: user process protection and default spec output cannot prove exact file execution / trade-off: an explicit reporter argv contract change and overdue natural completion / rejected: timeout relaxation, early success, forced termination or serializing files.
- **Decision**: Derive real fixture roots from module location and validate owned paths before writes / basis: canonical isolation / trade-off: audit each actual I/O path / rejected: blanket string replacement in fake-filesystem fixtures or fallback to main checkout.
- **Decision**: Preserve the shared canonical analysis parent and remove only exact owned nonce leaves; retain independent Temp internal-core missing-parent/junction creation/removal contracts / basis: default-concurrency races / trade-off: explicit ownership evidence / rejected: recursive deletion merely because a directory name matches.

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
- Proposed test-only `admission-event-reporter.mjs(source: AsyncIterable<TestEvent>) -> AsyncIterable<string>` ? emit versioned JSONL v1 summary/pass/fail/complete/output records and one terminal end record; explicit argv only, never NODE_OPTIONS.
- Proposed `evaluateAdmissionEvents(records, expectedEntryFiles) -> verdict` ? validate reporter shape, entry summaries, native count rules and final stream completeness; ordinary event.file is definition location, never entry-file attribution.
- Existing `captureFrozenProvenance({ workspaceRoot, manifestPath, phase })` — unchanged supported native capture; current collector bytes bind fresh evidence.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the sibling retained-FD fixture race completes THE SYSTEM SHALL prove both manifests bind copied collector/internal-core bytes, use distinct owned leaves, publish no same-basename original-root leaf, and leave reset/Git invariants clean, preserving predecessor SDS-AC-1.
- SDS-AC-2: WHEN the combined gate collects its children THE SYSTEM SHALL retain the seal-race physical two-Worker ready/release/distinct-capture/error/cleanup proof, preserving predecessor SDS-AC-2 without a replacement mock or skipped transcript.
- SDS-AC-3: WHEN the successor gate is executed THE SYSTEM SHALL invoke `['--test', '--test-reporter=./tools/wave3/admission-event-reporter.mjs', ...fixedClosureTests]` with the exact20-file order above with the existing Node executable/default file concurrency, compare the unique ordered fixed list and discovery set, and retain every underlying semantic suite from the removed9-child wrapper including the boundary suite elsewhere in the20; the wrapper's separate120s/boundary-exclusion policy SHALL NOT remain an implicit requirement of this proposed successor.
- SDS-AC-4: WHEN the observer launches a child THE SYSTEM SHALL start performance.now immediately before spawn and accept timing only when natural close elapsed is strictly below118000ms; elapsed at or above the boundary SHALL fail even if close is processed before a delayed timer. Deadline failure SHALL be irrevocable, with no kill/abort/process signal, and stdout/stderr collection SHALL continue through natural close. Exit alone SHALL NOT resolve observation. Callback/stream/child errors SHALL be retained while awaiting close; a synchronous spawn throw before returning a child SHALL report failure without inventing a child to await. A child that never closes SHALL remain unresolved with owned paths preserved, and a late exit0 SHALL NOT erase failure.
- SDS-AC-5: WHEN any native fixture performs filesystem I/O THE SYSTEM SHALL derive its checkout from module location and use only verified canonical-owned source/config inputs. Immediately before direct mkdir or cleanup it SHALL reuse canonical-containment and native parent-reparse validation; collector freshness SHALL remain unchanged. Shared canonical analysis parents SHALL remain intact and cleanup SHALL target only exact owned nonce leaves. Independent Temp internal-core missing-parent/junction fixtures SHALL retain their existing owned-root contracts. Unconfirmed actor-owned paths SHALL remain preserved; synthetic fake-fs strings SHALL NOT grant real I/O authority.
- SDS-AC-6: WHEN admission completion is proposed THE SYSTEM SHALL provide three fresh clean runs on the same approved tree/input contract, each nonempty and strictly below118000ms with successful natural close, zero failed/cancelled/skipped/TODO cases, all20 children actually executed as established by the explicitly selected reporter and all required semantic transcripts/cleanup assertions checked; predecessor or selected-parent results SHALL NOT be relabelled as these runs.

Reporter protocol proposal (v1): every line is one object with schemaVersion and a closed record type. summary records carry nullable file, success and the native counts required below. pass/fail/complete records carry only nullable file/name/nesting, nullable details.type/failureType, and explicit skip/todo presence plus their supported boolean/string value; unsupported required-field types fail validation. output records identify stdout/stderr and encode text as a JSON string, never reinterpret its contents as summaries. Serialize the selected fields explicitly rather than dumping arbitrary runtime objects. One end record carries the count of preceding event records; no further record may follow.

Each exact entry file must have exactly one native test:summary with tests>0, success:true and failed/cancelled/skipped/todo counts0. Require exactly one file-less root summary, and reconcile its counts with the20 file summaries. Count each native pass/fail event once using the installed countCompletedTest rule: distinguish suite events from ordinary tests and ordinary nested parents; complete events are diagnostic only and never counted again. Compare this independent global count with the file-summary sum and root summary. A regular event.file may point to a helper definition and must not identify the entry file. Missing/duplicate summaries, unknown entries, malformed/truncated JSONL, inconsistent counts, missing end, bad end count, abnormal reporter/output stream termination or unsuccessful process close fail the gate. Reporter-side complete is not proof of file completion. This observer detects incomplete/inconsistent test evidence; it is not a security boundary against a malicious runtime forging valid events.


## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | Retain sibling source binding, original-root nonpublication and reset assertions; existing RED stays historical, new regressions precede behavior edits. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs | Preserve real two-Worker barrier and failure/cleanup outcomes. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | Exact list/order/discovery, duplicate/missing/extra controls, documentary correspondence with deleted wrapper9; no arbitrary count substitution. |
| SDS-AC-4 | tools/wave3/admission-process-observer.test.mjs (proposed) | Controlled child events and clock: N-1/N/N+1, late exit0, signal/spawn/output errors, throwing deadline callback, close after exit, no signal and no early settlement. |
| SDS-AC-5 | tools/wave3/admission-fixture-root.test.mjs (proposed); existing trust/seal/wave/lexical/admission and race tests | Actual source/callback controls for pre-write ownership; concurrent shared-parent sibling preservation; canonical config only; retain fake-fs negative path corpus. |
| SDS-AC-6 | tools/wave3/admission-event-reporter.test.mjs (proposed); tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | RED helper-definition file attribution, nested describe/ordinary parent counts, empty entry, skip/TODO/cancel, duplicate/missing/root/end/partial stream and output-embedded pseudo-events; finite real Node probes after agreement, then three fresh complete gate runs. |

Source review scope includes trust.test.mjs:187-214 and seal.test.mjs:132-150 pre-validation writes; lexical/wave native capture roots and remediation module-relative roots; admission root-reading paths; and shared analysis-parent cleanup across concurrent files. Enumerate actual reads/writes before changing roots; do not mechanically rewrite harmless fake-fs constants. The AC-3 successor contract was adopted through the supported agreed/superseded workflow recorded above. Existing predecessor tests/evidence remain intact; proposed runner/root behavior requires new RED before implementation.

## 7. Open Questions

- The former adoption gate is resolved: three independent consents and official MCP lifecycle read-back established this SDS as agreed and the predecessor SDS as superseded. The predecessor step remains merged; no implementation or gate completion is implied.
- Adopted contract choices, not implemented behavior: replace the removed9-child wrapper's separate120s/boundary-exclusion policy with the exact20 list while preserving underlying semantic coverage; retain monotonic118000ms failure with natural settlement; preserve canonical shared parents and isolated Temp adversaries; use native entry summaries plus reconciled global/root counts through explicit reporter v1. Independent review assessed these choices before agreement.
- After agreement, strict RED must validate the proposed native counting rule and reporter fields against the installed runtime using finite helper-definition/nested-suite/empty/skip/TODO/partial controls. No complete-event inference, default-spec parsing, aggregate-only proof or old execution relabelling is allowed.
- Supporting records: [contract discrepancy](../../../memory/2026-09-08-admission-contract-boundary.md), [Node lifecycle observation](../../../plan/2026-09-08.admission-lifecycle-preflight.md), [selected physical result](../../../report/2026-09-09.native-probe-physical-validation.md). These do not waive any remaining full-gate requirement.
