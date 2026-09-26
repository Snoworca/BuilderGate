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
import { loadConfigFromPathStrict } from '../utils/configStrictLoader.js';

test('FR-BGSTAB-025 strict legacy loading preserves the file and unrelated Settings persistence does not restore retired defaults', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-retired-settings-'));
  const configPath = path.join(tempDir, 'config.json5');
  const raw = JSON5.parse(createLegacyConfigContent());
  raw.resourceLimits = { telemetry: { sampleIntervalMs: 60000, recentEventLimit: 321 } };
  // Keep the existing line-oriented Settings editor format; this test covers
  // retired-key migration, not adding compact JSON5 editing support.
  const originalContent = JSON5.stringify(raw, null, 2);
  await fs.writeFile(configPath, originalContent, 'utf-8');
  try {
    const loaded = loadConfigFromPathStrict(configPath, 'linux');
    assert.equal(await fs.readFile(configPath, 'utf-8'), originalContent, 'load must preserve the legacy file bytes');
    assert.equal(Reflect.get(loaded.resourceLimits!.telemetry, 'sampleIntervalMs'), undefined);
    assert.equal(loaded.resourceLimits!.telemetry.recentEventLimit, 321);
    const values = new RuntimeConfigStore(loaded, 'linux').mergeEditablePatch({ fileManager: { maxFileSize: 2097152 } });
    const result = new ConfigFileRepository(configPath, 'linux').persistEditableValues(values, {}, {
      dryRun: true, changedKeys: ['fileManager.maxFileSize'],
    });
    assert.equal(await fs.readFile(configPath, 'utf-8'), originalContent, 'dry-run must preserve legacy input');
    assert.equal(result.nextConfig.fileManager?.maxFileSize, 2097152);
    assert.equal(Reflect.get(result.nextConfig.resourceLimits!.telemetry, 'sampleIntervalMs'), undefined);
    assert.equal(result.nextConfig.resourceLimits!.telemetry.recentEventLimit, 321);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

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

    // FR-BGSTAB-025: generating missing sections must not reintroduce a retired leaf.
    assert.doesNotMatch(result.renderedContent, /sampleIntervalMs\s*:/);
    assert.equal(Reflect.get(result.nextConfig.resourceLimits!.telemetry, 'sampleIntervalMs'), undefined);
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

test('SEC-BGSTAB-001 a nested resourceLimits leaf survives being written into legacy config text', async () => {
  // 이 렌더러는 resourceLimits 의 모든 leaf 가 스칼라라고 가정하고 있었다.
  // renderJson5Value 의 마지막 줄이 String(value) 라서 중첩 객체는 조용히
  // `[object Object]` 가 되고, 그 다음 줄의 JSON5.parse 가 터진다 -- 즉 설정을
  // 저장하는 것 자체가 실패한다. terminal.osc52 가 이 스키마의 첫 중첩 leaf 다.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'buildergate-nested-resource-limits-'));
  const configPath = path.join(tempDir, 'config.json5');
  await fs.writeFile(configPath, createLegacyConfigContent(), 'utf-8');

  const parsedConfig = configSchema.parse(JSON5.parse(createLegacyConfigContent())) as Config;
  const values = new RuntimeConfigStore(parsedConfig, 'linux').mergeEditablePatch({
    resourceLimits: { headless: { pendingOutputMaxBytes: 2097152 } },
  });
  const repository = new ConfigFileRepository(configPath, 'linux');

  try {
    // 이 호출은 내부에서 렌더 결과를 다시 JSON5.parse 하므로, 렌더가 깨지면 여기서 던진다.
    const result = repository.persistEditableValues(values, {}, {
      dryRun: true,
      changedKeys: ['resourceLimits.headless.pendingOutputMaxBytes'],
    });

    assert.doesNotMatch(
      result.renderedContent,
      /\[object Object\]/,
      'a nested leaf must be rendered as a JSON5 block, not stringified',
    );
    const reparsed = JSON5.parse(result.renderedContent);
    assert.equal(reparsed.resourceLimits.terminal.osc52.allowWrite, true);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
