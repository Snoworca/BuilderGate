# SDS: 2026-07-27.pm.fair-readmission-closure-v3-ingress

| Field | Value |
|---|---|
| Document Type | sds |
| Task | 2026-07-27.pm.fair-readmission-closure-v3-ingress |
| Target | wave-3 |
| Status | superseded |
| Date | 2026-07-27 |

## 1. Context & Scope

Independent review of the prior strict step found a real one-path PowerShell syntax
failure, a public leaf-only guard fallback, superscript Windows device aliases, and
unprotected hash reads outside config. It also found caller-controlled root parameters in
exported collector helpers. This successor closes offline provenance collector ingress
only; it does not launch Playwright, create evidence output, or change runtime/browser code.

## 2. Goals / Non-goals

- Goal: Converge every Windows path probe and guard on the batch/full-frontier protocol.
- Goal: Protect every hashed collector input with the same force-fresh pre/read/post
  guarded-read lifecycle and frozen-root containment.
- Goal: Reject all relevant Windows special fixture components, including superscript
  reserved device aliases.
- Non-goal: Support non-C: Windows roots, shell execution, a native addon, or dynamic
  system-directory discovery.
- Non-goal: Claim that Node's missing `Stats.isReparsePoint` proves a hostile Windows
  system-directory tree safe; system-directory replacement remains outside the stated
  administrator threat model.

## 3. Architecture Decisions

- **Decision**: Make the one-path API delegate to the established batch protocol and
  reject the legacy injected `probe` guard fallback / basis: a separate script was
  syntactically broken and the fallback bypassed full-frontier validation / trade-off:
  test-double migration / rejected: dual probe semantics or a compatibility flag.
- **Decision**: Read/hash every protected source, fixture, config, collector, and Node
  runtime input through one force-fresh full-frontier pre/read/post primitive / basis:
  config-only protection leaves provenance rows vulnerable to substitution / trade-off:
  bounded repeat probes / rejected: `alreadyGuarded` read bypasses and leaf-only checks.
- **Decision**: Bind collector helper paths to the derived repository root and fixed
  fixture evidence root / basis: caller-controlled roots can turn valid relative strings
  into outside-root hashes / trade-off: helpers are no longer generic path utilities /
  rejected: exported arbitrary workspace/fixture roots.
- **Decision**: Treat the fixed C: PowerShell literal as an explicit bootstrap boundary:
  reject positive link/reparse evidence, require regular-file and native-realpath equality,
  but do not claim Node's absent metadata independently proves reparse absence / basis:
  probing the executable with itself is circular / trade-off: documented OS-trust
  assumption / rejected: a false complete-reparse guarantee.

## 4. Interfaces

- `probeWindowsReparsePoint({ path, spawnSync, fs, platform })` — delegates to the strict
  batch executor for one caller path; no distinct PowerShell program exists.
- `createSegmentReparseGuard({ fs, probeBatch })` — accepts only batch verification and
  validates every existing ancestor/leaf frontier before caching safe identity.
- `readProtectedInput(...)` — force-fresh validates a complete frontier immediately
  before and after its byte read; failure returns no bytes/digest.
- `hashConfigLockFile(...)` / `resolveFixturePath(...)` — operate only inside the
  collector-derived repository and fixed fixture roots.

## 5. Acceptance Contracts

- SDS-AC-1: WHEN either exported Windows probe or a guard is called THE SYSTEM SHALL use
  only the strict batch executor and full existing ancestor/leaf frontier; a legacy
  one-path script or injected leaf-only `probe` SHALL be rejected or absent.
- SDS-AC-2: WHEN any protected source, fixture, config, collector, or Node runtime input
  is read for hashing THE SYSTEM SHALL force-fresh validate its full frontier immediately
  before the byte read and again before returning its digest; a staged identity/reparse
  change SHALL yield no row or digest.
- SDS-AC-3: WHEN an exported collector helper receives a workspace, fixture root, or path
  outside the collector-derived frozen boundary THE SYSTEM SHALL reject it before any
  stat, read, or hash; in-bound ordinary inputs SHALL resolve deterministically.
- SDS-AC-4: WHEN fixture metadata contains a Windows device component including
  `COM¹`, `COM²`, `COM³`, `LPT¹`, `LPT²`, `LPT³` (with suffixes), volume/UNC/ADS/escaping
  syntax, or trailing dot/space THE SYSTEM SHALL reject it before a read or hash.
- SDS-AC-5: WHEN resolving the fixed PowerShell bootstrap candidate THE SYSTEM SHALL use
  no environment lookup, require a regular non-symlink leaf and native-realpath equality,
  reject any positive reparse evidence, and SHALL document that absent Node metadata is
  not an independent hostile-system-tree proof.

## 6. Test Plan

| SDS-AC | Test file (planned) | Case summary |
|---|---|---|
| SDS-AC-1 | tools/wave3/fair-readmission-closure-v3.ingress.test.mjs | Actual one-path execution succeeds through batch protocol; legacy guard fallback cannot bypass frontier. |
| SDS-AC-2 | tools/wave3/fair-readmission-closure-v3.ingress.test.mjs | Source/fixture/config/collector/runtime guarded reads all fail closed on post-read mutation. |
| SDS-AC-3 | tools/wave3/fair-readmission-closure-v3.ingress.test.mjs | Outside workspace/fixture helper roots fail before filesystem operations. |
| SDS-AC-4 | tools/wave3/fair-readmission-closure-v3.ingress.test.mjs | Superscript COM/LPT aliases and suffixes reject; normal descendants resolve. |
| SDS-AC-5 | tools/wave3/fair-readmission-closure-v3.ingress.test.mjs | Positive reparse evidence rejects and bootstrap limitation is represented by the fixed contract. |

## 7. Open Questions

- A future non-C: Windows support or an independent executable reparse proof requires a
  separate trusted OS API design; this step intentionally fails closed outside the frozen
  C: environment.
