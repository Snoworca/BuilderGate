# RED Evidence: isolated PERF-BGSTAB-010 AC-9 browser E2E

- Requirement: `PERF-BGSTAB-010` (AC-9 only)
- Step: `2026-07-26.pm.ac9-isolated-browser-e2e`
- Date: 2026-07-26
- Status: RED confirmed

## Missing-spec invocation

Command, run from `frontend` before the isolated spec existed:

```text
npx.cmd playwright test tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts --project "Desktop Chrome"
```

Observed result: exit 1, `Error: No tests found.`

## Test-first isolation contract

The committed test-first contract asserts that the new isolated spec exists and
does not import the historical evidence suite, reference its analysis directory,
or invoke `writeFileSync`.

Command, run from `frontend` before the spec was added:

```text
node --experimental-strip-types --test tests/unit/perfBgstab010Ac9IsolatedE2EContract.test.ts
```

Observed result: exit 1, `tests 1`, `pass 0`, `fail 1`; the assertion reports
that the isolated AC-9 browser spec must exist before current evidence can be
used.

## Workspace-cap safety-contract RED

The first isolated browser attempt proved that its initial source guard passed,
but its delivery case failed before injection: `POST /api/workspaces` returned
HTTP 409 because the configured workspace cap had been reached. A five-member
decision committee then selected, 3:2, a GET-only reuse of an existing
provenance-verified `W3-SOLE-WRITER-<timestamp>` idle PowerShell workspace.

The strengthened static contract forbids the prior creation/cleanup helpers and
all workspace HTTP mutation methods, and requires reusable-workspace selection
and local synthetic-ACK blocking. Before the safe spec is committed, that
contract is intentionally RED because no eligible isolated spec exists.
