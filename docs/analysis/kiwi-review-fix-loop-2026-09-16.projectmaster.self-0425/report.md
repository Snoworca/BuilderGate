---
run_id: 2026-09-16.projectmaster.self-0425
mode: self
mode_flags: ["--auto"]
pr_url: null
scope: commits 8ba0bad..HEAD (issue #26 lane)
rounds: 2
findings_total: 22
classified: { immediate_fix: 21, discussion_needed: 0, rejected: 1 }
regression_pass: true
closed_reqs_count: null
pr_responded: false
---

# kiwi-review-fix-loop — issue #26 lane

Self mode. The working tree was deliberately frozen before each review round, so the
scope was a commit range rather than `git status`.

## Round 1 — 16 findings (0 CRITICAL, 3 HIGH, 7 MEDIUM, 6 LOW)

P1 (factual accuracy of code citations) came back clean: all fifteen cited file:line
locations were exact. The three HIGH findings were all in reasoning, not in citation.

| Finding | Verdict after independent verification |
| --- | --- |
| FND-001 retry-budget reset surface understated | accepted — verified at `TerminalContainer.tsx:1111-1136`; the effect's own comment says it re-runs on callback identity change |
| FND-002 "refuse to mint is outcome-neutral" is false | accepted — verified at `TerminalAuthorityProductionAdapter.ts:1990`; the payload is transmitted before the browser rejects |
| FND-003 severity stated without its density precondition | accepted — new measurement showed 8 SGR runs/line at 200 columns reaches only 63.7% |
| FND-004…FND-014, FND-016 | accepted, fixed |
| FND-015 harness not re-runnable in place | **conclusion accepted, suggested fix rejected** — see `rejected_findings.log` |

## Round 2 — 12 resolved, 2 partial, 1 unresolved, 6 new (1 HIGH)

Round 2 found that the round-1 fixes had introduced problems of their own, and that one
correction had replaced a wrong number with a differently wrong number.

| Finding | Verdict |
| --- | --- |
| FND-101 HIGH — the two new evidence files had no committed producer | accepted; `density-and-crossover-harness.ts` written and committed, and every raw artifact now names its producer in §8 |
| FND-102 / FND-011 — crossover overprecise, and the doc's own bias argument contradicted it | **accepted, and it exposed an error of mine**: the "1/1501" explanation of the projection error was adopted from round 1 without verification and is wrong (real ratio 1.000567, constant across three geometries). The crossover is now measured directly, not projected |
| FND-103 — the worklog row still carried three pre-review claims | accepted, rewritten |
| FND-104 — "~25 runs per line" understated the generator | accepted; derived from the generator as ~34 |
| FND-105 — truncated section heading | accepted |
| FND-106 — `rejected_findings.log` untracked | accepted; the directory needed its own `.gitignore` negation because the root ignores `*.log` |

A second defect of mine surfaced while fixing FND-103: the round-1 worklog edit used
`json.dumps` defaults and silently converted the row from the canonical compact form to a
spaced one. Restored to compact.

## Why two rounds and not more

Round 2's HIGH was a provenance gap, not a reasoning error, and its substantive finding
(FND-102) was closed by replacing an inference with a measurement rather than by rewording.
Both classes are terminal: there is no further inference left to challenge on the crossover
number, because it is now read off a direct full-scrollback run.

## Regression

- `npx tsc --noEmit -p tsconfig.json` (cwd `server/`) — exit 0
- `npm run test:checkpoint-mint-size` (cwd `server/`) — 3 pass, 0 fail
- `npx tsx src/test-runner.ts` (cwd `server/`) — 3 failures, all pre-existing and reproduced in another lane's baseline log at the same HEAD

## Residual

Nothing CRITICAL or HIGH outstanding. The lane's substantive conclusion did not change
across either round; what changed is that two numbers and three rationales that were
asserted more confidently than the evidence supported are now either measured or
qualified.
