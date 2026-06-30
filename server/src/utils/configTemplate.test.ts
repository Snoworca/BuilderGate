import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { renderBootstrapConfigTemplate } from './configTemplate.js';

test('renderBootstrapConfigTemplate includes resourceLimits defaults', () => {
  const rendered = renderBootstrapConfigTemplate('linux');

  assert.match(rendered, /resourceLimits:\s*\{/);
  assert.match(rendered, /pendingOutputMaxBytes:\s*8388608/);
  assert.match(rendered, /serverBufferedHardLimitBytes:\s*33554432/);
  assert.match(rendered, /inputBackpressureBytes:\s*1048576/);
  assert.match(rendered, /hiddenOutputPolicy:\s*"snapshot-restore"/);
  assert.match(rendered, /hiddenOutputTailBytes:\s*262144/);
  assert.match(rendered, /maxLiveWorkspaces:\s*3/);
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
  assert.match(example, /sampleIntervalMs:\s*60000/);
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
