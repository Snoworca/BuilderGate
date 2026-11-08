// FR-MSG-004 AC-2/AC-3: how a room message is written into a session. The text is never altered:
// multi-line text goes as a bracketed paste when the program asked for it (DECSET 2004), and Enter
// is a separate write only when the member has enter on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomPaste, ROOM_PASTE_SOURCE } from './pasteFrame.js';
import { createSessionInputGateway } from '../SessionInputGateway.js';

const START = '\u001b[200~';
const END = '\u001b[201~';

test('FR-MSG-004 AC-2: bracketed paste wraps the body unchanged; Enter goes on its own when enter is on', () => {
  assert.deepEqual(buildRoomPaste('줄1\n줄2', { bracketed: true, submit: false }), { ok: true, body: `${START}줄1\n줄2${END}`, enter: false });
  assert.deepEqual(buildRoomPaste('한 줄', { bracketed: true, submit: true }), { ok: true, body: `${START}한 줄${END}`, enter: true });
});

test('FR-MSG-004 AC-2: without bracketed paste nothing is pasted, one line or several (the program on screen is not a ready agent TUI)', () => {
  // Live E2E 2026-11-08: the foreground hint said claude while vim ex mode was on screen; ex took the
  // paste and Enter. Agent TUIs set DECSET 2004, ex/vim/less do not, so 2004 is the readiness check.
  assert.deepEqual(buildRoomPaste('한 줄', { bracketed: false, submit: true }), { ok: false, code: 'AGENT_NOT_READY' });
  assert.deepEqual(buildRoomPaste('한 줄', { bracketed: false, submit: false }), { ok: false, code: 'AGENT_NOT_READY' });
  assert.deepEqual(buildRoomPaste('a\r\nb', { bracketed: false, submit: false }), { ok: false, code: 'AGENT_NOT_READY' });
});

test('FR-MSG-004: a paste-end sequence inside the text cannot close the paste early', () => {
  const result = buildRoomPaste(`x${END}rm -rf /\n`, { bracketed: true, submit: false });
  assert.equal(result.ok, true);
  assert.equal((result as { body: string }).body.split(END).length, 2);
});

test('FR-MSG-004 AC-2: the gateway takes a multi-line room paste without submit (the MCP Enter policy is for agents)', async () => {
  const writes: string[] = [];
  const gateway = createSessionInputGateway({
    writeInput: (write: Record<string, unknown>) => { writes.push(String(write.data)); return true; },
    resolveTarget: () => ({ ok: true, binding: { sessionKey: 's1', currentSessionId: 'p1' } }),
    evaluateInputPolicy: () => ({ ok: true }),
  } as never) as { submitInput: (request: unknown) => Promise<Record<string, unknown>> | Record<string, unknown> };
  const result = await gateway.submitInput({
    target: { sessionKey: 's1' }, data: `${START}a\nb${END}`, actor: { type: 'messenger', scopes: ['mcp:message.paste'] },
    delivery: { mode: 'paste', submit: false }, source: ROOM_PASTE_SOURCE,
  });
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.deepEqual(writes, [`${START}a\nb${END}`]);
});
