import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

/**
 * Issue #16, item 5 — the reset/reflow half.
 *
 * Item 5 asks for regressions over the five situations in which a selection
 * anchor can break: reset/reflow, user-scroll during output, WebGL context loss,
 * DOM fallback, and hide/reveal. The last three need a real GPU and a real
 * layout and live in tests/e2e/terminal-selection-renderer-lifecycle.spec.ts.
 * This file owns the two that a headless jsdom terminal can actually answer, and
 * it answers them about XTERM ITSELF rather than about BuilderGate's wrapper:
 * every reading below comes from a real `@xterm/xterm` Terminal opened into a
 * jsdom host, with no BuilderGate code in the path.
 *
 * That scoping is deliberate. A selection anchor model has to be designed
 * against what the terminal underneath it actually does, and three of the
 * measurements here contradict what a reasonable person would assume.
 *
 * MEASURED 2026-09-19 against @xterm/xterm 6.0.0. Selection requires `open()`:
 * on an unopened Terminal, `select()` throws inside the SelectionService, so
 * selection is a property of a RENDERED terminal and cannot be characterized
 * without one.
 *
 * ── The three findings, stated plainly ──────────────────────────────────────
 *
 * 1. A COLUMN RESIZE THAT REFLOWS SILENTLY REPOINTS THE SELECTION.
 *    `reflow-wider-20-to-40` selects the line `TARGETTARGETTARGET`, widens the
 *    terminal, and the selection — still reporting hasSelection() true and the
 *    same start/end coordinates — now reads `CCCCCCCCCCCCCCCCCC`, a different
 *    line entirely. Unwrapping the row above it shifted every row below up by
 *    one, and the selection is pinned to an absolute row number. This IS issue
 *    #16's symptom 2, reproduced without a browser: copy at that moment writes
 *    the wrong line to the clipboard.
 *
 * 2. `onSelectionChange` DOES NOT FIRE for any of the unsafe transitions.
 *    Reflow, CSI 2J and `clear()` all leave the subscriber silent
 *    (selectionChangeEvents 0), while the transitions that DO clear the
 *    selection — RIS, reset(), alternate-screen switch, row resize — fire it.
 *    So the browser cannot learn about a repointed selection by subscribing.
 *    Validation has to happen at the resize/erase boundary or at copy time.
 *
 * 3. `hasSelection()` CAN BE TRUE WHILE `getSelection()` IS EMPTY.
 *    After CSI 2J or `clear()` the selection still exists and still has
 *    coordinates, but the cells under it were blanked. FR-BGSTAB-029 AC-4's rule
 *    — read xterm's selection state, never the DOM's — is necessary but not
 *    sufficient: a copy path gated on hasSelection() alone writes an empty
 *    string here.
 *
 * ── What these tests assert, and what that means ────────────────────────────
 *
 * The rows below are CHARACTERIZATIONS. Four of them record behaviour that is
 * wrong from the user's point of view, and they are recorded rather than
 * asserted-as-correct because the fix belongs to the selection anchor model
 * being built in TerminalView.tsx / terminalSelectionAnchor.ts, not here. When
 * that model lands, the four entries marked `unsafe` below are expected to
 * change, and `UNSAFE_TRANSITIONS` is the list to update — deliberately as a
 * separate assertion, so that shrinking it is a visible, intentional edit rather
 * than a silently adjusted literal.
 */

installJsdomEnvironment();

const require = createRequire(import.meta.url);

const COLS = 20;
const ROWS = 8;
const SCROLLBACK = 100;

/**
 * 30 characters, so it occupies two rows at 20 columns and one at 40. Unwrapping
 * it is what moves every row beneath it, which is the mechanism behind finding 1.
 */
const WRAPPING_LINE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
/** 18 characters: never wraps at 19, 20 or 40, so any change to it is a repoint, not a rewrap. */
const TARGET_LINE = 'TARGETTARGETTARGET';
const TRAILING_LINE = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

interface SelectionCapableTerminal {
  readonly cols: number;
  readonly rows: number;
  open(host: HTMLElement): void;
  write(data: string, callback?: () => void): void;
  resize(cols: number, rows: number): void;
  reset(): void;
  clear(): void;
  select(column: number, row: number, length: number): void;
  hasSelection(): boolean;
  getSelection(): string;
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  onSelectionChange(handler: () => void): { dispose(): void };
  dispose(): void;
  readonly buffer: {
    readonly active: {
      readonly length: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

type SelectionTerminalConstructor = new (options: Record<string, unknown>) => SelectionCapableTerminal;

// The installed build is UMD, so Terminal may be on the namespace or its default
// export; read through `unknown` so narrowing does not hide the interop shape.
// Same idiom as tests/unit/terminalOutputScheduler.test.ts.
const xtermNamespace = require('@xterm/xterm') as unknown as {
  Terminal?: SelectionTerminalConstructor;
  default?: { Terminal?: SelectionTerminalConstructor };
};
const Terminal = xtermNamespace.Terminal ?? xtermNamespace.default?.Terminal;
assert.ok(Terminal, '@xterm/xterm must expose Terminal directly or on its default export');

function createHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

function writeAsync(terminal: SelectionCapableTerminal, data: string): Promise<void> {
  return new Promise(resolve => { terminal.write(data, () => resolve()); });
}

/**
 * Seeds the same three lines for every scenario and selects TARGET_LINE by
 * FINDING it rather than by a hardcoded row, so the setup cannot quietly select
 * the wrong line if the seeding changes.
 */
async function seedAndSelectTarget(terminal: SelectionCapableTerminal): Promise<void> {
  await writeAsync(terminal, `${WRAPPING_LINE}\r\n${TARGET_LINE}\r\n${TRAILING_LINE}\r\n`);
  let row = -1;
  for (let y = 0; y < terminal.buffer.active.length; y += 1) {
    if ((terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').startsWith('TARGET')) {
      row = y;
      break;
    }
  }
  assert.notEqual(row, -1, 'the seeded TARGET line must be locatable before selecting it');
  terminal.select(0, row, TARGET_LINE.length);
  assert.equal(
    terminal.getSelection(),
    TARGET_LINE,
    'the precondition of every row below is that the selection starts out holding TARGET_LINE',
  );
}

type SelectionSafety =
  /** The selection still holds exactly what the user selected. */
  | 'preserved'
  /** The selection is gone, and the copy path can see that it is gone. */
  | 'cleared'
  /** hasSelection() is still true but the selection no longer holds what was selected. */
  | 'unsafe';

interface SelectionLifecycleGolden {
  readonly name: string;
  readonly act: (terminal: SelectionCapableTerminal) => Promise<void>;
  readonly safety: SelectionSafety;
  readonly hasSelection: boolean;
  readonly text: string;
  readonly selectionChangeEvents: number;
  readonly note: string;
}

const LIFECYCLE_CORPUS: readonly SelectionLifecycleGolden[] = [
  {
    name: 'control-no-op',
    act: async () => {},
    safety: 'preserved',
    hasSelection: true,
    text: TARGET_LINE,
    selectionChangeEvents: 0,
    note: 'Boundary control. Without this, every "preserved" row below could be a test that never '
      + 'disturbed anything.',
  },
  {
    name: 'append-one-output-line',
    act: async terminal => { await writeAsync(terminal, 'NEWOUTPUT\r\n'); },
    safety: 'preserved',
    hasSelection: true,
    text: TARGET_LINE,
    selectionChangeEvents: 0,
    note: 'Output arriving under a live selection is SAFE, which contradicts the assumption this '
      + 'lane started from. The selection tracks its line as the buffer grows.',
  },
  {
    name: 'ris-full-reset',
    act: async terminal => { await writeAsync(terminal, 'c'); },
    safety: 'cleared',
    hasSelection: false,
    text: '',
    selectionChangeEvents: 2,
    note: 'RIS clears the selection AND notifies. This is the shape the unsafe rows should have.',
  },
  {
    name: 'api-reset',
    act: async terminal => { terminal.reset(); },
    safety: 'cleared',
    hasSelection: false,
    text: '',
    selectionChangeEvents: 2,
    note: 'Terminal.reset() behaves as RIS does.',
  },
  {
    name: 'erase-display-2j',
    act: async terminal => { await writeAsync(terminal, '[2J'); },
    safety: 'unsafe',
    hasSelection: true,
    text: '',
    selectionChangeEvents: 0,
    note: 'FINDING 3. The cells under the selection are blanked but the selection is not. A copy '
      + 'gated on hasSelection() alone writes an empty string and reports success.',
  },
  {
    name: 'erase-scrollback-3j',
    act: async terminal => { await writeAsync(terminal, '[3J'); },
    safety: 'preserved',
    hasSelection: true,
    text: TARGET_LINE,
    selectionChangeEvents: 0,
    note: 'Boundary control for 2J: 3J erases scrollback, and the selected line is in the '
      + 'viewport, so nothing should change. It does not.',
  },
  {
    name: 'api-clear',
    act: async terminal => { terminal.clear(); },
    safety: 'unsafe',
    hasSelection: true,
    text: '',
    selectionChangeEvents: 0,
    note: 'FINDING 3 again, through the public API rather than an escape sequence.',
  },
  {
    name: 'alternate-screen-enter',
    act: async terminal => { await writeAsync(terminal, '[?1049h'); },
    safety: 'cleared',
    hasSelection: false,
    text: '',
    selectionChangeEvents: 1,
    note: 'Switching to the alternate screen clears and notifies.',
  },
  {
    name: 'alternate-screen-enter-and-exit',
    act: async terminal => {
      await writeAsync(terminal, '[?1049h');
      await writeAsync(terminal, '[?1049l');
    },
    safety: 'cleared',
    hasSelection: false,
    text: '',
    selectionChangeEvents: 2,
    note: 'Returning from the alternate screen does NOT restore the selection, and should not.',
  },
  {
    name: 'reflow-wider-20-to-40',
    act: async terminal => { terminal.resize(40, ROWS); },
    safety: 'unsafe',
    hasSelection: true,
    text: 'CCCCCCCCCCCCCCCCCC',
    selectionChangeEvents: 0,
    note: 'FINDING 1, in its clearest form. Widening unwraps the line above TARGET, every row '
      + 'below shifts up by one, and the selection — same coordinates, still "valid" — now holds '
      + 'the FIRST 18 CHARACTERS OF A DIFFERENT LINE. Copy writes the wrong text.',
  },
  {
    name: 'reflow-narrower-20-to-10',
    act: async terminal => { terminal.resize(10, ROWS); },
    safety: 'unsafe',
    hasSelection: true,
    text: 'AAAAAAAAAA\nTARGETTA',
    selectionChangeEvents: 0,
    note: 'FINDING 1 in the other direction: narrowing pushes rows down, and the selection now '
      + 'straddles the tail of the wrapping line and the head of TARGET.',
  },
  {
    name: 'cols-change-without-reflow-20-to-19',
    act: async terminal => { terminal.resize(19, ROWS); },
    safety: 'preserved',
    hasSelection: true,
    text: TARGET_LINE,
    selectionChangeEvents: 0,
    note: 'Boundary control for the two above, and the one that makes them a REFLOW finding rather '
      + 'than a RESIZE finding: 20->19 changes the width without changing how anything wraps, and '
      + 'the selection is untouched. If a fix made every column resize clear the selection, this '
      + 'row would catch the overreach.',
  },
  {
    name: 'rows-shrink-8-to-3',
    act: async terminal => { terminal.resize(COLS, 3); },
    safety: 'cleared',
    hasSelection: false,
    text: '',
    selectionChangeEvents: 1,
    note: 'THE ASYMMETRY. A row resize clears the selection and notifies; a column resize does '
      + 'neither, even though the column resize is the one that moves content.',
  },
  {
    name: 'rows-grow-8-to-12',
    act: async terminal => { terminal.resize(COLS, 12); },
    safety: 'cleared',
    hasSelection: false,
    text: '',
    selectionChangeEvents: 1,
    note: 'Growing rows clears it too, so the row behaviour is about the resize, not about losing '
      + 'rows.',
  },
];

/**
 * The transitions after which a copy would deliver something other than what the
 * user selected. Declared separately from the corpus so that a fix has to remove
 * an entry here on purpose rather than by editing a literal in place.
 */
const UNSAFE_TRANSITIONS: readonly string[] = [
  'erase-display-2j',
  'api-clear',
  'reflow-wider-20-to-40',
  'reflow-narrower-20-to-10',
];

test('#16 item 5 — the lifecycle corpus covers reset, erase, buffer switch and reflow', () => {
  const names = LIFECYCLE_CORPUS.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length, 'corpus entry names must be unique');
  for (const required of ['reset', 'erase', 'alternate-screen', 'reflow', 'cols-change', 'rows-']) {
    assert.ok(
      names.some(name => name.includes(required)),
      `the corpus lost its '${required}' scenarios; item 5's reset/reflow half requires them`,
    );
  }
  // Non-vacuity floor, and a floor on the controls specifically: a corpus of
  // nothing but failures cannot tell a real finding from a broken harness.
  assert.ok(LIFECYCLE_CORPUS.length >= 14, `expected at least 14 scenarios, found ${LIFECYCLE_CORPUS.length}`);
  assert.ok(
    LIFECYCLE_CORPUS.filter(entry => entry.safety === 'preserved').length >= 3,
    'at least three scenarios must be controls in which the selection is preserved',
  );
});

test('#16 item 5 — selection requires a rendered terminal, so this characterization needs open()', async () => {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
  try {
    await writeAsync(terminal, `${TARGET_LINE}\r\n`);
    assert.throws(
      () => terminal.select(0, 0, TARGET_LINE.length),
      'select() on an unopened Terminal must throw. If it stops throwing, selection has become '
        + 'readable without a renderer and this whole file could be simplified — which is worth '
        + 'noticing rather than discovering by accident.',
    );
    assert.equal(terminal.hasSelection(), false);
  } finally {
    terminal.dispose();
  }
});

for (const entry of LIFECYCLE_CORPUS) {
  test(`#16 item 5 — selection after ${entry.name}`, async () => {
    const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK });
    terminal.open(createHost());
    let subscription: { dispose(): void } | null = null;
    try {
      await seedAndSelectTarget(terminal);

      let selectionChangeEvents = 0;
      subscription = terminal.onSelectionChange(() => { selectionChangeEvents += 1; });

      await entry.act(terminal);
      // xterm emits selection changes through its event queue, so give it a turn
      // before reading the count; without this the "0 events" rows would be
      // vacuous — they would read 0 because nothing had run yet.
      await new Promise(resolve => setTimeout(resolve, 20));

      assert.equal(
        terminal.hasSelection(),
        entry.hasSelection,
        `hasSelection() after '${entry.name}' changed. ${entry.note}`,
      );
      assert.equal(
        terminal.getSelection(),
        entry.text,
        `getSelection() after '${entry.name}' changed. ${entry.note}`,
      );
      assert.equal(
        selectionChangeEvents,
        entry.selectionChangeEvents,
        `onSelectionChange fired ${selectionChangeEvents} times after '${entry.name}', recorded `
          + `${entry.selectionChangeEvents}. Whether xterm notifies decides whether a fix can `
          + 'subscribe or has to validate at the boundary, so a change here changes the design.',
      );

      // The safety classification restated as a property, so it cannot drift
      // away from the recorded values it is supposed to summarise.
      const observedSafety: SelectionSafety = !terminal.hasSelection()
        ? 'cleared'
        : terminal.getSelection() === TARGET_LINE ? 'preserved' : 'unsafe';
      assert.equal(
        observedSafety,
        entry.safety,
        `'${entry.name}' is recorded as '${entry.safety}' but now behaves as '${observedSafety}'`,
      );
    } finally {
      subscription?.dispose();
      terminal.dispose();
    }
  });
}

/**
 * The forward-looking half. This is not a claim that the current behaviour is
 * correct — three of these four are user-visible defects — but a claim about
 * WHICH transitions are currently unsafe, so that the selection anchor model can
 * be checked against a known starting set rather than against an impression.
 */
test('#16 item 5 — exactly four transitions currently leave a selection that no longer holds what was selected', () => {
  const observed = LIFECYCLE_CORPUS.filter(entry => entry.safety === 'unsafe').map(entry => entry.name);
  assert.deepEqual(
    [...observed].sort(),
    [...UNSAFE_TRANSITIONS].sort(),
    'The set of unsafe transitions changed. If the selection anchor model closed one of these, '
      + 'delete it from UNSAFE_TRANSITIONS and change that corpus row to the behaviour it now has. '
      + 'If a new one appeared, that is a regression: a selection that survives an operation '
      + 'without still pointing at its content is how the wrong text reaches the clipboard.',
  );
  // Every unsafe transition is silent. That is the part that makes them hard to
  // fix reactively, and it is worth failing on if it ever stops being true —
  // because then subscribing WOULD be a valid fix.
  for (const name of UNSAFE_TRANSITIONS) {
    const entry = LIFECYCLE_CORPUS.find(candidate => candidate.name === name);
    assert.ok(entry, `${name} is declared unsafe but is not in the corpus`);
    assert.equal(
      entry.selectionChangeEvents,
      0,
      `${name} now notifies through onSelectionChange. A fix can subscribe rather than validating `
        + 'at the boundary, which is a cheaper design than the one these measurements implied.',
    );
  }
});
