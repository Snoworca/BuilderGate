import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Guards the gate-key inventory in
 * `docs/analysis/2026-09-19.issue21-gate-key-inventory.md` (#21 step 0).
 *
 * The inventory exists because the same table inside issue #21 was written in 2026-08 and
 * four of its claims were false by 2026-09: an override had been changed to the opposite
 * path, a config block the issue said did not exist did, and two gate keys were missing
 * entirely. Nothing failed when that happened, because a document cannot notice that the
 * thing it describes has moved.
 *
 * So this pins what the inventory asserts. It deliberately pins NAMES and DEFAULTS rather
 * than line numbers: this repository's own rule is that line numbers rot within a commit
 * or two, and a guard anchored on them would fail for the wrong reason.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCHEMA = `${REPO_ROOT}server/src/schemas/config.schema.ts`;
const OPERATIONAL_CONFIG = `${REPO_ROOT}server/config.json5`;

/** Every `z.enum(...).default(...)` the schema declares, as name -> default. */
function declaredEnumDefaults(): Map<string, string> {
  const source = readFileSync(SCHEMA, 'utf8');
  const found = new Map<string, string>();
  const pattern = /(\w+):\s*z\.enum\(\[[^\]]*\]\)\.default\('([^']*)'\)/gu;
  for (const match of source.matchAll(pattern)) {
    found.set(match[1], match[2]);
  }
  return found;
}

/**
 * The six keys that gate the new terminal path, plus the schema enums that are NOT gates.
 * A new enum in the schema fails this guard until it is triaged into one list or the other,
 * which is the whole point: issue #21's table went stale by omission, not by error.
 */
const GATE_KEYS: ReadonlyMap<string, { readonly schemaDefault: string; readonly consumer: string }> = new Map([
  ['wsTransportMode', { schemaDefault: 'unified', consumer: 'server/src/services/RuntimeConfigStore.ts' }],
  ['terminalWireFormat', { schemaDefault: 'json', consumer: 'server/src/index.ts' }],
  // Listed as a gate key in the inventory but marked non-gating: the schema offers two
  // values and no runtime branch consumes the difference. Its consumer entry is the file
  // that plumbs it, not a file that branches on it.
  ['headlessQueueMode', { schemaDefault: 'observe', consumer: 'server/src/services/SessionManager.ts' }],
  ['wsSendMode', { schemaDefault: 'direct', consumer: 'server/src/ws/WsRouter.ts' }],
  ['frontendRuntimeResidency', { schemaDefault: 'bounded', consumer: 'frontend/src/hooks/useTerminalRuntimeResidency.ts' }],
  ['hiddenOutputPolicy', { schemaDefault: 'snapshot-restore', consumer: 'server/src/services/TerminalResourcePolicy.ts' }],
]);

/** Schema enums triaged as NOT selecting between the old and new terminal path. */
const NON_GATE_ENUMS: ReadonlyMap<string, string> = new Map([
  ['mode', 'session.processCleanup.mode — process-tree termination, owned by FR-BGSTAB-019'],
  ['windowsPowerShellBackend', 'PTY backend selection, not a terminal-path axis'],
  ['shell', 'shell selection, not a terminal-path axis'],
  ['overflowPolicy', 'headless overflow handling, not a path selector'],
]);

test('#21 step 0 — the terminal-path gate keys and their defaults are the inventoried six', () => {
  const signature = 'the gate-key inventory no longer matches the schema';
  const declared = declaredEnumDefaults();

  for (const [key, expected] of GATE_KEYS) {
    assert.equal(
      declared.get(key),
      expected.schemaDefault,
      `${signature}: ${key} default moved (inventory says '${expected.schemaDefault}')`,
    );
  }
});

test('#21 step 0 — a new schema enum must be triaged as gate or non-gate', () => {
  const signature = 'a config schema enum is in neither the gate list nor the non-gate list';
  const declared = declaredEnumDefaults();

  const untriaged = [...declared.keys()]
    .filter((key) => !GATE_KEYS.has(key) && !NON_GATE_ENUMS.has(key));

  assert.deepEqual(
    untriaged,
    [],
    `${signature}. Decide whether each selects between the old and new terminal path, then `
    + 'update docs/analysis/2026-09-19.issue21-gate-key-inventory.md and this guard together.',
  );
});

test('#21 step 0 — every gate key still has its inventoried consumption site', () => {
  const signature = 'a gate key lost or moved its consumption site';

  for (const [key, { consumer }] of GATE_KEYS) {
    const source = readFileSync(`${REPO_ROOT}${consumer}`, 'utf8');
    assert.ok(
      source.includes(key),
      `${signature}: ${consumer} no longer mentions ${key}`,
    );
  }
});

test('#21 step 0 — the operational config still pins wsSendMode to the old path', () => {
  // Issue #21 states that server/config.json5 overrides this to 'safe-send-enforce', which
  // was the single key it called "already on the new path". It is 'direct' today, and that
  // inverts the issue's starting premise. Whichever value is true, it must be a measured
  // one: this asserts what was measured at 936e0e8c so a change is a decision, not drift.
  const signature = 'server/config.json5 changed which path wsSendMode selects';
  const config = readFileSync(OPERATIONAL_CONFIG, 'utf8');

  assert.match(config, /wsSendMode:\s*"direct"/u, signature);
  assert.match(config, /realtime:\s*\{/u, `${signature}: the realtime block is gone`);
});
