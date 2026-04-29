import type { InputDebugMetadata } from '../types/ws-protocol.js';

export type InputDebugValue = string | number | boolean | null;

const DEBUG_CAPTURE_PREVIEW_CHARS = 320;
const HANGUL_RE = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/u;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

interface GraphemeCountResult {
  count: number;
  approximate: boolean;
}

export function buildInputDebugDetails(
  raw: string,
  clientMetadata?: InputDebugMetadata,
): Record<string, InputDebugValue> {
  const safePreview = formatSafeInputPreview(raw);
  const spaceCount = (raw.match(/ /g) ?? []).length;
  const backspaceCount = (raw.match(/\x7f/g) ?? []).length;
  const enterCount = (raw.match(/[\r\n]/g) ?? []).length;
  const escapeCount = (raw.match(/\x1b/g) ?? []).length;
  const controlCount = (raw.match(/[\x00-\x1f\x7f]/g) ?? []).length;
  const codePointCount = Array.from(raw).length;
  const printableCount = Math.max(0, codePointCount - controlCount);
  const grapheme = countGraphemes(raw);
  const inputClass = classifyInput(safePreview !== null, controlCount, printableCount);

  return {
    ...sanitizeClientInputDebugMetadata(clientMetadata),
    byteLength: Buffer.byteLength(raw, 'utf8'),
    codePointCount,
    graphemeCount: grapheme.count,
    graphemeApproximate: grapheme.approximate,
    hasHangul: HANGUL_RE.test(raw),
    hasCjk: CJK_RE.test(raw),
    hasEnter: enterCount > 0,
    spaceCount,
    backspaceCount,
    enterCount,
    escapeCount,
    controlCount,
    printableCount,
    inputClass,
    containsPrintable: printableCount > 0,
    safePreview: safePreview !== null,
  };
}

export function sanitizeClientInputDebugMetadata(metadata?: InputDebugMetadata): Record<string, InputDebugValue> {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  const sanitized: Record<string, InputDebugValue> = {};
  copySafeInteger(metadata, sanitized, 'captureSeq');
  copySafeInteger(metadata, sanitized, 'compositionSeq');
  copySafeInteger(metadata, sanitized, 'clientObservedByteLength');
  copySafeInteger(metadata, sanitized, 'clientObservedCodePointCount');
  copySafeInteger(metadata, sanitized, 'clientObservedGraphemeCount');
  copyBoolean(metadata, sanitized, 'clientObservedGraphemeApproximate');
  copyBoolean(metadata, sanitized, 'clientObservedHasHangul');
  copyBoolean(metadata, sanitized, 'clientObservedHasCjk');
  copyBoolean(metadata, sanitized, 'clientObservedHasEnter');
  return sanitized;
}

export function formatSafeInputPreview(raw: string): string | null {
  if (!/^[\x00-\x20\x7f]+$/.test(raw)) {
    return null;
  }

  return raw
    .slice(0, DEBUG_CAPTURE_PREVIEW_CHARS)
    .replace(/ /g, '␠')
    .replace(/\x7f/g, '\\x7f')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (match) => `\\x${match.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(/\x1b/g, '\\x1b');
}

function classifyInput(hasSafePreview: boolean, controlCount: number, printableCount: number): string {
  if (hasSafePreview) {
    return 'safe-control';
  }
  if (controlCount > 0 && printableCount > 0) {
    return 'mixed-printable-control';
  }
  if (controlCount > 0) {
    return 'control';
  }
  return 'printable';
}

function countGraphemes(raw: string): GraphemeCountResult {
  const segmenterCtor = (Intl as unknown as {
    Segmenter?: new (
      locale?: string,
      options?: { granularity?: 'grapheme' },
    ) => { segment(input: string): Iterable<unknown> };
  }).Segmenter;

  if (!segmenterCtor) {
    return { count: Array.from(raw).length, approximate: true };
  }

  const segmenter = new segmenterCtor(undefined, { granularity: 'grapheme' });
  return { count: Array.from(segmenter.segment(raw)).length, approximate: false };
}

function copySafeInteger(
  source: InputDebugMetadata,
  target: Record<string, InputDebugValue>,
  key: keyof InputDebugMetadata,
): void {
  const value = source[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    target[key] = value;
  }
}

function copyBoolean(
  source: InputDebugMetadata,
  target: Record<string, InputDebugValue>,
  key: keyof InputDebugMetadata,
): void {
  const value = source[key];
  if (typeof value === 'boolean') {
    target[key] = value;
  }
}
