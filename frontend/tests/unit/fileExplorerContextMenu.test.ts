import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as ContextMenuModule from '../../src/components/fileExplorer/fileExplorerContextMenu.ts';

// FR-FEX-006 AC-1~AC-8 / FR-FEX-005 AC-8 / FR-FEX-011 AC-7 -- the explorer's
// context menu and the mobile button row, as pure builders.
//
// The menu is one ordered constant (FILE_EXPLORER_MENU_ORDER) that every surface
// filters; nothing copies the list per surface. Openability arrives only as the
// `openable` input -- this module never judges extensions itself (the source
// guard in fileRowInteraction.test.ts enforces that). Only the 'explorer-window'
// context is exercised here: the editor side panel's menu is FR-MDE-012's.
//
// The module is loaded inside each test: a static import of a missing module
// kills the runner before any test is named, so a red run would show one crash
// instead of which contracts are unmet. The `import type` line is erased at
// runtime and lets tsc check every call against the real signatures.
const MENU_PATH = '../../src/components/fileExplorer/fileExplorerContextMenu.ts';
type M = typeof ContextMenuModule;
type MenuInfo = Parameters<M['buildFileExplorerContextMenuItems']>[0];
type MenuHandlers = Parameters<M['buildFileExplorerContextMenuItems']>[1];

async function load(): Promise<M> {
  return await import(MENU_PATH) as M;
}

// The labels are the contract the user reads (design 7), so the test keeps its
// own copy and maps them back to ids; a label the table does not know fails.
const LABEL_TO_ID: Record<string, string> = {
  '편집기로 열기': 'open',
  '새 탭에서 열기': 'newtab',
  '복사': 'copy',
  '잘라내기': 'cut',
  '붙여넣기': 'paste',
  '이름 바꾸기': 'rename',
  '삭제': 'delete',
  '새 폴더': 'newdir',
  '새로 읽기': 'refresh',
};
const ID_TO_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(LABEL_TO_ID).map(([label, id]) => [id, label]),
);

// `ContextMenuItem` is a union of an action and a separator. Fields are read
// only after checking they are there -- a blind cast would keep passing if the
// builder began answering with shapes the renderer does not understand.
interface ItemProbe {
  label?: unknown;
  onClick?: unknown;
  disabled?: unknown;
  shortcut?: unknown;
  separator?: unknown;
}

function probe(items: readonly unknown[]): ItemProbe[] {
  return items.map((item) => {
    assert.equal(typeof item, 'object', 'every menu item is an object');
    assert.notEqual(item, null);
    return item as ItemProbe;
  });
}

function isSeparator(item: ItemProbe): boolean {
  return item.separator === true;
}

function labelsOf(items: readonly unknown[]): unknown[] {
  return probe(items).filter(item => !isSeparator(item)).map(item => item.label);
}

function idsOf(items: readonly unknown[]): string[] {
  return probe(items).map((item) => {
    if (isSeparator(item)) return 'sep';
    assert.equal(typeof item.label, 'string', 'an action item carries a label');
    const id = LABEL_TO_ID[item.label as string];
    assert.notEqual(id, undefined, `unknown menu label ${String(item.label)}`);
    return id;
  });
}

function itemById(items: readonly unknown[], id: string): ItemProbe {
  const found = probe(items).find(item => !isSeparator(item) && item.label === ID_TO_LABEL[id]);
  assert.notEqual(found, undefined, `the menu offers ${id}`);
  return found as ItemProbe;
}

function isEnabled(items: readonly unknown[], id: string): boolean {
  return itemById(items, id).disabled !== true;
}

function recordingHandlers(calls: string[]): MenuHandlers {
  return {
    open: () => calls.push('open'),
    newtab: () => calls.push('newtab'),
    copy: () => calls.push('copy'),
    cut: () => calls.push('cut'),
    paste: () => calls.push('paste'),
    rename: () => calls.push('rename'),
    delete: () => calls.push('delete'),
    newdir: () => calls.push('newdir'),
    refresh: () => calls.push('refresh'),
  };
}

function itemInfo(overrides: Partial<MenuInfo> = {}): MenuInfo {
  return {
    target: 'item',
    isDir: false,
    openable: true,
    count: 1,
    clipboardEmpty: false,
    mode: 'tree',
    context: 'explorer-window',
    ...overrides,
  };
}

const FULL_ORDER = ['open', 'newtab', 'sep', 'copy', 'cut', 'paste', 'sep', 'rename', 'delete', 'sep', 'newdir', 'refresh'];

// ---------------------------------------------------------------------------
// Right click and selection (FR-FEX-006 AC-1·AC-2·AC-3)
// ---------------------------------------------------------------------------

test('decideContextMenuSelection: 선택 안 된 항목 → 그 항목 하나', async () => {
  const { decideContextMenuSelection } = await load();
  const selected = new Set(['/r/a.txt', '/r/b.txt']);
  const decision = decideContextMenuSelection(selected, '/r/c.txt');

  assert.deepEqual(decision.selectedPaths, new Set(['/r/c.txt']));
  assert.deepEqual([...decision.targets], ['/r/c.txt']);
  // The caller's selection is not mutated; the new one is a fresh value.
  assert.deepEqual(selected, new Set(['/r/a.txt', '/r/b.txt']));

  // From an empty selection too -- not only when replacing another.
  const fromEmpty = decideContextMenuSelection(new Set(), '/r/a.txt');
  assert.deepEqual(fromEmpty.selectedPaths, new Set(['/r/a.txt']));
  assert.deepEqual([...fromEmpty.targets], ['/r/a.txt']);
});

test('이미 선택된 항목 → 선택 그대로(deep-equal), 조작 대상은 선택 전체', async () => {
  const { decideContextMenuSelection } = await load();
  const selected = new Set(['/r/a.txt', '/r/b.txt', '/r/src']);
  const decision = decideContextMenuSelection(selected, '/r/b.txt');

  // Collapsing to the clicked item here is exactly the regression design 7 names:
  // multi-select then right click would lose every other item.
  assert.deepEqual(decision.selectedPaths, new Set(['/r/a.txt', '/r/b.txt', '/r/src']));
  assert.deepEqual([...decision.targets].sort(), ['/r/a.txt', '/r/b.txt', '/r/src']);
  assert.deepEqual(selected, new Set(['/r/a.txt', '/r/b.txt', '/r/src']));
});

test("빈 곳 → 선택 해제, 메뉴 label 이 정확히 ['붙여넣기','새 폴더','새로 읽기']", async () => {
  const { decideContextMenuSelection, buildFileExplorerContextMenuItems } = await load();
  const decision = decideContextMenuSelection(new Set(['/r/a.txt', '/r/b.txt']), null);
  assert.deepEqual(decision.selectedPaths, new Set());
  assert.deepEqual([...decision.targets], []);

  const calls: string[] = [];
  for (const mode of ['tree', 'list'] as const) {
    const items = buildFileExplorerContextMenuItems(
      itemInfo({ target: 'empty', isDir: true, openable: false, count: 0, mode }),
      recordingHandlers(calls),
    );
    assert.deepEqual(labelsOf(items), ['붙여넣기', '새 폴더', '새로 읽기'], `empty-space menu in ${mode}`);
    // Filtering must not leave separators at the edges or doubled.
    const ids = idsOf(items);
    assert.notEqual(ids[0], 'sep');
    assert.notEqual(ids[ids.length - 1], 'sep');
    assert.ok(!ids.some((id, i) => id === 'sep' && ids[i + 1] === 'sep'), `no doubled separator: ${ids.join(',')}`);
  }
});

// ---------------------------------------------------------------------------
// Enablement (FR-FEX-006 AC-4·AC-5·AC-6 / FR-FEX-011 AC-7)
// ---------------------------------------------------------------------------

test("'편집기로 열기' 는 열 수 있는 파일만, '새 탭에서 열기' 는 explorer-window 의 디렉터리만 활성", async () => {
  const { buildFileExplorerContextMenuItems } = await load();
  const calls: string[] = [];
  const build = (info: Partial<MenuInfo>) => buildFileExplorerContextMenuItems(itemInfo(info), recordingHandlers(calls));

  const openableFile = build({ isDir: false, openable: true });
  assert.equal(isEnabled(openableFile, 'open'), true);
  assert.equal(isEnabled(openableFile, 'newtab'), false);

  const binaryFile = build({ isDir: false, openable: false });
  assert.equal(isEnabled(binaryFile, 'open'), false);
  assert.equal(isEnabled(binaryFile, 'newtab'), false);

  // A directory is never "opened in the editor", whatever `openable` says.
  const dir = build({ isDir: true, openable: true });
  assert.equal(isEnabled(dir, 'open'), false);
  assert.equal(isEnabled(dir, 'newtab'), true);

  // Choosing an enabled item runs its own handler, once.
  const clicked = itemById(dir, 'newtab');
  assert.equal(typeof clicked.onClick, 'function');
  (clicked.onClick as () => void)();
  assert.deepEqual(calls, ['newtab']);
});

test("'붙여넣기' disabled === 클립보드 비어 있음", async () => {
  const { buildFileExplorerContextMenuItems } = await load();
  for (const target of ['item', 'empty'] as const) {
    for (const clipboardEmpty of [true, false]) {
      const items = buildFileExplorerContextMenuItems(
        itemInfo({ target, clipboardEmpty, isDir: true, count: target === 'item' ? 1 : 0 }),
        recordingHandlers([]),
      );
      assert.equal(itemById(items, 'paste').disabled === true, clipboardEmpty, `${target} clipboardEmpty=${clipboardEmpty}`);
    }
  }
});

test("'이름 바꾸기' 는 선택 1개일 때만 활성 (0·1·2)", async () => {
  const { buildFileExplorerContextMenuItems } = await load();
  const expected = new Map([[0, false], [1, true], [2, false]]);
  for (const [count, enabled] of expected) {
    const items = buildFileExplorerContextMenuItems(itemInfo({ count }), recordingHandlers([]));
    assert.equal(isEnabled(items, 'rename'), enabled, `count=${count}`);
  }
});

test('열 수 없는 파일 선택에서도 복사·잘라내기·삭제가 활성', async () => {
  const { buildFileExplorerContextMenuItems } = await load();
  for (const count of [1, 2]) {
    const calls: string[] = [];
    const items = buildFileExplorerContextMenuItems(
      itemInfo({ isDir: false, openable: false, count }),
      recordingHandlers(calls),
    );
    // Openability blocks opening only (FR-FEX-011 AC-7).
    assert.equal(isEnabled(items, 'open'), false, `count=${count}`);
    for (const id of ['copy', 'cut', 'delete']) {
      assert.equal(isEnabled(items, id), true, `${id} count=${count}`);
      (itemById(items, id).onClick as () => void)();
    }
    assert.deepEqual(calls, ['copy', 'cut', 'delete']);
  }
});

// ---------------------------------------------------------------------------
// Order and shortcuts (FR-FEX-006 AC-7·AC-8)
// ---------------------------------------------------------------------------

test("항목 id 순서가 FILE_EXPLORER_MENU_ORDER 이고 복사·잘라내기·붙여넣기·삭제·이름 바꾸기의 shortcut 이 'Ctrl+C'·'Ctrl+X'·'Ctrl+V'·'Delete'·'F2' (DR-17)", async () => {
  const { FILE_EXPLORER_MENU_ORDER, buildFileExplorerContextMenuItems } = await load();
  assert.deepEqual([...FILE_EXPLORER_MENU_ORDER], FULL_ORDER);

  for (const isDir of [false, true]) {
    const items = buildFileExplorerContextMenuItems(itemInfo({ isDir }), recordingHandlers([]));
    assert.deepEqual(idsOf(items), FULL_ORDER, `tree item menu isDir=${isDir}`);

    const shortcuts = { copy: 'Ctrl+C', cut: 'Ctrl+X', paste: 'Ctrl+V', delete: 'Delete', rename: 'F2' };
    for (const [id, shortcut] of Object.entries(shortcuts)) {
      assert.equal(itemById(items, id).shortcut, shortcut, `${id} shortcut`);
    }
  }
});

test("mode 'list' 에서 '새 탭에서 열기' 만 빠지고 나머지 id 순서는 트리와 같다", async () => {
  const { buildFileExplorerContextMenuItems } = await load();
  for (const isDir of [false, true]) {
    const tree = idsOf(buildFileExplorerContextMenuItems(itemInfo({ isDir, mode: 'tree' }), recordingHandlers([])));
    const list = idsOf(buildFileExplorerContextMenuItems(itemInfo({ isDir, mode: 'list' }), recordingHandlers([])));
    assert.deepEqual(list, tree.filter(id => id !== 'newtab'), `isDir=${isDir}`);
    assert.deepEqual(list, ['open', 'sep', 'copy', 'cut', 'paste', 'sep', 'rename', 'delete', 'sep', 'newdir', 'refresh']);
  }
});

// ---------------------------------------------------------------------------
// Mobile button row (FR-FEX-005 AC-8)
// ---------------------------------------------------------------------------

test('buildMobileActionButtons: 여섯 버튼 순서와 disabled 가 메뉴와 같은 술어(붙여넣기=클립보드, 이름 바꾸기=선택 1개)를 쓴다', async () => {
  const { buildMobileActionButtons, buildFileExplorerContextMenuItems } = await load();

  for (const clipboardEmpty of [true, false]) {
    for (const count of [0, 1, 2]) {
      const calls: string[] = [];
      const buttons = buildMobileActionButtons({ count, clipboardEmpty }, recordingHandlers(calls));
      assert.deepEqual(
        buttons.map(button => button.id),
        ['copy', 'cut', 'paste', 'delete', 'rename', 'newdir'],
      );
      assert.deepEqual(buttons.map(button => button.label), ['복사', '잘라내기', '붙여넣기', '삭제', '이름 바꾸기', '새 폴더']);

      const byId = new Map(buttons.map(button => [button.id, button]));
      const label = `clipboardEmpty=${clipboardEmpty} count=${count}`;

      // The same predicate as the menu, compared against the menu itself.
      const menu = buildFileExplorerContextMenuItems(
        itemInfo({ clipboardEmpty, count, isDir: true }),
        recordingHandlers([]),
      );
      assert.equal(byId.get('paste')?.disabled === true, itemById(menu, 'paste').disabled === true, `paste ${label}`);
      assert.equal(byId.get('rename')?.disabled === true, itemById(menu, 'rename').disabled === true, `rename ${label}`);
      assert.equal(byId.get('paste')?.disabled === true, clipboardEmpty, `paste ${label}`);
      assert.equal(byId.get('rename')?.disabled === true, count !== 1, `rename ${label}`);

      // Nothing selected: nothing to copy, cut or delete. A new folder always has a place to go.
      for (const id of ['copy', 'cut', 'delete']) {
        assert.equal(byId.get(id)?.disabled === true, count === 0, `${id} ${label}`);
      }
      assert.equal(byId.get('newdir')?.disabled === true, false, `newdir ${label}`);

      // Each button runs its own handler.
      byId.get('newdir')?.onClick();
      assert.deepEqual(calls, ['newdir']);
    }
  }
});
