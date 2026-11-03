// SEC-MCP-001 AC-10 (#231): turning MCP off in the same save that returns it to loopback keeps the
// saved host. The stopped listener still reports its old external host; taking that back made the
// loopback config read 0.0.0.0 and the save fail with MCP_LOOPBACK_ONLY (2222, 2026-11-03).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpControlService } from './McpControlService.js';

type Rec = Record<string, unknown>;
const ui = { auth: { type: 'browser-jwt' } };

test('SEC-MCP-001 AC-10: a save that turns MCP off keeps its own host and port, not the stopped listener\'s', async () => {
  const control = createMcpControlService({
    config: { enabled: true, bindMode: 'whitelist', host: '0.0.0.0', port: 3399, transportSecurity: 'none', externalWhitelist: ['127.0.0.1'] },
    // What index.ts returns after stop(): the listener keeps its previous external bind.
    mutateConfig: () => ({
      ok: true,
      listenerStatus: 'stopped',
      active: { enabled: false, bindMode: 'whitelist', bindHost: '0.0.0.0', port: 3399, listenerStatus: 'stopped' },
    }),
  }) as Record<string, (request?: unknown) => unknown>;
  const set = async (patch: Rec) => await control.setConfig({ ...patch, ...ui }) as Rec;

  const saved = await set({ enabled: false, bindMode: 'loopback', host: '127.0.0.1', port: 3333, externalWhitelist: [] });
  assert.notEqual(saved.ok, false, JSON.stringify(saved));
  assert.equal(saved.host, '127.0.0.1');
  assert.equal(saved.port, 3333);

  // The next save validates against what was stored; it must not now read as loopback on 0.0.0.0.
  const next = await set({ submitEnterDelayMs: 200 });
  assert.notEqual(next.code, 'MCP_LOOPBACK_ONLY', JSON.stringify(next));
  assert.equal((control.getConfig(ui) as Rec).host, '127.0.0.1');
});
