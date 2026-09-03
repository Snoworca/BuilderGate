/**
 * REL-BGSTAB-020 — Workspace store flush serializes across immediate, debounced
 * and shutdown paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from './WorkspaceService.js';

function stubSessionManager(): any {
  return {
    onCwdChange() {},
    onTerminalTitleChange() {},
    onSessionFinalized() {},
    hasSession() { return true; },
  };
}

function makeTab(index: number) {
  return {
    id: `t${index}`,
    workspaceId: 'w1',
    sessionId: `s${index}`,
    name: `T${index}`,
    lastCwd: 'C:/work'.padEnd(400, 'x'),
  };
}

/**
 * A store large enough that a single write does not finish inside one
 * thread-pool tick, which AC-1 requires: an empty store lets two concurrent
 * writes complete before either rename and hides the defect.
 */
async function makeService(tabCount: number): Promise<{ service: WorkspaceService; dataFile: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-flush-'));
  const dataFile = path.join(dir, 'workspaces.json');
  const service = new WorkspaceService(stubSessionManager(), {});
  (service as any).dataFilePath = dataFile;
  (service as any).state = {
    workspaces: [{
      id: 'w1', name: 'W1', sortOrder: 0, viewMode: 'tab',
      activeTabId: null, colorCounter: 0, createdAt: '', updatedAt: '',
    }],
    tabs: Array.from({ length: tabCount }, (_, i) => makeTab(i)),
    gridLayouts: [],
  };
  // The private overrides above must be in effect, or every assertion below is vacuous.
  assert.equal(service.getDataFilePath(), dataFile);
  assert.equal(typeof (service as any).flushToDisk, 'function');
  assert.equal(typeof (service as any).config.flushDebounceMs, 'number');
  assert.equal((service as any).state.tabs.length, tabCount);
  return { service, dataFile };
}

async function readStore(dataFile: string): Promise<any> {
  return JSON.parse(await fs.readFile(dataFile, 'utf-8'));
}

// AC-1
test('concurrent immediate flushes all resolve and leave a valid store', async () => {
  for (let round = 0; round < 3; round++) {
    const { service, dataFile } = await makeService(50);

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.save(true)));

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.deepEqual(
      rejected.map(r => `${r.reason.code}: ${r.reason.message}`),
      [],
      'no flush may fail merely because another was in flight',
    );
    assert.equal((await readStore(dataFile)).state.tabs.length, 50);
    assert.equal(
      await fs.access(dataFile + '.tmp').then(() => true, () => false),
      false,
      'no temp file may remain beside the store',
    );
  }
});

// AC-2
test('an immediate flush behind an in-flight debounced flush resolves', async () => {
  for (let round = 0; round < 5; round++) {
    const { service, dataFile } = await makeService(200);
    (service as any).config.flushDebounceMs = 0;

    void service.save();
    await new Promise(resolve => setTimeout(resolve, 0)); // the debounced flush is now doing disk I/O

    await service.save(true);

    assert.equal((await readStore(dataFile)).state.tabs.length, 200);
  }
});

// AC-2 — the half that a completion reporting success without the caller's change would fail
test('an immediate flush completes only after its own change is on disk', async () => {
  for (let round = 0; round < 5; round++) {
    const { service, dataFile } = await makeService(200);
    (service as any).config.flushDebounceMs = 0;

    void service.save();
    await new Promise(resolve => setTimeout(resolve, 0)); // in-flight flush has already snapshotted

    // Changed after that snapshot, so only a write starting from here can carry it.
    (service as any).state.tabs.push({ ...makeTab(999), name: 'MARKER' });

    await service.save(true);

    const names = (await readStore(dataFile)).state.tabs.map((tab: { name: string }) => tab.name);
    assert.ok(
      names.includes('MARKER'),
      'save(true) resolved while the caller\'s own change was absent from the store',
    );
  }
});

// AC-3 — boundary control: without it, swallowing every failure satisfies AC-1 and AC-2
test('a real write failure still propagates to the caller', async () => {
  const { service } = await makeService(1);
  (service as any).dataFilePath = path.join(os.tmpdir(), `ws-flush-absent-${Date.now()}`, 'workspaces.json');

  await assert.rejects(() => service.save(true), /ENOENT/);
});
