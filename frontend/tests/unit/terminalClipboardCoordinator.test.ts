import assert from 'node:assert/strict';
import { test } from 'node:test';

type ClipboardSource = 'keyboard' | 'tab-context-menu' | 'grid-context-menu' | 'command-preset';

interface ClipboardTarget {
  terminalIdentity: object;
  sessionId: string;
  sessionGeneration: number;
  viewGeneration: number;
}

interface ClipboardSelection {
  text: string;
  rangeKey: string;
}

interface ClipboardActionResult {
  ok: boolean;
  action: 'copy' | 'paste';
  source: ClipboardSource;
  reason?: string;
}

interface ClipboardCoordinator {
  copySelection(source: ClipboardSource): Promise<ClipboardActionResult>;
  pasteClipboard(source: ClipboardSource): Promise<ClipboardActionResult>;
  pasteText(text: string, source: ClipboardSource): ClipboardActionResult;
  activate(): void;
  dispose(): void;
}

interface ClipboardObservation {
  action: 'copy' | 'paste';
  source: ClipboardSource;
  outcome: 'accepted' | 'rejected';
  reason?: string;
  payloadBytes: number;
  sessionId?: string;
  sessionGeneration?: number;
  viewGeneration?: number;
}

interface CoordinatorFactoryOptions {
  captureTarget: () => ClipboardTarget | null;
  isTargetCurrent: (target: ClipboardTarget) => boolean;
  captureSelection: (target: ClipboardTarget) => ClipboardSelection | null;
  isSelectionCurrent: (target: ClipboardTarget, selection: ClipboardSelection) => boolean;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  admitPaste: (
    target: ClipboardTarget,
    text: string,
    source: ClipboardSource,
  ) => { ok: true } | { ok: false; reason: string };
  clearSelection: (target: ClipboardTarget) => void;
  focus: (target: ClipboardTarget) => void;
  observe: (event: ClipboardObservation) => void;
}

type CoordinatorFactory = (options: CoordinatorFactoryOptions) => ClipboardCoordinator;

const RED_SIGNATURES = {
  copySuccess: 'expected copy to clear and focus only after successful write for the same target and selection',
  copyFailure: 'expected copy failure to preserve selection and expose an explicit rejection',
  copySuperseded: 'expected a superseded copy completion to preserve the replacement target selection',
  asyncPasteContext: 'expected async clipboard read to reject a disposed or replaced target before admission',
  pasteOnce: 'expected one programmatic paste action to enter the existing admission pipeline exactly once',
  multiline: 'expected multiline paste to preserve exact text or reject explicitly without fallback',
  dispose: 'expected disposed coordinator to reject programmatic paste without admission or focus',
  redaction: 'expected clipboard observations and results to exclude raw copy and paste payloads',
  copyEntryContext: 'expected copy to reject a missing or superseded target before reading the selection',
  copyNoSelection: 'expected copy without a selection to reject explicitly without writing or clearing',
  pasteTextNoTarget: 'expected pasteText without a live target to reject without admission or focus',
  activateLive: 'expected activate on a live coordinator to leave in-flight work owned by its own epoch',
  pasteAccepted: 'expected an accepted programmatic paste to be observed with its target identity',
  pasteClipboardEntry: 'expected pasteClipboard to reject a missing or superseded target before reading the clipboard',
  clipboardReadFailure: 'expected a failed clipboard read to reject as clipboard-read-failed without admission',
  staleTargetAdmission: 'expected a captured but superseded target to be rejected before admission',
} as const;

async function requireCoordinatorFactory(signature: string): Promise<CoordinatorFactory> {
  try {
    const module = await import('../../src/utils/terminalClipboardCoordinator.ts');
    const factory = (module as { createTerminalClipboardCoordinator?: unknown })
      .createTerminalClipboardCoordinator;
    assert.equal(typeof factory, 'function', signature);
    return factory as CoordinatorFactory;
  } catch (error) {
    const expectedCoordinatorUrl = new URL(
      '../../src/utils/terminalClipboardCoordinator.ts',
      import.meta.url,
    ).href;
    const missingCoordinatorModule = error instanceof Error
      && 'url' in error
      && error.url === expectedCoordinatorUrl;
    if (
      error instanceof Error
      && missingCoordinatorModule
      && ('code' in error ? error.code === 'ERR_MODULE_NOT_FOUND' : /Cannot find module/.test(error.message))
    ) {
      assert.fail(signature);
    }
    throw error;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides: Partial<CoordinatorFactoryOptions> = {}) {
  let currentTarget: ClipboardTarget | null = {
    terminalIdentity: {},
    sessionId: 'session-a',
    sessionGeneration: 7,
    viewGeneration: 11,
  };
  let currentSelection: ClipboardSelection | null = {
    text: 'copy fixture',
    rangeKey: '4:2-4:14',
  };
  const admitted: Array<{ target: ClipboardTarget; text: string; source: ClipboardSource }> = [];
  const written: string[] = [];
  const cleared: ClipboardTarget[] = [];
  const focused: ClipboardTarget[] = [];
  const observations: ClipboardObservation[] = [];

  const options: CoordinatorFactoryOptions = {
    captureTarget: () => currentTarget,
    isTargetCurrent: (target) => currentTarget === target,
    captureSelection: () => currentSelection,
    isSelectionCurrent: (target, selection) => (
      currentTarget === target
      && currentSelection?.text === selection.text
      && currentSelection.rangeKey === selection.rangeKey
    ),
    readClipboardText: async () => 'paste fixture',
    writeClipboardText: async (text) => { written.push(text); },
    admitPaste: (target, text, source) => {
      admitted.push({ target, text, source });
      return { ok: true };
    },
    clearSelection: (target) => cleared.push(target),
    focus: (target) => focused.push(target),
    observe: (event) => observations.push(event),
    ...overrides,
  };

  return {
    options,
    admitted,
    written,
    cleared,
    focused,
    observations,
    get target() { return currentTarget; },
    set target(value: ClipboardTarget | null) { currentTarget = value; },
    get selection() { return currentSelection; },
    set selection(value: ClipboardSelection | null) { currentSelection = value; },
  };
}

test('clipboard coordinator RED — successful copy clears and focuses after write settles', async () => {
  const signature = RED_SIGNATURES.copySuccess;
  const factory = await requireCoordinatorFactory(signature);
  const write = deferred<void>();
  const written: string[] = [];
  const harness = createHarness({
    writeClipboardText: (text) => {
      written.push(text);
      return write.promise;
    },
  });
  const coordinator = factory(harness.options);

  const pending = coordinator.copySelection('keyboard');
  assert.equal(harness.cleared.length, 0, signature);
  assert.equal(harness.focused.length, 0, signature);
  write.resolve(undefined);
  const result = await pending;

  assert.deepEqual(result, { ok: true, action: 'copy', source: 'keyboard' }, signature);
  assert.deepEqual(written, ['copy fixture'], signature);
  assert.equal(harness.cleared.length, 1, signature);
  assert.equal(harness.focused.length, 1, signature);
});

test('clipboard coordinator RED — rejected copy preserves selection and reports failure', async () => {
  const signature = RED_SIGNATURES.copyFailure;
  const harness = createHarness({
    writeClipboardText: async () => { throw new Error('permission denied'); },
  });
  const factory = await requireCoordinatorFactory(signature);
  const coordinator = factory(harness.options);

  const result = await coordinator.copySelection('tab-context-menu');

  assert.deepEqual(
    result,
    { ok: false, action: 'copy', source: 'tab-context-menu', reason: 'clipboard-write-failed' },
    signature,
  );
  assert.equal(harness.cleared.length, 0, signature);
  assert.equal(harness.focused.length, 0, signature);
});

test('clipboard coordinator RED — target-only and selection-only replacement each supersede copy completion', async () => {
  const signature = RED_SIGNATURES.copySuperseded;
  const factory = await requireCoordinatorFactory(signature);

  const targetWrite = deferred<void>();
  const targetHarness = createHarness({ writeClipboardText: () => targetWrite.promise });
  const targetCoordinator = factory(targetHarness.options);
  const targetPending = targetCoordinator.copySelection('grid-context-menu');
  targetHarness.target = {
    terminalIdentity: {},
    sessionId: 'session-b',
    sessionGeneration: 8,
    viewGeneration: 1,
  };
  targetWrite.resolve(undefined);
  const targetResult = await targetPending;

  const selectionWrite = deferred<void>();
  const selectionHarness = createHarness({ writeClipboardText: () => selectionWrite.promise });
  const selectionCoordinator = factory(selectionHarness.options);
  const selectionPending = selectionCoordinator.copySelection('grid-context-menu');
  selectionHarness.selection = { text: 'replacement fixture', rangeKey: '1:0-1:19' };
  selectionWrite.resolve(undefined);
  const selectionResult = await selectionPending;

  assert.deepEqual(
    targetResult,
    { ok: false, action: 'copy', source: 'grid-context-menu', reason: 'context-changed' },
    signature,
  );
  assert.deepEqual(selectionResult, targetResult, signature);
  assert.equal(targetHarness.cleared.length, 0, signature);
  assert.equal(targetHarness.focused.length, 0, signature);
  assert.equal(selectionHarness.cleared.length, 0, signature);
  assert.equal(selectionHarness.focused.length, 0, signature);
});

test('clipboard coordinator RED — async clipboard read isolates context replacement and dispose races', async () => {
  const signature = RED_SIGNATURES.asyncPasteContext;
  const factory = await requireCoordinatorFactory(signature);

  const contextRead = deferred<string>();
  const contextHarness = createHarness({ readClipboardText: () => contextRead.promise });
  const contextCoordinator = factory(contextHarness.options);
  const contextPending = contextCoordinator.pasteClipboard('tab-context-menu');
  contextHarness.target = {
    terminalIdentity: {},
    sessionId: 'session-replacement',
    sessionGeneration: 9,
    viewGeneration: 1,
  };
  contextRead.resolve('late context fixture');
  const contextResult = await contextPending;

  const disposeRead = deferred<string>();
  const disposeHarness = createHarness({ readClipboardText: () => disposeRead.promise });
  const disposeCoordinator = factory(disposeHarness.options);
  const disposePending = disposeCoordinator.pasteClipboard('tab-context-menu');
  disposeCoordinator.dispose();
  disposeRead.resolve('late dispose fixture');
  const disposeResult = await disposePending;

  assert.deepEqual(
    contextResult,
    { ok: false, action: 'paste', source: 'tab-context-menu', reason: 'context-changed' },
    signature,
  );
  assert.deepEqual(disposeResult, contextResult, signature);
  assert.equal(contextHarness.admitted.length, 0, signature);
  assert.equal(contextHarness.focused.length, 0, signature);
  assert.equal(disposeHarness.admitted.length, 0, signature);
  assert.equal(disposeHarness.focused.length, 0, signature);
});

test('clipboard coordinator RED — accepted programmatic paste has one admission and one focus', async () => {
  const signature = RED_SIGNATURES.pasteOnce;
  const harness = createHarness();
  const factory = await requireCoordinatorFactory(signature);
  const coordinator = factory(harness.options);

  const result = coordinator.pasteText('one action fixture', 'command-preset');

  assert.deepEqual(result, { ok: true, action: 'paste', source: 'command-preset' }, signature);
  assert.equal(harness.admitted.length, 1, signature);
  assert.equal(harness.admitted[0]?.text, 'one action fixture', signature);
  assert.equal(harness.focused.length, 1, signature);
});

test('clipboard coordinator RED — multiline paste is exact and rejection has no fallback', async () => {
  const signature = RED_SIGNATURES.multiline;
  const multiline = 'first line\r\n둘째 줄\n😀';
  const admitted: string[] = [];
  const harness = createHarness({
    admitPaste: (_target, text) => {
      admitted.push(text);
      return text === multiline
        ? { ok: true }
        : { ok: false, reason: 'unsupported-multiline-paste' };
    },
  });
  const factory = await requireCoordinatorFactory(signature);
  const coordinator = factory(harness.options);

  const accepted = coordinator.pasteText(multiline, 'grid-context-menu');
  const rejected = coordinator.pasteText('fallback must not run', 'grid-context-menu');

  assert.deepEqual(accepted, { ok: true, action: 'paste', source: 'grid-context-menu' }, signature);
  assert.deepEqual(
    rejected,
    { ok: false, action: 'paste', source: 'grid-context-menu', reason: 'unsupported-multiline-paste' },
    signature,
  );
  assert.deepEqual(admitted, [multiline, 'fallback must not run'], signature);
  assert.equal(harness.focused.length, 1, signature);
});

test('clipboard coordinator RED — dispose rejects later paste without side effects', async () => {
  const signature = RED_SIGNATURES.dispose;
  const harness = createHarness();
  const factory = await requireCoordinatorFactory(signature);
  const coordinator = factory(harness.options);
  coordinator.dispose();

  const result = coordinator.pasteText('disposed fixture', 'command-preset');

  assert.deepEqual(
    result,
    { ok: false, action: 'paste', source: 'command-preset', reason: 'context-changed' },
    signature,
  );
  assert.equal(harness.admitted.length, 0, signature);
  assert.equal(harness.focused.length, 0, signature);
});

test('clipboard coordinator RED — observations and results redact raw clipboard payloads', async () => {
  const signature = RED_SIGNATURES.redaction;
  const copyPayload = 'copy-sensitive-fixture-79aa';
  const pastePayload = 'paste-sensitive-fixture-a441';
  const harness = createHarness({
    captureSelection: () => ({ text: copyPayload, rangeKey: 'redacted-range' }),
    isSelectionCurrent: () => true,
    readClipboardText: async () => pastePayload,
    admitPaste: () => ({ ok: false, reason: 'transport-barrier' }),
  });
  const factory = await requireCoordinatorFactory(signature);
  const coordinator = factory(harness.options);

  const copyResult = await coordinator.copySelection('keyboard');
  const pasteResult = await coordinator.pasteClipboard('grid-context-menu');
  const durableShape = JSON.stringify({ copyResult, pasteResult, observations: harness.observations });

  assert.equal(durableShape.includes(copyPayload), false, signature);
  assert.equal(durableShape.includes(pastePayload), false, signature);
  assert.deepEqual(
    harness.observations.map(({ action, outcome, payloadBytes }) => ({ action, outcome, payloadBytes })),
    [
      { action: 'copy', outcome: 'accepted', payloadBytes: new TextEncoder().encode(copyPayload).byteLength },
      { action: 'paste', outcome: 'rejected', payloadBytes: new TextEncoder().encode(pastePayload).byteLength },
    ],
    signature,
  );
});

// The five tests below close contract clauses that an AST mutation sweep of
// src/utils/terminalClipboardCoordinator.ts found unverified: deleting the guard
// each one names left the whole suite green. Each asserts the transition, not the
// resting state, so deleting the guard again makes the named test red.

test('clipboard coordinator RED — copy rejects a missing or superseded target before reading the selection', async () => {
  const signature = RED_SIGNATURES.copyEntryContext;
  const factory = await requireCoordinatorFactory(signature);

  const missing = createHarness();
  missing.target = null;
  const missingResult = await factory(missing.options).copySelection('keyboard');

  assert.deepEqual(
    missingResult,
    { ok: false, action: 'copy', source: 'keyboard', reason: 'context-changed' },
    signature,
  );
  assert.deepEqual(missing.written, [], signature);
  assert.equal(missing.cleared.length, 0, signature);
  assert.equal(missing.focused.length, 0, signature);

  // A target that still captures but is no longer current: the entry guard must
  // stop the copy before captureSelection runs, so the selection is never read.
  let selectionReads = 0;
  const superseded = createHarness({
    isTargetCurrent: () => false,
    captureSelection: () => {
      selectionReads += 1;
      return { text: 'must not be read', rangeKey: 'stale' };
    },
  });
  const supersededResult = await factory(superseded.options).copySelection('tab-context-menu');

  assert.deepEqual(
    supersededResult,
    { ok: false, action: 'copy', source: 'tab-context-menu', reason: 'context-changed' },
    signature,
  );
  assert.equal(selectionReads, 0, signature);
  assert.deepEqual(superseded.written, [], signature);
  assert.equal(superseded.cleared.length, 0, signature);
  assert.deepEqual(
    superseded.observations.map(({ action, outcome, reason }) => ({ action, outcome, reason })),
    [{ action: 'copy', outcome: 'rejected', reason: 'context-changed' }],
    signature,
  );
});

test('clipboard coordinator RED — copy without a selection rejects without writing or clearing', async () => {
  const signature = RED_SIGNATURES.copyNoSelection;
  const factory = await requireCoordinatorFactory(signature);

  // Selection-less copy is the path that must leave Ctrl+C to the native SIGINT
  // owner, so it must not write the clipboard and must not clear anything.
  const absent = createHarness();
  absent.selection = null;
  const absentResult = await factory(absent.options).copySelection('keyboard');

  assert.deepEqual(
    absentResult,
    { ok: false, action: 'copy', source: 'keyboard', reason: 'no-selection' },
    signature,
  );
  assert.deepEqual(absent.written, [], signature);
  assert.equal(absent.cleared.length, 0, signature);
  assert.equal(absent.focused.length, 0, signature);

  // An empty-but-present selection is a distinct operand of the same guard.
  const empty = createHarness();
  empty.selection = { text: '', rangeKey: 'collapsed-range' };
  const emptyResult = await factory(empty.options).copySelection('grid-context-menu');

  assert.deepEqual(
    emptyResult,
    { ok: false, action: 'copy', source: 'grid-context-menu', reason: 'no-selection' },
    signature,
  );
  assert.deepEqual(empty.written, [], signature);
  assert.equal(empty.cleared.length, 0, signature);
  assert.deepEqual(
    empty.observations.map(({ action, outcome, reason, payloadBytes }) => ({
      action, outcome, reason, payloadBytes,
    })),
    [{ action: 'copy', outcome: 'rejected', reason: 'no-selection', payloadBytes: 0 }],
    signature,
  );
});

test('clipboard coordinator RED — pasteText without a live target rejects without admission', async () => {
  const signature = RED_SIGNATURES.pasteTextNoTarget;
  const factory = await requireCoordinatorFactory(signature);
  const harness = createHarness();
  harness.target = null;

  const result = factory(harness.options).pasteText('no target fixture', 'command-preset');

  assert.deepEqual(
    result,
    { ok: false, action: 'paste', source: 'command-preset', reason: 'context-changed' },
    signature,
  );
  assert.equal(harness.admitted.length, 0, signature);
  assert.equal(harness.focused.length, 0, signature);
  assert.deepEqual(
    harness.observations.map(({ action, outcome, reason, payloadBytes, sessionId }) => ({
      action, outcome, reason, payloadBytes, sessionId,
    })),
    [{
      action: 'paste',
      outcome: 'rejected',
      reason: 'context-changed',
      payloadBytes: new TextEncoder().encode('no target fixture').byteLength,
      // No target was captured, so no session identity can be attributed.
      sessionId: undefined,
    }],
    signature,
  );
});

test('clipboard coordinator RED — activate on a live coordinator does not supersede in-flight work', async () => {
  const signature = RED_SIGNATURES.activateLive;
  const factory = await requireCoordinatorFactory(signature);
  const pending = deferred<string>();
  const harness = createHarness({ readClipboardText: () => pending.promise });
  const coordinator = factory(harness.options);

  // Precondition for non-vacuity: the read is genuinely still outstanding when
  // activate() runs, so the assertion below is about a live epoch and not about
  // an operation that had already settled.
  const inFlight = coordinator.pasteClipboard('tab-context-menu');
  assert.equal(harness.admitted.length, 0, signature);

  coordinator.activate();
  pending.resolve('in-flight fixture');
  const result = await inFlight;

  assert.deepEqual(result, { ok: true, action: 'paste', source: 'tab-context-menu' }, signature);
  assert.equal(harness.admitted.length, 1, signature);
  assert.equal(harness.admitted[0]?.text, 'in-flight fixture', signature);

  // The same call after a real dispose must still revive the coordinator, or the
  // assertion above would be satisfiable by an activate() that does nothing.
  coordinator.dispose();
  coordinator.activate();
  const revived = coordinator.pasteText('revived fixture', 'command-preset');
  assert.deepEqual(revived, { ok: true, action: 'paste', source: 'command-preset' }, signature);
});

test('clipboard coordinator RED — accepted programmatic paste is observed with its target identity', async () => {
  const signature = RED_SIGNATURES.pasteAccepted;
  const factory = await requireCoordinatorFactory(signature);
  const harness = createHarness();
  const payload = 'observed paste fixture';

  const result = factory(harness.options).pasteText(payload, 'grid-context-menu');

  assert.deepEqual(result, { ok: true, action: 'paste', source: 'grid-context-menu' }, signature);
  // Exactly-once is asserted against adapter admission, and this observation is
  // the record of that admission. Without it an admitted paste leaves no trace.
  assert.deepEqual(
    harness.observations,
    [{
      action: 'paste',
      source: 'grid-context-menu',
      outcome: 'accepted',
      payloadBytes: new TextEncoder().encode(payload).byteLength,
      sessionId: 'session-a',
      sessionGeneration: 7,
      viewGeneration: 11,
    }],
    signature,
  );
});

// The two tests below close gaps the post-fix sweep found that the pre-fix
// grouping had misfiled: pasteClipboard's entry guard is a separate surface from
// copySelection's and pasteText's, and the catch around the clipboard read was
// verified only as a whole try/catch, not for the rejection it produces.

test('clipboard coordinator RED — pasteClipboard rejects a missing or superseded target before reading the clipboard', async () => {
  const signature = RED_SIGNATURES.pasteClipboardEntry;
  const factory = await requireCoordinatorFactory(signature);

  let reads = 0;
  const countingRead = async () => {
    reads += 1;
    return 'must not be read';
  };

  const missing = createHarness({ readClipboardText: countingRead });
  missing.target = null;
  const missingResult = await factory(missing.options).pasteClipboard('tab-context-menu');

  assert.deepEqual(
    missingResult,
    { ok: false, action: 'paste', source: 'tab-context-menu', reason: 'context-changed' },
    signature,
  );
  // The guard must stop the operation before the clipboard is touched at all.
  assert.equal(reads, 0, signature);
  assert.equal(missing.admitted.length, 0, signature);
  assert.equal(missing.focused.length, 0, signature);

  reads = 0;
  const superseded = createHarness({
    readClipboardText: countingRead,
    isTargetCurrent: () => false,
  });
  const supersededResult = await factory(superseded.options).pasteClipboard('grid-context-menu');

  assert.deepEqual(
    supersededResult,
    { ok: false, action: 'paste', source: 'grid-context-menu', reason: 'context-changed' },
    signature,
  );
  assert.equal(reads, 0, signature);
  assert.equal(superseded.admitted.length, 0, signature);
  assert.deepEqual(
    superseded.observations.map(({ action, outcome, reason, payloadBytes }) => ({
      action, outcome, reason, payloadBytes,
    })),
    [{ action: 'paste', outcome: 'rejected', reason: 'context-changed', payloadBytes: 0 }],
    signature,
  );
});

test('clipboard coordinator RED — a failed clipboard read rejects as clipboard-read-failed without admission', async () => {
  const signature = RED_SIGNATURES.clipboardReadFailure;
  const factory = await requireCoordinatorFactory(signature);
  const denied = 'NotAllowedError: clipboard read denied';
  const harness = createHarness({
    readClipboardText: async () => { throw new Error(denied); },
  });

  const result = await factory(harness.options).pasteClipboard('tab-context-menu');

  assert.deepEqual(
    result,
    { ok: false, action: 'paste', source: 'tab-context-menu', reason: 'clipboard-read-failed' },
    signature,
  );
  assert.equal(harness.admitted.length, 0, signature);
  assert.equal(harness.focused.length, 0, signature);
  // The failure has to reach the debug channel as an explicit rejection rather
  // than being swallowed, and without carrying the thrown message through.
  assert.deepEqual(
    harness.observations.map(({ action, outcome, reason, payloadBytes }) => ({
      action, outcome, reason, payloadBytes,
    })),
    [{ action: 'paste', outcome: 'rejected', reason: 'clipboard-read-failed', payloadBytes: 0 }],
    signature,
  );
  assert.equal(JSON.stringify(harness.observations).includes(denied), false, signature);
});

// Found by review, not by the sweep. pasteText's entry guard checks only that a
// target was captured, not that it is still current, so the currency check
// inside pasteCapturedText is the only thing standing between a superseded
// target and admission. Every earlier differential fixture defined
// isTargetCurrent as identity against captureTarget, so the two agreed by
// construction and no input could reach this state -- the guard read as a no-op
// because the harness could not pose the question, not because it does nothing.
test('clipboard coordinator RED — a captured but superseded target is rejected before admission', async () => {
  const signature = RED_SIGNATURES.staleTargetAdmission;
  const factory = await requireCoordinatorFactory(signature);
  // captureTarget succeeds and isTargetCurrent disagrees: these are independent
  // inputs in production too, where they read separate refs.
  const harness = createHarness({ isTargetCurrent: () => false });

  // Precondition for non-vacuity: a target IS captured, so this test exercises
  // the currency check and not the null-target guard that a separate test owns.
  assert.notEqual(harness.options.captureTarget(), null, signature);

  const result = factory(harness.options).pasteText('stale target payload', 'command-preset');

  assert.deepEqual(
    result,
    { ok: false, action: 'paste', source: 'command-preset', reason: 'context-changed' },
    signature,
  );
  assert.equal(harness.admitted.length, 0, signature);
  assert.equal(harness.focused.length, 0, signature);
  assert.deepEqual(
    harness.observations.map(({ action, outcome, reason }) => ({ action, outcome, reason })),
    [{ action: 'paste', outcome: 'rejected', reason: 'context-changed' }],
    signature,
  );
});
