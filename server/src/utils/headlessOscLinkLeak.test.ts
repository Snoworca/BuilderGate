// REL-BGSTAB-051: the server headless terminal must not keep a record per OSC 8 hyperlink.
// @xterm/headless 6.0.0 registers a marker, its listeners and a link entry (~3 KB) for every
// OSC 8 link without an id, and frees them only when the line is trimmed out of scrollback.
// A TUI that redraws in place (or clears, or resets) never trims, so they pile up: the 2002
// daemon grew ~106 MB/h this way until the V8 heap limit (2026-10-23).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  readHeadlessTerminalText,
  writeHeadlessTerminal,
  type HeadlessTerminalState,
} from './headlessTerminal.js';

/** What xterm holds for OSC 8 links, read from its internals (no public API exposes it). */
function linkRecords(state: HeadlessTerminalState): { entries: number; markers: number } {
  const core = (state.terminal as unknown as { _core: { _oscLinkService: { _dataByLinkId: Map<number, unknown> }; buffer: { markers: unknown[] } } })._core;
  return { entries: core._oscLinkService._dataByLinkId.size, markers: core.buffer.markers.length };
}

const link = (url: string, text: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

test('REL-BGSTAB-051 AC-1: redrawing a hyperlink in place leaves no link records', async () => {
  const state = createHeadlessTerminalState({ cols: 80, rows: 6, scrollbackLines: 100 });
  try {
    const frame = `\x1b[H\x1b[2Kstatus ${link('https://example.com/a', 'example')} done\r\n\x1b[2K${link('file:///C:/repo/src/a.ts', 'src/a.ts')}`;
    for (let i = 0; i < 2_000; i += 1) await writeHeadlessTerminal(state, frame);
    const records = linkRecords(state);
    assert.equal(records.entries, 0, `link entries after 2,000 redraws: ${records.entries}`);
    assert.ok(records.markers < 10, `markers after 2,000 redraws: ${records.markers}`);
    // The text and the cursor are what they would be without the links.
    const text = readHeadlessTerminalText(state, 6);
    assert.match(text, /status example done/);
    assert.match(text, /src\/a\.ts/);
    const buffer = state.terminal.buffer.active;
    assert.deepEqual([buffer.cursorY, buffer.cursorX], [1, 'src/a.ts'.length]);
  } finally {
    disposeHeadlessTerminal(state);
  }
});

test('REL-BGSTAB-051 AC-1: clear and reset with links on screen keep nothing; a link split across writes is still ignored', async () => {
  const state = createHeadlessTerminalState({ cols: 80, rows: 6, scrollbackLines: 100 });
  try {
    for (let i = 0; i < 200; i += 1) {
      await writeHeadlessTerminal(state, `${link('https://example.com/x', 'x')}\x1b[2J\x1b[H`);
      await writeHeadlessTerminal(state, `${link('https://example.com/y', 'y')}\x1bc`);
    }
    const whole = `before ${link('https://example.com/split', 'split')} after`;
    for (let i = 0; i < whole.length; i += 3) await writeHeadlessTerminal(state, whole.slice(i, i + 3));
    assert.equal(linkRecords(state).entries, 0);
    assert.match(readHeadlessTerminalText(state, 6), /before split after/);
  } finally {
    disposeHeadlessTerminal(state);
  }
});
