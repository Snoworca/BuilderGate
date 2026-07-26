# Intent: 2026-07-26.pm.canary-fixture-recovery-public-api

Replace the superseded internal-identity recovery contract with a new,
test-only public-API fixture contract. The focused test will begin from a
missing-module RED, then verify public session DTO visibility, fake-PTY
registration, and public cleanup without private SessionManager access or any
production/SRS lifecycle change.
