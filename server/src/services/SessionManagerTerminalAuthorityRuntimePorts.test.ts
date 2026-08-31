import assert from 'node:assert/strict';
import test from 'node:test';
import type { IPty } from 'node-pty';
import { config } from '../utils/config.js';
import { writeHeadlessTerminal } from '../utils/headlessTerminal.js';
import {
  SessionManager,
  type TerminalAuthorityRuntimeFactory,
  type TerminalAuthoritySessionRuntime,
} from './SessionManager.js';

const SESSION_ID = 'terminal-authority-runtime-ports';

class RuntimePortFakePty {
  readonly pid = 92_001;
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

function createHarness(options: {
  comparerResult?: 'match' | 'mismatch';
  retainedShadowEnabled?: boolean;
  writeHeadlessTerminalFn?: typeof writeHeadlessTerminal;
} = {}) {
  const pty = new RuntimePortFakePty();
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
    retainedTerminalShadowEnabled: options.retainedShadowEnabled ?? true,
    writeHeadlessTerminalFn: options.writeHeadlessTerminalFn,
    compareRetainedHeadlessCheckpointRoundTripFn: async () => ({
      result: options.comparerResult ?? 'match',
      axes: {
        logicalLines: options.comparerResult ?? 'match',
        cells: options.comparerResult ?? 'match',
        unicodeWidth: options.comparerResult ?? 'match',
        cursor: options.comparerResult ?? 'match',
        modes: options.comparerResult ?? 'match',
        activeBuffer: options.comparerResult ?? 'match',
        parserTail: 'unavailable',
        eviction: 'unavailable',
      },
    }),
  } as ConstructorParameters<typeof SessionManager>[1]);
  (manager as unknown as { isCommandAvailable(command: string): boolean }).isCommandAvailable = () => true;
  manager.createSession('MIG-BGSTAB-002 authority runtime ports', 'bash', process.cwd(), {
    sessionId: SESSION_ID,
  });
  return {
    manager,
    pty,
    close: () => manager.deleteSession(SESSION_ID),
  };
}

test('MIG-BGSTAB-002 screen repair waits for an accepted retained resize before checking geometry', async t => {
  let releaseWrite!: () => void;
  const writeReleased = new Promise<void>(resolve => { releaseWrite = resolve; });
  let markWriteStarted!: () => void;
  const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve; });
  const harness = createHarness({
    writeHeadlessTerminalFn: async (state, data) => {
      markWriteStarted();
      await writeReleased;
      await writeHeadlessTerminal(state, data);
    },
  });
  t.after(harness.close);

  const lease = harness.manager.establishRetainedTerminalMutationLease(
    SESSION_ID,
    'browser-resize-repair',
    3,
  );
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  harness.pty.emitData('output-before-fit-resize\r\n');
  await writeStarted;
  assert.equal(harness.manager.resize(SESSION_ID, 59, 17, {
    authorityEpoch: lease.authorityEpoch,
    clientId: 'browser-resize-repair',
    viewGeneration: 3,
    leaseGeneration: lease.leaseGeneration,
  }), true);

  const repairPromise = harness.manager.getScreenRepair(SESSION_ID, {
    cols: 59,
    rows: 17,
    bufferType: 'normal',
  });
  releaseWrite();

  const repair = await repairPromise;
  assert.equal(repair.ok, true);
  if (!repair.ok) return;
  assert.equal(repair.payload.cols, 59);
  assert.equal(repair.payload.rows, 17);
  assert.equal(harness.pty.cols, 59);
  assert.equal(harness.pty.rows, 17);
});

test('MIG-BGSTAB-002 production attachment can activate retained shadow for an existing disabled session', async t => {
  const harness = createHarness({ retainedShadowEnabled: false });
  t.after(harness.close);

  assert.equal(harness.manager.getRetainedTerminalAuthorityState(SESSION_ID)?.mode, 'disabled');
  assert.deepEqual(
    harness.manager.registerRetainedTerminalClientView(SESSION_ID, 'browser-after-attach', 1),
    { ok: false, reason: 'shadow-disabled' },
  );

  assert.equal(harness.manager.setRetainedTerminalShadowEnabled(true), true);
  assert.equal(harness.manager.getRetainedTerminalAuthorityState(SESSION_ID)?.mode, 'shadow');
  assert.deepEqual(
    harness.manager.registerRetainedTerminalClientView(SESSION_ID, 'browser-after-attach', 1),
    { ok: true, reason: 'registered' },
  );

  harness.pty.emitData('shadow-after-production-attach\r\n');
  await new Promise(resolve => setTimeout(resolve, 40));
  const retainedAfterOutput = harness.manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(retainedAfterOutput?.records.some(record => record.kind === 'output'));
  assert.ok(BigInt(retainedAfterOutput?.sourceSeq ?? '0') > 0n);
});

async function settleRetainedComparison(pty: RuntimePortFakePty): Promise<void> {
  pty.emitData('authority-runtime-parity-line\r\n');
  await new Promise(resolve => setTimeout(resolve, 40));
}

test('MIG-BGSTAB-002 runtime factory registration backfills sessions restored before production authority attachment', async t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager, pty } = harness;
  const internal = manager as unknown as {
    sessions: Map<string, {
      headless: TerminalAuthorityRuntimeFactory extends (input: infer Input) => unknown
        ? Input extends { headlessState: infer Headless }
          ? Headless
          : never
        : never;
      terminalAuthorityController?: TerminalAuthoritySessionRuntime['controller'];
      terminalQueryResponder?: TerminalAuthoritySessionRuntime['queryResponder'];
      nextTerminalAuthoritySourceSeq: bigint;
    }>;
  };
  const restoredSession = internal.sessions.get(SESSION_ID);
  assert.ok(restoredSession?.headless);
  assert.equal(restoredSession.terminalAuthorityController, undefined);
  assert.equal(restoredSession.terminalQueryResponder, undefined);

  pty.emitData('restored-before-runtime\r\n');
  await new Promise(resolve => setTimeout(resolve, 40));
  const retainedBeforeAttach = manager.getRetainedTerminalAuthorityState(SESSION_ID);
  assert.ok(retainedBeforeAttach);
  const sourceSeqBeforeAttach = BigInt(retainedBeforeAttach.sourceSeq);
  assert.ok(sourceSeqBeforeAttach > 0n);

  let factoryCalls = 0;
  let detachCalls = 0;
  const capturedSourceSeqs: bigint[] = [];
  const controller = {
    enqueueHeadlessOutput: ({ sourceSeq }: { sourceSeq: string }) => {
      capturedSourceSeqs.push(BigInt(sourceSeq));
      return {
        recordId: `record-${sourceSeq}`,
        sourceSeq,
        ingestOwnerToken: `owner-${sourceSeq}`,
        ownerSelectedAt: 'enqueue',
      };
    },
    applyEnqueuedHeadlessOutput: async (recordId: string) => ({
      recordId,
      sourceSeq: capturedSourceSeqs.at(-1)?.toString() ?? '0',
      responderLeaseId: 'legacy-responder-test',
      ingestOwner: 'legacy-browser',
      ingestOwnerToken: 'legacy-browser',
      commitOwner: 'legacy-browser',
      ownerSelectedAt: 'enqueue',
      modelCommitted: true,
      factCommitted: true,
      deliveryDisposition: 'legacy-delivered',
    }),
    dispose: () => {},
  } as unknown as TerminalAuthoritySessionRuntime['controller'];
  const factory: TerminalAuthorityRuntimeFactory = input => {
    factoryCalls += 1;
    assert.equal(input.sessionId, SESSION_ID);
    assert.equal(input.headlessState, restoredSession.headless);
    return {
      controller,
      queryResponder: {
        attachedHeadlessState: input.headlessState,
        captureCommittedWrite: async (
          _data: string,
          _options: { source: 'live' | 'seed' | 'replay' },
          commit: () => Promise<void>,
        ) => {
          await commit();
          return { replies: [], disposition: 'not-query', promotionEligible: true };
        },
        detach: () => { detachCalls += 1; },
      } as unknown as TerminalAuthoritySessionRuntime['queryResponder'],
      dispose: () => {},
    };
  };

  manager.setTerminalAuthorityRuntimeFactory(factory);

  const attachedSession = internal.sessions.get(SESSION_ID);
  assert.ok(attachedSession);
  assert.equal(factoryCalls, 1, 'pre-existing restored session must receive one production runtime');
  assert.equal(attachedSession.terminalAuthorityController, controller);
  assert.equal(attachedSession.terminalQueryResponder?.attachedHeadlessState, restoredSession.headless);
  assert.equal(detachCalls, 0);

  manager.setTerminalAuthorityRuntimeFactory(factory);
  assert.equal(factoryCalls, 1, 're-registering the same factory must not replace an attached runtime');
  assert.equal(detachCalls, 0);

  pty.emitData('first-output-after-runtime\r\n');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(capturedSourceSeqs.length, 1);
  assert.ok(
    capturedSourceSeqs[0] > sourceSeqBeforeAttach,
    'backfilled runtime output ordinal must remain ahead of output retained before attachment',
  );
  assert.equal(restoredSession.nextTerminalAuthoritySourceSeq, capturedSourceSeqs[0]);
});

test('MIG-BGSTAB-002 runtime factory registration is atomic and rejects a different owner factory', t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager } = harness;
  const secondSessionId = `${SESSION_ID}-second`;
  const thirdSessionId = `${SESSION_ID}-third`;
  manager.createSession('MIG-BGSTAB-002 authority runtime ports second', 'bash', process.cwd(), {
    sessionId: secondSessionId,
  });
  manager.createSession('MIG-BGSTAB-002 authority runtime ports third', 'bash', process.cwd(), {
    sessionId: thirdSessionId,
  });
  t.after(() => manager.deleteSession(secondSessionId));
  t.after(() => manager.deleteSession(thirdSessionId));
  const internal = manager as unknown as {
    sessions: Map<string, {
      terminalAuthorityRuntime?: TerminalAuthoritySessionRuntime;
      terminalAuthorityController?: TerminalAuthoritySessionRuntime['controller'];
      terminalQueryResponder?: TerminalAuthoritySessionRuntime['queryResponder'];
    }>;
    terminalAuthorityRuntimeFactory: TerminalAuthorityRuntimeFactory | null;
  };
  let factoryCalls = 0;
  let stagedDisposals = 0;
  let stagedResponderDetaches = 0;
  let stagedControllerDisposals = 0;
  const failingFactory: TerminalAuthorityRuntimeFactory = input => {
    factoryCalls += 1;
    if (factoryCalls === 3) throw new Error('factory-third-session-failed');
    return {
      controller: {
        dispose: () => { stagedControllerDisposals += 1; },
      } as unknown as TerminalAuthoritySessionRuntime['controller'],
      queryResponder: {
        attachedHeadlessState: input.headlessState,
        detach: () => { stagedResponderDetaches += 1; },
      } as unknown as TerminalAuthoritySessionRuntime['queryResponder'],
      dispose: () => {
        stagedDisposals += 1;
        if (input.sessionId === secondSessionId) {
          throw new Error('injected-staged-runtime-dispose-failure');
        }
      },
    };
  };

  assert.throws(
    () => manager.setTerminalAuthorityRuntimeFactory(failingFactory),
    /factory-third-session-failed/,
  );
  assert.equal(stagedDisposals, 2, 'all staged runtimes must be disposed even when one disposer throws');
  assert.equal(stagedResponderDetaches, 2, 'all staged responder handlers must be detached on registration rollback');
  assert.equal(stagedControllerDisposals, 2, 'all staged controller resources must be disposed on registration rollback');
  assert.equal(internal.terminalAuthorityRuntimeFactory, null);
  for (const data of internal.sessions.values()) {
    assert.equal(data.terminalAuthorityRuntime, undefined);
    assert.equal(data.terminalAuthorityController, undefined);
    assert.equal(data.terminalQueryResponder, undefined);
  }

  const ownerFactory: TerminalAuthorityRuntimeFactory = input => ({
    controller: { dispose: () => {} } as unknown as TerminalAuthoritySessionRuntime['controller'],
    queryResponder: {
      attachedHeadlessState: input.headlessState,
      detach: () => {},
    } as unknown as TerminalAuthoritySessionRuntime['queryResponder'],
    dispose: () => {},
  });
  manager.setTerminalAuthorityRuntimeFactory(ownerFactory);
  const replacementFactory: TerminalAuthorityRuntimeFactory = input => ({
    controller: { dispose: () => {} } as unknown as TerminalAuthoritySessionRuntime['controller'],
    queryResponder: {
      attachedHeadlessState: input.headlessState,
      detach: () => {},
    } as unknown as TerminalAuthoritySessionRuntime['queryResponder'],
    dispose: () => {},
  });
  assert.throws(
    () => manager.setTerminalAuthorityRuntimeFactory(replacementFactory),
    /terminal-authority-runtime-factory-already-registered/,
  );
  assert.equal(internal.terminalAuthorityRuntimeFactory, ownerFactory);
  assert.throws(
    () => manager.setTerminalAuthorityRuntimeFactory(null),
    /terminal-authority-runtime-factory-clear-requires-owner-disposal/,
  );
  assert.equal(manager.clearTerminalAuthorityRuntimeFactory(ownerFactory), false);
  assert.equal(internal.terminalAuthorityRuntimeFactory, ownerFactory);
});

test('MIG-BGSTAB-002 headless recreation disposes the previous authority runtime before replacement', async t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager } = harness;
  const internal = manager as unknown as {
    sessions: Map<string, {
      headless: TerminalAuthorityRuntimeFactory extends (input: infer Input) => unknown
        ? Input extends { headlessState: infer Headless }
          ? Headless
          : never
        : never;
    }>;
    recreateTerminalAuthorityDebugHeadless(
      sessionId: string,
      data: unknown,
      scrollbackLines: number,
    ): Promise<void>;
  };
  let factoryCalls = 0;
  let disposedRuntimes = 0;
  const factory: TerminalAuthorityRuntimeFactory = input => {
    factoryCalls += 1;
    const controller = {
      dispose: () => {},
      getState: () => ({ mode: 'server' }),
    } as unknown as TerminalAuthoritySessionRuntime['controller'];
    return {
      controller,
      queryResponder: {
        attachedHeadlessState: input.headlessState,
        detach: () => {},
      } as unknown as TerminalAuthoritySessionRuntime['queryResponder'],
      dispose: () => {
        disposedRuntimes += 1;
        manager.detachTerminalAuthorityRuntime(input.sessionId, controller);
        controller.dispose();
      },
    };
  };
  manager.setTerminalAuthorityRuntimeFactory(factory);
  const data = internal.sessions.get(SESSION_ID);
  assert.ok(data);
  const originalHeadless = data.headless;

  await internal.recreateTerminalAuthorityDebugHeadless(SESSION_ID, data, 128);

  assert.equal(disposedRuntimes, 1, 'old controller ownership must settle before headless replacement');
  assert.equal(factoryCalls, 2);
  assert.notEqual(data.headless, originalHeadless);
});

test('MIG-BGSTAB-002 headless degradation settles the owned authority runtime without a partial attachment', t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager } = harness;
  let runtimeDisposals = 0;
  let responderDetaches = 0;
  let controllerDisposals = 0;
  const controller = {
    dispose: () => { controllerDisposals += 1; },
  } as unknown as TerminalAuthoritySessionRuntime['controller'];
  manager.setTerminalAuthorityRuntimeFactory(input => ({
    controller,
    queryResponder: {
      attachedHeadlessState: input.headlessState,
      detach: () => {
        responderDetaches += 1;
        throw new Error('injected-query-responder-detach-failure');
      },
    } as unknown as TerminalAuthoritySessionRuntime['queryResponder'],
    dispose: () => { runtimeDisposals += 1; },
  }));
  const internal = manager as unknown as {
    sessions: Map<string, {
      terminalAuthorityRuntime?: TerminalAuthoritySessionRuntime;
      terminalAuthorityController?: TerminalAuthoritySessionRuntime['controller'];
      terminalQueryResponder?: TerminalAuthoritySessionRuntime['queryResponder'];
    }>;
    markHeadlessDegraded(sessionId: string, data: unknown, phase: 'write', error: Error): void;
  };
  const data = internal.sessions.get(SESSION_ID);
  assert.ok(data);

  internal.markHeadlessDegraded(SESSION_ID, data, 'write', new Error('injected-headless-degradation'));

  assert.equal(runtimeDisposals, 1);
  assert.equal(responderDetaches, 2, 'runtime detach and ownership settlement must both be idempotent');
  assert.equal(controllerDisposals, 1);
  assert.equal(data.terminalAuthorityRuntime, undefined);
  assert.equal(data.terminalAuthorityController, undefined);
  assert.equal(data.terminalQueryResponder, undefined);
});

test('MIG-BGSTAB-002 session finalization disposes a factory-owned authority runtime', () => {
  const harness = createHarness();
  const { manager } = harness;
  let runtimeDisposals = 0;
  let controllerDisposals = 0;
  const controller = {
    dispose: () => { controllerDisposals += 1; },
  } as unknown as TerminalAuthoritySessionRuntime['controller'];
  manager.setTerminalAuthorityRuntimeFactory(input => ({
    controller,
    queryResponder: {
      attachedHeadlessState: input.headlessState,
      detach: () => {},
    } as unknown as TerminalAuthoritySessionRuntime['queryResponder'],
    dispose: () => { runtimeDisposals += 1; },
  }));

  assert.equal(manager.deleteSession(SESSION_ID), true);
  assert.equal(runtimeDisposals, 1);
  assert.equal(controllerDisposals, 1);
});

test('MIG-BGSTAB-002 runtime ports close real admission and restore the concrete browser driver only after both compatibility leases bind', async t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager } = harness;

  const browserLease = manager.establishRetainedTerminalMutationLease(SESSION_ID, 'browser-a', 7);
  assert.equal(browserLease.ok, true);
  if (!browserLease.ok) return;
  const browserLeaseGeneration = browserLease.leaseGeneration;

  assert.deepEqual(manager.stopTerminalAuthorityNewAdmission(SESSION_ID, {
    transitionEpoch: '8',
  }), { ok: true });
  const blockedAdmission = manager.establishRetainedTerminalMutationLease(SESSION_ID, 'browser-b', 1);
  assert.equal(blockedAdmission.ok, false);
  assert.equal(blockedAdmission.ok ? undefined : blockedAdmission.reason, 'authority-admission-closed');

  assert.deepEqual(manager.bindTerminalAuthorityServerDriverLease(SESSION_ID, {
    driverLeaseId: 'driver-server-8',
  }), { ok: true });
  assert.deepEqual(manager.setTerminalAuthorityServerResponderEnabled(SESSION_ID, {
    enabled: true,
    responderLeaseId: 'responder-server-8',
  }), { ok: true });
  let state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'server');
  assert.equal(state?.driver.activeLeaseId, 'driver-server-8');
  assert.equal(state?.responder.activeLeaseId, 'responder-server-8');
  assert.equal(manager.writeTerminalAuthorityServerQueryReply(SESSION_ID, {
    responderLeaseId: 'responder-server-8',
    reply: '\x1b[1;1R',
  }), true);
  assert.equal(
    manager.observeRetainedTerminalDriverMutation(
      SESSION_ID,
      'browser-a',
      7,
      browserLeaseGeneration,
      'input',
    ).accepted,
    false,
    'server promotion must revoke the previous browser mutation lease in the real retained path',
  );
  const userMutationIdentity = {
    authorityEpoch: browserLease.authorityEpoch,
    clientId: 'browser-a',
    viewGeneration: 7,
    leaseGeneration: browserLeaseGeneration,
  };
  assert.equal(
    manager.writeInput(SESSION_ID, 'server-authority-user-input', undefined, undefined, userMutationIdentity),
    true,
    'server terminal authority must not revoke the selected browser user-input capability',
  );
  assert.equal(
    manager.resize(SESSION_ID, 100, 31, userMutationIdentity),
    true,
    'server terminal authority must still accept the selected browser resize request',
  );
  assert.equal(harness.pty.cols, 100);
  assert.equal(harness.pty.rows, 31);
  assert.equal(
    manager.writeInput(SESSION_ID, 'stale-user-input', undefined, undefined, {
      ...userMutationIdentity,
      viewGeneration: 8,
    }),
    false,
    'server authority input admission must remain fenced to the exact suspended browser view',
  );
  assert.equal(
    manager.writeInput(SESSION_ID, 'unleased-user-input'),
    false,
    'server authority must fail closed when the browser omits its user-mutation identity',
  );

  assert.deepEqual(manager.stopTerminalAuthorityNewAdmission(SESSION_ID, {
    transitionEpoch: '9',
  }), { ok: true });
  assert.deepEqual(manager.setTerminalAuthorityServerResponderEnabled(SESSION_ID, {
    enabled: false,
    responderLeaseId: 'responder-server-8',
  }), { ok: true });
  assert.equal(manager.writeTerminalAuthorityServerQueryReply(SESSION_ID, {
    responderLeaseId: 'responder-server-8',
    reply: '\x1b[2;2R',
  }), false, 'disabled or revoked server responder must not reach the PTY');
  assert.deepEqual(manager.revokeTerminalAuthorityResponderLease(SESSION_ID, {
    responderLeaseId: 'responder-server-8',
  }), { ok: true });
  assert.deepEqual(manager.revokeTerminalAuthorityDriverLease(SESSION_ID, {
    driverLeaseId: 'driver-server-8',
  }), { ok: true });
  assert.deepEqual(manager.rebindTerminalAuthorityCompatibilityDriverLease(SESSION_ID, {
    driverLeaseId: 'driver-browser-9',
    clientId: 'browser-a',
    viewGeneration: 7,
    leaseGeneration: '9',
  }), { ok: true });
  state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'none', 'one rebound lease cannot reopen admission');
  assert.deepEqual(manager.rebindTerminalAuthorityCompatibilityResponderLease(SESSION_ID, {
    responderLeaseId: 'responder-browser-9',
  }), { ok: true });
  state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'legacy');
  assert.equal(state?.driver.activeLeaseId, 'driver-browser-9');
  assert.equal(state?.responder.activeLeaseId, 'responder-browser-9');
  assert.equal(manager.writeTerminalAuthorityCompatibilityQueryReply(SESSION_ID, {
    responderLeaseId: 'responder-browser-9',
    clientId: 'browser-a',
    viewGeneration: 7,
    reply: '\x1b[3;3R',
  }), true);
  assert.deepEqual(harness.pty.writes, [
    '\x1b[1;1R',
    'server-authority-user-input',
    '\x1b[3;3R',
  ]);
  assert.equal(
    manager.observeRetainedTerminalDriverMutation(SESSION_ID, 'browser-a', 7, '9', 'input').accepted,
    true,
  );
  assert.equal(
    manager.observeRetainedTerminalDriverMutation(
      SESSION_ID,
      'browser-a',
      7,
      browserLeaseGeneration,
      'input',
    ).accepted,
    false,
    'pre-promotion browser lease must remain stale after compatibility rebind',
  );
});

test('MIG-BGSTAB-002 unregistering the legacy driver preserves the session responder through replacement rebind', t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager } = harness;

  assert.equal(manager.registerRetainedTerminalClientView(SESSION_ID, 'browser-a', 7).ok, true);
  assert.deepEqual(manager.stopTerminalAuthorityNewAdmission(SESSION_ID, {
    transitionEpoch: '8',
  }), { ok: true });
  assert.deepEqual(manager.rebindTerminalAuthorityCompatibilityDriverLease(SESSION_ID, {
    driverLeaseId: 'driver-browser-8',
    clientId: 'browser-a',
    viewGeneration: 7,
    leaseGeneration: '8',
  }), { ok: true });
  assert.deepEqual(manager.rebindTerminalAuthorityCompatibilityResponderLease(SESSION_ID, {
    responderLeaseId: 'responder-browser-8',
  }), { ok: true });

  assert.deepEqual(manager.unregisterRetainedTerminalClientView(SESSION_ID, 'browser-a', 7), {
    ok: true,
    reason: 'unregistered-driver-revoked',
  });
  let state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'none');
  assert.equal(state?.driver.active, null);
  assert.equal(state?.responder.active, 'legacy-browser');
  assert.equal(state?.responder.activeLeaseId, 'responder-browser-8');
  assert.equal(state?.responder.legacyEnabled, true);

  const replacement = manager.establishRetainedTerminalMutationLease(SESSION_ID, 'browser-b', 9);
  assert.equal(replacement.ok, true);
  state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'legacy');
  assert.equal(state?.driver.active, 'legacy-browser');

  assert.deepEqual(manager.unregisterRetainedTerminalClientView(SESSION_ID, 'browser-b', 9), {
    ok: true,
    reason: 'unregistered-driver-revoked',
  });
  assert.equal(manager.registerRetainedTerminalClientView(SESSION_ID, 'browser-c', 10).ok, true);
  assert.deepEqual(manager.stopTerminalAuthorityNewAdmission(SESSION_ID, {
    transitionEpoch: '9',
  }), { ok: true });
  assert.deepEqual(manager.rebindTerminalAuthorityCompatibilityDriverLease(SESSION_ID, {
    driverLeaseId: 'driver-browser-9',
    clientId: 'browser-c',
    viewGeneration: 10,
    leaseGeneration: '9',
  }), { ok: true });
  assert.deepEqual(manager.rebindTerminalAuthorityCompatibilityResponderLease(SESSION_ID, {
    responderLeaseId: 'responder-browser-9',
  }), { ok: true });
  state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'legacy');
});

test('MIG-BGSTAB-002 baseline legacy responder without an explicit lease id admits a replacement driver', t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager } = harness;

  const initial = manager.establishRetainedTerminalMutationLease(SESSION_ID, 'browser-a', 7);
  assert.equal(initial.ok, true);
  let state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.responder.active, 'legacy-browser');
  assert.equal(state?.responder.activeLeaseId, null);

  assert.deepEqual(manager.unregisterRetainedTerminalClientView(SESSION_ID, 'browser-a', 7), {
    ok: true,
    reason: 'unregistered-driver-revoked',
  });
  const replacement = manager.establishRetainedTerminalMutationLease(SESSION_ID, 'browser-b', 8);
  assert.equal(replacement.ok, true);
  state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'legacy');
  assert.equal(state?.driver.active, 'legacy-browser');
  assert.equal(state?.responder.active, 'legacy-browser');
});

test('MIG-BGSTAB-002 promotion parity snapshot fails closed for missing lease, no-cache evidence, and comparer mismatch', async t => {
  const missing = createHarness();
  t.after(missing.close);
  await settleRetainedComparison(missing.pty);
  let parity = missing.manager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
  assert.equal(parity.retainedStateParity, true);
  assert.equal(parity.factParity, true);
  assert.equal(parity.leaseParity, false);
  assert.equal(parity.noLocalCacheParity, false);
  assert.ok(parity.blockers.includes('driver-lease-missing'));
  assert.ok(parity.blockers.includes('no-local-cache-parity-missing'));

  assert.equal(missing.manager.registerRetainedTerminalClientView(SESSION_ID, 'browser-a', 1).ok, true);
  assert.equal(missing.manager.claimRetainedTerminalDriverLease(SESSION_ID, 'browser-a', 1).ok, true);
  assert.deepEqual(missing.manager.prepareTerminalAuthorityPromotionCandidate(SESSION_ID, {
    transitionEpoch: '8',
    limitedSessionSelected: true,
  }), { ok: false, reason: 'server-recovery-ack-missing' });
  assert.deepEqual(missing.manager.recordTerminalAuthorityServerRecoveryApplied(SESSION_ID, {
    clientId: 'browser-a',
    viewGeneration: 1,
    replayToken: 'server-replay-tail-pending',
    snapshotSeq: 1,
    snapshotMode: 'authoritative',
    snapshotTruncated: false,
    queuedOutputBytes: 4,
    queuedOutputTruncated: false,
  }), { ok: false, reason: 'server-recovery-tail-not-drained' });
  assert.deepEqual(missing.manager.prepareTerminalAuthorityPromotionCandidate(SESSION_ID, {
    transitionEpoch: '8',
    limitedSessionSelected: true,
  }), { ok: false, reason: 'server-recovery-ack-missing' });
  assert.deepEqual(missing.manager.recordTerminalAuthorityServerRecoveryApplied(SESSION_ID, {
    clientId: 'browser-a',
    viewGeneration: 1,
    replayToken: 'server-replay-a',
    snapshotSeq: 1,
    snapshotMode: 'authoritative',
    snapshotTruncated: false,
    queuedOutputBytes: 0,
    queuedOutputTruncated: false,
  }), { ok: true });
  assert.deepEqual(missing.manager.prepareTerminalAuthorityPromotionCandidate(SESSION_ID, {
    transitionEpoch: '8',
    limitedSessionSelected: true,
  }), { ok: true });
  parity = missing.manager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
  assert.equal(parity.leaseParity, true);
  assert.equal(parity.noLocalCacheParity, true);
  assert.equal(parity.limitedSessionSelected, true);
  assert.deepEqual(parity.blockers, []);

  const mismatch = createHarness({ comparerResult: 'mismatch' });
  t.after(mismatch.close);
  await settleRetainedComparison(mismatch.pty);
  assert.equal(mismatch.manager.registerRetainedTerminalClientView(SESSION_ID, 'browser-b', 2).ok, true);
  assert.equal(mismatch.manager.claimRetainedTerminalDriverLease(SESSION_ID, 'browser-b', 2).ok, true);
  assert.deepEqual(mismatch.manager.recordTerminalAuthorityServerRecoveryApplied(SESSION_ID, {
    clientId: 'browser-b',
    viewGeneration: 2,
    replayToken: 'server-replay-b',
    snapshotSeq: 1,
    snapshotMode: 'authoritative',
    snapshotTruncated: false,
    queuedOutputBytes: 0,
    queuedOutputTruncated: false,
  }), { ok: true });
  assert.deepEqual(mismatch.manager.prepareTerminalAuthorityPromotionCandidate(SESSION_ID, {
    transitionEpoch: '8',
    limitedSessionSelected: true,
  }), { ok: true });
  const mismatchParity = mismatch.manager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
  assert.equal(mismatchParity.retainedStateParity, false);
  assert.ok(mismatchParity.blockers.includes('retained-state-parity-mismatch'));
});

test('MIG-BGSTAB-002 reconnect cleanup revokes runtime leases and invalidates prepared promotion evidence', async t => {
  const harness = createHarness();
  t.after(harness.close);
  const { manager } = harness;
  assert.equal(manager.registerRetainedTerminalClientView(SESSION_ID, 'browser-a', 4).ok, true);
  assert.equal(manager.claimRetainedTerminalDriverLease(SESSION_ID, 'browser-a', 4).ok, true);
  assert.deepEqual(manager.recordTerminalAuthorityServerRecoveryApplied(SESSION_ID, {
    clientId: 'browser-a',
    viewGeneration: 4,
    replayToken: 'server-replay-reconnect',
    snapshotSeq: 1,
    snapshotMode: 'authoritative',
    snapshotTruncated: false,
    queuedOutputBytes: 0,
    queuedOutputTruncated: false,
  }), { ok: true });
  assert.deepEqual(manager.prepareTerminalAuthorityPromotionCandidate(SESSION_ID, {
    transitionEpoch: '8',
    limitedSessionSelected: true,
  }), { ok: true });

  assert.deepEqual(manager.cleanupTerminalAuthorityRuntimePorts(SESSION_ID, {
    scope: 'reconnect',
  }), { ok: true });
  const state = manager.getTerminalAuthorityRuntimePortState(SESSION_ID);
  assert.equal(state?.admission.mode, 'none');
  assert.equal(state?.driver.activeLeaseId, null);
  assert.equal(state?.responder.activeLeaseId, null);
  assert.equal(state?.reconnectGeneration, 1);
  const parity = manager.readTerminalAuthorityPromotionParitySnapshot(SESSION_ID);
  assert.equal(parity.leaseParity, false);
  assert.equal(parity.noLocalCacheParity, false);
  const blockedReconnectAdmission = manager.establishRetainedTerminalMutationLease(
    SESSION_ID,
    'browser-c',
    1,
  );
  assert.equal(blockedReconnectAdmission.ok, false);
  assert.equal(
    blockedReconnectAdmission.ok ? undefined : blockedReconnectAdmission.reason,
    'authority-admission-closed',
  );
});
