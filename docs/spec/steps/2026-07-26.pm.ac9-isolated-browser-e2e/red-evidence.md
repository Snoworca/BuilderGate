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
