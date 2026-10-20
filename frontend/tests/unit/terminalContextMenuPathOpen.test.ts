import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTerminalContextMenuItems,
  type BuildTerminalMenuOptions,
} from '../../src/utils/contextMenuBuilder.ts';

// FR-ARCH-013 AC-1~AC-5 — the terminal menu (mobile long press, right click)
// offers the file path near the press and the files on screen.
//
// contextMenuBuilder.ts is under the stable FR-ARCH-004..006 contracts, so a
// caller that does not pass the option gets exactly the menu it got before.
// The option travels in a variable typed as the builder's options plus the new
// field, so this file type-checks before the field exists.
type Target = { path: string; alternatives: string[] };
type PathOpenOption = {
  near: Target | null;
  screen: Target[];
  onOpen: (target: Target) => void;
};
const target = (path: string): Target => ({ path, alternatives: [] });
type TerminalMenuOptionsWithPaths = BuildTerminalMenuOptions & { openPath?: PathOpenOption };

const SCREEN_FILES = '화면의 파일';

function base(overrides: Partial<TerminalMenuOptionsWithPaths> = {}): TerminalMenuOptionsWithPaths {
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

test('FR-ARCH-013 AC-1·AC-5: a path near the press is the first item and opens that path', () => {
  const opened: string[] = [];
  const items = buildTerminalContextMenuItems(base({
    openPath: { near: target('docs/design/main.html'), screen: [target('docs/design/main.html')], onOpen: chosen => opened.push(chosen.path) },
  }));
  const first = items[0];
  assert.ok(first && !first.separator);
  assert.equal(first.label, 'main.html 열기');
  first.onClick?.();
  assert.deepEqual(opened, ['docs/design/main.html']);
  assert.equal(items[1]?.separator, true, 'a separator sets the open item apart from the menu below');
});

test('FR-ARCH-013 AC-2: without a path near the press the menu starts as before', () => {
  const plain = labelsOf(buildTerminalContextMenuItems(base()));
  const items = buildTerminalContextMenuItems(base({ openPath: { near: null, screen: [], onOpen: () => undefined } }));
  assert.equal(labelsOf(items)[0], plain[0]);
  assert.equal(labelsOf(items).some(label => label.endsWith(' 열기') && label !== '파일 탐색기 열기'), false);
});

test('FR-ARCH-013 AC-3·AC-5: 화면의 파일 lists the screen paths in order and each opens its path', () => {
  const opened: string[] = [];
  const items = buildTerminalContextMenuItems(base({
    openPath: { near: null, screen: [target('c.md'), target('docs/b.html')], onOpen: chosen => opened.push(chosen.path) },
  }));
  const entry = items.find(item => !item.separator && item.label === SCREEN_FILES);
  assert.ok(entry && !entry.separator, `the menu offers ${SCREEN_FILES}; got ${JSON.stringify(labelsOf(items))}`);
  assert.notEqual(entry.disabled, true);
  // AC-7: each entry shows the file name; the folder goes on its second line.
  assert.deepEqual(entry.children?.map(child => (child.separator ? '' : child.label)), ['c.md', 'b.html']);
  const second = entry.children?.[1];
  assert.ok(second && !second.separator);
  second.onClick?.();
  assert.deepEqual(opened, ['docs/b.html']);
});

test('FR-ARCH-013 AC-4: with no paths on screen 화면의 파일 is disabled', () => {
  const items = buildTerminalContextMenuItems(base({ openPath: { near: null, screen: [], onOpen: () => undefined } }));
  const entry = items.find(item => !item.separator && item.label === SCREEN_FILES);
  assert.ok(entry && !entry.separator);
  assert.equal(entry.disabled, true);
});

test('FR-ARCH-013: without the option the menu is exactly what it was', () => {
  const items = buildTerminalContextMenuItems(base());
  assert.equal(labelsOf(items).includes(SCREEN_FILES), false);
});

test('FR-ARCH-013 AC-7: items show the file name, and the folder relative to the session folder below it', () => {
  const tab = { id: 't1', cwd: 'C:\\w\\proj' } as never;
  const items = buildTerminalContextMenuItems(base({
    tab,
    openPath: {
      near: target('C:\\w\\proj\\docs\\mockups\\a.html'),
      screen: [target('C:\\w\\proj\\docs\\mockups\\a.html'), target('b.md')],
      onOpen: () => undefined,
    },
  }));
  const first = items[0];
  assert.ok(first && !first.separator);
  assert.equal(first.label, 'a.html 열기');
  assert.equal(first.description, 'docs\\mockups');
  const entry = items.find(item => !item.separator && item.label === SCREEN_FILES);
  assert.ok(entry && !entry.separator);
  assert.deepEqual(
    entry.children?.map(child => (child.separator ? null : [child.label, child.description])),
    [['a.html', 'docs\\mockups'], ['b.md', '현재 폴더']],
  );
});

test('FR-ARCH-013 AC-4: the disabled 화면의 파일 survives the menu normalization', async () => {
  const { normalizeContextMenuItems } = await import('../../src/components/ContextMenu/contextMenuModel.ts');
  const items = buildTerminalContextMenuItems(base({ openPath: { near: null, screen: [], onOpen: () => undefined } }));
  const entry = normalizeContextMenuItems(items).find(item => !item.separator && item.label === SCREEN_FILES);
  assert.ok(entry && !entry.separator, 'the empty entry is still shown');
  assert.equal(entry.disabled, true);
});
