# SDS: 2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-worker-ssot-successor |
| Target | wave-3 |
| Status | agreed |
| Date | 2026-07-27 |

## 1. Context & Scope

The minimal physical fixture now proves the retained-FD missing-parent, junction,
sibling, replacement, and lifecycle cases, but it also repeats a two-Worker
ready/release barrier already physically covered by the fixed-gate seal-race suite.
Five-member committee decision B (4:1) permits a successor scope only when the
generic Worker proof remains canonical in seal-race and the fixture-specific
provenance proof is absorbed by the sibling physical race. This step changes
test evidence only; the collector, protocol, fixture roots, and fixed suite list
remain closed.

## 2. Goals / Non-goals

- Goal: Name the existing seal-race as the canonical physical proof for the
  generic two-Worker ready/release/capture/cleanup contract.
- Goal: Preserve fixture-bound collector/internal-core provenance, distinct
  owned leaves, original-root nonpublication, and reset evidence in the sibling
  retained-FD physical race before removing only the duplicate fixture Worker
  barrier.
- Goal: Require the admission gate to use a 118_000 ms timeout bound and prove
  that three clean executions each complete strictly below 118_000 ms, while
  keeping the exact fixed 21-suite list, Node command, and default Node file
  concurrency unchanged.
- Non-goal: Change production collector behavior, add a test mode or mock,
  remove the seal-race Worker barrier, weaken native retained-FD evidence, or
  relax the timing threshold.

## 3. Architecture Decisions

- **Decision**: The existing `fair-readmission-closure-v3.seal-race.test.mjs`
  remains the SSOT for the generic two-Worker import/ready/Atomics-release/
  distinct-capture/cleanup proof. The fixture Worker barrier is removed only
  after sibling A/B gains equivalent fixture-provenance assertions / basis:
  the fixed gate already executes the seal-race physical Worker contract while
  the fixture barrier adds 13--14 seconds and prevents stable SDS-AC-3 timing /
  trade-off: the sibling test must explicitly prove fixture identity and
  nonpublication rather than relying on Worker ready payloads /
  rejected: silent deletion under the prior SDS, merging Worker and retained-FD
  adversaries, skipped suites, and concurrency-only relief.

## 4. Interfaces

- sibling fixture manifest assertion — each A/B manifest binds the copied
  collector and internal-core SHA-256 values and uses a distinct owned fixture
  leaf; same-basename leaves in the original workspace remain absent.
- seal-race Worker assertion — the unchanged physical two-Worker barrier remains
  in the fixed 21-suite discovery set and is the generic Worker SSOT.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN the sibling retained-FD fixture race completes THE SYSTEM SHALL
  prove both fixture manifests bind the copied collector and internal-core bytes,
  use distinct owned fixture leaves, publish no same-basename leaf in the
  original workspace, and leave the fixture reset/Git invariant clean.
- SDS-AC-2: WHEN the duplicate fixture Worker barrier is removed THE SYSTEM
  SHALL retain the unchanged seal-race physical two-Worker ready/release/
  distinct-capture/error/cleanup proof in the fixed admission suite.
- SDS-AC-3: WHEN the fixed admission gate executes THE SYSTEM SHALL invoke the
  unchanged Node command with the unchanged exact fixed 21-suite list and
  default Node file concurrency; its timeout bound SHALL be 118_000 ms, each
  of three clean executions SHALL complete strictly below 118_000 ms, and no
  native transcript or cleanup assertion SHALL be skipped.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.internal-core-race.test.mjs | RED fixture-manifest provenance and original-root nonpublication; GREEN removes only the fixture Worker barrier after sibling proof passes. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.seal-race.test.mjs | Preserve generic physical two-Worker barrier as the canonical fixed-gate proof. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.admission-gate.test.mjs | Assert the 118_000 ms timeout bound, then record three clean executions strictly below 118_000 ms without changing the Node command, fixed 21-suite list, or default Node file concurrency. |

## 7. Open Questions

- The predecessor minimal-native-fixture step is superseded by this scoped
  successor only for the generic Worker-proof allocation; its retained-FD
  fixture decisions remain in force.
