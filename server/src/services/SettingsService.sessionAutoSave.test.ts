import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import JSON5 from 'json5';
import type { Config } from '../types/config.types.js';
import { configSchema, sessionSchema } from '../schemas/config.schema.js';
import { ConfigFileRepository } from './ConfigFileRepository.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';
import { SettingsService } from './SettingsService.js';
import { CryptoService } from './CryptoService.js';
import { AuthService } from './AuthService.js';
import { SessionManager } from './SessionManager.js';
import { AppError } from '../utils/errors.js';

// FR-AITUI-019 — the auto save switch, its interval and how many manual saves are kept.

test('FR-AITUI-019 AC-1: auto save is on every 5 minutes and 10 manual saves are kept by default', () => {
  const session = sessionSchema.parse({});
  assert.deepEqual(session.autoSave, { enabled: true, intervalMinutes: 5 });
  assert.equal(session.snapshotRetention, 10);
});

test('FR-AITUI-019 AC-1/AC-2: the schema refuses an interval under 5 or over 1440 minutes and a retention outside 1..100', () => {
  for (const bad of [
    { autoSave: { intervalMinutes: 4 } },
    { autoSave: { intervalMinutes: 1441 } },
    { autoSave: { intervalMinutes: 5.5 } },
    { snapshotRetention: 0 },
    { snapshotRetention: 101 },
  ]) {
    assert.equal(sessionSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
  assert.equal(sessionSchema.safeParse({ autoSave: { enabled: false, intervalMinutes: 1440 }, snapshotRetention: 100 }).success, true);
  assert.equal(configSchema.safeParse({ session: { autoSave: { intervalMinutes: 4 } } }).success, false);
});

interface Harness {
  service: SettingsService;
  configPath: string;
  applied: unknown[];
  store: RuntimeConfigStore;
  dispose: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const fixture = createConfigFixture();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-autosave-settings-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createConfigContent(), 'utf-8');
  const cryptoService = new CryptoService('autosave-settings');
  const store = new RuntimeConfigStore(fixture, 'linux');
  const applied: unknown[] = [];
  const service = new SettingsService({
    runtimeConfigStore: store,
    configRepository: new ConfigFileRepository(configPath, 'linux'),
    cryptoService,
    authService: new AuthService(fixture.auth!, cryptoService),
    getFileService: () => ({ updateConfig: () => undefined } as any),
    sessionManager: new SessionManager({ pty: fixture.pty, session: fixture.session }, { platform: 'linux' }),
    onSessionSaveSettings: (settings) => { applied.push(settings); },
  }, 'linux');
  return { service, configPath, applied, store, dispose: () => fs.rm(tempDir, { recursive: true, force: true }) };
}

test('FR-AITUI-019 AC-1: a config without the keys reads as the defaults', async () => {
  const h = await harness();
  try {
    const { values } = h.service.getSettingsSnapshot();
    assert.deepEqual(values.session.autoSave, { enabled: true, intervalMinutes: 5 });
    assert.equal(values.session.snapshotRetention, 10);
  } finally {
    await h.dispose();
  }
});

test('FR-AITUI-019 AC-2: the server refuses an interval under 5 minutes', async () => {
  const h = await harness();
  try {
    assert.throws(
      () => h.service.savePatch({ session: { autoSave: { intervalMinutes: 4 } } } as never),
      (error: unknown) => error instanceof AppError && error.statusCode === 400,
    );
    assert.deepEqual(h.applied, [], 'nothing is applied');
  } finally {
    await h.dispose();
  }
});

test('FR-AITUI-019 AC-3: a change applies at once and is written to the config file', async () => {
  const h = await harness();
  try {
    const response = h.service.savePatch({ session: { autoSave: { enabled: false, intervalMinutes: 15 }, snapshotRetention: 3 } } as never);
    assert.deepEqual(h.applied.at(-1), { autoSave: { enabled: false, intervalMinutes: 15 }, snapshotRetention: 3 });
    assert.ok(response.applySummary.immediate.includes('session.autoSave.enabled'));
    assert.ok(response.applySummary.immediate.includes('session.autoSave.intervalMinutes'));
    assert.ok(response.applySummary.immediate.includes('session.snapshotRetention'));
    assert.deepEqual(response.values.session.autoSave, { enabled: false, intervalMinutes: 15 });

    const saved = JSON5.parse(await fs.readFile(h.configPath, 'utf-8')) as Config;
    assert.deepEqual(saved.session.autoSave, { enabled: false, intervalMinutes: 15 });
    assert.equal(saved.session.snapshotRetention, 3);
    assert.equal(saved.session.idleDelayMs, 200, 'the other session keys stay');

    // Only the interval this time: the switch stays off, and the existing keys are rewritten in place.
    h.service.savePatch({ session: { autoSave: { intervalMinutes: 30 } } } as never);
    const again = JSON5.parse(await fs.readFile(h.configPath, 'utf-8')) as Config;
    assert.deepEqual(again.session.autoSave, { enabled: false, intervalMinutes: 30 });
    assert.deepEqual(h.applied.at(-1), { autoSave: { enabled: false, intervalMinutes: 30 }, snapshotRetention: 3 });
  } finally {
    await h.dispose();
  }
});

function createConfigFixture(): Config {
  return {
    server: { port: 4242 },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      scrollbackLines: 1000,
      maxSnapshotBytes: 2097152,
      shell: 'auto',
    },
    session: { idleDelayMs: 200 },
    security: { osc52: { allowWrite: true }, cors: { allowedOrigins: [], credentials: true, maxAge: 86400 } },
    auth: { password: '', durationMs: 1800000, jwtSecret: 'jwt-secret' },
    fileManager: {
      maxFileSize: 1048576,
      maxDirectoryEntries: 10000,
      blockedExtensions: ['.exe', '.dll'],
      blockedPaths: ['.ssh', '.aws'],
      cwdCacheTtlMs: 1000,
    },
    twoFactor: { enabled: false, externalOnly: false, issuer: 'BuilderGate', accountName: 'admin' },
  };
}

function createConfigContent(): string {
  return `{
  server: {
    port: 4242,
  },
  pty: {
    termName: "xterm-256color",
    defaultCols: 80,
    defaultRows: 24,
    useConpty: false,
    windowsPowerShellBackend: "inherit",
    scrollbackLines: 1000,
    maxSnapshotBytes: 2097152,
    shell: "auto",
  },
  session: {
    idleDelayMs: 200,
  },
  security: {
    cors: {
      allowedOrigins: [],
      credentials: true,
      maxAge: 86400,
    },
  },
  auth: {
    password: "",
    durationMs: 1800000,
    jwtSecret: "jwt-secret",
  },
  fileManager: {
    maxFileSize: 1048576,
    maxDirectoryEntries: 10000,
    blockedExtensions: [".exe", ".dll"],
    blockedPaths: [".ssh", ".aws"],
    cwdCacheTtlMs: 1000,
  },
}`;
}
