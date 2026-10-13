// FR-MCP-002 AC-7: a submit delivery writes the text, waits, then writes Enter on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUBMIT_ENTER_DELAY,
  SUBMIT_ENTER_MAX_DELAY_MS,
  isValidSubmitEnterBaseMs,
  isValidSubmitEnterPerKbMs,
  submitEnterDelayMs,
  submitWithSeparateEnter,
} from './submitDelivery.js';
import { createSessionInputGateway, submitMcpMessageInput } from './SessionInputGateway.js';

type Rec = Record<string, unknown>;

function recorder(results: Rec[] = []) {
  const log: Array<['write', Rec] | ['sleep', number]> = [];
  let call = 0;
  return {
    log,
    writes: () => log.filter(([kind]) => kind === 'write').map(([, request]) => request as Rec),
    submit: async (request: Rec) => {
      log.push(['write', request]);
      return results[call++] ?? { accepted: true, auditId: `audit-${call}` };
    },
    sleep: async (ms: number) => { log.push(['sleep', ms]); },
  };
}

const submitRequest = (data: string): Rec => ({
  target: { sessionKey: 'k-1' },
  data,
  delivery: { mode: 'submit', submit: true },
  auditContext: { requestId: 'r-1' },
});

test('FR-MCP-002 AC-7: submit writes the text, waits, then writes Enter as a separate write', async () => {
  const r = recorder();
  const result = await submitWithSeparateEnter(r.submit, submitRequest('hello agent'), { sleep: r.sleep });
  assert.deepEqual(r.log.map(([kind, value]) => (kind === 'write' ? (value as Rec).data : kind)), ['hello agent', 'sleep', '\r']);
  assert.equal(result.accepted, true);
});

test('FR-MCP-002 AC-7: a trailing CR/LF in the text is not written with it, and Enter is written once', async () => {
  const r = recorder();
  await submitWithSeparateEnter(r.submit, submitRequest('echo hi\r\n'), { sleep: r.sleep });
  assert.deepEqual(r.writes().map(w => w.data), ['echo hi', '\r']);
});

test('FR-MCP-002 AC-7: the Enter write is not audited again and the result keeps the text write audit id', async () => {
  const r = recorder();
  const result = await submitWithSeparateEnter(r.submit, submitRequest('task'), { sleep: r.sleep });
  const [text, enter] = r.writes();
  assert.deepEqual(text.auditContext, { requestId: 'r-1' });
  assert.equal('auditContext' in enter, false);
  assert.deepEqual(enter.delivery, { mode: 'submit', submit: true });
  assert.equal(result.auditId, 'audit-1');
});

test('FR-MCP-002 AC-7: a rejected text write writes no Enter', async () => {
  const r = recorder([{ accepted: false, code: 'INPUT_REJECTED_REPLAY_PENDING' }]);
  const result = await submitWithSeparateEnter(r.submit, submitRequest('task'), { sleep: r.sleep });
  assert.deepEqual(r.writes().map(w => w.data), ['task']);
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'INPUT_REJECTED_REPLAY_PENDING');
});

test('FR-MCP-002 AC-7: a rejected Enter write returns its failure instead of a delivered status', async () => {
  const r = recorder([{ accepted: true, auditId: 'a' }, { accepted: false, code: 'TARGET_SESSION_GONE' }]);
  const result = await submitWithSeparateEnter(r.submit, submitRequest('task'), { sleep: r.sleep });
  assert.equal(result.accepted, false);
  assert.equal(result.code, 'TARGET_SESSION_GONE');
});

test('FR-MCP-002 AC-7: a bare-boolean style failure ({ ok: false }) of the Enter write is a failure too', async () => {
  const r = recorder([{ ok: true }, { ok: false }]);
  const result = await submitWithSeparateEnter(r.submit, submitRequest('ls'), { sleep: r.sleep });
  assert.equal(result.ok, false);
});

test('FR-MCP-002 AC-7: submit with empty text writes one Enter', async () => {
  const r = recorder();
  await submitWithSeparateEnter(r.submit, submitRequest('\r'), { sleep: r.sleep });
  assert.deepEqual(r.log.map(([kind, value]) => (kind === 'write' ? (value as Rec).data : kind)), ['\r']);
});

test('FR-MCP-002 AC-3 boundary: paste delivery is written once, unchanged, with no wait', async () => {
  const r = recorder();
  await submitWithSeparateEnter(r.submit, { data: 'draft', delivery: { mode: 'paste', submit: false } }, { sleep: r.sleep });
  assert.deepEqual(r.log.map(([kind, value]) => (kind === 'write' ? (value as Rec).data : kind)), ['draft']);
});

test('FR-MCP-002 AC-8: by default the wait is 150 ms plus 50 ms per started KB', () => {
  assert.deepEqual(DEFAULT_SUBMIT_ENTER_DELAY, { baseMs: 150, perKbMs: 50 });
  assert.equal(submitEnterDelayMs('hi'), 200);
  assert.equal(submitEnterDelayMs('x'.repeat(1024)), 200);
  assert.equal(submitEnterDelayMs('x'.repeat(1025)), 250);
});

test('FR-MCP-002 AC-8: the configured base and per-KB waits are used', () => {
  assert.equal(submitEnterDelayMs('x'.repeat(3000), { baseMs: 400, perKbMs: 100 }), 700);
  assert.equal(submitEnterDelayMs('x'.repeat(3000), { baseMs: 0, perKbMs: 0 }), 0);
});

test('FR-MCP-002 AC-8: the wait is capped at 10000 ms', () => {
  assert.equal(SUBMIT_ENTER_MAX_DELAY_MS, 10_000);
  assert.equal(submitEnterDelayMs('x'.repeat(1_000_000)), 10_000);
  assert.equal(submitEnterDelayMs('x'.repeat(100_000), { baseMs: 5000, perKbMs: 1000 }), 10_000);
});

test('FR-MCP-002 AC-8: submitWithSeparateEnter waits the configured delay', async () => {
  const r = recorder();
  await submitWithSeparateEnter(r.submit, submitRequest('x'.repeat(2048)), { sleep: r.sleep, delay: { baseMs: 300, perKbMs: 20 } });
  assert.deepEqual(r.log.filter(([kind]) => kind === 'sleep'), [['sleep', 340]]);
});

test('FR-MCP-002 AC-8: range checks for the two settings', () => {
  assert.equal(isValidSubmitEnterBaseMs(0), true);
  assert.equal(isValidSubmitEnterBaseMs(5000), true);
  assert.equal(isValidSubmitEnterBaseMs(5001), false);
  assert.equal(isValidSubmitEnterBaseMs(-1), false);
  assert.equal(isValidSubmitEnterBaseMs(1.5), false);
  assert.equal(isValidSubmitEnterBaseMs('150'), false);
  assert.equal(isValidSubmitEnterPerKbMs(1000), true);
  assert.equal(isValidSubmitEnterPerKbMs(1001), false);
});

test('FR-MCP-002 AC-7 with the real gateway: both writes pass its Enter policy and reach the PTY in order', async () => {
  const ptyWrites: string[] = [];
  const audits: Rec[] = [];
  const gateway = createSessionInputGateway({
    writeInput: (write) => { ptyWrites.push(String(write.data)); return true; },
    auditInput: (event) => { audits.push(event); },
    resolveTarget: () => ({ ok: true, binding: { sessionKey: 'k-1', currentSessionId: 's-1' } }),
    readReplayState: () => ({ replayPending: false, screenRepairPending: false }),
  });
  const result = await submitWithSeparateEnter(
    (request) => submitMcpMessageInput(gateway, request),
    {
      ...submitRequest('long prompt '.repeat(200)),
      actor: { type: 'mcp-fixed-access-key', scopes: ['mcp:message.paste', 'mcp:message.submit'] },
      replayPolicy: 'reject',
    },
    { sleep: async () => undefined },
  );
  assert.equal(result.accepted, true);
  assert.deepEqual(ptyWrites, ['long prompt '.repeat(200), '\r']);
  assert.equal(audits.length, 1, 'one delivery, one audit record');
});

test('FR-MCP-002 AC-3 boundary with the real gateway: an actor without submit scope gets no write at all', async () => {
  const ptyWrites: string[] = [];
  const gateway = createSessionInputGateway({
    writeInput: (write) => { ptyWrites.push(String(write.data)); return true; },
    resolveTarget: () => ({ ok: true, binding: { sessionKey: 'k-1', currentSessionId: 's-1' } }),
  });
  const result = await submitWithSeparateEnter(
    (request) => submitMcpMessageInput(gateway, request),
    { ...submitRequest('task'), actor: { scopes: ['mcp:message.paste'] } },
    { sleep: async () => undefined },
  );
  assert.equal(result.code, 'INPUT_REJECTED_ENTER_POLICY');
  assert.deepEqual(ptyWrites, []);
});
