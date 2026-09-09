# Per-task evidence fields

Use this structure in the existing task report. Do not copy it into a competing master ledger.

```text
Task ID / original master item:
Requirement ID / AC / current Status and Stability:
Kind: decision / RED / implementation / verification / external gate
Root / common-dir / branch / HEAD:
Exact changed files and symbols:
Original defect and resulting behavior:
Frozen contract and preserved invariants:
RED: command/cwd/env, actual reason, counts/exit, raw path/SHA, test commit
GREEN: command/cwd/env, counts/exit, raw path/SHA
Types/regression: actual project/config/file set, excluded/unverified scope
Independent reviewer: role, findings, corrections, final verdict
Provenance/process: before/after hashes, natural close, preservation
SRS evidence: tool/workspace/id/read-back or reason not applicable
Full commit SHA / official worklog read-back:
Precisely completed scope:
Unfinished items and decisions:
Next task / exact first command or source symbol:
```

Decision tasks do not invent test results. Implementation tasks do not substitute intention for GREEN. Code review and actual execution are separate evidence dimensions.
