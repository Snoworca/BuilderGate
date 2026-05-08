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
}

export interface SerializedHeadlessSnapshot {
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
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
  | { ok: false; reason: 'geometry-mismatch' | 'buffer-mismatch' | 'headless-degraded' | 'generation-failed' };

interface RepairCell {
  getWidth(): number;
  getChars(): string;
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
  readonly isWrapped: boolean;
  getCell(x: number, cell?: RepairCell): RepairCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
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
  return {
    terminal,
    serializeAddon,
    cursorHidden: false,
    cursorVisibilityTail: '',
  };
}

export function writeHeadlessTerminal(state: HeadlessTerminalState, data: string): Promise<void> {
  return new Promise((resolve) => {
    state.terminal.write(data, () => {
      updateCursorVisibilityState(state, data);
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
  const serialized = state.serializeAddon.serialize(options);
  if (serialized.length > maxSnapshotBytes) {
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
  state.terminal.dispose();
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
