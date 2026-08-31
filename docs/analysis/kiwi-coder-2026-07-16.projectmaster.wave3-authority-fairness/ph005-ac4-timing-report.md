# PH005 AC-4 timing and fail-safe recovery note

- Requirement: `MIG-BGSTAB-002` AC-4/AC-5; evidence task `T-PH005-03`.
- Final authoritative evidence: `authority-promotion-decision.json` records compatibility 39/39, target unit 12/12, extended regression 59/59, route guards 5/5, and HTTPS E2E 6/6.

## Observed timing history

1. A fresh AC-4 run first failed the final retained-state contract. A clean trace-enabled repeat then failed during cleanup after the server had exhausted checkpoint-delivery-ready retries for replacement views.
2. That trace captured a 91,214-byte, 10,030-line authoritative checkpoint. The frontend emitted `failure-ack` with reason `timeout` about 2.017 seconds after checkpoint processing began. While recovery was pending, the frontend deferred prepared readiness; the server exhausted four ready attempts per affected view and, before the fix, left server authority active with isolation resources still held.
3. The server recovery branch now invokes the existing safe rollback path after `checkpoint-delivery-ready-retry-exhausted`. Its deterministic contract proves no authoritative checkpoint is admitted for the unready view, then verifies `rolling-back` followed by browser compatibility ACK/drain completion to `legacy`.
4. After the change, a fresh trace-enabled AC-4 run passed, a fresh dedicated AC-6 run passed, and a fresh exact-six HTTPS aggregate passed. The final authoritative tool repeated and recorded the six-case aggregate as 6/6.

## Scope of the conclusion

This evidence shows fail-safe convergence when the observed browser write timeout leads to exhausted readiness retries. It does not establish that the fixed two-second browser checkpoint-write deadline can never be exceeded on a slow renderer or a larger retained range. Future changes to retained-range size, checkpoint encoding, or the frontend write watchdog require a fresh AC-4 trace and aggregate run.
