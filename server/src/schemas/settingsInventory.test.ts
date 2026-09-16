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

interface InventoryConsumer {
  readonly module: string;
  readonly symbol: string;
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
      // The excluded surfaces are the ones that mention every key by
      // construction. Accepting them would make AC-3 satisfiable by plumbing.
      assert.doesNotMatch(
        consumer.module,
        /config\.schema\.ts$|config\.types\.ts$|settings\.types\.ts$|configTemplate\.ts$|\.test\.[cm]?tsx?$|^server\/src\/benchmarks\//u,
        `${entry.path}: ${consumer.module} is schema, plumbing or benchmark code, not a runtime consumer`,
      );
    }
  }
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
  // so the walker would emit one leaf where a subtree belongs.
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
  ];
  for (const [label, child] of composites) {
    assert.throws(
      () => listConfigSchemaLeafPaths(z.object({ section: child })),
      /cannot walk/u,
      `${label} must be refused rather than collapsed into a single leaf`,
    );
  }

  // An array of scalars stays a leaf: the operator sets it as one value, and
  // `fileManager.blockedExtensions` depends on that.
  assert.deepEqual(
    listConfigSchemaLeafPaths(z.object({ section: z.array(z.string()) })),
    ['section'],
  );
});

// @req OPS-BGSTAB-011 AC-1
test('OPS-BGSTAB-011 the configuration schema still has exactly 81 leaves', () => {
  // The pin the inventory is sized against. It is asserted separately from the
  // coverage test so that a change in the schema's shape is distinguishable
  // from a change in the inventory.
  assert.equal(listConfigSchemaLeafPaths(configSchema).length, 81);
});
