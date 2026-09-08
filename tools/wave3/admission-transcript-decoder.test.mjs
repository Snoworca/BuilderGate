import assert from 'node:assert/strict';
import test from 'node:test';
import * as validation from './admission-event-validation.mjs';

// PERF-BGSTAB-010 / SDS-AC-6: pure transcript framing, no child or physical gate.
function decoder() {
  assert.equal(typeof validation.decodeAdmissionTranscript, 'function', 'real decoder export is required');
  return validation.decodeAdmissionTranscript;
}
const version = 'admission-events/v1';
const counts = { tests: 1, suites: 0, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, topLevel: 1 };
const records = () => [
  { schemaVersion: version, type: 'pass', file: '/helper.mjs', name: 'leaf', nesting: 0, details: { type: 'test', failureType: null }, skip: { present: false, value: null }, todo: { present: false, value: null } },
  { schemaVersion: version, type: 'summary', file: '/entry.mjs', success: true, counts },
  { schemaVersion: version, type: 'summary', file: null, success: true, counts },
  { schemaVersion: version, type: 'end', eventCount: 3 },
];
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';

test('AC6 transcript preserves escaped newline Unicode and JSON-standard line whitespace', () => {
  const decode = decoder();
  const value = { text: '한글 😀\nsecond line', slash: '\\' };
  assert.deepEqual(decode(' \t' + JSON.stringify(value) + '\r\n'), [value]);
  assert.deepEqual(decode('null\n42\ntrue\n'), [null, 42, true], 'record semantics belong to evaluateAdmissionEvents');
});

test('AC6 transcript rejects invalid parameters and absent LF framing', () => {
  const decode = decoder();
  for (const input of [undefined, null, 42, {}, [], '', '{}', '{}\r']) assert.throws(() => decode(input));
});

test('AC6 transcript rejects blank lines without trimming or silently dropping records', () => {
  const decode = decoder();
  for (const input of ['\n', ' \t\r\n', '{}\n\n', '\n{}\n', '{}\n \t\n']) assert.throws(() => decode(input));
});

test('AC6 transcript propagates invalid JSON without BOM stripping or syntax repair', () => {
  const decode = decoder();
  for (const input of ['{"x":\n', '{}{}\n', '{"text":"raw\nnewline"}\n', '\uFEFF{}\n', '{}\n\uFEFF{}\n']) {
    assert.throws(() => decode(input), SyntaxError);
  }
});

test('AC6 decoded real record stream reaches existing summary and end validation', () => {
  const decode = decoder();
  const result = validation.evaluateAdmissionEvents(decode(encode(records())), ['/entry.mjs']);
  assert.equal(result.accepted, true); assert.deepEqual(result.reasons, []); assert.deepEqual(result.counts, counts);
});

test('AC6 valid JSON cannot bypass closed record shapes missing end or after-end rejection', () => {
  const decode = decoder();
  for (const rows of [[null], [42], [{}], records().slice(0, -1), [...records(), { schemaVersion: version, type: 'output', stream: 'stdout', text: 'late' }]]) {
    const result = validation.evaluateAdmissionEvents(decode(encode(rows)), ['/entry.mjs']);
    assert.equal(result.accepted, false); assert.ok(result.reasons.length > 0);
  }
});
