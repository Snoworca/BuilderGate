import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type * as FileRowInteractionModule from '../../src/components/fileExplorer/fileRowInteraction.ts';
import type { VisibleRow } from '../../src/components/fileExplorer/fileTreeState.ts';
import { isViewableExtension } from '../../src/utils/viewableExtensions.ts';

// CON-FEX-001 AC-3 / FR-FEX-002 AC-5 / FR-FEX-006 AC-2·AC-3 / FR-FEX-011 AC-2~AC-7
// — the pure decisions behind a row: what a click, a double click and a pointer
// press do (design §8.2), which files open (§8.3), and where a right click lands.
//
// Loaded inside each test for the same reason as fileTreeState.test.ts: a static
// import of a missing module crashes the runner before any test is named, so a
// red run would not say which contract is unmet. The `import type` is erased at
// runtime and lets tsc check the calls below once the module exists.
const MODULE_PATH = '../../src/components/fileExplorer/fileRowInteraction.ts';
type M = typeof FileRowInteractionModule;
type NodeRow = Extract<VisibleRow, { kind: 'node' }>;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

const MODES = ['tree', 'list'] as const;

// A list row is the same node shape at depth 0: the list is another view of the
// same state (design §8.1), so one decision function must serve both modes.
function fileRow(path: string): NodeRow {
  return { kind: 'node', path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file', depth: 1 };
}

function dirRow(path: string): NodeRow {
  return { kind: 'node', path, name: path.slice(path.lastIndexOf('/') + 1), type: 'directory', depth: 1 };
}

const UP_ROW: VisibleRow = { kind: 'up' };

function classesOf(className: string): string[] {
  return className.split(/\s+/).filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Double click (FR-FEX-011 AC-2·AC-3·AC-5, FR-FEX-002 AC-5)
// ---------------------------------------------------------------------------

test('decideDoubleClick: 파일 행은 두 모드 모두 open-editor', async () => {
  const { decideDoubleClick } = await load();
  // Uppercase extension on purpose: the openable check must fold case the way
  // isViewableExtension does, or 'README.MD' would silently refuse to open.
  for (const path of ['/r/notes.md', '/r/src/app.ts', '/r/README.MD']) {
    for (const mode of MODES) {
      assert.deepEqual(decideDoubleClick(fileRow(path), mode), { type: 'open-editor', path }, `${mode} ${path}`);
    }
  }
});

test('decideDoubleClick: 디렉터리는 tree=toggle-expand, list=enter', async () => {
  const { decideDoubleClick } = await load();
  const row = dirRow('/r/src');
  assert.deepEqual(decideDoubleClick(row, 'tree'), { type: 'toggle-expand', path: '/r/src' });
  assert.deepEqual(decideDoubleClick(row, 'list'), { type: 'enter', path: '/r/src' });
});

test('열 수 없는 파일은 noop 이고 rowRenderClass 에 \'unopenable\'', async () => {
  const { decideDoubleClick, rowRenderClass } = await load();
  // No extension, a binary extension and a dotfile: the three ways a name falls
  // outside the viewable set.
  for (const path of ['/r/logo.png', '/r/Makefile', '/r/.bashrc']) {
    const row = fileRow(path);
    for (const mode of MODES) {
      assert.equal(decideDoubleClick(row, mode).type, 'noop', `${mode} ${path}`);
    }
    assert.ok(classesOf(rowRenderClass(row, null)).includes('unopenable'), `${path} must render dimmed`);
  }
  // The cheap way to pass the loop above is to dim every row. An openable file
  // and a directory — which has no extension either — must stay undimmed.
  assert.ok(!classesOf(rowRenderClass(fileRow('/r/notes.md'), null)).includes('unopenable'), 'openable file dimmed');
  assert.ok(!classesOf(rowRenderClass(dirRow('/r/assets'), null)).includes('unopenable'), 'directory dimmed');
});

test('목록 모드 디렉터리 더블클릭은 enter(뿌리 변경)이고 펼치지 않는다', async () => {
  const { decideDoubleClick } = await load();
  const row = dirRow('/r/docs');
  const inList = decideDoubleClick(row, 'list');
  assert.deepEqual(inList, { type: 'enter', path: '/r/docs' });
  assert.notEqual(inList.type, 'toggle-expand');
  // Guards against a function that ignores `mode` and always enters: the same
  // row in tree mode must not change the root.
  assert.notEqual(decideDoubleClick(row, 'tree').type, 'enter');
});

// ---------------------------------------------------------------------------
// Openable-file judgement is borrowed, not copied (FR-FEX-011 AC-6·AC-7)
// ---------------------------------------------------------------------------

const FILE_EXPLORER_DIR = new URL('../../src/components/fileExplorer/', import.meta.url);
const VIEWABLE_SOURCE_URL = new URL('../../src/utils/viewableExtensions.ts', import.meta.url);

// Comments are stripped first so that a sentence like "do not import
// viewableExtensions here" cannot trip, or satisfy, a source guard.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function readStripped(url: URL): string {
  return stripComments(readFileSync(url, 'utf8'));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('주석 제거 후 소스: isViewableExtension 을 utils/viewableExtensions.ts 에서 import 하고 확장자 집합을 다시 선언하지 않는다', async () => {
  const mod = await load();
  const source = readStripped(new URL('fileRowInteraction.ts', FILE_EXPLORER_DIR));

  assert.match(
    source,
    /import\s*\{[^}]*\bisViewableExtension\b[^}]*\}\s*from\s*['"](?:\.\.\/)+utils\/viewableExtensions(?:\.ts)?['"]/,
    'fileRowInteraction.ts must import isViewableExtension from utils/viewableExtensions',
  );
  // Importing without calling would leave a private copy doing the real work.
  assert.match(source, /\bisViewableExtension\s*\(/, 'isViewableExtension is imported but never called');

  // Every extension the shared set knows, read from its source rather than
  // listed here, so a copy of the set is caught even after the set grows.
  const extensions = [...readStripped(VIEWABLE_SOURCE_URL).matchAll(/['"](\.[a-z0-9]+)['"]/g)].map((m) => m[1]);
  assert.ok(extensions.length > 10, `expected the viewable set to be readable, got ${extensions.length} entries`);
  const redeclared = extensions.filter((ext) => {
    const bare = ext.slice(1);
    const forms = bare.length >= 2 ? [ext, bare] : [ext];
    return forms.some((form) => new RegExp(`['"\`]${escapeRegExp(form)}['"\`]`).test(source));
  });
  assert.deepEqual(redeclared, [], 'fileRowInteraction.ts redeclares viewable extensions');

  // Behaviour agrees with the shared predicate on names that expose a naive
  // re-implementation: case, no extension, dotfile, double extension.
  for (const name of ['a.md', 'README.MD', 'Makefile', '.bashrc', 'archive.tar.gz', 'x.config.ts', 'logo.png']) {
    assert.equal(mod.isOpenableFile(name), isViewableExtension(name), name);
  }
});

// The copy/move/delete paths. Two of the three are created later in the plan
// (fileExplorerClipboard.ts by T-PH003-02, fileExplorerContextMenu.ts by
// T-PH003-04); this case is expected to stay red until then. A missing file is
// a failure, never a pass: "the file does not reference it" is vacuously true of
// a file that does not exist.
const COPY_MOVE_DELETE_SOURCES = ['fileTreeState.ts', 'fileExplorerClipboard.ts', 'fileExplorerContextMenu.ts'];

// isOpenableFile is listed too: reaching the judgement through fileRowInteraction
// is the same coupling as importing it directly. The context menu learns
// openability only through its `openable` input.
const OPENABILITY_TOKENS = ['viewableExtensions', 'isViewableExtension', 'isOpenableFile'];

test('주석 제거 후 소스: fileTreeState/fileExplorerClipboard/fileExplorerContextMenu 의 복사·이동·삭제 경로가 viewableExtensions 를 참조하지 않는다', () => {
  const missing = COPY_MOVE_DELETE_SOURCES.filter((name) => !existsSync(new URL(name, FILE_EXPLORER_DIR)));
  assert.deepEqual(missing, [], `copy/move/delete sources must exist before they can be checked; missing: ${missing.join(', ')}`);

  for (const name of COPY_MOVE_DELETE_SOURCES) {
    const source = readStripped(new URL(name, FILE_EXPLORER_DIR));
    assert.ok(source.trim().length > 0, `${name} is empty after stripping comments`);
    const hits = OPENABILITY_TOKENS.filter((token) => new RegExp(`\\b${token}\\b`).test(source));
    assert.deepEqual(hits, [], `${name} references the openable-file judgement`);
  }
});

// ---------------------------------------------------------------------------
// '..' is chrome (CON-FEX-001 AC-3) and where a right click lands (FR-FEX-006 AC-3)
// ---------------------------------------------------------------------------

test('isContextMenuEligible 은 up 행 종류에 false', async () => {
  const { isContextMenuEligible } = await load();
  assert.equal(isContextMenuEligible(UP_ROW), false);
  // "Always false" would pass the line above; every real node gets a menu.
  assert.equal(isContextMenuEligible(fileRow('/r/logo.png')), true);
  assert.equal(isContextMenuEligible(dirRow('/r/src')), true);
});

// A stand-in for an Element that answers closest() the way the DOM does: the
// nearest node on the ancestor chain (self first) matching any of the
// comma-separated attribute selectors. Only [data-*] selectors are understood;
// anything else throws so the contract stays "resolve by data attributes"
// (DR-09) instead of silently returning null for a class selector.
interface FakeNode {
  attrs: Record<string, string>;
  parent: FakeNode | null;
}

function node(attrs: Record<string, string>, parent: FakeNode | null): FakeNode {
  return { attrs, parent };
}

function asTarget(start: FakeNode): Parameters<M['resolveContextMenuTarget']>[0] {
  const view = (n: FakeNode) => ({
    getAttribute: (name: string) => (name in n.attrs ? n.attrs[name] : null),
    dataset: Object.fromEntries(
      Object.entries(n.attrs)
        .filter(([k]) => k.startsWith('data-'))
        .map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
    ),
  });
  const target = {
    closest(selector: string) {
      const attrs = selector.split(',').map((part) => {
        const m = /^\s*\[(data-[a-z-]+)\]\s*$/.exec(part);
        if (m === null) throw new Error(`fake closest() understands only [data-*] selectors, got ${JSON.stringify(selector)}`);
        return m[1];
      });
      for (let n: FakeNode | null = start; n !== null; n = n.parent) {
        if (attrs.some((a) => a in n!.attrs)) return view(n);
      }
      return null;
    },
  };
  return target as unknown as Parameters<M['resolveContextMenuTarget']>[0];
}

// Tree markup: surface > tree > up row > label. The label is what the pointer
// actually hits, so resolution must climb, not read the target itself.
function treeMarkup() {
  const surface = node({ 'data-explorer-surface': '' }, null);
  const tree = node({ role: 'tree' }, surface);
  const upRow = node({ 'data-up': '' }, tree);
  const upLabel = node({}, upRow);
  const fileRowNode = node({ 'data-path': '/r/a.txt' }, tree);
  const fileLabel = node({}, fileRowNode);
  return { surface, tree, upLabel, fileRowNode, fileLabel };
}

// List markup: surface > table > tbody > up row (tr) > cell (td).
function listMarkup() {
  const surface = node({ 'data-explorer-surface': '' }, null);
  const table = node({ role: 'grid' }, surface);
  const tbody = node({}, table);
  const upRow = node({ 'data-up': '' }, tbody);
  const upCell = node({}, upRow);
  const dirRowNode = node({ 'data-path': '/r/src' }, tbody);
  const dirCell = node({}, dirRowNode);
  return { tbody, upCell, dirCell };
}

// 'none' means "no menu at all" — the caller still calls preventDefault so the
// browser's own menu does not appear over '..'. That half is the caller's and is
// checked where the handler is wired; here the decision must be 'none', which a
// resolver that only knows [data-path] gets wrong by answering 'empty'.
test('resolveContextMenuTarget: 트리 마크업의 [data-up] 안 대상 → none(메뉴 없음, preventDefault)', async () => {
  const { resolveContextMenuTarget } = await load();
  const { upLabel } = treeMarkup();
  assert.deepEqual(resolveContextMenuTarget(asTarget(upLabel)), { kind: 'none' });
});

test('resolveContextMenuTarget: 목록 마크업의 [data-up] 안 대상 → none', async () => {
  const { resolveContextMenuTarget } = await load();
  const { upCell } = listMarkup();
  assert.deepEqual(resolveContextMenuTarget(asTarget(upCell)), { kind: 'none' });
});

test('resolveContextMenuTarget: [data-path] → item(path), 그 밖 → empty', async () => {
  const { resolveContextMenuTarget } = await load();
  const tree = treeMarkup();
  const list = listMarkup();
  assert.deepEqual(resolveContextMenuTarget(asTarget(tree.fileLabel)), { kind: 'item', path: '/r/a.txt' });
  assert.deepEqual(resolveContextMenuTarget(asTarget(tree.fileRowNode)), { kind: 'item', path: '/r/a.txt' });
  assert.deepEqual(resolveContextMenuTarget(asTarget(list.dirCell)), { kind: 'item', path: '/r/src' });
  // Blank space inside the surface: neither a row nor '..'. A resolver that
  // answers 'none' for everything without a path would hide the directory menu
  // (paste · new folder · refresh) that FR-FEX-006 AC-3 requires here.
  assert.deepEqual(resolveContextMenuTarget(asTarget(tree.tree)), { kind: 'empty' });
  assert.deepEqual(resolveContextMenuTarget(asTarget(list.tbody)), { kind: 'empty' });
});

// ---------------------------------------------------------------------------
// Pointer press and single click (FR-FEX-006 AC-2 / decision 15, FR-FEX-011 AC-4)
// ---------------------------------------------------------------------------

test('decideRowPointer: button !== 0 이면 noop (이미 선택된 행의 우클릭이 선택을 줄이지 않는다), button 0 은 select', async () => {
  const { decideRowPointer } = await load();
  const plain = { ctrlKey: false, metaKey: false, shiftKey: false };
  // Middle, right, back, forward. A right press on a row that is part of a
  // multi-selection must not collapse the selection to that row (decision 15);
  // the context-menu path decides selection instead.
  for (const button of [1, 2, 3, 4]) {
    for (const isSelected of [true, false]) {
      assert.deepEqual(decideRowPointer({ button, ...plain, isSelected }), { type: 'noop' }, `button ${button} selected=${isSelected}`);
    }
  }
  assert.deepEqual(decideRowPointer({ button: 0, ...plain, isSelected: false }), { type: 'select', mods: { ctrl: false, shift: false } });
  assert.deepEqual(decideRowPointer({ button: 0, ...plain, isSelected: true }), { type: 'select', mods: { ctrl: false, shift: false } });
  // Modifiers must reach the reducer, or Ctrl/Shift selection is lost; Cmd on
  // macOS plays the Ctrl role.
  assert.deepEqual(decideRowPointer({ button: 0, ctrlKey: true, metaKey: false, shiftKey: false, isSelected: false }), { type: 'select', mods: { ctrl: true, shift: false } });
  assert.deepEqual(decideRowPointer({ button: 0, ctrlKey: false, metaKey: true, shiftKey: false, isSelected: false }), { type: 'select', mods: { ctrl: true, shift: false } });
  assert.deepEqual(decideRowPointer({ button: 0, ctrlKey: false, metaKey: false, shiftKey: true, isSelected: true }), { type: 'select', mods: { ctrl: false, shift: true } });
});

test('decideRowClick: targetPart \'expander\' → toggle-expand 만(선택 변경 없음), \'row\' → select', async () => {
  const { decideRowClick } = await load();
  // With Ctrl held on purpose: the expander must not turn into "add to
  // selection" just because a modifier is down. deepEqual also rejects a result
  // that toggles AND carries selection fields.
  for (const mods of [{ ctrl: false, shift: false }, { ctrl: true, shift: false }, { ctrl: false, shift: true }]) {
    assert.deepEqual(decideRowClick({ targetPart: 'expander', mode: 'tree', isDir: true, mods }), { type: 'toggle-expand' }, JSON.stringify(mods));
  }
  // A single click on the row body selects and never expands (design §8.2) —
  // for a directory as much as for a file.
  assert.deepEqual(decideRowClick({ targetPart: 'row', mode: 'tree', isDir: true, mods: { ctrl: false, shift: false } }), { type: 'select', mods: { ctrl: false, shift: false } });
  assert.deepEqual(decideRowClick({ targetPart: 'row', mode: 'tree', isDir: false, mods: { ctrl: true, shift: false } }), { type: 'select', mods: { ctrl: true, shift: false } });
  assert.deepEqual(decideRowClick({ targetPart: 'row', mode: 'list', isDir: true, mods: { ctrl: false, shift: true } }), { type: 'select', mods: { ctrl: false, shift: true } });
});
