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

  // The occurrence branch of the guard has to be LIVE where the contract is held. Leaving
  // `reservedIdProductionOccurrences` off this row meant the strongest of the reservation checks
  // never ran against real data -- deleting the branch outright would not have reddened anything
  // the production contract asserts. The same scan helper the dedicated scan test uses is called
  // here, so the two cannot diverge.
  const reservedIdProductionOccurrences = scanReservedIdProductionOccurrences(
    TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS.map(entry => entry.consumerId),
  ).residualById;

  const result = validateTerminalResourceConsumerRegistration({
    consumerIds,
    catalogConsumerIds,
    manifestConsumerIds,
    reservations: TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS,
    reservedIdProductionOccurrences,
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
//
// Roots walked directly. The scanned set is the UNION of these roots with the sealed manifest's
// own evidence.sourceHashes key set, because these two roots are narrower than the claim the scan
// supports: the manifest -- which this suite already trusts for its consumer ids -- records
// sources outside them (tools/wave3/...), and tools/wave3/canary-admission-evidence.test.mjs
// literally passes `consumer: 'server.ws.router'` from outside them. Scanning less than the
// project's own model of consumer-bearing source would let a consumer sit in a file this scan
// never opens.
const PRODUCTION_SCAN_ROOTS = ['server/src', 'frontend/src'];

const MANIFEST_SEALED_SOURCE_PATHS: ReadonlySet<string> = new Set(Object.keys(
  (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    evidence?: { sourceHashes?: Record<string, string> };
  }).evidence?.sourceHashes ?? {},
));

// How an occurrence is IDENTIFIED, not how many of them are forgiven.
//
// The previous form of this table forgave a COUNT per file. Two defects followed from that and
// both are closed here. (1) The lookup matched on path alone inside a loop over reserved ids, so
// every reserved id occurring in a listed file inherited that file's budget -- a second
// reservation added later would arrive with a multi-occurrence production allowance it never
// argued for. (2) Because only a count was forgiven, deleting the argumentative comment mention
// in TerminalResourcePolicyInventory.ts and adding a REAL consuming call in the same file kept
// the per-file count identical, hiding a genuine consumer with zero edits to any table or
// assertion.
//
// So an occurrence is excluded only when it matches a declared entry on ALL THREE of path,
// consumerId and kind, where `kind` is a structural predicate evaluated against the text of the
// line the occurrence sits on. An occurrence matching no entry is a residual and fails.
type ReservedIdOccurrenceKind =
  | 'registry-array-entry'
  | 'comment-line'
  | 'reservation-consumer-id-property';

const RESERVED_ID_OCCURRENCE_KIND_PREDICATES:
Readonly<Record<ReservedIdOccurrenceKind, (lineText: string, consumerId: string) => boolean>> = {
  // A bare element of a string-literal array: the trimmed line is the quoted id and nothing else
  // but an optional trailing comma. A call site cannot take this shape, because a call needs a
  // callee on the line or an enclosing expression that would leave other tokens behind.
  // Residual it passes over: an element of an ARGUMENT array to a live call, e.g.
  //   consumeResources([\n  'server.config.schema',\n]) -- the predicate sees one line and has no
  // view of the enclosing array's identity, so a genuine consumer written that way is excluded.
  'registry-array-entry': (lineText, consumerId) => {
    const trimmed = lineText.trim();
    return trimmed === `'${consumerId}',` || trimmed === `'${consumerId}'`;
  },
  // A line comment: argumentative prose about the reservation. Never executable.
  // Residual it passes over: the id written inside a multi-line template literal whose line
  // happens to begin with `//` -- a script body assembled as data and handed to an eval, a Worker
  // or a spawned child. That text does reach a consumer, and this predicate reads it as a comment.
  'comment-line': lineText => lineText.trim().startsWith('//'),
  // The `consumerId` property of the reservation object literal, alone on its line.
  // Residual it passes over: any OTHER object literal in the same declared file that also carries
  // a `consumerId` property on its own line -- `registerConsumer({\n  consumerId: 'x',\n ... })`
  // would be a genuine registration and is shaped identically. Keying the entry to the path
  // confines this to TerminalResourcePolicyInventory.ts; inside that file it is a real gap.
  'reservation-consumer-id-property': (lineText, consumerId) => {
    const trimmed = lineText.trim();
    return trimmed === `consumerId: '${consumerId}',` || trimmed === `consumerId: '${consumerId}'`;
  },
};

// Occurrences that are the DECLARATION of the reservation rather than a use of it. Each entry
// names exactly which occurrence it covers, so adding a mention costs an argued edit and cannot
// be bought by bumping a number.
const RESERVED_ID_DECLARATION_SITES: ReadonlyArray<{
  path: string;
  consumerId: string;
  kind: ReservedIdOccurrenceKind;
  covers: string;
}> = [
  {
    path: 'server/src/services/TerminalResourcePolicy.ts',
    consumerId: 'server.config.schema',
    kind: 'registry-array-entry',
    covers: 'the id literal inside the TERMINAL_RESOURCE_POLICY_CONSUMER_IDS declaration',
  },
  {
    path: 'server/src/services/TerminalResourcePolicyInventory.ts',
    consumerId: 'server.config.schema',
    kind: 'comment-line',
    covers: 'the mention in the comment block that argues this reservation',
  },
  {
    path: 'server/src/services/TerminalResourcePolicyInventory.ts',
    consumerId: 'server.config.schema',
    kind: 'reservation-consumer-id-property',
    covers: 'the consumerId property of the reservation entry itself',
  },
  {
    path: 'server/src/services/TerminalResourcePolicy.test.ts',
    consumerId: 'server.config.schema',
    kind: 'registry-array-entry',
    covers: 'the EXPECTED_POLICY_CONSUMER_IDS membership pin that mirrors the registry. This file '
      + 'is scanned because the seal names it as a consumer-evidence source; the occurrence is a '
      + 'declaration mirror asserting registry membership, not a consumer passing the id.',
  },
];

function listProductionSourceFiles(): string[] {
  const files = new Set<string>(MANIFEST_SEALED_SOURCE_PATHS);
  const visit = (relativeRoot: string): void => {
    for (const entry of readdirSync(join(REPOSITORY_ROOT, relativeRoot), { withFileTypes: true })) {
      const relativePath = `${relativeRoot}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(relativePath);
        continue;
      }
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.name)) continue;
      // Test and spec files are dropped ONLY when the seal does not name them. A file the manifest
      // records as a source of consumer evidence belongs to the project's own model of
      // consumer-bearing source whatever its filename says, and excluding it would narrow the scan
      // below the claim it supports. A test file that is NOT sealed is excluded as before: this
      // suite itself writes the reserved id many times over, and scanning it would be circular.
      if ((entry.name.includes('.test.') || entry.name.includes('.spec.'))
        && !MANIFEST_SEALED_SOURCE_PATHS.has(relativePath)) continue;
      files.add(relativePath);
    }
  };
  for (const root of PRODUCTION_SCAN_ROOTS) visit(root);
  return [...files].sort((left, right) => left.localeCompare(right));
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

interface ReservedIdOccurrenceScan {
  files: string[];
  rawById: Map<string, number>;
  excludedById: Map<string, number>;
  residualById: Record<string, number>;
  residualSites: string[];
  entryHits: number[];
}

// Shared by the production contract row and by the scan test, so the occurrence branch of the
// guard is exercised against real data on the path where the contract is actually held.
function scanReservedIdProductionOccurrences(reservedIds: readonly string[]): ReservedIdOccurrenceScan {
  const files = listProductionSourceFiles();
  const rawById = new Map<string, number>();
  const excludedById = new Map<string, number>();
  const residualById: Record<string, number> = {};
  const residualSites: string[] = [];
  const entryHits = RESERVED_ID_DECLARATION_SITES.map(() => 0);
  for (const reservedId of reservedIds) {
    rawById.set(reservedId, 0);
    excludedById.set(reservedId, 0);
    residualById[reservedId] = 0;
  }

  for (const relativePath of files) {
    const lines = readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8').split('\n');
    lines.forEach((lineText, lineIndex) => {
      for (const reservedId of reservedIds) {
        const onLine = countFixedStringOccurrences(lineText, reservedId);
        if (onLine === 0) continue;
        rawById.set(reservedId, (rawById.get(reservedId) ?? 0) + onLine);
        const matchedIndexes = RESERVED_ID_DECLARATION_SITES
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.path === relativePath
            && entry.consumerId === reservedId
            && RESERVED_ID_OCCURRENCE_KIND_PREDICATES[entry.kind](lineText, reservedId))
          .map(({ index }) => index);
        // Every excluded occurrence must be attributable to EXACTLY ONE entry. Two entries
        // matching the same line means the predicates overlap and the table has stopped
        // identifying occurrences.
        assert.ok(matchedIndexes.length <= 1,
          `${relativePath}:${lineIndex + 1} matches ${matchedIndexes.length} declaration-site entries for ${reservedId}`);
        if (matchedIndexes.length === 1) {
          entryHits[matchedIndexes[0]] += onLine;
          excludedById.set(reservedId, (excludedById.get(reservedId) ?? 0) + onLine);
          continue;
        }
        residualById[reservedId] += onLine;
        for (let repeat = 0; repeat < onLine; repeat += 1) {
          residualSites.push(`${relativePath}:${lineIndex + 1}`);
        }
      }
    });
  }

  return { files, rawById, excludedById, residualById, residualSites, entryHits };
}

test('REL-BGSTAB-010 AC-7 no reserved consumer id is written into production outside its declaration', async () => {
  const reservedIds = TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS.map(entry => entry.consumerId);
  assert.ok(reservedIds.length > 0, 'there are no reservations to scan for');

  const scan = scanReservedIdProductionOccurrences(reservedIds);
  assert.ok(scan.files.length > 0, 'the production source scan enumerated no files');

  // No bare literal over a live quantity. How many times a reserved id's literal appears across
  // the source tree is exactly the kind of moving number the previous rounds removed elsewhere,
  // and naming one id in the assertion constrained nothing about any future reservation. The
  // expectation is derived per id instead, by iterating the reservations.
  for (const reservedId of reservedIds) {
    const raw = scan.rawById.get(reservedId) ?? 0;
    const excluded = scan.excludedById.get(reservedId) ?? 0;
    assert.equal(excluded + scan.residualById[reservedId], raw,
      `occurrence accounting for ${reservedId} does not partition its raw occurrences`);
    assert.equal(scan.residualById[reservedId], 0,
      `${reservedId} is written into a scanned source outside its declared sites: `
      + `${scan.residualSites.join(', ')}`);
  }

  // A declaration-site entry that matches nothing is a rotted exemption, and would otherwise sit
  // in the table forgiving a site that no longer exists.
  RESERVED_ID_DECLARATION_SITES.forEach((entry, index) => {
    assert.ok(scan.entryHits[index] > 0,
      `declaration site ${entry.path} / ${entry.kind} / ${entry.consumerId} matches no occurrence (${entry.covers})`);
  });

  // The manifest ids come from the sealed file, not from a syntactic derivation off the catalog.
  // Passing getTerminalResourceCatalogConsumerIds() for both arguments would make the two agree by
  // construction and make the tuple condition unaskable -- the correction this suite already
  // records for the production contract row applies here identically.
  const manifest = await loadTerminalResourceConsumerManifest({ manifestPath: MANIFEST_PATH });
  const result = validateTerminalResourceConsumerRegistration({
    consumerIds: TERMINAL_RESOURCE_POLICY_CONSUMER_IDS,
    catalogConsumerIds: getTerminalResourceCatalogConsumerIds(),
    manifestConsumerIds: manifest.consumers.map(entry => entry.consumerId),
    reservations: TERMINAL_RESOURCE_CONSUMER_REGISTRATION_RESERVATIONS,
    reservedIdProductionOccurrences: scan.residualById,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
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
