# Subagent Summary

Five read-only subagents inspected the problem:

1. Frontend: found the placeholder write path in `TerminalContainer` and `TerminalView`; recommended deduped or non-destructive empty fallback handling while preserving ACK and recovery-pending semantics.
2. Server: found degraded headless snapshots always return empty data and that degraded headless can be permanent for a session; recommended degraded replay data/diagnostic improvements and fallback refresh suppression.
3. Protocol: found ACK flushes queued output but timeout deletes pending replay state without flushing queued output; recommended timeout output preservation.
4. Tests: found current tests lock empty degraded snapshots and placeholder recovery guards, but do not cover repeated placeholder suppression or ACK timeout output preservation.
5. SRS: found existing BGSTAB requirements are related but insufficient; recommended new `FR-BGSTAB-018` plus optional observability companion.

