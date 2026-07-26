import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const specUrl = new URL('../e2e/perf-bgstab-010-ac6-server-ack-fault.spec.ts', import.meta.url);
const harnessUrl = new URL('../support/perfBgstab010Ac6BrowserAckHarness.ts', import.meta.url);

test('PERF-BGSTAB-010 AC-6 isolated browser ACK evidence keeps its safety boundary', () => {
  assert.equal(existsSync(specUrl), true, 'AC-6 browser evidence must be an isolated current spec');
  assert.equal(existsSync(harnessUrl), true, 'AC-6 browser evidence must own a native WebSocket harness');

  const spec = readFileSync(specUrl, 'utf8');
  const harness = readFileSync(harnessUrl, 'utf8');

  assert.match(spec, /openAc6BrowserAckProbe/u);
  assert.match(spec, /test\.describe\.configure\(\{ retries: 0 \}\)/u);
  assert.doesNotMatch(spec, /routeWebSocket|connectToServer|injectFromServer/u);
  assert.doesNotMatch(spec, /active_workspace_id|create.*Workspace|delete.*Workspace/iu);
  assert.doesNotMatch(spec, /method:\s*'(?:POST|PUT|PATCH|DELETE)'/u);
  assert.doesNotMatch(spec, /terminal-authority\.spec|wave3-terminal-authority-fairness\.spec/u);

  assert.match(harness, /wss:\/\/localhost:2222\/ws/u);
  assert.match(harness, /terminal-delivery:capability/u);
  assert.match(harness, /terminal-delivery:ack-rejected/u);
  assert.match(harness, /ACK_UNKNOWN_LANE/u);
  assert.doesNotMatch(harness, /routeWebSocket|connectToServer|injectFromServer/u);
  assert.doesNotMatch(harness, /active_workspace_id|create.*Workspace|delete.*Workspace/iu);
  assert.doesNotMatch(harness, /method:\s*'(?:POST|PUT|PATCH|DELETE)'/u);
});
