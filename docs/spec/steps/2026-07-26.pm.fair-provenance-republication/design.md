# SDS: Fair provenance runtime repair and republication

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-26.pm.fair-provenance-republication |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-26 |

## 1. Context & Scope

Compiled runtime은 source digest를 계산할 때 `dist/**/*.ts`를 읽어 ENOENT를 내고 `decision-artifact-invalid-json`으로 fail-closed한다. 정상 TypeScript resolver 수정은 digest input 자체를 바꾸므로, current fair artifact는 의도적으로 stale이 된다.

이 step은 source/dist compatible provenance manifest, deterministic benchmark regeneration, and atomic publication을 하나의 evidence chain으로 수행한다. Current untracked generation files는 유지하며 parent requirement lifecycle fields는 변경하지 않는다.

## 2. Goals / Non-goals

- Goal: source execution과 compiled dist가 같은 canonical five-TypeScript input provenance를 검증한다.
- Goal: source fix 뒤 official writer가 새 1/2/8-client WAN artifact, raw evidence, 15 trial sidecar를 staged validation 후 atomically publish한다.
- Goal: actual `https://localhost:2222` candidate capability admission이 new published evidence로 accepted가 되도록 한다.
- Non-goal: old generation 삭제·수정, manual JSON editing, policy threshold 완화, parent AC/status/evidence lifecycle mutation.
- Non-goal: AC-6 invalid ACK browser proof의 완료; admission green 뒤 별도 step으로 재개한다.

## 3. Architecture Decisions

- **Decision**: source code owns the resolver and build emits immutable dist provenance manifest / basis: source and deployed behavior must match while portable runtime omits `src` / trade-off: build artifact contract is added / rejected: postcompile-only patch.
- **Decision**: published artifact is regenerated through `writeFairSchedulerDecisionArtifact` after the source change / basis: sourceDigest includes the corrected benchmark TypeScript input / trade-off: full deterministic benchmark run and new evidence generation / rejected: retaining a stale artifact or manual JSON edit.
- **Decision**: old publication generation remains immutable; writer stages, validates, adds one new generation, then switches only canonical pointer files atomically / basis: auditability and rollback / trade-off: retained evidence storage / rejected: deletion or in-place generation mutation.

## 4. Interfaces

- `server/tools/write-fair-scheduler-source-provenance.mjs` — build-time canonical five-source provenance manifest writer.
- `server/dist/benchmarks/fair-scheduler-source-provenance.json` — validated compiled runtime provenance input.
- `writeFairSchedulerDecisionArtifact(profile)` — official deterministic fair benchmark publisher; only permitted canonical artifact mutation path.
- `validatePublishedFairDeliveryCandidateArtifact()` — compiled admission validator for the newly published evidence.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN `server` builds THE SYSTEM SHALL emit a provenance manifest whose ordered canonical source identities, per-file SHA-256 values, and aggregate digest match the source execution contract.
- SDS-AC-2: WHEN the compiled validator evaluates a publication whose sourceDigest matches the new canonical source inputs THE SYSTEM SHALL return `accepted:true` and `decision-artifact-verified` without reading `dist/**/*.ts`.
- SDS-AC-3: WHEN provenance is missing, malformed, identity-reordered, file-digest-invalid, aggregate-inconsistent, or stale relative to the current source THE SYSTEM SHALL reject fair delivery with a provenance-specific reason.
- SDS-AC-4: WHEN the corrected source changes the canonical digest THE SYSTEM SHALL use only the official writer to create and validate a fresh 1/2/8-client, 150-sample, 1,650-raw-sample generation with 15 preserved trial sidecars before switching canonical publication pointers.
- SDS-AC-5: WHEN publication succeeds THE SYSTEM SHALL preserve all existing generation files, change no parent SRS lifecycle field, and leave no hand-authored artifact JSON.
- SDS-AC-6: WHEN portable runtime is built THE SYSTEM SHALL include the compiled provenance manifest with copied `server/dist`.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | RED source and build manifest contract. |
| SDS-AC-2 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | Fresh compiled dist validates the canonical new publication. |
| SDS-AC-3 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | Missing/malformed/tampered provenance rejects without fallback. |
| SDS-AC-4 | tools/wave3/fair-scheduler-decision.test.mjs | Official writer output, fixed WAN profile, raw samples, and trial sidecars validate. |
| SDS-AC-5 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | Publication input is official and previous generation remains available. |
| SDS-AC-6 | tools/daemon/build-portable-runtime.test.js | Portable layout rejects a missing dist provenance manifest. |

## 7. Open Questions

- (none — three-person decision committee unanimously selected source fix plus fresh atomic publication.)
