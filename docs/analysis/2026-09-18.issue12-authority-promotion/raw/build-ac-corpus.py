import json, re, glob, sys, hashlib, os
files = sorted(glob.glob('docs/spec/*.srs.md'))
req_re = re.compile(r'^#{2,6}\s+(?:Requirement\s+)?([A-Z]{2,4}-[A-Z0-9]+-\d{3})\b(.*)$')
ac_re  = re.compile(r'^\s*-\s*\[( |x|X)\]\s*(AC-\d+)\s*[:.]?\s*(.*)$')
rows, reqs, cur = [], {}, None
for f in files:
    for i, line in enumerate(open(f, encoding='utf-8'), 1):
        m = req_re.match(line.rstrip('\n'))
        if m:
            cur = m.group(1); reqs.setdefault(cur, {'file': f, 'line': i, 'acs': 0}); continue
        m = ac_re.match(line.rstrip('\n'))
        if m and cur:
            rows.append({'req': cur, 'ac': m.group(2), 'checked': m.group(1).lower() == 'x',
                         'text': m.group(3).strip(), 'file': f, 'line': i})
            reqs[cur]['acs'] += 1
out = {'files': files, 'requirementCount': len(reqs), 'acRowCount': len(rows),
       'requirements': reqs, 'rows': rows}
json.dump(out, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('files', len(files), 'requirements', len(reqs), 'acRows', len(rows))
