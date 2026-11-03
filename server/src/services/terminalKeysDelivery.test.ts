// FR-MCP-015 AC-5/AC-6 (#232): keys are written one by one through the input gateway, a key that
// submits is marked as a submit (so the Enter policy still applies), esc is followed by a longer
// pause, and a refused key stops the rest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MCP_KEY_ESC_GAP_MS, MCP_KEY_GAP_MS, sendKeysInOrder } from './submitDelivery.js';
import { createSessionInputGateway, submitMcpMessageInput } from './SessionInputGateway.js';

type Rec = Record<string, unknown>;

const keys = [
  { name: 'down', bytes: '\u001b[B', submits: false },
  { name: 'esc', bytes: '\u001b', submits: false },
  { name: 'enter', bytes: '\r', submits: true },
];

test('FR-MCP-015 AC-6: each key is its own write, with a longer pause after esc', async () => {
  const requests: Rec[] = [];
  const sleeps: number[] = [];
  const result = await sendKeysInOrder(
    (request) => { requests.push(request); return { accepted: true }; },
    { target: { sessionKey: 'k-1' }, actor: { scopes: [] }, auditContext: { requestId: 'r' } },
    keys,
    { sleep: async (ms) => { sleeps.push(ms); } },
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(requests.map((request) => request.data), ['\u001b[B', '\u001b', '\r']);
  assert.deepEqual(requests.map((request) => (request.delivery as Rec).submit), [false, false, true]);
  assert.deepEqual(sleeps, [MCP_KEY_GAP_MS, MCP_KEY_ESC_GAP_MS]);
  assert.ok(MCP_KEY_ESC_GAP_MS > MCP_KEY_GAP_MS);
});

test('FR-MCP-015 AC-5: with the real gateway, enter needs the submit scope and a refusal stops the rest', async () => {
  const writes: string[] = [];
  const gateway = createSessionInputGateway({
    writeInput: (write) => { writes.push(String(write.data)); return true; },
    resolveTarget: () => ({ ok: true, binding: { sessionKey: 'k-1', currentSessionId: 's-1' } }),
  });
  const base = { target: { sessionKey: 'k-1' }, replayPolicy: 'reject' };
  const pasteOnly = await sendKeysInOrder(
    (request) => submitMcpMessageInput(gateway, request),
    { ...base, actor: { type: 'mcp', scopes: ['mcp:message.paste'] } },
    [...keys, { name: 'up', bytes: '\u001b[A', submits: false }],
    { sleep: async () => undefined },
  );
  assert.equal(pasteOnly.code, 'INPUT_REJECTED_ENTER_POLICY');
  assert.equal(pasteOnly.keysSent, 2, 'the result says how many keys went before the refusal');
  assert.deepEqual(writes, ['\u001b[B', '\u001b'], 'down and esc went; enter was refused and up never sent');

  writes.length = 0;
  const full = await sendKeysInOrder(
    (request) => submitMcpMessageInput(gateway, request),
    { ...base, actor: { type: 'mcp', scopes: ['mcp:message.paste', 'mcp:message.submit'] } },
    keys,
    { sleep: async () => undefined },
  );
  assert.equal(full.accepted, true, JSON.stringify(full));
  assert.equal(full.keysSent, 3);
  assert.deepEqual(writes, ['\u001b[B', '\u001b', '\r']);
});
