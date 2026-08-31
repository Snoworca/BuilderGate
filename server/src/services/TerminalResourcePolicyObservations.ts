import type {
  TerminalResourceConsumerState,
  TerminalResourceKey,
  TerminalResourcePolicyConsumerId,
} from './TerminalResourcePolicy.js';

export interface RegisteredTerminalResourcePolicyObservationDecision {
  consumer: TerminalResourcePolicyConsumerId;
  resource: TerminalResourceKey;
  source: string;
  state: TerminalResourceConsumerState;
}

const REGISTERED_OBSERVATION_DECISIONS = [
  ['browser.hidden-output', 'resourceLimits.terminal.hiddenOutputPolicy', 'resourceLimits.terminal.hiddenOutputPolicy', 'consumed'],
  ['browser.hidden-output', 'resourceLimits.terminal.hiddenOutputTailBytes', 'resourceLimits.terminal.hiddenOutputTailBytes', 'consumed'],
  ['browser.runtime.residency', 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', 'consumed'],
  ['browser.runtime.residency', 'resourceLimits.workspaceRuntime.maxLiveTerminals', 'resourceLimits.workspaceRuntime.maxLiveTerminals', 'consumed'],
  ['browser.runtime.residency', 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', 'consumed'],
  ['browser.snapshot.persisted-storage', 'resourceLimits.snapshots.maxEntries', 'resourceLimits.snapshots.maxEntries', 'consumed'],
  ['browser.snapshot.persisted-storage', 'resourceLimits.snapshots.perSnapshotMaxChars', 'resourceLimits.snapshots.perSnapshotMaxChars', 'consumed'],
  ['browser.snapshot.persisted-storage', 'resourceLimits.snapshots.tombstoneTtlMs', 'resourceLimits.snapshots.tombstoneTtlMs', 'consumed'],
  ['browser.snapshot.persisted-storage', 'resourceLimits.snapshots.totalStorageBudgetChars', 'resourceLimits.snapshots.totalStorageBudgetChars', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.clientWs.hardReconnectBytes', 'resourceLimits.clientWs.hardReconnectBytes', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.clientWs.inputBackpressureBytes', 'resourceLimits.clientWs.inputBackpressureBytes', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.terminal.inputQueueMaxBytes', 'resourceLimits.terminal.inputQueueMaxBytes', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.terminal.inputQueueTtlMs', 'resourceLimits.terminal.inputQueueTtlMs', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.terminal.transportOutboxMaxBytes', 'resourceLimits.terminal.transportOutboxMaxBytes', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.terminal.transportOutboxTtlMs', 'resourceLimits.terminal.transportOutboxTtlMs', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.terminal.visibleOutputMaxChunks', 'resourceLimits.terminal.visibleOutputMaxChunks', 'consumed'],
  ['browser.terminal.recovery-scheduler', 'resourceLimits.terminal.visibleOutputQueueMaxBytes', 'resourceLimits.terminal.visibleOutputQueueMaxBytes', 'consumed'],
  ['browser.terminal.write-scheduler', 'resourceLimits.terminal.scrollbackLines', 'TerminalView:xterm-constructor-hardcoded', 'divergent-legacy'],
  ['browser.terminal.write-scheduler', 'resourceLimits.terminal.visibleFlushBudgetBytes', 'resourceLimits.terminal.visibleFlushBudgetBytes', 'consumed'],
  ['browser.terminal.write-scheduler', 'resourceLimits.terminal.visibleOutputMaxChunks', 'resourceLimits.terminal.visibleOutputMaxChunks', 'consumed'],
  ['browser.terminal.write-scheduler', 'resourceLimits.terminal.visibleOutputQueueMaxBytes', 'resourceLimits.terminal.visibleOutputQueueMaxBytes', 'consumed'],
  ['server.config.runtime-store', 'resourceLimits.headless.writeBatchMaxBytes', 'resourceLimits.headless.writeBatchMaxBytes', 'reserved-unapplied'],
  ['server.config.runtime-store', 'resourceLimits.headless.writeLagWarnMs', 'resourceLimits.headless.writeLagWarnMs', 'reserved-unapplied'],
  ['server.pty.headless-model', 'resourceLimits.headless.overflowPolicy', 'resourceLimits.headless.overflowPolicy', 'consumed'],
  ['server.pty.headless-model', 'resourceLimits.headless.pendingOutputMaxBytes', 'resourceLimits.headless.pendingOutputMaxBytes', 'consumed'],
  ['server.pty.headless-model', 'resourceLimits.headless.pendingOutputMaxChunks', 'resourceLimits.headless.pendingOutputMaxChunks', 'consumed'],
  ['server.pty.headless-model', 'resourceLimits.terminal.scrollbackLines', 'pty.scrollbackLines', 'divergent-legacy'],
  ['server.snapshot.replay-repair', 'resourceLimits.headless.pendingOutputMaxChunks', 'resourceLimits.headless.pendingOutputMaxChunks', 'consumed'],
  ['server.ws.router', 'resourceLimits.ws.outputCoalesceWindowMs', 'resourceLimits.ws.outputCoalesceWindowMs', 'consumed'],
  ['server.ws.router', 'resourceLimits.ws.perClientControlQueueMaxBytes', 'resourceLimits.ws.perClientControlQueueMaxBytes', 'consumed'],
  ['server.ws.router', 'resourceLimits.ws.perClientOutputQueueMaxBytes', 'resourceLimits.ws.perClientOutputQueueMaxBytes', 'consumed'],
  ['server.ws.router', 'resourceLimits.ws.serverBufferedHardLimitBytes', 'resourceLimits.ws.serverBufferedHardLimitBytes', 'consumed'],
  ['server.ws.router', 'resourceLimits.ws.serverBufferedHighWaterBytes', 'resourceLimits.ws.serverBufferedHighWaterBytes', 'consumed'],
  ['server.ws.send-policy', 'resourceLimits.ws.outputCoalesceWindowMs', 'resourceLimits.ws.outputCoalesceWindowMs', 'consumed'],
] as const satisfies readonly (readonly [
  TerminalResourcePolicyConsumerId,
  TerminalResourceKey,
  string,
  TerminalResourceConsumerState,
])[];

export function getRegisteredTerminalResourcePolicyObservationDecisions(): RegisteredTerminalResourcePolicyObservationDecision[] {
  return REGISTERED_OBSERVATION_DECISIONS.map(([consumer, resource, source, state]) => ({
    consumer,
    resource,
    source,
    state,
  }));
}
