export type TerminalBufferType = 'normal' | 'alternate';

export interface TerminalRetainedCell {
  column: number;
  chars: string;
  code: number;
  width: number;
  fgMode: number;
  bgMode: number;
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

export interface TerminalRetainedLine {
  index: number;
  isWrapped: boolean;
  text: string;
  cells: TerminalRetainedCell[];
}

export interface TerminalCursorState {
  x: number;
  y: number;
  absoluteY: number;
}

export interface TerminalSavedCursorState {
  available: boolean;
  x?: number;
  y?: number;
}

export interface TerminalModeState {
  applicationCursorKeysMode: boolean;
  applicationKeypadMode: boolean;
  bracketedPasteMode: boolean;
  insertMode: boolean;
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  originMode: boolean;
  reverseWraparoundMode: boolean;
  sendFocusMode: boolean;
  synchronizedOutputMode: boolean;
  wraparoundMode: boolean;
}

export interface TerminalRetainedStateInput {
  schemaVersion: 1;
  activeBuffer: TerminalBufferType;
  geometry: { rows: number; cols: number };
  cursor?: TerminalCursorState;
  savedCursor?: TerminalSavedCursorState;
  modes?: TerminalModeState;
  lines: TerminalRetainedLine[];
}

export interface CanonicalTerminalRetainedState {
  schemaVersion: 1;
  activeBuffer: TerminalBufferType;
  geometry: { rows: number; cols: number };
  cursor?: TerminalCursorState;
  savedCursor?: TerminalSavedCursorState;
  modes?: TerminalModeState;
  lines: TerminalRetainedLine[];
  logicalLinesHash: string;
  cellContentAttributeHash: string;
  digest: string;
}

export interface TerminalRetainedLineFingerprint {
  index: number;
  logicalLineHash: string;
  cellContentAttributeHash: string;
}

export interface TerminalRetainedStateEvidence {
  schemaVersion: 1;
  activeBuffer: TerminalBufferType;
  geometry: { rows: number; cols: number };
  cursor?: TerminalCursorState;
  savedCursor?: TerminalSavedCursorState;
  modes?: TerminalModeState;
  logicalLinesHash: string;
  cellContentAttributeHash: string;
  digest: string;
  lineFingerprints: TerminalRetainedLineFingerprint[];
}

export interface TerminalStreamingRetainedStateOptions {
  hashContract: 'ph005-retained-stream-v1';
  compactCellRuns: true;
  maxBufferedLines: 1;
}

export interface TerminalStreamingRetainedBoundaryEvidence {
  index: number;
  logicalLineSha256: string;
  cellAttributesSha256: string;
}

export interface TerminalStreamingRetainedOverlapShiftEvidence {
  shiftLines: number;
  suffixSha256: string;
  prefixSha256: string;
}

export interface TerminalStreamingRetainedStateEvidence {
  schemaVersion: 1;
  hashContract: 'ph005-retained-stream-v1';
  lineCount: number;
  orderedLogicalLinesSha256: string;
  orderedCellAttributesSha256: string;
  orderedLineFingerprintSha256: string;
  fullStateSha256: string;
  activeBuffer: TerminalBufferType;
  geometry: { rows: number; cols: number };
  cursor: TerminalCursorState;
  savedCursor: TerminalSavedCursorState;
  modes: TerminalModeState;
  firstLine: TerminalStreamingRetainedBoundaryEvidence;
  lastLine: TerminalStreamingRetainedBoundaryEvidence;
  overlap: {
    contract: 'ph005-retained-overlap-v1';
    maxShiftLines: 8;
    canonicalLineFingerprint: 'logical-line-and-cell-attributes-without-index';
    shifts: TerminalStreamingRetainedOverlapShiftEvidence[];
  };
  streaming: {
    fullCellObjectMaterializationCount: 0;
    maxBufferedLines: 1;
    compactCellRuns: true;
  };
}

interface TerminalStreamingCellRun {
  startColumn: number;
  length: number;
  chars: string;
  code: number;
  width: number;
  fgMode: number;
  bgMode: number;
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  dim: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
}

export type RetainedStateFieldVerdict = 'equal' | 'changed' | 'missing';

export interface TerminalRetainedStateDiff {
  fields: {
    logicalLines: RetainedStateFieldVerdict;
    cells: RetainedStateFieldVerdict;
    cursor: RetainedStateFieldVerdict;
    savedCursor: RetainedStateFieldVerdict;
    modes: RetainedStateFieldVerdict;
    activeBuffer: RetainedStateFieldVerdict;
    geometry: RetainedStateFieldVerdict;
  };
}

export const RETAINED_STATE_CAUSE_KINDS = [
  'snapshot_truncation',
  'fallback',
  'replay_tail_truncation',
  'remount_handoff',
  'local_cache_decision',
  'visible_hidden_overflow_repair',
] as const;

export type RetainedStateCauseKind = (typeof RETAINED_STATE_CAUSE_KINDS)[number];
export type RetainedStateCauseStatus = 'observed' | 'candidate' | 'not_observed';

export interface RetainedStateCauseSignal {
  kind: RetainedStateCauseKind;
  status: RetainedStateCauseStatus;
  evidenceReferences: string[];
  details: Record<string, unknown>;
}

export interface TerminalRetainedStateBoundary {
  retainedLineStart: number;
  retainedLineEnd: number;
  serializedPayloadBoundary: {
    value: number;
    unit: 'bytes' | 'characters';
    provenance: string;
  };
}

export interface TerminalRetainedStateAnalysis {
  fieldVerdicts: TerminalRetainedStateDiff['fields'];
  classification: {
    expectedCurrentEviction: number;
    observedLoss: number;
  };
  expectedEvictedLineIndexes: number[];
  observedLostLineIndexes: number[];
  stateFieldObservedLoss: string[];
  effectiveBoundary: TerminalRetainedStateBoundary;
  causeSignals: RetainedStateCauseSignal[];
}

export interface ReadonlyTerminalCellLike {
  getChars(): string;
  getCode(): number;
  getWidth(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isItalic(): number;
  isDim(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
}

export interface ReadonlyTerminalLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean): string;
  getCell(column: number): ReadonlyTerminalCellLike | undefined;
}

export interface ReadonlyTerminalLike {
  readonly rows: number;
  readonly cols: number;
  readonly modes: TerminalModeState;
  readonly buffer: {
    readonly active: {
      readonly type: TerminalBufferType;
      readonly cursorX: number;
      readonly cursorY: number;
      readonly baseY: number;
      readonly viewportY: number;
      readonly length: number;
      getLine(index: number): ReadonlyTerminalLineLike | undefined;
    };
  };
}

const MODE_KEYS = [
  'applicationCursorKeysMode',
  'applicationKeypadMode',
  'bracketedPasteMode',
  'insertMode',
  'mouseTrackingMode',
  'originMode',
  'reverseWraparoundMode',
  'sendFocusMode',
  'synchronizedOutputMode',
  'wraparoundMode',
] as const satisfies readonly (keyof TerminalModeState)[];

const SHA256_ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const retainedStateTextEncoder = new TextEncoder();

function rotateRight32(value: number, count: number): number {
  return ((value >>> count) | (value << (32 - count))) >>> 0;
}

class StreamingSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly pending = new Uint8Array(64);
  private pendingLength = 0;
  private totalBytes = 0n;
  private finalized = false;

  update(value: string | Uint8Array): this {
    if (this.finalized) {
      throw new Error('sha256 accumulator is already finalized');
    }
    const bytes = typeof value === 'string' ? retainedStateTextEncoder.encode(value) : value;
    this.totalBytes += BigInt(bytes.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = Math.min(64 - this.pendingLength, bytes.byteLength - offset);
      this.pending.set(bytes.subarray(offset, offset + count), this.pendingLength);
      this.pendingLength += count;
      offset += count;
      if (this.pendingLength === 64) {
        this.processBlock(this.pending);
        this.pendingLength = 0;
      }
    }
    return this;
  }

  digestHex(): string {
    if (this.finalized) {
      throw new Error('sha256 accumulator is already finalized');
    }
    this.finalized = true;
    const finalByteLength = this.pendingLength + 1 + 8;
    const paddedLength = Math.ceil(finalByteLength / 64) * 64;
    const finalBlocks = new Uint8Array(paddedLength);
    finalBlocks.set(this.pending.subarray(0, this.pendingLength));
    finalBlocks[this.pendingLength] = 0x80;
    const bitLength = this.totalBytes * 8n;
    const finalView = new DataView(finalBlocks.buffer);
    finalView.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffff_ffffn));
    finalView.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn));
    for (let offset = 0; offset < paddedLength; offset += 64) {
      this.processBlock(finalBlocks.subarray(offset, offset + 64));
    }
    return Array.from(this.state)
      .map(word => word.toString(16).padStart(8, '0'))
      .join('');
  }

  private processBlock(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight32(previous15, 7) ^ rotateRight32(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight32(previous2, 17) ^ rotateRight32(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight32(e!, 6) ^ rotateRight32(e!, 11) ^ rotateRight32(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choice + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight32(a!, 2) ^ rotateRight32(a!, 13) ^ rotateRight32(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    this.state[0] = (this.state[0]! + a!) >>> 0;
    this.state[1] = (this.state[1]! + b!) >>> 0;
    this.state[2] = (this.state[2]! + c!) >>> 0;
    this.state[3] = (this.state[3]! + d!) >>> 0;
    this.state[4] = (this.state[4]! + e!) >>> 0;
    this.state[5] = (this.state[5]! + f!) >>> 0;
    this.state[6] = (this.state[6]! + g!) >>> 0;
    this.state[7] = (this.state[7]! + h!) >>> 0;
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(stableStringify(value)) as T;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('retained-state values must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  throw new TypeError('retained-state values must be JSON-serializable');
}

export function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`;
}

function canonicalizeCell(cell: TerminalRetainedCell): TerminalRetainedCell {
  assertNonNegativeInteger(cell.column, 'cell.column');
  assertNonNegativeInteger(cell.code, 'cell.code');
  assertNonNegativeInteger(cell.width, 'cell.width');
  if (typeof cell.chars !== 'string') {
    throw new TypeError('cell.chars must be a string');
  }
  return {
    column: cell.column,
    chars: cell.chars,
    code: cell.code,
    width: cell.width,
    fgMode: cell.fgMode,
    bgMode: cell.bgMode,
    fg: cell.fg,
    bg: cell.bg,
    bold: Boolean(cell.bold),
    italic: Boolean(cell.italic),
    dim: Boolean(cell.dim),
    underline: Boolean(cell.underline),
    blink: Boolean(cell.blink),
    inverse: Boolean(cell.inverse),
    invisible: Boolean(cell.invisible),
    strikethrough: Boolean(cell.strikethrough),
    overline: Boolean(cell.overline),
  };
}

function canonicalizeLine(line: TerminalRetainedLine): TerminalRetainedLine {
  assertNonNegativeInteger(line.index, 'line.index');
  if (typeof line.text !== 'string') {
    throw new TypeError('line.text must be a string');
  }
  const cells = line.cells.map(canonicalizeCell).sort((left, right) => left.column - right.column);
  if (new Set(cells.map((cell) => cell.column)).size !== cells.length) {
    throw new TypeError('line cells must have unique columns');
  }
  return {
    index: line.index,
    isWrapped: Boolean(line.isWrapped),
    text: line.text,
    cells,
  };
}

function canonicalizeModes(modes: TerminalModeState | undefined): TerminalModeState | undefined {
  if (!modes) return undefined;
  const result = {} as TerminalModeState;
  for (const key of MODE_KEYS) {
    (result as unknown as Record<string, unknown>)[key] = modes[key];
  }
  return result;
}

export function canonicalizeTerminalRetainedState(
  input: TerminalRetainedStateInput,
): CanonicalTerminalRetainedState {
  if (input.schemaVersion !== 1) {
    throw new TypeError('unsupported retained-state schema version');
  }
  if (input.activeBuffer !== 'normal' && input.activeBuffer !== 'alternate') {
    throw new TypeError('unsupported terminal buffer type');
  }
  assertNonNegativeInteger(input.geometry.rows, 'geometry.rows');
  assertNonNegativeInteger(input.geometry.cols, 'geometry.cols');

  const lines = input.lines.map(canonicalizeLine).sort((left, right) => left.index - right.index);
  if (new Set(lines.map((line) => line.index)).size !== lines.length) {
    throw new TypeError('retained lines must have unique indexes');
  }
  const base = {
    schemaVersion: 1 as const,
    activeBuffer: input.activeBuffer,
    geometry: cloneJson(input.geometry),
    ...(input.cursor ? { cursor: cloneJson(input.cursor) } : {}),
    ...(input.savedCursor ? { savedCursor: cloneJson(input.savedCursor) } : {}),
    ...(input.modes ? { modes: canonicalizeModes(input.modes) } : {}),
    lines,
  };
  const logicalLinesHash = fnv1a64(stableStringify(lines.map(({ index, isWrapped, text }) => ({ index, isWrapped, text }))));
  const cellContentAttributeHash = fnv1a64(stableStringify(lines.map(({ index, cells }) => ({ index, cells }))));

  return {
    ...base,
    logicalLinesHash,
    cellContentAttributeHash,
    digest: fnv1a64(stableStringify({ ...base, logicalLinesHash, cellContentAttributeHash })),
  };
}

export function captureTerminalRetainedState(
  terminal: ReadonlyTerminalLike,
): CanonicalTerminalRetainedState {
  const buffer = terminal.buffer.active;
  const lines: TerminalRetainedLine[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    const cells: TerminalRetainedCell[] = [];
    const cellCount = Math.min(line.length, terminal.cols);
    for (let column = 0; column < cellCount; column += 1) {
      const cell = line.getCell(column);
      if (!cell) continue;
      cells.push({
        column,
        chars: cell.getChars(),
        code: cell.getCode(),
        width: cell.getWidth(),
        fgMode: cell.getFgColorMode(),
        bgMode: cell.getBgColorMode(),
        fg: cell.getFgColor(),
        bg: cell.getBgColor(),
        bold: Boolean(cell.isBold()),
        italic: Boolean(cell.isItalic()),
        dim: Boolean(cell.isDim()),
        underline: Boolean(cell.isUnderline()),
        blink: Boolean(cell.isBlink()),
        inverse: Boolean(cell.isInverse()),
        invisible: Boolean(cell.isInvisible()),
        strikethrough: Boolean(cell.isStrikethrough()),
        overline: Boolean(cell.isOverline()),
      });
    }
    lines.push({
      index,
      isWrapped: line.isWrapped,
      text: line.translateToString(true),
      cells,
    });
  }

  return canonicalizeTerminalRetainedState({
    schemaVersion: 1,
    activeBuffer: buffer.type,
    geometry: { rows: terminal.rows, cols: terminal.cols },
    cursor: {
      x: buffer.cursorX,
      y: buffer.cursorY,
      absoluteY: buffer.baseY + buffer.cursorY,
    },
    // xterm's public API does not expose DECSC saved-cursor coordinates.
    // Preserve that absence explicitly instead of reading unstable private internals.
    savedCursor: { available: false },
    modes: terminal.modes,
    lines,
  });
}

function updateLengthFramedSha256(hash: StreamingSha256, value: string): void {
  const bytes = retainedStateTextEncoder.encode(value);
  hash.update(String(bytes.byteLength));
  hash.update(':');
  hash.update(bytes);
}

function sha256Text(value: string): string {
  return new StreamingSha256().update(value).digestHex();
}

function defaultStreamingCellRun(column: number): TerminalStreamingCellRun {
  return {
    startColumn: column,
    length: 1,
    chars: '',
    code: 0,
    width: 1,
    fgMode: 0,
    bgMode: 0,
    // xterm reports its default foreground/background through the public
    // buffer-cell API as -1. Treating only zero as default prevented blank
    // suffixes from ever coalescing in real terminals.
    fg: -1,
    bg: -1,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
}

function streamingCellRun(
  cell: ReadonlyTerminalCellLike | undefined,
  column: number,
): TerminalStreamingCellRun {
  if (!cell) return defaultStreamingCellRun(column);
  return {
    startColumn: column,
    length: 1,
    chars: cell.getChars(),
    code: cell.getCode(),
    width: cell.getWidth(),
    fgMode: cell.getFgColorMode(),
    bgMode: cell.getBgColorMode(),
    fg: cell.getFgColor(),
    bg: cell.getBgColor(),
    bold: Boolean(cell.isBold()),
    italic: Boolean(cell.isItalic()),
    dim: Boolean(cell.isDim()),
    underline: Boolean(cell.isUnderline()),
    blink: Boolean(cell.isBlink()),
    inverse: Boolean(cell.isInverse()),
    invisible: Boolean(cell.isInvisible()),
    strikethrough: Boolean(cell.isStrikethrough()),
    overline: Boolean(cell.isOverline()),
  };
}

function isBlankDefaultStreamingCell(run: TerminalStreamingCellRun): boolean {
  return run.chars === ''
    && run.code === 0
    && run.width === 1
    && run.fgMode === 0
    && run.bgMode === 0
    && run.fg === -1
    && run.bg === -1
    && !run.bold
    && !run.italic
    && !run.dim
    && !run.underline
    && !run.blink
    && !run.inverse
    && !run.invisible
    && !run.strikethrough
    && !run.overline;
}

function captureStreamingCellRuns(
  line: ReadonlyTerminalLineLike,
  cols: number,
): TerminalStreamingCellRun[] {
  const runs: TerminalStreamingCellRun[] = [];
  for (let column = 0; column < cols; column += 1) {
    const run = streamingCellRun(line.getCell(column), column);
    const previous = runs.at(-1);
    // The PH005 evidence contract retains one record for every non-blank cell
    // and only compacts the potentially large default blank suffix.
    if (
      previous
      && isBlankDefaultStreamingCell(previous)
      && isBlankDefaultStreamingCell(run)
      && previous.startColumn + previous.length === column
    ) {
      previous.length += 1;
      continue;
    }
    runs.push(run);
  }
  return runs;
}

function captureSavedCursor(terminal: ReadonlyTerminalLike): TerminalSavedCursorState {
  const privateBuffer = (terminal as unknown as {
    _core?: { buffer?: { savedX?: unknown; savedY?: unknown } };
  })._core?.buffer;
  if (
    Number.isSafeInteger(privateBuffer?.savedX)
    && Number(privateBuffer?.savedX) >= 0
    && Number.isSafeInteger(privateBuffer?.savedY)
    && Number(privateBuffer?.savedY) >= 0
  ) {
    return {
      available: true,
      x: Number(privateBuffer!.savedX),
      y: Number(privateBuffer!.savedY),
    };
  }
  return { available: false };
}

// Local-only PH005 evidence seam. It scans the live xterm buffer one line at a
// time and never constructs the full retained cell graph in browser memory.
// @req MIG-BGSTAB-002 AC-4
// @req REL-BGSTAB-007 AC-3 AC-8
export function captureTerminalRetainedStateStreaming(
  terminal: ReadonlyTerminalLike,
  options: TerminalStreamingRetainedStateOptions,
): TerminalStreamingRetainedStateEvidence {
  if (
    options.hashContract !== 'ph005-retained-stream-v1'
    || options.compactCellRuns !== true
    || options.maxBufferedLines !== 1
  ) {
    throw new TypeError('unsupported retained-state streaming contract');
  }

  const buffer = terminal.buffer.active;
  const orderedLogical = new StreamingSha256();
  const orderedCells = new StreamingSha256();
  const orderedFingerprints = new StreamingSha256();
  const overlapSuffixHashes = Array.from({ length: 8 }, () => new StreamingSha256());
  const overlapPrefixHashes = Array.from({ length: 8 }, () => new StreamingSha256());
  const recentCanonicalFingerprints: string[] = [];
  let firstLine: TerminalStreamingRetainedBoundaryEvidence | null = null;
  let lastLine: TerminalStreamingRetainedBoundaryEvidence | null = null;
  let lineCount = 0;

  for (let sourceIndex = 0; sourceIndex < buffer.length; sourceIndex += 1) {
    const line = buffer.getLine(sourceIndex);
    if (!line) continue;
    const index = lineCount;
    const lineText = line.translateToString(true);
    const compactCellRuns = captureStreamingCellRuns(line, terminal.cols);
    const logicalPayload = JSON.stringify({
      index,
      isWrapped: line.isWrapped,
      text: lineText,
    });
    const cellPayload = JSON.stringify({
      index,
      compactCellRuns,
    });
    const logicalLineSha256 = sha256Text(logicalPayload);
    const cellAttributesSha256 = sha256Text(cellPayload);
    updateLengthFramedSha256(orderedLogical, logicalPayload);
    updateLengthFramedSha256(orderedCells, cellPayload);
    updateLengthFramedSha256(
      orderedFingerprints,
      JSON.stringify({ index, logicalLineSha256, cellAttributesSha256 }),
    );
    const canonicalFingerprint = sha256Text(JSON.stringify({
      logicalLine: { isWrapped: line.isWrapped, text: lineText },
      cellAttributes: { compactCellRuns },
    }));
    for (let shiftIndex = 0; shiftIndex < overlapSuffixHashes.length; shiftIndex += 1) {
      const shiftLines = shiftIndex + 1;
      if (index >= shiftLines) {
        updateLengthFramedSha256(overlapSuffixHashes[shiftIndex]!, canonicalFingerprint);
        updateLengthFramedSha256(
          overlapPrefixHashes[shiftIndex]!,
          recentCanonicalFingerprints[recentCanonicalFingerprints.length - shiftLines]!,
        );
      }
    }
    recentCanonicalFingerprints.push(canonicalFingerprint);
    if (recentCanonicalFingerprints.length > overlapSuffixHashes.length) {
      recentCanonicalFingerprints.shift();
    }
    const boundary = { index, logicalLineSha256, cellAttributesSha256 };
    firstLine ??= boundary;
    lastLine = boundary;
    lineCount += 1;
  }

  if (!firstLine || !lastLine) {
    throw new Error('terminal retained-state streaming capture requires at least one line');
  }

  const orderedLogicalLinesSha256 = orderedLogical.digestHex();
  const orderedCellAttributesSha256 = orderedCells.digestHex();
  const orderedLineFingerprintSha256 = orderedFingerprints.digestHex();
  const overlapShifts = overlapSuffixHashes
    .map((suffixHash, shiftIndex) => ({
      shiftLines: shiftIndex + 1,
      suffixSha256: suffixHash,
      prefixSha256: overlapPrefixHashes[shiftIndex]!,
    }))
    .filter(({ shiftLines }) => shiftLines < lineCount)
    .map(({ shiftLines, suffixSha256, prefixSha256 }) => ({
      shiftLines,
      suffixSha256: suffixSha256.digestHex(),
      prefixSha256: prefixSha256.digestHex(),
    }));
  const activeBuffer = buffer.type;
  const geometry = { rows: terminal.rows, cols: terminal.cols };
  const cursor = {
    x: buffer.cursorX,
    y: buffer.cursorY,
    absoluteY: buffer.baseY + buffer.cursorY,
  };
  const savedCursor = captureSavedCursor(terminal);
  const modes = canonicalizeModes(terminal.modes)!;
  const fullStateSha256 = sha256Text(JSON.stringify({
    schemaVersion: 1,
    activeBuffer,
    geometry,
    cursor,
    savedCursor,
    modes,
    lineCount,
    orderedLogicalLinesSha256,
    orderedCellAttributesSha256,
    orderedLineFingerprintSha256,
  }));

  return {
    schemaVersion: 1,
    hashContract: 'ph005-retained-stream-v1',
    lineCount,
    orderedLogicalLinesSha256,
    orderedCellAttributesSha256,
    orderedLineFingerprintSha256,
    fullStateSha256,
    activeBuffer,
    geometry,
    cursor,
    savedCursor,
    modes,
    firstLine,
    lastLine,
    overlap: {
      contract: 'ph005-retained-overlap-v1',
      maxShiftLines: 8,
      canonicalLineFingerprint: 'logical-line-and-cell-attributes-without-index',
      shifts: overlapShifts,
    },
    streaming: {
      fullCellObjectMaterializationCount: 0,
      maxBufferedLines: 1,
      compactCellRuns: true,
    },
  };
}

export function createTerminalRetainedStateEvidence(
  state: CanonicalTerminalRetainedState,
): TerminalRetainedStateEvidence {
  return {
    schemaVersion: state.schemaVersion,
    activeBuffer: state.activeBuffer,
    geometry: cloneJson(state.geometry),
    ...(state.cursor ? { cursor: cloneJson(state.cursor) } : {}),
    ...(state.savedCursor ? { savedCursor: cloneJson(state.savedCursor) } : {}),
    ...(state.modes ? { modes: cloneJson(state.modes) } : {}),
    logicalLinesHash: state.logicalLinesHash,
    cellContentAttributeHash: state.cellContentAttributeHash,
    digest: state.digest,
    lineFingerprints: state.lines.map(({ index, isWrapped, text, cells }) => ({
      index,
      logicalLineHash: fnv1a64(stableStringify({ isWrapped, text })),
      cellContentAttributeHash: fnv1a64(stableStringify({ cells })),
    })),
  };
}

function compareOptional(left: unknown, right: unknown): RetainedStateFieldVerdict {
  if (left === undefined || right === undefined) return 'missing';
  return stableStringify(left) === stableStringify(right) ? 'equal' : 'changed';
}

export function diffTerminalRetainedState(
  pre: CanonicalTerminalRetainedState,
  post: CanonicalTerminalRetainedState,
): TerminalRetainedStateDiff {
  return {
    fields: {
      logicalLines: pre.logicalLinesHash === post.logicalLinesHash ? 'equal' : 'changed',
      cells: pre.cellContentAttributeHash === post.cellContentAttributeHash ? 'equal' : 'changed',
      cursor: compareOptional(pre.cursor, post.cursor),
      savedCursor: compareOptional(pre.savedCursor, post.savedCursor),
      modes: compareOptional(pre.modes, post.modes),
      activeBuffer: pre.activeBuffer === post.activeBuffer ? 'equal' : 'changed',
      geometry: stableStringify(pre.geometry) === stableStringify(post.geometry) ? 'equal' : 'changed',
    },
  };
}

function validateBoundary(boundary: TerminalRetainedStateBoundary): TerminalRetainedStateBoundary {
  assertNonNegativeInteger(boundary.retainedLineStart, 'retainedLineStart');
  assertNonNegativeInteger(boundary.retainedLineEnd, 'retainedLineEnd');
  assertNonNegativeInteger(boundary.serializedPayloadBoundary.value, 'serializedPayloadBoundary.value');
  if (!['bytes', 'characters'].includes(boundary.serializedPayloadBoundary.unit)) {
    throw new TypeError('serializedPayloadBoundary.unit must be bytes or characters');
  }
  if (!boundary.serializedPayloadBoundary.provenance.trim()) {
    throw new TypeError('serializedPayloadBoundary.provenance is required');
  }
  if (boundary.retainedLineEnd < boundary.retainedLineStart) {
    throw new TypeError('retainedLineEnd must not precede retainedLineStart');
  }
  return cloneJson(boundary);
}

function validateCauseSignals(causes: readonly RetainedStateCauseSignal[]): RetainedStateCauseSignal[] {
  return causes.map((cause) => {
    if (!(RETAINED_STATE_CAUSE_KINDS as readonly unknown[]).includes(cause.kind)) {
      throw new TypeError('unsupported retained-state cause kind');
    }
    if (!['observed', 'candidate', 'not_observed'].includes(cause.status)) {
      throw new TypeError('unsupported retained-state cause status');
    }
    if (!cause.evidenceReferences.length || cause.evidenceReferences.some((reference) => !reference.trim())) {
      throw new TypeError('cause signals require raw evidence references');
    }
    return cloneJson(cause);
  });
}

export function analyzeTerminalRetainedState(input: {
  pre: CanonicalTerminalRetainedState;
  post: CanonicalTerminalRetainedState;
  effectiveBoundary: TerminalRetainedStateBoundary;
  causeSignals: readonly RetainedStateCauseSignal[];
}): TerminalRetainedStateAnalysis {
  const boundary = validateBoundary(input.effectiveBoundary);
  const fieldVerdicts = diffTerminalRetainedState(input.pre, input.post).fields;
  const postLines = new Map(input.post.lines.map((line) => [line.index, line]));
  const expectedEvictedLineIndexes: number[] = [];
  const observedLostLineIndexes: number[] = [];

  for (const preLine of input.pre.lines) {
    const postLine = postLines.get(preLine.index);
    const changed = postLine !== undefined && stableStringify(preLine) !== stableStringify(postLine);
    if (!postLine || changed) {
      if (!postLine && (preLine.index < boundary.retainedLineStart || preLine.index > boundary.retainedLineEnd)) {
        expectedEvictedLineIndexes.push(preLine.index);
      } else {
        observedLostLineIndexes.push(preLine.index);
      }
    }
  }

  const stateFieldObservedLoss = Object.entries(fieldVerdicts)
    .filter(([field, verdict]) => !['logicalLines', 'cells'].includes(field) && verdict !== 'equal')
    .map(([field]) => field);

  return {
    fieldVerdicts,
    classification: {
      expectedCurrentEviction: expectedEvictedLineIndexes.length,
      observedLoss: observedLostLineIndexes.length + stateFieldObservedLoss.length,
    },
    expectedEvictedLineIndexes,
    observedLostLineIndexes,
    stateFieldObservedLoss,
    effectiveBoundary: boundary,
    causeSignals: validateCauseSignals(input.causeSignals),
  };
}

export function analyzeTerminalRetainedStateEvidence(input: {
  pre: TerminalRetainedStateEvidence;
  post: TerminalRetainedStateEvidence;
  effectiveBoundary: TerminalRetainedStateBoundary;
  causeSignals: readonly RetainedStateCauseSignal[];
}): TerminalRetainedStateAnalysis {
  const boundary = validateBoundary(input.effectiveBoundary);
  const fieldVerdicts = {
    logicalLines: input.pre.logicalLinesHash === input.post.logicalLinesHash ? 'equal' : 'changed',
    cells: input.pre.cellContentAttributeHash === input.post.cellContentAttributeHash ? 'equal' : 'changed',
    cursor: compareOptional(input.pre.cursor, input.post.cursor),
    savedCursor: compareOptional(input.pre.savedCursor, input.post.savedCursor),
    modes: compareOptional(input.pre.modes, input.post.modes),
    activeBuffer: input.pre.activeBuffer === input.post.activeBuffer ? 'equal' : 'changed',
    geometry: stableStringify(input.pre.geometry) === stableStringify(input.post.geometry) ? 'equal' : 'changed',
  } satisfies TerminalRetainedStateDiff['fields'];
  const preLines = input.pre.lineFingerprints;
  const postLines = input.post.lineFingerprints;
  const lcsLengths = Array.from(
    { length: preLines.length + 1 },
    () => new Uint32Array(postLines.length + 1),
  );
  // @req OBS-BGSTAB-004
  const sameFingerprint = (
    left: TerminalRetainedLineFingerprint,
    right: TerminalRetainedLineFingerprint,
  ) => left.logicalLineHash === right.logicalLineHash
    && left.cellContentAttributeHash === right.cellContentAttributeHash;
  for (let preIndex = 1; preIndex <= preLines.length; preIndex += 1) {
    for (let postIndex = 1; postIndex <= postLines.length; postIndex += 1) {
      lcsLengths[preIndex][postIndex] = sameFingerprint(
        preLines[preIndex - 1],
        postLines[postIndex - 1],
      )
        ? lcsLengths[preIndex - 1][postIndex - 1] + 1
        : Math.max(lcsLengths[preIndex - 1][postIndex], lcsLengths[preIndex][postIndex - 1]);
    }
  }
  const matchedPreIndexes = new Set<number>();
  let preIndex = preLines.length;
  let postIndex = postLines.length;
  while (preIndex > 0 && postIndex > 0) {
    if (sameFingerprint(preLines[preIndex - 1], postLines[postIndex - 1])) {
      matchedPreIndexes.add(preIndex - 1);
      preIndex -= 1;
      postIndex -= 1;
    } else if (lcsLengths[preIndex - 1][postIndex] >= lcsLengths[preIndex][postIndex - 1]) {
      preIndex -= 1;
    } else {
      postIndex -= 1;
    }
  }
  const unmatchedPreLines = preLines.filter((_, index) => !matchedPreIndexes.has(index));
  const expectedEvictedLineIndexes = unmatchedPreLines
    .filter((line) => line.index < boundary.retainedLineStart || line.index > boundary.retainedLineEnd)
    .map((line) => line.index);
  const observedLostLineIndexes = unmatchedPreLines
    .filter((line) => line.index >= boundary.retainedLineStart && line.index <= boundary.retainedLineEnd)
    .map((line) => line.index);
  const stateFieldObservedLoss = Object.entries(fieldVerdicts)
    .filter(([field, verdict]) => !['logicalLines', 'cells'].includes(field) && verdict !== 'equal')
    .map(([field]) => field);
  return {
    fieldVerdicts,
    classification: {
      expectedCurrentEviction: expectedEvictedLineIndexes.length,
      observedLoss: observedLostLineIndexes.length + stateFieldObservedLoss.length,
    },
    expectedEvictedLineIndexes,
    observedLostLineIndexes,
    stateFieldObservedLoss,
    effectiveBoundary: boundary,
    causeSignals: validateCauseSignals(input.causeSignals),
  };
}
