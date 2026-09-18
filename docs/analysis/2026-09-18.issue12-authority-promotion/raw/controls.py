import json, sys
c = json.load(open('docs/analysis/2026-09-18.issue12-authority-promotion/raw/ac-corpus.json', encoding='utf-8'))
rows = c['rows']
print(f"corpus: {c['requirementCount']} requirements / {c['acRowCount']} AC rows")
def rep(req):
    rs = [r for r in rows if r['req'] == req]
    return f"{req}: {len(rs)} ACs, checked={sum(1 for r in rs if r['checked'])}"
print('CONTROL A', rep('MIG-BGSTAB-002'))
print('CONTROL B', rep('REL-BGSTAB-007'))
print('CONTROL B2', rep('REL-BGSTAB-011'))
print('CONTROL B3', rep('MIG-BGSTAB-005'))
for term in ['epoch', 'rollback', 'dedup', 'lease', 'responder', 'poisoned', 'exactly-once', 'ledger', 'ZZZ-does-not-exist-QQ']:
    hits = [r for r in rows if term.lower() in r['text'].lower()]
    reqs = sorted({r['req'] for r in hits})
    print(f"CONTROL C  {term!r}: {len(hits)} hits across {len(reqs)} requirements -> {reqs[:12]}")
