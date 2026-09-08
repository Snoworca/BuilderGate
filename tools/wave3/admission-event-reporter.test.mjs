import assert from 'node:assert/strict';
import test from 'node:test';
const schemaVersion = 'admission-events/v1';
const count = (tests = 2, extra = {}) => ({ tests, topLevel: 0, suites: 0, passed: tests, failed: 0, cancelled: 0, skipped: 0, todo: 0, ...extra });
const directive = { present: false, value: null };
const event = (type = 'pass', extra = {}) => ({ schemaVersion, type, file: '/helpers/definition.mjs', name: 'ordinary', nesting: 1, details: { type: 'test', failureType: null }, skip: { ...directive }, todo: { ...directive }, ...extra });
const summary = (file, counts, success = true) => ({ schemaVersion, type: 'summary', file, success, counts });
const end = records => [...records, { schemaVersion, type: 'end', eventCount: records.length }];
const entries = ['/owned/a.test.mjs', '/owned/b.test.mjs'];
const valid = () => end([event(), event('pass', { name: 'ordinary parent', nesting: 0 }), event('complete'), summary(entries[0], count(1)), summary(entries[1], count(1, { topLevel: 1 })), summary(null, count(2, { topLevel: 1 }))]);
const validator = async () => (await import('./admission-event-validation.mjs')).evaluateAdmissionEvents;
const reporter = async () => (await import('./admission-event-reporter.mjs')).default;
async function* source(events) { yield* events; }
async function report(events) { const run = await reporter(); const lines = []; for await (const line of run(source(events))) { assert.equal(typeof line, 'string'); assert.ok(line.endsWith('\n')); lines.push(line); } return lines.map(line => JSON.parse(line)); }

test('admission reporter selects native fields and preserves directive presence and JSON output text', async () => {
  const text = '{"type":"summary","success":true}\nnot a summary';
  const records = await report([
    { type: 'test:pass', data: { file: '/helper.mjs', name: 'test', nesting: 1, details: { type: 'test', duration_ms: 123 }, skip: false, todo: '', secret: 'never serialize' } },
    { type: 'test:stdout', data: { message: text, file: '/helper.mjs' } },
    { type: 'test:stderr', data: { message: 'diagnostic' } },
    { type: 'test:summary', data: { file: entries[0], success: true, counts: { ...count(1), topLevel: 1 }, duration_ms: 2 } },
    { type: 'test:enqueue', data: {} },
  ]);
  assert.deepEqual(records, [
    event('pass', { file: '/helper.mjs', name: 'test', skip: { present: true, value: false }, todo: { present: true, value: '' } }),
    { schemaVersion, type: 'output', stream: 'stdout', text },
    { schemaVersion, type: 'output', stream: 'stderr', text: 'diagnostic' },
    summary(entries[0], count(1, { topLevel: 1 })), { schemaVersion, type: 'end', eventCount: 4 },
  ]);
});

test('admission reporter preserves native failure type and complete as diagnostic only', async () => {
  const records = await report([{ type: 'test:fail', data: { name: 'timeout', nesting: 0, details: { type: 'test', error: { failureType: 'testTimeoutFailure', secret: 'excluded' } } } }, { type: 'test:complete', data: { name: 'timeout', nesting: 0, details: { type: 'test' } } }]);
  assert.deepEqual(records[0], event('fail', { file: null, name: 'timeout', nesting: 0, details: { type: 'test', failureType: 'testTimeoutFailure' } }));
  assert.equal(records[1].type, 'complete'); assert.equal(records[2].eventCount, 2);
});

test('admission reporter source error remains an error without an end record', async () => {
  const run = await reporter(), failure = Error('source failed'), emitted = [];
  async function* broken() { yield { type: 'test:stdout', data: { message: 'partial' } }; throw failure; }
  await assert.rejects(async () => { for await (const line of run(broken())) emitted.push(JSON.parse(line)); }, error => error === failure);
  assert.equal(emitted.some(record => record.type === 'end'), false);
});

test('admission validator reconciles entry summaries root and ordinary nested parent events without helper attribution', async () => {
  const evaluate = await validator(); const result = evaluate(valid(), entries);
  assert.equal(result.accepted, true); assert.deepEqual(result.reasons, []); assert.deepEqual(result.counts, count(2, { topLevel: 1 }));
});

test('admission validator excludes suites from tests but reconciles suite count', async () => {
  const evaluate = await validator();
  const rows = [event('pass', { details: { type: 'suite', failureType: null }, nesting: 0 }), event(), event(), summary(entries[0], count(1, { suites: 1, topLevel: 1 })), summary(entries[1], count(1)), summary(null, count(2, { suites: 1, topLevel: 1 }))];
  const result = evaluate(end(rows), entries); assert.equal(result.accepted, true); assert.deepEqual(result.counts, count(2, { suites: 1, topLevel: 1 }));
});

for (const [label, extra, outcome] of [
  ['skip-before-todo', { skip: { present: true, value: true }, todo: { present: true, value: true } }, 'skipped'],
  ['todo-before-cancel', { todo: { present: true, value: 'later' }, details: { type: 'test', failureType: 'testTimeoutFailure' } }, 'todo'],
  ['cancelled', { details: { type: 'test', failureType: 'cancelledByParent' } }, 'cancelled'],
  ['failed', {}, 'failed'],
]) test(`admission validator native count precedence ${label} remains a failed gate`, async () => {
  const evaluate = await validator(), counts = count(1, { passed: 0, [outcome]: 1 });
  const result = evaluate(end([event('fail', extra), summary(entries[0], counts, false), summary(null, counts, false)]), [entries[0]]);
  assert.equal(result.accepted, false); assert.ok(result.reasons.length); assert.deepEqual(result.counts, counts);
});

test('admission validator rejects summary omissions duplicates unknown entries empty counts and mismatches', async () => {
  const evaluate = await validator();
  const base = valid().slice(0, -1);
  const variants = [base.filter(row => !(row.type === 'summary' && row.file === entries[0])), [...base, summary(entries[0], count(1))], [...base, summary('/foreign/a.test.mjs', count(1))], base.map(row => row.type === 'summary' && row.file === entries[0] ? summary(entries[0], count(0)) : row), base.map(row => row.type === 'summary' && row.file === null ? summary(null, count(3)) : row), base.filter(row => !(row.type === 'summary' && row.file === null))];
  for (const rows of variants) { const result = evaluate(end(rows), entries); assert.equal(result.accepted, false); assert.ok(result.reasons.length); }
});

test('admission validator rejects malformed closed schemas numeric fields and framing tails', async () => {
  const evaluate = await validator();
  const variants = [valid().slice(0, -1), [...valid(), event()], [...valid(), valid().at(-1)], valid().map(row => row.type === 'end' ? { ...row, eventCount: 999 } : row), valid().map((row, i) => i === 0 ? { ...row, extra: true } : row), valid().map((row, i) => i === 0 ? { ...row, nesting: -1 } : row), valid().map((row, i) => i === 0 ? { ...row, skip: { present: false, value: true } } : row), valid().map((row, i) => i === 0 ? { ...row, schemaVersion: 'other' } : row), [...valid().slice(0, -1), '{partial']];
  for (const bad of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) variants.push(valid().map(row => row.type === 'summary' ? { ...row, counts: { ...row.counts, tests: bad } } : row));
  for (const rows of variants) { const result = evaluate(rows, entries); assert.equal(result.accepted, false); assert.ok(result.reasons.length); }
});

test('admission validator output text cannot forge summaries and complete cannot substitute for missing pass events', async () => {
  const evaluate = await validator();
  const rows = valid().slice(0, -1).filter(row => row.type !== 'pass');
  rows.unshift({ schemaVersion, type: 'output', stream: 'stdout', text: JSON.stringify(summary(null, count())) });
  assert.equal(evaluate(end(rows), entries).accepted, false);
});

test('admission validator counts explicit false or empty directives by presence and refuses suite directives', async () => {
  const evaluate = await validator();
  for (const value of [false, '']) {
    const counts = count(1, { passed: 0, skipped: 1 });
    const result = evaluate(end([event('pass', { skip: { present: true, value } }), summary(entries[0], counts), summary(null, counts)]), [entries[0]]);
    assert.equal(result.accepted, false); assert.deepEqual(result.counts, counts);
    const suiteCounts = count(1, { suites: 1, topLevel: 1 });
    assert.equal(evaluate(end([event('pass', { nesting: 0, details: { type: 'suite', failureType: null }, todo: { present: true, value } }), event(), summary(entries[0], suiteCounts), summary(null, suiteCounts)]), [entries[0]]).accepted, false);
  }
});

test('admission reporter refuses unsupported field types before JSON can coerce them to null', async () => {
  await reporter(); // Missing implementation is not evidence of valid field rejection.
  for (const data of [{ nesting: NaN }, { nesting: Infinity }, { skip: 42 }, { todo: {} }, { file: 2 }, { details: { type: 9 } }]) {
    await assert.rejects(report([{ type: 'test:pass', data: { name: 'bad', ...data } }]));
  }
  await assert.rejects(report([{ type: 'test:summary', data: { file: null, success: true, counts: count(NaN) } }]));
});

test('admission validator recognizes native testAborted cancellation', async () => {
  const evaluate = await validator(), counts = count(1, { passed: 0, cancelled: 1 });
  const result = evaluate(end([event('fail', { details: { type: 'test', failureType: 'testAborted' } }), summary(entries[0], counts, false), summary(null, counts, false)]), [entries[0]]);
  assert.equal(result.accepted, false); assert.deepEqual(result.counts, counts);
});

test('admission validator rejects topLevel-only file sum root and independent event mismatches', async () => {
  const evaluate = await validator();
  for (const selected of ['file', 'root', 'both']) {
    const rows = valid().map(row => row.type === 'summary'
      && ((selected !== 'root' && row.file === entries[1]) || (selected !== 'file' && row.file === null))
      ? { ...row, counts: { ...row.counts, topLevel: 2 } } : row);
    const result = evaluate(rows, entries);
    assert.equal(result.accepted, false); assert.ok(result.reasons.length);
  }
});

test('admission validator top-level suite counts once while nested ordinary tests do not add topLevel', async () => {
  const evaluate = await validator();
  const counts = count(2, { suites: 1, topLevel: 1 });
  const rows = end([
    event('pass', { nesting: 0, details: { type: 'suite', failureType: null } }),
    event('pass', { nesting: 1, name: 'ordinary parent' }),
    event('pass', { nesting: 2, name: 'ordinary child' }),
    event('complete', { nesting: 0, details: { type: 'suite', failureType: null } }),
    summary(entries[0], counts), summary(null, counts),
  ]);
  const result = evaluate(rows, [entries[0]]);
  assert.equal(result.accepted, true); assert.deepEqual(result.counts, counts);
});
