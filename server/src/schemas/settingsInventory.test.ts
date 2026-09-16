import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import { configSchema } from './config.schema.js';
import { listConfigSchemaLeafPaths } from './configSchemaLeaves.js';
import {
  EDITABLE_SETTINGS_KEYS,
  RESERVED_WAVE6_SETTING_KEYS,
} from '../services/RuntimeConfigStore.js';

// @req OPS-BGSTAB-011
//
// The inventory is the artifact; this file is the pin that stops it rotting.
// Everything asserted below is derived from the Zod schema at run time rather
// than from a second hand-written list, so adding or removing a configuration
// leaf without touching the inventory fails here.

const INVENTORY_URL = new URL('./settingsInventory.json', import.meta.url);

const CLASSIFICATIONS = ['user-visible', 'reserved', 'inert', 'safety-only'] as const;
type Classification = (typeof CLASSIFICATIONS)[number];

// Which discovery rule admitted a consumer. `dotted-path` means the module
// carries the leaf's own access chain; `co-occurrence` means it only mentions
// the leaf and parent segments somewhere in the file, which is a place to start
// reading rather than proof of consumption.
const CONSUMER_MATCHES = ['dotted-path', 'co-occurrence'] as const;
type ConsumerMatch = (typeof CONSUMER_MATCHES)[number];

interface InventoryConsumer {
  readonly module: string;
  readonly symbol: string;
  readonly match: ConsumerMatch;
}

interface InventoryEntry {
  readonly path: string;
  readonly classification: Classification;
  readonly reason: string;
  readonly consumers: readonly InventoryConsumer[];
  readonly safetyBound?: string;
}

interface Inventory {
  readonly schemaVersion: number;
  readonly requirementId: string;
  readonly classifications: readonly string[];
  readonly entries: readonly InventoryEntry[];
}

// AC-4: the inventory is parsed, not scraped, and this test reads that same
// artifact rather than a second copy of the data.
function readInventory(): Inventory {
  return JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as Inventory;
}

// @req OPS-BGSTAB-011 AC-1
test('OPS-BGSTAB-011 the inventory covers the configuration schema exactly once per leaf', () => {
  const schemaLeaves = listConfigSchemaLeafPaths(configSchema);
  const entries = readInventory().entries;

  // A duplicate entry would let one leaf carry two classifications and make the
  // set comparison below pass anyway, so multiplicity is checked before the sets.
  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(entry.path, (seen.get(entry.path) ?? 0) + 1);
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([path]) => path);
  assert.deepEqual(duplicated, [], 'each leaf must appear exactly once in the inventory');

  const inInventory = new Set(seen.keys());
  const inSchema = new Set(schemaLeaves);

  const missing = schemaLeaves.filter((path) => !inInventory.has(path));
  assert.deepEqual(missing, [], 'every configuration schema leaf must be classified');

  const stale = [...inInventory].filter((path) => !inSchema.has(path)).sort();
  assert.deepEqual(stale, [], 'every inventory entry must name a leaf the schema still declares');

  // Guards the two assertions above against a walker that silently returns
  // nothing: empty-vs-empty would satisfy both.
  assert.ok(schemaLeaves.length > 50, `expected a populated schema, got ${schemaLeaves.length} leaves`);
});

// @req OPS-BGSTAB-011 AC-2
test('OPS-BGSTAB-011 every entry carries one classification from the closed set and a reason', () => {
  for (const entry of readInventory().entries) {
    assert.ok(
      (CLASSIFICATIONS as readonly string[]).includes(entry.classification),
      `${entry.path}: classification ${entry.classification} is outside the closed set`,
    );
    assert.equal(typeof entry.reason, 'string', `${entry.path}: reason must be a string`);
    assert.ok(entry.reason.trim().length > 0, `${entry.path}: reason must not be blank`);
  }
});

// @req OPS-BGSTAB-011 AC-3
test('OPS-BGSTAB-011 non-inert entries name a real consumer and inert entries name none', () => {
  for (const entry of readInventory().entries) {
    if (entry.classification === 'inert') {
      assert.deepEqual(
        entry.consumers,
        [],
        `${entry.path}: an inert leaf must record no runtime consumer`,
      );
      continue;
    }
    assert.ok(
      entry.consumers.length >= 1,
      `${entry.path}: a ${entry.classification} leaf must name at least one runtime consumer`,
    );
    for (const consumer of entry.consumers) {
      assert.ok(consumer.module.length > 0, `${entry.path}: consumer module must not be blank`);
      assert.ok(consumer.symbol.length > 0, `${entry.path}: consumer symbol must not be blank`);
      // Every attribution has to declare which rule admitted it, so a reader can
      // tell an access chain from bare co-occurrence without re-running the
      // search. An entry with no `match` would let the weaker rule pass for the
      // stronger one silently, which is the failure this field exists to stop.
      assert.ok(
        (CONSUMER_MATCHES as readonly string[]).includes(consumer.match),
        `${entry.path}: consumer ${consumer.module} must record match as one of ${CONSUMER_MATCHES.join(' or ')}, got ${String(consumer.match)}`,
      );
      // The excluded surfaces are the ones that mention every key by
      // construction. Accepting them would make AC-3 satisfiable by plumbing.
      assert.doesNotMatch(
        consumer.module,
        /config\.schema\.ts$|config\.types\.ts$|settings\.types\.ts$|configTemplate\.ts$|\.test\.[cm]?tsx?$|^server\/src\/benchmarks\//u,
        `${entry.path}: ${consumer.module} is schema, plumbing or benchmark code, not a runtime consumer`,
      );
    }
    // Rule: where a leaf has an access chain anywhere on the shipped surface,
    // the weaker co-occurrence candidates for that leaf are discarded. A leaf
    // carrying both would be presenting a guess beside evidence.
    const matches = new Set(entry.consumers.map((consumer) => consumer.match));
    assert.ok(
      !(matches.has('dotted-path') && matches.has('co-occurrence')),
      `${entry.path}: co-occurrence consumers must be dropped once the leaf has a dotted-path match`,
    );
  }

  // The stronger class may not go vacuous: an inventory that recorded nothing as
  // dotted-path would mean the access-chain rule never ran. The weaker class is
  // pinned at its present size instead of being required to be non-empty,
  // because the live state is that every attribution is dotted-path and the
  // co-occurrence fallback has admitted nothing. Pinning the count keeps that
  // fact from changing quietly: admitting the first co-occurrence entry, or
  // losing one later, has to be a deliberate edit to this number and to
  // `consumerDiscovery`, which states the same thing in prose.
  const all = readInventory().entries.flatMap((entry) => entry.consumers);
  assert.ok(
    all.some((consumer) => consumer.match === 'dotted-path'),
    'at least one consumer must be admitted by the dotted-path rule',
  );
  assert.equal(
    all.filter((consumer) => consumer.match === 'co-occurrence').length,
    0,
    'no attribution is admitted by the weaker co-occurrence rule; update this pin and consumerDiscovery together if that changes',
  );
});

// @req OPS-BGSTAB-011 AC-5
test('OPS-BGSTAB-011 the inventory agrees with the existing RuntimeConfigStore classification tables', () => {
  const byPath = new Map(readInventory().entries.map((entry) => [entry.path, entry]));

  // The editable key set and the Wave 6 reserved set are imported from the
  // module that owns them, so this is a reconciliation against the live tables
  // and not against a transcription of them.
  // Both loops below would pass over an empty table without asserting anything,
  // so the tables are checked to be populated first.
  assert.ok(EDITABLE_SETTINGS_KEYS.length > 0, 'EDITABLE_SETTINGS_KEYS must not be empty');
  assert.ok(RESERVED_WAVE6_SETTING_KEYS.size > 0, 'RESERVED_WAVE6_SETTING_KEYS must not be empty');

  for (const key of RESERVED_WAVE6_SETTING_KEYS) {
    const entry = byPath.get(key);
    assert.ok(entry, `${key} is reserved by RuntimeConfigStore but absent from the inventory`);
    assert.equal(
      entry.classification,
      'reserved',
      `${key} is in RESERVED_WAVE6_SETTING_KEYS, so the inventory must classify it reserved`,
    );
  }

  for (const key of EDITABLE_SETTINGS_KEYS) {
    if (RESERVED_WAVE6_SETTING_KEYS.has(key)) continue;
    const entry = byPath.get(key);
    assert.ok(entry, `${key} is editable per FIELD_SCOPES but absent from the inventory`);
    assert.notEqual(
      entry.classification,
      'inert',
      `${key} is offered as an editable setting, so it cannot be inert`,
    );
  }
});

// @req OPS-BGSTAB-011 AC-6
test('OPS-BGSTAB-011 safety-only entries record the bound they protect', () => {
  const safetyOnly = readInventory().entries.filter((e) => e.classification === 'safety-only');
  assert.ok(safetyOnly.length > 0, 'the safety-only class must not be vacuous');
  for (const entry of safetyOnly) {
    assert.equal(
      typeof entry.safetyBound,
      'string',
      `${entry.path}: a safety-only leaf must record the bound it protects`,
    );
    assert.ok((entry.safetyBound ?? '').trim().length > 0, `${entry.path}: safetyBound must not be blank`);
  }

  // The converse, so the field cannot drift onto keys it does not describe.
  for (const entry of readInventory().entries) {
    if (entry.classification === 'safety-only') continue;
    assert.equal(
      entry.safetyBound,
      undefined,
      `${entry.path}: safetyBound belongs to safety-only entries only`,
    );
  }
});

// @req OPS-BGSTAB-011 AC-1
//
// The leaf walk underpins every assertion above, and its failure mode is silent:
// a shape it does not understand collapses a whole subtree into one leaf, or
// disappears entirely, and the count still looks plausible. These tests prove it
// refuses rather than guesses.
test('OPS-BGSTAB-011 the schema walk refuses shapes it would silently mis-count', () => {
  // An empty object contributes neither a leaf nor any children.
  assert.throws(
    () => listConfigSchemaLeafPaths(z.object({ section: z.object({}) })),
    /no keys/u,
    'an object with no keys must be refused, not dropped',
  );

  // Each of these carries child schemas that are not reachable through `shape`,
  // so the walker would emit one leaf where a subtree belongs. The walk decides
  // by allowlist, so a kind nobody anticipated is refused too; `map`, `set`,
  // `promise`, `function` and `custom` are here as that second group — under the
  // previous denylist every one of them collapsed silently into a single leaf.
  const composites: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
    ['union', z.union([z.object({ a: z.string() }), z.object({ b: z.string() })])],
    ['discriminatedUnion', z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), a: z.string() }),
      z.object({ kind: z.literal('b'), b: z.string() }),
    ])],
    ['record', z.record(z.string(), z.object({ a: z.string() }))],
    ['lazy', z.lazy(() => z.object({ a: z.string() }))],
    ['intersection', z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))],
    ['tuple', z.tuple([z.object({ a: z.string() })])],
    ['map', z.map(z.string(), z.object({ a: z.string() }))],
    ['set', z.set(z.object({ a: z.string() }))],
    ['promise', z.promise(z.object({ a: z.string() }))],
    ['function', z.function() as unknown as z.ZodTypeAny],
    ['custom', z.custom<{ a: string }>(() => true)],
    // `z.instanceof` is a scalar, but it reports itself as `custom` and so
    // cannot be told apart from a genuine composite by kind alone. It stays
    // refused, and that is pinned rather than left to be rediscovered.
    ['instanceof', z.instanceof(Date) as unknown as z.ZodTypeAny],
  ];
  for (const [label, child] of composites) {
    assert.throws(
      () => listConfigSchemaLeafPaths(z.object({ section: child })),
      /cannot walk/u,
      `${label} must be refused rather than collapsed into a single leaf`,
    );
  }

  // The allowlisted kinds stay leaves. An array of scalars is the load-bearing
  // one: the operator sets it as a single value, and
  // `fileManager.blockedExtensions` depends on that.
  const leafKinds: ReadonlyArray<readonly [string, z.ZodTypeAny]> = [
    ['array', z.array(z.string())],
    ['string', z.string()],
    ['number', z.number()],
    ['boolean', z.boolean()],
    ['literal', z.literal('a')],
    ['enum', z.enum(['a', 'b'])],
    ['date', z.date()],
    ['null', z.null()],
    ['undefined', z.undefined()],
    ['any', z.any()],
    ['unknown', z.unknown()],
    // The rarely used scalars. Refusing these bought nothing — a scalar has no
    // children to collapse — and only turned a usable config kind into a crash,
    // so they are allowlisted and pinned here as leaves.
    ['bigint', z.bigint()],
    ['symbol', z.symbol()],
    ['nan', z.nan()],
    ['template_literal', z.templateLiteral(['a', z.string()])],
    // The shape `auth.password` actually has: a pipe whose endpoints are
    // scalars, wrapped in a default. The allowlist has to resolve through the
    // pipe or this leaf would start throwing.
    ['preprocessed scalar', z.preprocess((value) => value ?? '', z.string()).default('')],
  ];
  for (const [label, child] of leafKinds) {
    assert.deepEqual(
      listConfigSchemaLeafPaths(z.object({ section: child })),
      ['section'],
      `${label} must stay a single leaf`,
    );
  }
});

// @req OPS-BGSTAB-011 AC-1
test('OPS-BGSTAB-011 the configuration schema still has exactly 81 leaves', () => {
  // The pin the inventory is sized against. It is asserted separately from the
  // coverage test so that a change in the schema's shape is distinguishable
  // from a change in the inventory.
  assert.equal(listConfigSchemaLeafPaths(configSchema).length, 81);
});
