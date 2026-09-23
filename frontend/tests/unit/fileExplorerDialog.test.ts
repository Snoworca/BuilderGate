import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as FileExplorerDialogModule from '../../src/components/fileExplorer/fileExplorerDialog.ts';

// FR-FEX-003 AC-1·AC-2 / FR-FEX-010 AC-6 — the one open-or-raise decision every
// entry point (session-path menu, terminal menu, header button) goes through.
//
// The decision is kept pure so it can be judged here without a DOM: the hook
// that owns the window turns a 'raise' into raiseDialogById(id, 'modeless').
// What must never happen is a third outcome -- a toggle that closes the window
// on a second click -- so the tests pin the outcome set, not just one answer.
//
// Loaded inside each test: a static import of a missing module kills the runner
// before any test is named. The `import type` above is erased at runtime and
// exists so tsc checks every call against the real signature once it exists.
const MODULE_PATH = '../../src/components/fileExplorer/fileExplorerDialog.ts';
type M = typeof FileExplorerDialogModule;

async function load(): Promise<M> {
  return await import(MODULE_PATH) as M;
}

test('fileExplorerDialogId(ws) === \'file-explorer:\'+ws, 같은 입력은 같은 id', async () => {
  const { fileExplorerDialogId } = await load();

  // Several workspaces, so a constant return value cannot pass.
  for (const workspaceId of ['ws-1', 'ws-2', 'a1b2c3d4-0000-4000-8000-000000000000']) {
    assert.equal(fileExplorerDialogId(workspaceId), `file-explorer:${workspaceId}`);
    assert.equal(fileExplorerDialogId(workspaceId), fileExplorerDialogId(workspaceId));
  }

  // One window per workspace means two workspaces never share an id.
  assert.notEqual(fileExplorerDialogId('ws-1'), fileExplorerDialogId('ws-2'));
});

test('decideOpenFileExplorer: 등록된 id 면 raise, 없으면 create — close 분기 없음', async () => {
  const { decideOpenFileExplorer } = await load();
  const own = 'file-explorer:ws-1';

  assert.deepEqual(
    decideOpenFileExplorer({ registeredDialogIds: [own], workspaceId: 'ws-1' }),
    { action: 'raise', dialogId: own },
  );
  // Among other dialogs, still found.
  assert.deepEqual(
    decideOpenFileExplorer({
      registeredDialogIds: ['editor-window:ws-1', own, 'mcp-control'],
      workspaceId: 'ws-1',
    }),
    { action: 'raise', dialogId: own },
  );
  assert.deepEqual(
    decideOpenFileExplorer({ registeredDialogIds: [], workspaceId: 'ws-1' }),
    { action: 'create', dialogId: own },
  );

  // Cheap wrong answers that the lists below rule out: "any dialog open →
  // raise", "any id mentioning the workspace → raise", and prefix matching
  // that confuses ws-1 with ws-10.
  for (const registeredDialogIds of [
    ['file-explorer:ws-2'],
    ['editor-window:ws-1'],
    ['file-explorer:ws-10'],
    ['mcp-control', 'editor-window:ws-2'],
  ]) {
    assert.deepEqual(
      decideOpenFileExplorer({ registeredDialogIds, workspaceId: 'ws-1' }),
      { action: 'create', dialogId: own },
      `registered=${JSON.stringify(registeredDialogIds)}`,
    );
  }

  // Asking again while the window is up raises again. A toggle would have to
  // remember the previous answer and flip it to a close here.
  const input = { registeredDialogIds: [own], workspaceId: 'ws-1' };
  const outcomes = new Set<string>();
  for (let i = 0; i < 3; i += 1) {
    outcomes.add(decideOpenFileExplorer(input).action);
  }
  assert.deepEqual([...outcomes], ['raise']);
});

test('decideOpenFileExplorer 가 진입점 종류 인자를 받지 않는다 — 세 진입점이 같은 판정', async () => {
  const { decideOpenFileExplorer } = await load();

  // A second positional parameter would be where an entry-point kind creeps in.
  assert.equal(decideOpenFileExplorer.length, 1);

  const entryPoints = ['session-path-menu', 'terminal-menu', 'header-button'] as const;
  for (const registeredDialogIds of [['file-explorer:ws-1'], []]) {
    const base = { registeredDialogIds, workspaceId: 'ws-1' };
    const expected = decideOpenFileExplorer(base);

    for (const entryPoint of entryPoints) {
      // Passed as a non-literal so tsc's excess-property check does not reject
      // it; the point is that the value, if smuggled in, changes nothing.
      const withEntryPoint = { ...base, entryPoint };
      assert.deepEqual(decideOpenFileExplorer(withEntryPoint), expected, entryPoint);
    }
  }
});
