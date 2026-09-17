import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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
  // those absent from the catalog. Derived, not pinned: a bare literal over a live quantity rots
  // exactly the way the deleted registry-size literal did, and the cheapest repair for a red
  // would be retyping the number.
  const expectedChecked = consumerIds.filter(id => !catalogConsumerIds.includes(id)).length;
  assert.ok(expectedChecked > 0, 'the production fixture no longer exercises the reserved-id path');
  assert.equal(result.checked, expectedChecked,
    'checked must equal the number of registered consumer ids absent from the catalog');
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);

  // Manifest freshness. The sealed .current.json is trusted above for its tuple ids, but a stale
  // seal would silently widen the reservation hole -- a consumer added since the seal owns no
  // tuple in it, so a reservation for that consumer would pass the tuple condition. The manifest
  // records evidence.sourceHashes as a path -> sha256(utf8 source) map (written at
  // TerminalResourcePolicyInventory.ts where sourceHashes[path] is assigned), so the seal can be
  // checked directly against the files on disk.
  //
  // EVERY recorded path is checked, not just the inventory's own source. Checking one entry left
  // the other thirty-five free to drift, and a consumer added to any of them since the seal is
  // exactly the drift that widens the hole.
  //
  // This deliberately duplicates part of the OBS-BGSTAB-005 AC-6 seal-freshness contract. The
  // duplication is the point: this suite trusts the manifest's consumer ids for its own decision,
  // so it must not delegate its trust in that seal to a contract that could be relaxed elsewhere.
  const sealedSourceHashes = manifest.evidence?.sourceHashes as Record<string, string> | undefined;
  assert.ok(sealedSourceHashes !== undefined, 'sealed manifest records no evidence.sourceHashes');
  const sealedSourceEntries = Object.entries(sealedSourceHashes);
  // Count before the loop. A universal claim over an empty map is true.
  assert.ok(sealedSourceEntries.length > 0, 'sealed manifest records an empty evidence.sourceHashes');
  const staleSourcePaths = sealedSourceEntries
    .filter(([sourcePath, sealedSha256]) => createHash('sha256')
      .update(readFileSync(join(REPOSITORY_ROOT, sourcePath), 'utf8'), 'utf8')
      .digest('hex') !== sealedSha256)
    .map(([sourcePath]) => sourcePath);
  assert.deepEqual(staleSourcePaths, [],
    `sealed manifest is stale for ${staleSourcePaths[0]}; its tuple ids cannot be trusted`);
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
  // This fixture encodes a STALE OR HAND-EDITED manifest, and only that. Against a freshly sealed
  // manifest the manifest id set equals the catalog id set, so this branch cannot fire for an id
  // that is not already in use -- and a used id is rejected one branch earlier. It is defence in
  // depth for a state the suite's manifest-freshness assertion rejects first, not a second
  // independent check that a reserved consumer genuinely does not consume.
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

test('REL-BGSTAB-010 AC-7 registration guard defers other diagnostics for a duplicated reservation', () => {
  // Pins the `continue` in the reservation loop: a duplicated id must report ONLY
  // duplicate-reservation, even when it is independently faulty in a way that would otherwise
  // produce a second, different error. Without this test the `continue` is an unverified
  // defensive statement -- removing it leaves the whole suite green.
  //
  // 'server.retired.consumer' is both duplicated (reserved twice) and unregistered (absent from
  // consumerIds), which would surface as reservation-not-registered for each occurrence once the
  // duplicate check no longer skips it.
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.ws.router'],
    catalogConsumerIds: ['server.ws.router'],
    manifestConsumerIds: ['server.ws.router'],
    reservations: [
      { consumerId: 'server.retired.consumer', reason: 'first copy', decidedBy: 'nobody' },
      { consumerId: 'server.retired.consumer', reason: 'second copy', decidedBy: 'nobody' },
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ code: 'duplicate-reservation', reference: 'server.retired.consumer' }]);
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

// Production-occurrence scan for the reserved ids. A reservation asserts the id has no consumer.
// That claim is falsifiable: if the id's literal is written into a production source anywhere
// other than the declaration sites that must name it, something is passing it and the claim is
// false. This is the one part of "genuinely unused" that is checkable from the source tree.
//
// Fixed-string counting, never a regex: `server.config.schema` as a regex matches the unrelated
// hyphenated catalog category `server-config-schema-store`, because `.` matches `-`. That
// category is real and lives in this very file's inventory, so the regex form would report a
// false occurrence and this check would red for the wrong reason.
const PRODUCTION_SCAN_ROOTS = ['server/src', 'frontend/src'];

// Occurrences that are the DECLARATION of the reservation rather than a use of it, and are
// therefore subtracted. Each entry names what it covers, so adding a mention costs an argued edit.
const RESERVED_ID_DECLARATION_SITE_OCCURRENCES: ReadonlyArray<{
  path: string;
  count: number;
  covers: string;
}> = [
  {
    path: 'server/src/services/TerminalResourcePolicy.ts',
    count: 1,
    covers: 'the id literal inside the TERMINAL_RESOURCE_POLICY_CONSUMER_IDS declaration',
  },
  {
    path: 'server/src/services/TerminalResourcePolicyInventory.ts',
    count: 2,
    covers: 'the consumerId literal in the reservation entry, plus the one mention in the '
      + 'comment block that argues that reservation',
  },
];

function listProductionSourceFiles(): string[] {
  const files: string[] = [];
  const visit = (relativeRoot: string): void => {
    for (const entry of readdirSync(join(REPOSITORY_ROOT, relativeRoot), { withFileTypes: true })) {
      const relativePath = `${relativeRoot}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.name)) continue;
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
      files.push(relativePath);
    }
  };
  for (const root of PRODUCTION_SCAN_ROOTS) visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function countFixedStringOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

test('REL-BGSTAB-010 AC-7 no reserved consumer id is written into production outside its declaration', () => {
  const reservedIds = TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS.map(entry => entry.consumerId);
  assert.ok(reservedIds.length > 0, 'there are no reservations to scan for');

  const productionFiles = listProductionSourceFiles();
  assert.ok(productionFiles.length > 0, 'the production source scan enumerated no files');

  const rawOccurrencesById = new Map<string, number>();
  const declarationSiteTotalsById = new Map<string, number>();
  for (const reservedId of reservedIds) {
    rawOccurrencesById.set(reservedId, 0);
    declarationSiteTotalsById.set(reservedId, 0);
  }
  for (const relativePath of productionFiles) {
    const source = readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');
    for (const reservedId of reservedIds) {
      const inFile = countFixedStringOccurrences(source, reservedId);
      if (inFile === 0) continue;
      rawOccurrencesById.set(reservedId, (rawOccurrencesById.get(reservedId) ?? 0) + inFile);
      const declaration = RESERVED_ID_DECLARATION_SITE_OCCURRENCES.find(entry => entry.path === relativePath);
      if (declaration === undefined) continue;
      assert.ok(inFile >= declaration.count,
        `${relativePath} carries fewer occurrences than the declared exclusion (${declaration.covers})`);
      declarationSiteTotalsById.set(reservedId,
        (declarationSiteTotalsById.get(reservedId) ?? 0) + declaration.count);
    }
  }

  // The measured totals today: three raw occurrences of the single reserved id, all three at the
  // two declaration sites above, leaving nothing outside them.
  assert.equal(rawOccurrencesById.get('server.config.schema'), 3,
    'the raw production occurrence count for the reserved id moved; re-argue the declaration sites');

  const reservedIdProductionOccurrences: Record<string, number> = {};
  for (const reservedId of reservedIds) {
    reservedIdProductionOccurrences[reservedId] = Math.max(
      0,
      (rawOccurrencesById.get(reservedId) ?? 0) - (declarationSiteTotalsById.get(reservedId) ?? 0),
    );
  }
  assert.deepEqual(reservedIdProductionOccurrences, { 'server.config.schema': 0 },
    'a reserved consumer id is written into a production source outside its declaration');

  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: TERMINAL_RESOURCE_POLICY_CONSUMER_IDS,
    catalogConsumerIds: getTerminalResourceCatalogConsumerIds(),
    manifestConsumerIds: getTerminalResourceCatalogConsumerIds(),
    reservations: TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS,
    reservedIdProductionOccurrences,
  });
  assert.deepEqual(
    result.errors.filter(entry => entry.code === 'reservation-id-occurs-in-production'),
    [],
  );
});

test('REL-BGSTAB-010 AC-7 registration guard rejects a reservation whose id is used in production', () => {
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: ['server.config.schema'],
    catalogConsumerIds: [],
    manifestConsumerIds: [],
    reservations: [{ consumerId: 'server.config.schema', reason: 'claims to be unused', decidedBy: 'nobody' }],
    reservedIdProductionOccurrences: { 'server.config.schema': 1 },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.errors,
    [{ code: 'reservation-id-occurs-in-production', reference: 'server.config.schema' }]);
});
