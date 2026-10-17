import json, hashlib, datetime, os
p = 'kiwi/orchestrator/2026-10-17.ProjectMaster.mobile-terminal-keyboard/lane-2026-10-17.projectmaster.mobile-terminal-keyboard-wave-1/deferred-srs.jsonl'
os.makedirs(os.path.dirname(p), exist_ok=True)
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
E = 'frontend/tests/unit/mobileKeyEncoder.test.ts'
L = 'frontend/tests/unit/mobileModifierLatch.test.ts'
R = 'frontend/tests/unit/terminalMobileLatchOnData.test.ts'
calls = []
def ev(i, ref, cov, notes):
    calls.append({"tool": "add_verification_evidence", "args": {"id": i, "type": "test", "reference": ref, "covers": cov, "notes": notes}})
ev("FR-MKB-001", E, "AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8", "npm run test:unit:mobile-keyboard (frontend) 28/28 pass; SDS-AC-1..4")
ev("FR-MKB-002", L, "AC-1, AC-2, AC-3, AC-4, AC-5, AC-6", "npm run test:unit:mobile-keyboard (frontend) 28/28 pass; SDS-AC-5..8, node:test mock timers")
ev("FR-MKB-003", L, "AC-1, AC-3", "applyLatchToTypedData unit tests; SDS-AC-9")
ev("FR-MKB-003", R, "AC-1, AC-2, AC-3, AC-4, AC-5", "npm run test:unit:terminal-view-behavior 28/28 pass; rendered TerminalView onData, submission observed via terminal_input_queued debug event; SDS-AC-10, SDS-AC-11")
ev("IR-MKB-001", R, "AC-1, AC-2", "handle getter mirrors fake term.modes; container forward pinned by source text; SDS-AC-12")
for i, f in [("FR-MKB-001", "frontend/src/utils/mobileKeyEncoder.ts"),
             ("FR-MKB-002", "frontend/src/utils/mobileModifierLatch.ts"),
             ("FR-MKB-003", "frontend/src/utils/mobileModifierLatch.ts"),
             ("FR-MKB-003", "frontend/src/components/Terminal/TerminalView.tsx"),
             ("IR-MKB-001", "frontend/src/components/Terminal/TerminalView.tsx"),
             ("IR-MKB-001", "frontend/src/components/Terminal/TerminalContainer.tsx")]:
    calls.append({"tool": "add_trace_link", "args": {"id": i, "type": "Code", "reference": f, "relation": "implements"}})
with open(p, 'a') as fh:
    for c in calls:
        h = hashlib.sha1(json.dumps(c["args"], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        c.update({"args_hash": h, "ok": None, "dry_run": False, "called_at": now, "deferred": True})
        fh.write(json.dumps(c, ensure_ascii=False) + "\n")
print(len(calls))
