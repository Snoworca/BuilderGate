import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareRetainedHeadlessCheckpointRoundTrip,
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
  writeHeadlessTerminal,
} from './headlessTerminal.js';

const ESC = String.fromCharCode(27);
const SCROLLBACK = 1000;
const COLS = 120;
const ROWS = 30;

/**
 * Drives a fresh headless terminal with `body`, then compares its retained
 * checkpoint against a rehydrated round-trip exactly as the shadow comparer
 * does in SessionManager.runRetainedTerminalComparison.
 */
async function roundTripAxes(body: string) {
  const state = createHeadlessTerminalState({
    cols: COLS,
    rows: ROWS,
    scrollbackLines: SCROLLBACK,
  });
  try {
    await writeHeadlessTerminal(state, body);
    const checkpoint = {
      ...serializeRetainedHeadlessCheckpoint(state),
      pendingEscapeTailAnsi: '',
    };
    const comparison = await compareRetainedHeadlessCheckpointRoundTrip(checkpoint, {
      scrollbackLines: SCROLLBACK,
    });
    return { axes: comparison.axes, rehydrateAnsi: checkpoint.rehydrateAnsi };
  } finally {
    disposeHeadlessTerminal(state);
  }
}

async function attributeHash(body: string): Promise<string> {
  const state = createHeadlessTerminalState({
    cols: COLS,
    rows: ROWS,
    scrollbackLines: SCROLLBACK,
  });
  try {
    await writeHeadlessTerminal(state, body);
    return serializeRetainedHeadlessCheckpoint(state).normal.attributeHash;
  } finally {
    disposeHeadlessTerminal(state);
  }
}

// @req FR-BGSTAB-027 AC-1
test('FR-BGSTAB-027 AC-1 indexed SGR palette slots 0..15 survive the checkpoint round trip', async () => {
  const mismatched: number[] = [];
  for (let index = 0; index < 16; index += 1) {
    const fg = await roundTripAxes(`${ESC}[38;5;${index}mX${ESC}[0m`);
    const bg = await roundTripAxes(`${ESC}[48;5;${index}mX${ESC}[0m`);
    if (fg.axes.cells !== 'match' || bg.axes.cells !== 'match') mismatched.push(index);
  }

  assert.deepEqual(
    mismatched,
    [],
    'indexed palette slots 0..15 must not make the cells axis mismatch',
  );
});

// @req FR-BGSTAB-027 AC-1 AC-4
test('FR-BGSTAB-027 AC-4 an SGR-dense scrollback keeps every principal comparer axis matching', async () => {
  let body = '';
  for (let line = 0; line < 2_000; line += 1) {
    body += `${ESC}[3${line % 8}m${ESC}[1mline ${line}${ESC}[0m `
      + `${ESC}[38;5;${line % 256}mtoken${ESC}[0m `
      + `${ESC}[4mund${ESC}[24m\r\n`;
  }

  const { axes } = await roundTripAxes(body);

  assert.equal(axes.cells, 'match');
  assert.equal(axes.logicalLines, 'match');
  assert.equal(axes.unicodeWidth, 'match');
  assert.equal(axes.cursor, 'match');
  assert.equal(axes.modes, 'match');
  assert.equal(axes.activeBuffer, 'match');
});

// @req FR-BGSTAB-027 AC-2
test('FR-BGSTAB-027 AC-2 P16 short form and P256 indexed form of one palette slot hash alike', async () => {
  for (const [shortForm, index] of [[30, 0], [33, 3], [37, 7], [90, 8], [95, 13], [97, 15]] as const) {
    assert.equal(
      await attributeHash(`${ESC}[${shortForm}mX${ESC}[0m`),
      await attributeHash(`${ESC}[38;5;${index}mX${ESC}[0m`),
      `foreground SGR ${shortForm} must hash like indexed slot ${index}`,
    );
  }
  for (const [shortForm, index] of [[40, 0], [43, 3], [47, 7], [100, 8], [105, 13], [107, 15]] as const) {
    assert.equal(
      await attributeHash(`${ESC}[${shortForm}mX${ESC}[0m`),
      await attributeHash(`${ESC}[48;5;${index}mX${ESC}[0m`),
      `background SGR ${shortForm} must hash like indexed slot ${index}`,
    );
  }
});

// @req FR-BGSTAB-027 AC-3
test('FR-BGSTAB-027 AC-3 palette normalization still distinguishes genuinely different attributes', async () => {
  const plain = await attributeHash('X');
  const slot3 = await attributeHash(`${ESC}[38;5;3mX${ESC}[0m`);
  const slot4 = await attributeHash(`${ESC}[38;5;4mX${ESC}[0m`);
  const slot11 = await attributeHash(`${ESC}[38;5;11mX${ESC}[0m`);
  const slot3Bg = await attributeHash(`${ESC}[48;5;3mX${ESC}[0m`);
  // xterm's default palette entry 3 is #a50 / rgb(170,85,0); the truecolor form
  // is a distinct color mode even when the rendered color coincides.
  const trueColor = await attributeHash(`${ESC}[38;2;170;85;0mX${ESC}[0m`);
  const bold = await attributeHash(`${ESC}[1mX${ESC}[0m`);

  const distinct = new Set([plain, slot3, slot4, slot11, slot3Bg, trueColor, bold]);
  assert.equal(distinct.size, 7, 'distinct attributes must keep distinct attribute hashes');
});

// @req FR-BGSTAB-027 AC-3
test('BOUNDARY CONTROL — indexed slots at or above 16 were already round-trip stable', async () => {
  // Without this the AC-1 test would also pass if the normalization silently
  // collapsed every palette colour into one token.
  for (const index of [16, 42, 128, 255]) {
    const { axes, rehydrateAnsi } = await roundTripAxes(`${ESC}[38;5;${index}mX${ESC}[0m`);
    assert.equal(axes.cells, 'match');
    assert.ok(
      rehydrateAnsi.includes(`38;5;${index}`),
      `serializer keeps the indexed form for slot ${index}`,
    );
  }
});
