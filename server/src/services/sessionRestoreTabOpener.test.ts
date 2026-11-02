// FR-AITUI-022: a tab that session restore opens is announced to every browser at once.
// 2026-11-02 user report: restore said it was done but no tab appeared until a reload, so the
// user restored again and the same tabs opened twice. The restore path called
// WorkspaceService.addTab directly and, unlike the REST route, the loop runtime and the MCP
// control, never broadcast tab:added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRestoreTabOpener, type RestoreTabOpenerDeps } from './sessionRestoreTabOpener.js';

function setup(overrides: Partial<RestoreTabOpenerDeps> = {}) {
  const events: Array<[string, object]> = [];
  const opened: Array<[string, string, string | undefined]> = [];
  const deps: RestoreTabOpenerDeps = {
    listWorkspaces: () => [{ id: 'ws-b', sortOrder: 1 }, { id: 'ws-a', sortOrder: 0 }],
    addTab: async (workspaceId, name, cwd) => {
      opened.push([workspaceId, name, cwd]);
      return { id: `tab-${opened.length}`, workspaceId, name };
    },
    broadcast: (event, data) => { events.push([event, data]); },
    ...overrides,
  };
  return { open: createRestoreTabOpener(deps), events, opened };
}

test('FR-AITUI-022 AC-1: a tab opened for restore is broadcast as tab:added with the tab', async () => {
  const { open, events, opened } = setup();
  const tabId = await open('ws-b', 'claude', '/work', null);
  assert.equal(tabId, 'tab-1');
  assert.deepEqual(opened, [['ws-b', 'claude', '/work']]);
  assert.deepEqual(events, [['tab:added', { id: 'tab-1', workspaceId: 'ws-b', name: 'claude' }]]);
});

test('FR-AITUI-022 AC-1: the saved workspace, then the fallback, then the first workspace', async () => {
  const gone = setup();
  await gone.open('ws-gone', 'a', undefined, 'ws-b');
  assert.equal(gone.opened[0][0], 'ws-b');
  const neither = setup();
  await neither.open('ws-gone', 'a', null, 'ws-also-gone');
  assert.equal(neither.opened[0][0], 'ws-a', 'the workspace with the lowest sort order');
  assert.equal(neither.opened[0][2], undefined, 'a missing folder is passed as undefined');
});

test('FR-AITUI-022 AC-3: no workspace or a failed open sends nothing', async () => {
  const none = setup({ listWorkspaces: () => [] });
  assert.equal(await none.open('ws-a', 'a', null, null), null);
  assert.deepEqual(none.events, []);
  const failing = setup({ addTab: async () => { throw new Error('tab limit'); } });
  await assert.rejects(() => failing.open('ws-a', 'a', null, null), /tab limit/);
  assert.deepEqual(failing.events, []);
});
