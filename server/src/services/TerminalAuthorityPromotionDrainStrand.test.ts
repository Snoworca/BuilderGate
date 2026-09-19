import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createTerminalAuthorityController,
  type TerminalAuthorityControllerOptions,
} from './TerminalAuthorityController.js';

/**
 * REL-BGSTAB-007 / MIG-BGSTAB-002: a failed headless-output apply strands its pending
 * record forever, and every later promotion on that session waits on it forever.
 *
 * `beginPromotion` drains before it can settle:
 *
 *     const prefix = [...pendingOutputs.values()]
 *       .filter(output => output.ingestOwnerToken === 'legacy-browser')
 *       .map(output => output.settled);
 *     await Promise.all(prefix);                    // unguarded: no timeout, no abort
 *
 * and `pending.settle()` is the LAST statement of an unguarded async IIFE inside
 * `applyEnqueuedHeadlessOutput` -- there is no try/catch/finally anywhere in those ~130
 * lines. So a throw partway through the apply rejects `pending.applying`, leaves the record
 * in `pendingOutputs`, and leaves `settled` with no remaining resolver. `pending.settle()`
 * is reachable from exactly two places in the controller: that success path, and `dispose()`.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the hazard is REACHABLE: one failed
 * apply is sufficient to make every subsequent promotion hang. It does NOT prove this is
 * what happened in the 2026-09-20 harness run where promotion returned nothing at 120s on a
 * quiesced session. That run's cause is unmeasured, and the resemblance is a reason to look,
 * not a finding. Quiescing cannot clear a strand -- the record predates the measurement
 * window and no further output settles it -- which is consistent with what was observed, and
 * consistent is not the same as demonstrated.
 *
 * The assertion is bounded deliberately. A test for a hang that hangs its own suite would be
 * its own small joke; this races the promotion against a timer and asserts the timer wins.
 */

const SETTLE_PROBE_MS = 500;

function createOptions(overrides: Partial<TerminalAuthorityControllerOptions> = {}):
TerminalAuthorityControllerOptions {
  return {
    initial: {
      sessionId: 'strand-session',
      authorityEpoch: '1',
      streamEpoch: '1',
      sessionGeneration: '1',
      legacyResponderLeaseId: 'legacy-responder-1',
      legacyDriverLeaseId: 'legacy-driver-1',
      sessionStatus: 'idle',
    },
    readPromotionGates: () => ({
      retainedStateParity: true,
      factParity: true,
      leaseParity: true,
      noLocalCacheParity: true,
      limitedSessionSelected: true,
      allRespondersCapable: true,
      replayRepairIdle: true,
      queryResponderCapability: true,
    }),
    listRequiredResponderViews: () => [
      {
        connectionId: 'conn-1',
        viewGeneration: 1,
        responderLeaseId: 'legacy-responder-1',
        queryReplyCapability: 'terminal.query-reply-input.v1',
        parserResponderCapability: 'terminal.parser-responder-disable.v1',
        driverLeaseGeneration: '1',
        acceptedViewAttributesGeneration: '1',
      },
    ] as never,
    readLastCommittedSourceSeq: () => '0',
    readPromotionSafetyLimits: () => ({
      ackDeadlineMs: 5_000,
      maxHeldOutputBytes: 1_048_576,
      maxHeldOutputChunks: 1_024,
    }),
    now: () => Date.now(),
    onOrderedCompatibilityRecoveryRequired: () => {},
    enqueueTerminalMessage: () => true,
    emit: () => {},
    loadAuthoritativeRecovery: () => ({
      retainedStateHash: 'hash',
      checkpointEpoch: '1',
      snapshotSeq: '1',
      checkpointMessages: [],
      postSnapshotOutput: [],
    }),
    loadCompatibilityRecovery: () => ({ snapshotSeq: '1', checkpointMessages: [] }),
    stopNewAdmission: () => {},
    ...overrides,
  } as TerminalAuthorityControllerOptions;
}

test('a failed headless-output apply strands the pending record so promotion never drains', async () => {
  let failNextCommit = true;
  const controller = createTerminalAuthorityController(createOptions({
    emit: (event: { type: string }) => {
      // Thrown from inside the apply IIFE, before `pending.settle()` is reached.
      if (event.type === 'headless-model-committed' && failNextCommit) {
        failNextCommit = false;
        throw new Error('injected-commit-failure');
      }
    },
  }));

  try {
    const reserved = controller.enqueueHeadlessOutput({ sourceSeq: '1', data: 'stranded-output' });
    const recordId = (reserved as { recordId: string }).recordId;

    await assert.rejects(
      () => controller.applyEnqueuedHeadlessOutput(recordId),
      /injected-commit-failure/u,
      'precondition: the injected failure must reach the apply, not be swallowed earlier',
    );

    const promotion = controller.beginPromotion({
      sessionId: 'strand-session',
      authorityEpoch: '1',
      previousStreamEpoch: '1',
      nextStreamEpoch: '2',
      transitionEpoch: '2',
      oldResponderLeaseId: 'legacy-responder-1',
      nextResponderLeaseId: 'server-responder-1',
      nextDriverLeaseId: 'server-driver-1',
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = new Promise<'unsettled'>(resolve => {
      timer = setTimeout(() => resolve('unsettled'), SETTLE_PROBE_MS);
    });
    const outcome = await Promise.race([
      promotion.then(result => ({ settled: result })),
      probe,
    ]);
    if (timer) clearTimeout(timer);

    assert.equal(
      outcome,
      'unsettled',
      `promotion settled within ${SETTLE_PROBE_MS}ms after a failed apply; if this now passes, `
      + 'the drain has gained a timeout or the failed apply no longer strands its record -- '
      + 'check which before deleting this test',
    );
  } finally {
    controller.dispose();
  }
});

/**
 * The control, and it is not optional. "Promotion did not settle in 500ms" is satisfied by a
 * genuine strand AND by a stub harness in which promotion never settles for some unrelated
 * reason -- a rejected validation would even settle FAST and pass a naive negative check the
 * other way. This runs the identical setup with no injected failure: the apply completes,
 * `pending.settle()` runs, the drain finds nothing outstanding, and promotion returns.
 *
 * So the pair separates "the drain is waiting on a stranded record" from "this harness
 * cannot promote at all", which is the only reading that would make the test above worthless.
 */
test('control: with the apply succeeding, the same promotion settles promptly', async () => {
  const controller = createTerminalAuthorityController(createOptions());

  try {
    const reserved = controller.enqueueHeadlessOutput({ sourceSeq: '1', data: 'applied-output' });
    const recordId = (reserved as { recordId: string }).recordId;
    await controller.applyEnqueuedHeadlessOutput(recordId);

    const promotion = controller.beginPromotion({
      sessionId: 'strand-session',
      authorityEpoch: '1',
      previousStreamEpoch: '1',
      nextStreamEpoch: '2',
      transitionEpoch: '2',
      oldResponderLeaseId: 'legacy-responder-1',
      nextResponderLeaseId: 'server-responder-1',
      nextDriverLeaseId: 'server-driver-1',
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const probe = new Promise<'unsettled'>(resolve => {
      timer = setTimeout(() => resolve('unsettled'), SETTLE_PROBE_MS);
    });
    const outcome = await Promise.race([
      promotion.then(result => ({ settled: result })),
      probe,
    ]);
    if (timer) clearTimeout(timer);

    assert.notEqual(
      outcome,
      'unsettled',
      'control failed: promotion did not settle even with a successful apply, so the strand '
      + 'test above is measuring something other than the strand',
    );
  } finally {
    controller.dispose();
  }
});

/**
 * The instrument for the live case: `pendingLegacyBrowserOutputCount` on the authority
 * state, surfaced through the debug inventory. A strand is invisible to buffer quiescence
 * -- the record predates the measurement window and no later output settles it -- so the
 * count is the only thing that can say, BEFORE a promotion is attempted, whether that
 * promotion will hang.
 *
 * It is computed at read time from `pendingOutputs` with the same predicate the drain
 * filters on, so it cannot report a number the drain disagrees with.
 */
test('the drain quantity is observable: stranded reports one, applied reports zero', async () => {
  let failNextCommit = true;
  const stranded = createTerminalAuthorityController(createOptions({
    emit: (event: { type: string }) => {
      if (event.type === 'headless-model-committed' && failNextCommit) {
        failNextCommit = false;
        throw new Error('injected-commit-failure');
      }
    },
  }));
  try {
    assert.equal(
      stranded.getState().pendingLegacyBrowserOutputCount,
      0,
      'precondition: a fresh session has nothing outstanding',
    );
    const reserved = stranded.enqueueHeadlessOutput({ sourceSeq: '1', data: 'stranded-output' });
    await assert.rejects(
      () => stranded.applyEnqueuedHeadlessOutput((reserved as { recordId: string }).recordId),
      /injected-commit-failure/u,
    );
    assert.equal(
      stranded.getState().pendingLegacyBrowserOutputCount,
      1,
      'a failed apply must leave its record countable; this is what quiescence cannot see',
    );
  } finally {
    stranded.dispose();
  }

  const healthy = createTerminalAuthorityController(createOptions());
  try {
    const reserved = healthy.enqueueHeadlessOutput({ sourceSeq: '1', data: 'applied-output' });
    await healthy.applyEnqueuedHeadlessOutput((reserved as { recordId: string }).recordId);
    assert.equal(
      healthy.getState().pendingLegacyBrowserOutputCount,
      0,
      'control: a successful apply must clear the record, or the count reports a constant',
    );
  } finally {
    healthy.dispose();
  }
});
