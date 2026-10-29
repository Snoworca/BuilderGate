import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SessionSnapshotService, type SnapshotTabRecord } from './SessionSnapshotService.js';

// FR-LOOP-004 AC-7: the tabs loops open in @schedule-{n} are not saved or restored — the loop
// opens them again on its own schedule.

test('FR-LOOP-004 AC-7: tabs in a workspace the loops own are left out of the session save', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-snapshot-schedule-'));
  try {
    const tabs: SnapshotTabRecord[] = [
      { workspaceId: 'w1', workspaceName: 'pm', tab: { id: 'tUser', name: 'a', sessionId: 'sA', lastCwd: '/work' } },
      { workspaceId: 'sched', workspaceName: '@schedule-0', tab: { id: 'tLoop', name: '시황 #1', sessionId: 'sB', lastCwd: '/work' } },
    ];
    const service = new SessionSnapshotService({
      dataPath: path.join(dir, 'data', 'session-snapshot.json'),
      listTabs: () => tabs,
      getRuntime: () => ({ foregroundAppId: null, ptyPid: null, cwd: '/work' }),
      scheduleResume: () => true,
      skipWorkspace: (workspaceId) => workspaceId === 'sched',
      listProcesses: async () => [],
      now: () => new Date('2026-10-30T00:00:00.000Z'),
    });
    await service.initialize();
    const { tabs: rows } = await service.preview();
    assert.deepEqual(rows.map((row) => row.tabId), ['tUser']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
