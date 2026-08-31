# PH-006 Fair delivery scheduler and ACK credit — verification report

- Requirement: `PERF-BGSTAB-010` (Status at review start: `in_progress`, Stability: `evolving`)
- Plan tasks: `T-PH006-01` through `T-PH006-07`
- Decision artifact: [fair-scheduler-decision.json](../fair-scheduler-decision.json), digest `8ba1599be0e86a0a958d5696a08d3216e8924411e95fd5e85bcff389776cd141`

## Delivered contract

- The server keeps per-client/per-session fair-delivery credit and emits a control-only ACK only after the browser's terminal write is accepted.
- Fair wire envelopes retain `screenSeq`, authority epoch/revision, and chunk identity; unsubscribing or terminating a session removes its queued lane, credit, and timer.
- Delivery capability fails closed when hidden-output loss cannot be recovered. The current browser explicitly advertises `supportsHiddenDataGapRecovery: false`, retaining legacy delivery until PH-007 supplies server `dataGap`/reveal recovery.
- Restore-pending terminal output retains its accepted-write callback, so a post-restore write still returns exactly one ACK; rejected or skipped output does not return credit.
- The HTTPS browser evidence uses an isolated PowerShell workspace. It proves one visible identified delivery produces one ACK and leaves the interactive session `idle`.

## Evidence

| Check | Result |
| --- | --- |
| `npm run typecheck` and 78 focused recovery contracts | pass |
| `npx playwright test tests/e2e/wave3-terminal-authority-fairness.spec.ts --project "Desktop Chrome"` at `https://localhost:2222` | 6 passed |
| `node tools/wave3/fair-scheduler-decision.test.mjs` | pass |
| Server production build (`tsc`) | pass |
| Fair scheduler/router regression, single concurrency | 76 pass, 14 documented TODO, 0 fail |
| `TerminalResourcePolicyCanary` filtered to `PERF-BGSTAB-010` | 3 passed |
| `node tools/wave3/terminal-resource-consumer-manifest.test.mjs` | pass; 80 tuples, 29 keys, manifest `1d6dcff51115ed5760cf6a9f30a169060d052d46feaf465ec1d205d79f5bd155` |

The first parallel server run hit a Windows `tsx` worker initialization error (`EINVAL`) after individual assertions had run. Re-running the identical set with `--test-concurrency=1` completed with exit 0; the documented split-mode limitations remain TODO and are not counted as failures.

## Rollback and next gate

Closing capability admission or withdrawing capability releases the fair ledger, queue, and timer and resumes legacy FIFO safe-send on a new connection epoch. PH-007 owns hidden `dataGap`/authoritative reveal recovery; PH-006 deliberately does not claim hidden loss recovery.
