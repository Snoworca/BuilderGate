# SDS: Fair provenance runtime manifest

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-26.pm.fair-provenance-runtime-manifest |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-26 |

## 1. Context & Scope

`server/dist` runtime은 fair-scheduler source digest를 계산할 때 존재하지 않는 `dist/**/*.ts`를 읽어 `decision-artifact-invalid-json`으로 fail-closed한다. 이는 `https://localhost:2222`의 capability admission을 막아 AC-6 browser evidence의 선행 결함이다.

이 step은 기존 다섯 TypeScript source 입력의 digest를 build 시 immutable manifest로 `dist`에 포함하고, compiled runtime이 그 manifest를 검증해 사용하도록 한정한다. published artifact, publication, raw trial evidence와 parent requirement는 수정하지 않는다.

## 2. Goals / Non-goals

- Goal: source/tsx와 fresh compiled `dist`가 같은 published artifact source digest를 검증한다.
- Goal: build output과 portable runtime에 provenance manifest가 포함되고, manifest 누락·손상은 fail-closed한다.
- Goal: actual `dist` admission failure 원인을 compiled-runtime regression으로 고정한다.
- Non-goal: artifact/publication/raw evidence 재생성·수정, runtime policy 변경, candidate rollout, package artifact publication policy 변경.
- Non-goal: AC-6 browser ACK assertion 자체의 완료; prerequisite 후 새 AC-6 step에서 다룬다.

## 3. Architecture Decisions

- **Decision**: build-time immutable provenance manifest를 `dist`에 생성한다 / basis: portable runtime은 `dist`와 dependencies만 복사하고 `src`는 포함하지 않는다 / trade-off: build script와 manifest contract를 추가한다 / rejected: compiled runtime이 `server/src`를 다시 읽는 방식.
- **Decision**: manifest는 기존 다섯 UTF-8 TypeScript source의 순서·digest algorithm과 동등한 source digest 및 file identity를 고정한다 / basis: existing published artifact의 sourceDigest 호환성을 유지한다 / trade-off: source 변경 후 build가 필수다 / rejected: compiled JavaScript 재해싱 또는 artifact rewrite.
- **Decision**: source execution은 canonical TypeScript inputs를 직접 계산하고 dist execution은 validated manifest만 사용한다 / basis: source benchmark generation과 deployed runtime을 각각 재현 가능하게 한다 / trade-off: two-path validation이 필요하다 / rejected: broad exception을 JSON error로 숨기는 fallback.

## 4. Interfaces

- `server/tools/write-fair-scheduler-source-provenance.mjs` — canonical five-source fingerprint manifest를 build output에 작성한다.
- `server/dist/benchmarks/fair-scheduler-source-provenance.json` — schema version, ordered source identities, file hashes, aggregate source digest를 가진 immutable build output.
- `getFairSchedulerBenchmarkSourceDigest()` — source mode에서는 canonical TS inputs, dist mode에서는 validated provenance manifest로 existing artifact-compatible digest를 반환한다.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN `server` build completes THE SYSTEM SHALL emit a provenance manifest in `dist/benchmarks` whose aggregate digest equals the existing five-source TypeScript digest algorithm.
- SDS-AC-2: WHEN the compiled `dist` validator evaluates the current published artifact THE SYSTEM SHALL return `accepted:true` and `decision-artifact-verified` without reading a nonexistent `dist/**/*.ts` input.
- SDS-AC-3: WHEN the provenance manifest is absent, malformed, has a changed ordered identity, non-hex file digest, or aggregate mismatch THE SYSTEM SHALL fail closed with a provenance-specific rejection and SHALL NOT accept fair delivery.
- SDS-AC-4: WHEN portable runtime is built THE SYSTEM SHALL include the compiled provenance manifest with its copied `server/dist` tree.
- SDS-AC-5: WHEN this step executes THE SYSTEM SHALL NOT rewrite the fair-scheduler artifact, publication manifest, raw evidence, or parent SRS lifecycle fields.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | RED compiled-runtime contract expects the manifest-backed artifact admission to succeed. |
| SDS-AC-2 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | Fresh `npm run build` dist module validates current artifact with the runtime policy. |
| SDS-AC-3 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | Missing and tampered manifest cases reject without fallback to source or artifact mutation. |
| SDS-AC-4 | tools/daemon/build-portable-runtime.test.js | Portable layout includes the manifest as part of copied `server/dist`. |
| SDS-AC-5 | server/src/benchmarks/FairSchedulerSourceProvenanceRuntime.test.ts | Test asserts artifact inputs are read-only and uses only external/generated build output. |

## 7. Open Questions

- (none — five-person decision committee selected the build-time manifest design by 3:2 vote.)
