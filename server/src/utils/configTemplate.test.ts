import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import JSON5 from 'json5';
import { renderBootstrapConfigTemplate } from './configTemplate.js';
import { workspaceSchema } from '../schemas/config.schema.js';

test('FR-BGSTAB-025 bootstrap templates omit every retired setting on both platforms', () => {
  for (const platform of ['linux', 'win32'] as const) {
    const rendered = renderBootstrapConfigTemplate(platform);
    const raw = JSON5.parse(rendered);
    for (const retiredPath of [
      'logging.level', 'logging.audit', 'logging.directory', 'logging.maxSize', 'logging.maxFiles',
      'bruteForce.rateLimit.windowMs', 'bruteForce.rateLimit.maxRequests',
      'bruteForce.lockout.maxAttempts', 'bruteForce.lockout.lockoutDurationMs', 'bruteForce.lockout.progressiveDelay',
      'auth.maxDurationMs', 'fileManager.maxCodeFileSize', 'resourceLimits.telemetry.sampleIntervalMs',
    ]) {
      let value: unknown = raw;
      for (const key of retiredPath.split('.')) {
        value = value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;
      }
      assert.equal(value, undefined, `${platform}: ${retiredPath}`);
    }
    assert.equal(raw.fileManager.maxFileSize, 1048576);
    assert.equal(raw.resourceLimits.telemetry.recentEventLimit, 256);
  }
});

test('renderBootstrapConfigTemplate includes resourceLimits defaults', () => {
  const rendered = renderBootstrapConfigTemplate('linux');

  assert.match(rendered, /resourceLimits:\s*\{/);
  assert.match(rendered, /pendingOutputMaxBytes:\s*8388608/);
  assert.match(rendered, /serverBufferedHardLimitBytes:\s*33554432/);
  assert.match(rendered, /inputBackpressureBytes:\s*1048576/);
  assert.match(rendered, /hiddenOutputPolicy:\s*"snapshot-restore"/);
  assert.match(rendered, /hiddenOutputTailBytes:\s*262144/);
  assert.match(rendered, /maxLiveWorkspaces:\s*10/);
  assert.match(rendered, /maxLiveTerminals:\s*32/);
  assert.match(rendered, /hiddenRuntimeTtlMs:\s*600000/);
  assert.match(rendered, /stabilityModes:\s*\{/);
  assert.match(rendered, /headlessQueueMode:\s*"observe"/);
  assert.match(rendered, /wsSendMode:\s*"direct"/);
  assert.match(rendered, /frontendRuntimeResidency:\s*"bounded"/);
  assert.match(rendered, /processCleanup:\s*\{/);
  assert.match(rendered, /mode:\s*"observe"/);
  assert.match(rendered, /gracefulWaitMs:\s*750/);
  assert.match(rendered, /forceWaitMs:\s*1500/);
  assert.match(rendered, /descendantSampleLimit:\s*64/);
});

test('config.json5.example documents resourceLimits defaults', async () => {
  const rootRelativePath = path.resolve('server', 'config.json5.example');
  const serverRelativePath = path.resolve('config.json5.example');
  const examplePath = await fs.stat(rootRelativePath).then(
    () => rootRelativePath,
    () => serverRelativePath,
  );
  const example = await fs.readFile(examplePath, 'utf-8');

  assert.match(example, /resourceLimits:\s*\{/);
  assert.match(example, /pendingOutputMaxChunks:\s*1024/);
  assert.match(example, /perClientOutputQueueMaxBytes:\s*2097152/);
  assert.match(example, /transportOutboxTtlMs:\s*1500/);
  assert.match(example, /tombstoneTtlMs:\s*86400000/);
  assert.match(example, /maxLiveWorkspaces:\s*10/);
  assert.match(example, /maxLiveTerminals:\s*32/);
  assert.match(example, /hiddenRuntimeTtlMs:\s*600000/);
  // FR-BGSTAB-025 retires this formerly documented Wave0 setting.
  assert.doesNotMatch(example, /sampleIntervalMs\s*:/);
  assert.match(example, /stabilityModes:\s*\{/);
  assert.match(example, /headlessQueueMode:\s*"observe"/);
  assert.match(example, /wsSendMode:\s*"direct"/);
  assert.match(example, /frontendRuntimeResidency:\s*"bounded"/);
  assert.match(example, /processCleanup:\s*\{/);
  assert.match(example, /mode:\s*"observe"/);
  assert.match(example, /gracefulWaitMs:\s*750/);
  assert.match(example, /forceWaitMs:\s*1500/);
  assert.match(example, /descendantSampleLimit:\s*64/);
});

async function readExample(): Promise<string> {
  const rootRelativePath = path.resolve('server', 'config.json5.example');
  const serverRelativePath = path.resolve('config.json5.example');
  const examplePath = await fs.stat(rootRelativePath).then(
    () => rootRelativePath,
    () => serverRelativePath,
  );
  return fs.readFile(examplePath, 'utf-8');
}

test('FR-BGSTAB-026 bootstrap templates document every settable workspace key', () => {
  assert.ok(workspaceSchema.shape, 'workspaceSchema must expose .shape for the parity guards to read');
  const schemaKeys = Object.keys(workspaceSchema.shape).sort();
  for (const platform of ['linux', 'win32'] as const) {
    const raw = JSON5.parse(renderBootstrapConfigTemplate(platform));
    assert.deepEqual(
      Object.keys(raw.workspace ?? {}).sort(),
      schemaKeys,
      `${platform}: bootstrap workspace block must list exactly the schema's settable keys`,
    );
  }
});

test('FR-BGSTAB-026 config.json5.example documents every settable workspace key', async () => {
  const raw = JSON5.parse(await readExample());
  assert.deepEqual(
    Object.keys(raw.workspace ?? {}).sort(),
    Object.keys(workspaceSchema.shape).sort(),
    'config.json5.example workspace block must list exactly the schema\'s settable keys',
  );
});

test('FR-BGSTAB-026 documented workspace defaults match the schema defaults', async () => {
  const parsedSchemaDefaults = workspaceSchema.parse({}) as Record<string, unknown>;
  const sources: Array<[string, Record<string, unknown>]> = [
    ['linux bootstrap', JSON5.parse(renderBootstrapConfigTemplate('linux')).workspace],
    ['win32 bootstrap', JSON5.parse(renderBootstrapConfigTemplate('win32')).workspace],
    ['config.json5.example', JSON5.parse(await readExample()).workspace],
  ];
  for (const [label, workspace] of sources) {
    // Every settable key, not just the two this issue introduced: a documented
    // value that drifts from the schema default is the same defect either way.
    for (const [key, expected] of Object.entries(parsedSchemaDefaults)) {
      assert.equal(workspace[key], expected, `${label}: ${key}`);
    }
  }
});
