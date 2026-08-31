# Intent: closure-v3 reparse hardening

Replace the insufficient Node-only reparse guard with a deterministic Windows attribute
probe. The collector remains provenance-only: it neither starts Playwright nor manages
external output. Preserve all prior closure-v3 commits as audit history.
