import { createHash } from 'node:crypto';
import type { ISerializeOptions, SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import serializeModule from '@xterm/addon-serialize';
import unicode11Module from '@xterm/addon-unicode11';
import type { ITerminalOptions, Terminal as HeadlessTerminalType } from '@xterm/headless';
import headlessModule from '@xterm/headless';
import type {
  ScreenRepairBufferType,
  ScreenRepairRowPatch,
  WindowsPtyInfo,
} from '../types/ws-protocol.js';

const { SerializeAddon } = serializeModule;
const { Unicode11Addon } = unicode11Module;
const { Terminal } = headlessModule;

/**
 * Issue #114. The unicode width table both engines use.
 *
 * xterm's built-in table is Unicode 6, under which every astral emoji is one
 * cell. A shell computing its own line width uses wcwidth, which gives two, so
 * the two disagree about where the cursor is the moment any emoji is printed —
 * and modern CLI and agent output is full of them. Measured 2026-09-20 across
 * both engines: astral emoji 1 -> 2 cells, a ZWJ family 3 -> 6, a skin-tone pair
 * 2 -> 4; CJK, ambiguous-width and ASCII unchanged. Both engines returned
 * identical values for every sample, which is the property that matters here.
 *
 * It MUST be loaded on both sides or on neither. One side alone shifts recovered
 * output by a cell from the first emoji onward, which is the failure
 * FR-BGSTAB-029 exists to prevent;
 * frontend/tests/unit/terminalWidthPolicyParity.test.ts fails when only one
 * source tree loads one, and frontend/tests/unit/terminalUnicodeWidthGolden.test.ts
 * runs both engines and compares them against recorded values.
 *
 * Bound: Unicode 11 is a per-code-point table, not a grapheme segmenter. A BMP
 * emoji with VS16 stays one cell and a ZWJ sequence is the sum of its parts
 * rather than one glyph's width. `@xterm/addon-unicode-graphemes` is the thing
 * that would change that, and adopting it is a separate decision that would have
 * to be taken on both sides at once for the same reason.
 */
export const UNICODE_WIDTH_VERSION = '11';

function installUnicodeWidthTable(terminal: HeadlessTerminalType): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = UNICODE_WIDTH_VERSION;
}

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

/**
 * A range of committed source records that touched one physical line of the normal buffer.
 *
 * PERF-BGSTAB-031: this used to hold an xterm marker. xterm tells every marker about every
 * trimmed row, so with a range per scrollback row one scrolled line cost O(scrollback)
 * (150 us at 10,000 rows). The range now keeps the line itself, counted from the first row the
 * buffer ever held, which a trim does not change; the tracker applies the rules xterm applies
 * to a marker -- a trim, an insert and a delete from the line-list events, and an erased line
 * from Buffer.clearMarkers -- and drops every range when RIS replaces the buffer.
 */
interface RetainedSourceRange {
  /** Stream epoch for the source range. Ranges never coalesce across rollover. */
  streamEpoch: string;
  /** Oldest committed source identity known to have touched this physical line. */
  sourceSeq: string;
  /** Newest committed source identity coalesced into this physical-line range. */
  latestSourceSeq: string;
  /** Buffer line plus the rows trimmed before it was read; below the trimmed count means gone. */
  absoluteLine: number;
  disposed: boolean;
}

interface RetainedSourceRangeIndex {
  bySequence: Map<string, RetainedSourceRange>;
  /** Ranges per absolute line, in creation order. Rebuilt after an insert or a delete. */
  byLine: Map<number, RetainedSourceRange[]>;
  linesValid: boolean;
  disposedPending: number;
}

interface RetainedHeadlessMetricsTracker {
  rows: RetainedPhysicalRowMetric[];
  /**
   * PERF-BGSTAB-018: how many leading rows of `rows` are known to be final. Rows above the
   * viewport cannot be written any more, so a refresh recomputes only from here to the end.
   * Resize (reflow) and a shrinking buffer (scrollback clear) reset it to 0.
   */
  stableRows: number;
  /**
   * PERF-BGSTAB-031: running totals over `rows`, so a read does not walk the scrollback.
   * `unwrappedRows` counts the rows that start a logical line of their own.
   */
  totalUtf8Bytes: number;
  unwrappedRows: number;
  trimTrackingAvailable: boolean;
  evictedPhysicalRows: number;
  evictedLogicalRows: number;
  evictedUtf8Bytes: number;
  trimEvents: number;
  completeLogicalRowBoundary: boolean;
  /** False when xterm does not report what moves or removes a line's source range. */
  lineEventsAvailable: boolean;
  /** The normal buffer the listeners are on. RIS replaces it, and they are then moved. */
  attachedBuffer: InternalNormalBuffer | undefined;
  detachBuffer: () => void;
  /** Live source ranges, oldest first. */
  sourceMarkers: RetainedSourceRange[];
  markerIndex: RetainedSourceRangeIndex;
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

/**
 * Issue #114. `reflowCursorLine` is false on both sides, and both sides say so
 * explicitly rather than inheriting the default, so an xterm release that moved
 * the default would move them together or not at all.
 *
 * It used to be true here and unset in the browser. Measured 2026-09-20 by
 * driving both engines through one stream: with the cursor on a wrapped prompt
 * line — the state a live shell is normally in — a 40 -> 72 resize put the same
 * text on different rows with the cursor two rows apart, and 40 -> 24 diverged
 * the other way. Committed history agreed either way, which is why nothing
 * noticed. This replica exists to reproduce what the browser shows so restore
 * can hand it back, so a divergence is a defect here by definition.
 *
 * False rather than true on both sides because xterm's default is false for a
 * stated reason — "shells usually handle this themselves" — and the browser
 * terminal is attached to a real shell. Both engines consume that one shell's
 * output. frontend/tests/unit/terminalReflowParity.test.ts drives both engines
 * and fails if they diverge again.
 */
const DEFAULT_TERMINAL_OPTIONS: Pick<ITerminalOptions, 'allowProposedApi' | 'reflowCursorLine'> = {
  allowProposedApi: true,
  reflowCursorLine: false,
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
  installUnicodeWidthTable(terminal);
  // REL-BGSTAB-051 AC-1: xterm keeps a marker, its listeners and a link entry (~3 KB) for every
  // OSC 8 hyperlink without an id, freed only when the line leaves scrollback. A TUI that
  // redraws in place, clears or resets never frees them; the 2002 daemon reached the V8 heap
  // limit this way (2026-10-23). The serialize addon never writes links back, so restored
  // screens never had them: a handler that consumes OSC 8 here changes no text, cursor or
  // live output byte. Browsers still receive the original sequence.
  terminal.parser.registerOscHandler(8, () => true);
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

/**
 * PERF-BGSTAB-019: xterm's WriteBuffer defers a write to a `setTimeout` tick unless it follows
 * user input. On Windows a tick is ~15.6 ms, which capped the serialized headless queue near
 * 64 chunks/s per session. Flagging the write as user-input-adjacent makes xterm parse it in the
 * same call through its normal (async-handler safe) path; only the timer wait is removed.
 */
function processHeadlessWriteImmediately(terminal: HeadlessTerminalState['terminal']): void {
  const writeBuffer = (terminal as unknown as { _core?: { _writeBuffer?: { handleUserInput?: () => void } } })
    ._core?._writeBuffer;
  writeBuffer?.handleUserInput?.();
}

export function writeHeadlessTerminal(state: HeadlessTerminalState, data: string): Promise<void> {
  return new Promise((resolve) => {
    processHeadlessWriteImmediately(state.terminal);
    state.terminal.write(data, () => {
      updateCursorVisibilityState(state, data);
      updateSavedCursorState(state, data);
      resolve();
    });
  });
}

/**
 * FR-MCP-008: the last `maxLines` logical lines of the active buffer as plain text. Wrapped rows
 * are joined back into one line, attributes are dropped and trailing blank lines trimmed.
 */
/** OSC 8 link entries xterm holds for this terminal (REL-BGSTAB-051 AC-2; expected 0). */
export function countHeadlessOscLinks(state: HeadlessTerminalState): number {
  const core = (state.terminal as unknown as { _core?: { _oscLinkService?: { _dataByLinkId?: Map<number, unknown> } } })._core;
  return core?._oscLinkService?._dataByLinkId?.size ?? 0;
}

export function readHeadlessTerminalText(state: HeadlessTerminalState, maxLines: number): string {
  if (maxLines <= 0) return '';
  const buffer = state.terminal.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.slice(-maxLines).map(line => line.trimEnd()).join('\n');
}

export function resizeHeadlessTerminal(state: HeadlessTerminalState, cols: number, rows: number): void {
  // A reflow can trim rows that are still in the viewport, so they are measured first.
  refreshRetainedPhysicalRows(state.retainedMetricsTracker, state.terminal);
  state.terminal.resize(cols, rows);
}

export type HeadlessMouseEncoding = 'DEFAULT' | 'SGR' | 'SGR_PIXELS';

/**
 * REL-BGSTAB-039: the mouse report encoding the application selected. The serialize addon
 * restores the tracking mode (?1000/1002/1003h) but not the encoding (?1006h/?1016h), and xterm
 * does not expose it publicly, so it is read from the core the same way the write buffer is.
 * Resets (RIS, term.reset) are reflected because this is xterm's own state, not a copy.
 */
export function readHeadlessMouseEncoding(state: HeadlessTerminalState): HeadlessMouseEncoding | null {
  const encoding = (state.terminal as unknown as { _core?: { coreMouseService?: { activeEncoding?: unknown } } })
    ._core?.coreMouseService?.activeEncoding;
  return encoding === 'DEFAULT' || encoding === 'SGR' || encoding === 'SGR_PIXELS' ? encoding : null;
}

/** The DECSET that re-selects `encoding` on a rehydrated terminal; nothing for the default. */
export function mouseEncodingRestoreSequence(encoding: HeadlessMouseEncoding | null): string {
  if (encoding === 'SGR') return '\x1b[?1006h';
  if (encoding === 'SGR_PIXELS') return '\x1b[?1016h';
  return '';
}

function serializeWithMouseEncoding(state: HeadlessTerminalState, options?: ISerializeOptions): string {
  return state.serializeAddon.serialize(options) + mouseEncodingRestoreSequence(readHeadlessMouseEncoding(state));
}

export function serializeHeadlessTerminal(
  state: HeadlessTerminalState,
  maxSnapshotBytes: number,
  options?: ISerializeOptions,
): SerializedHeadlessSnapshot {
  const serialized = serializeWithMouseEncoding(state, options ?? VIEWPORT_ONLY_SERIALIZE_OPTIONS);
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
  const serialized = serializeWithMouseEncoding(state);
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
  const index = tracker.markerIndex;
  if (index.bySequence.has(markerKey(streamEpoch, sourceSeq))) return true;

  const normalBuffer = state.terminal.buffer.normal;
  if (state.terminal.buffer.active.type !== 'normal' || !tracker.lineEventsAvailable) {
    tracker.markerCoverage = 'partial';
    return false;
  }
  const absoluteLine = normalBuffer.baseY + normalBuffer.cursorY + tracker.evictedPhysicalRows;
  const currentLineRange = sourceRangesOnLine(tracker, absoluteLine)
    ?.find(entry => entry.streamEpoch === streamEpoch);
  if (currentLineRange) {
    if (currentLineRange.latestSourceSeq !== currentLineRange.sourceSeq) {
      index.bySequence.delete(markerKey(streamEpoch, currentLineRange.latestSourceSeq));
    }
    currentLineRange.latestSourceSeq = sourceSeq;
    index.bySequence.set(markerKey(streamEpoch, sourceSeq), currentLineRange);
    return true;
  }

  const entry: RetainedSourceRange = { streamEpoch, sourceSeq, latestSourceSeq: sourceSeq, absoluteLine, disposed: false };
  tracker.sourceMarkers.push(entry);
  index.bySequence.set(markerKey(streamEpoch, sourceSeq), entry);
  addSourceRangeToLine(index, entry);
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
  refreshRetainedPhysicalRows(tracker, state.terminal);
  pruneDisposedSourceMarkers(tracker);
  const rows = tracker.rows;
  return {
    trimTracking: tracker.trimTrackingAvailable ? 'xterm-line-events' : 'unavailable',
    currentPhysicalRows: rows.length,
    // The first row always starts a logical row, wrapped or not.
    currentLogicalRows: rows.length === 0 ? 0 : tracker.unwrappedRows + (rows[0]!.wrapped ? 1 : 0),
    currentUtf8Bytes: tracker.totalUtf8Bytes,
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
  state.retainedMetricsTracker.sourceMarkers.length = 0;
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
  const rows = captureRetainedPhysicalRows(terminal.buffer.normal);
  return {
    rows,
    stableRows: Math.max(0, terminal.buffer.normal.length - terminal.rows),
    totalUtf8Bytes: rows.reduce((total, row) => total + row.utf8Bytes, 0),
    unwrappedRows: rows.reduce((total, row) => total + (row.wrapped ? 0 : 1), 0),
    trimTrackingAvailable: false,
    evictedPhysicalRows: 0,
    evictedLogicalRows: 0,
    evictedUtf8Bytes: 0,
    trimEvents: 0,
    completeLogicalRowBoundary: true,
    lineEventsAvailable: false,
    attachedBuffer: undefined,
    detachBuffer: () => undefined,
    sourceMarkers: [],
    markerIndex: { bySequence: new Map(), byLine: new Map(), linesValid: true, disposedPending: 0 },
    markerCoverage: 'none',
    disposables: [],
  };
}

function attachRetainedMetricsTracker(state: HeadlessTerminalState): void {
  const tracker = state.retainedMetricsTracker;
  attachRetainedNormalBuffer(tracker, state.terminal);
  tracker.disposables.push({ dispose: () => tracker.detachBuffer() });
  tracker.disposables.push(state.terminal.buffer.onBufferChange(() => {
    // RIS (ESC c) builds a new normal buffer. Its rows and its line events are not the old ones:
    // move the listeners, measure the new rows, and drop the ranges of the rows that are gone.
    if (readInternalNormalBuffer(state.terminal) === tracker.attachedBuffer) return;
    attachRetainedNormalBuffer(tracker, state.terminal);
    for (const entry of tracker.sourceMarkers) {
      if (!entry.disposed) disposeSourceRange(tracker.markerIndex, entry);
    }
    tracker.markerIndex.byLine.clear();
    tracker.markerIndex.linesValid = true;
    tracker.stableRows = 0;
    refreshRetainedPhysicalRows(tracker, state.terminal);
  }));
  tracker.disposables.push(state.terminal.onScroll(() => {
    recordRetainedScroll(tracker, state.terminal);
  }));
  tracker.disposables.push(state.terminal.onResize(() => {
    // Reflow rewrites every row, so nothing is stable any more.
    tracker.stableRows = 0;
    refreshRetainedPhysicalRows(tracker, state.terminal);
  }));
}

function attachRetainedNormalBuffer(tracker: RetainedHeadlessMetricsTracker, terminal: HeadlessTerminalType): void {
  tracker.detachBuffer();
  const buffer = readInternalNormalBuffer(terminal);
  const lineList = buffer?.lines;
  const attached: Array<{ dispose(): void }> = [];
  tracker.attachedBuffer = buffer;
  tracker.detachBuffer = () => { for (const disposable of attached.splice(0)) disposable.dispose(); };
  tracker.trimTrackingAvailable = false;
  tracker.lineEventsAvailable = false;
  if (!buffer || !lineList?.onTrim) return;
  tracker.trimTrackingAvailable = true;
  attached.push(lineList.onTrim((amount) => consumeRetainedTrim(tracker, amount)));
  const clearMarkers = buffer.clearMarkers;
  if (!lineList.onInsert || !lineList.onDelete || typeof clearMarkers !== 'function') return;
  tracker.lineEventsAvailable = true;
  attached.push(
    lineList.onInsert(event => moveSourceRangesForInsert(tracker, event.index, event.amount)),
    lineList.onDelete(event => moveSourceRangesForDelete(tracker, event.index, event.amount)),
  );
  // An erase (ED) removes the markers of each line it resets and reports it nowhere else.
  buffer.clearMarkers = (line: number): void => {
    clearMarkers.call(buffer, line);
    disposeSourceRangesOnLine(tracker, line + tracker.evictedPhysicalRows);
  };
  attached.push({ dispose: () => { delete buffer.clearMarkers; } });
}

/**
 * PERF-BGSTAB-018: brings `tracker.rows` up to date by recomputing only the rows that can still
 * change -- from the previous viewport top to the end -- instead of the whole scrollback.
 */
function refreshRetainedPhysicalRows(
  tracker: RetainedHeadlessMetricsTracker,
  terminal: { buffer: { normal: RetainedBufferView }; rows: number },
): void {
  const buffer = terminal.buffer.normal;
  const length = buffer.length;
  const rows = tracker.rows;
  // A buffer shorter than what we believed final (e.g. a scrollback clear) invalidates it all.
  const keep = length < tracker.stableRows ? 0 : Math.min(tracker.stableRows, rows.length, length);
  for (let y = keep; y < rows.length; y += 1) forgetRetainedRow(tracker, rows[y]!);
  rows.length = Math.min(rows.length, length);
  for (let y = keep; y < length; y += 1) measureRetainedRow(tracker, buffer, y);
  tracker.stableRows = Math.max(0, length - terminal.rows);
}

/**
 * PERF-BGSTAB-031: what a scroll has to record. A scroll makes the rows that left the viewport
 * final, so those are measured now. The rows still in the viewport are measured again by the
 * next read anyway; until then only a trim reads them, and a trim reaches no further than the
 * first viewport row (a scrollback clear) while at least two rows are final. So this measures
 * the rows that became final, the first viewport row, and the rows that are new -- instead of
 * the whole viewport on every scrolled line. A reflow can trim further; resizeHeadlessTerminal
 * refreshes before it.
 */
function recordRetainedScroll(
  tracker: RetainedHeadlessMetricsTracker,
  terminal: { buffer: { normal: RetainedBufferView }; rows: number },
): void {
  const buffer = terminal.buffer.normal;
  const length = buffer.length;
  const rows = tracker.rows;
  const stable = Math.max(0, length - terminal.rows);
  if (stable < 2 || tracker.stableRows > rows.length || rows.length > length || stable < tracker.stableRows) {
    refreshRetainedPhysicalRows(tracker, terminal);
    return;
  }
  for (let y = tracker.stableRows; y < length; y += 1) {
    if (y > stable && y < rows.length) continue;
    if (y < rows.length) forgetRetainedRow(tracker, rows[y]!);
    measureRetainedRow(tracker, buffer, y);
  }
  tracker.stableRows = stable;
}

function measureRetainedRow(tracker: RetainedHeadlessMetricsTracker, buffer: RetainedBufferView, y: number): void {
  const line = buffer.getLine(y);
  const row = {
    wrapped: line?.isWrapped ?? false,
    utf8Bytes: Buffer.byteLength(line?.translateToString(true) ?? '', 'utf8'),
  };
  tracker.rows[y] = row;
  tracker.totalUtf8Bytes += row.utf8Bytes;
  if (!row.wrapped) tracker.unwrappedRows += 1;
}

function forgetRetainedRow(tracker: RetainedHeadlessMetricsTracker, row: RetainedPhysicalRowMetric): void {
  tracker.totalUtf8Bytes -= row.utf8Bytes;
  if (!row.wrapped) tracker.unwrappedRows -= 1;
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
  disposeTrimmedSourceRanges(tracker, amount);
  tracker.evictedPhysicalRows += amount;
  const rows = tracker.rows;
  const knownCount = Math.min(amount, rows.length);

  // shift() and not splice(0, n): V8 moves the start of a large array for shift, but copies
  // every remaining element for splice (43 us against 0.08 us per row at 10,000 rows).
  for (let index = 0; index < knownCount; index += 1) {
    const row = rows.shift()!;
    tracker.evictedUtf8Bytes += row.utf8Bytes;
    forgetRetainedRow(tracker, row);
    const next = rows[0];
    if (!next || !next.wrapped) tracker.evictedLogicalRows += 1;
  }
  if (knownCount < amount || rows[0]?.wrapped) {
    tracker.completeLogicalRowBoundary = false;
  }
  tracker.stableRows = Math.max(0, tracker.stableRows - knownCount);
}

function markerKey(streamEpoch: string, value: string): string {
  return `${streamEpoch}\u0000${value}`;
}

function addSourceRangeToLine(index: RetainedSourceRangeIndex, entry: RetainedSourceRange): void {
  if (!index.linesValid) return;
  const onLine = index.byLine.get(entry.absoluteLine);
  if (onLine) onLine.push(entry);
  else index.byLine.set(entry.absoluteLine, [entry]);
}

/** The live ranges on a line, oldest first. */
function sourceRangesOnLine(
  tracker: RetainedHeadlessMetricsTracker,
  absoluteLine: number,
): RetainedSourceRange[] | undefined {
  const index = tracker.markerIndex;
  if (!index.linesValid) {
    index.byLine.clear();
    index.linesValid = true;
    for (const entry of tracker.sourceMarkers) {
      if (!entry.disposed) addSourceRangeToLine(index, entry);
    }
  }
  return index.byLine.get(absoluteLine);
}

function disposeSourceRange(index: RetainedSourceRangeIndex, entry: RetainedSourceRange): void {
  entry.disposed = true;
  index.disposedPending += 1;
  index.bySequence.delete(markerKey(entry.streamEpoch, entry.sourceSeq));
  index.bySequence.delete(markerKey(entry.streamEpoch, entry.latestSourceSeq));
}

function disposeSourceRangesOnLine(tracker: RetainedHeadlessMetricsTracker, absoluteLine: number): void {
  const onLine = sourceRangesOnLine(tracker, absoluteLine);
  if (!onLine) return;
  for (const entry of onLine) disposeSourceRange(tracker.markerIndex, entry);
  tracker.markerIndex.byLine.delete(absoluteLine);
}

/** xterm's marker rule for a trim: a range whose line was trimmed is gone. */
function disposeTrimmedSourceRanges(tracker: RetainedHeadlessMetricsTracker, amount: number): void {
  if (tracker.sourceMarkers.length === 0) return;
  const first = tracker.evictedPhysicalRows;
  for (let absoluteLine = first; absoluteLine < first + amount; absoluteLine += 1) {
    disposeSourceRangesOnLine(tracker, absoluteLine);
  }
}

/** xterm's marker rule for an insert: a range at or below the inserted rows moves down. */
function moveSourceRangesForInsert(tracker: RetainedHeadlessMetricsTracker, index: number, amount: number): void {
  const from = index + tracker.evictedPhysicalRows;
  for (const entry of tracker.sourceMarkers) {
    if (!entry.disposed && entry.absoluteLine >= from) entry.absoluteLine += amount;
  }
  tracker.markerIndex.linesValid = false;
}

/** xterm's marker rule for a delete: a range on a deleted row is gone, one below it moves up. */
function moveSourceRangesForDelete(tracker: RetainedHeadlessMetricsTracker, index: number, amount: number): void {
  const from = index + tracker.evictedPhysicalRows;
  for (const entry of tracker.sourceMarkers) {
    if (entry.disposed) continue;
    if (entry.absoluteLine >= from && entry.absoluteLine < from + amount) disposeSourceRange(tracker.markerIndex, entry);
    else if (entry.absoluteLine > from) entry.absoluteLine -= amount;
  }
  tracker.markerIndex.linesValid = false;
}

function pruneDisposedSourceMarkers(tracker: RetainedHeadlessMetricsTracker): void {
  const index = tracker.markerIndex;
  if (index.disposedPending === 0) return;
  const markers = tracker.sourceMarkers;
  // A trim disposes the oldest ranges, which are at the front; then nothing else has to move.
  // shift() for the reason given in consumeRetainedTrim.
  let removed = 0;
  while (markers.length > 0 && markers[0]!.disposed) {
    markers.shift();
    removed += 1;
  }
  if (removed < index.disposedPending) tracker.sourceMarkers = markers.filter(entry => !entry.disposed);
  index.disposedPending = 0;
  if (tracker.sourceMarkers.length === 0) {
    tracker.markerCoverage = 'partial';
  }
}

interface InternalNormalLineList {
  onTrim?(listener: (amount: number) => void): { dispose(): void };
  onInsert?(listener: (event: { index: number; amount: number }) => void): { dispose(): void };
  onDelete?(listener: (event: { index: number; amount: number }) => void): { dispose(): void };
}

interface InternalNormalBuffer {
  lines?: InternalNormalLineList;
  clearMarkers?: (line: number) => void;
}

function readInternalNormalBuffer(terminal: HeadlessTerminalType): InternalNormalBuffer | undefined {
  const internal = terminal as unknown as {
    _core?: { _bufferService?: { buffers?: { normal?: InternalNormalBuffer } } };
  };
  return internal._core?._bufferService?.buffers?.normal;
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

// xterm stores an ANSI palette colour under two interchangeable modes: the
// 16-colour short form (`ESC[33m`) as P16 and the indexed form (`ESC[38;5;3m`)
// as P256. Both name the same palette slot and render identically, but
// @xterm/addon-serialize always re-emits slots 0..15 in the short form. A
// checkpoint minted from indexed SGR therefore rehydrates as P16 and the
// attribute hash diverges on content that is byte-for-byte equivalent on
// screen, which permanently fails the retained-state promotion parity gate.
// Canonicalizing P16 onto the shared palette index removes that false
// mismatch. DEFAULT and RGB are left alone: they are genuinely other modes.
// @req FR-BGSTAB-027 AC-2 AC-3
const XTERM_COLOR_MODE_P16 = 0x01000000;
const XTERM_COLOR_MODE_P256 = 0x02000000;
const XTERM_PALETTE_16_SIZE = 16;

function canonicalPaletteColor(mode: number, color: number): readonly [number, number] {
  if (mode === XTERM_COLOR_MODE_P16 && color >= 0 && color < XTERM_PALETTE_16_SIZE) {
    return [XTERM_COLOR_MODE_P256, color];
  }
  return [mode, color];
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
        ...canonicalPaletteColor(current.getFgColorMode(), current.getFgColor()),
        ...canonicalPaletteColor(current.getBgColorMode(), current.getBgColor()),
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
