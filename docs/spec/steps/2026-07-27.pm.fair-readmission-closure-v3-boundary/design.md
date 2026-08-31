# SDS: 2026-07-27.pm.fair-readmission-closure-v3-boundary

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-boundary |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Three independent reviews of wave admission found remaining public/API, TypeScript-host,
manifest-destination, cap/cache, and regression-gate gaps. This successor closes only the
offline provenance collector boundary and focused Node tests. It neither runs Playwright
nor changes BuilderGate runtime, browser, external evidence lifecycle, native code, or a
persistent PowerShell worker.

## 2. Goals / Non-goals

- Goal: Enforce strict object child results, bounded full-frontier guards, guarded metadata
  reads, and wave cache cleanup on every public collector path.
- Goal: Ensure dependency/config discovery is driven by admitted contained snapshot bytes,
  and manifest destination admission has fresh parent/leaf validation around exclusive write.
- Goal: Provide an executable, fixed nine-file, external 120-second focused regression gate.
- Non-goal: Claim a Node pathname write is atomically immune to a hostile kernel-time
  parent-directory replacement; fail-closed admission checks are the stated boundary.
- Non-goal: General TypeScript package/alias resolution outside the admitted workspace.

## 3. Architecture Decisions

- **Decision**: Accept only actual `spawnSync` result objects and reject singleton batches
  exceeding count/byte caps before probe invocation / basis: raw strings invent missing
  status and oversized injected batches bypass the contract / trade-off: legacy test seam
  removal / rejected: coercion adapters.
- **Decision**: Make guarded snapshot/wave ownership the only collector metadata and byte
  ingress; public source closure constructs a strict guard, and preflight `exists/stat`
  calls are removed / basis: follow-link metadata before guard is an unadmitted boundary /
  trade-off: centralized error normalization / rejected: optional guard and preflight paths.
- **Decision**: Replace `ts.sys` filesystem resolution with a contained admitted-byte
  resolver for the permitted relative source closure; unsupported config/package/alias
  discovery fails closed / basis: mutable host reads cannot establish provenance / trade-off:
  deliberately narrow supported closure / rejected: host resolver fallback.
- **Decision**: Before exclusive manifest leaf creation, create/require analysis root then
  force-fresh validate complete parent/leaf frontier immediately before write and validate
  again afterward; changed/admission-invalid output is not accepted / basis: reduce
  pathname parent swap exposure within Node APIs / trade-off: documented non-atomic limit /
  rejected: a false no-follow guarantee.

## 4. Interfaces

- `probeWindowsReparsePoint/Points(...)` — accept strict child result objects only.
- `collectSourceClosure(...)` — requires or constructs strict full-frontier batch guard;
  no lstat-only public mode exists.
- admitted resolver — maps only contained permitted relative imports from admitted bytes;
  unsupported host-dependent resolution fails before read/hash.
- manifest writer — performs fresh parent/leaf admission before `wx` write and post-write
  revalidation before return.
- focused gate — invokes exactly the nine named closure tests under a 120-second external
  child timeout, without self-recursing.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a probe, guard, or public closure API is used THE SYSTEM SHALL require
  strict child-result objects, strict batch guard wiring, and count/byte cap compliance;
  raw result, missing guard, singleton overflow, mismatch, or disappearance SHALL fail
  closed and invalidate relevant cache identities.
- SDS-AC-2: WHEN collector metadata, bytes, config, imports, or source rows are discovered
  THE SYSTEM SHALL use admitted contained snapshot bytes and a guarded resolver only;
  `existsSync`, `statSync`, `ts.sys`, or host package/alias fallback before admission SHALL
  not select a protected input.
- SDS-AC-3: WHEN a manifest is written THE SYSTEM SHALL create/require its analysis root,
  force-fresh validate contained parent/leaf immediately before exclusive creation, then
  post-validate before accepting output; any observed change SHALL fail capture without
  treating the manifest as evidence.
- SDS-AC-4: WHEN the fixed nine-file closure list runs through the external gate THE SYSTEM
  SHALL complete all tests within 120 seconds; the gate SHALL fail on timeout/nonzero and
  record its measured elapsed duration without recursively invoking itself.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.boundary.test.mjs | Raw child, missing guard, singleton cap, mismatch cache cleanup fail closed. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.boundary.test.mjs | No preflight/ts.sys path; admitted relative resolver only and unsupported host discovery rejects. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.boundary.test.mjs | Destination parent/leaf fresh validation surrounds exclusive write and post failure is rejected. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.boundary-gate.test.mjs | Nonrecursive fixed nine-file child gate enforces 120-second wall clock and emits elapsed evidence. |

## 7. Open Questions

- A stronger guarantee that a hostile concurrent parent swap cannot cause an outside write
  requires a separate native/Win32-handle design and is not silently claimed here.
