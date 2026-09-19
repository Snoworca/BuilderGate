import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareRetainedHeadlessCheckpointRoundTrip,
  createHeadlessTerminalState,
  disposeHeadlessTerminal,
  serializeRetainedHeadlessCheckpoint,
  writeHeadlessTerminal,
  type HeadlessTerminalState,
} from './headlessTerminal.js';

/**
 * Issue #16, item 2 — golden tests for snapshot-and-recovery across the terminal
 * states that a plain "write text, snapshot, restore" test never reaches:
 * alternate-screen switches, cursor position, the saved cursor (DECSC/DECRC),
 * wrap-pending at the right margin, and an escape sequence split across writes.
 *
 * REL-BGSTAB-011 AC-2 requires the retained checkpoint to carry active screen,
 * alternate buffer, cursor/saved cursor, modes and the incomplete parser tail;
 * AC-4 requires the shadow comparer to compare those axes. Both were evidenced
 * by the RetainedTerminalAuthority registry, which exercises the wiring. What
 * had no golden was the state itself: nothing recorded WHAT a checkpoint of a
 * terminal parked at the right margin, or sitting on the alternate screen with
 * an outstanding DECSC, is supposed to contain, so a regression that changed it
 * consistently on both sides of a round trip would have compared equal to itself
 * and passed.
 *
 * Each scenario therefore makes four claims, and the last two are the ones that
 * a self-comparing round-trip test cannot make:
 *   1. the checkpoint of the driven terminal matches a RECORDED projection;
 *   2. a terminal rehydrated from that checkpoint matches the same projection;
 *   3. the internal comparer axes all report `match`;
 *   4. the origin and the rehydrated terminal, given the SAME next bytes, end in
 *      the same recorded state.
 *
 * (4) exists because several of these states are invisible in a static
 * projection. `wrap-pending-at-right-margin` and its boundary control differ by
 * a single column of input and produce the same visible row; they are told apart
 * only by where the next character lands — row 1 column 1 versus row 0 column 20.
 * A snapshot format that dropped the pending-wrap flag would pass (1), (2) and
 * (3) and fail only here.
 *
 * MEASURED 2026-09-19 against @xterm/headless 6.0.0 with the server's own
 * DEFAULT_TERMINAL_OPTIONS. The goldens are recorded observations, not values
 * derived from a specification.
 */

const COLS = 20;
const ROWS = 5;
const SCROLLBACK = 50;

function createState(): HeadlessTerminalState {
  return createHeadlessTerminalState({ cols: COLS, rows: ROWS, scrollbackLines: SCROLLBACK });
}

interface TerminalProjection {
  activeBuffer: string;
  cursor: { x: number; y: number };
  normal: string[];
  alternate: string[];
  /**
   * The cursor's row rendered cell by cell with its foreground colour, so a lost
   * SGR state shows up as a content difference rather than only as a style the
   * text projection cannot see.
   */
  styledCursorRow: string[];
}

function project(state: HeadlessTerminalState): TerminalProjection {
  const terminal = state.terminal;
  const rows = (which: 'normal' | 'alternate'): string[] => {
    const buffer = which === 'normal' ? terminal.buffer.normal : terminal.buffer.alternate;
    const out: string[] = [];
    for (let y = 0; y < buffer.length; y += 1) {
      out.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  };

  const line = terminal.buffer.active.getLine(terminal.buffer.active.cursorY);
  const styledCursorRow: string[] = [];
  if (line) {
    for (let x = 0; x < terminal.cols; x += 1) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const chars = cell.getChars();
      if (chars === '') continue;
      styledCursorRow.push(`${chars}@${cell.getFgColorMode()}:${cell.getFgColor()}`);
    }
  }

  return {
    activeBuffer: terminal.buffer.active.type,
    cursor: { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY },
    normal: rows('normal'),
    alternate: rows('alternate'),
    styledCursorRow,
  };
}

async function drive(state: HeadlessTerminalState, chunks: readonly string[]): Promise<void> {
  for (const chunk of chunks) {
    await writeHeadlessTerminal(state, chunk);
  }
}

interface RecoveryGolden {
  readonly name: string;
  /** Written in order, one write() per element, so split-write states are reachable. */
  readonly driveChunks: readonly string[];
  /** Written to BOTH the origin and the rehydrated terminal after the checkpoint. */
  readonly continuation: string;
  readonly savedCursor: { x: number; y: number } | null;
  readonly checkpointed: TerminalProjection;
  readonly afterContinuation: TerminalProjection;
}

const RECOVERY_CORPUS: readonly RecoveryGolden[] = [
  {
    name: 'normal-buffer-baseline',
    driveChunks: ['hello\r\nworld'],
    continuation: '!',
    savedCursor: null,
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 5, y: 1 },
      normal: ['hello', 'world'],
      alternate: [],
      styledCursorRow: ['w@0:-1', 'o@0:-1', 'r@0:-1', 'l@0:-1', 'd@0:-1'],
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 6, y: 1 },
      normal: ['hello', 'world!'],
      alternate: [],
      styledCursorRow: ['w@0:-1', 'o@0:-1', 'r@0:-1', 'l@0:-1', 'd@0:-1', '!@0:-1'],
    },
  },
  // The alternate screen must be restored as the ACTIVE buffer while the normal
  // buffer keeps the scrollback that was there before the switch. Losing either
  // half looks the same to a user until they exit the full-screen program.
  {
    name: 'alternate-screen-active',
    driveChunks: ['normal-1\r\nnormal-2', '[?1049h', '[HALT-A\r\nALT-B'],
    continuation: 'Z',
    savedCursor: null,
    checkpointed: {
      activeBuffer: 'alternate',
      cursor: { x: 5, y: 1 },
      normal: ['normal-1', 'normal-2'],
      alternate: ['ALT-A', 'ALT-B'],
      styledCursorRow: ['A@0:-1', 'L@0:-1', 'T@0:-1', '-@0:-1', 'B@0:-1'],
    },
    afterContinuation: {
      activeBuffer: 'alternate',
      cursor: { x: 6, y: 1 },
      normal: ['normal-1', 'normal-2'],
      alternate: ['ALT-A', 'ALT-BZ'],
      styledCursorRow: ['A@0:-1', 'L@0:-1', 'T@0:-1', '-@0:-1', 'B@0:-1', 'Z@0:-1'],
    },
  },
  // Boundary control for the entry above: after 1049l the alternate buffer is
  // discarded and the cursor is back where the normal buffer left it. If the
  // checkpoint confused the two buffers, this is the entry that says so.
  {
    name: 'alternate-screen-returned-to-normal',
    driveChunks: ['normal-1\r\nnormal-2', '[?1049h', '[HALT-A', '[?1049l'],
    continuation: 'Z',
    savedCursor: null,
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 8, y: 1 },
      normal: ['normal-1', 'normal-2'],
      alternate: [],
      styledCursorRow: ['n@0:-1', 'o@0:-1', 'r@0:-1', 'm@0:-1', 'a@0:-1', 'l@0:-1', '-@0:-1', '2@0:-1'],
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 9, y: 1 },
      normal: ['normal-1', 'normal-2Z'],
      alternate: [],
      styledCursorRow: ['n@0:-1', 'o@0:-1', 'r@0:-1', 'm@0:-1', 'a@0:-1', 'l@0:-1', '-@0:-1', '2@0:-1', 'Z@0:-1'],
    },
  },
  // Cursor parked in the middle of existing content rather than after it: the
  // continuation overwrites, which is what a prompt redraw does.
  {
    name: 'cursor-positioned-by-cup',
    driveChunks: ['line1\r\nline2\r\nline3', '[2;4H'],
    continuation: 'Z',
    savedCursor: null,
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 3, y: 1 },
      normal: ['line1', 'line2', 'line3'],
      alternate: [],
      styledCursorRow: ['l@0:-1', 'i@0:-1', 'n@0:-1', 'e@0:-1', '2@0:-1'],
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 4, y: 1 },
      normal: ['line1', 'linZ2', 'line3'],
      alternate: [],
      styledCursorRow: ['l@0:-1', 'i@0:-1', 'n@0:-1', 'Z@0:-1', '2@0:-1'],
    },
  },
  // DECSC with the restore still outstanding. The saved position is invisible in
  // every projection above, so the continuation opens with DECRC: if the saved
  // cursor were lost the Z would land at 0,0 instead of 4,2.
  {
    name: 'saved-cursor-decsc-outstanding',
    driveChunks: ['abc\r\ndef', '[3;5H', '7', '[1;1H'],
    continuation: '8Z',
    savedCursor: { x: 4, y: 2 },
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 0, y: 0 },
      normal: ['abc', 'def'],
      alternate: [],
      styledCursorRow: ['a@0:-1', 'b@0:-1', 'c@0:-1'],
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 5, y: 2 },
      normal: ['abc', 'def', '    Z'],
      alternate: [],
      styledCursorRow: ['Z@0:-1'],
    },
  },
  // DECRC already consumed before the checkpoint. The saved cursor survives the
  // restore (DECRC does not clear it), which is why savedCursor is still set.
  {
    name: 'saved-cursor-decsc-decrc-restored',
    driveChunks: ['abc\r\ndef', '[3;5H7[1;1H8'],
    continuation: 'Z',
    savedCursor: { x: 4, y: 2 },
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 4, y: 2 },
      normal: ['abc', 'def'],
      alternate: [],
      styledCursorRow: [],
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 5, y: 2 },
      normal: ['abc', 'def', '    Z'],
      alternate: [],
      styledCursorRow: ['Z@0:-1'],
    },
  },
  // Exactly COLS characters. xterm parks the cursor at x === cols, one past the
  // last column, meaning "the next printable wraps". Compare the two rows of
  // afterContinuation with the control below: same visible row, opposite answer.
  {
    name: 'wrap-pending-at-right-margin',
    driveChunks: ['X'.repeat(COLS)],
    continuation: 'Y',
    savedCursor: null,
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 20, y: 0 },
      normal: ['XXXXXXXXXXXXXXXXXXXX'],
      alternate: [],
      styledCursorRow: Array.from({ length: 20 }, () => 'X@0:-1'),
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 1, y: 1 },
      normal: ['XXXXXXXXXXXXXXXXXXXX', 'Y'],
      alternate: [],
      styledCursorRow: ['Y@0:-1'],
    },
  },
  {
    name: 'wrap-not-pending-boundary-control',
    driveChunks: ['X'.repeat(COLS - 1)],
    continuation: 'Y',
    savedCursor: null,
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 19, y: 0 },
      normal: ['XXXXXXXXXXXXXXXXXXX'],
      alternate: [],
      styledCursorRow: Array.from({ length: 19 }, () => 'X@0:-1'),
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 20, y: 0 },
      normal: ['XXXXXXXXXXXXXXXXXXXY'],
      alternate: [],
      styledCursorRow: [...Array.from({ length: 19 }, () => 'X@0:-1'), 'Y@0:-1'],
    },
  },
  // An SGR split across two write() calls. Once the sequence completes, the
  // checkpoint must carry the resulting red foreground (P16 mode 16777216,
  // colour 1) and not the literal bytes. The mid-escape case is NOT here; it is
  // a separate test below because it does not round-trip.
  {
    name: 'escape-split-across-writes-completed',
    driveChunks: ['pre[3', '1mRED'],
    continuation: '!',
    savedCursor: null,
    checkpointed: {
      activeBuffer: 'normal',
      cursor: { x: 6, y: 0 },
      normal: ['preRED'],
      alternate: [],
      styledCursorRow: ['p@0:-1', 'r@0:-1', 'e@0:-1', 'R@16777216:1', 'E@16777216:1', 'D@16777216:1'],
    },
    afterContinuation: {
      activeBuffer: 'normal',
      cursor: { x: 7, y: 0 },
      normal: ['preRED!'],
      alternate: [],
      styledCursorRow: [
        'p@0:-1', 'r@0:-1', 'e@0:-1',
        'R@16777216:1', 'E@16777216:1', 'D@16777216:1', '!@16777216:1',
      ],
    },
  },
];

test('#16 the recovery corpus covers every state issue #16 item 2 names', () => {
  const names = RECOVERY_CORPUS.map(entry => entry.name);
  assert.equal(new Set(names).size, names.length, 'corpus entry names must be unique');
  for (const required of ['alternate-screen', 'cursor-positioned', 'saved-cursor', 'wrap-pending', 'escape-split']) {
    assert.ok(
      names.some(name => name.includes(required)),
      `the corpus lost its '${required}' state; issue #16 item 2 requires all of them`,
    );
  }
  // Non-vacuity floor: a shrunk corpus passes every per-entry assertion below by
  // having none left to run.
  assert.ok(RECOVERY_CORPUS.length >= 9, `expected at least 9 scenarios, found ${RECOVERY_CORPUS.length}`);
});

for (const entry of RECOVERY_CORPUS) {
  test(`#16 snapshot recovery golden — ${entry.name}`, async () => {
    const origin = createState();
    let restored: HeadlessTerminalState | null = null;
    try {
      await drive(origin, entry.driveChunks);

      assert.deepEqual(
        project(origin),
        entry.checkpointed,
        `driving '${entry.name}' no longer reaches the recorded state; the golden below describes `
          + 'a terminal this input does not produce any more',
      );

      const checkpoint = serializeRetainedHeadlessCheckpoint(origin);
      assert.deepEqual(
        checkpoint.savedCursor,
        entry.savedCursor,
        `the checkpoint's saved cursor for '${entry.name}' changed; DECRC after a restore would `
          + 'move the cursor somewhere else',
      );
      assert.equal(checkpoint.activeBuffer, entry.checkpointed.activeBuffer);
      assert.deepEqual(checkpoint.cursor, entry.checkpointed.cursor);

      // The comparer's own verdict, per axis. `parserTail` and `eviction` are
      // external axes the caller supplies; asserting the folded result instead
      // would read `unavailable` here and say nothing.
      const comparison = await compareRetainedHeadlessCheckpointRoundTrip(checkpoint, {
        scrollbackLines: SCROLLBACK,
      });
      for (const axis of ['logicalLines', 'cells', 'unicodeWidth', 'cursor', 'modes', 'activeBuffer'] as const) {
        assert.equal(
          comparison.axes[axis],
          'match',
          `round-trip axis '${axis}' for '${entry.name}' is ${comparison.axes[axis]}`,
        );
      }

      restored = createState();
      await writeHeadlessTerminal(restored, checkpoint.rehydrateAnsi);
      assert.deepEqual(
        project(restored),
        entry.checkpointed,
        `a terminal rehydrated from the '${entry.name}' checkpoint is not in the state that was `
          + 'checkpointed',
      );

      // The discriminating half. Identical next bytes must land identically.
      await writeHeadlessTerminal(origin, entry.continuation);
      await writeHeadlessTerminal(restored, entry.continuation);
      assert.deepEqual(
        project(origin),
        entry.afterContinuation,
        `continuing the origin terminal for '${entry.name}' no longer reaches the recorded state`,
      );
      assert.deepEqual(
        project(restored),
        entry.afterContinuation,
        `the rehydrated terminal for '${entry.name}' diverges from the origin once output resumes. `
          + 'A static projection can be equal while the terminals are in different states; this is '
          + 'where that shows.',
      );
    } finally {
      disposeHeadlessTerminal(origin);
      if (restored) disposeHeadlessTerminal(restored);
    }
  });
}

/**
 * The one case that does NOT round-trip, recorded as a measurement rather than
 * asserted as correct.
 *
 * A checkpoint taken while an escape sequence is half-delivered carries only
 * what the parser has committed. The bytes parked mid-sequence are not in
 * `rehydrateAnsi`, so a terminal rehydrated from that checkpoint and then handed
 * the REST of the sequence parses the remainder as literal text: `pre1mRED`
 * unstyled, where the origin has `preRED` in red.
 *
 * This is not a defect in the checkpoint; it is why REL-BGSTAB-011 AC-2 lists the
 * incomplete parser tail as its own element of the retained state and AC-4 gives
 * `parserTail` its own comparer axis rather than folding it into the cell
 * comparison. The second half of this test is the constructive statement: replay
 * the tail ahead of the continuation and the divergence closes exactly.
 */
test('#16 a checkpoint taken mid-escape does not carry the parser tail, and replaying it closes the gap', async () => {
  const COMMITTED = 'pre';
  const PARKED_TAIL = '[3';
  const REMAINDER = '1mRED';

  const origin = createState();
  const naive = createState();
  const withTail = createState();
  try {
    await drive(origin, [COMMITTED + PARKED_TAIL]);
    const checkpoint = serializeRetainedHeadlessCheckpoint(origin);

    assert.equal(
      checkpoint.rehydrateAnsi.includes(PARKED_TAIL),
      false,
      'the checkpoint now carries the incomplete escape inline. That would change how the parser '
        + 'tail must be replayed, so re-derive this contract rather than deleting the assertion.',
    );
    assert.equal(checkpoint.rehydrateAnsi, COMMITTED);

    await writeHeadlessTerminal(naive, checkpoint.rehydrateAnsi);
    await writeHeadlessTerminal(withTail, checkpoint.rehydrateAnsi);

    await writeHeadlessTerminal(origin, REMAINDER);
    await writeHeadlessTerminal(naive, REMAINDER);
    await writeHeadlessTerminal(withTail, PARKED_TAIL + REMAINDER);

    const originProjection = project(origin);
    assert.deepEqual(originProjection.normal, ['preRED']);
    assert.deepEqual(
      originProjection.styledCursorRow,
      ['p@0:-1', 'r@0:-1', 'e@0:-1', 'R@16777216:1', 'E@16777216:1', 'D@16777216:1'],
    );

    // MEASURED divergence. Recorded exactly, so that a future change which makes
    // the checkpoint carry the tail fails here and gets read rather than passing
    // silently under a looser `notDeepEqual`.
    const naiveProjection = project(naive);
    assert.deepEqual(naiveProjection.normal, ['pre1mRED']);
    assert.deepEqual(naiveProjection.cursor, { x: 8, y: 0 });
    assert.deepEqual(
      naiveProjection.styledCursorRow,
      ['p@0:-1', 'r@0:-1', 'e@0:-1', '1@0:-1', 'm@0:-1', 'R@0:-1', 'E@0:-1', 'D@0:-1'],
      'the remainder of the escape must be parsed as literal text when the tail was dropped; if it '
        + 'is not, this test is no longer measuring what it claims',
    );

    assert.deepEqual(
      project(withTail),
      originProjection,
      'replaying the parked parser tail ahead of the remaining bytes must reproduce the origin '
        + 'exactly; if it does not, carrying the tail out of band is not sufficient recovery',
    );
  } finally {
    disposeHeadlessTerminal(origin);
    disposeHeadlessTerminal(naive);
    disposeHeadlessTerminal(withTail);
  }
});
