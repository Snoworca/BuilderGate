import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalWebglRenderer,
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

function harness(options: {
  failOnActivate?: boolean;
  maxContextLossRetries?: number;
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
