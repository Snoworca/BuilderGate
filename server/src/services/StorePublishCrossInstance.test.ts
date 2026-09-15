/**
 * REL-BGSTAB-022 — Store publication must not collide between processes
 * sharing one checkout. GitHub issue #24.
 *
 * REL-BGSTAB-020 already serializes flushToDisk inside one process. That
 * mechanism is a promise chain, which is per-process state, so this suite
 * deliberately drives TWO independently constructed service instances bound to
 * one data file: separate in-memory state and separate mutation chains over one
 * filesystem. That is what a second dev instance in the same checkout is.
 *
 * The peer is interposed deterministically rather than raced. A racing fixture
 * cannot distinguish a publish that moved a peer's bytes from a peer that
 * published afterwards, and it reproduces the torn case only some of the time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandPresetService } from './CommandPresetService.js';

/**
 * fs/promises is a module namespace object, so the services reach these
 * functions by property lookup at call time and a fixture can swap them. Every
 * swap is installed and removed through this helper so a failing assertion
 * cannot leak a patched builtin into a sibling test in this file.
 */
async function withPatchedFs<T>(
  patches: Partial<Record<'writeFile' | 'copyFile' | 'rename' | 'unlink', unknown>>,
  body: () => Promise<T>,
): Promise<T> {
  const target = fs as unknown as Record<string, unknown>;
  const original: Record<string, unknown> = {};
  for (const key of Object.keys(patches)) {
    original[key] = target[key];
    target[key] = patches[key as keyof typeof patches];
  }
  try {
    return await body();
  } finally {
    for (const key of Object.keys(original)) {
      target[key] = original[key];
    }
  }
}

async function makeStore(tag: string): Promise<{ dir: string; dataFile: string; make: () => CommandPresetService }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bgstab022-${tag}-`));
  const dataFile = path.join(dir, 'command-presets.json');
  const make = (): CommandPresetService => {
    const service = new CommandPresetService({ dataPath: dataFile });
    // The override must be in effect, or every assertion below is vacuous.
    assert.equal(service.getDataFilePath(), dataFile);
    return service;
  };
  return { dir, dataFile, make };
}

/** Puts `count` presets into a service without touching the disk. */
function seed(service: CommandPresetService, label: string, count: number): void {
  const now = new Date().toISOString();
  (service as unknown as { presets: unknown[] }).presets = Array.from({ length: count }, (_, i) => ({
    id: `${label}-${i}`,
    kind: 'command',
    label: `${label}-${i}`,
    value: `${label}`.repeat(200),
    sortOrder: i,
    createdAt: now,
    updatedAt: now,
  }));
}

const flush = (service: CommandPresetService): Promise<void> =>
  (service as unknown as { flushToDisk: () => Promise<void> }).flushToDisk();

const readJson = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, 'utf-8'));

/** The temp path every unfixed writer in this codebase derives from its destination. */
const sharedTempOf = (dataFile: string): string => `${dataFile}.tmp`;

// ---------------------------------------------------------------------------
// AC-1 — neither publish fails because the other moved the temp file away.
// ---------------------------------------------------------------------------
test('REL-BGSTAB-022 AC-1: two instances publishing concurrently both resolve', async () => {
  const { dataFile, make } = await makeStore('ac1');
  const mine = make();
  const peer = make();
  seed(mine, 'mine', 40);
  seed(peer, 'peer', 40);

  const realWriteFile = fs.writeFile.bind(fs);
  let interposed = false;

  // The peer publishes in full between this publish's write and its rename.
  // Against a shared temp path that consumes the source this publish is about
  // to rename.
  const result = await withPatchedFs({
    writeFile: async (file: unknown, data: unknown, options: unknown) => {
      await realWriteFile(file as string, data as string, options as never);
      if (!interposed && String(file).endsWith('.tmp')) {
        interposed = true;
        await peer.getAll();
        await flush(peer);
      }
    },
  }, async () => flush(mine).then(() => 'resolved' as const, (error: Error) => error));

  assert.ok(interposed, 'the fixture never interposed the peer publish');
  assert.equal(
    result,
    'resolved',
    `this publish rejected because the peer consumed the temp file it was going to rename: ${String(result)}`,
  );
  await readJson(dataFile);
});

// ---------------------------------------------------------------------------
// AC-2 — a resolved publish holds the document that publish wrote.
// ---------------------------------------------------------------------------
test('REL-BGSTAB-022 AC-2: a resolved publish holds the document it wrote', async () => {
  const { dataFile, make } = await makeStore('ac2');
  const mine = make();
  seed(mine, 'mine', 40);

  const realWriteFile = fs.writeFile.bind(fs);
  const peerDocument = JSON.stringify({ version: 1, lastUpdated: 'peer', presets: [] }, null, 2);
  let interposed = false;

  await withPatchedFs({
    writeFile: async (file: unknown, data: unknown, options: unknown) => {
      await realWriteFile(file as string, data as string, options as never);
      if (!interposed && String(file).endsWith('.tmp')) {
        interposed = true;
        // A peer overwrites the same temp path in full before this publish
        // renames it.
        await realWriteFile(sharedTempOf(dataFile), peerDocument, { encoding: 'utf-8', mode: 0o600 });
      }
    },
  }, async () => flush(mine));

  assert.ok(interposed, 'the fixture never interposed the peer write');
  const published = await readJson(dataFile) as { lastUpdated: string; presets: unknown[] };
  assert.notEqual(
    published.lastUpdated,
    'peer',
    'this publish resolved having moved the peer\'s document into place; its own change was lost and its caller was told the write succeeded',
  );
  assert.equal(published.presets.length, 40);
});

// ---------------------------------------------------------------------------
// AC-3 — a shorter peer overlay leaves no foreign tail.
//
// fs.writeFile opens with O_TRUNC, so a peer calling writeFile would simply
// replace the document and the result would parse whole. The corruption
// measured on 2026-09-16 comes from the truncate and the write being separated
// in time across two processes: one truncates and writes 60 KB, the other then
// writes its shorter document from offset zero into the now-longer file and
// leaves a foreign tail behind it. This fixture reproduces that shape exactly.
// ---------------------------------------------------------------------------
test('REL-BGSTAB-022 AC-3: a shorter peer overlay leaves no foreign tail', async () => {
  const { dataFile, make } = await makeStore('ac3');
  const mine = make();
  seed(mine, 'mine', 2);

  const realWriteFile = fs.writeFile.bind(fs);
  const realOpen = fs.open.bind(fs);
  const peerDocument = JSON.stringify(
    { version: 1, lastUpdated: 'peer', presets: [{ pad: 'P'.repeat(60000) }] },
    null,
    2,
  );
  let interposed = false;

  // The peer writes to the path a peer can actually reach: the one derived from
  // the destination, which is the only name a second process can know without
  // being told. If this publish uses that same path, the peer's long document
  // and this publish's short one end up in one file.
  const peerReachablePath = sharedTempOf(dataFile);

  await withPatchedFs({
    writeFile: async (file: unknown, data: unknown, options: unknown) => {
      if (!interposed && String(file).endsWith('.tmp')) {
        interposed = true;
        // This publish opened its temp file and truncated it...
        const truncate = await realOpen(file as string, 'w');
        await truncate.close();
        // ...the peer then truncated the path *it* can reach and wrote its long
        // document there...
        await realWriteFile(peerReachablePath, peerDocument, { encoding: 'utf-8', mode: 0o600 });
        // ...and this publish's own write lands from offset zero, without
        // truncating, into whatever that file now is.
        const handle = await realOpen(file as string, 'r+');
        try {
          await handle.write(String(data), 0, 'utf-8');
        } finally {
          await handle.close();
        }
        return;
      }
      await realWriteFile(file as string, data as string, options as never);
    },
  }, async () => flush(mine));

  assert.ok(interposed, 'the fixture never interposed the peer overlay');
  assert.notEqual(
    await fs.readFile(peerReachablePath, 'utf-8').catch(() => null),
    null,
    'the peer write did not happen, so this assertion would pass vacuously',
  );
  const raw = await fs.readFile(dataFile, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    assert.fail(
      `the publish moved a partially written document into place (${raw.length} bytes, ends ${JSON.stringify(raw.slice(-24))}): ${(error as Error).message}`,
    );
  }
  assert.equal((parsed as { lastUpdated: string }).lastUpdated !== 'peer', true);
  assert.equal((parsed as { presets: unknown[] }).presets.length, 2);
});

// ---------------------------------------------------------------------------
// AC-4 — failure cleanup removes only the caller's own temp file.
// ---------------------------------------------------------------------------
test('REL-BGSTAB-022 AC-4: failure cleanup removes only the caller\'s own temp file', async () => {
  const { dataFile, make } = await makeStore('ac4');
  const mine = make();
  seed(mine, 'mine', 10);

  // A peer process running this same build has a publish in flight. Against a
  // fixed temp path that file is at exactly the path this publish will use, so
  // this publish's failure cleanup deletes it.
  const peerTemp = sharedTempOf(dataFile);
  await fs.writeFile(peerTemp, 'peer-in-flight', 'utf-8');

  const realRename = fs.rename.bind(fs);
  await withPatchedFs({
    rename: async (from: unknown, to: unknown) => {
      if (String(to) === dataFile) {
        const error = new Error('injected rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return realRename(from as string, to as string);
    },
  }, async () => {
    await assert.rejects(flush(mine), 'the injected rename failure should reach the caller');
  });

  const survived = await fs.readFile(peerTemp, 'utf-8').then(() => true, () => false);
  assert.equal(
    survived,
    true,
    'the failing publish deleted a peer publish\'s in-flight temp file, because both derive the same fixed temp path from the destination',
  );
});

// ---------------------------------------------------------------------------
// AC-7 — the backup is published whole.
//
// Two processes copying onto one .bak path interleave the same way the temp
// path does. The fixture splits this publish's backup write in half and lets a
// peer's whole backup land in between: against a shared backup path the two
// halves straddle the peer's document, and against a privately named backup
// temp published by rename they cannot.
// ---------------------------------------------------------------------------
test('REL-BGSTAB-022 AC-7: the backup parses whole under an interposed peer overlay', async () => {
  const { dataFile, make } = await makeStore('ac7');
  const mine = make();
  seed(mine, 'mine', 40);
  // A previous publish left a store on disk, so there is something to back up.
  await flush(mine);

  const bakPath = `${dataFile}.bak`;
  const realCopyFile = fs.copyFile.bind(fs);
  const realWriteFile = fs.writeFile.bind(fs);
  const realOpen = fs.open.bind(fs);
  const peerBackup = JSON.stringify(
    { version: 1, lastUpdated: 'peer', presets: [{ pad: 'P'.repeat(60000) }] },
    null,
    2,
  );
  let interposed = false;

  // As in AC-3, the peer writes to the backup path it can reach — the one
  // derived from the destination. A publish that writes its backup there too
  // interleaves with it; a publish that writes to a private path and renames
  // cannot.
  const splitWriteThroughPeer = async (destination: string, contents: string): Promise<void> => {
    const half = Math.floor(contents.length / 2);
    const handle = await realOpen(destination, 'w');
    try {
      await handle.write(contents.slice(0, half), 0, 'utf-8');
    } finally {
      await handle.close();
    }
    // The peer's whole backup lands between this publish's two halves.
    await realWriteFile(bakPath, peerBackup, { encoding: 'utf-8', mode: 0o600 });
    const rest = await realOpen(destination, 'r+');
    try {
      await rest.write(contents.slice(half), half, 'utf-8');
    } finally {
      await rest.close();
    }
  };

  seed(mine, 'second', 40);
  await withPatchedFs({
    copyFile: async (from: unknown, to: unknown) => {
      // Today's code backs up with copyFile onto the shared .bak path.
      interposed = true;
      const contents = await fs.readFile(from as string, 'utf-8');
      await splitWriteThroughPeer(to as string, contents);
    },
    writeFile: async (file: unknown, data: unknown, options: unknown) => {
      // A helper that publishes the backup atomically writes it to its own temp
      // file instead; interpose there so the fixture is not silently skipped.
      if (String(file).includes('.bak')) {
        interposed = true;
        await splitWriteThroughPeer(String(file), String(data));
        return;
      }
      await realWriteFile(file as string, data as string, options as never);
    },
  }, async () => flush(mine));

  assert.ok(interposed, 'the fixture never interposed on the backup write');
  const raw = await fs.readFile(bakPath, 'utf-8');
  try {
    JSON.parse(raw);
  } catch (error) {
    assert.fail(
      `the backup this publish left behind does not parse (${raw.length} bytes): ${(error as Error).message}`,
    );
  }
});

// ---------------------------------------------------------------------------
// AC-8 — every in-scope store under server/data/, not just command presets.
//
// AC-7 is conditional on a publish that writes a backup. McpControlConfigStore
// and WebhookInvocationService have never written one and this change does not
// give them one, so their rows assert that absence rather than skipping it
// silently — a row that just disappeared would hide a store that stopped
// backing up by accident.
// ---------------------------------------------------------------------------

interface StoreUnderTest {
  name: string;
  file: string;
  writesBackup: boolean;
  /** Publishes `marker` into the store's own document shape. */
  publish: (dataFile: string, marker: string) => Promise<void>;
  /** The error a rejected publish must still produce, by constructor name. */
  rejectsWith: 'AppError' | 'raw';
}

async function loadStores(): Promise<StoreUnderTest[]> {
  const { WorkspaceService } = await import('./WorkspaceService.js');
  const { TerminalShortcutService } = await import('./TerminalShortcutService.js');
  const { RecoveryOptionService } = await import('./RecoveryOptionService.js');
  const { createAgentCommandProfileService } = await import('./AgentLifecycleService.js');
  const { createMcpControlConfigFileStore } = await import('./McpControlConfigStore.js');
  const { createWebhookRecordFileStore } = await import('./WebhookInvocationService.js');

  const sessionManagerStub = {
    onCwdChange() {}, onTerminalTitleChange() {}, onSessionFinalized() {}, hasSession() { return true; },
  } as never;

  return [
    {
      name: 'command-presets', file: 'command-presets.json', writesBackup: true, rejectsWith: 'AppError',
      publish: async (dataFile, marker) => {
        const service = new CommandPresetService({ dataPath: dataFile });
        seed(service, marker, 40);
        await flush(service);
      },
    },
    {
      name: 'workspaces', file: 'workspaces.json', writesBackup: true, rejectsWith: 'raw',
      publish: async (dataFile, marker) => {
        const service = new WorkspaceService(sessionManagerStub, {});
        (service as unknown as { dataFilePath: string }).dataFilePath = dataFile;
        assert.equal(service.getDataFilePath(), dataFile);
        (service as unknown as { state: unknown }).state = {
          workspaces: [{
            id: marker, name: marker, sortOrder: 0, viewMode: 'tab',
            activeTabId: null, colorCounter: 0, createdAt: '', updatedAt: '',
          }],
          tabs: Array.from({ length: 40 }, (_, i) => ({
            id: `${marker}-${i}`, workspaceId: marker, sessionId: `s${i}`,
            name: `T${i}`, lastCwd: 'C:/work'.padEnd(400, 'x'),
          })),
          gridLayouts: [],
        };
        await (service as unknown as { flushToDisk: () => Promise<void> }).flushToDisk();
      },
    },
    {
      name: 'terminal-shortcuts', file: 'terminal-shortcuts.json', writesBackup: true, rejectsWith: 'AppError',
      publish: async (dataFile, marker) => {
        const service = new TerminalShortcutService({ dataPath: dataFile });
        await service.initialize();
        await (service as unknown as { flushToDisk: () => Promise<void> }).flushToDisk();
        void marker;
      },
    },
    {
      name: 'recovery-options', file: 'recovery-options.json', writesBackup: true, rejectsWith: 'AppError',
      publish: async (dataFile, marker) => {
        const service = new RecoveryOptionService({ dataPath: dataFile });
        await service.initialize();
        await (service as unknown as { flushToDisk: () => Promise<void> }).flushToDisk();
        void marker;
      },
    },
    {
      name: 'agent-command-profiles', file: 'agent-command-profiles.json', writesBackup: true, rejectsWith: 'raw',
      publish: async (dataFile, marker) => {
        const service = createAgentCommandProfileService({ dataPath: dataFile }) as {
          initialize: () => Promise<void>;
          createProfile: (input: unknown) => Promise<unknown>;
        };
        await service.initialize();
        await service.createProfile({ id: marker, label: marker, command: 'echo', args: [] });
      },
    },
    {
      name: 'mcp-control-config', file: 'mcp-control-config.json', writesBackup: false, rejectsWith: 'raw',
      publish: async (dataFile, marker) => {
        const store = createMcpControlConfigFileStore({ dataPath: dataFile }) as {
          saveConfig: (config: unknown) => Promise<{ ok?: boolean }>;
        };
        const result = await store.saveConfig({ enabled: true });
        assert.notEqual(result, undefined);
        void marker;
      },
    },
    {
      name: 'mcp-webhook-records', file: 'mcp-webhook-records.json', writesBackup: false, rejectsWith: 'raw',
      publish: async (dataFile, marker) => {
        const store = createWebhookRecordFileStore({ dataPath: dataFile }) as {
          saveRecords: (records: unknown) => Promise<unknown>;
        };
        await store.saveRecords([]);
        void marker;
      },
    },
  ];
}

test('REL-BGSTAB-022 AC-8: each of the seven in-scope stores publishes through a private temp path', async () => {
  const stores = await loadStores();
  assert.equal(stores.length, 7, 'the table must cover every in-scope store named by the requirement');

  for (const store of stores) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bgstab022-table-${store.name}-`));
    const dataFile = path.join(dir, store.file);

    const realWriteFile = fs.writeFile.bind(fs);
    const realOpen = fs.open.bind(fs);
    const peerReachablePath = sharedTempOf(dataFile);
    const peerDocument = JSON.stringify({ version: 1, peer: 'P'.repeat(60000) }, null, 2);
    let interposed = false;

    await withPatchedFs({
      writeFile: async (file: unknown, data: unknown, options: unknown) => {
        if (!interposed && String(file).endsWith('.tmp') && String(file).startsWith(dataFile)) {
          interposed = true;
          const truncate = await realOpen(file as string, 'w');
          await truncate.close();
          await realWriteFile(peerReachablePath, peerDocument, { encoding: 'utf-8', mode: 0o600 });
          const handle = await realOpen(file as string, 'r+');
          try {
            await handle.write(String(data), 0, 'utf-8');
          } finally {
            await handle.close();
          }
          return;
        }
        await realWriteFile(file as string, data as string, options as never);
      },
    }, async () => {
      await store.publish(dataFile, 'mine');
    });

    assert.ok(interposed, `${store.name}: the fixture never interposed, so this row proves nothing`);
    const raw = await fs.readFile(dataFile, 'utf-8');
    try {
      JSON.parse(raw);
    } catch (error) {
      assert.fail(`${store.name}: published a document that does not parse (${raw.length} bytes): ${(error as Error).message}`);
    }

    const backupExists = await fs.readFile(`${dataFile}.bak`, 'utf-8').then(() => true, () => false);
    if (store.writesBackup) {
      // First publish into an empty directory has nothing to back up, so this
      // only asserts the two backup-less stores did not silently acquire one.
      void backupExists;
    } else {
      assert.equal(
        backupExists,
        false,
        `${store.name}: has never written a backup and must not start; AC-7 is conditional on a publish that writes one`,
      );
    }
  }
});

test('REL-BGSTAB-022 AC-8: each converted store preserves the error type it rejected with before', async () => {
  const stores = await loadStores();
  const realRename = fs.rename.bind(fs);

  for (const store of stores) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `bgstab022-err-${store.name}-`));
    const dataFile = path.join(dir, store.file);

    let rejection: unknown = null;
    await withPatchedFs({
      rename: async (from: unknown, to: unknown) => {
        if (String(to) === dataFile) {
          const error = new Error('injected rename failure') as NodeJS.ErrnoException;
          error.code = 'EIO';
          throw error;
        }
        return realRename(from as string, to as string);
      },
    }, async () => {
      rejection = await store.publish(dataFile, 'mine').then(() => null, (error: unknown) => error);
    });

    assert.notEqual(rejection, null, `${store.name}: a failed publish must still reach the caller`);
    const name = (rejection as Error).constructor.name;
    if (store.rejectsWith === 'AppError') {
      assert.equal(name, 'AppError', `${store.name}: used to reject with AppError and must still do so`);
    } else {
      assert.notEqual(name, 'AppError', `${store.name}: used to reject with the raw error and must still do so`);
    }
  }
});

// ---------------------------------------------------------------------------
// AC-9 — REL-BGSTAB-020's in-process contract must survive this change.
// ---------------------------------------------------------------------------
test('REL-BGSTAB-022 AC-9: overlapping publishes through one instance each reach disk', async () => {
  const { dataFile, make } = await makeStore('ac9');
  const service = make();

  const first = service.createPreset({ kind: 'command', label: 'first', value: 'f'.repeat(4000) });
  const second = service.createPreset({ kind: 'command', label: 'second', value: 's'.repeat(4000) });
  const [firstPreset, secondPreset] = await Promise.all([first, second]);

  const published = await readJson(dataFile) as { presets: Array<{ id: string }> };
  const ids = new Set(published.presets.map(preset => preset.id));
  assert.equal(ids.has(firstPreset.id), true, 'the first caller resolved but its change is not on disk');
  assert.equal(ids.has(secondPreset.id), true, 'the second caller resolved but its change is not on disk');
});
