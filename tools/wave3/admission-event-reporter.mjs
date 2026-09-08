import { ADMISSION_SCHEMA_VERSION, ADMISSION_COUNT_KEYS, admissionRecordError } from './admission-event-validation.mjs';

// PERF-BGSTAB-010 / SDS-AC-6: project native events, never parse child output.
const progressTypes = new Set(['test:enqueue', 'test:dequeue', 'test:start', 'test:plan', 'test:diagnostic', 'test:coverage']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const optional = value => value === undefined ? null : value;
const directive = value => ({ present: value !== undefined, value: optional(value) });

export default async function* admissionEventReporter(source) {
  let eventCount = 0;
  for await (const event of source) {
    if (!object(event) || typeof event.type !== 'string' || !object(event.data)) {
      throw new Error('Invalid native admission event');
    }
    const data = event.data;
    let record;
    const schemaVersion = ADMISSION_SCHEMA_VERSION;
    if (['test:pass', 'test:fail', 'test:complete'].includes(event.type)) {
      if (data.details !== undefined && !object(data.details)) throw new Error('Invalid native event details');
      if (data.details?.error !== undefined && !object(data.details.error)) throw new Error('Invalid native event error');
      record = {
        schemaVersion, type: event.type.slice(5), file: optional(data.file), name: optional(data.name),
        nesting: optional(data.nesting),
        details: { type: optional(data.details?.type), failureType: optional(data.details?.error?.failureType) },
        skip: directive(data.skip), todo: directive(data.todo),
      };
    } else if (event.type === 'test:summary') {
      if (!object(data.counts)) throw new Error('Invalid native summary counts');
      record = {
        schemaVersion, type: 'summary', file: optional(data.file), success: data.success,
        counts: Object.fromEntries(ADMISSION_COUNT_KEYS.map(key => [key, data.counts[key]])),
      };
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      record = { schemaVersion, type: 'output', stream: event.type.slice(5), text: data.message };
    } else if (progressTypes.has(event.type)) {
      continue;
    } else {
      throw new Error(`Unsupported native admission event: ${event.type}`);
    }
    const error = admissionRecordError(record);
    if (error !== null) throw new Error(error);
    yield `${JSON.stringify(record)}\n`;
    eventCount++;
  }
  const end = { schemaVersion: ADMISSION_SCHEMA_VERSION, type: 'end', eventCount };
  const error = admissionRecordError(end);
  if (error !== null) throw new Error(error);
  yield `${JSON.stringify(end)}\n`;
}
