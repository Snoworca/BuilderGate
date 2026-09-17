import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TERMINAL_RESOURCE_POLICY_CONSUMER_IDS } from './TerminalResourcePolicy.js';
import {
  TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS,
  getTerminalResourceCatalogConsumerIds,
  loadTerminalResourceConsumerManifest,
  validateTerminalResourceConsumerRegistration,
} from './TerminalResourcePolicyInventory.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MANIFEST_PATH = join(
  REPOSITORY_ROOT,
  'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/terminal-resource-consumer-manifest.current.json',
);

// @req REL-BGSTAB-010 AC-7
//
// The registration contract this suite holds:
//
//   Every id in TERMINAL_RESOURCE_POLICY_CONSUMER_IDS must be used by at least one
//   consumer catalog entry, or appear in TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS
//   with a written reason and a named decision owner.
//
// The existing inventory contract (OBS-BGSTAB-005 AC-6) enforces the opposite direction only:
// an id used by a catalog entry must be registered. Nothing held this direction, and it had
// already rotted -- see the production reservation for the one id that is registered and unused.
//
// The manifest-tuple condition is NOT an independent check of genuine non-consumption. The
// manifest is generated one tuple per catalog entry, so on a fresh seal its id set equals the
// catalog id set and the condition cannot fire for an id that is not already used. It is a
// tripwire against a stale or hand-edited manifest. See the matching note in
// TerminalResourcePolicyInventory.ts for the residual this guard cannot resolve.

test('REL-BGSTAB-010 AC-7 every registered consumer id is used by the catalog or carries a recorded reservation', async () => {
  const consumerIds = TERMINAL_RESOURCE_POLICY_CONSUMER_IDS;
  const catalogConsumerIds = getTerminalResourceCatalogConsumerIds();
  // The two enumerations must come from independent sources. Deriving the manifest ids from the
  // catalog ids would make the two agree by construction, and the question "is a reserved id
  // still carrying manifest tuples" would become unaskable -- the check would answer it cleanly
  // and vacuously. The catalog ids come from the TypeScript source, these from the sealed file.
  const manifest = await loadTerminalResourceConsumerManifest({ manifestPath: MANIFEST_PATH });
  const manifestConsumerIds = manifest.consumers.map(entry => entry.consumerId);

  // Count first. A universal claim over an empty enumeration is true, so these assertions have
  // to fire before the property below rather than after it.
  // No bare literal count here. Pinning a live registry size as a number rots exactly the way
  // this requirement is removing elsewhere: registering a twelfth consumer would red on the
  // number before it redded on anything meaningful, and the cheapest repair would be retyping
  // the number. Uniqueness and non-emptiness are properties that do not rot.
  assert.ok(consumerIds.length > 0, 'registered consumer id enumeration returned nothing');
  assert.equal(new Set(consumerIds).size, consumerIds.length,
    'a consumer id is registered twice');
  assert.ok(catalogConsumerIds.length > 0, 'catalog consumer id enumeration returned nothing');
  assert.ok(manifestConsumerIds.length > 0, 'manifest consumer id enumeration returned nothing');

  const result = validateTerminalResourceConsumerRegistration({
    consumerIds,
    catalogConsumerIds,
    manifestConsumerIds,
    reservations: TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS,
  });

  // `checked` is the number of registered ids that reached the used/reserved decision, i.e.
  // those absent from the catalog. Today that is exactly one: server.config.schema.
  assert.equal(result.checked, 1,
    'checked counts registered ids absent from the catalog; expected only server.config.schema');
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);

  // Manifest freshness. The sealed .current.json is trusted above for its tuple ids, but a stale
  // seal would silently widen the reservation hole -- a consumer added since the seal owns no
  // tuple in it, so a reservation for that consumer would pass the tuple condition. The manifest
  // records evidence.sourceHashes as a path -> sha256(utf8 source) map (written at
  // TerminalResourcePolicyInventory.ts where sourceHashes[path] is assigned), so the seal can be
  // checked directly against the file on disk.
  const inventorySourcePath = 'server/src/services/TerminalResourcePolicyInventory.ts';
  const sealedSourceHashes = manifest.evidence?.sourceHashes as Record<string, string> | undefined;
  assert.ok(sealedSourceHashes !== undefined, 'sealed manifest records no evidence.sourceHashes');
  const onDiskSha256 = createHash('sha256')
    .update(readFileSync(join(REPOSITORY_ROOT, inventorySourcePath), 'utf8'), 'utf8')
    .digest('hex');
  assert.equal(sealedSourceHashes[inventorySourcePath], onDiskSha256,
    `sealed manifest is stale for ${inventorySourcePath}; its tuple ids cannot be trusted`);
});

test('REL-BGSTAB-010 AC-7 reservation membership is pinned so a new exemption costs an argued edit', () => {
  // Pinning membership rather than a count: a rename, a substitution and a paired swap all
  // survive a count assertion. Adding an exemption has to be an edit someone defends here.
  assert.deepEqual(
    TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS.map(entry => entry.consumerId),
    ['server.config.schema'],
  );
  for (const entry of TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS) {
    assert.ok(entry.reason.length > 0, `reservation ${entry.consumerId} has no reason`);
    assert.ok(entry.decidedBy.length > 0, `reservation ${entry.consumerId} has no decision owner`);
  }
});

test('REL-BGSTAB-010 AC-7 registration guard rejects a registered consumer id that nothing uses', () => {
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.ws.router', 'server.config.schema'],
    catalogConsumerIds: ['server.ws.router'],
    manifestConsumerIds: ['server.ws.router'],
    reservations: [],
  });

  // Only server.config.schema is absent from the catalog, so only it reaches the decision.
  assert.equal(result.checked, 1,
    'checked counts registered ids absent from the catalog');
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'unused-consumer-id', reference: 'server.config.schema' }]);
});

test('REL-BGSTAB-010 AC-7 registration guard rejects a reservation with no reason or no decision owner', () => {
  const missingReason = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.config.schema'],
    catalogConsumerIds: [],
    manifestConsumerIds: [],
    reservations: [{ consumerId: 'server.config.schema', reason: '   ', decidedBy: 'wave4-wave5 step 0' }],
  });
  assert.deepEqual(missingReason.errors,
    [{ code: 'reservation-without-reason', reference: 'server.config.schema' }]);

  const missingOwner = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.config.schema'],
    catalogConsumerIds: [],
    manifestConsumerIds: [],
    reservations: [{ consumerId: 'server.config.schema', reason: 'pending a later decision', decidedBy: '' }],
  });
  assert.deepEqual(missingOwner.errors,
    [{ code: 'reservation-without-reason', reference: 'server.config.schema' }]);
});

test('REL-BGSTAB-010 AC-7 registration guard refuses a reservation for an id that still owns manifest tuples', () => {
  // The second, independent condition. Copying a name into the reservation list satisfies the
  // name check and fails this one, so the cheapest route to a green is not a keystroke.
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.ws.router'],
    catalogConsumerIds: [],
    manifestConsumerIds: ['server.ws.router'],
    reservations: [{ consumerId: 'server.ws.router', reason: 'claims to be unused', decidedBy: 'nobody' }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'reservation-has-tuple', reference: 'server.ws.router' }]);
});

test('REL-BGSTAB-010 AC-7 registration guard rejects a reservation for an id outside the registry', () => {
  // A reservation that outlives its consumer id is itself a rotted entry.
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.ws.router'],
    catalogConsumerIds: ['server.ws.router'],
    manifestConsumerIds: ['server.ws.router'],
    reservations: [{ consumerId: 'server.retired.consumer', reason: 'left behind', decidedBy: 'nobody' }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors,
    [{ code: 'reservation-not-registered', reference: 'server.retired.consumer' }]);
});

test('REL-BGSTAB-010 AC-7 registration guard rejects the same consumer id reserved twice', () => {
  // Building the reservation map with `new Map(...)` keeps only the last entry for a repeated
  // key, so a second reservation would otherwise overwrite an argued one and vanish.
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.ws.router', 'server.config.schema'],
    catalogConsumerIds: ['server.ws.router'],
    manifestConsumerIds: ['server.ws.router'],
    reservations: [
      { consumerId: 'server.config.schema', reason: 'the argued original', decidedBy: 'wave4-wave5 step 0' },
      { consumerId: 'server.config.schema', reason: 'a later unargued copy', decidedBy: 'nobody' },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'duplicate-reservation', reference: 'server.config.schema' }]);
});

test('REL-BGSTAB-010 AC-7 registration guard rejects a reservation for an id the catalog uses', () => {
  // A reservation asserts the id is unused. Reserving one that IS in the catalog is a
  // contradiction, and the unused-id loop continues past used ids so nothing else examines it.
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.ws.router'],
    catalogConsumerIds: ['server.ws.router'],
    manifestConsumerIds: ['server.ws.router'],
    reservations: [{ consumerId: 'server.ws.router', reason: 'claims to be unused', decidedBy: 'nobody' }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'reservation-for-used-id', reference: 'server.ws.router' }]);
  assert.equal(result.checked, 0,
    'a used id never reaches the used/reserved decision');
});
