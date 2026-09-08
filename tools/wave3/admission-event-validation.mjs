// PERF-BGSTAB-010 / SDS-AC-3/6: only native result events contribute to counts.
export const ADMISSION_SCHEMA_VERSION = 'admission-events/v1';
export const ADMISSION_COUNT_KEYS = Object.freeze([
  'tests', 'suites', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'topLevel',
]);
const cancelledTypes = new Set(['cancelledByParent', 'testAborted', 'testTimeoutFailure']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const textOrNull = value => value === null || typeof value === 'string';
const keys = (value, expected) => object(value)
  && Object.keys(value).length === expected.length
  && expected.every(key => Object.hasOwn(value, key));
const emptyCounts = () => Object.fromEntries(ADMISSION_COUNT_KEYS.map(key => [key, 0]));

function directive(value) {
  return keys(value, ['present', 'value']) && typeof value.present === 'boolean'
    && (value.present ? typeof value.value === 'boolean' || typeof value.value === 'string' : value.value === null);
}

export function admissionRecordError(record) {
  if (!object(record) || record.schemaVersion !== ADMISSION_SCHEMA_VERSION) return 'invalid event schema';
  const base = ['schemaVersion', 'type'];
  switch (record.type) {
    case 'summary':
      return keys(record, [...base, 'file', 'success', 'counts'])
        && textOrNull(record.file) && typeof record.success === 'boolean'
        && keys(record.counts, ADMISSION_COUNT_KEYS)
        && ADMISSION_COUNT_KEYS.every(key => integer(record.counts[key]))
        && record.counts.tests === record.counts.passed + record.counts.failed
          + record.counts.cancelled + record.counts.skipped + record.counts.todo
        && record.counts.topLevel <= record.counts.tests + record.counts.suites ? null : 'invalid summary';
    case 'pass':
    case 'fail':
    case 'complete':
      return keys(record, [...base, 'file', 'name', 'nesting', 'details', 'skip', 'todo'])
        && textOrNull(record.file) && textOrNull(record.name)
        && (record.nesting === null || integer(record.nesting))
        && keys(record.details, ['type', 'failureType'])
        && textOrNull(record.details.type) && textOrNull(record.details.failureType)
        && directive(record.skip) && directive(record.todo) ? null : 'invalid test result';
    case 'output':
      return keys(record, [...base, 'stream', 'text'])
        && ['stdout', 'stderr'].includes(record.stream) && typeof record.text === 'string' ? null : 'invalid output';
    case 'end':
      return keys(record, [...base, 'eventCount']) && integer(record.eventCount) ? null : 'invalid end';
    default:
      return 'unknown event type';
  }
}

export function decodeAdmissionTranscript(text) {
  if (typeof text !== 'string' || text.length === 0 || !text.endsWith('\n')) {
    throw new Error('Admission transcript must be nonempty and LF-terminated');
  }
  return text.slice(0, -1).split('\n').map((line, index) => {
    if (line.trim().length === 0) throw new Error(`Blank admission record at line ${index + 1}`);
    return JSON.parse(line);
  });
}

export function evaluateAdmissionEvents(records, expectedEntryFiles) {
  const counts = emptyCounts(), reasons = [];
  const verdict = () => ({ accepted: reasons.length === 0, reasons, counts });
  if (!Array.isArray(records) || !Array.isArray(expectedEntryFiles) || expectedEntryFiles.length === 0
      || expectedEntryFiles.some(file => typeof file !== 'string' || file.length === 0)
      || new Set(expectedEntryFiles).size !== expectedEntryFiles.length) {
    reasons.push('invalid records or expected entry files');
    return verdict();
  }
  const expected = new Set(expectedEntryFiles), summaries = new Map();
  let root = null, ends = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index], error = admissionRecordError(record);
    if (error) { reasons.push(`record ${index}: ${error}`); continue; }
    if (record.type === 'end') {
      ends++;
      if (index !== records.length - 1 || record.eventCount !== index) reasons.push('invalid end position or count');
      continue;
    }
    if (record.type === 'summary') {
      if (!record.success) reasons.push(`unsuccessful summary: ${record.file ?? 'root'}`);
      if (record.file === null) {
        if (root) reasons.push('duplicate root summary');
        else root = record;
      } else {
        if (!expected.has(record.file)) reasons.push(`unexpected entry: ${record.file}`);
        else if (summaries.has(record.file)) reasons.push(`duplicate entry summary: ${record.file}`);
        else summaries.set(record.file, record);
        if (record.counts.tests === 0) reasons.push(`empty entry: ${record.file}`);
      }
      for (const key of ['failed', 'cancelled', 'skipped', 'todo']) {
        if (record.counts[key] !== 0) reasons.push(`summary contains ${key}: ${record.file ?? 'root'}`);
      }
      continue;
    }
    if (record.type !== 'pass' && record.type !== 'fail') continue;
    if (record.type === 'fail') reasons.push('failed test event');
    if (record.skip.present || record.todo.present) reasons.push('skip or TODO directive');
    if (record.type === 'pass' && record.details.failureType !== null) reasons.push('pass event carries a failure');
    if (record.nesting === 0) counts.topLevel++;
    if (record.details.type === 'suite') { counts.suites++; continue; }
    counts.tests++;
    if (record.skip.present) counts.skipped++;
    else if (record.todo.present) counts.todo++;
    else if (cancelledTypes.has(record.details.failureType)) counts.cancelled++;
    else if (record.type === 'fail') counts.failed++;
    else counts.passed++;
  }
  if (ends !== 1) reasons.push('missing or duplicate end');
  if (!root) reasons.push('missing root summary');
  for (const file of expected) if (!summaries.has(file)) reasons.push(`missing entry summary: ${file}`);
  const sum = emptyCounts();
  for (const record of summaries.values()) {
    for (const key of ADMISSION_COUNT_KEYS) sum[key] += record.counts[key];
  }
  for (const key of ADMISSION_COUNT_KEYS) {
    if (!integer(sum[key]) || sum[key] !== counts[key] || (root && root.counts[key] !== counts[key])) {
      reasons.push(`inconsistent ${key} count`);
    }
  }
  if (counts.tests === 0) reasons.push('no completed tests');
  return verdict();
}
