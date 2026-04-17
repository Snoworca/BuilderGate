# Integration Test Guide

## Purpose

Validate that backend canonical replay replaces fragile browser-primary scrollback restoration for real user flows.

## Critical Scenarios

1. Refresh with long PowerShell or Codex output
   Expected:
   - history is replayed from the server
   - terminal remains visible
   - no duplicated blank-line gaps appear near the end

2. WS reconnect while user is on a different workspace
   Expected:
   - hidden and visible sessions both recover from backend replay
   - no session collapses to only “recent few lines”

3. Grid-mode and tab-mode parity
   Expected:
   - both view modes can subscribe and replay history
   - switching modes does not lose canonical server history

4. Restarted tab isolation
   Expected:
   - a new session ID does not inherit stale replay or stale browser snapshot content

5. Replay barrier race
   Expected:
   - `history` arrives
   - client clears and replays
   - queued live `output` flushes only after `history:ready`
   - no interleaving or duplication occurs

6. Replay timeout cleanup
   Expected:
   - a stalled client does not accumulate unbounded pending output
   - timeout cleanup preserves overall system boundedness
   - a fresh subscribe can still rebuild from canonical replay

## Integration Matrix

| Component | Contract |
|-----------|----------|
| `SessionManager` | produce bounded replay snapshot |
| `WsRouter` | deliver `history`, hold replay barrier, flush queued output after `history:ready` |
| `WebSocketContext` | route `history` and replay lifecycle |
| `TerminalContainer` | choose history vs fallback snapshot and manage replay state |
| `TerminalView` | clear, write history, flush buffered live output |

## Test Code Targets

- server unit tests for replay append, truncation, filtering
- protocol-level tests for subscribe ordering and duplicate subscribe idempotency
- protocol-level tests for mixed batch subscribe semantics
- Playwright tests for refresh and reconnect recovery
- targeted ordering test for `history` / `history:ready` / `output` race
- timeout test for replay-pending cleanup

## Requirement Trace

- `FR-001` through `FR-004`: server unit and protocol tests
- `FR-005` through `FR-007`: frontend integration and E2E
- `FR-008`: final regression suite plus manual checklist
