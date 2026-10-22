---
run_id: 2026-10-18.projectmaster.self-w3post
mode: self
mode_flags: [--auto, --no-pipeline-emit]
self_scope: { source: base-head, commit_range: 00321a55..b95046ff, files: 2, excluded_prose: [], refused_artifacts: [], unclassified_files: [] }
findings_total: 2
classified: { immediate_fix: 0, discussion_needed: 0, rejected: 2 }
fix_iter: 0
recheck_iter: 0
regression_pass: true
test_sufficiency: no-scope
closed_reqs_count: null
pr_responded: false
---
Coverage: mobileKeyboardModel.ts 3/3 anchors, mobileKeyboardModel.test.ts 1/1 anchor (verified against git diff -U0).
Regression: mobileKeyboardModel.test.ts 15/15, test:unit:mobile-keyboard 54/54.
Rejected: see rejected_findings.log (F1 MEDIUM landscape terminal squeeze = AC-2 intended; F2 LOW magic number).
