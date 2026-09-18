import json
c = json.load(open('docs/analysis/2026-09-18.issue12-authority-promotion/raw/ac-corpus.json', encoding='utf-8'))
rows = c['rows']
terms = {
 'AC-2 zero-window':  ['동시 활성', '동시에 활성', 'overlap', '구간이 0', '하나만 활성'],
 'AC-4 ledger tuple': ['valueHash', 'factType', 'ordinal', 'sourceSeq', 'dedup', '중복 제거'],
 'AC-8 silent/zero':  ['silent', '정확히 1회', 'exactly-once', '0회', '관측 가능한 정책'],
 'AC-11 ledger hold': ['dedup ledger', 'ledger', 'epoch 안정', '유지'],
 'AC-9 repeat fact':  ['반복 fact', '같은 chunk', '여러', '복수'],
 'AC-10 idle':        ['local echo', 'prompt redraw', 'ticker', 'running', 'idle'],
 'AC-7 sizes':        ['10,000', '1,000', '2MiB', 'multibyte', 'reorder'],
 'control-zero':      ['QQZZ-nonexistent-term'],
}
for label, ts in terms.items():
    print('==', label)
    for t in ts:
        hits = [r for r in rows if t.lower() in r['text'].lower()]
        reqs = sorted({r['req'] for r in hits})
        print(f"   {t!r:24} {len(hits):3} hits / {len(reqs):2} reqs  {reqs[:8]}")
