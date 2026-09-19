import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const webSocketContextSource = readFileSync(
  new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
  'utf8',
);

// @req REL-BGSTAB-016
// @req REL-BGSTAB-011
test('REL-BGSTAB-016 a server input rejection is surfaced to the user, not only recorded', () => {
  // Measured 2026-09-19 on https://localhost:2222: server_input_rejected fired twice with
  // reason "invalid-payload" for the two sends that were supposed to launch codex, and the
  // handler was `case 'input:rejected': break;`. The characters left the browser, the server
  // refused them, and the user was told nothing. The discard bus REL-BGSTAB-016 already built
  // for the two local discard sites is the surface a remote refusal owes the user too.
  const signature = 'input:rejected must reach the discard surface';
  assert.match(webSocketContextSource, /publishInputDiscard/, signature);
  assert.match(
    webSocketContextSource,
    /recordTerminalDebugEvent\(sessionId, 'server_input_rejected'[\s\S]{0,1200}?publishInputDiscard\(sessionId\)/u,
    signature,
  );
  assert.doesNotMatch(
    webSocketContextSource,
    /case 'input:rejected':\s*\n\s*break;/u,
    'the empty case is what made the refusal invisible',
  );
});
