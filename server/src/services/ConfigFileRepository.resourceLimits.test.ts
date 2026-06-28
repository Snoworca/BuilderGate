import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import JSON5 from 'json5';
import type { Config } from '../types/config.types.js';
import { configSchema } from '../schemas/config.schema.js';
import { ConfigFileRepository } from './ConfigFileRepository.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';

test('ConfigFileRepository inserts Wave6 resource sections into legacy config text', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-resource-limits-config-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createLegacyConfigContent(), 'utf-8');

  const parsedConfig = configSchema.parse(JSON5.parse(createLegacyConfigContent())) as Config;
  const values = new RuntimeConfigStore(parsedConfig, 'linux').mergeEditablePatch({
    resourceLimits: {
      headless: {
        pendingOutputMaxBytes: 2097152,
      },
      ws: {
        serverBufferedHighWaterBytes: 2000000,
        serverBufferedHardLimitBytes: 8000000,
      },
      clientWs: {
        inputBackpressureBytes: 2000000,
        hardReconnectBytes: 8000000,
      },
      snapshots: {
        perSnapshotMaxChars: 1000000,
        totalStorageBudgetChars: 10000000,
        maxEntries: 32,
      },
    },
  });
  const repository = new ConfigFileRepository(configPath, 'linux');

  try {
    const result = repository.persistEditableValues(values, {}, {
      dryRun: true,
      changedKeys: [
        'resourceLimits.headless.pendingOutputMaxBytes',
        'resourceLimits.ws.serverBufferedHighWaterBytes',
        'resourceLimits.ws.serverBufferedHardLimitBytes',
        'resourceLimits.clientWs.inputBackpressureBytes',
        'resourceLimits.clientWs.hardReconnectBytes',
        'resourceLimits.snapshots.perSnapshotMaxChars',
        'resourceLimits.snapshots.totalStorageBudgetChars',
        'resourceLimits.snapshots.maxEntries',
      ],
    });
    const reparsed = configSchema.parse(JSON5.parse(result.renderedContent)) as Config;

    assert.equal(result.nextConfig.resourceLimits?.headless.pendingOutputMaxBytes, 2097152);
    assert.equal(result.nextConfig.resourceLimits?.ws.serverBufferedHighWaterBytes, 2000000);
    assert.equal(result.nextConfig.resourceLimits?.ws.serverBufferedHardLimitBytes, 8000000);
    assert.equal(result.nextConfig.resourceLimits?.clientWs.inputBackpressureBytes, 2000000);
    assert.equal(result.nextConfig.resourceLimits?.clientWs.hardReconnectBytes, 8000000);
    assert.equal(result.nextConfig.resourceLimits?.snapshots.maxEntries, 32);
    assert.equal(reparsed.resourceLimits?.headless.pendingOutputMaxBytes, 2097152);
    assert.equal(reparsed.resourceLimits?.ws.serverBufferedHighWaterBytes, 2000000);
    assert.match(result.renderedContent, /resourceLimits:\s*\{[\s\S]*clientWs:\s*\{[\s\S]*inputBackpressureBytes:\s*2000000/);
    assert.match(result.renderedContent, /headless:\s*\{[\s\S]*pendingOutputMaxBytes:\s*2097152/);
    assert.match(result.renderedContent, /ws:\s*\{[\s\S]*serverBufferedHardLimitBytes:\s*8000000/);
    assert.match(result.renderedContent, /hardReconnectBytes:\s*8000000/);
    assert.match(result.renderedContent, /snapshots:\s*\{[\s\S]*maxEntries:\s*32/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function createLegacyConfigContent(): string {
  return `{
  server: {
    port: 2002,
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
    runningDelayMs: 250,
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
    maxDurationMs: 86400000,
    jwtSecret: "jwt-secret",
  },
  fileManager: {
    maxFileSize: 1048576,
    maxCodeFileSize: 524288,
    maxDirectoryEntries: 10000,
    blockedExtensions: [".exe", ".dll"],
    blockedPaths: [".ssh", ".aws"],
    cwdCacheTtlMs: 1000,
  },
}`;
}
