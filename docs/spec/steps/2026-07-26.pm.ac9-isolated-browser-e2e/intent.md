# Intent: 2026-07-26.pm.ac9-isolated-browser-e2e

Add a strict-TDD, self-contained HTTPS Playwright proof for
`PERF-BGSTAB-010` AC-9. It will inject one fair-delivery output through the
browser's routed real WebSocket, verify its ACK and the `idle` session invariant,
and avoid every historical evidence writer. The step is evidence-only: it does
not modify the fair-delivery runtime or claim parent requirement completion.
