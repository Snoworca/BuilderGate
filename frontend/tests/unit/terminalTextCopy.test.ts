import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  buildTerminalContextMenuItems,
  type BuildTerminalMenuOptions,
} from '../../src/utils/contextMenuBuilder.ts';
import {
  TERMINAL_TEXT_MAX_LINES,
  copyAllTerminalText,
  readTerminalBufferText,
} from '../../src/utils/terminalTextExport.ts';

// FR-ARCH-017 (#219): the terminal draws on a WebGL canvas, so a phone shows no
// selection handles over it and the menu's 복사 is always disabled there. The
// menu's 텍스트 선택 opens the terminal text as plain text in a dialog, where the
// operating system's own selection and copy work.

interface FakeRow { text: string; wrapped?: boolean }

/** A buffer shaped like xterm's IBuffer: translateToString(true) trims the right. */
function bufferOf(rows: FakeRow[]) {
  return {
    length: rows.length,
    getLine(index: number) {
      const row = rows[index];
      if (!row) return undefined;
      return {
        isWrapped: row.wrapped === true,
        translateToString: (trimRight?: boolean) => (trimRight ? row.text.replace(/\s+$/, '') : row.text),
      };
    },
  };
}

test('FR-ARCH-017 AC-2: rows xterm wrapped are joined back into one line, keeping the spaces at the wrap', () => {
  const text = readTerminalBufferText(bufferOf([
    { text: 'error: the file ' },
    { text: 'was not found   ', wrapped: true },
    { text: '$ ls' },
  ]));
  assert.equal(text, 'error: the file was not found\n$ ls');
});

test('FR-ARCH-017 AC-2: trailing blank lines are dropped, blank lines between text are kept', () => {
  const text = readTerminalBufferText(bufferOf([
    { text: 'one' },
    { text: '' },
    { text: 'two' },
    { text: '    ' },
    { text: '' },
  ]));
  assert.equal(text, 'one\n\ntwo');
});

test('FR-ARCH-017 AC-2: only the last lines are kept, counted as joined lines', () => {
  const rows: FakeRow[] = [];
  for (let line = 1; line <= 5; line += 1) {
    rows.push({ text: `line ${line} ` }, { text: 'tail', wrapped: true });
  }
  assert.equal(readTerminalBufferText(bufferOf(rows), 3), 'line 3 tail\nline 4 tail\nline 5 tail');
});

test('FR-ARCH-017 AC-2: the default keeps the last 2000 lines', () => {
  assert.equal(TERMINAL_TEXT_MAX_LINES, 2000);
  const rows = Array.from({ length: 2500 }, (_, index) => ({ text: `row ${index + 1}` }));
  const lines = readTerminalBufferText(bufferOf(rows)).split('\n');
  assert.equal(lines.length, 2000);
  assert.equal(lines[0], 'row 501');
  assert.equal(lines.at(-1), 'row 2500');
});

test('FR-ARCH-017 AC-4: 모두 복사 writes the whole text and reports copied, or failed when the write fails', async () => {
  const written: string[] = [];
  assert.equal(await copyAllTerminalText('a\nb', { writeText: async (data) => { written.push(data); } }), 'copied');
  assert.deepEqual(written, ['a\nb']);
  assert.equal(await copyAllTerminalText('a', { writeText: async () => { throw new Error('denied'); } }), 'failed');
  assert.equal(await copyAllTerminalText('a', undefined), 'failed');
});

function menuOptions(overrides: Partial<BuildTerminalMenuOptions> = {}): BuildTerminalMenuOptions {
  return {
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: false,
    ...overrides,
  };
}

function labelsOf(items: ReturnType<typeof buildTerminalContextMenuItems>): string[] {
  return items.flatMap(item => (item.separator ? [] : [item.label]));
}

test('FR-ARCH-017 AC-1: 텍스트 선택 follows 붙여넣기 when offered, and opens the dialog', () => {
  let opened = 0;
  const items = buildTerminalContextMenuItems(menuOptions({ onSelectText: () => { opened += 1; } }));
  const labels = labelsOf(items);
  const paste = labels.indexOf('붙여넣기');
  assert.ok(paste >= 0);
  assert.equal(labels[paste + 1], '텍스트 선택');
  const chosen = items.find(item => !item.separator && item.label === '텍스트 선택');
  assert.ok(chosen && !chosen.separator);
  chosen.onClick?.();
  assert.equal(opened, 1);
});

test('FR-ARCH-017 AC-1: without the option the menu is as before', () => {
  assert.equal(labelsOf(buildTerminalContextMenuItems(menuOptions())).includes('텍스트 선택'), false);
});

const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

test('FR-ARCH-017 AC-1: both terminal menus offer the item on a touch screen only', () => {
  for (const path of ['App.tsx', 'components/Grid/MosaicContainer.tsx']) {
    assert.match(source(path), /onSelectText:\s*isTouchMenuScreen\(\)[^?\n]*\?/, `${path} offers 텍스트 선택 only on a touch screen`);
  }
  assert.match(source('utils/terminalTextExport.ts'), /matchMedia\('\(pointer: coarse\)'\)/);
});

test('FR-ARCH-017 AC-2·AC-5: the handle reads the active buffer once, without touching the terminal', () => {
  const view = source('components/Terminal/TerminalView.tsx');
  assert.match(view, /getText:\s*\(\)\s*=>[\s\S]{0,120}readTerminalBufferText\([^)]*buffer\.active/);
  assert.match(source('components/Terminal/TerminalContainer.tsx'), /getText:\s*\(\)\s*=>\s*terminalRef\.current\?\.getText\(\)/);
});

test('FR-ARCH-017 AC-3: the dialog shows selectable plain text, starts at the last line and focuses no input', () => {
  const dialog = source('components/Terminal/TerminalTextDialog.tsx');
  assert.doesNotMatch(dialog, /<textarea|<input|autoFocus/);
  assert.match(dialog, /scrollTop\s*=\s*[\w.]*scrollHeight/);
  assert.match(dialog, /copyAllTerminalText\(/);
  const css = source('components/Terminal/TerminalTextDialog.css');
  assert.match(css, /-webkit-user-select:\s*text/);
  assert.match(css, /(^|[^-])user-select:\s*text/m);
  assert.match(css, /-webkit-touch-callout:\s*default/);
});
