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
// own evidence.sourceHashes key set, because the two src roots are narrower than the claim the
// scan supports: the manifest -- which this suite already trusts for its consumer ids -- records
// sources outside them, and tools/wave3/canary-admission-evidence.test.mjs literally passes
// `consumer: 'server.ws.router'` from outside them. Scanning less than the project's own model of
// consumer-bearing source would let a consumer sit in a file this scan never opens.
//
// MEASURED, and why tools/wave3 is now a root of its own: the sealed key set has 36 entries and
// exactly two of them are outside the src roots -- tools/wave3/terminal-resource-consumer-manifest
// .test.mjs and tools/wave3/terminal-resource-policy-differential.ts. The cited
// canary-admission-evidence.test.mjs is NOT among them, so the union with the seal did not reach
// it and the sentence above motivated the widening with a file the widening did not scan.
//
// THE FILENAME RULE, stated explicitly rather than left implicit:
//   * Under the SRC roots, a `.test.`/`.spec.` file is scanned only when the seal names it. This
//     suite itself lives under server/src and writes the reserved id many times over, so scanning
//     unsealed tests there would be circular.
//   * Under TOOLS_SCAN_ROOTS every source file is scanned, sealed or not, filename regardless.
//     Nothing under tools/wave3 is a copy of this suite, so the circularity that justifies the src
//     exclusion does not exist there, and applying the exclusion would re-exclude the very file
//     cited as the reason for widening.
const PRODUCTION_SCAN_ROOTS = ['server/src', 'frontend/src'];
const TOOLS_SCAN_ROOTS = ['tools/wave3'];

const MANIFEST_SEALED_SOURCE_PATHS: ReadonlySet<string> = new Set(Object.keys(
  (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    evidence?: { sourceHashes?: Record<string, string> };
  }).evidence?.sourceHashes ?? {},
));

// The window of source an anchor hashes: the occurrence's line plus this many lines either side.
const RESERVED_ID_ANCHOR_CONTEXT_LINES = 3;

function anchorWindowSha256(lines: readonly string[], lineIndex: number): string {
  const start = Math.max(0, lineIndex - RESERVED_ID_ANCHOR_CONTEXT_LINES);
  const end = Math.min(lines.length, lineIndex + RESERVED_ID_ANCHOR_CONTEXT_LINES + 1);
  return createHash('sha256').update(lines.slice(start, end).join('\n'), 'utf8').digest('hex');
}

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
// (3) Even keyed to path + consumerId + kind, the kind predicates are pure LINE-SHAPE tests over a
// whole file, so the exclusion was still buyable with zero edits: writing a REAL consuming call in
// TerminalResourcePolicy.ts as
//     registerHiddenConsumer(
//       'server.config.schema',
//     );
// produces a line whose trimmed text is exactly `'server.config.schema',`, which the
// `registry-array-entry` entry for that file matches. It would have been counted as excluded, the
// residual would have stayed 0, and `entryHits > 0` -- one entry licensing arbitrarily many
// matching lines -- would have stayed satisfied.
//
// So an occurrence is excluded only when it matches a declared entry on ALL FIVE of path,
// consumerId, kind, LINE NUMBER and a sha256 over the surrounding source window, where `kind` is a
// structural predicate evaluated against the text of the line the occurrence sits on. An
// occurrence matching no entry is a residual and fails, so a new bare-literal line elsewhere in an
// already-listed file is a residual rather than an inherited exemption. Each entry also declares
// how many occurrences it expects and is asserted to have matched EXACTLY that many.
//
// THESE ANCHORS INTENTIONALLY ROT when the surrounding source moves -- an unrelated edit three
// lines above a declaration site changes its window hash and reddens this suite. That is the
// deliberate cost of identifying an occurrence instead of forgiving a count: a table that survives
// the source moving underneath it is a table that has stopped knowing which occurrence it excuses.
// Re-anchoring is therefore an ARGUED EDIT: whoever updates `line`/`windowSha256` must re-read the
// site and restate, in `covers`, that the occurrence there is still a declaration and not a use.
// Recomputing the hashes mechanically without re-reading the site defeats the entire mechanism.
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
  line: number;
  windowSha256: string;
  occurrences: number;
  covers: string;
}> = [
  {
    path: 'server/src/services/TerminalResourcePolicy.ts',
    consumerId: 'server.config.schema',
    kind: 'registry-array-entry',
    line: 73,
    windowSha256: 'd35cf7abb74ee86482eaced1bb2bc019375419d10254a2777f851d3792a8126e',
    occurrences: 1,
    covers: 'the id literal inside the TERMINAL_RESOURCE_POLICY_CONSUMER_IDS declaration',
  },
  {
    path: 'server/src/services/TerminalResourcePolicyInventory.ts',
    consumerId: 'server.config.schema',
    kind: 'comment-line',
    line: 1551,
    windowSha256: '01673b382b3ceb09876685d334ab969f45574d6f87c8a65fd936c15e698a52fc',
    occurrences: 1,
    covers: 'the mention in the comment block that argues this reservation',
  },
  {
    path: 'server/src/services/TerminalResourcePolicyInventory.ts',
    consumerId: 'server.config.schema',
    kind: 'reservation-consumer-id-property',
    line: 1561,
    windowSha256: '4f2c456c34d92fba9258fb1ac6cddf3df88791d54cc38a97b30c711a407b59d1',
    occurrences: 1,
    covers: 'the consumerId property of the reservation entry itself',
  },
  {
    path: 'server/src/services/TerminalResourcePolicy.test.ts',
    consumerId: 'server.config.schema',
    kind: 'registry-array-entry',
    line: 41,
    windowSha256: 'ec395e07ddd4958ecb7cc421031892216c7c6343a3047a60f15350a55b3c9cc2',
    occurrences: 1,
    covers: 'the EXPECTED_POLICY_CONSUMER_IDS literal in that file. This file is scanned because '
      + 'the seal names it as a consumer-evidence source. The occurrence is a declaration mirror '
      + 'rather than a consumer passing the id, and it is NOT taken on trust: the test below, '
      + '"the EXPECTED_POLICY_CONSUMER_IDS mirror ... is pinned to the live registry", parses that '
      + 'array literal out of the file and deep-equals it to '
      + 'TERMINAL_RESOURCE_POLICY_CONSUMER_IDS in order, so the mirror cannot diverge from the '
      + 'registry it mirrors. The earlier wording claimed the file "asserts the id is registered"; '
      + 'that was measurably false -- EXPECTED_POLICY_CONSUMER_IDS is referenced exactly once in '
      + 'that file, inside expectedAppliedPolicyIds(), which nothing in the repository calls.',
  },
];

function listProductionSourceFiles(): string[] {
  const files = new Set<string>(MANIFEST_SEALED_SOURCE_PATHS);
  const visit = (relativeRoot: string, dropUnsealedTests: boolean): void => {
    for (const entry of readdirSync(join(REPOSITORY_ROOT, relativeRoot), { withFileTypes: true })) {
      const relativePath = `${relativeRoot}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(relativePath, dropUnsealedTests);
        continue;
      }
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/u.test(entry.name)) continue;
      // Under the SRC roots, test and spec files are dropped ONLY when the seal does not name them.
      // A file the manifest records as a source of consumer evidence belongs to the project's own
      // model of consumer-bearing source whatever its filename says. An UNSEALED test file under
      // those roots is excluded because this suite itself lives there and writes the reserved id
      // many times over, so scanning it would be circular.
      //
      // Under TOOLS_SCAN_ROOTS `dropUnsealedTests` is false and nothing is dropped by filename.
      // That is the whole point of the widening: the file the widening cites,
      // tools/wave3/canary-admission-evidence.test.mjs, is an unsealed `.test.` file and the src
      // rule would exclude it again.
      if (dropUnsealedTests
        && (entry.name.includes('.test.') || entry.name.includes('.spec.'))
        && !MANIFEST_SEALED_SOURCE_PATHS.has(relativePath)) continue;
      files.add(relativePath);
    }
  };
  for (const root of PRODUCTION_SCAN_ROOTS) visit(root, true);
  for (const root of TOOLS_SCAN_ROOTS) visit(root, false);
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
  // Keyed by reserved id. Flat, this was a single list shared across every reservation, so with two
  // or more reservations the failure message for one id could name another id's sites and send the
  // reader to a file that has nothing to do with the id that failed.
  residualSitesById: Record<string, string[]>;
  entryHits: number[];
}

// Shared by the production contract row and by the scan test, so the occurrence branch of the
// guard is exercised against real data on the path where the contract is actually held.
function scanReservedIdProductionOccurrences(reservedIds: readonly string[]): ReservedIdOccurrenceScan {
  const files = listProductionSourceFiles();
  const rawById = new Map<string, number>();
  const excludedById = new Map<string, number>();
  const residualById: Record<string, number> = {};
  const residualSitesById: Record<string, string[]> = {};
  const entryHits = RESERVED_ID_DECLARATION_SITES.map(() => 0);
  for (const reservedId of reservedIds) {
    rawById.set(reservedId, 0);
    excludedById.set(reservedId, 0);
    residualById[reservedId] = 0;
    residualSitesById[reservedId] = [];
  }

  for (const relativePath of files) {
    const lines = readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8').split('\n');
    // Computed lazily, once per file that actually contains a reserved id.
    let windowSha256ByLineIndex: Map<number, string> | undefined;
    lines.forEach((lineText, lineIndex) => {
      for (const reservedId of reservedIds) {
        const onLine = countFixedStringOccurrences(lineText, reservedId);
        if (onLine === 0) continue;
        rawById.set(reservedId, (rawById.get(reservedId) ?? 0) + onLine);
        windowSha256ByLineIndex ??= new Map<number, string>();
        let windowSha256 = windowSha256ByLineIndex.get(lineIndex);
        if (windowSha256 === undefined) {
          windowSha256 = anchorWindowSha256(lines, lineIndex);
          windowSha256ByLineIndex.set(lineIndex, windowSha256);
        }
        // The anchor is part of the MATCH, not a check applied after a match. A line elsewhere in
        // a listed file that happens to have the declared shape therefore matches no entry at all
        // and falls through to the residual, rather than matching an entry and then arguing about
        // it.
        const matchedIndexes = RESERVED_ID_DECLARATION_SITES
          .map((entry, index) => ({ entry, index }))
          .filter(({ entry }) => entry.path === relativePath
            && entry.consumerId === reservedId
            && entry.line === lineIndex + 1
            && entry.windowSha256 === windowSha256
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
          residualSitesById[reservedId].push(`${relativePath}:${lineIndex + 1}`);
        }
      }
    });
  }

  return { files, rawById, excludedById, residualById, residualSitesById, entryHits };
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
      + `${scan.residualSitesById[reservedId].join(', ')}`);
  }

  // EXACTLY the declared number of occurrences, never `> 0`. `> 0` let one entry license
  // arbitrarily many matching lines in its file, which is how a real consuming call written in the
  // declared shape could hide behind a declaration-site exemption. A rotted exemption (matching
  // nothing) and an over-broad one (matching more than it declares) both red here.
  RESERVED_ID_DECLARATION_SITES.forEach((entry, index) => {
    assert.ok(entry.occurrences > 0,
      `declaration site ${entry.path} / ${entry.kind} declares no occurrences (${entry.covers})`);
    assert.equal(scan.entryHits[index], entry.occurrences,
      `declaration site ${entry.path}:${entry.line} / ${entry.kind} / ${entry.consumerId} matched `
      + `${scan.entryHits[index]} occurrences, declared ${entry.occurrences} (${entry.covers}). `
      + 'If the surrounding source moved, re-read the site before re-anchoring line/windowSha256.');
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

// The scan boundary is partly DECIDED BY THE SEAL. `listProductionSourceFiles` seeds its file set
// from MANIFEST_SEALED_SOURCE_PATHS, and the manifest-freshness loop above quantifies over whatever
// keys remain under a `> 0` guard -- so dropping a key from the seal removes a file from the
// production-occurrence scan AND from the freshness check at once, with nothing going red. That
// makes the seal a silent control over how much source this suite looks at.
//
// CHOICE, stated: the FULL sorted key list is pinned here, not merely the out-of-roots subset.
// Pinning only the out-of-roots paths would leave every sealed in-roots path droppable, and while
// the src roots would still walk those files, their FRESHNESS check would vanish -- which is the
// half of the hole that matters, because a stale in-roots source is exactly the drift that widens
// the reservation hole.
//
// WHAT THIS STILL DOES NOT PIN: it pins key IDENTITY only. It does not pin the recorded sha256
// VALUES (the freshness loop above compares those against disk), it does not pin that the seal is
// COMPLETE with respect to the real consumer-bearing source tree -- a genuinely consumer-bearing
// file that was never sealed is absent from both the seal and this list and nothing here notices
// -- and it does not pin the contents of the walked roots, so a file appearing or disappearing
// under server/src, frontend/src or tools/wave3 moves the scan without moving this list.
const EXPECTED_MANIFEST_SEALED_SOURCE_PATHS: readonly string[] = [
  'frontend/src/components/Settings/settingsDraftHelpers.ts',
  'frontend/src/components/Terminal/TerminalContainer.tsx',
  'frontend/src/components/Terminal/TerminalView.tsx',
  'frontend/src/contexts/WebSocketContext.tsx',
  'frontend/src/hooks/useTerminalRuntimeResidency.ts',
  'frontend/src/services/tokenStorage.ts',
  'frontend/src/types/settings.ts',
  'frontend/src/utils/inputReliabilityMode.ts',
  'frontend/src/utils/terminalGraceBuffer.ts',
  'frontend/src/utils/terminalHiddenOutput.ts',
  'frontend/src/utils/terminalOutputHotPath.ts',
  'frontend/src/utils/terminalOutputScheduler.ts',
  'frontend/src/utils/terminalSnapshot.ts',
  'frontend/src/utils/terminalViewAttributes.ts',
  'frontend/src/utils/visibleOutputRecovery.ts',
  'frontend/src/utils/webSocketBackpressure.ts',
  'server/src/schemas/config.schema.ts',
  'server/src/services/ConfigFileRepository.ts',
  'server/src/services/RuntimeConfigStore.test.ts',
  'server/src/services/RuntimeConfigStore.ts',
  'server/src/services/SessionManager.ts',
  'server/src/services/SettingsService.ts',
  'server/src/services/TerminalResourcePolicy.test.ts',
  'server/src/services/TerminalResourcePolicy.ts',
  'server/src/services/TerminalResourcePolicyInventory.ts',
  'server/src/services/TerminalResourcePolicyObservations.ts',
  'server/src/types/config.types.ts',
  'server/src/types/settings.types.ts',
  'server/src/utils/config.ts',
  'server/src/utils/configStrictLoader.ts',
  'server/src/utils/headlessOutputQueue.ts',
  'server/src/utils/headlessTerminal.ts',
  'server/src/ws/WsRouter.ts',
  'server/src/ws/wsSendPolicy.ts',
  'tools/wave3/terminal-resource-consumer-manifest.test.mjs',
  'tools/wave3/terminal-resource-policy-differential.ts',
];

test('REL-BGSTAB-010 AC-7 the sealed source key set that decides the scan boundary is pinned', () => {
  const sealedPaths = [...MANIFEST_SEALED_SOURCE_PATHS].sort((left, right) => left.localeCompare(right));
  assert.ok(sealedPaths.length > 0, 'the sealed manifest names no source paths');
  assert.deepEqual(sealedPaths, [...EXPECTED_MANIFEST_SEALED_SOURCE_PATHS],
    'the sealed evidence.sourceHashes key set changed; it decides which files this suite scans and '
    + 'freshness-checks, so a change here must be an argued edit');
});

// Extracts a `const <NAME> = [ ... ] as const;` array-of-string-literals declaration from TypeScript
// source text. Deliberately narrow: it matches the exact declaration shape and reads only quoted
// elements, so a declaration that changes shape yields nothing and the non-emptiness assertion at
// the call site reddens rather than the equality passing vacuously.
function extractStringLiteralArrayDeclaration(sourceText: string, name: string): string[] {
  const opening = `const ${name} = [`;
  const start = sourceText.indexOf(opening);
  if (start === -1) return [];
  const end = sourceText.indexOf('\n]', start);
  if (end === -1) return [];
  return sourceText.slice(start + opening.length, end)
    .split('\n')
    .map(line => /^\s*'([^']*)'\s*,?\s*$/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

test('REL-BGSTAB-010 AC-7 the EXPECTED_POLICY_CONSUMER_IDS mirror in TerminalResourcePolicy.test.ts is pinned to the live registry', () => {
  // The declaration-site exemption for TerminalResourcePolicy.test.ts is argued on that array being
  // a mirror of the registry. MEASURED before this test existed, that argument was false as
  // written: EXPECTED_POLICY_CONSUMER_IDS is referenced exactly once in that file, inside
  // `expectedAppliedPolicyIds(...)`, and nothing in the repository calls that function. Nothing
  // compared the array to TERMINAL_RESOURCE_POLICY_CONSUMER_IDS, so letting it diverge reddened
  // nothing -- an unverified hand-typed duplicate of a live registry, which is the exact defect
  // class this work exists to remove.
  //
  // The pin is held HERE rather than in that file: its test count is pinned at 31 by a separate
  // guard, so adding a test there would break that guard.
  const mirrorSourceText = readFileSync(
    join(REPOSITORY_ROOT, 'server/src/services/TerminalResourcePolicy.test.ts'), 'utf8');
  const mirror = extractStringLiteralArrayDeclaration(mirrorSourceText, 'EXPECTED_POLICY_CONSUMER_IDS');

  // Non-emptiness BEFORE the equality. A silent parse failure returning [] is a known failure mode
  // for text extraction, and `deepEqual([], [])` would make this whole test vacuous if the registry
  // were ever empty -- and even against a non-empty registry, a diagnostic that says "expected 11
  // got 0" is much weaker evidence than one that says the extraction itself broke.
  assert.ok(mirror.length > 0,
    'EXPECTED_POLICY_CONSUMER_IDS could not be extracted from TerminalResourcePolicy.test.ts; the '
    + 'declaration shape changed and this pin is no longer reading anything');

  assert.deepEqual(mirror, [...TERMINAL_RESOURCE_POLICY_CONSUMER_IDS],
    'the EXPECTED_POLICY_CONSUMER_IDS mirror has diverged from TERMINAL_RESOURCE_POLICY_CONSUMER_IDS');
});
