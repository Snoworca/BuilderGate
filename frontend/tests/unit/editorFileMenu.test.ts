import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EDITOR_INSTRUCTION_FILES,
  buildEditorFileMenuItems,
  decideEditorFileMenuSelection,
  resolveEditorFilePath,
  type EditorFileMenuSelection,
  type OpenEditorWindow,
} from '../../src/utils/editorFileMenu.ts';

// FR-MDE-007 — the item builder and the duplicate key, as pure functions.
//
// AC-1 (the three items), AC-6 and AC-7 (the duplicate key is the normalized
// absolute path, never the tab-and-path pair) and AC-8 (the items come from a
// module that is not contextMenuBuilder.ts) are decided here. AC-3, AC-4 and
// AC-5 issue a read, a confirmation and a MessageBox against a live session and
// belong to the Playwright suite; this one has no DOM and no server.
//
// The right-click itself is E2E's too, but which render sites carry the handler
// is readable from the source, and that is the one failure the component cannot
// show: both sites render the same component, so an omission at one of them is
// invisible from inside it.

const CWD = 'C:\\Work\\proj';

// The menu items as this suite inspects them. `ContextMenuItem` is a union of an
// action and a separator, and the fields below are read only after each one has
// been checked to be there -- a blind cast would keep passing if the builder
// started answering with separators or with items that carry no handler.
interface MenuItemProbe {
  label?: unknown;
  onClick?: unknown;
  children?: unknown;
  separator?: unknown;
}

function probe(items: readonly unknown[]): MenuItemProbe[] {
  return items.map((item) => {
    assert.equal(typeof item, 'object', 'every menu item is an object');
    assert.notEqual(item, null);
    return item as MenuItemProbe;
  });
}

function labelsOf(items: readonly unknown[]): unknown[] {
  return probe(items).map(item => item.label);
}

function choose(items: readonly unknown[], label: string): void {
  const found = probe(items).find(item => item.label === label);
  assert.notEqual(found, undefined, `the menu offers ${label}`);
  assert.equal(typeof found?.onClick, 'function', `${label} carries a handler`);
  (found?.onClick as () => void)();
}

test('FR-MDE-007 the builder produces exactly the three agent instruction files', () => {
  const selections: EditorFileMenuSelection[] = [];
  const items = buildEditorFileMenuItems({
    cwd: CWD,
    tabId: 'tab-1',
    openWindows: [],
    onSelect: selection => selections.push(selection),
  });

  // The uppercase spelling is the contract, not a display choice: these are the
  // names the tools actually read off disk.
  assert.deepEqual(labelsOf(items), ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
  assert.deepEqual([...EDITOR_INSTRUCTION_FILES], ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);

  // No separators and no submenus. FR-ARCH-001 caps menu depth at 5, and a flat
  // list of three never approaches it.
  probe(items).forEach((item) => {
    assert.equal(item.separator, undefined);
    assert.equal(item.children, undefined);
  });

  choose(items, 'CLAUDE.local.md');
  assert.deepEqual(selections, [{
    kind: 'open',
    filePath: resolveEditorFilePath(CWD, 'CLAUDE.local.md'),
    tabId: 'tab-1',
  }]);
});

test('FR-MDE-007 reopening the same resolved path reuses the existing window', () => {
  const filePath = resolveEditorFilePath(CWD, 'CLAUDE.md');
  const openWindows: OpenEditorWindow[] = [{ tabId: 'tab-1', filePath }];
  const selections: EditorFileMenuSelection[] = [];

  const items = buildEditorFileMenuItems({
    cwd: CWD,
    tabId: 'tab-1',
    openWindows,
    onSelect: selection => selections.push(selection),
  });
  choose(items, 'CLAUDE.md');

  // `revive` and not `open`: the caller reads this as "raise that window" and
  // issues neither the read nor the write, which is what AC-6 counts.
  assert.deepEqual(selections, [{ kind: 'revive', filePath, tabId: 'tab-1' }]);

  // The key is the normalized absolute path, so the same directory written with
  // the other separator or with a trailing one is the same window.
  assert.equal(resolveEditorFilePath('C:/Work/proj/', 'CLAUDE.md'), filePath);
  assert.equal(resolveEditorFilePath('C:\\Work\\proj\\', 'CLAUDE.md'), filePath);
  assert.deepEqual(
    decideEditorFileMenuSelection({
      cwd: 'C:/Work/proj/',
      fileName: 'CLAUDE.md',
      tabId: 'tab-1',
      openWindows,
    }),
    { kind: 'revive', filePath, tabId: 'tab-1' },
  );
});

test('FR-MDE-007 two tabs sharing a cwd resolve to one window bound to the first tab', () => {
  const filePath = resolveEditorFilePath(CWD, 'CLAUDE.md');
  const openWindows: OpenEditorWindow[] = [{ tabId: 'tab-1', filePath }];

  // Keyed by the pair, this would answer `open` and put a second window on the
  // same file on disk; with no conflict detection the later save erases the
  // other one's work.
  assert.deepEqual(
    decideEditorFileMenuSelection({
      cwd: CWD,
      fileName: 'CLAUDE.md',
      tabId: 'tab-2',
      openWindows,
    }),
    { kind: 'revive', filePath, tabId: 'tab-1' },
  );

  // The key stays a key: a different file under the same cwd, and the same file
  // under a different cwd, are both still new windows bound to the asking tab.
  assert.deepEqual(
    decideEditorFileMenuSelection({
      cwd: CWD,
      fileName: 'AGENTS.md',
      tabId: 'tab-2',
      openWindows,
    }),
    { kind: 'open', filePath: resolveEditorFilePath(CWD, 'AGENTS.md'), tabId: 'tab-2' },
  );
  assert.deepEqual(
    decideEditorFileMenuSelection({
      cwd: 'C:\\Work\\other',
      fileName: 'CLAUDE.md',
      tabId: 'tab-2',
      openWindows,
    }),
    { kind: 'open', filePath: resolveEditorFilePath('C:\\Work\\other', 'CLAUDE.md'), tabId: 'tab-2' },
  );
});

const BUILDER_SOURCE = readFileSync(
  new URL('../../src/utils/contextMenuBuilder.ts', import.meta.url),
  'utf8',
);
const MENU_SOURCE = readFileSync(
  new URL('../../src/utils/editorFileMenu.ts', import.meta.url),
  'utf8',
);
const ROW_SOURCE = readFileSync(
  new URL('../../src/components/MetadataBar/MetadataRow.tsx', import.meta.url),
  'utf8',
);
const APP_SOURCE = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
const TILE_SOURCE = readFileSync(
  new URL('../../src/components/Grid/MosaicTile.tsx', import.meta.url),
  'utf8',
);

test('FR-MDE-007 the items come from a module other than contextMenuBuilder.ts', () => {
  // contextMenuBuilder.ts is covered by the FR-ARCH-004 through FR-ARCH-006
  // contracts, which are Stability=stable. The three names living anywhere in it
  // -- or it reaching for the new module -- is this work having entangled itself
  // with those contracts.
  EDITOR_INSTRUCTION_FILES.forEach((name) => {
    assert.equal(BUILDER_SOURCE.includes(name), false, `${name} stays out of contextMenuBuilder.ts`);
  });
  assert.equal(BUILDER_SOURCE.includes('editorFileMenu'), false);
  assert.equal(BUILDER_SOURCE.includes('EditorWindow'), false);

  EDITOR_INSTRUCTION_FILES.forEach((name) => {
    assert.ok(MENU_SOURCE.includes(name), `${name} is declared by the new builder`);
  });
});

test('FR-MDE-007 both MetadataRow render sites carry the path context menu handler', () => {
  // The DOM half of AC-1 and AC-2 -- that the menu actually opens on a right
  // click and that a left click still copies -- is Playwright's. What is read
  // here is the wiring both of those rest on.
  const pathStart = ROW_SOURCE.indexOf('className="metadata-cwd-path"');
  assert.notEqual(pathStart, -1, 'the path element is still identified by its class');

  // The element's own attribute list, cut at the first `>` after the class name,
  // so a handler attached to some other element in the row does not count.
  const pathAttributes = ROW_SOURCE.slice(pathStart, ROW_SOURCE.indexOf('>', pathStart));
  assert.ok(pathAttributes.includes('onClick={handleCopy}'), 'the copy handler stays');
  assert.ok(pathAttributes.includes('onContextMenu'), 'the path element opens the menu');
  assert.ok(ROW_SOURCE.includes('onPathContextMenu'), 'the handler arrives as a prop');

  // Both render sites, because a component cannot see which of its call sites
  // forgot to pass the prop.
  [
    ['App.tsx', APP_SOURCE],
    ['MosaicTile.tsx', TILE_SOURCE],
  ].forEach(([name, source]) => {
    const mountStart = source.indexOf('<MetadataRow');
    assert.notEqual(mountStart, -1, `${name} still renders MetadataRow`);

    const mountEnd = source.indexOf('/>', mountStart);
    assert.notEqual(mountEnd, -1, `${name}'s MetadataRow element is self-closing`);
    assert.ok(
      source.slice(mountStart, mountEnd).includes('onPathContextMenu'),
      `${name} passes onPathContextMenu`,
    );
  });
});

// FR-FEX-010 — the file explorer entry at the top of the same menu.
//
// The order is the user's own decision: the explorer first, then a separator,
// then the instruction files. EDITOR_INSTRUCTION_FILES is a list that can grow,
// and an entry placed under it would drift down every time it did; the top is
// the one position that stays put.
//
// The option is threaded through a variable typed as the builder's options plus
// the new field, so this file still type-checks before the field exists and the
// failure lands on the assertions below rather than on the compiler.
type EditorFileMenuOptionsWithExplorer = Parameters<typeof buildEditorFileMenuItems>[0] & {
  onOpenFileExplorer?: (tabId: string) => void;
};

function buildWithExplorer(
  overrides: Partial<EditorFileMenuOptionsWithExplorer> = {},
): { items: ReturnType<typeof buildEditorFileMenuItems>; explorerCalls: string[]; selections: EditorFileMenuSelection[] } {
  const explorerCalls: string[] = [];
  const selections: EditorFileMenuSelection[] = [];
  const options: EditorFileMenuOptionsWithExplorer = {
    cwd: CWD,
    tabId: 'tab-7',
    openWindows: [],
    onSelect: selection => selections.push(selection),
    onOpenFileExplorer: tabId => explorerCalls.push(tabId),
    ...overrides,
  };

  return { items: buildEditorFileMenuItems(options), explorerCalls, selections };
}

test('FR-FEX-010 AC-1 the first item is 파일 탐색기 and it opens the explorer for the right-clicked tab', () => {
  const { items, explorerCalls, selections } = buildWithExplorer();
  const first = probe(items)[0];

  assert.equal(first?.label, '파일 탐색기', 'the explorer is the first item');
  assert.equal(first?.separator, undefined, 'the first item is an action, not a separator');
  assert.equal(typeof first?.onClick, 'function', 'the explorer item carries a handler');

  (first?.onClick as () => void)();

  // The right-clicked tab, not the active one: in grid mode the tile under the
  // pointer is routinely not the active tile.
  assert.deepEqual(explorerCalls, ['tab-7']);
  // Choosing the explorer is not choosing a file.
  assert.deepEqual(selections, []);

  // A second tab id, so a handler that ignores options.tabId and hard-codes
  // the one above cannot pass.
  const other = buildWithExplorer({ tabId: 'tab-3' });
  (probe(other.items)[0]?.onClick as () => void)();
  assert.deepEqual(other.explorerCalls, ['tab-3']);
});

test('FR-FEX-010 AC-2 a separator follows, then the instruction files in their declared order', () => {
  const { items } = buildWithExplorer();
  const probed = probe(items);

  assert.equal(probed.length, 2 + EDITOR_INSTRUCTION_FILES.length);
  assert.equal(probed[1]?.separator, true, 'items[1] is the separator');
  assert.deepEqual(labelsOf(items.slice(2)), [...EDITOR_INSTRUCTION_FILES]);
  // The whole order at once, so neither a missing separator nor the explorer
  // appended at the bottom can satisfy this by accident.
  assert.deepEqual(labelsOf(items), ['파일 탐색기', undefined, 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md']);
});

test('FR-FEX-010 AC-3 the instruction file items keep their open/revive decisions when the explorer is present', () => {
  const revived = resolveEditorFilePath(CWD, 'CLAUDE.md');
  const { items, explorerCalls, selections } = buildWithExplorer({
    openWindows: [{ tabId: 'tab-1', filePath: revived }],
  });

  // Still a plain array the existing ContextMenu renders.
  assert.ok(Array.isArray(items));
  assert.equal(labelsOf(items)[0], '파일 탐색기');

  choose(items, 'CLAUDE.md');
  choose(items, 'CLAUDE.local.md');
  choose(items, 'AGENTS.md');

  assert.deepEqual(selections, [
    { kind: 'revive', filePath: revived, tabId: 'tab-1' },
    { kind: 'open', filePath: resolveEditorFilePath(CWD, 'CLAUDE.local.md'), tabId: 'tab-7' },
    { kind: 'open', filePath: resolveEditorFilePath(CWD, 'AGENTS.md'), tabId: 'tab-7' },
  ]);
  assert.deepEqual(explorerCalls, [], 'choosing a file does not open the explorer');

  // Without the option the menu is the three files and nothing else, which is
  // what every caller that has not been wired yet still sees.
  const withoutExplorer = buildEditorFileMenuItems({
    cwd: CWD,
    tabId: 'tab-7',
    openWindows: [],
    onSelect: () => undefined,
  });
  assert.deepEqual(labelsOf(withoutExplorer), [...EDITOR_INSTRUCTION_FILES]);
});
