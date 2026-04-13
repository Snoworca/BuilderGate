import type { ISerializeOptions, SerializeAddon as SerializeAddonType } from '@xterm/addon-serialize';
import serializeModule from '@xterm/addon-serialize';
import type { ITerminalOptions, Terminal as HeadlessTerminalType } from '@xterm/headless';
import headlessModule from '@xterm/headless';

const { SerializeAddon } = serializeModule;
const { Terminal } = headlessModule;

export interface HeadlessTerminalState {
  terminal: HeadlessTerminalType;
  serializeAddon: SerializeAddonType;
}

export interface SerializedHeadlessSnapshot {
  cols: number;
  rows: number;
  data: string;
  truncated: boolean;
}

const DEFAULT_TERMINAL_OPTIONS: Pick<ITerminalOptions, 'allowProposedApi' | 'reflowCursorLine'> = {
  allowProposedApi: true,
  reflowCursorLine: true,
};

export function createHeadlessTerminalState(options: {
  cols: number;
  rows: number;
  scrollbackLines: number;
}): HeadlessTerminalState {
  const terminal = new Terminal({
    ...DEFAULT_TERMINAL_OPTIONS,
    cols: options.cols,
    rows: options.rows,
    scrollback: options.scrollbackLines,
  });
  const serializeAddon = new SerializeAddon();
  terminal.loadAddon(serializeAddon);
  return { terminal, serializeAddon };
}

export function writeHeadlessTerminal(state: HeadlessTerminalState, data: string): Promise<void> {
  return new Promise((resolve) => {
    state.terminal.write(data, resolve);
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

export function disposeHeadlessTerminal(state: HeadlessTerminalState): void {
  state.terminal.dispose();
}
