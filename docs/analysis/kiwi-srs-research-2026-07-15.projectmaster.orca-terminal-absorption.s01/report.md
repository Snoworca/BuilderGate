# Orca terminal absorption research report

Run: `2026-07-15.projectmaster.orca-terminal-absorption.s01`

Mode: standalone, question-only

Topology: valid core roles 5 (clean-room triage + isolated researchers 3 + synthesizer), unique subagents executed 7 including two discarded/validation runs

Workflow status: standalone dissent/persistence user decision pending. SRS mutation and final pipeline event have not been emitted.

## Verdict

Orca의 상수나 Electron 전제를 복사하지 않고, BuilderGate의 WebSocket/WAN 조건에 맞춰 compatibility facade, authority-first model, bounded snapshot recovery, per-client/per-session fairness, model-ingestion 이후 hidden delivery, 통합 clipboard/input ownership 순으로 교체한다.

## Result counts

- Consensus findings: 6
- Preserved dissent findings: 6
- SRS mutations: 0, pending the standalone user decision gate
- Rejected unsupported findings: 6

## Primary user document

`docs/research/2026-07-15.orca-terminal-stack-absorption-research-and-implementation-plan.ko.md`

## Verification snapshot

- UTF-8/JSON/source-quote/table guard: pass; 39/39 source quotes matched literally.
- Server TypeScript and frontend typecheck: pass.
- Safe-send priority and transport parser: 11/11 pass.
- Focused frontend terminal units: 79/80 pass; the remaining source-contract fixture truncates its 900-character slice immediately before an existing production call.
- Split handshake/routing diagnostic: 3/16 pass, reproducing the documented production/test drift.
- SpecKiwi validation: 0 errors, 1 unrelated draft warning (`REL-BGSTAB-005`).

## Audit files

- `preflight.json`
- `subject.json`
- `triage.json`
- `agent-manifest.json`
- `research-raw/code-research.json`
- `research-raw/external-research.json`
- `research-raw/risk-research.json`
- `research-summary.json`
- `mutation-log.json`
- `rejected_findings.log`

자동 source-quote 검증은 100% 무결성을 보장하지 않는다. 핵심 finding과 수치의 표본 검토가 필요하다.
