# GREEN Evidence: isolated PERF-BGSTAB-010 AC-9 browser E2E

- Requirement: `PERF-BGSTAB-010` (AC-9 browser boundary only)
- Step: `2026-07-26.pm.ac9-isolated-browser-e2e`
- Date: 2026-07-26
- Status: GREEN confirmed

## Focused results

Run from `frontend`:

```text
node --experimental-strip-types --test tests/unit/perfBgstab010Ac9IsolatedE2EContract.test.ts
```

Result: exit 0; `tests 2`, `pass 2`, `fail 0`. The contract rejects
`writeFile`, `writeFileSync`, `appendFile`, and `appendFileSync` tokens while
allowing the spec's read-only `readFileSync` source inspection.

```text
npx.cmd playwright test tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts --project "Desktop Chrome"
```

Result: exit 0; two tests passed. The browser case used
`https://localhost:2222` and the routed `wss://localhost:2222/ws` connection,
selected only a GET-verified idle `W3-SOLE-WRITER-<timestamp>` PowerShell
workspace, rendered one synthetic marker, captured exactly one matching ACK in
the relay without forwarding it to the server, and observed `idle` both before
and after delivery. The workspace/tab topology fingerprint was unchanged and
the runtime mutation guard observed no workspace API mutation.

```text
npx.cmd eslint tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts tests/unit/perfBgstab010Ac9IsolatedE2EContract.test.ts
```

Result: exit 0 with no diagnostics.

## Scope boundary

This evidence is transient test-support proof for the browser ACK/idle boundary
only. It does not replace historical phase evidence, demonstrate server ACK
credit acceptance, or verify/complete any other `PERF-BGSTAB-010` acceptance
criterion or lifecycle field.
