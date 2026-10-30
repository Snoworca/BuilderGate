// FR-LOOP-007: loops over MCP — buildergate.loop.* against a real LoopService on an in-memory runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMcpToolService } from './McpToolService.js';
import { getDefaultMcpSessionScopes, getFixedMcpAccessKeyScopes } from './McpSecurityContract.js';
import { LoopService, type LoopRuntimePort } from './loop/LoopService.js';

type Rec = Record<string, unknown>;

const runtime: LoopRuntimePort = {
  workspaceExists: () => true,
  countTabs: () => 0,
  maxTabsPerWorkspace: () => 8,
  createWorkspace: async () => 'ws',
  openTab: async () => ({ tabId: 't', sessionId: 's' }),
  closeTab: async () => undefined,
  tabExists: () => true,
  submit: async () => true,
  sleep: async () => undefined,
  directoryExists: async () => true,
};

const definition = {
  name: '아침 시황',
  schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: ['08:30'] },
  shell: 'bash',
  cwd: '/work/market',
  steps: [{ kind: 'command', text: 'codex' }, { kind: 'delay', ms: 2000 }, { kind: 'prompt', text: '금일 주식 시황 분석하시오' }],
};

async function withTools(body: (call: (name: string, args?: Rec, scopes?: string[]) => Promise<Rec>, service: LoopService, listTools: () => Rec) => Promise<void>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-mcp-loop-'));
  const loops = new LoopService({ dataPath: path.join(dir, 'loops.json'), runtime, startTimer: false, now: () => new Date(2026, 9, 30, 8, 0) });
  await loops.initialize();
  const tools = createMcpToolService({ loopControl: loops }) as { callTool: (request: unknown) => Promise<Rec>; listTools: () => Rec };
  try {
    await body(
      (name, args = {}, scopes = getDefaultMcpSessionScopes()) => tools.callTool({ name, arguments: args, actor: { type: 'mcp-session', scopes } }),
      loops,
      () => tools.listTools(),
    );
  } finally {
    loops.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('FR-LOOP-007 AC-1: tools/list advertises the loop tools with input schemas', async () => {
  await withTools(async (_call, _loops, listTools) => {
    const tools = listTools().tools as Rec[];
    for (const name of ['list', 'history', 'create', 'update', 'delete', 'run']) {
      const tool = tools.find((entry) => entry.name === `buildergate.loop.${name}`);
      assert.ok(tool, `buildergate.loop.${name}`);
      assert.equal((tool.inputSchema as Rec).type, 'object');
    }
  });
});

test('FR-LOOP-007 AC-7: session agents and the fixed key both hold the loop scopes', () => {
  for (const scopes of [getDefaultMcpSessionScopes(), getFixedMcpAccessKeyScopes()]) {
    assert.ok(scopes.includes('mcp:loops.read'));
    assert.ok(scopes.includes('mcp:loops.write'));
  }
});

test('FR-LOOP-007 AC-7: without the scope the tool is refused', async () => {
  await withTools(async (call) => {
    assert.equal((await call('buildergate.loop.create', definition, ['mcp:loops.read'])).code, 'INVALID_SCOPE');
    assert.equal((await call('buildergate.loop.list', {}, ['mcp:self.read'])).code, 'INVALID_SCOPE');
  });
});

test('FR-LOOP-007 AC-2/AC-3: create registers the loop, list shows its next run', async () => {
  await withTools(async (call) => {
    const created = await call('buildergate.loop.create', definition);
    assert.equal(created.ok, true);
    const loop = created.loop as Rec;
    assert.equal(loop.name, '아침 시황');
    assert.equal(loop.nextRunAt, new Date(2026, 9, 30, 8, 30).toISOString());
    const listed = await call('buildergate.loop.list');
    assert.deepEqual((listed.loops as Rec[]).map((entry) => entry.loopId), [loop.loopId]);
    assert.equal((listed.loops as Rec[])[0].lastRun, null);
  });
});

test('FR-LOOP-007 AC-3: an invalid loop is refused with the reason', async () => {
  await withTools(async (call) => {
    const refused = await call('buildergate.loop.create', { ...definition, steps: [{ kind: 'end' }, { kind: 'command', text: 'x' }] });
    assert.equal(refused.code, 'VALIDATION_ERROR');
    assert.equal((refused.fieldErrors as Rec).reason, 'endNotLast');
  });
});

test('FR-LOOP-007 AC-4: update changes only the fields given', async () => {
  await withTools(async (call, loops) => {
    const { loop } = await call('buildergate.loop.create', definition) as { loop: Rec };
    const updated = await call('buildergate.loop.update', { loopName: '아침 시황', enabled: false, keepTabs: 3 });
    assert.equal(updated.ok, true);
    const stored = loops.get(String(loop.loopId))!;
    assert.equal(stored.enabled, false);
    assert.equal(stored.keepTabs, 3);
    assert.equal(stored.cwd, '/work/market');
    assert.equal(stored.steps.length, 3);
  });
});

test('FR-LOOP-007 AC-4: delete needs confirm', async () => {
  await withTools(async (call, loops) => {
    const { loop } = await call('buildergate.loop.create', definition) as { loop: Rec };
    assert.equal((await call('buildergate.loop.delete', { loopId: loop.loopId })).code, 'VALIDATION_ERROR');
    assert.equal(loops.list().length, 1);
    assert.equal((await call('buildergate.loop.delete', { loopId: loop.loopId, confirm: true })).ok, true);
    assert.equal(loops.list().length, 0);
  });
});

test('FR-LOOP-007 AC-5/AC-2: run answers with the running record; history shows the finished run', async () => {
  await withTools(async (call) => {
    const { loop } = await call('buildergate.loop.create', definition) as { loop: Rec };
    const run = await call('buildergate.loop.run', { loopId: loop.loopId });
    assert.equal(run.ok, true);
    assert.equal((run.run as Rec).result, 'running');
    let history = await call('buildergate.loop.history', { loopId: loop.loopId, limit: 5 });
    for (let i = 0; i < 100 && (history.runs as Rec[])[0]?.result !== 'success'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      history = await call('buildergate.loop.history', { loopId: loop.loopId, limit: 5 });
    }
    assert.equal((history.runs as Rec[])[0].result, 'success');
  });
});

test('FR-LOOP-007 AC-6: a loop is named by id or name; unknown and shared names are refused', async () => {
  await withTools(async (call) => {
    assert.equal((await call('buildergate.loop.run', { loopName: '없음' })).code, 'TARGET_NOT_FOUND');
    assert.equal((await call('buildergate.loop.run', { loopId: 'nope' })).code, 'TARGET_NOT_FOUND');
    await call('buildergate.loop.create', definition);
    await call('buildergate.loop.create', definition);
    const ambiguous = await call('buildergate.loop.run', { loopName: '아침 시황' });
    assert.equal(ambiguous.code, 'AMBIGUOUS_TARGET');
    assert.equal((ambiguous.candidates as Rec[]).length, 2);
    assert.equal((await call('buildergate.loop.run', {})).code, 'VALIDATION_ERROR');
  });
});

test('FR-LOOP-007 AC-1: the create schema spells out every schedule and step shape', async () => {
  await withTools(async (_call, _loops, listTools) => {
    const create = (listTools().tools as Rec[]).find((tool) => tool.name === 'buildergate.loop.create')!;
    const properties = (create.inputSchema as Rec).properties as Rec;
    const kinds = (variants: unknown) => (variants as Rec[]).map((variant) => ((variant.properties as Rec).kind as Rec).const).sort();
    assert.deepEqual(kinds((properties.schedule as Rec).oneOf), ['interval', 'monthly', 'once', 'weekly']);
    assert.deepEqual(kinds(((properties.steps as Rec).items as Rec).oneOf), ['command', 'delay', 'end', 'prompt']);
    assert.equal(typeof (properties.shell as Rec).description, 'string');
  });
});
