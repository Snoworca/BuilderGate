import assert from 'node:assert/strict';
import test from 'node:test';
import type { IPty } from 'node-pty';
import { config } from '../utils/config.js';
import { SessionManager } from './SessionManager.js';

/**
 * Named owner for issue #12 AC-2's zero-window property.
 *
 * `MIG-BGSTAB-002` AC-3 requires that one epoch carry exactly one
 * snapshot/query/side-effect authority, and issue #12 AC-2 sharpens that to an
 * absence over a *transient interval*: the window in which both responders are
 * simultaneously active must be zero.
 *
 * Before this file, nothing in `server/src` -- tests included -- read
 * `serverEnabled` and `legacyEnabled` together. The invariant was held by an
 * assignment convention across twelve sites, and a thirteenth site assigning
 * only one of the two would have reddened nothing. That is the *covered but
 * unowned* disposition; these tests exist to give the property a name.
 *
 * Measured at HEAD 283ad7b, and recorded so a later reader does not have to
 * re-derive it: the duplicate-admission hazard is excluded by
 * `responder.active`, which is single-valued and is assigned *before* either
 * boolean at all twelve sites. So the hazard arm below is expected to hold even
 * if the literal arm is ever broken. Both are asserted, because they can fail
 * independently and only one of them is what the criterion says.
 *
 * @req MIG-BGSTAB-002 AC-3
 */

const SESSION_ID = 'terminal-authority-responder-exclusivity';

class ExclusivityFakePty {
  readonly pid = 92_101;
  readonly process = 'bash';
  readonly handleFlowControl = false;
  cols = 80;
  rows = 24;
  readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  kill(): void {}
  pause(): void {}
  resume(): void {}
  clear(): void {}
}

function createHarness() {
  const pty = new ExclusivityFakePty();
  const manager = new SessionManager({
    pty: structuredClone(config.pty),
    session: structuredClone(config.session),
    resourceLimits: structuredClone(config.resourceLimits),
    stabilityModes: structuredClone(config.stabilityModes),
  }, {
    platform: 'linux',
    spawnPty: (() => pty as unknown as IPty) as NonNullable<
      ConstructorParameters<typeof SessionManager>[1]
    >['spawnPty'],
    readProcessStartIdentityFn: async () => null,
    retainedTerminalShadowEnabled: true,
    compareRetainedHeadlessCheckpointRoundTripFn: async () => ({
      result: 'match' as const,
      axes: {
        logicalLines: 'match' as const,
        cells: 'match' as const,
        unicodeWidth: 'match' as const,
        cursor: 'match' as const,
        modes: 'match' as const,
        activeBuffer: 'match' as const,
        parserTail: 'unavailable' as const,
        eviction: 'unavailable' as const,
      },
    }),
  } as ConstructorParameters<typeof SessionManager>[1]);
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.createSession('MIG-BGSTAB-002 responder exclusivity', 'bash', process.cwd(), {
    sessionId: SESSION_ID,
  });
  return { manager, pty, close: () => manager.deleteSession(SESSION_ID) };
}

interface ResponderSample {
  readonly step: string;
  readonly active: string | null;
  readonly serverEnabled: boolean;
  readonly legacyEnabled: boolean;
}

function sampleResponder(manager: SessionManager, step: string): ResponderSample {
  const state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.ok(state, `runtime port state must exist at step ${step}`);
  return {
    step,
    active: state.responder.active,
    serverEnabled: state.responder.serverEnabled,
    legacyEnabled: state.responder.legacyEnabled,
  };
}

/**
 * Drives promotion then rollback, sampling the responder after every step.
 *
 * The step list is the epoch barrier of `MIG-BGSTAB-002` AC-2 followed by the
 * rollback ordering of AC-5, so each returned sample is one prefix of those
 * sequences -- the brief's "test each prefix, not just the end state".
 */
function driveHandoffAndSample(manager: SessionManager): ResponderSample[] {
  const samples: ResponderSample[] = [sampleResponder(manager, 'initial')];

  const browserLease = manager.establishRetainedTerminalMutationLease(SESSION_ID, 'browser-a', 7);
  assert.equal(browserLease.ok, true, 'fixture precondition: the browser lease must bind');
  samples.push(sampleResponder(manager, 'browser-lease-bound'));

  assert.deepEqual(
    manager.rebindTerminalAuthorityCompatibilityResponderLease(SESSION_ID, {
      responderLeaseId: 'responder-browser-7',
    }),
    { ok: true },
    'fixture precondition: the legacy responder must be enabled before promotion',
  );
  samples.push(sampleResponder(manager, 'legacy-responder-enabled'));

  assert.deepEqual(
    manager.stopTerminalAuthorityNewAdmission(SESSION_ID, { transitionEpoch: '8' }),
    { ok: true },
  );
  samples.push(sampleResponder(manager, 'promotion-admission-stopped'));

  assert.deepEqual(
    manager.bindTerminalAuthorityServerDriverLease(SESSION_ID, { driverLeaseId: 'driver-server-8' }),
    { ok: true },
  );
  samples.push(sampleResponder(manager, 'server-driver-lease-bound'));

  assert.deepEqual(
    manager.setTerminalAuthorityServerResponderEnabled(SESSION_ID, {
      enabled: true,
      responderLeaseId: 'responder-server-8',
    }),
    { ok: true },
  );
  samples.push(sampleResponder(manager, 'server-responder-enabled'));

  assert.deepEqual(
    manager.stopTerminalAuthorityNewAdmission(SESSION_ID, { transitionEpoch: '9' }),
    { ok: true },
  );
  samples.push(sampleResponder(manager, 'rollback-admission-stopped'));

  assert.deepEqual(
    manager.rebindTerminalAuthorityCompatibilityDriverLease(SESSION_ID, {
      driverLeaseId: 'driver-browser-9',
      clientId: 'browser-a',
      viewGeneration: 7,
      leaseGeneration: '9',
    }),
    { ok: true },
  );
  samples.push(sampleResponder(manager, 'compatibility-driver-rebound'));

  assert.deepEqual(
    manager.rebindTerminalAuthorityCompatibilityResponderLease(SESSION_ID, {
      responderLeaseId: 'responder-browser-9',
    }),
    { ok: true },
  );
  samples.push(sampleResponder(manager, 'legacy-responder-re-enabled'));

  return samples;
}

test('MIG-BGSTAB-002 the server and legacy responders are never both enabled, at any step of promotion or rollback', async t => {
  const harness = createHarness();
  t.after(harness.close);

  const samples = driveHandoffAndSample(harness.manager);

  // Assert the setup before asserting the property, so that a fixture which
  // stops exercising the transition fails here rather than passing over
  // nothing. An enumeration that can return zero must assert its own count.
  assert.equal(samples.length, 9, 'every step of the handoff must be sampled');
  assert.ok(
    samples.some(sample => sample.serverEnabled),
    'fixture precondition: some step must have the server responder enabled, '
    + `otherwise this test passes vacuously; got ${JSON.stringify(samples)}`,
  );
  assert.ok(
    samples.some(sample => sample.legacyEnabled),
    'fixture precondition: some step must have the legacy responder enabled, '
    + `otherwise this test passes vacuously; got ${JSON.stringify(samples)}`,
  );

  const both = samples.filter(sample => sample.serverEnabled && sample.legacyEnabled);
  assert.deepEqual(
    both,
    [],
    'MIG-BGSTAB-002 AC-3: one epoch carries exactly one responder, so no step of '
    + 'the handoff may have both enabled',
  );
});

test('MIG-BGSTAB-002 no handoff step admits a query reply on both the server and the compatibility path', async t => {
  const harness = createHarness();
  t.after(harness.close);

  const accepted: Array<{ step: string; server: boolean; compatibility: boolean }> = [];
  // Probe each path with the lease the runtime currently holds, not with a fixed
  // id. A fixed id makes `activeLeaseId` a third discriminator that closes the
  // path on its own, so the probe never reaches the guards under test -- the
  // fixture would return a clean zero over a question it never asked.
  const record = (step: string) => {
    const state = harness.manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
    const leaseId = state?.responder.activeLeaseId ?? 'no-active-lease';
    accepted.push({
      step,
      server: harness.manager.writeTerminalAuthorityServerQueryReply(SESSION_ID, {
        responderLeaseId: leaseId,
        reply: '\x1b[1;1R',
      }),
      compatibility: harness.manager.writeTerminalAuthorityCompatibilityQueryReply(SESSION_ID, {
        responderLeaseId: leaseId,
        clientId: 'browser-a',
        viewGeneration: 7,
        reply: '\x1b[1;1R',
      }),
    });
  };

  const browserLease = harness.manager.establishRetainedTerminalMutationLease(SESSION_ID, 'browser-a', 7);
  assert.equal(browserLease.ok, true);
  record('browser-lease-bound');
  harness.manager.rebindTerminalAuthorityCompatibilityResponderLease(SESSION_ID, {
    responderLeaseId: 'responder-browser-7',
  });
  record('legacy-responder-enabled');
  harness.manager.stopTerminalAuthorityNewAdmission(SESSION_ID, { transitionEpoch: '8' });
  record('promotion-admission-stopped');
  harness.manager.bindTerminalAuthorityServerDriverLease(SESSION_ID, { driverLeaseId: 'driver-server-8' });
  record('server-driver-lease-bound');
  harness.manager.setTerminalAuthorityServerResponderEnabled(SESSION_ID, {
    enabled: true,
    responderLeaseId: 'responder-server-8',
  });
  record('server-responder-enabled');
  harness.manager.stopTerminalAuthorityNewAdmission(SESSION_ID, { transitionEpoch: '9' });
  record('rollback-admission-stopped');
  harness.manager.rebindTerminalAuthorityCompatibilityDriverLease(SESSION_ID, {
    driverLeaseId: 'driver-browser-9',
    clientId: 'browser-a',
    viewGeneration: 7,
    leaseGeneration: '9',
  });
  record('compatibility-driver-rebound');
  harness.manager.rebindTerminalAuthorityCompatibilityResponderLease(SESSION_ID, {
    responderLeaseId: 'responder-browser-9',
  });
  record('legacy-responder-re-enabled');

  assert.equal(accepted.length, 8, 'every step must be probed on both reply paths');

  // The control for this test's own zero: if neither path ever accepts, the
  // duplicate count is trivially zero and the test asserts nothing.
  assert.ok(
    accepted.some(entry => entry.server),
    `fixture precondition: the server reply path must accept at some step; got ${JSON.stringify(accepted)}`,
  );
  assert.ok(
    accepted.some(entry => entry.compatibility),
    `fixture precondition: the compatibility reply path must accept at some step; got ${JSON.stringify(accepted)}`,
  );

  assert.deepEqual(
    accepted.filter(entry => entry.server && entry.compatibility),
    [],
    'MIG-BGSTAB-002 AC-3: a single query must never be admitted by both responders, '
    + 'which is the duplicate-reply hazard AC-2 exists to prevent',
  );

  // The overlap assertion above is necessary and not sufficient, and the gap was
  // found by mutation rather than by reading. Deleting `admission.mode` and
  // `responder.active` from the server reply guard leaves the server path
  // accepting through `rollback-admission-stopped` and
  // `compatibility-driver-rebound` -- a server responder that outlives the
  // rollback's revoke step. The overlap count stays zero throughout, because the
  // server path closes exactly as the legacy path opens.
  //
  // So "never both" does not imply "the old responder closed on time". They are
  // different properties and this arm owns the second one: `MIG-BGSTAB-002` AC-5
  // revokes the new responder *before* the legacy responder is re-enabled.
  const rollbackStart = accepted.findIndex(entry => entry.step === 'rollback-admission-stopped');
  assert.ok(rollbackStart >= 0, 'fixture precondition: the rollback step must be probed');
  assert.deepEqual(
    accepted.slice(rollbackStart).filter(entry => entry.server),
    [],
    'MIG-BGSTAB-002 AC-5: the server responder is revoked at the start of rollback, '
    + 'so no step from that point on may admit a server reply',
  );
});
