# SDS: 2026-07-26.pm.fair-runtime-policy-profile

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-26.pm.fair-runtime-policy-profile |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-26 |

## 1. Context & Scope

The published fair-scheduler artifact now has valid source provenance, but the live 2222 WSS correctly rejects it because its fixed benchmark policy differs from the effective runtime policy.
This corrective step makes the benchmark, artifact validator, and official publisher bind one immutable non-secret policy profile derived through RuntimeConfigStore and the existing fair-policy resolver.
It covers PERF-BGSTAB-010 AC-2, AC-3, AC-4 and the AC-6 browser admission prerequisite.
The result remains fail-closed whenever the live policy, source provenance, or trial evidence differs.

## 2. Goals / Non-goals

- Goal: Measure and publish the exact effective fair-delivery policy profile without exposing configuration contents or secrets.
- Goal: Require an exact policy-profile match for source, compiled, and live-WSS artifact admission.
- Goal: Preserve the existing immutable-generation, staged validation, and atomic canonical-pointer publication contract.
- Non-goal: Change runtime resource-limit settings to match a benchmark fixture.
- Non-goal: Add a test-only admission bypass, expose config values/secrets, or alter unrelated terminal UI/protocol behavior.

## 3. Architecture Decisions

- **Decision**: Derive a canonical fair-policy profile from RuntimeConfigStore editable WS limits and resolve it with the same TerminalResourcePolicy resolver used by WsRouter / basis: live admission uses that authority / trade-off: a profile change requires a new benchmark generation / rejected: fixed benchmark limits or direct config parsing.
- **Decision**: Bind the profile identity and derived policy to raw trials, contract hashes, artifact validation, and publishing / basis: AC-3/AC-4 require evidence for the selected policy / trade-off: validators require an explicit profile / rejected: accepting any artifact-provided policy.
- **Decision**: The official writer alone creates a fresh immutable generation and replaces canonical pointers after staged validation / basis: preserve evidence history and prevent manual artifact edits / trade-off: a full 1/2/8-client measurement is required / rejected: editing the current JSON or config to force acceptance.
- **Decision**: Live WSS capability acceptance is the final authority check; a profile/source/evidence mismatch remains rejected / basis: runtime settings can change after a snapshot / trade-off: a changed setting blocks promotion until remeasurement / rejected: fallback admission.

## 4. Interfaces

- `createFairSchedulerRuntimePolicyProfile(runtimeConfig: Pick<RuntimeConfigStore, 'getEditableValues'>): FairSchedulerRuntimePolicyProfile` — returns only canonical fair-policy provenance, derived policy, and hashes.
- `getFairSchedulerBenchmarkContract(input?: FairSchedulerBenchmarkInput, profile?: FairSchedulerRuntimePolicyProfile): FairSchedulerBenchmarkContract` — derives workload and policy-bound contract from a validated profile.
- `createFairSchedulerDecisionArtifact(input: FairSchedulerBenchmarkInput & { runtimePolicyProfile?: FairSchedulerRuntimePolicyProfile }): FairSchedulerGeneratedArtifact` — runs every candidate/raw trial against one validated profile.
- `validateFairSchedulerDecisionArtifact(input: { artifact: unknown; rawArtifacts: unknown; runtimePolicyProfile?: FairSchedulerRuntimePolicyProfile }): FairSchedulerValidation` — rejects missing, altered, or mismatched profiles.
- `writeFairSchedulerDecisionArtifact(input: FairSchedulerBenchmarkInput & { outputPath: string; runtimePolicyProfile?: FairSchedulerRuntimePolicyProfile }): Promise<PublishedArtifact>` — writes only staged, validated immutable generations.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN an effective WS policy is projected from RuntimeConfigStore THE SYSTEM SHALL create a canonical immutable profile containing only the fair-policy provenance, derived policy, and their hashes.
- SDS-AC-2: WHEN a benchmark runs with a supplied policy profile THE SYSTEM SHALL use that exact profile for candidate scheduling, raw evidence, thresholds, workload/config hashes, and the published decision artifact.
- SDS-AC-3: WHEN an artifact, raw evidence, or validator receives a missing, altered, or one-field-different policy profile THE SYSTEM SHALL reject it without admitting the fair-delivery candidate.
- SDS-AC-4: WHEN the official writer publishes a complete matching-profile benchmark THE SYSTEM SHALL stage-validate it, preserve prior immutable generations, and atomically update only the canonical publication pointers.
- SDS-AC-5: WHEN the compiled runtime validates the fresh published artifact against its exact effective policy THE SYSTEM SHALL accept the candidate; WHEN the runtime policy differs THE SYSTEM SHALL fail closed with the runtime-policy mismatch reason.
- SDS-AC-6: WHEN an authenticated browser WSS client has received that accepted capability and submits an unknown-lane ACK THE SYSTEM SHALL reject the ACK with `ACK_UNKNOWN_LANE` without crediting the active ledger.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | server/src/benchmarks/terminalFairnessCharacterization.test.ts | RuntimeConfigStore projection is canonical, non-secret, immutable, and complete. |
| SDS-AC-2 | server/src/benchmarks/terminalFairnessCharacterization.test.ts | A non-fixture profile controls candidate, raw, threshold, and artifact contracts. |
| SDS-AC-3 | server/src/benchmarks/terminalFairnessCharacterization.test.ts | Missing, tampered, and one-field drift profiles reject before admission. |
| SDS-AC-4 | server/src/benchmarks/terminalFairnessCharacterization.test.ts | Writer keeps prior generation and publishes only a staged-validated matching profile. |
| SDS-AC-5 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | Compiled runtime accepts exact profile and rejects policy drift. |
| SDS-AC-6 | frontend/tests/e2e/perf-bgstab-010-ac6-server-ack-fault.spec.ts; server/src/ws/WsRouterSendPriority.test.ts | Live accepted capability precedes unknown-lane ACK rejection and zero credit change. |

## 7. Open Questions

- (none; the user-approved three-member committee unanimously selected effective-policy remeasurement over config changes, test injection, or deferral.)
