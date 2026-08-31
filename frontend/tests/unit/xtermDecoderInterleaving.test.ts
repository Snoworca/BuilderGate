import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);

const { Terminal } = require('@xterm/headless') as {
  Terminal: new (options?: Record<string, unknown>) => XtermHeadlessTerminal;
};

interface XtermHeadlessTerminal {
  write(data: string | Uint8Array, callback?: () => void): void;
  dispose(): void;
  readonly buffer: {
    readonly active: {
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/**
 * '한' (U+D55C) encodes to ED 95 9C. Splitting after two bytes leaves the
 * third byte outstanding, which is what parks a partial sequence in
 * Utf8ToUtf32's 3-byte `interim` buffer.
 */
const HAN_BYTES = Object.freeze([0xed, 0x95, 0x9c]);
const HAN_HEAD = () => new Uint8Array(HAN_BYTES.slice(0, 2));
const HAN_TAIL = () => new Uint8Array(HAN_BYTES.slice(2));
const HAN_WHOLE = () => new Uint8Array(HAN_BYTES);

function createTerminal(): XtermHeadlessTerminal {
  return new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
}

function writeAsync(terminal: XtermHeadlessTerminal, data: string | Uint8Array): Promise<void> {
  return new Promise(resolve => {
    terminal.write(data, () => resolve());
  });
}

async function firstLineAfter(
  writes: readonly (string | Uint8Array)[],
): Promise<string> {
  const terminal = createTerminal();
  try {
    for (const chunk of writes) {
      await writeAsync(terminal, chunk);
    }
    return terminal.buffer.active.getLine(0)?.translateToString(true) ?? '';
  } finally {
    terminal.dispose();
  }
}

/**
 * Substitution guard. Arm A measures `@xterm/headless`; production renders with
 * `@xterm/xterm`. The characterization only transfers while the two are the same
 * release. If they drift, this fails loudly instead of silently going stale.
 */
test('Arm A guard — headless and browser xterm are the same version', () => {
  const headlessVersion = require('@xterm/headless/package.json').version as string;
  const browserVersion = require('@xterm/xterm/package.json').version as string;
  assert.equal(
    headlessVersion,
    browserVersion,
    'Arm A substitutes @xterm/headless for @xterm/xterm; a version split invalidates the substitution',
  );
});

/**
 * Characterization, not a contract. xterm picks its decoder per write chunk
 * (`_stringDecoder` for string, `_utf8Decoder` for bytes) and parses immediately,
 * so a string write jumps ahead of bytes still parked in the utf8 `interim`
 * buffer. Source order `한` then `X` renders as `X한`.
 *
 * The live output path never reaches this today — every byte write it performs
 * is codepoint-aligned. Locking the behaviour down here means the day that
 * changes is the day this test moves.
 */
test('Arm A case 1 — a string write between split byte writes reorders output', async () => {
  const line = await firstLineAfter([HAN_HEAD(), 'X', HAN_TAIL()]);
  assert.equal(line, 'X한');
});

test('Arm A case 2 (boundary control) — an unsplit byte write keeps source order', async () => {
  const line = await firstLineAfter([HAN_WHOLE(), 'X']);
  assert.equal(
    line,
    '한X',
    'if this fails, the case 1 result is not about interim buffering at all',
  );
});

test('Arm A case 3 (boundary control) — an empty string write does not disturb interim', async () => {
  const line = await firstLineAfter([HAN_HEAD(), '', HAN_TAIL()]);
  assert.equal(line, '한');
});

test('Arm A case 4 (boundary control) — split byte writes with nothing between recombine', async () => {
  const line = await firstLineAfter([HAN_HEAD(), HAN_TAIL()]);
  assert.equal(
    line,
    '한',
    'the split itself must be lossless; only an interleaved write may reorder',
  );
});
