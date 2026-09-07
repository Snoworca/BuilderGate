# Checkout raw-byte provenance boundary

- Date: 2026-09-08 KST; Requirement ID: N/A (operational audit, not SRS verification evidence).
- Trigger: normal Git clean/checkout conversion changes hashes of the six pinned source files, and automated regression also reproduces changes to current authority JSON bytes.
- Workspace/common-dir: C:/Work/git/_Snoworca/ProjectMaster and its .git; branch work/mcp-session-orchestration-20260709; HEAD ed037694735e113ac40d0bf5c8c2ea167a330cfc.
- MCP workspace: same root, package2.13.1, sdd, activeTarget wave-5. Workflow run/event/idempotency: not used; this event is Git byte-reproduction testing for P2b publication. No missing workflow response or repair is alleged.
- User-owned files: same seven untracked paths/hashes in the prior raw source-boundary audit; none adopted or modified. No source/index/artifact edits were made by the checkout probe, only Temp evidence and unreferenced Git blobs.

## Identical raw packet for independent roles

- core.autocrlf=true from system Git configuration; source paths have text/eol/filter unspecified. Current six source files are all LF.
- Current source digest: 78c951ac5b80067538270e8b52bf89fc5f2079aa76ba9703589555af23361236.
- Normal checkout source digest: 960926e54d69d5ac869b7e024997fad13859b61ae10aa86dcb2c692cd45707cb.
- Source raw/clean/checkout SHA256 and EOL counts: C:/Users/beom/AppData/Local/Temp/buildergate-p2b-checkout-roundtrip.json.
- Current generation d77cef68372a6a4d1354b2e537b9adf116a433db40339b0067352574408f57ee passed current-worktree/built-bundle integrity and 68/68 regression; this is a separate checkout-reproducibility failure, not a reversal of that observation.
- New regression: server/tools/fair-scheduler-checkout-provenance.test.mjs. It reads the built source inventory and current authority JSON inventory, runs actual Git clean/smudge with core.autocrlf=true using temporary blobs, and compares raw SHA256 without altering files/index/worktrees.
- RED command: node --test server/tools/fair-scheduler-checkout-provenance.test.mjs; exit1. Raw log: C:/Users/beom/AppData/Local/Temp/buildergate-checkout-provenance-red.log. Product attributes have not been changed yet.
- Existing source/body digest functions hash raw UTF-8 text; current JSON manifests hash raw UTF-8 bytes. Existing authority artifact bytes have LF endings emitted by supported writers.

## Proposed minimal recovery to judge

- Add .gitattributes rules text eol=lf for the six source paths declared by the source-provenance writer, plus docs/analysis/terminal-fairness-authority/**/*.json.
- Do not change hash algorithms, replace digests, relax thresholds, rewrite existing source/artifact bytes or change global/user Git config.
- Re-run the actual checkout regression, verify source6/current19 JSON hashes unchanged and ordinary checkout hashes equal, then recheck current source/built authority integrity and necessary regression.
- If bytes truly remain unchanged, the existing new generation remains valid and does not need synthetic republication; otherwise treat the changed fingerprint through the supported publication path again.
- Source requirements for eventual implementation evidence: PERF-BGSTAB-010 AC-3/4 and PERF-BGSTAB-011 AC-7. This incident itself is only operational audit.

## Decisions

- Audit/tool integrity (analysis_review): CONSENT; actual clean/smudge test is non-vacuous; keep raw hashes/thresholds/global Git config unchanged.
- Preservation/provenance (baseline_a): CONSENT; source6 and authority JSON451 are LF already, user hashes unchanged; no byte rewriting required.
- SRS/integration (requirements_mapping): CONSENT; scoped attributes preserve PERF010 AC3/4 and PERF011 AC7 reproducibility; do not expand into binary adoption evidence.
- No attribute mutation/adoption/completion until three independent explicit consents, with Critical/High0 for the selected recovery. Keep each conclusion private until all three return.

## Recovery/read-back

- Three independent consents collected before circulation, each Critical/High0 for this recovery. Applied exactly7 attribute rules; source/artifact bytes and hash algorithms were not changed.
- Actual regression passed27/27: source6 + currentJSON19 +2 parent tests; no fail/skip/todo/cancelled. Raw log C:/Users/beom/AppData/Local/Temp/buildergate-checkout-provenance-green.log SHA2562A49AD77382E8663BC0366B1ED9AAA54FC29DA0295401BA576101A1DC27D712C.
- npm run build after attributes exited0 and retained the same d77 generation/19-file bundle (tool process10310, completion d9655f).
- Audit post-check CONSENT: actualattributes/sourcehashes/digests and source/built19-byte-equality/resolvers all verified.
- Preservation post-check CONSENT: source6/user7/current19/oldgeneration unchanged; unrelated paths remain without forcedattributes.
- Integration post-check No findings: previous68/68 and tsc remain valid because product bytes unchanged; approved P2b scoped completion. All post-check roles operated read-only.
