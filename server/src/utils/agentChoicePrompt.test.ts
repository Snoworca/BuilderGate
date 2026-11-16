/**
 * FR-AITUI-024 AC-1 / AC-3: what counts as an agent waiting on a choice, read from
 * the bottom of its screen, and which key presses answer it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOICE_PROMPT_SCAN_ROWS,
  isAgentChoicePrompt,
  isChoiceAnsweringInput,
  readHeadlessBottomRows,
} from './agentChoicePrompt.js';
import { CAPTURED_NEGATIVE_SCREENS, CAPTURED_POSITIVE_SCREENS } from './agentChoicePrompt.fixtures.js';
import { createHeadlessTerminalState, writeHeadlessTerminal } from './headlessTerminal.js';

/** The rows the server actually reads: the bottom of a 32-row screen. */
function bottomRows(screen: string): string {
  return screen.split('\n').slice(-CHOICE_PROMPT_SCAN_ROWS).join('\n');
}

for (const [name, screen] of Object.entries(CAPTURED_POSITIVE_SCREENS)) {
  test(`FR-AITUI-024 AC-1: the captured screen ${name} waits on a choice`, () => {
    assert.equal(isAgentChoicePrompt(bottomRows(screen)), true, screen);
  });
}

for (const [name, screen] of Object.entries(CAPTURED_NEGATIVE_SCREENS)) {
  test(`FR-AITUI-024 AC-1: the captured screen ${name} does not wait on a choice`, () => {
    assert.equal(isAgentChoicePrompt(bottomRows(screen)), false, screen);
  });
}

// Not captured: codex-cli 0.167.0 on this machine ran the command without asking.
// Reconstructed from the approval overlay's wording so the second cursor glyph (›)
// and its footer are covered; replace it with a capture when one is at hand.
test('FR-AITUI-024 AC-1: a Codex approval overlay (reconstructed, not captured) waits on a choice', () => {
  const screen = [
    '› Run this shell command and nothing else: mkdir awaiting-probe',
    '',
    '  Would you like to run the following command?',
    '',
    '  $ mkdir awaiting-probe',
    '',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for this command (a)",
    '  3. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n');
  assert.equal(isAgentChoicePrompt(screen), true);
});

test('FR-AITUI-024 AC-1: a numbered menu without a footer still counts when the cursor sits on it', () => {
  assert.equal(isAgentChoicePrompt(['Pick one', '❯ 1. Alpha', '  2. Beta', '  3. Gamma'].join('\n')), true);
});

test('FR-AITUI-024 AC-1: an ASCII-cursor (">") numbered menu counts, as Claude Code draws it without TERM', () => {
  assert.equal(isAgentChoicePrompt(['Do you want to create probe.txt?', '> 1. Yes', '  2. No', '', 'Esc to cancel'].join('\n')), true);
  assert.equal(isAgentChoicePrompt(['Pick one', '> 1. Alpha', '  2. Beta'].join('\n')), true);
});

test('FR-AITUI-024 AC-1: PowerShell continuation (">>") and a quoted list printed by a shell do not count', () => {
  assert.equal(isAgentChoicePrompt(['PS C:\\work> if ($true) {', '>> Write-Host 1', '>> ', 'Enter to confirm'].join('\n')), false);
  assert.equal(isAgentChoicePrompt(['PS C:\\work> Get-Content notes.md', '> 1. build', '> 2. test', 'PS C:\\work> '].join('\n')), false);
});

test('FR-AITUI-024 AC-1: shell output with a numbered list and a prompt after it does not count', () => {
  const screen = ['PS C:\\work> Get-Steps', '1. build', '2. test', '3. ship', 'PS C:\\work> '].join('\n');
  assert.equal(isAgentChoicePrompt(screen), false);
});

test('FR-AITUI-024 AC-1: a working agent ("esc to interrupt") does not count', () => {
  const screen = ['❯ fix the build', '', '✻ Thinking… (12s · esc to interrupt)', '', '─────', '❯ ', '─────'].join('\n');
  assert.equal(isAgentChoicePrompt(screen), false);
});

test('FR-AITUI-024 AC-1: a menu scrolled up away from the bottom does not count', () => {
  const lines = ['❯ 1. Yes', '  2. No', 'Esc to cancel'];
  for (let i = 0; i < 10; i += 1) lines.push(`output line ${i}`);
  assert.equal(isAgentChoicePrompt(lines.join('\n')), false);
});

test('FR-AITUI-024 AC-3: keys that pick or cancel answer the prompt', () => {
  for (const key of ['\r', '\u001b', '1', '2', 'y', 'n', '\u0003', 'hello', '\u001b[200~pasted\u001b[201~']) {
    assert.equal(isChoiceAnsweringInput(key), true, JSON.stringify(key));
  }
});

test('FR-AITUI-024 AC-3: moving, focus, mouse and query replies do not answer it', () => {
  const quiet = [
    '\u001b[A', '\u001b[B', '\u001b[C', '\u001b[D', '\u001bOA', '\u001bOB', '\u001b[1;5A',
    '\t', '\u001b[Z', '\u001b[5~', '\u001b[6~', '\u001b[H', '\u001b[F',
    '\u001b[I', '\u001b[O',
    '\u001b[<0;12;7M', '\u001b[<0;12;7m', '\u001b[<35;40;9M', '\u001b[M !!',
    '\u001b[12;40R', '\u001b[?62;22c', '\u001b[>0;276;0c',
    '\u001b]11;rgb:1e1e/1e1e/1e1e\u0007', '\u001b]10;rgb:cccc/cccc/cccc\u001b\\',
    '\u001b[B\u001b[B',
    '',
  ];
  for (const data of quiet) {
    assert.equal(isChoiceAnsweringInput(data), false, JSON.stringify(data));
  }
});

test('FR-AITUI-024 AC-2: only the bottom rows of the live screen are read, not the scrollback', async () => {
  const state = createHeadlessTerminalState({ cols: 40, rows: 6, scrollbackLines: 500 });
  try {
    let text = '';
    for (let i = 0; i < 200; i += 1) text += `line ${i}\r\n`;
    text += 'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel';
    await writeHeadlessTerminal(state, text);
    const rows = readHeadlessBottomRows(state, 4);
    assert.deepEqual(rows.split('\n'), ['Do you want to proceed?', '❯ 1. Yes', '  2. No', 'Esc to cancel']);
    assert.equal(readHeadlessBottomRows(state, 100).split('\n').length, 6, 'never more than the screen');
    assert.equal(isAgentChoicePrompt(readHeadlessBottomRows(state, CHOICE_PROMPT_SCAN_ROWS)), true);
  } finally {
    state.terminal.dispose();
  }
});

test('FR-AITUI-024 AC-2: a menu drawn high on a tall screen with blank rows below it is still read', async () => {
  // Seen on 2222: a 143x40 browser terminal, Claude Code's folder-trust menu drawn
  // under the shell prompt around row 18, rows 19-40 still blank. The bottom 16 rows
  // of the screen were all blank, so the menu was never seen.
  const state = createHeadlessTerminalState({ cols: 80, rows: 40, scrollbackLines: 500 });
  try {
    await writeHeadlessTerminal(state, 'PS C:\work> claude\r\n\r\n Quick safety check\r\n\r\n > No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel\r\n');
    const rows = readHeadlessBottomRows(state, CHOICE_PROMPT_SCAN_ROWS);
    assert.ok(rows.includes('> No, exit'), rows);
    assert.equal(isAgentChoicePrompt(rows), true);
    assert.ok(rows.split('\n').length <= CHOICE_PROMPT_SCAN_ROWS, 'never more than the requested rows');
  } finally {
    state.terminal.dispose();
  }
});

test('FR-AITUI-024 AC-2: a blank screen reads as nothing', async () => {
  const state = createHeadlessTerminalState({ cols: 80, rows: 40, scrollbackLines: 500 });
  try {
    await writeHeadlessTerminal(state, '\u001b[2J\u001b[H');
    assert.equal(readHeadlessBottomRows(state, CHOICE_PROMPT_SCAN_ROWS), '');
  } finally {
    state.terminal.dispose();
  }
});
