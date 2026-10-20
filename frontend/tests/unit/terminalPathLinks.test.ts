import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as TerminalPathLinksModule from '../../src/utils/terminalPathLinks.ts';
import type * as TerminalPathOpenModule from '../../src/utils/terminalPathOpen.ts';

// FR-ARCH-012 AC-5~AC-7 / FR-ARCH-013 AC-1·AC-3 — the xterm side: links for one
// buffer line (Ctrl/Cmd+click opens, the modifier shows the underline) and the
// paths around a pressed point. A fake terminal stands in for xterm.
const MODULE_PATH = '../../src/utils/terminalPathLinks.ts';
const OPEN_PATH = '../../src/utils/terminalPathOpen.ts';
type M = typeof TerminalPathLinksModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

interface FakeLineSpec { text: string; wrapped?: boolean }

function fakeTerminal(lines: FakeLineSpec[], options: { cols: number; rows: number; viewportY: number }) {
  const bufferLines = lines.map(({ text, wrapped }) => ({
    isWrapped: wrapped === true,
    length: options.cols,
    getCell: (x: number) => {
      const ch = [...text][x];
      return { getChars: () => ch ?? '', getWidth: () => 1 };
    },
  }));
  let provider: { provideLinks: (y: number, cb: (links: unknown[] | undefined) => void) => void } | null = null;
  return {
    cols: options.cols,
    rows: options.rows,
    buffer: { active: { viewportY: options.viewportY, length: lines.length, getLine: (y: number) => bufferLines[y] } },
    element: {
      querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: options.cols * 10, height: options.rows * 20 }) }),
    },
    registerLinkProvider(next: typeof provider) {
      provider = next;
      return { dispose: () => { provider = null; } };
    },
    linksAt(y: number): Promise<Array<{
      text: string;
      range: { start: { x: number; y: number }; end: { x: number; y: number } };
      decorations?: { underline: boolean; pointerCursor: boolean };
      activate: (event: { ctrlKey: boolean; metaKey: boolean }, text: string) => void;
      hover?: (event: { ctrlKey: boolean; metaKey: boolean }, text: string) => void;
      leave?: (event: unknown, text: string) => void;
    }>> {
      return new Promise((resolve) => provider?.provideLinks(y, (links) => resolve((links ?? []) as never)));
    },
  };
}

async function captureOpens(): Promise<{ opened: string[]; stop: () => void }> {
  const { subscribeTerminalPathOpen } = await import(OPEN_PATH) as typeof TerminalPathOpenModule;
  const opened: string[] = [];
  const stop = subscribeTerminalPathOpen((sessionId, target) => opened.push(`${sessionId}:${target.path}`));
  return { opened, stop };
}

test('FR-ARCH-012 AC-6: Ctrl or Cmd+click on a path link opens it; a plain click does not', async () => {
  const { registerTerminalPathLinks } = await load();
  const term = fakeTerminal([{ text: 'made docs/a.html ok' }], { cols: 40, rows: 5, viewportY: 0 });
  registerTerminalPathLinks(term as never, 's1');
  const [link] = await term.linksAt(1);
  assert.equal(link.text, 'docs/a.html');
  assert.deepEqual(link.range, { start: { x: 6, y: 1 }, end: { x: 16, y: 1 } });
  const { opened, stop } = await captureOpens();
  try {
    link.activate({ ctrlKey: false, metaKey: false }, link.text);
    assert.deepEqual(opened, []);
    link.activate({ ctrlKey: true, metaKey: false }, link.text);
    link.activate({ ctrlKey: false, metaKey: true }, link.text);
    assert.deepEqual(opened, ['s1:docs/a.html', 's1:docs/a.html']);
  } finally {
    stop();
  }
});

test('FR-ARCH-012 AC-7: the underline shows only while Ctrl or Cmd is held over the link', async () => {
  const { registerTerminalPathLinks } = await load();
  const term = fakeTerminal([{ text: 'a.md' }], { cols: 40, rows: 5, viewportY: 0 });
  registerTerminalPathLinks(term as never, 's1');
  const [link] = await term.linksAt(1);
  // What xterm 6's Linkifier does on hover (src/browser/Linkifier.ts): it copies
  // link.decorations into its own state, calls link.hover, and only then swaps
  // link.decorations for an object whose setters drive the screen. A change made
  // to the original object, or made during hover, never reaches the screen.
  const shown = { ...(link.decorations ?? { underline: true, pointerCursor: true }) };
  assert.deepEqual(shown, { underline: false, pointerCursor: false });
  const hover = (ctrlKey: boolean) => {
    link.hover?.({ ctrlKey, metaKey: false }, link.text);
    const tracked = {} as { underline: boolean; pointerCursor: boolean };
    Object.defineProperties(tracked, {
      underline: { get: () => shown.underline, set: (v: boolean) => { shown.underline = v; } },
      pointerCursor: { get: () => shown.pointerCursor, set: (v: boolean) => { shown.pointerCursor = v; } },
    });
    link.decorations = tracked;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Node has no window; key events go to a stand-in the module listens on.
  const keys = new EventTarget();
  const saved = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = keys;
  const press = (type: string, ctrlKey: boolean) => keys.dispatchEvent(Object.assign(new Event(type), { ctrlKey, metaKey: false }));
  try {

  hover(true);
  await settle();
  assert.deepEqual(shown, { underline: true, pointerCursor: true }, 'Ctrl held on entering the link');

  press('keyup', false);
  assert.deepEqual(shown, { underline: false, pointerCursor: false }, 'Ctrl released over the link');
  press('keydown', true);
  assert.deepEqual(shown, { underline: true, pointerCursor: true }, 'Ctrl pressed again over the link');

  link.leave?.({}, link.text);
  assert.deepEqual(shown, { underline: false, pointerCursor: false });
  press('keydown', true);
  assert.deepEqual(shown, { underline: false, pointerCursor: false }, 'after leaving, keys no longer move the underline');
  } finally {
    (globalThis as { window?: unknown }).window = saved;
  }
});

test('FR-ARCH-012 AC-5: a wrapped path is one link on both of its rows', async () => {
  const { registerTerminalPathLinks } = await load();
  const term = fakeTerminal([{ text: 'see docs/d' }, { text: 'esign.html', wrapped: true }], { cols: 10, rows: 5, viewportY: 0 });
  registerTerminalPathLinks(term as never, 's1');
  for (const y of [1, 2]) {
    const [link] = await term.linksAt(y);
    assert.equal(link.text, 'docs/design.html');
    assert.deepEqual(link.range, { start: { x: 5, y: 1 }, end: { x: 10, y: 2 } });
  }
});

test('FR-ARCH-013 AC-1·AC-3: the path near a pressed point and the paths on the visible screen', async () => {
  const { readTerminalPathsAt } = await load();
  // Rows 0-1 are scrollback; the screen shows rows 2-4 (viewportY 2, 3 rows).
  const term = fakeTerminal(
    [{ text: 'old.md' }, { text: 'older.md' }, { text: 'a.md      b.md' }, { text: '' }, { text: 'c.md' }],
    { cols: 20, rows: 3, viewportY: 2 },
  );
  // Screen row 0, column 11 (x = 115 px, y = 10 px with 10 x 20 px cells) is on b.md.
  const result = readTerminalPathsAt(term as never, 115, 10);
  assert.equal(result.near?.path, 'b.md');
  assert.deepEqual(result.screen.map(target => target.path), ['c.md', 'b.md', 'a.md']);
  // Screen row 1 is empty: the rows around it hold a.md above and c.md below,
  // both at the pressed column; a tie goes to the row above.
  assert.equal(readTerminalPathsAt(term as never, 15, 30).near?.path, 'a.md');
  // Further right, b.md in the row above is nearest.
  assert.equal(readTerminalPathsAt(term as never, 125, 30).near?.path, 'b.md');
  // Outside the screen there is no near path, but the screen list stays.
  const outside = readTerminalPathsAt(term as never, 500, 500);
  assert.equal(outside.near, null);
  assert.deepEqual(outside.screen.map(target => target.path), ['c.md', 'b.md', 'a.md']);
});

test('FR-ARCH-012: a terminal without registerLinkProvider (a partial stand-in) is left alone', async () => {
  const { registerTerminalPathLinks } = await load();
  const bare = { cols: 10, rows: 2, buffer: { active: { viewportY: 0, length: 0, getLine: () => undefined } } };
  const disposable = registerTerminalPathLinks(bare as never, 's1');
  assert.doesNotThrow(() => disposable.dispose());
});

test('FR-ARCH-012 AC-5: a path cut into indented full rows is one link on each of its rows', async () => {
  const { registerTerminalPathLinks } = await load();
  // 11 columns: the first row is full, the second starts with the indent.
  const cut = fakeTerminal(
    [{ text: '  aa/bb/ccc' }, { text: '  dd/e.md' }],
    { cols: 11, rows: 5, viewportY: 0 },
  );
  registerTerminalPathLinks(cut as never, 's1');
  for (const y of [1, 2]) {
    const [link] = await cut.linksAt(y);
    assert.equal(link?.text, 'aa/bb/cccdd/e.md');
    assert.deepEqual(link.range, { start: { x: 3, y: 1 }, end: { x: 9, y: 2 } });
  }
});
