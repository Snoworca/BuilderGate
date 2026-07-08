import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWorkspaceMoveTargets } from '../../src/components/Workspace/workspaceMoveTargets.ts';
import type { Workspace, WorkspaceTabRuntime } from '../../src/types/workspace.ts';

const workspaces: Workspace[] = [
  workspace('ws-2', 'Target Full', 1),
  workspace('ws-1', 'Current', 0),
  workspace('ws-3', 'Target Open', 2),
];

const tabs: WorkspaceTabRuntime[] = [
  tab('tab-1', 'ws-1'),
  tab('tab-2', 'ws-2'),
  tab('tab-3', 'ws-2'),
];

test('buildWorkspaceMoveTargets sorts workspaces and disables current and full targets', () => {
  const targets = buildWorkspaceMoveTargets({
    workspaces,
    tabs,
    sourceWorkspaceId: 'ws-1',
    maxTabsPerWorkspace: 2,
  });

  assert.deepEqual(targets.map(target => target.workspace.id), ['ws-1', 'ws-2', 'ws-3']);
  assert.deepEqual(targets.map(target => target.disabled), [true, true, false]);
  assert.equal(targets[0].reason, 'current');
  assert.equal(targets[1].reason, 'full');
  assert.equal(targets[2].tabCount, 0);
});

function workspace(id: string, name: string, sortOrder: number): Workspace {
  return {
    id,
    name,
    sortOrder,
    viewMode: 'tab',
    activeTabId: null,
    colorCounter: 0,
    createdAt: '2026-07-08T00:00:00.000Z',
    updatedAt: '2026-07-08T00:00:00.000Z',
  };
}

function tab(id: string, workspaceId: string): WorkspaceTabRuntime {
  return {
    id,
    workspaceId,
    sessionId: `session-${id}`,
    name: id,
    colorIndex: 0,
    sortOrder: 0,
    shellType: 'bash',
    createdAt: '2026-07-08T00:00:00.000Z',
    status: 'idle',
    cwd: '',
  };
}
