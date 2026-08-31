import { createHash } from 'node:crypto';
import type { ISerializeOptions, SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import serializeModule from '@xterm/addon-serialize';
import type { ITerminalOptions, Terminal as HeadlessTerminalType } from '@xterm/headless';
import headlessModule from '@xterm/headless';
import type {
  ScreenRepairBufferType,
  ScreenRepairRowPatch,
  WindowsPtyInfo,
} from '../types/ws-protocol.js';

const { SerializeAddon } = serializeModule;
const { Terminal } = headlessModule;

export interface HeadlessTerminalState {
  terminal: HeadlessTerminalType;
  serializeAddon: SerializeAddonType;
  cursorHidden: boolean;
  cursorVisibilityTail: string;
  savedCursorControlTail: string;
  savedCursorObserved: boolean;
  retainedMetricsTracker: RetainedHeadlessMetricsTracker;
}

export interface SerializedHeadlessSnapshot {
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
}

export interface RetainedHeadlessBufferProjection {
  logicalLines: readonly string[];
  cellHash: string;
  attributeHash: string;
}

export interface RetainedHeadlessCheckpoint {
  serializedData: string;
  rehydrateAnsi: string;
  normal: RetainedHeadlessBufferProjection;
  alternate: RetainedHeadlessBufferProjection;
  activeBuffer: 'normal' | 'alternate';
  cursor: { x: number; y: number };
  savedCursor: { x: number; y: number } | null;
  modes: Readonly<Record<string, boolean | number | string>>;
  cols: number;
  rows: number;
  truncated: false;
}

export type RetainedHeadlessComparisonAxis = 'match' | 'mismatch' | 'unavailable';

export interface RetainedHeadlessComparisonAxes {
  logicalLines: RetainedHeadlessComparisonAxis;
  cells: RetainedHeadlessComparisonAxis;
  unicodeWidth: RetainedHeadlessComparisonAxis;
  cursor: RetainedHeadlessComparisonAxis;
  modes: RetainedHeadlessComparisonAxis;
  activeBuffer: RetainedHeadlessComparisonAxis;
  parserTail: RetainedHeadlessComparisonAxis;
  eviction: RetainedHeadlessComparisonAxis;
}

export interface RetainedHeadlessExternalAxis<T> {
  expected: T;
  actual: T;
}

export interface CompareRetainedHeadlessCheckpointOptions<TEviction = unknown> {
  scrollbackLines: number;
  windowsPty?: WindowsPtyInfo;
  parserTail?: RetainedHeadlessExternalAxis<string>;
  eviction?: RetainedHeadlessExternalAxis<TEviction>;
}

export interface RetainedHeadlessComparisonResult {
  result: RetainedHeadlessComparisonAxis;
  axes: RetainedHeadlessComparisonAxes;
  reason?: 'roundtrip-failed';
}

export interface RetainedHeadlessBufferMetrics {
  trimTracking: 'xterm-line-events' | 'unavailable';
  currentPhysicalRows: number;
  currentLogicalRows: number;
  currentUtf8Bytes: number;
  leadingRowWrapped: boolean;
  evictedPhysicalRows: number;
  evictedLogicalRows: number;
  evictedUtf8Bytes: number;
  trimEvents: number;
  completeLogicalRowBoundary: boolean;
  oldestRetainedStreamEpoch: string | null;
  oldestRetainedSeq: string | null;
  sourceMarkerCoverage: 'complete' | 'partial' | 'none';
  trackedSourceRanges: number;
}

export interface HeadlessScreenRepairPayload {
  seq: number;
  cols: number;
  rows: number;
  bufferType: ScreenRepairBufferType;
  cursor: { x: number; y: number; hidden?: boolean };
  viewportRows: ScreenRepairRowPatch[];
  ansiPatch: string;
}

export type HeadlessScreenRepairResult =
  | { ok: true; payload: HeadlessScreenRepairPayload }
  | {
      ok: false;
      reason:
        | 'geometry-mismatch'
        | 'buffer-mismatch'
        | 'headless-degraded'
        | 'headless-busy'
        | 'generation-failed';
    };

interface RepairCell {
  getWidth(): number;
  getChars(): string;
  getCode(): number;
  getFgColorMode(): number;
  getBgColorMode(): number;
  getFgColor(): number;
  getBgColor(): number;
  isBold(): number;
  isDim(): number;
  isItalic(): number;
  isUnderline(): number;
  isBlink(): number;
  isInverse(): number;
  isInvisible(): number;
  isStrikethrough(): number;
  isOverline(): number;
  isFgRGB(): boolean;
  isBgRGB(): boolean;
  isFgPalette(): boolean;
  isBgPalette(): boolean;
}

interface RepairLine {
  readonly length: number;
  readonly isWrapped: boolean;
  getCell(x: number, cell?: RepairCell): RepairCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

interface RetainedPhysicalRowMetric {
  wrapped: boolean;
  utf8Bytes: number;
}

interface RetainedSourceMarker {
  /** Stream epoch for the source range. Ranges never coalesce across rollover. */
  streamEpoch: string;
  /** Oldest committed source identity known to have touched this physical line. */
  sourceSeq: string;
  /** Newest committed source identity coalesced into this physical-line range. */
  latestSourceSeq: string;
  marker: {
    readonly line: number;
    readonly isDisposed: boolean;
    onDispose(listener: () => void): { dispose(): void };
    dispose(): void;
  };
  disposeListener: { dispose(): void };
}

interface RetainedHeadlessMetricsTracker {
  rows: RetainedPhysicalRowMetric[];
  trimTrackingAvailable: boolean;
  evictedPhysicalRows: number;
  evictedLogicalRows: number;
  evictedUtf8Bytes: number;
  trimEvents: number;
  completeLogicalRowBoundary: boolean;
  sourceMarkers: RetainedSourceMarker[];
  markerCoverage: 'complete' | 'partial' | 'none';
  disposables: Array<{ dispose(): void }>;
}

type RepairStyle = {
  fgMode: number;
  fg: number;
  fgRgb: boolean;
  fgPalette: boolean;
  bgMode: number;
  bg: number;
  bgRgb: boolean;
  bgPalette: boolean;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  blink: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  overline: boolean;
};

const DEFAULT_TERMINAL_OPTIONS: Pick<ITerminalOptions, 'allowProposedApi' | 'reflowCursorLine'> = {
  allowProposedApi: true,
  reflowCursorLine: true,
};

export const VIEWPORT_ONLY_SERIALIZE_OPTIONS: ISerializeOptions = { scrollback: 0 };

export function createHeadlessTerminalState(options: {
  cols: number;
  rows: number;
  scrollbackLines: number;
  windowsPty?: WindowsPtyInfo;
}): HeadlessTerminalState {
  const terminal = new Terminal({
    ...DEFAULT_TERMINAL_OPTIONS,
    cols: options.cols,
    rows: options.rows,
    scrollback: options.scrollbackLines,
    windowsPty: options.windowsPty,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  const state: HeadlessTerminalState = {
    terminal,
    serializeAddon,
    cursorHidden: false,
    cursorVisibilityTail: '',
    savedCursorControlTail: '',
    savedCursorObserved: false,
    retainedMetricsTracker: createRetainedMetricsTracker(terminal),
  };
  attachRetainedMetricsTracker(state);
  return state;
}

export function writeHeadlessTerminal(state: HeadlessTerminalState, data: string): Promise<void> {
  return new Promise((resolve) => {
    state.terminal.write(data, () => {
      updateCursorVisibilityState(state, data);
      updateSavedCursorState(state, data);
      resolve();
    });
  });
}

export function resizeHeadlessTerminal(state: HeadlessTerminalState, cols: number, rows: number): void {
  state.terminal.resize(cols, rows);
}

export function serializeHeadlessTerminal(
  state: HeadlessTerminalState,
  maxSnapshotBytes: number,
  options?: ISerializeOptions,
): SerializedHeadlessSnapshot {
  const serialized = state.serializeAddon.serialize(options ?? VIEWPORT_ONLY_SERIALIZE_OPTIONS);
  if (Buffer.byteLength(serialized, 'utf8') > maxSnapshotBytes) {
    return {
      cols: state.terminal.cols,
      rows: state.terminal.rows,
      data: '',
      truncated: true,
    };
  }

  return {
    cols: state.terminal.cols,
    rows: state.terminal.rows,
    data: serialized,
    truncated: false,
  };
}

/**
 * Projects the complete retained state from the existing authoritative headless
 * terminal. Unlike the compatibility serializer above, this adapter is not a
 * transport-sized payload and therefore never converts a valid model into an
 * empty/truncated success.
 */
export function serializeRetainedHeadlessCheckpoint(
  state: HeadlessTerminalState,
): RetainedHeadlessCheckpoint {
  const terminal = state.terminal;
  const normal = projectRetainedBuffer(terminal.buffer.normal, 0);
  // A fresh xterm alternate buffer has no scrollback. An inactive alternate
  // buffer can temporarily retain extra rows across a resize, so normalize it
  // to the rows that the serialized checkpoint can actually rehydrate.
  const alternate = projectRetainedBuffer(
    terminal.buffer.alternate,
    Math.max(0, terminal.buffer.alternate.length - terminal.rows),
  );
  const activeBuffer = terminal.buffer.active.type;
  const savedCursors = readInternalSavedCursors(terminal);
  const savedCursor = state.savedCursorObserved
    ? savedCursors.normal ?? savedCursors.active
    : null;
  const serialized = state.serializeAddon.serialize();
  const rehydrateAnsi = state.savedCursorObserved
    ? injectSavedCursorState(serialized, activeBuffer, terminal, savedCursors)
    : serialized;

  return {
    serializedData: rehydrateAnsi,
    rehydrateAnsi,
    normal,
    alternate,
    activeBuffer,
    cursor: {
      x: terminal.buffer.active.cursorX,
      y: terminal.buffer.active.cursorY,
    },
    savedCursor,
    modes: { ...terminal.modes },
    cols: terminal.cols,
    rows: terminal.rows,
    truncated: false,
  };
}

/**
 * Compares a retained checkpoint against a freshly rehydrated, ephemeral
 * headless terminal. The baseline terminal is always disposed before this
 * promise settles, so this does not add a persistent session model.
 */
export async function compareRetainedHeadlessCheckpointRoundTrip<TEviction = unknown>(
  checkpoint: RetainedHeadlessCheckpoint,
  options: CompareRetainedHeadlessCheckpointOptions<TEviction>,
): Promise<RetainedHeadlessComparisonResult> {
  const consumer = createHeadlessTerminalState({
    cols: checkpoint.cols,
    rows: checkpoint.rows,
    scrollbackLines: options.scrollbackLines,
    windowsPty: options.windowsPty,
  });

  try {
    await writeHeadlessTerminal(consumer, checkpoint.rehydrateAnsi);
    const roundTrip = serializeRetainedHeadlessCheckpoint(consumer);
    const axes: RetainedHeadlessComparisonAxes = {
      logicalLines: compareValues(
        [checkpoint.normal.logicalLines, checkpoint.alternate.logicalLines],
        [roundTrip.normal.logicalLines, roundTrip.alternate.logicalLines],
      ),
      cells: compareValues(
        [
          checkpoint.normal.cellHash, checkpoint.normal.attributeHash,
          checkpoint.alternate.cellHash, checkpoint.alternate.attributeHash,
        ],
        [
          roundTrip.normal.cellHash, roundTrip.normal.attributeHash,
          roundTrip.alternate.cellHash, roundTrip.alternate.attributeHash,
        ],
      ),
      // Cell hashes include code point, grapheme chars and xterm cell width.
      unicodeWidth: compareValues(
        [checkpoint.normal.cellHash, checkpoint.alternate.cellHash],
        [roundTrip.normal.cellHash, roundTrip.alternate.cellHash],
      ),
      cursor: compareValues(
        [checkpoint.cursor, checkpoint.savedCursor],
        [roundTrip.cursor, roundTrip.savedCursor],
      ),
      modes: compareValues(checkpoint.modes, roundTrip.modes),
      activeBuffer: checkpoint.activeBuffer === roundTrip.activeBuffer ? 'match' : 'mismatch',
      parserTail: compareExternalAxis(options.parserTail),
      eviction: compareExternalAxis(options.eviction),
    };
    return { result: foldComparisonAxes(axes), axes };
  } catch {
    return {
      result: 'unavailable',
      reason: 'roundtrip-failed',
      axes: {
        logicalLines: 'unavailable',
        cells: 'unavailable',
        unicodeWidth: 'unavailable',
        cursor: 'unavailable',
        modes: 'unavailable',
        activeBuffer: 'unavailable',
        parserTail: compareExternalAxis(options.parserTail),
        eviction: compareExternalAxis(options.eviction),
      },
    };
  } finally {
    disposeHeadlessTerminal(consumer);
  }
}

/**
 * Associates a committed source record with xterm's real normal-buffer line
 * marker. Marker disposal, rather than newline estimation, determines which
 * source records are no longer retained after scrollback trim/reflow.
 */
export function markRetainedHeadlessSourceSequence(
  state: HeadlessTerminalState,
  streamEpoch: string,
  sourceSeq: string,
): boolean {
  const tracker = state.retainedMetricsTracker;
  pruneDisposedSourceMarkers(tracker);
  if (tracker.sourceMarkers.some(
    entry => entry.streamEpoch === streamEpoch
      && (entry.sourceSeq === sourceSeq || entry.latestSourceSeq === sourceSeq),
  )) return true;

  const normalBuffer = state.terminal.buffer.normal;
  if (state.terminal.buffer.active.type !== 'normal') {
    tracker.markerCoverage = 'partial';
    return false;
  }
  const currentPhysicalLine = normalBuffer.baseY + normalBuffer.cursorY;
  const currentLineRange = tracker.sourceMarkers.find(
    entry => entry.streamEpoch === streamEpoch && entry.marker.line === currentPhysicalLine,
  );
  if (currentLineRange) {
    currentLineRange.latestSourceSeq = sourceSeq;
    return true;
  }

  const marker = state.terminal.registerMarker(0);
  if (!marker) {
    tracker.markerCoverage = 'partial';
    return false;
  }
  const disposeListener = marker.onDispose(() => undefined);
  tracker.sourceMarkers.push({ streamEpoch, sourceSeq, latestSourceSeq: sourceSeq, marker, disposeListener });
  if (tracker.markerCoverage === 'none' && tracker.sourceMarkers.length === 1) {
    tracker.markerCoverage = 'complete';
  }
  return true;
}

/** Reads physical/logical retention from xterm buffer and trim/marker events. */
export function readRetainedHeadlessBufferMetrics(
  state: HeadlessTerminalState,
): RetainedHeadlessBufferMetrics {
  const tracker = state.retainedMetricsTracker;
  tracker.rows = captureRetainedPhysicalRows(state.terminal.buffer.normal);
  pruneDisposedSourceMarkers(tracker);
  const rows = tracker.rows;
  return {
    trimTracking: tracker.trimTrackingAvailable ? 'xterm-line-events' : 'unavailable',
    currentPhysicalRows: rows.length,
    currentLogicalRows: countRetainedLogicalRows(rows),
    currentUtf8Bytes: rows.reduce((total, row) => total + row.utf8Bytes, 0),
    leadingRowWrapped: rows[0]?.wrapped ?? false,
    evictedPhysicalRows: tracker.evictedPhysicalRows,
    evictedLogicalRows: tracker.evictedLogicalRows,
    evictedUtf8Bytes: tracker.evictedUtf8Bytes,
    trimEvents: tracker.trimEvents,
    completeLogicalRowBoundary: tracker.completeLogicalRowBoundary,
    oldestRetainedStreamEpoch: tracker.sourceMarkers[0]?.streamEpoch ?? null,
    oldestRetainedSeq: tracker.sourceMarkers[0]?.sourceSeq ?? null,
    sourceMarkerCoverage: tracker.markerCoverage,
    trackedSourceRanges: tracker.sourceMarkers.length,
  };
}

export function serializeHeadlessScreenRepair(
  state: HeadlessTerminalState,
  expected: { cols: number; rows: number; bufferType: ScreenRepairBufferType; seq?: number },
  maxBytes: number,
): HeadlessScreenRepairResult {
  const terminal = state.terminal;
  const buffer = terminal.buffer.active;
  if (terminal.cols !== expected.cols || terminal.rows !== expected.rows) {
    return { ok: false, reason: 'geometry-mismatch' };
  }
  if (buffer.type !== expected.bufferType) {
    return { ok: false, reason: 'buffer-mismatch' };
  }

  try {
    const viewportRows: ScreenRepairRowPatch[] = [];
    for (let y = 0; y < terminal.rows; y += 1) {
      const line = buffer.getLine(buffer.viewportY + y);
      const text = line?.translateToString(true, 0, terminal.cols) ?? '';
      viewportRows.push({
        y,
        text,
        ansi: line ? serializeLineAnsi(line, terminal.cols, buffer.getNullCell()) : '',
        wrapped: line?.isWrapped ?? false,
      });
    }

    const cursor = {
      x: buffer.cursorX,
      y: buffer.cursorY,
      hidden: state.cursorHidden,
    };
    const ansiPatch = buildViewportAnsiPatch(viewportRows, cursor, terminal.cols);
    if (Buffer.byteLength(ansiPatch, 'utf8') > maxBytes) {
      return { ok: false, reason: 'generation-failed' };
    }

    return {
      ok: true,
      payload: {
        seq: expected.seq ?? 0,
        cols: terminal.cols,
        rows: terminal.rows,
        bufferType: buffer.type,
        cursor,
        viewportRows,
        ansiPatch,
      },
    };
  } catch {
    return { ok: false, reason: 'generation-failed' };
  }
}

export function disposeHeadlessTerminal(state: HeadlessTerminalState): void {
  for (const sourceMarker of state.retainedMetricsTracker.sourceMarkers) {
    sourceMarker.disposeListener.dispose();
  }
  for (const disposable of state.retainedMetricsTracker.disposables) {
    disposable.dispose();
  }
  state.terminal.dispose();
}

function compareValues(expected: unknown, actual: unknown): RetainedHeadlessComparisonAxis {
  return JSON.stringify(expected) === JSON.stringify(actual) ? 'match' : 'mismatch';
}

function compareExternalAxis<T>(
  axis: RetainedHeadlessExternalAxis<T> | undefined,
): RetainedHeadlessComparisonAxis {
  return axis ? compareValues(axis.expected, axis.actual) : 'unavailable';
}

function foldComparisonAxes(axes: RetainedHeadlessComparisonAxes): RetainedHeadlessComparisonAxis {
  const values = Object.values(axes);
  if (values.includes('mismatch')) return 'mismatch';
  if (values.includes('unavailable')) return 'unavailable';
  return 'match';
}

function createRetainedMetricsTracker(terminal: HeadlessTerminalType): RetainedHeadlessMetricsTracker {
  return {
    rows: captureRetainedPhysicalRows(terminal.buffer.normal),
    trimTrackingAvailable: false,
    evictedPhysicalRows: 0,
    evictedLogicalRows: 0,
    evictedUtf8Bytes: 0,
    trimEvents: 0,
    completeLogicalRowBoundary: true,
    sourceMarkers: [],
    markerCoverage: 'none',
    disposables: [],
  };
}

function attachRetainedMetricsTracker(state: HeadlessTerminalState): void {
  const tracker = state.retainedMetricsTracker;
  const lineList = readInternalNormalLineList(state.terminal);
  if (lineList?.onTrim) {
    tracker.trimTrackingAvailable = true;
    tracker.disposables.push(lineList.onTrim((amount) => consumeRetainedTrim(tracker, amount)));
  }
  tracker.disposables.push(state.terminal.onScroll(() => {
    tracker.rows = captureRetainedPhysicalRows(state.terminal.buffer.normal);
  }));
  tracker.disposables.push(state.terminal.onResize(() => {
    tracker.rows = captureRetainedPhysicalRows(state.terminal.buffer.normal);
  }));
}

function captureRetainedPhysicalRows(buffer: RetainedBufferView): RetainedPhysicalRowMetric[] {
  const rows: RetainedPhysicalRowMetric[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    rows.push({
      wrapped: line?.isWrapped ?? false,
      utf8Bytes: Buffer.byteLength(line?.translateToString(true) ?? '', 'utf8'),
    });
  }
  return rows;
}

function consumeRetainedTrim(tracker: RetainedHeadlessMetricsTracker, amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) return;
  tracker.trimEvents += 1;
  tracker.evictedPhysicalRows += amount;
  const knownCount = Math.min(amount, tracker.rows.length);
  const removed = tracker.rows.slice(0, knownCount);
  const firstRetained = tracker.rows[knownCount];
  tracker.evictedUtf8Bytes += removed.reduce((total, row) => total + row.utf8Bytes, 0);

  for (let index = 0; index < removed.length; index += 1) {
    const next = removed[index + 1] ?? firstRetained;
    if (!next || !next.wrapped) tracker.evictedLogicalRows += 1;
  }
  if (knownCount < amount || firstRetained?.wrapped) {
    tracker.completeLogicalRowBoundary = false;
  }
  tracker.rows = tracker.rows.slice(knownCount);
}

function countRetainedLogicalRows(rows: readonly RetainedPhysicalRowMetric[]): number {
  if (rows.length === 0) return 0;
  let count = 1;
  for (let index = 1; index < rows.length; index += 1) {
    if (!rows[index]!.wrapped) count += 1;
  }
  return count;
}

function pruneDisposedSourceMarkers(tracker: RetainedHeadlessMetricsTracker): void {
  const previousCount = tracker.sourceMarkers.length;
  const retained: RetainedSourceMarker[] = [];
  for (const entry of tracker.sourceMarkers) {
    if (entry.marker.isDisposed) {
      entry.disposeListener.dispose();
    } else {
      retained.push(entry);
    }
  }
  tracker.sourceMarkers = retained;
  if (previousCount > 0 && retained.length === 0) {
    tracker.markerCoverage = 'partial';
  }
}

interface InternalNormalLineList {
  onTrim?(listener: (amount: number) => void): { dispose(): void };
}

function readInternalNormalLineList(terminal: HeadlessTerminalType): InternalNormalLineList | undefined {
  const internal = terminal as unknown as {
    _core?: {
      _bufferService?: {
        buffers?: {
          normal?: { lines?: InternalNormalLineList };
        };
      };
    };
  };
  return internal._core?._bufferService?.buffers?.normal?.lines;
}

function buildViewportAnsiPatch(
  viewportRows: ScreenRepairRowPatch[],
  cursor: { x: number; y: number; hidden?: boolean },
  cols: number,
): string {
  const patch: string[] = ['\x1b[?25l'];
  for (const row of viewportRows) {
    patch.push(`\x1b[${row.y + 1};1H\x1b[2K${row.ansi}`);
  }

  const cursorX = Math.max(1, Math.min(cols, cursor.x + 1));
  patch.push(`\x1b[0m\x1b[${cursor.y + 1};${cursorX}H${cursor.hidden ? '\x1b[?25l' : '\x1b[?25h'}`);
  return patch.join('');
}

function updateCursorVisibilityState(state: HeadlessTerminalState, data: string): void {
  const scan = `${state.cursorVisibilityTail}${data}`;
  const csiPattern = /(?:\x1b\[|\x9b)\?([0-9;:]*)?([hl])/g;
  let match: RegExpExecArray | null;
  while ((match = csiPattern.exec(scan)) !== null) {
    const params = (match[1] ?? '').split(/[;:]/).filter(Boolean);
    if (params.includes('25')) {
      state.cursorHidden = match[2] === 'l';
    }
  }
  state.cursorVisibilityTail = scan.slice(-64);
}

function updateSavedCursorState(state: HeadlessTerminalState, data: string): void {
  const scan = `${state.savedCursorControlTail}${data}`;
  const cursorControlPattern = /\x1bc|\x1b7|(?:\x1b\[|\x9b)s/g;
  let match: RegExpExecArray | null;
  while ((match = cursorControlPattern.exec(scan)) !== null) {
    state.savedCursorObserved = match[0] !== '\x1bc';
  }
  state.savedCursorControlTail = scan.slice(-8);
}

interface RetainedBufferView {
  readonly length: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(y: number): RepairLine | undefined;
  getNullCell(): RepairCell;
}

function projectRetainedBuffer(
  buffer: RetainedBufferView,
  startRow: number,
): RetainedHeadlessBufferProjection {
  const logicalLines: string[] = [];
  const cellTokens: unknown[] = [];
  const attributeTokens: unknown[] = [];
  const cell = buffer.getNullCell();

  const normalizedStartRow = Math.max(0, Math.min(startRow, buffer.length));
  for (let sourceY = normalizedStartRow, y = 0; sourceY < buffer.length; sourceY += 1, y += 1) {
    const line = buffer.getLine(sourceY);
    // When retention evicts the preceding half of a wrapped logical line, a
    // serialized fresh terminal necessarily starts a new logical line here.
    const wrapped = (normalizedStartRow === 0 || y > 0) && (line?.isWrapped ?? false);
    const rowToken = { y, wrapped };
    cellTokens.push(rowToken);
    attributeTokens.push(rowToken);

    const text = line?.translateToString(true) ?? '';
    if (wrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += text;
    } else {
      logicalLines.push(text);
    }

    if (!line) continue;
    for (let x = 0; x < line.length; x += 1) {
      const current = line.getCell(x, cell);
      if (!current) continue;
      cellTokens.push([x, current.getChars(), current.getCode(), current.getWidth()]);
      attributeTokens.push([
        x,
        current.getFgColorMode(), current.getFgColor(),
        current.getBgColorMode(), current.getBgColor(),
        current.isBold(), current.isDim(), current.isItalic(), current.isUnderline(),
        current.isBlink(), current.isInverse(), current.isInvisible(),
        current.isStrikethrough(), current.isOverline(),
      ]);
    }
  }

  while (logicalLines.length > 0 && logicalLines.at(-1) === '') {
    logicalLines.pop();
  }

  return {
    logicalLines,
    cellHash: hashRetainedTokens(cellTokens),
    attributeHash: hashRetainedTokens(attributeTokens),
  };
}

function hashRetainedTokens(tokens: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(tokens), 'utf8').digest('hex');
}

interface InternalSavedCursorBuffer {
  savedX?: unknown;
  savedY?: unknown;
  ybase?: unknown;
}

interface SavedCursorPositions {
  normal: { x: number; y: number } | null;
  alternate: { x: number; y: number } | null;
  active: { x: number; y: number } | null;
}

function readInternalSavedCursors(terminal: HeadlessTerminalType): SavedCursorPositions {
  const internal = terminal as unknown as {
    _core?: {
      _bufferService?: {
        buffer?: InternalSavedCursorBuffer;
        buffers?: {
          normal?: InternalSavedCursorBuffer;
          alternate?: InternalSavedCursorBuffer;
        };
      };
    };
  };
  const service = internal._core?._bufferService;
  return {
    normal: normalizeInternalSavedCursor(service?.buffers?.normal),
    alternate: normalizeInternalSavedCursor(service?.buffers?.alternate),
    active: normalizeInternalSavedCursor(service?.buffer),
  };
}

function normalizeInternalSavedCursor(
  buffer: InternalSavedCursorBuffer | undefined,
): { x: number; y: number } | null {
  if (!Number.isInteger(buffer?.savedX) || !Number.isInteger(buffer?.savedY)) {
    return null;
  }
  const ybase = Number.isInteger(buffer?.ybase) ? Number(buffer!.ybase) : 0;
  return {
    x: Number(buffer!.savedX),
    y: Math.max(0, Number(buffer!.savedY) - ybase),
  };
}

function injectSavedCursorState(
  serialized: string,
  activeBuffer: 'normal' | 'alternate',
  terminal: HeadlessTerminalType,
  saved: SavedCursorPositions,
): string {
  const normalSavedAnsi = buildSavedCursorAnsi(
    saved.normal,
    { x: terminal.buffer.normal.cursorX, y: terminal.buffer.normal.cursorY },
  );
  if (activeBuffer === 'normal') {
    return `${serialized}${normalSavedAnsi}`;
  }

  const alternateMarker = '\x1b[?1049h\x1b[H';
  const markerIndex = serialized.lastIndexOf(alternateMarker);
  const withNormalSaved = markerIndex >= 0
    ? `${serialized.slice(0, markerIndex)}${normalSavedAnsi}${serialized.slice(markerIndex)}`
    : `${serialized}${normalSavedAnsi}`;
  const alternateSavedAnsi = buildSavedCursorAnsi(
    saved.alternate,
    { x: terminal.buffer.alternate.cursorX, y: terminal.buffer.alternate.cursorY },
  );
  return `${withNormalSaved}${alternateSavedAnsi}`;
}

function buildSavedCursorAnsi(
  saved: { x: number; y: number } | null,
  current: { x: number; y: number },
): string {
  if (!saved) return '';
  return `${cursorPositionAnsi(saved)}\x1b7${cursorPositionAnsi(current)}`;
}

function cursorPositionAnsi(cursor: { x: number; y: number }): string {
  return `\x1b[${Math.max(0, cursor.y) + 1};${Math.max(0, cursor.x) + 1}H`;
}

function serializeLineAnsi(line: RepairLine, cols: number, cell: RepairCell): string {
  let ansi = '';
  let currentStyleKey = 'default';
  for (let x = 0; x < cols; x += 1) {
    const nextCell = line.getCell(x, cell);
    if (!nextCell) {
      break;
    }
    if (nextCell.getWidth() === 0) {
      continue;
    }

    const nextStyle = getCellStyle(nextCell);
    const nextStyleKey = getStyleKey(nextStyle);
    if (nextStyleKey !== currentStyleKey) {
      ansi += styleToSgr(nextStyle);
      currentStyleKey = nextStyleKey;
    }

    const chars = nextCell.getChars();
    ansi += chars.length > 0 ? chars : ' ';
  }

  if (currentStyleKey !== 'default') {
    ansi += '\x1b[0m';
  }
  return ansi;
}

function getCellStyle(cell: RepairCell): RepairStyle {
  return {
    fgMode: cell.getFgColorMode(),
    fg: cell.getFgColor(),
    fgRgb: cell.isFgRGB(),
    fgPalette: cell.isFgPalette(),
    bgMode: cell.getBgColorMode(),
    bg: cell.getBgColor(),
    bgRgb: cell.isBgRGB(),
    bgPalette: cell.isBgPalette(),
    bold: Boolean(cell.isBold()),
    dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    blink: Boolean(cell.isBlink()),
    inverse: Boolean(cell.isInverse()),
    invisible: Boolean(cell.isInvisible()),
    strikethrough: Boolean(cell.isStrikethrough()),
    overline: Boolean(cell.isOverline()),
  };
}

function getStyleKey(style: RepairStyle): string {
  if (
    style.fgMode === 0
    && style.fg === 0
    && style.bgMode === 0
    && style.bg === 0
    && !style.bold
    && !style.dim
    && !style.italic
    && !style.underline
    && !style.blink
    && !style.inverse
    && !style.invisible
    && !style.strikethrough
    && !style.overline
  ) {
    return 'default';
  }
  return JSON.stringify(style);
}

function styleToSgr(style: RepairStyle): string {
  const params: number[] = [0];
  appendFgSgr(params, style);
  appendBgSgr(params, style);
  if (style.bold) params.push(1);
  if (style.dim) params.push(2);
  if (style.italic) params.push(3);
  if (style.underline) params.push(4);
  if (style.blink) params.push(5);
  if (style.inverse) params.push(7);
  if (style.invisible) params.push(8);
  if (style.strikethrough) params.push(9);
  if (style.overline) params.push(53);
  return `\x1b[${params.join(';')}m`;
}

function appendFgSgr(params: number[], style: RepairStyle): void {
  if (style.fgMode === 0) {
    return;
  }
  if (style.fgRgb) {
    params.push(38, 2, (style.fg >>> 16) & 0xFF, (style.fg >>> 8) & 0xFF, style.fg & 0xFF);
    return;
  }
  if (style.fgPalette && style.fg >= 16) {
    params.push(38, 5, style.fg);
    return;
  }
  params.push((style.fg & 8) ? 90 + (style.fg & 7) : 30 + (style.fg & 7));
}

function appendBgSgr(params: number[], style: RepairStyle): void {
  if (style.bgMode === 0) {
    return;
  }
  if (style.bgRgb) {
    params.push(48, 2, (style.bg >>> 16) & 0xFF, (style.bg >>> 8) & 0xFF, style.bg & 0xFF);
    return;
  }
  if (style.bgPalette && style.bg >= 16) {
    params.push(48, 5, style.bg);
    return;
  }
  params.push((style.bg & 8) ? 100 + (style.bg & 7) : 40 + (style.bg & 7));
}
