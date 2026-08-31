# SDS: 2026-07-27.pm.fair-readmission-closure-v3-fd-manifest

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-fd-manifest |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Independent review found that pathname `writeFileSync(..., 'wx')` cannot identify the object it
created when an attacker replaces it with an identical regular file before the first pathname
observation. A five-member committee chose a private retained file-descriptor flow by 4:1.
This successor preserves the closed collector boundary and all opaque-wave contracts while
binding manifest admission to the actual exclusively-created leaf.

## 2. Goals / Non-goals

- Goal: Bind the manifest object created by exclusive create to final postflight pathname state.
- Goal: Restore guard-before-path-I/O ordering and strict core input validation.
- Non-goal: Add public options/exports, test mode, path/capability callbacks, a third core API,
  source rewrite, or an OS-specific atomic publish redesign.

## 3. Architecture Decisions

- **Decision**: The private adapter SHALL use `openSync(destination, 'wx')`, write serialized
  bytes to that retained descriptor, take `fstatSync(fd)` identity, run postflight, compare that
  identity with the final pathname identity, and close the descriptor exactly once in `finally`
  / basis: a pathname write returns no created-object identity and cannot reject same-byte
  replacement / trade-off: explicit descriptor lifecycle / rejected: hash/lstat best effort.
- **Decision**: Native race tests SHALL exercise the unchanged collector in an isolated child
  with a nonce-only preloader adapted to the fd exclusive-create flow; test helpers never alter
  collector source, capture inputs, production mode, or parent process builtins / basis:
  deterministic `wx`-to-postflight evidence without public injection / rejected: polling and a
  third manifest callback port.
- **Decision**: Before every pathname read/probe, private adapter validation precedes the I/O;
  opaque wave port remains exactly four own string callback keys and manifest state rejects
  authority-shaped nested values / basis: reviewer evidence / rejected: permissive extras.

## 4. Interfaces

- private manifest adapter — owns descriptor, native paths, reparse guard, serialized bytes,
  and identity capture; it is reachable only from normal capture.
- `evaluateManifestWriteState(state)` — unchanged pure internal policy; evaluates fstat-derived
  created identity and pathname postflight identity, with no filesystem/capability input.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN a caller supplies unsupported authority, callback, test-mode, or nested
  authority-shaped internal state THE SYSTEM SHALL reject before protected path I/O; the public
  collector SHALL retain its exact three-field input and no protected exports.
- SDS-AC-2: WHEN private exclusive manifest create succeeds THE SYSTEM SHALL write through the
  retained descriptor, capture identity from `fstatSync(fd)`, compare it against final pathname
  identity after postflight, and close fd exactly once on success, write failure, postflight
  failure, or `EEXIST` failure.
- SDS-AC-3: WHEN a same-byte or different-byte regular leaf replacement occurs after exclusive
  create and before final comparison THE SYSTEM SHALL reject with no accepted manifest; WHEN a
  sibling leaf changes only permitted parent timestamps during the retained-fd transaction THE
  SYSTEM SHALL accept the original leaf after successful postflight.
- SDS-AC-4: WHEN the fixed admission gate runs core, lexical, seal, native missing-parent, and
  retained-fd worker races THE SYSTEM SHALL pass within 120 seconds without skipped suites.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.internal-core.test.mjs | Exact port/nested authority/pre-I/O rejection. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | fd lifecycle and fstat-derived identity. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | same-byte replacement rejection and sibling timestamp churn. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | Exhaustive gate/timing. |

## 7. Open Questions

- A final pathname replacement after final comparison remains a platform-level filesystem race;
  this step closes the reviewed pre-observation/same-byte gap without claiming a portable atomic
  publish primitive.
