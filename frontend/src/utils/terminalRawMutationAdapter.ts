import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import { isTerminalCheckpointModes } from '../types/ws-protocol.ts';
import type {
  TerminalWriteCoordinatorAdapter,
  TerminalWriteKind,
} from './terminalWriteCoordinator.ts';

export interface TerminalRawMutationAdapter extends TerminalWriteCoordinatorAdapter {
  clearScreen: () => void;
  fit: () => Readonly<{ cols: number; rows: number }>;
}

export interface TerminalRawMutationAdapterOptions {
  terminal: Terminal;
  fitAddon: FitAddon;
  applyModes?: (modes: Readonly<Record<string, boolean>>) => void;
  markReady: (viewGeneration: number) => void;
  releaseInput: (data: string) => void;
  settleInput: TerminalWriteCoordinatorAdapter['settleInput'];
  requestFreshRecovery: (reason: string) => void;
  requestRuntimeRecreation: TerminalWriteCoordinatorAdapter['requestRuntimeRecreation'];
  compatibilityRecoveryDrained: TerminalWriteCoordinatorAdapter['compatibilityRecoveryDrained'];
  settle: (
    token: string,
    outcome: 'written' | 'superseded' | 'disposed' | 'failed',
  ) => void;
  checkpointApplied: TerminalWriteCoordinatorAdapter['checkpointApplied'];
  checkpointDrained: TerminalWriteCoordinatorAdapter['checkpointDrained'];
}

const MODE_ESCAPE_SEQUENCES = Object.freeze({
  applicationCursorKeysMode: ['\u001b[?1l', '\u001b[?1h'],
  applicationKeypadMode: ['\u001b>', '\u001b='],
  bracketedPasteMode: ['\u001b[?2004l', '\u001b[?2004h'],
  insertMode: ['\u001b[4l', '\u001b[4h'],
  originMode: ['\u001b[?6l', '\u001b[?6h'],
  reverseWraparoundMode: ['\u001b[?45l', '\u001b[?45h'],
  sendFocusMode: ['\u001b[?1004l', '\u001b[?1004h'],
  wraparoundMode: ['\u001b[?7l', '\u001b[?7h'],
} satisfies Readonly<Record<string, readonly [string, string]>>);

const terminalEncoder = new TextEncoder();

// @req FR-BGSTAB-022 AC-2 AC-3
export function encodeTerminalModeRehydrate(
  modes: Readonly<Record<string, boolean>>,
): Uint8Array {
  if (!isTerminalCheckpointModes(modes)) {
    const unsupported = Object.keys(modes).find(name => !(name in MODE_ESCAPE_SEQUENCES));
    throw new TypeError(`unsupported terminal checkpoint mode: ${unsupported ?? 'invalid-mode-record'}`);
  }
  let encoded = '';
  for (const [name, enabled] of Object.entries(modes)) {
    const sequences = MODE_ESCAPE_SEQUENCES[name as keyof typeof MODE_ESCAPE_SEQUENCES];
    if (!sequences) throw new TypeError('terminal checkpoint mode preflight drift');
    encoded += sequences[enabled ? 1 : 0];
  }
  return terminalEncoder.encode(encoded);
}

function prependBytes(prefix: Uint8Array, data: string | Uint8Array): Uint8Array {
  const body = typeof data === 'string' ? terminalEncoder.encode(data) : data;
  const merged = new Uint8Array(prefix.byteLength + body.byteLength);
  merged.set(prefix, 0);
  merged.set(body, prefix.byteLength);
  return merged;
}

// @req FR-BGSTAB-022
export function createTerminalRawMutationAdapter(
  options: TerminalRawMutationAdapterOptions,
): TerminalRawMutationAdapter {
  const { terminal, fitAddon } = options;
  let pendingCheckpointModePrefix: Uint8Array = new Uint8Array();
  return Object.freeze({
    write: (
      command: Readonly<{ kind: TerminalWriteKind; data: string | Uint8Array }>,
      onWritten: () => void,
    ) => {
      if (command.kind !== 'checkpoint') {
        terminal.write(command.data, onWritten);
        return;
      }
      const prefix = pendingCheckpointModePrefix;
      pendingCheckpointModePrefix = new Uint8Array();
      terminal.write(prependBytes(prefix, command.data), onWritten);
    },
    probeWritePipeline: (onWritten: () => void) => terminal.write('', onWritten),
    resetParser: () => terminal.reset(),
    resize: (cols: number, rows: number) => terminal.resize(cols, rows),
    applyModes: (modes: Readonly<Record<string, boolean>>) => {
      pendingCheckpointModePrefix = encodeTerminalModeRehydrate(modes);
      options.applyModes?.(modes);
    },
    clearScreen: () => terminal.clear(),
    fit: () => {
      fitAddon.fit();
      return Object.freeze({ cols: terminal.cols, rows: terminal.rows });
    },
    setWindowsPty: (value: unknown) => {
      terminal.options.windowsPty = value as Terminal['options']['windowsPty'];
    },
    markReady: options.markReady,
    releaseInput: options.releaseInput,
    settleInput: options.settleInput,
    requestFreshRecovery: options.requestFreshRecovery,
    requestRuntimeRecreation: options.requestRuntimeRecreation,
    compatibilityRecoveryDrained: options.compatibilityRecoveryDrained,
    settle: options.settle,
    checkpointApplied: options.checkpointApplied,
    checkpointDrained: options.checkpointDrained,
  });
}

// @req FR-BGSTAB-022
export function digestTerminalBytes(bytes: Uint8Array): string {
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;
  const bitLength = BigInt(bytes.byteLength) * 8n;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffff_ffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffff_ffffn));

  const roundConstants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  const rotateRight = (value: number, count: number): number => (
    (value >>> count) | (value << (32 - count))
  ) >>> 0;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15]!;
      const previous2 = words[index - 2]!;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choice + roundConstants[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
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
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  return `sha256:${state.map(word => word.toString(16).padStart(8, '0')).join('')}`;
}
