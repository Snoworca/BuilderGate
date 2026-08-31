# Intent: closure-v3 reparse probe cache

Make the approved Windows reparse guard practical for complete provenance capture without
weakening its fail-closed contract. The cache has capture lifetime only and is never
available to a future Playwright runner.
