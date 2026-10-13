// FR-MCP-002 AC-8: the Enter wait of a submit delivery is set in the MCP settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpControlService } from './McpControlService.js';
import { sanitizeMcpControlConfig } from './McpControlConfigStore.js';

type Rec = Record<string, unknown>;
const ui = { auth: { type: 'browser-jwt' } };

function service(config: Rec = {}) {
  const mutations: Rec[] = [];
  const control = createMcpControlService({
    config,
    mutateConfig: (request: unknown) => { mutations.push(request as Rec); return { ok: true }; },
  }) as Record<string, (request?: unknown) => unknown>;
  return {
    mutations,
    getConfig: () => control.getConfig(ui) as Rec,
    setConfig: async (patch: Rec) => await control.setConfig({ ...patch, ...ui }) as Rec,
  };
}

test('FR-MCP-002 AC-8: getConfig reports the defaults 150 ms and 50 ms per KB', () => {
  const config = service().getConfig();
  assert.equal(config.submitEnterDelayMs, 150);
  assert.equal(config.submitEnterDelayPerKbMs, 50);
});

test('FR-MCP-002 AC-8: getConfig reports stored values', () => {
  const config = service({ submitEnterDelayMs: 400, submitEnterDelayPerKbMs: 0 }).getConfig();
  assert.equal(config.submitEnterDelayMs, 400);
  assert.equal(config.submitEnterDelayPerKbMs, 0);
});

test('FR-MCP-002 AC-8: setConfig changes both values without asking for a rebind', async () => {
  const s = service();
  const result = await s.setConfig({ submitEnterDelayMs: 300, submitEnterDelayPerKbMs: 80 });
  assert.equal(result.submitEnterDelayMs, 300);
  assert.equal(result.submitEnterDelayPerKbMs, 80);
  assert.equal(s.mutations.at(-1)?.rebindRequested, false);
  assert.equal(s.getConfig().submitEnterDelayMs, 300);
});

test('FR-MCP-002 AC-8: out-of-range or non-integer values are rejected with VALIDATION_ERROR and change nothing', async () => {
  const s = service();
  for (const patch of [
    { submitEnterDelayMs: 5001 },
    { submitEnterDelayMs: -1 },
    { submitEnterDelayMs: 12.5 },
    { submitEnterDelayMs: '200' },
    { submitEnterDelayPerKbMs: 1001 },
  ]) {
    const result = await s.setConfig(patch);
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.code, 'VALIDATION_ERROR');
    assert.ok(result.fieldErrors && typeof result.fieldErrors === 'object');
  }
  assert.equal(s.mutations.length, 0);
  assert.equal(s.getConfig().submitEnterDelayMs, 150);
  assert.equal(s.getConfig().submitEnterDelayPerKbMs, 50);
});

test('FR-MCP-002 AC-8: the config store keeps valid values and drops invalid ones', () => {
  assert.deepEqual(
    sanitizeMcpControlConfig({ submitEnterDelayMs: 0, submitEnterDelayPerKbMs: 1000 }),
    { submitEnterDelayMs: 0, submitEnterDelayPerKbMs: 1000 },
  );
  assert.deepEqual(sanitizeMcpControlConfig({ submitEnterDelayMs: 9999, submitEnterDelayPerKbMs: -5 }), {});
});
