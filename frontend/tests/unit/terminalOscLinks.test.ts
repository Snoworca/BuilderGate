// REL-BGSTAB-052 AC-1, AC-2: the browser terminal does not keep a record per OSC 8 link.
// xterm keeps a marker, its listeners and a link entry for every OSC 8 link without an id;
// reset() keeps them too, and through their markers the whole previous buffer (~20 MB for a
// full 10,000-line scrollback). Measured with @xterm/headless, whose link service is the same
// code as the browser build.
import test from 'node:test';
import assert from 'node:assert/strict';
import headless from '@xterm/headless';
import { createTerminalRawMutationAdapter } from '../../src/utils/terminalRawMutationAdapter.ts';
import { assignOscLinkIds } from '../../src/utils/terminalOscLinks.ts';

const { Terminal } = headless as unknown as { Terminal: new (o: object) => HeadlessTerminal };
interface HeadlessTerminal {
  write(data: string | Uint8Array, cb?: () => void): void;
  reset(): void;
  clear(): void;
  resize(c: number, r: number): void;
  cols: number; rows: number; options: Record<string, unknown>;
  _core: { _oscLinkService: { _dataByLinkId: Map<number, { data: { id?: string; uri: string } }> }; buffer: { markers: unknown[] } };
}

function setup() {
  const terminal = new Terminal({ cols: 80, rows: 6, scrollback: 200, allowProposedApi: true });
  const noop = () => {};
  const adapter = createTerminalRawMutationAdapter({
    terminal: terminal as never, fitAddon: { fit: noop } as never,
    markReady: noop, releaseInput: noop, settleInput: noop as never, requestFreshRecovery: noop,
    requestRuntimeRecreation: noop as never, compatibilityRecoveryDrained: noop as never, settle: noop, checkpointApplied: noop as never,
  } as never);
  const write = (data: string | Uint8Array) => new Promise<void>((done) => adapter.write({ kind: 'live', data }, done));
  return { terminal, adapter, write, links: () => terminal._core._oscLinkService._dataByLinkId };
}
const link = (url: string, text: string, end = '\x07') => `\x1b]8;;${url}${end}${text}\x1b]8;;${end}`;

test('REL-BGSTAB-052 AC-1: reset releases every link record', async () => {
  const { adapter, write, links, terminal } = setup();
  await write(`${'line\r\n'.repeat(50)}${link('https://example.com/r', 'r')}${link('https://example.com/s', 's')}`);
  assert.ok(links().size > 0, 'the fixture registered links');
  adapter.resetParser();
  assert.equal(links().size, 0, `link entries after reset: ${links().size}`);
  void terminal;
});

test('REL-BGSTAB-052 AC-1: a reset sent by the shell (RIS, ESC c) releases them too', async () => {
  const { write, links } = setup();
  await write(`${link('https://example.com/r', 'r')}${link('https://example.com/s', 's')}`);
  assert.ok(links().size > 0);
  await write('\x1bc');
  assert.equal(links().size, 0, `link entries after RIS: ${links().size}`);
});

test('REL-BGSTAB-052 AC-2: redrawing the same link in place keeps one record and the URI', async () => {
  const { write, links } = setup();
  const frame = `\x1b[H\x1b[2K${link('https://example.com/a', 'a')} ${link('file:///C:/r/b.ts', 'b.ts', '\x1b\\')}`;
  for (let i = 0; i < 500; i += 1) await write(frame);
  assert.ok(links().size <= 2, `link entries after 500 redraws: ${links().size}`);
  const uris = [...links().values()].map((e) => e.data.uri).sort();
  assert.deepEqual(uris, ['file:///C:/r/b.ts', 'https://example.com/a']);
});

test('REL-BGSTAB-052 AC-2: bytes, existing ids, other OSC and text without links are left as they are', () => {
  const plain = 'hello \x1b]0;title\x07 world';
  assert.equal(assignOscLinkIds(plain), plain);
  const withId = '\x1b]8;id=mine;https://x\x07t\x1b]8;;\x07';
  assert.equal(assignOscLinkIds(withId), withId, 'an existing id is kept; the closing sequence has no URI');
  const out = assignOscLinkIds('\x1b]8;;https://x\x07t\x1b]8;;\x07') as string;
  assert.match(out, /^\x1b\]8;id=bg[0-9a-z]+;https:\/\/x\x07t\x1b\]8;;\x07$/);
  assert.equal(assignOscLinkIds('\x1b]8;;https://x\x07'), assignOscLinkIds('\x1b]8;;https://x\x07'), 'same URI, same id');
  const bytes = new TextEncoder().encode('a\x1b]8;;https://y\x07b');
  const rewritten = assignOscLinkIds(bytes);
  assert.ok(rewritten instanceof Uint8Array);
  assert.match(new TextDecoder().decode(rewritten as Uint8Array), /^a\x1b\]8;id=bg[0-9a-z]+;https:\/\/y\x07b$/);
  const withParams = assignOscLinkIds('\x1b]8;foo=bar;https://p\x07t\x1b]8;;\x07') as string;
  assert.match(withParams, /^\x1b\]8;foo=bar:id=bg[0-9a-z]+;https:\/\/p\x07/, 'other params keep, an id is added');
  const keepId = '\x1b]8;foo=1:id=x;https://p\x07';
  assert.equal(assignOscLinkIds(keepId), keepId);
  // Byte input that is not whole UTF-8 (a chunk split inside a character) and starts with a BOM.
  const split = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('\x1b]8;;https://z\x07'), 0xe2, 0x82]);
  const out2 = assignOscLinkIds(split) as Uint8Array;
  assert.deepEqual([...out2.slice(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM bytes are kept');
  assert.deepEqual([...out2.slice(-2)], [0xe2, 0x82], 'the split character bytes are kept');
  assert.match(String.fromCharCode(...out2), /\x1b\]8;id=bg[0-9a-z]+;https:\/\/z\x07/);
  assert.equal(
    (assignOscLinkIds('\x1b]8;;https://ü\x07') as string).match(/id=(bg\w+)/)![1],
    new TextDecoder().decode(assignOscLinkIds(new TextEncoder().encode('\x1b]8;;https://ü\x07')) as Uint8Array).match(/id=(bg\w+)/)![1],
    'the same id whether the link came as text or bytes',
  );
  const noLinkBytes = new TextEncoder().encode('no links here');
  assert.equal(assignOscLinkIds(noLinkBytes), noLinkBytes, 'the same array when there is nothing to change');
});

test('REL-BGSTAB-052 AC-2: other terminators, a missing params separator and an empty id', () => {
  // A link closed with C1 ST (0x9c), alone or UTF-8 encoded, stays a plain close: an id on a
  // close would make xterm keep the link open over the text that follows.
  const c1 = '\x1b]8;;https://a\x9cA\x1b]8;;\x9c tail \x07';
  assert.match(assignOscLinkIds(c1) as string, /^\x1b\]8;id=bg[0-9a-z]+;https:\/\/a\x9cA\x1b\]8;;\x9c tail \x07$/);
  const c1Bytes = new Uint8Array([...new TextEncoder().encode('\x1b]8;;https://a'), 0xc2, 0x9c, 0x41, ...new TextEncoder().encode('\x1b]8;;'), 0xc2, 0x9c, 0x20, 0x07]);
  const outBytes = String.fromCharCode(...(assignOscLinkIds(c1Bytes) as Uint8Array));
  assert.match(outBytes, /\x1b\]8;;\xc2\x9c \x07$/, 'the close keeps no id');
  // CAN/SUB abort the sequence: leave it alone.
  const aborted = '\x1b]8;;https://a\x18 text\x07';
  assert.equal(assignOscLinkIds(aborted), aborted);
  // A malformed sequence whose params never meet a ';' must not touch the text after it.
  const broken = '\x1b]8;\x07 a;b c\x07';
  assert.equal(assignOscLinkIds(broken), broken);
  // An empty id is no id to xterm: it gets one.
  assert.match(assignOscLinkIds('\x1b]8;id=;https://e\x07') as string, /^\x1b\]8;id=bg[0-9a-z]+;https:\/\/e\x07$/);
});

test('REL-BGSTAB-052 AC-2: a C1 control that cuts the sequence short leaves it untouched; ESC ends it like xterm', () => {
  for (const raw of ['\x1b]8;a\x85b;http://u\x07Z', '\x1b]8;a\x9bb;http://u\x07Z']) {
    assert.equal(assignOscLinkIds(raw), raw, JSON.stringify(raw));
    const bytes = new Uint8Array([...raw].flatMap((ch) => [...new TextEncoder().encode(ch)]));
    assert.equal(assignOscLinkIds(bytes), bytes, `bytes ${JSON.stringify(raw)}`);
  }
  // U+009D aborts the first OSC and starts a new one: only that second, real link gets an id.
  assert.match(assignOscLinkIds('\x1b]8;\x9d8;;http://u\x07Z') as string, /^\x1b\]8;\x9d8;id=bg[0-9a-z]+;http:\/\/u\x07Z$/);
  // A continuation byte in the 0x80-0x9f range inside a UTF-8 URI is not a C1 control.
  const quote = new TextEncoder().encode('\x1b]8;;https://q/\u201c\x07q');
  assert.notEqual(assignOscLinkIds(quote), quote, 'a URI with \u201c (E2 80 9C) still gets an id');
  // ESC followed by anything ends the OSC in xterm, so such a link gets its id too.
  assert.match(assignOscLinkIds('\x1b]8;;https://e\x1b[1mX') as string, /^\x1b\]8;id=bg[0-9a-z]+;https:\/\/e\x1b\[1mX$/);
});

test('REL-BGSTAB-052 AC-2: a close whose URI xterm reads as empty stays a close; params are read as xterm reads them', () => {
  // xterm drops C0 controls and a BOM inside an OSC, and invalid UTF-8 from bytes: such a URI
  // is empty to it, so the sequence closes the link. An id would keep the link open.
  for (const close of ['\x1b]8;;\x01\x07', '\x1b]8;;\x00\x1f\x07', '\x1b]8;;\ufeff\x07']) {
    assert.equal(assignOscLinkIds(close), close, JSON.stringify(close));
  }
  for (const tail of [[0xc2], [0x80], [0xef, 0xbb, 0xbf]]) {
    const bytes = new Uint8Array([0x1b, 0x5d, 0x38, 0x3b, 0x3b, ...tail, 0x07]);
    assert.equal(assignOscLinkIds(bytes), bytes, JSON.stringify(tail));
  }
  // The first id= entry is the one xterm uses: an empty first one is filled, a set one is kept.
  assert.match(assignOscLinkIds('\x1b]8;id=:id=x;https://p\x07') as string, /^\x1b\]8;id=bg[0-9a-z]+:id=x;https:\/\/p\x07$/);
  assert.match(assignOscLinkIds('\x1b]8; id=;https://p\x07') as string, /^\x1b\]8;id=bg[0-9a-z]+;https:\/\/p\x07$/);
  assert.match(assignOscLinkIds('\x1b]8;id=\x01;https://p\x07') as string, /^\x1b\]8;id=bg[0-9a-z]+;https:\/\/p\x07$/);
  const kept = '\x1b]8;x=1:id=mine;https://p\x07';
  assert.equal(assignOscLinkIds(kept), kept);
});

test('REL-BGSTAB-052 AC-2: an explicit id made of spaces is an id to xterm and is kept', () => {
  // xterm trims the params as a whole, then takes the first id= as it is: spaces inside count.
  for (const raw of ['\x1b]8;id= :x;http://u\x07', '\x1b]8;id=  :x;http://u\x07', '\x1b]8;id= :x;http://u\x07']) {
    assert.equal(assignOscLinkIds(raw), raw, JSON.stringify(raw));
  }
  // ...while trailing spaces of the whole params are trimmed away, leaving an empty id to fill.
  assert.match(assignOscLinkIds('\x1b]8;id=  ;http://u\x07') as string, /^\x1b\]8;id=bg[0-9a-z]+;http:\/\/u\x07$/);
});

test('REL-BGSTAB-052 AC-2: an OSC started with the C1 introducer (U+009D) gets its id too', async () => {
  assert.match(assignOscLinkIds('\u009d8;;https://c1\x07c') as string, /^\u009d8;id=bg[0-9a-z]+;https:\/\/c1\x07c$/);
  const bytes = new Uint8Array([0xc2, 0x9d, ...new TextEncoder().encode('8;;https://c1\x07c')]);
  assert.match(String.fromCharCode(...(assignOscLinkIds(bytes) as Uint8Array)), /^\xc2\x9d8;id=bg[0-9a-z]+;https:\/\/c1\x07c$/);
  // ...and redrawn in place it keeps one record, like the ESC ] form.
  const { write, links } = setup();
  for (let i = 0; i < 200; i += 1) await write('\x1b[H\u009d8;;https://c1\x07c\u009d8;;\x07');
  assert.ok(links().size <= 1, `link entries: ${links().size}`);
});
