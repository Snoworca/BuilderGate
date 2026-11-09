// FR-MCP-023 AC-2 (security review L1/L2): terminal.input and message.send through the real
// SessionInputGateway. deliverMessage is wired the way index.ts wires it: the prompt (then Enter on
// its own for a submit), then the keys, each through submitMcpDeliveryInput.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolService } from './McpToolService.js';
import { getDefaultMcpSessionScopes } from './McpSecurityContract.js';
import { createSessionInputGateway, submitMcpDeliveryInput } from './SessionInputGateway.js';
import { sendKeysInOrder, submitWithSeparateEnter } from './submitDelivery.js';
import { encodeTerminalKey, type ParsedMcpKey } from './terminalKeys.js';

type Rec = Record<string, unknown>;

const SESSIONS = [
  { sessionKey: 'k-lead', sessionId: 's-lead', alias: 'leader', bindingLifecycle: 'live' },
  { sessionKey: 'k-work', sessionId: 's-work', alias: 'worker', bindingLifecycle: 'live' },
];
const noSleep = async () => undefined;

function setup() {
  const writes: Array<{ data: string; source: unknown }> = [];
  const results: Rec[] = [];
  const deliveries: Rec[] = [];
  const gateway = createSessionInputGateway({
    writeInput: (write) => { writes.push({ data: String(write.data), source: (write.metadata as Rec | undefined)?.source }); return true; },
    resolveTarget: () => ({ ok: true, binding: { sessionKey: 'k-work', currentSessionId: 's-work' } }),
  });
  const service = createMcpToolService({
    listSessions: () => SESSIONS,
    deliverMessage: async (delivery: Rec) => {
      deliveries.push(delivery);
      const mode = delivery.deliveryMode;
      const request = { target: { sessionKey: delivery.sessionKey }, data: delivery.prompt, actor: delivery.actor, delivery: { mode, submit: mode === 'submit' }, replayPolicy: 'reject' };
      const submit = (req: Rec) => submitMcpDeliveryInput(gateway, req, delivery.source);
      let result: Rec = { accepted: true };
      if (delivery.prompt !== '') result = await submitWithSeparateEnter(submit, request, { sleep: noSleep });
      const keys = (delivery.keys ?? []) as ParsedMcpKey[];
      if (keys.length > 0 && result.accepted !== false) {
        result = await sendKeysInOrder(submit, request, keys.map((key) => ({ name: key.name, bytes: encodeTerminalKey(key.key, key.mods, false), submits: key.submits })), { sleep: noSleep });
      }
      results.push(result);
      return result.accepted === false ? { ok: false, code: result.code } : { ok: true, status: 'delivered' };
    },
  } as never) as { callTool: (r: unknown) => Promise<Rec> };
  const call = (name: string, args: Rec) => service.callTool({ name, arguments: args, actor: { type: 'mcp', sessionKey: 'k-lead', scopes: getDefaultMcpSessionScopes() } });
  return { writes, results, deliveries, call };
}

test('L1(a): a session agent\'s terminal.input command and enter pass the gateway, under source mcp-terminal-input', async () => {
  const { writes, call } = setup();
  const command = await call('buildergate.terminal.input', { alias: 'worker', command: 'npm test' });
  assert.equal(command.ok, true, JSON.stringify(command));
  const enter = await call('buildergate.terminal.input', { alias: 'worker', keys: ['down', 'enter'] });
  assert.equal(enter.ok, true, JSON.stringify(enter));
  assert.deepEqual(writes.map((w) => w.data), ['npm test', '\r', '\u001b[B', '\r']);
  assert.deepEqual([...new Set(writes.map((w) => w.source))], ['mcp-terminal-input']);
});

test('L1(b): a session agent\'s message.send paste with a CR inside is refused by the gateway', async () => {
  const { writes, results, call } = setup();
  const result = await call('buildergate.message.send', { alias: 'worker', prompt: 'echo a\recho b', deliveryMode: 'paste' });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(results[0]!.code, 'INPUT_REJECTED_ENTER_POLICY');
  assert.equal(writes.length, 0);
});

test('L1(c): keys without enter are delivered with the caller\'s own scopes', async () => {
  const { writes, deliveries, call } = setup();
  const result = await call('buildergate.terminal.input', { alias: 'worker', keys: ['up', 'ctrl+c'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(((deliveries[0]!.actor as Rec).scopes as string[]).includes('mcp:message.submit'), false);
  assert.deepEqual(writes.map((w) => w.data), ['\u001b[A', '\u0003']);
});
