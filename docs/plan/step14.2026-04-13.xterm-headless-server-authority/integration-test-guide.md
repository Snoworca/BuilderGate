# Integration Test Guide

## Purpose

Validate that server-authoritative headless snapshots replace both raw replay tails and browser-primary snapshots for the user-visible terminal lifecycle.

## Critical Scenarios

1. Refresh while a long PowerShell session is idle on the prompt
   Expected:
   - current screen is restored from the server
   - no collapse to recent tail only

2. Refresh while a Codex-style session is actively writing
   Expected:
   - snapshot is applied first
   - replay gate flushes pending live output in order

3. Reconnect while an alternate-screen application is active
   Expected:
   - the active screen is restored
   - no fallback to stale normal-screen text tail

4. Resize, then refresh or reconnect
   Expected:
   - restored geometry matches server geometry
   - wrapped content is based on the new size, not the old one

5. Restart tab during or after a replay-pending state
   Expected:
   - old session lineage is gone
   - new session starts clean with a new snapshot path

6. Delete workspace with multiple active sessions
   Expected:
   - all headless state and replay queues are released
   - no stale output appears after deletion

7. Degraded headless session fallback
   Expected:
   - session stays usable live
   - logs or counters show the degraded state clearly

8. Codex-driven long scrollback across workspace switches
   Expected:
   - launch `codex` in one workspace terminal
   - enter `1부터 300까지 종 방향으로 출력하시오`
   - after moving to another workspace and back, the first workspace still retains deep scrollback
   - after refresh, the restored screen still corresponds to the same long vertical output rather than a recent tail only

## Integration Matrix

| Component | Contract |
|-----------|----------|
| `SessionManager` | owns PTY plus headless state and returns authoritative snapshots |
| `WsRouter` | sends `screen-snapshot`, enforces replay tokens, flushes queued output |
| `WorkspaceService` | clears authority state on delete, restart, and recovery |
| `WebSocketContext` | routes snapshot and token-based acknowledgements |
| `TerminalContainer` | applies server snapshot before live output |
| `TerminalView` | clear-and-write snapshot boundary plus live-output buffering |
| `SettingsService` | applies the migrated scrollback and snapshot settings |

## Test Code Targets

- server unit tests for snapshot cache, degraded sessions, resize invalidation, and cleanup
- router tests for tokenized ordering, stale acknowledgements, duplicate subscribe, and bounded queues
- Playwright tests for refresh, reconnect, tab mode, grid mode, restart, and delete
- one refresh/workspace-switch regression that uses a real `codex` prompt with long vertical output
- at least one alternate-screen regression test using deterministic escape sequences

## Requirement Trace

- `BG-001`: phases 2, 3, 4, 5
- `BG-002`: phases 3, 4, 5
- `BG-003`: phases 2, 5
- `FR-001` to `FR-002`: phase 2
- `FR-003` to `FR-007`: phase 3
- `FR-008` to `FR-010`: phase 4
- `FR-011` to `FR-012`: phases 2 and 5
