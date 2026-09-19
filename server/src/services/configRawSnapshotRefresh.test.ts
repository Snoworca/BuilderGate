import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { declaredInRawConfig } from '../schemas/terminalPathGateKeyBackup.js';
import { getRawConfigSnapshot } from '../utils/rawConfigSnapshot.js';
import { ConfigFileRepository } from './ConfigFileRepository.js';

/**
 * OPS-BGSTAB-012 correction, found while scoping the rollback drill.
 *
 * The gate-key backup's `explicit` axis reads the raw pre-parse config. That snapshot was
 * captured only at load, while settings patches rewrote the file and refreshed the runtime
 * separately -- so after any patch, `explicit` described the boot-time file and
 * `effectiveValue` described the patched runtime, and both halves looked correct on their
 * own. Two views updated on different paths with nothing asserting they agree.
 *
 * The refresh now happens where the file is actually written.
 */

function writeConfigFixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-key-raw-snapshot-'));
  const path = join(dir, 'config.json5');
  writeFileSync(path, contents, 'utf-8');
  return path;
}

const BASE_CONFIG = `{
  server: { port: 2222 },
  session: { shell: "bash" },
  stabilityModes: { wsSendMode: "direct" },
}`;

test('writing config refreshes the raw snapshot that `explicit` is read from', () => {
  const configPath = writeConfigFixture(BASE_CONFIG);
  const repository = new ConfigFileRepository(configPath, 'linux');

  // The snapshot starts as this repository's own config, recorded when `utils/config.ts`
  // loaded at import time. That is the boot-time reading `explicit` used to be stuck on.
  const boot = getRawConfigSnapshot();
  assert.equal(
    declaredInRawConfig(boot, 'realtime.wsTransportMode'),
    true,
    'precondition: the boot snapshot is this repo config, which pins wsTransportMode',
  );

  const prepared = repository.persistEditableValues(
    { stabilityModes: { headlessQueueMode: 'bounded' } } as never,
    {},
    { dryRun: true, changedKeys: ['stabilityModes.headlessQueueMode'] as never },
  );
  assert.equal(getRawConfigSnapshot(), boot, 'a dry run moved the snapshot; nothing was written');

  repository.writePreparedResult(prepared);

  const refreshed = getRawConfigSnapshot() as Record<string, Record<string, unknown>>;
  assert.notEqual(refreshed, boot, 'the snapshot still describes the boot-time file');
  assert.equal(
    refreshed.stabilityModes.headlessQueueMode,
    'bounded',
    'the refreshed snapshot does not carry the value that was just written',
  );
  assert.equal(
    declaredInRawConfig(refreshed, 'stabilityModes.wsSendMode'),
    true,
    'the refresh dropped a key the written file still declares',
  );
});

test('the refreshed snapshot is the raw text, not the parsed config', () => {
  // The trap on the fix side: re-recording the parsed `nextConfig` would make every key
  // report as declared, because zod has already filled its defaults in. That failure
  // reads as "the operator pinned everything", which is worse than a stale snapshot.
  const configPath = writeConfigFixture(BASE_CONFIG);
  const repository = new ConfigFileRepository(configPath, 'linux');

  const prepared = repository.persistEditableValues(
    { stabilityModes: { headlessQueueMode: 'bounded' } } as never,
    {},
    { dryRun: true, changedKeys: ['stabilityModes.headlessQueueMode'] as never },
  );
  repository.writePreparedResult(prepared);

  assert.equal(
    declaredInRawConfig(getRawConfigSnapshot(), 'realtime.wsTransportMode'),
    false,
    'the snapshot carries zod defaults: every key would report as explicitly declared',
  );
});
