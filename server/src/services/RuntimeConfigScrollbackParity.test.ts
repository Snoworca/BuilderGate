import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceLimitsSchema } from '../schemas/config.schema.js';
import type { Config } from '../types/config.types.js';
import { RuntimeConfigStore } from './RuntimeConfigStore.js';
import { SessionManager } from './SessionManager.js';
import {
  captureTerminalResourceConfigProvenance,
  registerTerminalResourceConfigProvenance,
} from './TerminalResourcePolicy.js';

/**
 * REL-BGSTAB-007 AC-1/AC-2: one scrollback decision, applied to both sides.
 *
 * The server model reads the compiled policy, which prefers the canonical key
 * and falls back to pty.scrollbackLines as an explicit legacy migration source.
 * The browser reads whatever /api/runtime-config hands it. Those were different
 * readings: with no canonical key in the file, the policy resolved 1000 from the
 * legacy alias while the parsed config carried the canonical key's schema
 * default of 10000, so the browser offered ten times the history the server
 * could recover -- which AC-2 forbids.
 *
 * The fix is to publish the policy's decision rather than the parsed value, so
 * the two agree without anyone having to write the canonical key. A deployment
 * that does write it gets that value on both sides instead.
 */

function rawConfigWithout(canonicalScrollback: false): Record<string, unknown>;
function rawConfigWithout(canonicalScrollback: number): Record<string, unknown>;
function rawConfigWithout(canonicalScrollback: number | false): Record<string, unknown> {
  return {
    server: { port: 4242 },
    pty: { scrollbackLines: 1_000 },
    resourceLimits: {
      terminal: canonicalScrollback === false
        ? { visibleFlushBudgetBytes: 262_144 }
        : { scrollbackLines: canonicalScrollback, visibleFlushBudgetBytes: 262_144 },
    },
  };
}

function storeFor(raw: Record<string, unknown>): RuntimeConfigStore {
  const parsedLimits = resourceLimitsSchema.parse(
    (raw.resourceLimits ?? {}) as Record<string, unknown>,
  );
  const config: Config = {
    server: { port: 4242 },
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: false,
      scrollbackLines: 1_000,
      maxSnapshotBytes: 65_536,
      shell: 'auto',
    },
    session: { idleDelayMs: 200 },
    resourceLimits: parsedLimits,
    stabilityModes: {
      headlessQueueMode: 'observe',
      wsSendMode: 'direct',
      frontendRuntimeResidency: 'bounded',
    },
  } as Config;
  registerTerminalResourceConfigProvenance(config, raw, 'config-repository');
  return new RuntimeConfigStore(config, 'linux');
}

function publishedScrollback(store: RuntimeConfigStore): number {
  return store.getPublicRuntimeConfig('queue').resourceLimits.terminal.scrollbackLines;
}

function decidedScrollback(store: RuntimeConfigStore): number {
  const observation = store.getTerminalResourcePolicyObservation();
  const entry = observation.recentObservations.find(
    (candidate) => candidate.resource === 'resourceLimits.terminal.scrollbackLines'
      && candidate.consumer === 'server.pty.headless-model',
  );
  assert.ok(entry, 'the policy did not observe a server scrollback decision');
  return entry.legacyDecision as number;
}

test('with no canonical key the browser is given the legacy decision, not the schema default', () => {
  const store = storeFor(rawConfigWithout(false));

  assert.equal(decidedScrollback(store), 1_000, 'the policy should fall back to pty.scrollbackLines');
  assert.equal(
    publishedScrollback(store),
    1_000,
    'the browser must not be offered more history than the server retains',
  );
});

test('a canonical key is published as written', () => {
  const store = storeFor(rawConfigWithout(10_000));

  assert.equal(decidedScrollback(store), 10_000);
  assert.equal(publishedScrollback(store), 10_000);
});

test('the published value equals the policy decision on both configurations', () => {
  for (const raw of [rawConfigWithout(false), rawConfigWithout(10_000), rawConfigWithout(4_242)]) {
    const store = storeFor(raw);
    assert.equal(
      publishedScrollback(store),
      decidedScrollback(store),
      `published and decided scrollback disagree for ${JSON.stringify(raw.resourceLimits)}`,
    );
  }
});

/**
 * The server half of the same decision. SessionManager compiles the policy
 * from what it is handed, and it was handed the parsed config -- where the
 * canonical key always exists because zod defaults it. That made every
 * provenance canonical-explicit and put the legacy migration branch out of
 * reach, so a deployment carrying only pty.scrollbackLines got the schema
 * default rather than its own configured value.
 */
function headlessScrollbackFor(raw: Record<string, unknown>): number {
  const parsedLimits = resourceLimitsSchema.parse(
    (raw.resourceLimits ?? {}) as Record<string, unknown>,
  );
  const ptyConfig = {
    termName: 'xterm-256color',
    defaultCols: 80,
    defaultRows: 24,
    useConpty: false,
    scrollbackLines: (raw.pty as { scrollbackLines?: number } | undefined)?.scrollbackLines ?? 1_000,
    maxSnapshotBytes: 65_536,
    shell: 'auto' as const,
  };
  const initial = {
    pty: ptyConfig,
    session: { idleDelayMs: 200 },
    resourceLimits: parsedLimits,
    provenance: captureTerminalResourceConfigProvenance(raw, 'config-repository'),
  };
  const manager = new SessionManager(initial as never, { retainedTerminalShadowEnabled: true } as never);
  return (manager as unknown as {
    compiledTerminalResourcePolicy: { legacyPolicy: { terminal: { scrollbackLines: { value: number } } } };
  }).compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines.value;
}

test('the server model honours a legacy-only configuration instead of the schema default', () => {
  assert.equal(headlessScrollbackFor(rawConfigWithout(false)), 1_000);
});

test('the server model and the published value agree on a legacy-only configuration', () => {
  const raw = rawConfigWithout(false);
  assert.equal(headlessScrollbackFor(raw), publishedScrollback(storeFor(raw)));
});
