import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * MIG-BGSTAB-004 AC-3 and AC-6.
 *
 * AC-6 forbids deleting the legacy JSON data plane until two releases of soak
 * have passed. A "must not delete" requirement has no natural test, which is
 * why it needs one written on purpose: the flip that makes the legacy path stop
 * running is exactly the moment it starts looking like dead code, and the next
 * person removing it would be doing the obvious thing.
 */

const routerSource = readFileSync(new URL('./WsRouter.ts', import.meta.url), 'utf8');
const policySource = readFileSync(new URL('./wsSendPolicy.ts', import.meta.url), 'utf8');
const wirePayloadSource = readFileSync(new URL('./wirePayload.ts', import.meta.url), 'utf8');

test('MIG-BGSTAB-004 AC-6 the JSON encoder is still reachable and is still the fallback', () => {
  // `encodeFor` falls back to JSON on three independent conditions. Losing any
  // of them turns an un-negotiated client from "served over JSON" into
  // "served nothing", which is a silent outage rather than a codec change.
  assert.match(wirePayloadSource, /jsonWirePayload\(/, 'the JSON payload constructor must survive');
  assert.match(
    wirePayloadSource,
    /return jsonWirePayload\(input\.encodeJson\(input\.message\)\)/,
    'encodeFor must still end on the JSON branch',
  );
  assert.match(policySource, /jsonWirePayload\(JSON\.stringify\(wireMessage\)\)/,
    'the codec-absent path must still produce a JSON envelope');
});

test('MIG-BGSTAB-004 AC-6 the config ladder still accepts json as a value', () => {
  // Rollback is "put json in the config file" (AC-2). Removing the rung would
  // make the documented rollback impossible while every test still passed.
  const schema = readFileSync(new URL('../schemas/config.schema.ts', import.meta.url), 'utf8');
  assert.match(
    schema,
    /terminalWireFormat:\s*z\.enum\(\['json',\s*'binary-shadow',\s*'binary-optin',\s*'binary'\]\)/,
    'the four-rung ladder must stay a closed enum with json in it',
  );
});

test('MIG-BGSTAB-004 AC-3 rollback stays one function, and the session kill switch is not a second one', () => {
  // AC-3 requires the MIG-BGSTAB-002 AC-5 order to live in one place. The
  // session kill switch is allowed to exist *because* it does not roll back:
  // it must not bump the codec epoch or retire every channel.
  const rollbackAt = routerSource.indexOf('rollbackTerminalBinaryGroup(\n');
  assert.notEqual(rollbackAt, -1, 'the single rollback function must exist');

  const demoteAt = routerSource.indexOf('demoteTerminalBinarySession(');
  assert.notEqual(demoteAt, -1, 'the session kill switch must exist');
  const demoteBody = routerSource.slice(demoteAt, routerSource.indexOf('\n  /**', demoteAt));
  assert.ok(!demoteBody.includes('bumpCodecEpoch'), 'demotion must not invalidate other sessions frames');
  assert.ok(!demoteBody.includes('retireAllChannels'), 'demotion must not take the whole group down');
  assert.match(demoteBody, /closeSession\(sessionId\)/, 'demotion retires only that session');
});

test('MIG-BGSTAB-004 AC-3 every codec-epoch bump happens inside the rollback function', () => {
  // Control for the test above: asserting what demotion does not do proves
  // nothing if some third site does it instead.
  const bumps = [...routerSource.matchAll(/\.bumpCodecEpoch\(/g)];
  assert.equal(bumps.length, 1, `expected exactly one codec epoch bump, found ${bumps.length}`);
  const rollbackStart = routerSource.indexOf('private rollbackTerminalBinaryGroup(');
  const rollbackEnd = routerSource.indexOf('\n  /**', rollbackStart);
  assert.ok(
    bumps[0].index > rollbackStart && bumps[0].index < rollbackEnd,
    'the only codec epoch bump must be inside rollbackTerminalBinaryGroup',
  );
});
