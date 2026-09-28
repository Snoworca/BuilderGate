import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalWebglRenderer,
  createWebglContextPool,
  type WebglContextPool,
  type WebglAddonLike,
} from '../../src/utils/terminalWebglRenderer.ts';

/**
 * Issue #15. The renderer is the easy half; the fallback is the requirement.
 * These drive the lifecycle through an injected addon factory so context loss,
 * activation failure and visibility changes are all exercised without a GPU.
 */

interface Harness {
  renderer: ReturnType<typeof createTerminalWebglRenderer>;
  created: number;
  disposed: number;
  fallbacks: string[];
  loseContext: () => void;
}

// PERF-BGSTAB-020: the existing #15 cases run with a hidden time limit of 0, which is the
// release-on-hide behaviour they were written for.
const releaseOnHide = (): WebglContextPool => createWebglContextPool({ maxAttached: 12, hiddenTtlMs: 0 });

function harness(options: {
  failOnActivate?: boolean;
  maxContextLossRetries?: number;
  pool?: WebglContextPool;
} = {}): Harness {
  const state = { created: 0, disposed: 0, fallbacks: [] as string[] };
  let contextLossHandler: (() => void) | null = null;

  const renderer = createTerminalWebglRenderer({
    createAddon: (): WebglAddonLike => {
      state.created += 1;
      return {
        onContextLoss: (handler) => {
          contextLossHandler = handler;
          return { dispose: () => { contextLossHandler = null; } };
        },
        dispose: () => { state.disposed += 1; },
      };
    },
    loadAddon: () => {
      if (options.failOnActivate) {
        throw new Error('WebGL unavailable in this context');
      }
    },
    onFallback: (reason) => { state.fallbacks.push(reason); },
    pool: options.pool ?? releaseOnHide(),
    ...(options.maxContextLossRetries === undefined
      ? {}
      : { maxContextLossRetries: options.maxContextLossRetries }),
  });

  return {
    renderer,
    get created() { return state.created; },
    get disposed() { return state.disposed; },
    get fallbacks() { return state.fallbacks; },
    loseContext: () => {
      if (!contextLossHandler) throw new Error('no context-loss handler registered');
      contextLossHandler();
    },
  } as Harness;
}

test('#15 attaches only when the terminal is visible', () => {
  const h = harness();
  h.renderer.sync(false);
  assert.equal(h.created, 0, 'a hidden terminal must not take a WebGL context');
  assert.equal(h.renderer.getState(), 'detached');

  h.renderer.sync(true);
  assert.equal(h.created, 1);
  assert.equal(h.renderer.getState(), 'attached');
});

test('#15 releases the context when the terminal is hidden', () => {
  const h = harness();
  h.renderer.sync(true);
  h.renderer.sync(false);
  assert.equal(h.disposed, 1, 'hiding must release the context for other tabs');
  assert.equal(h.renderer.getState(), 'detached');

  h.renderer.sync(true);
  assert.equal(h.created, 2, 'revealing re-attaches');
});

test('#15 repeated sync on an unchanged visibility does not churn contexts', () => {
  const h = harness();
  h.renderer.sync(true);
  h.renderer.sync(true);
  h.renderer.sync(true);
  assert.equal(h.created, 1);
  assert.equal(h.disposed, 0);
});

test('#15 context loss disposes the addon and reports the fallback', () => {
  const h = harness();
  h.renderer.sync(true);
  h.loseContext();

  assert.equal(h.disposed, 1, 'the dead addon must be disposed, not left attached');
  assert.deepEqual(h.fallbacks, ['context-loss']);
  assert.equal(
    h.renderer.getState(),
    'detached',
    'after context loss the terminal is on the DOM renderer, not still claiming WebGL',
  );
});

test('#15 a terminal that lost its context recovers on the next reveal', () => {
  const h = harness({ maxContextLossRetries: 2 });
  h.renderer.sync(true);
  h.loseContext();
  h.renderer.sync(false);
  h.renderer.sync(true);
  assert.equal(h.created, 2, 'one loss must not permanently demote the terminal');
  assert.equal(h.renderer.getState(), 'attached');
});

test('#15 repeated context loss stops retrying instead of thrashing', () => {
  const h = harness({ maxContextLossRetries: 2 });
  h.renderer.sync(true);
  h.loseContext();
  h.renderer.sync(true);
  h.loseContext();
  const createdBefore = h.created;

  h.renderer.sync(false);
  h.renderer.sync(true);

  assert.equal(h.created, createdBefore, 'the retry budget must be spent, not renewed');
  assert.equal(h.renderer.getState(), 'unavailable');
  assert.equal(h.fallbacks.at(-1), 'context-loss-budget-exhausted');
});

test('#15 an addon that fails to activate falls back without throwing', () => {
  const h = harness({ failOnActivate: true });
  assert.doesNotThrow(() => h.renderer.sync(true));
  assert.equal(h.renderer.getState(), 'unavailable');
  assert.deepEqual(h.fallbacks, ['activation-failed']);

  h.renderer.sync(false);
  h.renderer.sync(true);
  assert.equal(h.created, 1, 'an unavailable renderer must not be retried on every reveal');
});

test('#15 dispose releases the context and stops responding to visibility', () => {
  const h = harness();
  h.renderer.sync(true);
  h.renderer.dispose();
  assert.equal(h.disposed, 1);
  assert.equal(h.renderer.getState(), 'detached');

  h.renderer.sync(true);
  assert.equal(h.created, 1, 'a disposed renderer must not re-attach');
});

// PERF-BGSTAB-020 — a hidden terminal keeps its WebGL context within a page-wide budget.

function fakeClock() {
  let now = 0; let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimeout: (run: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, run }); return id; },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { timers.delete(id); t.run(); }
      }
    },
  };
}

test('PERF-BGSTAB-020 AC-1: hide then reveal within the time limit reuses the addon', () => {
  const clock = fakeClock();
  const pool = createWebglContextPool({ maxAttached: 12, hiddenTtlMs: 60_000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const h = harness({ pool });
  h.renderer.sync(true);
  h.renderer.sync(false);
  assert.equal(h.disposed, 0, 'a just-hidden terminal keeps its context');
  assert.equal(h.renderer.getState(), 'attached');
  clock.advance(30_000);
  h.renderer.sync(true);
  assert.equal(h.created, 1, 'revealing reuses the kept addon');
  clock.advance(120_000);
  assert.equal(h.disposed, 0, 'a visible terminal is not released by the old hidden timer');
});

test('PERF-BGSTAB-020 AC-2: the hidden time limit releases the context', () => {
  const clock = fakeClock();
  const pool = createWebglContextPool({ maxAttached: 12, hiddenTtlMs: 60_000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const h = harness({ pool });
  h.renderer.sync(true);
  h.renderer.sync(false);
  clock.advance(60_000);
  assert.equal(h.disposed, 1);
  assert.equal(h.renderer.getState(), 'detached');
  h.renderer.sync(true);
  assert.equal(h.created, 2, 'a released terminal re-attaches on reveal');
});

test('PERF-BGSTAB-020 AC-3: over budget, the least recently hidden context goes first and visible ones stay', () => {
  const clock = fakeClock();
  const pool = createWebglContextPool({ maxAttached: 3, hiddenTtlMs: 600_000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const [a, b, c, d] = [harness({ pool }), harness({ pool }), harness({ pool }), harness({ pool })];
  a.renderer.sync(true); b.renderer.sync(true);
  a.renderer.sync(false); b.renderer.sync(false); // two kept hidden, a older
  c.renderer.sync(true); // 3 attached: within budget
  assert.equal(a.disposed + b.disposed, 0);
  d.renderer.sync(true); // 4 attached: over budget by one
  assert.equal(a.disposed, 1, 'the least recently hidden context is released');
  assert.equal(b.disposed, 0);
  const e = harness({ pool });
  e.renderer.sync(true); // over again: b goes, visible c/d/e stay even though still over
  assert.equal(b.disposed, 1);
  const f = harness({ pool });
  f.renderer.sync(true);
  assert.equal(c.disposed + d.disposed + e.disposed + f.disposed, 0, 'a visible context is never released for the budget');
});

test('PERF-BGSTAB-020 AC-4: dispose and context loss take a kept hidden context out of the pool', () => {
  const clock = fakeClock();
  const pool = createWebglContextPool({ maxAttached: 2, hiddenTtlMs: 600_000, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  const a = harness({ pool });
  a.renderer.sync(true); a.renderer.sync(false);
  a.loseContext();
  assert.equal(a.disposed, 1);
  assert.deepEqual(a.fallbacks, ['context-loss']);
  const b = harness({ pool });
  b.renderer.sync(true); b.renderer.sync(false);
  b.renderer.dispose();
  assert.equal(b.disposed, 1);
  clock.advance(700_000);
  assert.equal(a.disposed + b.disposed, 2, 'no double release from a stale timer');
  const [c, d] = [harness({ pool }), harness({ pool })];
  c.renderer.sync(true); d.renderer.sync(true);
  assert.equal(c.disposed + d.disposed, 0, 'released entries no longer count against the budget');
});
