// Security (FR-MSG-004): which sessions count as having an AI agent — the foreground detection the
// session save uses (SessionManager.getAgentRuntimeInfo), with the MCP registry's agentKind as a
// second source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSessionAgent } from './agentDetection.js';
import { FakeNetwork } from './testHarness.js';

type Rec = Record<string, unknown>;

test('a Claude Code started by hand (foreground detection, no agentKind) is an agent', () => {
  assert.deepEqual(detectSessionAgent({}, { foregroundAppId: 'claude' }, 'running'), { kind: 'claude', status: 'running' });
  assert.deepEqual(detectSessionAgent({ agentKind: 'terminal' }, { foregroundAppId: 'codex' }, 'idle'), { kind: 'codex', status: 'idle' });
  assert.deepEqual(detectSessionAgent({}, { foregroundAppId: 'hermes' }, undefined), { kind: 'hermes', status: 'running' });
});

test('the registry status wins when it names the same agent', () => {
  assert.deepEqual(detectSessionAgent({ agentKind: 'claude', agentStatus: 'busy' }, { foregroundAppId: 'claude' }, 'idle'), { kind: 'claude', status: 'busy' });
});

test('a plain shell is not an agent', () => {
  assert.equal(detectSessionAgent({}, { foregroundAppId: null }, 'running'), null);
  assert.equal(detectSessionAgent({ agentKind: 'terminal' }, null, 'idle'), null);
  assert.equal(detectSessionAgent({ agentKind: 'unknown' }, { foregroundAppId: null }, undefined), null);
});

test('an agent launched over MCP counts from the registry while it has not finished', () => {
  assert.deepEqual(detectSessionAgent({ agentKind: 'codex', agentStatus: 'ready' }, { foregroundAppId: null }, 'idle'), { kind: 'codex', status: 'ready' });
  assert.equal(detectSessionAgent({ agentKind: 'codex', agentStatus: 'completed' }, { foregroundAppId: null }, 'idle'), null);
  assert.equal(detectSessionAgent({ agentKind: 'codex', agentStatus: 'failed' }, { foregroundAppId: null }, 'idle'), null);
});

test('end to end: hand-started claude gets the room message, plain bash gets NO_AGENT', async () => {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [
    { sessionKey: 'a1', name: 'claude-tab', agent: detectSessionAgent({}, { foregroundAppId: 'claude' }, 'running') },
    { sessionKey: 'a2', name: 'bash-tab', agent: detectSessionAgent({}, { foregroundAppId: null }, 'running') },
  ]);
  const created = await alice.svc.createRoom({ name: 'r', sessions: ['a1', 'a2'], people: [] }) as Rec;
  const roomId = (created.room as Rec).id as string;
  alice.pastes.length = 0;
  await alice.svc.postFromUi(roomId, 'hello');
  await net.idle();
  assert.deepEqual(alice.pastes.map((p) => [p.sessionKey, p.text]), [['a1', '[BG-ROOM:r | alice] hello']]);
  const message = ((await alice.svc.getRoom(roomId, {}) as Rec).messages as Rec[]).at(-1)!;
  assert.deepEqual(message.receipts, { targets: 2, delivered: 1, pasted: 1, skipped: 1, skippedReasons: { NO_AGENT: 1 } });
});
