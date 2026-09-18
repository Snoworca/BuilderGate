import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateBootstrapAccess, isLoopbackIp, normalizeBootstrapIpEntry } from './bootstrapAccessPolicy.js';

// #54: isLoopbackIp rejected two legitimate loopback spellings. The direction was fail-closed,
// so nothing was wrongly admitted -- the defect was an undocumented gap in a security predicate
// that also guards bootstrap access.
//
// These assertions are written so a predicate that simply returned true could not satisfy them:
// every accepting case is paired with a near-miss that must still be refused.

test('#54 isLoopbackIp accepts uppercase IPv4-mapped loopback', () => {
  assert.equal(isLoopbackIp('::FFFF:127.0.0.1'), true);
  assert.equal(isLoopbackIp('::ffff:127.0.0.1'), true, 'the lowercase form must not regress');
  // Near-miss: mapped, correctly spelled, and NOT loopback.
  assert.equal(isLoopbackIp('::FFFF:10.0.0.1'), false);
});

test('#54 isLoopbackIp accepts the fully expanded IPv6 loopback', () => {
  assert.equal(isLoopbackIp('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackIp('0000:0000:0000:0000:0000:0000:0000:0001'), true);
  assert.equal(isLoopbackIp('::1'), true, 'the abbreviated form must not regress');
  // Near-miss: same shape, different address. Collapsing this would be a real hole.
  assert.equal(isLoopbackIp('0:0:0:0:0:0:0:2'), false);
  assert.equal(isLoopbackIp('1:0:0:0:0:0:0:1'), false);
});

test('#54 non-loopback addresses are still refused', () => {
  for (const ip of ['10.0.0.1', '192.168.1.5', '::2', '2001:db8::1', '', ' ']) {
    assert.equal(isLoopbackIp(ip), false, `${JSON.stringify(ip)} must not be loopback`);
  }
  assert.equal(isLoopbackIp(undefined), false);
  assert.equal(isLoopbackIp(null), false);
});

test('#54 the operator allowlist normalises the same way, so either spelling matches', () => {
  // The normaliser serves both sides. An operator who writes one spelling must match a peer
  // that reports the other -- that symmetry is why the fix lives in the normaliser.
  assert.equal(normalizeBootstrapIpEntry('::FFFF:10.0.0.1'), '10.0.0.1');
  assert.equal(normalizeBootstrapIpEntry('0:0:0:0:0:0:0:1'), '::1');

  const viaUppercaseAllowlist = evaluateBootstrapAccess('10.0.0.1', ['::FFFF:10.0.0.1']);
  assert.equal(viaUppercaseAllowlist.requesterAllowed, true);

  const viaExpandedPeer = evaluateBootstrapAccess('0:0:0:0:0:0:0:1', ['::1']);
  assert.equal(viaExpandedPeer.requesterAllowed, true);

  const unrelated = evaluateBootstrapAccess('10.0.0.2', ['::FFFF:10.0.0.1']);
  assert.equal(unrelated.requesterAllowed, false, 'normalisation must not widen the allowlist');
});
