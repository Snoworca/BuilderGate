import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createHiddenOutputState,
  resolveHiddenOutput,
} from '../../src/utils/terminalHiddenOutput.ts';
import { recordTerminalDebugEvent } from '../../src/utils/terminalDebugCapture.ts';

/**
 * IR-BGSTAB-001: the codec-neutral delivery hands the output handler a deferred
 * `previewText()` so a byte-backed adapter can skip decoding. That only holds if
 * every consumer forwards the deferral instead of collapsing it at the call site.
 *
 * The decision of whether the preview is needed lives inside the consumers —
 * `resolveHiddenOutput` needs it only for a `debug-tail` skip with a positive tail
 * budget, and `recordTerminalDebugEvent` only when capture is on for the session.
 * Duplicating either rule in `TerminalContainer` would let the two copies drift.
 */

function countingPreview(text: string): { preview: () => string; calls: () => number } {
  let calls = 0;
  return {
    preview: () => {
      calls += 1;
      return text;
    },
    calls: () => calls,
  };
}

// Both visibilities, because under `write-hidden` a VISIBLE terminal is the normal
// path, not the exception. Testing only `isVisible: false` leaves a mutant that
// decodes on every live frame — the exact cost this change exists to remove.
for (const isVisible of [false, true]) {
  test(`resolveHiddenOutput leaves the preview unevaluated when the policy writes through (visible=${isVisible})`, () => {
    const { preview, calls } = countingPreview('unused');
    const decision = resolveHiddenOutput(createHiddenOutputState(), {
      isVisible,
      byteLength: 12,
      data: preview,
      hiddenOutputPolicy: 'write-hidden',
    });

    assert.equal(decision.action, 'write');
    assert.equal(calls(), 0, 'write-hidden returns before the preview can matter');
  });
}

// The skip branch is reachable with `isVisible: true` once the state is already
// skipped — the hidden-to-visible window before recovery clears it. Every other
// negative starts from `createHiddenOutputState()` (`skipped: false`), leaving this
// state axis entirely uncovered.
test('resolveHiddenOutput leaves the preview unevaluated for a visible frame after a skip', () => {
  const { preview, calls } = countingPreview('unused');
  const decision = resolveHiddenOutput(
    { skipped: true, skippedBytes: 5, debugTail: '' },
    {
      isVisible: true,
      byteLength: 12,
      data: preview,
      hiddenOutputPolicy: 'snapshot-restore',
      hiddenOutputTailBytes: 64,
    },
  );

  assert.equal(decision.action, 'skip', 'an already-skipped state keeps skipping while visible');
  assert.equal(
    calls(),
    0,
    'snapshot-restore zeroes the budget even on the visible-after-skip path',
  );
});

// The negative above covers the visible-after-skip state only under `snapshot-restore`,
// where the budget is zero and no resolve is legitimate. Under `debug-tail` one resolve
// IS legitimate, which is exactly where a second, wasted one can hide.
test('resolveHiddenOutput evaluates the preview once on a visible-after-skip debug-tail frame', () => {
  const { preview, calls } = countingPreview('tail-text');
  const decision = resolveHiddenOutput(
    { skipped: true, skippedBytes: 5, debugTail: '' },
    {
      isVisible: true,
      byteLength: 12,
      data: preview,
      hiddenOutputPolicy: 'debug-tail',
      hiddenOutputTailBytes: 64,
    },
  );

  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextState.debugTail, 'tail-text');
  assert.equal(calls(), 1, 'the visible-after-skip path must not resolve twice');
});

// `hiddenOutputTailBytes` omitted, not an explicit 0 — otherwise `?? 0` is unpinned and
// could become `?? 64`, decoding on every hidden frame.
test('resolveHiddenOutput leaves the preview unevaluated when the tail budget is omitted', () => {
  const { preview, calls } = countingPreview('unused');
  const decision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 12,
    data: preview,
    hiddenOutputPolicy: 'debug-tail',
  });

  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextState.debugTail, '');
  assert.equal(calls(), 0, 'an omitted tail budget defaults to 0, which reads nothing');
});

test('resolveHiddenOutput leaves the preview unevaluated for a visible write', () => {
  const { preview, calls } = countingPreview('unused');
  const decision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: true,
    byteLength: 12,
    data: preview,
    hiddenOutputPolicy: 'debug-tail',
    hiddenOutputTailBytes: 64,
  });

  assert.equal(decision.action, 'write');
  assert.equal(calls(), 0, 'a visible write never reaches the debug tail');
});

test('resolveHiddenOutput leaves the preview unevaluated when the tail budget is zero', () => {
  const zeroBudget = countingPreview('unused');
  const zeroBudgetDecision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 12,
    data: zeroBudget.preview,
    hiddenOutputPolicy: 'debug-tail',
    hiddenOutputTailBytes: 0,
  });

  assert.equal(zeroBudgetDecision.action, 'skip');
  assert.equal(zeroBudgetDecision.nextState.debugTail, '');
  assert.equal(zeroBudget.calls(), 0, 'a zero tail budget discards the preview unread');

  const nonDebugPolicy = countingPreview('unused');
  const nonDebugDecision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 12,
    data: nonDebugPolicy.preview,
    hiddenOutputPolicy: 'snapshot-restore',
    hiddenOutputTailBytes: 64,
  });

  assert.equal(nonDebugDecision.action, 'skip');
  assert.equal(nonDebugDecision.nextState.debugTail, '');
  assert.equal(nonDebugPolicy.calls(), 0, 'snapshot-restore zeroes the budget regardless of tail bytes');
});

// Every other negative here passes an EXPLICIT policy, so none of them exercises
// `resolveHiddenOutput`'s own default (`input.hiddenOutputPolicy ?? 'snapshot-restore'`).
// Without this case, an implementation that materializes eagerly on the defaulted path
// and then discards the result passes the entire repo — measured, not hypothetical.
test('resolveHiddenOutput leaves the preview unevaluated when the policy is defaulted', () => {
  const { preview, calls } = countingPreview('unused');
  const decision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 12,
    data: preview,
    hiddenOutputTailBytes: 64,
  });

  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextState.debugTail, '');
  assert.equal(calls(), 0, "the defaulted policy is 'snapshot-restore', which zeroes the tail budget");
});

// Boundary control for the negatives above. Without a case that DOES consume
// the preview, an implementation that ignored `data` everywhere would pass them all.
test('resolveHiddenOutput evaluates the preview exactly once for a debug-tail skip', () => {
  const { preview, calls } = countingPreview('tail-text');
  const decision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 12,
    data: preview,
    hiddenOutputPolicy: 'debug-tail',
    hiddenOutputTailBytes: 64,
  });

  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextState.debugTail, 'tail-text');
  assert.equal(calls(), 1, 'the preview is read once, not per byte-budget probe');
});

// The positive control above stays under budget, so it exits `appendDebugTail` early
// and never enters the trim loop. Without this case, re-resolving inside that loop
// costs a second decode per frame once the tail fills up, unseen.
test('resolveHiddenOutput evaluates the preview once even when the tail must be trimmed', () => {
  const { preview, calls } = countingPreview('abcdefghij');
  const decision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 10,
    data: preview,
    hiddenOutputPolicy: 'debug-tail',
    hiddenOutputTailBytes: 4,
  });

  assert.equal(decision.action, 'skip');
  assert.equal(decision.nextState.debugTail, 'ghij', 'the tail keeps the last 4 bytes');
  assert.equal(calls(), 1, 'trimming must not re-resolve the preview');
});

test('resolveHiddenOutput still accepts an already-materialized preview string', () => {
  const decision = resolveHiddenOutput(createHiddenOutputState(), {
    isVisible: false,
    byteLength: 12,
    data: 'literal-text',
    hiddenOutputPolicy: 'debug-tail',
    hiddenOutputTailBytes: 64,
  });

  assert.equal(decision.nextState.debugTail, 'literal-text');
});

function withBrowserHost<T>(run: (fakeWindow: Window) => T): T {
  const globalWithBrowser = globalThis as typeof globalThis & {
    window?: Window;
    localStorage?: Storage;
  };
  const previousWindow = globalWithBrowser.window;
  const previousLocalStorage = globalWithBrowser.localStorage;
  const fakeWindow = { location: { hostname: 'localhost' } } as unknown as Window;

  Object.defineProperty(globalWithBrowser, 'window', {
    configurable: true,
    value: fakeWindow,
    writable: true,
  });
  Object.defineProperty(globalWithBrowser, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => undefined,
    } as unknown as Storage,
    writable: true,
  });

  try {
    return run(fakeWindow);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalWithBrowser, 'window');
    } else {
      Object.defineProperty(globalWithBrowser, 'window', {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    }
    if (previousLocalStorage === undefined) {
      Reflect.deleteProperty(globalWithBrowser, 'localStorage');
    } else {
      Object.defineProperty(globalWithBrowser, 'localStorage', {
        configurable: true,
        value: previousLocalStorage,
        writable: true,
      });
    }
  }
}

test('recordTerminalDebugEvent leaves the preview unevaluated while capture is off', () => {
  withBrowserHost(fakeWindow => {
    const { preview, calls } = countingPreview('never-read');
    recordTerminalDebugEvent('session-preview-off', 'live_output_received', { byteLength: 3 }, preview);

    const store = fakeWindow.__buildergateTerminalDebug;
    assert.ok(store, 'debug store must initialize for the browser test host');
    assert.equal(store.isEnabled('session-preview-off'), false);
    assert.equal(calls(), 0, 'a disabled session returns before the preview can matter');
  });
});

test('recordTerminalDebugEvent evaluates the preview exactly once while capture is on', () => {
  withBrowserHost(fakeWindow => {
    // The store is created lazily on the first record, so prime it before enabling.
    recordTerminalDebugEvent('session-preview-on', 'capture_probe');
    const store = fakeWindow.__buildergateTerminalDebug;
    assert.ok(store, 'debug store must initialize for the browser test host');
    store.enable('session-preview-on');
    store.clear('session-preview-on');

    const { preview, calls } = countingPreview('captured-text');
    recordTerminalDebugEvent('session-preview-on', 'live_output_received', { byteLength: 3 }, preview);

    assert.equal(calls(), 1, 'an enabled session reads the preview once');

    // A second frame on the SAME session. Without it, memoizing the first resolve per
    // session passes every call-count assertion while recording stale text forever —
    // a defect that looks lazier and is silently wrong.
    const second = countingPreview('second-text');
    recordTerminalDebugEvent(
      'session-preview-on',
      'live_output_received',
      { byteLength: 4 },
      second.preview,
    );
    assert.equal(second.calls(), 1, 'each frame resolves its own preview');

    const recorded = store.events.filter(event => event.sessionId === 'session-preview-on');
    assert.equal(recorded.length, 2);
    assert.match(recorded[0].preview ?? '', /captured-text/u);
    assert.match(recorded[1].preview ?? '', /second-text/u, 'the second frame must not reuse the first');
  });
});

// String-path control, mirroring the one `resolveHiddenOutput` already has above.
// Without it, resolving the union as `typeof rawPreview === 'function' ? rawPreview()
// : undefined` silently drops the preview from every string call site (~24 in src)
// and still passes every other test in this file.
test('recordTerminalDebugEvent records an already-materialized preview string', () => {
  withBrowserHost(fakeWindow => {
    recordTerminalDebugEvent('session-preview-string', 'capture_probe');
    const store = fakeWindow.__buildergateTerminalDebug;
    assert.ok(store, 'debug store must initialize for the browser test host');
    store.enable('session-preview-string');
    store.clear('session-preview-string');

    recordTerminalDebugEvent(
      'session-preview-string',
      'live_output_received',
      { byteLength: 3 },
      'literal-preview',
    );

    const recorded = store.events.filter(event => event.sessionId === 'session-preview-string');
    assert.equal(recorded.length, 1);
    assert.match(
      recorded[0].preview ?? '',
      /literal-preview/u,
      'a string preview must survive the union resolution, not just a thunk',
    );
  });
});

// Both capture scopes: the two tests above enable a single session, so narrowing
// `isEnabled` to the per-session set — dropping global capture — goes unnoticed.
test('recordTerminalDebugEvent resolves the preview under global capture too', () => {
  withBrowserHost(fakeWindow => {
    recordTerminalDebugEvent('session-global-capture', 'capture_probe');
    const store = fakeWindow.__buildergateTerminalDebug;
    assert.ok(store, 'debug store must initialize for the browser test host');
    store.enable();
    store.clear('session-global-capture');

    const { preview, calls } = countingPreview('global-text');
    recordTerminalDebugEvent('session-global-capture', 'live_output_received', {}, preview);

    assert.equal(calls(), 1, 'global capture must read the preview like a per-session enable');
    const recorded = store.events.filter(event => event.sessionId === 'session-global-capture');
    assert.equal(recorded.length, 1);
    assert.match(recorded[0].preview ?? '', /global-text/u);
  });
});

const containerSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
  'utf8',
);

test('TerminalContainer forwards the delivery preview without evaluating it', () => {
  const signature = 'IR-BGSTAB-001: a byte-backed adapter must not decode every live frame';
  const handlerStart = containerSource.indexOf('const hiddenDecision = resolveHiddenOutput(');
  assert.notEqual(handlerStart, -1, signature);
  const handlerChunk = containerSource.slice(handlerStart, handlerStart + 1200);

  assert.match(handlerChunk, /data: delivery\.previewText,/u, signature);
  assert.match(
    handlerChunk,
    /recordTerminalDebugEvent\([\s\S]*?'live_output_received'[\s\S]*?\}, delivery\.previewText\)/u,
    signature,
  );
  // Not bound to the `delivery` receiver: aliasing it first
  // (`const previewText = delivery.previewText; previewText();`) collapses the
  // deferral just as thoroughly and would slip past a receiver-specific pattern.
  assert.doesNotMatch(
    containerSource,
    /\.previewText\(\)/u,
    'evaluating previewText() at the call site defeats the deferral the IR exists to provide',
  );
});
