import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import {
  TERMINAL_RESOURCE_KEYS,
  TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
  TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
  getTerminalResourcePolicyUnit,
  type TerminalResourceConsumerState,
  type TerminalResourceKey,
  type TerminalResourcePolicyConsumerId,
} from './TerminalResourcePolicy.js';

export interface TerminalResourceConsumerManifestEntry {
  consumerId: TerminalResourcePolicyConsumerId;
  category: string;
  resourceKey: TerminalResourceKey;
  unit: string;
  source: string;
  schemaVersion: string;
  profileVersion: string;
  legacyAliases: string[];
  applyBoundary: string;
  consumerPath: string;
  consumerSymbol: string;
  evidenceSignature: string;
  evidenceRole: TerminalResourceEvidenceRole;
  evidenceAstSha256: string;
  state: TerminalResourceConsumerState;
}

export type TerminalResourceEvidenceRole = 'object-option-flow' | 'reserved-copy'
  | 'control-guard' | 'call-input' | 'derived-control';

export const TERMINAL_RESOURCE_EVIDENCE_HASH_SCHEMA_VERSION = 'terminal-resource-evidence-ast/v1';

export interface TerminalResourcePathClassification {
  path: string;
  classification: 'schema-source' | 'settings-facade' | 'persistence-boundary'
    | 'policy-projection' | 'consumer-adapter';
  symbol: string;
  evidenceSignature: string;
  accessEvidenceSha256: string;
  reason: string;
}

export interface TerminalResourceConsumerManifest {
  schemaVersion: string;
  profileVersion: string;
  consumers: TerminalResourceConsumerManifestEntry[];
  classifications: TerminalResourcePathClassification[];
  evidence?: Record<string, unknown>;
}

type CatalogEntry = Omit<TerminalResourceConsumerManifestEntry, 'evidenceAstSha256'>;

type CatalogSeed = Omit<CatalogEntry, 'schemaVersion' | 'profileVersion' | 'legacyAliases'>
  & { legacyAliases?: string[] };

function catalog(seed: CatalogSeed): CatalogEntry {
  return {
    ...seed,
    schemaVersion: TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
    profileVersion: TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
    legacyAliases: seed.legacyAliases ?? [],
  };
}

const CONSUMER_CATALOG: readonly CatalogEntry[] = [
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.headless.pendingOutputMaxBytes', unit: 'bytes', source: 'resourceLimits.headless.pendingOutputMaxBytes', applyBoundary: 'new-session', consumerPath: 'server/src/services/SessionManager.ts', consumerSymbol: 'SessionManager.createHeadlessOutputQueue', evidenceSignature: 'maxBytes: limits.pendingOutputMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.headless.pendingOutputMaxBytes', unit: 'bytes', source: 'resourceLimits.headless.pendingOutputMaxBytes', applyBoundary: 'queue-admission', consumerPath: 'server/src/utils/headlessOutputQueue.ts', consumerSymbol: 'DefaultHeadlessOutputQueue.constructor', evidenceSignature: 'maxBytes: options.maxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.headless.pendingOutputMaxChunks', unit: 'count', source: 'resourceLimits.headless.pendingOutputMaxChunks', applyBoundary: 'new-session', consumerPath: 'server/src/services/SessionManager.ts', consumerSymbol: 'SessionManager.createHeadlessOutputQueue', evidenceSignature: 'maxChunks: limits.pendingOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.headless.pendingOutputMaxChunks', unit: 'count', source: 'resourceLimits.headless.pendingOutputMaxChunks', applyBoundary: 'queue-admission', consumerPath: 'server/src/utils/headlessOutputQueue.ts', consumerSymbol: 'DefaultHeadlessOutputQueue.constructor', evidenceSignature: 'maxChunks: options.maxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.snapshot.replay-repair', category: 'snapshot-replay-repair', resourceKey: 'resourceLimits.headless.pendingOutputMaxChunks', unit: 'count', source: 'resourceLimits.headless.pendingOutputMaxChunks', applyBoundary: 'recovery-generation', consumerPath: 'server/src/services/SessionManager.ts', consumerSymbol: 'SessionManager.getScreenRepairQueuePolicy', evidenceSignature: 'maxChunks: this.runtimeHeadlessQueueConfig.limits.pendingOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'reserved-copy', consumerId: 'server.config.runtime-store', category: 'server-config-schema-store', resourceKey: 'resourceLimits.headless.writeLagWarnMs', unit: 'ms', source: 'resourceLimits.headless.writeLagWarnMs', applyBoundary: 'reserved-unapplied', consumerPath: 'server/src/services/SessionManager.ts', consumerSymbol: 'cloneHeadlessResourceLimits', evidenceSignature: 'writeLagWarnMs: source.writeLagWarnMs', state: 'reserved-unapplied' }),
  catalog({ evidenceRole: 'reserved-copy', consumerId: 'server.config.runtime-store', category: 'server-config-schema-store', resourceKey: 'resourceLimits.headless.writeBatchMaxBytes', unit: 'bytes', source: 'resourceLimits.headless.writeBatchMaxBytes', applyBoundary: 'reserved-unapplied', consumerPath: 'server/src/services/SessionManager.ts', consumerSymbol: 'cloneHeadlessResourceLimits', evidenceSignature: 'writeBatchMaxBytes: source.writeBatchMaxBytes', state: 'reserved-unapplied' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.headless.overflowPolicy', unit: 'enum', source: 'resourceLimits.headless.overflowPolicy', applyBoundary: 'new-session', consumerPath: 'server/src/services/SessionManager.ts', consumerSymbol: 'SessionManager.createHeadlessOutputQueue', evidenceSignature: 'overflowPolicy: limits.overflowPolicy', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.headless.overflowPolicy', unit: 'enum', source: 'resourceLimits.headless.overflowPolicy', applyBoundary: 'new-session', consumerPath: 'server/src/utils/headlessOutputQueue.ts', consumerSymbol: 'DefaultHeadlessOutputQueue.enqueue', evidenceSignature: "shouldDegradeHeadless: this.overflowPolicy === 'degrade-headless'", state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'server.ws.router', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.serverBufferedHighWaterBytes', unit: 'bytes', source: 'resourceLimits.ws.serverBufferedHighWaterBytes', applyBoundary: 'immediate-send-gate', consumerPath: 'server/src/ws/WsRouter.ts', consumerSymbol: 'WsRouter.sendTransportMessage', evidenceSignature: 'limits.serverBufferedHighWaterBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'server.ws.router', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.serverBufferedHighWaterBytes', unit: 'bytes', source: 'resourceLimits.ws.serverBufferedHighWaterBytes', applyBoundary: 'immediate-drain-gate', consumerPath: 'server/src/ws/WsRouter.ts', consumerSymbol: 'WsRouter.flushTransportQueue', evidenceSignature: 'limits.serverBufferedHighWaterBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'server.ws.router', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.serverBufferedHardLimitBytes', unit: 'bytes', source: 'resourceLimits.ws.serverBufferedHardLimitBytes', applyBoundary: 'immediate-send-gate', consumerPath: 'server/src/ws/WsRouter.ts', consumerSymbol: 'WsRouter.sendTransportMessage', evidenceSignature: 'limits.serverBufferedHardLimitBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'server.ws.router', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.serverBufferedHardLimitBytes', unit: 'bytes', source: 'resourceLimits.ws.serverBufferedHardLimitBytes', applyBoundary: 'immediate-drain-gate', consumerPath: 'server/src/ws/WsRouter.ts', consumerSymbol: 'WsRouter.flushTransportQueue', evidenceSignature: 'limits.serverBufferedHardLimitBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'call-input', consumerId: 'server.ws.router', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.perClientOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.ws.perClientOutputQueueMaxBytes', applyBoundary: 'immediate', consumerPath: 'server/src/ws/WsRouter.ts', consumerSymbol: 'WsRouter.admitTerminalResourcePolicyCanaryMessage', evidenceSignature: 'limits.perClientOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'server.ws.router', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.perClientControlQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.ws.perClientControlQueueMaxBytes', applyBoundary: 'immediate', consumerPath: 'server/src/ws/WsRouter.ts', consumerSymbol: 'WsRouter.enqueueTransportMessage', evidenceSignature: 'limits.perClientControlQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'call-input', consumerId: 'server.ws.router', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.outputCoalesceWindowMs', unit: 'ms', source: 'resourceLimits.ws.outputCoalesceWindowMs', applyBoundary: 'immediate', consumerPath: 'server/src/ws/WsRouter.ts', consumerSymbol: 'WsRouter.enqueueTransportMessage', evidenceSignature: 'limits.outputCoalesceWindowMs', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'server.ws.send-policy', category: 'websocket-router-send-policy', resourceKey: 'resourceLimits.ws.outputCoalesceWindowMs', unit: 'ms', source: 'resourceLimits.ws.outputCoalesceWindowMs', applyBoundary: 'immediate-delegated', consumerPath: 'server/src/ws/wsSendPolicy.ts', consumerSymbol: 'tryCoalesceOutputMessage', evidenceSignature: 'incoming.queuedAt - existing.queuedAt > coalesceWindowMs', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.clientWs.inputBackpressureBytes', unit: 'bytes', source: 'resourceLimits.clientWs.inputBackpressureBytes', applyBoundary: 'browser-send', consumerPath: 'frontend/src/contexts/WebSocketContext.tsx', consumerSymbol: 'WebSocketProvider#send', evidenceSignature: 'limits: getClientWsResourceLimits()', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.clientWs.inputBackpressureBytes', unit: 'bytes', source: 'resourceLimits.clientWs.inputBackpressureBytes', applyBoundary: 'browser-send-admission', consumerPath: 'frontend/src/utils/webSocketBackpressure.ts', consumerSymbol: 'evaluateBrowserInputBackpressure', evidenceSignature: 'projectedBytes > input.limits.inputBackpressureBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.clientWs.hardReconnectBytes', unit: 'bytes', source: 'resourceLimits.clientWs.hardReconnectBytes', applyBoundary: 'browser-send', consumerPath: 'frontend/src/contexts/WebSocketContext.tsx', consumerSymbol: 'WebSocketProvider#send', evidenceSignature: 'limits: getClientWsResourceLimits()', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.clientWs.hardReconnectBytes', unit: 'bytes', source: 'resourceLimits.clientWs.hardReconnectBytes', applyBoundary: 'browser-hard-reconnect', consumerPath: 'frontend/src/utils/webSocketBackpressure.ts', consumerSymbol: 'evaluateBrowserInputBackpressure', evidenceSignature: 'projectedBytes > input.limits.hardReconnectBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'browser-output-generation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#getOutputScheduler', evidenceSignature: 'visibleOutputQueueMaxBytes: limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'browser-ingress-retry-generation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#getOutputScheduler', evidenceSignature: 'maxBytes: limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'browser-ingress-single-output-cap', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#getOutputScheduler', evidenceSignature: 'maxSingleIngressBytes: limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'restore-single-output-admission', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#bufferOutputWhileRestorePending', evidenceSignature: 'byteLength > limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'restore-total-output-admission', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#bufferOutputWhileRestorePending', evidenceSignature: 'nextBytes > limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'restore-output-overflow-observation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#bufferOutputWhileRestorePending', evidenceSignature: 'maxBytes: limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'browser-output-admission', consumerPath: 'frontend/src/utils/terminalOutputScheduler.ts', consumerSymbol: 'createTerminalOutputScheduler#enqueueLegacy', evidenceSignature: 'queuedBytes + bytes.byteLength > config.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'browser-output-generation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#getOutputScheduler', evidenceSignature: 'visibleOutputMaxChunks: limits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'browser-ingress-retry-generation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#getOutputScheduler', evidenceSignature: 'maxChunks: limits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'restore-output-chunk-admission', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#bufferOutputWhileRestorePending', evidenceSignature: 'nextChunks > limits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'restore-output-overflow-observation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#bufferOutputWhileRestorePending', evidenceSignature: 'maxChunks: limits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'call-input', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'browser-output-admission', consumerPath: 'frontend/src/utils/terminalOutputScheduler.ts', consumerSymbol: 'createTerminalOutputScheduler#compactToChunkLimit', evidenceSignature: 'normalizeChunkLimit(config.visibleOutputMaxChunks)', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'screen-repair-recovery-generation', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'TerminalContainer#handleScreenRepairRestoreNeeded', evidenceSignature: 'maxHeldBytes: terminalLimits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'screen-repair-recovery-generation', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'TerminalContainer#handleScreenRepairRestoreNeeded', evidenceSignature: 'maxHeldChunks: terminalLimits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'compatibility-post-ack-convergence', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'TerminalContainer#handleScreenSnapshot', evidenceSignature: 'maxHeldBytes: terminalLimits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'compatibility-post-ack-convergence', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'TerminalContainer#handleScreenSnapshot', evidenceSignature: 'maxHeldChunks: terminalLimits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'derived-control', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'grace-output-admission', consumerPath: 'frontend/src/contexts/WebSocketContext.tsx', consumerSymbol: 'WebSocketProvider#bufferGraceMessage', evidenceSignature: 'current.outputBytes + messageBytes > limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'grace-output-overflow-observation', consumerPath: 'frontend/src/contexts/WebSocketContext.tsx', consumerSymbol: 'WebSocketProvider#bufferGraceMessage', evidenceSignature: 'maxBytes: limits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'derived-control', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'grace-output-admission', consumerPath: 'frontend/src/contexts/WebSocketContext.tsx', consumerSymbol: 'WebSocketProvider#bufferGraceMessage', evidenceSignature: 'current.output.length + 1 > limits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'grace-output-overflow-observation', consumerPath: 'frontend/src/contexts/WebSocketContext.tsx', consumerSymbol: 'WebSocketProvider#bufferGraceMessage', evidenceSignature: 'maxChunks: limits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleFlushBudgetBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleFlushBudgetBytes', applyBoundary: 'browser-frame', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#getOutputScheduler', evidenceSignature: 'visibleFlushBudgetBytes: limits.visibleFlushBudgetBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'call-input', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleFlushBudgetBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleFlushBudgetBytes', applyBoundary: 'browser-write-slice', consumerPath: 'frontend/src/utils/terminalOutputScheduler.ts', consumerSymbol: 'createTerminalOutputScheduler#drainFrame', evidenceSignature: 'config.visibleFlushBudgetBytes,', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.hidden-output', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.terminal.hiddenOutputPolicy', unit: 'enum', source: 'resourceLimits.terminal.hiddenOutputPolicy', applyBoundary: 'visibility-decision', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'TerminalContainer#$callback:useEffect:0@127825#onOutput', evidenceSignature: 'hiddenOutputPolicy: terminalLimits.hiddenOutputPolicy', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.hidden-output', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.terminal.hiddenOutputPolicy', unit: 'enum', source: 'resourceLimits.terminal.hiddenOutputPolicy', applyBoundary: 'visibility-enforcement', consumerPath: 'frontend/src/utils/terminalHiddenOutput.ts', consumerSymbol: 'resolveHiddenOutput', evidenceSignature: "hiddenOutputPolicy === 'write-hidden'", state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.hidden-output', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.terminal.hiddenOutputTailBytes', unit: 'bytes', source: 'resourceLimits.terminal.hiddenOutputTailBytes', applyBoundary: 'visibility-decision', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'TerminalContainer#$callback:useEffect:0@127825#onOutput', evidenceSignature: 'hiddenOutputTailBytes: terminalLimits.hiddenOutputTailBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'call-input', consumerId: 'browser.hidden-output', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.terminal.hiddenOutputTailBytes', unit: 'bytes', source: 'resourceLimits.terminal.hiddenOutputTailBytes', applyBoundary: 'hidden-tail-cap', consumerPath: 'frontend/src/utils/terminalHiddenOutput.ts', consumerSymbol: 'resolveHiddenOutput', evidenceSignature: 'input.hiddenOutputTailBytes ?? 0', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'recovery-held-output-cap', consumerPath: 'frontend/src/utils/visibleOutputRecovery.ts', consumerSymbol: 'createVisibleOutputRecoveryCoordinator#acceptOutput', evidenceSignature: 'record.state.heldOutputBytes + chunkBytes > maxHeldBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'recovery-held-chunk-cap', consumerPath: 'frontend/src/utils/visibleOutputRecovery.ts', consumerSymbol: 'createVisibleOutputRecoveryCoordinator#acceptOutput', evidenceSignature: 'record.state.heldChunks.length + 1 > maxHeldChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.inputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.inputQueueMaxBytes', applyBoundary: 'recovery-generation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'getInputQueueLimits', evidenceSignature: 'inputQueueMaxBytes: limits.inputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.inputQueueTtlMs', unit: 'ms', source: 'resourceLimits.terminal.inputQueueTtlMs', applyBoundary: 'recovery-generation', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'getInputQueueLimits', evidenceSignature: 'inputQueueTtlMs: limits.inputQueueTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.visibleOutputQueueMaxBytes', applyBoundary: 'checkpoint-write-coordinator', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#$callback:useEffect:0@121057', evidenceSignature: 'postCheckpointMaxBytes: coordinatorLimits.visibleOutputQueueMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'checkpoint-write-coordinator', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#$callback:useEffect:0@121057', evidenceSignature: 'postCheckpointMaxChunks: coordinatorLimits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'checkpoint-input-count-cap', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#$callback:useEffect:0@121057', evidenceSignature: 'pendingInputMaxCount: coordinatorLimits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.visibleOutputMaxChunks', unit: 'count', source: 'resourceLimits.terminal.visibleOutputMaxChunks', applyBoundary: 'checkpoint-settlement-ledger-cap', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#$callback:useEffect:0@121057', evidenceSignature: 'settlementLedgerMaxEntries: coordinatorLimits.visibleOutputMaxChunks', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.transportOutboxMaxBytes', unit: 'bytes', source: 'resourceLimits.terminal.transportOutboxMaxBytes', applyBoundary: 'browser-transport-generation', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'getTransportOutboxLimits', evidenceSignature: 'transportOutboxMaxBytes: limits.transportOutboxMaxBytes', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.recovery-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.transportOutboxTtlMs', unit: 'ms', source: 'resourceLimits.terminal.transportOutboxTtlMs', applyBoundary: 'browser-transport-generation', consumerPath: 'frontend/src/components/Terminal/TerminalContainer.tsx', consumerSymbol: 'getTransportOutboxLimits', evidenceSignature: 'transportOutboxTtlMs: limits.transportOutboxTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.terminal.scrollbackLines', unit: 'lines', source: 'pty.scrollbackLines', legacyAliases: ['pty.scrollbackLines'], applyBoundary: 'session-generation', consumerPath: 'server/src/services/SessionManager.ts', consumerSymbol: 'SessionManager.initializeHeadlessState', evidenceSignature: 'this.compiledTerminalResourcePolicy.legacyPolicy.terminal.scrollbackLines.value', state: 'divergent-legacy' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'server.pty.headless-model', category: 'pty-headless-model', resourceKey: 'resourceLimits.terminal.scrollbackLines', unit: 'lines', source: 'pty.scrollbackLines', legacyAliases: ['pty.scrollbackLines'], applyBoundary: 'headless-terminal-construction', consumerPath: 'server/src/utils/headlessTerminal.ts', consumerSymbol: 'createHeadlessTerminalState', evidenceSignature: 'scrollback: options.scrollbackLines', state: 'divergent-legacy' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.terminal.write-scheduler', category: 'terminal-write-recovery-scheduler', resourceKey: 'resourceLimits.terminal.scrollbackLines', unit: 'lines', source: 'TerminalView:xterm-constructor-hardcoded', applyBoundary: 'terminal-runtime-construction', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#$callback:useEffect:0@121057', evidenceSignature: 'scrollback: 10000', state: 'divergent-legacy' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.perSnapshotMaxChars', unit: 'chars', source: 'resourceLimits.snapshots.perSnapshotMaxChars', applyBoundary: 'snapshot-read-cap', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#loadStoredSnapshot', evidenceSignature: 'maxContentLength: snapshotLimits.perSnapshotMaxChars', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.perSnapshotMaxChars', unit: 'chars', source: 'resourceLimits.snapshots.perSnapshotMaxChars', applyBoundary: 'snapshot-write-cap', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#saveSnapshot', evidenceSignature: 'maxContentLength: snapshotLimits.perSnapshotMaxChars', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.perSnapshotMaxChars', unit: 'chars', source: 'resourceLimits.snapshots.perSnapshotMaxChars', applyBoundary: 'snapshot-size-admission', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#saveSnapshot', evidenceSignature: 'content.length > snapshotLimits.perSnapshotMaxChars', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.perSnapshotMaxChars', unit: 'chars', source: 'resourceLimits.snapshots.perSnapshotMaxChars', applyBoundary: 'snapshot-parse-cap', consumerPath: 'frontend/src/utils/terminalSnapshot.ts', consumerSymbol: 'parseTerminalViewportSnapshot', evidenceSignature: 'content.length > maxContentLength', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.totalStorageBudgetChars', unit: 'chars', source: 'resourceLimits.snapshots.totalStorageBudgetChars', applyBoundary: 'snapshot-eviction', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#saveSnapshot', evidenceSignature: 'maxTotalChars: snapshotLimits.totalStorageBudgetChars', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.totalStorageBudgetChars', unit: 'chars', source: 'resourceLimits.snapshots.totalStorageBudgetChars', applyBoundary: 'auth-token-quota-recovery', consumerPath: 'frontend/src/services/tokenStorage.ts', consumerSymbol: 'setToken', evidenceSignature: 'maxTotalChars: snapshotLimits.totalStorageBudgetChars', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.totalStorageBudgetChars', unit: 'chars', source: 'resourceLimits.snapshots.totalStorageBudgetChars', applyBoundary: 'snapshot-storage-cap', consumerPath: 'frontend/src/utils/terminalSnapshot.ts', consumerSymbol: 'setTerminalSnapshotWithQuotaRecovery', evidenceSignature: 'targetMaxChars: options.maxTotalChars ?? TERMINAL_SNAPSHOT_STORAGE_BUDGET_CHARS', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.maxEntries', unit: 'count', source: 'resourceLimits.snapshots.maxEntries', applyBoundary: 'snapshot-eviction', consumerPath: 'frontend/src/services/tokenStorage.ts', consumerSymbol: 'setToken', evidenceSignature: 'maxEntries: snapshotLimits.maxEntries', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.maxEntries', unit: 'count', source: 'resourceLimits.snapshots.maxEntries', applyBoundary: 'snapshot-eviction', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#saveSnapshot', evidenceSignature: 'maxEntries: snapshotLimits.maxEntries', state: 'consumed' }),
  catalog({ evidenceRole: 'derived-control', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.maxEntries', unit: 'count', source: 'resourceLimits.snapshots.maxEntries', applyBoundary: 'snapshot-entry-cap', consumerPath: 'frontend/src/utils/terminalSnapshot.ts', consumerSymbol: 'evictTerminalSnapshots', evidenceSignature: 'snapshotEntryCount > maxEntries', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.tombstoneTtlMs', unit: 'ms', source: 'resourceLimits.snapshots.tombstoneTtlMs', applyBoundary: 'snapshot-cleanup', consumerPath: 'frontend/src/utils/inputReliabilityMode.ts', consumerSymbol: 'cleanupTerminalSnapshotTombstonesFromRuntimeConfig', evidenceSignature: 'resourceLimits.snapshots.tombstoneTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.tombstoneTtlMs', unit: 'ms', source: 'resourceLimits.snapshots.tombstoneTtlMs', applyBoundary: 'snapshot-save-tombstone-check', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#saveSnapshot', evidenceSignature: 'tombstoneTtlMs: snapshotLimits.tombstoneTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.tombstoneTtlMs', unit: 'ms', source: 'resourceLimits.snapshots.tombstoneTtlMs', applyBoundary: 'buffered-output-tombstone-check', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#persistBufferedOutput', evidenceSignature: 'tombstoneTtlMs: snapshotLimits.tombstoneTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.tombstoneTtlMs', unit: 'ms', source: 'resourceLimits.snapshots.tombstoneTtlMs', applyBoundary: 'terminal-dispose-tombstone-check', consumerPath: 'frontend/src/components/Terminal/TerminalView.tsx', consumerSymbol: 'TerminalView#$callback:useEffect:0@121057#$anonymous@169494', evidenceSignature: 'tombstoneTtlMs: snapshotLimits.tombstoneTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.snapshot.persisted-storage', category: 'persisted-snapshot-storage', resourceKey: 'resourceLimits.snapshots.tombstoneTtlMs', unit: 'ms', source: 'resourceLimits.snapshots.tombstoneTtlMs', applyBoundary: 'snapshot-tombstone-expiry', consumerPath: 'frontend/src/utils/terminalSnapshot.ts', consumerSymbol: 'cleanupExpiredTerminalSnapshotTombstones', evidenceSignature: 'nowMs - entry.savedAtMs <= tombstoneTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'object-option-flow', consumerId: 'browser.runtime.residency', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', unit: 'count', source: 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', applyBoundary: 'runtime-residency-projection', consumerPath: 'frontend/src/hooks/useTerminalRuntimeResidency.ts', consumerSymbol: 'resolveTerminalRuntimeResidency', evidenceSignature: 'maxLiveWorkspaces: input.limits.maxLiveWorkspaces', state: 'consumed' }),
  catalog({ evidenceRole: 'control-guard', consumerId: 'browser.runtime.residency', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', unit: 'count', source: 'resourceLimits.workspaceRuntime.maxLiveWorkspaces', applyBoundary: 'runtime-residency-cap', consumerPath: 'frontend/src/hooks/useTerminalRuntimeResidency.ts', consumerSymbol: 'applyWorkspaceCap', evidenceSignature: 'hiddenWorkspaceIds.size <= input.maxLiveWorkspaces', state: 'consumed' }),
  catalog({ evidenceRole: 'call-input', consumerId: 'browser.runtime.residency', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.workspaceRuntime.maxLiveTerminals', unit: 'count', source: 'resourceLimits.workspaceRuntime.maxLiveTerminals', applyBoundary: 'runtime-residency', consumerPath: 'frontend/src/hooks/useTerminalRuntimeResidency.ts', consumerSymbol: 'resolveTerminalRuntimeResidency', evidenceSignature: 'input.limits.maxLiveTerminals', state: 'consumed' }),
  catalog({ evidenceRole: 'derived-control', consumerId: 'browser.runtime.residency', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', unit: 'ms', source: 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', applyBoundary: 'runtime-residency-decision', consumerPath: 'frontend/src/hooks/useTerminalRuntimeResidency.ts', consumerSymbol: 'resolveTerminalRuntimeResidency', evidenceSignature: 'input.limits.hiddenRuntimeTtlMs', state: 'consumed' }),
  catalog({ evidenceRole: 'derived-control', consumerId: 'browser.runtime.residency', category: 'browser-runtime-residency-hidden-output', resourceKey: 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', unit: 'ms', source: 'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs', applyBoundary: 'runtime-residency-refresh', consumerPath: 'frontend/src/hooks/useTerminalRuntimeResidency.ts', consumerSymbol: 'getNextTerminalRuntimeResidencyRefreshDelay', evidenceSignature: 'input.limits.hiddenRuntimeTtlMs', state: 'consumed' }),
] as const;

const PATH_CLASSIFICATIONS: readonly TerminalResourcePathClassification[] = [
  { path: 'server/src/types/config.types.ts', classification: 'schema-source', symbol: 'ResourceLimitsConfig', evidenceSignature: 'export interface ResourceLimitsConfig', accessEvidenceSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', reason: 'Typed source; it does not make runtime decisions.' },
  { path: 'server/src/schemas/config.schema.ts', classification: 'schema-source', symbol: 'resourceLimitsSchema', evidenceSignature: 'export const resourceLimitsSchema', accessEvidenceSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', reason: 'Validation/default source; it does not make runtime decisions.' },
  { path: 'server/src/services/RuntimeConfigStore.ts', classification: 'policy-projection', symbol: 'getTerminalResourcePolicyObservation', evidenceSignature: 'getTerminalResourcePolicyObservation', accessEvidenceSha256: 'f98f45d38dbe49427b6c59b6f0817a7c702d9967b0e1195027e078cbb61aaaa6', reason: 'Projects effective values and evidence without claiming consumer application.' },
  { path: 'server/src/services/SettingsService.ts', classification: 'settings-facade', symbol: 'mergeEditablePatch', evidenceSignature: 'mergeEditablePatch', accessEvidenceSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', reason: 'Settings facade passes values to persistence/runtime boundaries.' },
  { path: 'server/src/services/ConfigFileRepository.ts', classification: 'persistence-boundary', symbol: 'applyEditableValues', evidenceSignature: 'function applyEditableValues', accessEvidenceSha256: '99ca442cae983de0925938267e2a74856eba8b0587e8dccdda8381d04111dd39', reason: 'Persists configuration; it is not a terminal runtime consumer.' },
  { path: 'frontend/src/utils/inputReliabilityMode.ts', classification: 'policy-projection', symbol: 'getTerminalResourceLimits', evidenceSignature: 'export function getTerminalResourceLimits', accessEvidenceSha256: '5c0e5934d04fe2a9efd6a69c26f23fc745c7e837b99305523ac7847c39ab6cb6', reason: 'Browser config projection plus tombstone cleanup consumer.' },
  { path: 'frontend/src/utils/terminalOutputHotPath.ts', classification: 'policy-projection', symbol: 'getTerminalOutputHotPathLimits', evidenceSignature: 'getTerminalResourceLimits()', accessEvidenceSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', reason: 'Caches browser terminal limits for downstream runtime consumers.' },
  { path: 'frontend/src/components/Settings/settingsDraftHelpers.ts', classification: 'settings-facade', symbol: 'mergeSettingsDraft', evidenceSignature: 'resourceLimits.headless.pendingOutputMaxBytes', accessEvidenceSha256: '37e29d7a9b35d8580277ec9cad6dacad0975a3b6648e190eb6b9bcc979e5701a', reason: 'Settings draft projection; it does not apply terminal runtime decisions.' },
  { path: 'frontend/src/types/settings.ts', classification: 'schema-source', symbol: 'EditableSettingsValues', evidenceSignature: 'resourceLimits.headless.pendingOutputMaxBytes', accessEvidenceSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', reason: 'Browser settings type source; it does not apply terminal runtime decisions.' },
  { path: 'server/src/types/settings.types.ts', classification: 'schema-source', symbol: 'EditableSettingsKey', evidenceSignature: 'resourceLimits.headless.pendingOutputMaxBytes', accessEvidenceSha256: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945', reason: 'Server settings key source; it does not apply terminal runtime decisions.' },
];

const INVENTORY_EVIDENCE_SUPPORT_PATHS = [
  'server/src/services/TerminalResourcePolicy.test.ts',
  'server/src/services/TerminalResourcePolicy.ts',
  'server/src/services/TerminalResourcePolicyInventory.ts',
  'server/src/services/TerminalResourcePolicyObservations.ts',
  'server/src/services/RuntimeConfigStore.test.ts',
  'server/src/utils/config.ts',
  'server/src/utils/configStrictLoader.ts',
  'tools/wave3/terminal-resource-consumer-manifest.test.mjs',
  'tools/wave3/terminal-resource-policy-differential.ts',
] as const;

export interface TerminalResourceInventory {
  resourceKeys: TerminalResourceKey[];
  resourceUnits: Record<string, string>;
  consumerPaths: string[];
  gettersOrCallSites: Array<{ path: string; symbol: string }>;
  tuples: TerminalResourceConsumerManifestEntry[];
  classifications: TerminalResourcePathClassification[];
  unregisteredCallSites: Array<{ path: string; symbol: string }>;
  evidenceHashSchemaVersion: string;
  typescriptVersion: string;
  evidenceSourcePaths: string[];
  sourceHashes: Record<string, string>;
  sourceSetSha256: string;
}

type TypescriptModule = typeof import('typescript');

interface AstEvidenceMatch {
  entry: CatalogEntry;
  start: number;
  end: number;
  scopeNames: string[];
  evidenceRole: string;
  evidenceAstOccurrenceSha256: string;
}

interface AstResourceAccess {
  key?: TerminalResourceKey;
  start: number;
  end: number;
  symbol: string;
  scopeNames: string[];
  evidenceSignature: string;
}

const RESOURCE_KEY_BY_SECTION_FIELD = new Map<string, TerminalResourceKey>(
  TERMINAL_RESOURCE_KEYS.map((key) => {
    const [, section, field] = key.split('.');
    return [`${section}.${field}`, key];
  }),
);
const RESOURCE_LIMITS_ROOT = '@resource-limits-root';
const RESOURCE_GETTER_ALIAS_PREFIX = '@resource-getter:';
const RESOURCE_GETTER_NAMESPACE_PREFIX = '@resource-getter-namespace:';
const TRUSTED_RESOURCE_GETTER_MODULES = new Map<string, ReadonlyMap<string, string>>([
  ['frontend/src/utils/inputReliabilityMode', new Map([
    ['getClientWsResourceLimits', 'clientWs'],
    ['getTerminalResourceLimits', 'terminal'],
    ['getSnapshotResourceLimits', 'snapshots'],
    ['getWorkspaceRuntimeResourceLimits', 'workspaceRuntime'],
  ])],
  ['frontend/src/utils/terminalOutputHotPath', new Map([
    ['getCachedTerminalOutputResourceLimits', 'terminal'],
  ])],
]);

function toAstResourceGetterAlias(section: string): string {
  return `${RESOURCE_GETTER_ALIAS_PREFIX}${section}`;
}

function fromAstResourceGetterAlias(value: string | undefined): string | undefined {
  return value?.startsWith(RESOURCE_GETTER_ALIAS_PREFIX)
    ? value.slice(RESOURCE_GETTER_ALIAS_PREFIX.length)
    : undefined;
}

function normalizeAstModuleId(value: string): string {
  return posix.normalize(value.replace(/\\/g, '/')).replace(/\.(?:js|jsx|ts|tsx)$/, '');
}

function resolveAstImportedModuleId(sourceFile: import('typescript').SourceFile, moduleSpecifier: string): string | undefined {
  if (!moduleSpecifier.startsWith('.')) return undefined;
  return normalizeAstModuleId(posix.join(posix.dirname(sourceFile.fileName), moduleSpecifier));
}

function getTrustedAstResourceGetterSection(moduleId: string | undefined, exportName: string): string | undefined {
  if (moduleId === undefined) return undefined;
  return TRUSTED_RESOURCE_GETTER_MODULES.get(normalizeAstModuleId(moduleId))?.get(exportName);
}

function toAstResourceGetterNamespace(moduleId: string): string {
  return `${RESOURCE_GETTER_NAMESPACE_PREFIX}${normalizeAstModuleId(moduleId)}`;
}

function fromAstResourceGetterNamespace(value: string | undefined): string | undefined {
  return value?.startsWith(RESOURCE_GETTER_NAMESPACE_PREFIX)
    ? value.slice(RESOURCE_GETTER_NAMESPACE_PREFIX.length)
    : undefined;
}

function getAstClassName(ts: TypescriptModule, node: import('typescript').Node): string | undefined {
  let current: import('typescript').Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) return current.name?.getText();
    if (ts.isFunctionLike(current)) return undefined;
    current = current.parent;
  }
  return undefined;
}

function getAstCallName(ts: TypescriptModule, call: import('typescript').CallExpression): string {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return 'call';
}

function getAstFunctionLocalName(
  ts: TypescriptModule,
  node: import('typescript').SignatureDeclaration,
): { name: string; classOwned: boolean } {
  const className = getAstClassName(ts, node);
  if (ts.isConstructorDeclaration(node)) {
    return { name: className ? `${className}.constructor` : 'constructor', classOwned: Boolean(className) };
  }
  if (
    ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
  ) {
    const methodName = node.name.getText();
    return { name: className ? `${className}.${methodName}` : methodName, classOwned: Boolean(className) };
  }
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return { name: node.name.getText(), classOwned: false };
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent)) return { name: parent.name.getText(), classOwned: false };
  if (ts.isPropertyAssignment(parent)) return { name: parent.name.getText(), classOwned: false };
  if (ts.isCallExpression(parent)) {
    if (ts.isVariableDeclaration(parent.parent)) {
      return { name: parent.parent.name.getText(), classOwned: false };
    }
    if (ts.isPropertyAssignment(parent.parent)) {
      return { name: parent.parent.name.getText(), classOwned: false };
    }
    const argumentIndex = parent.arguments.findIndex((argument) => argument === node);
    return {
      name: `$callback:${getAstCallName(ts, parent)}:${Math.max(0, argumentIndex)}@${node.getStart(node.getSourceFile())}`,
      classOwned: false,
    };
  }
  return { name: `$anonymous@${node.getStart(node.getSourceFile())}`, classOwned: false };
}

function getAstFunctionOwner(
  ts: TypescriptModule,
  node: import('typescript').SignatureDeclaration,
): string {
  const local = getAstFunctionLocalName(ts, node);
  if (local.classOwned) return local.name;
  let current: import('typescript').Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return `${getAstFunctionOwner(ts, current)}#${local.name}`;
    current = current.parent;
  }
  return local.name;
}

function getAstScopeNames(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
  position: number,
): string[] {
  let deepest: import('typescript').Node = sourceFile;
  const descend = (node: import('typescript').Node): void => {
    node.forEachChild((child) => {
      if (child.getStart(sourceFile) <= position && position < child.end) {
        deepest = child;
        descend(child);
      }
    });
  };
  descend(sourceFile);
  let current: import('typescript').Node | undefined = deepest;
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return [getAstFunctionOwner(ts, current)];
    current = current.parent;
  }
  return ['$module'];
}

function getAstDeepestNodeAtPosition(
  sourceFile: import('typescript').SourceFile,
  position: number,
): import('typescript').Node {
  let deepest: import('typescript').Node = sourceFile;
  const descend = (node: import('typescript').Node): void => {
    node.forEachChild((child) => {
      if (child.getStart(sourceFile) <= position && position < child.end) {
        deepest = child;
        descend(child);
      }
    });
  };
  descend(sourceFile);
  return deepest;
}

function getAstSmallestNodeContainingRange(
  sourceFile: import('typescript').SourceFile,
  start: number,
  end: number,
): import('typescript').Node {
  let smallest: import('typescript').Node = sourceFile;
  const descend = (node: import('typescript').Node): void => {
    node.forEachChild((child) => {
      if (child.getStart(sourceFile) <= start && end <= child.end) {
        smallest = child;
        descend(child);
      }
    });
  };
  descend(sourceFile);
  return smallest;
}

function consumerSymbolMatchesScope(consumerSymbol: string, scopeNames: readonly string[]): boolean {
  const expected = new Set(consumerSymbol.split('/').map((scope) => scope.trim()));
  return scopeNames.some((scope) => expected.has(scope));
}

function getExcludedAstRanges(
  ts: TypescriptModule,
  source: string,
  sourceFile: import('typescript').SourceFile,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const addCommentRanges = (items: readonly import('typescript').CommentRange[] | undefined): void => {
    for (const item of items ?? []) ranges.push({ start: item.pos, end: item.end });
  };
  const visit = (node: import('typescript').Node): void => {
    if (
      node.kind === ts.SyntaxKind.StringLiteral
      || node.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
      || node.kind === ts.SyntaxKind.TemplateHead
      || node.kind === ts.SyntaxKind.TemplateMiddle
      || node.kind === ts.SyntaxKind.TemplateTail
    ) {
      ranges.push({ start: node.getStart(sourceFile), end: node.end });
    }
    addCommentRanges(ts.getLeadingCommentRanges(source, node.pos));
    addCommentRanges(ts.getTrailingCommentRanges(source, node.end));
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return ranges;
}

function isExcludedAstPosition(position: number, ranges: readonly { start: number; end: number }[]): boolean {
  return ranges.some((range) => range.start <= position && position < range.end);
}

function getAstConstantBoolean(
  ts: TypescriptModule,
  expression: import('typescript').Expression,
): boolean | undefined {
  if (ts.isParenthesizedExpression(expression)) return getAstConstantBoolean(ts, expression.expression);
  if (
    ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
  ) return getAstConstantBoolean(ts, expression.expression);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isNumericLiteral(expression)) return Number(expression.text) !== 0;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text.length > 0;
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = getAstConstantBoolean(ts, expression.operand);
    return operand === undefined ? undefined : !operand;
  }
  return undefined;
}

function astNodeContainsPosition(
  sourceFile: import('typescript').SourceFile,
  node: import('typescript').Node | undefined,
  position: number,
): boolean {
  return Boolean(node && node.getStart(sourceFile) <= position && position < node.end);
}

function isAstPositionObviouslyReachable(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
  position: number,
): boolean {
  let current: import('typescript').Node | undefined = getAstDeepestNodeAtPosition(sourceFile, position);
  while (current?.parent) {
    const parent: import('typescript').Node = current.parent;
    if (ts.isIfStatement(parent)) {
      const condition = getAstConstantBoolean(ts, parent.expression);
      if (condition === false && astNodeContainsPosition(sourceFile, parent.thenStatement, position)) return false;
      if (condition === true && astNodeContainsPosition(sourceFile, parent.elseStatement, position)) return false;
    } else if (ts.isConditionalExpression(parent)) {
      const condition = getAstConstantBoolean(ts, parent.condition);
      if (condition === false && astNodeContainsPosition(sourceFile, parent.whenTrue, position)) return false;
      if (condition === true && astNodeContainsPosition(sourceFile, parent.whenFalse, position)) return false;
    } else if (ts.isWhileStatement(parent)) {
      if (getAstConstantBoolean(ts, parent.expression) === false) return false;
    } else if (ts.isForStatement(parent) && parent.condition) {
      if (getAstConstantBoolean(ts, parent.condition) === false) return false;
    } else if (ts.isBinaryExpression(parent) && astNodeContainsPosition(sourceFile, parent.right, position)) {
      const left = getAstConstantBoolean(ts, parent.left);
      if (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && left === false) return false;
      if (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken && left === true) return false;
    }
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const statements = parent.statements;
      const containingIndex = statements.findIndex((statement) => astNodeContainsPosition(sourceFile, statement, position));
      if (containingIndex > 0 && statements.slice(0, containingIndex).some((statement) => (
        ts.isReturnStatement(statement)
        || ts.isThrowStatement(statement)
        || ts.isBreakStatement(statement)
        || ts.isContinueStatement(statement)
      ))) return false;
    }
    current = parent;
  }
  return true;
}

function deriveAstEvidenceRole(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
  start: number,
  end: number,
  entry: CatalogEntry,
): TerminalResourceEvidenceRole | undefined {
  if (!isAstPositionObviouslyReachable(ts, sourceFile, start)) return undefined;
  const evidenceNode = getAstSmallestNodeContainingRange(sourceFile, start, end);

  const containsEvidence = (node: import('typescript').Node | undefined): boolean => (
    Boolean(node && node.getStart(sourceFile) <= start && end <= node.end)
  );
  const getContainingVariable = (
    node: import('typescript').Node,
  ): import('typescript').VariableDeclaration | undefined => {
    let current: import('typescript').Node | undefined = node;
    while (current && !ts.isFunctionLike(current)) {
      if (ts.isVariableDeclaration(current) && containsEvidence(current.initializer)) return current;
      current = current.parent;
    }
    return undefined;
  };
  const isIdentifierUsedMeaningfully = (
    identifier: import('typescript').Identifier,
    declaration: import('typescript').VariableDeclaration,
    strictControl: boolean,
  ): boolean => {
    let statement: import('typescript').Node = declaration;
    while (statement.parent && !ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent)) {
      statement = statement.parent;
    }
    const container = statement.parent;
    if (!(container && (ts.isBlock(container) || ts.isSourceFile(container)))) return false;
    const statements = container.statements;
    const statementIndex = statements.findIndex((candidate) => candidate === statement);
    if (statementIndex < 0) return false;
    let meaningful = false;
    const declaresShadow = (node: import('typescript').Node): boolean => {
      if (ts.isVariableStatement(node)) {
        return node.declarationList.declarations.some((candidate) => (
          getAstBindingNames(ts, candidate.name).includes(identifier.text)
        ));
      }
      if (
        (ts.isForOfStatement(node) || ts.isForInStatement(node))
        && ts.isVariableDeclarationList(node.initializer)
      ) {
        return node.initializer.declarations.some((candidate) => (
          getAstBindingNames(ts, candidate.name).includes(identifier.text)
        ));
      }
      return Boolean(
        ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name?.text === identifier.text)
        || (ts.isCatchClause(node)
          && node.variableDeclaration
          && getAstBindingNames(ts, node.variableDeclaration.name).includes(identifier.text)),
      );
    };
    const hasStrictBranchEffect = (node: import('typescript').Node | undefined): boolean => {
      if (!node) return false;
      let effect = false;
      const inspect = (current: import('typescript').Node): void => {
        if (effect || ts.isFunctionLike(current)) return;
        if (
          ts.isReturnStatement(current)
          || ts.isThrowStatement(current)
          || ts.isContinueStatement(current)
          || (ts.isBreakStatement(current) && current.label === undefined)
          || ts.isPostfixUnaryExpression(current)
          || (ts.isPrefixUnaryExpression(current)
            && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken))
          || (ts.isBinaryExpression(current)
            && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
        ) effect = true;
        else if (
          ts.isCallExpression(current)
          && entry.applyBoundary === 'runtime-residency-decision'
          && ['eligibleHiddenTabs.push', 'protectedHiddenTabs.push'].includes(current.expression.getText(sourceFile))
        ) effect = true;
        else current.forEachChild(inspect);
      };
      inspect(node);
      return effect;
    };
    const visit = (node: import('typescript').Node): void => {
      if (meaningful) return;
      if (ts.isFunctionLike(node)) return;
      if (
        (ts.isBlock(node) || ts.isCatchClause(node))
        && node !== container
        && (ts.isBlock(node) ? node.statements.some(declaresShadow) : declaresShadow(node))
      ) return;
      if (ts.isIdentifier(node) && node.text === identifier.text) {
        let current: import('typescript').Node | undefined = node;
        while (current?.parent && !ts.isFunctionLike(current.parent)) {
          const parent: import('typescript').Node = current.parent;
          if (
            (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
            && astNodeContainsPosition(sourceFile, parent.expression, node.getStart(sourceFile))
          ) {
            meaningful = !strictControl || (ts.isIfStatement(parent)
              ? hasStrictBranchEffect(parent.thenStatement) || hasStrictBranchEffect(parent.elseStatement)
              : hasStrictBranchEffect(parent.statement));
          }
          if (
            ts.isForStatement(parent)
            && astNodeContainsPosition(sourceFile, parent.condition, node.getStart(sourceFile))
          ) meaningful = !strictControl || hasStrictBranchEffect(parent.statement);
          if (
            !strictControl
            && (ts.isCallExpression(parent) || ts.isNewExpression(parent))
            && parent.arguments?.some((argument) => astNodeContainsPosition(sourceFile, argument, node.getStart(sourceFile)))
          ) meaningful = true;
          if (!strictControl && ts.isReturnStatement(parent)) meaningful = true;
          if (meaningful) return;
          current = parent;
        }
      }
      node.forEachChild(visit);
    };
    for (const candidate of statements.slice(statementIndex + 1)) {
      if (declaresShadow(candidate)) break;
      visit(candidate);
      if (meaningful) break;
    }
    return meaningful;
  };
  const isDerivedControl = (node: import('typescript').Node): boolean => {
    const declaration = getContainingVariable(node);
    return Boolean(
      declaration
      && ts.isIdentifier(declaration.name)
      && isIdentifierUsedMeaningfully(declaration.name, declaration, true),
    );
  };
  const isVariableValueFlow = (node: import('typescript').Node): boolean => {
    const declaration = getContainingVariable(node);
    return Boolean(
      declaration
      && ts.isIdentifier(declaration.name)
      && isIdentifierUsedMeaningfully(declaration.name, declaration, false),
    );
  };
  const isObjectFlowingToBoundary = (property: import('typescript').PropertyAssignment): boolean => {
    let current: import('typescript').Node = property;
    while (current.parent && !ts.isFunctionLike(current.parent)) {
      const parent = current.parent;
      if (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === current)) return true;
      if (
        (ts.isCallExpression(parent) || ts.isNewExpression(parent))
        && parent.arguments?.some((argument) => argument === current || containsEvidence(argument))
      ) return true;
      if (ts.isVariableDeclaration(parent)) return isVariableValueFlow(current);
      if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return false;
      current = parent;
    }
    return false;
  };
  const isReservedReturnCopy = (property: import('typescript').PropertyAssignment): boolean => {
    let current: import('typescript').Node = property;
    while (current.parent && !ts.isFunctionLike(current.parent)) {
      if (ts.isReturnStatement(current.parent)) return true;
      if (ts.isCallExpression(current.parent) || ts.isNewExpression(current.parent)) return false;
      current = current.parent;
    }
    return false;
  };
  const hasMeaningfulControlEffect = (node: import('typescript').Node | undefined): boolean => {
    if (!node) return false;
    let meaningful = false;
    const visit = (current: import('typescript').Node): void => {
      if (meaningful || ts.isFunctionLike(current)) return;
      if (
        ts.isReturnStatement(current)
        || ts.isThrowStatement(current)
        || ts.isContinueStatement(current)
        || (ts.isBreakStatement(current) && current.label === undefined)
        || ts.isPostfixUnaryExpression(current)
        || (ts.isPrefixUnaryExpression(current)
          && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken))
        || (ts.isBinaryExpression(current)
          && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      ) {
        meaningful = true;
        return;
      }
      if (ts.isCallExpression(current)) {
        const callText = current.expression.getText(sourceFile);
        if (entry.applyBoundary === 'snapshot-cleanup' && callText === 'localStorage.removeItem') {
          meaningful = true;
          return;
        }
      }
      current.forEachChild(visit);
    };
    visit(node);
    return meaningful;
  };
  const getControlEffect = (
    parent: import('typescript').Node,
  ): import('typescript').Node | undefined => {
    if (ts.isIfStatement(parent)) {
      return hasMeaningfulControlEffect(parent.thenStatement)
        ? parent.thenStatement
        : parent.elseStatement;
    }
    if (ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isForStatement(parent)) return parent.statement;
    if (ts.isConditionalExpression(parent)) return parent;
    return undefined;
  };
  const isCallInputMeaningful = (call: import('typescript').CallExpression | import('typescript').NewExpression): boolean => {
    let current: import('typescript').Node = call;
    while (current.parent && !ts.isFunctionLike(current.parent)) {
      const parent = current.parent;
      if (ts.isReturnStatement(parent)) return true;
      if (ts.isPropertyAssignment(parent)) return isObjectFlowingToBoundary(parent);
      if (ts.isVariableDeclaration(parent)) return isVariableValueFlow(current);
      if (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isForStatement(parent)) return true;
      if (
        (ts.isCallExpression(parent) || ts.isNewExpression(parent))
        && parent.arguments?.some((argument) => argument === current || astNodeContainsPosition(sourceFile, argument, current.getStart(sourceFile)))
      ) {
        current = parent;
        continue;
      }
      if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent)) return false;
      current = parent;
    }
    return false;
  };

  let current: import('typescript').Node | undefined = evidenceNode;
  while (current?.parent) {
    if (ts.isVoidExpression(current)) return undefined;
    if (ts.isPropertyAssignment(current) && containsEvidence(current)) {
      if (entry.state === 'reserved-unapplied') {
        return isReservedReturnCopy(current) ? 'reserved-copy' : undefined;
      }
      return isObjectFlowingToBoundary(current) ? 'object-option-flow' : undefined;
    }
    if (
      (ts.isCallExpression(current) || ts.isNewExpression(current))
      && containsEvidence(current)
    ) return isCallInputMeaningful(current) ? 'call-input' : undefined;
    if (ts.isVariableDeclaration(current) && containsEvidence(current.initializer)) {
      return isDerivedControl(current) ? 'derived-control' : undefined;
    }
    const parent: import('typescript').Node = current.parent;
    if (ts.isVoidExpression(parent)) return undefined;
    if (
      (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
      && containsEvidence(parent.expression)
    ) return hasMeaningfulControlEffect(getControlEffect(parent)) ? 'control-guard' : undefined;
    if (
      ts.isForStatement(parent)
      && containsEvidence(parent.condition)
    ) return hasMeaningfulControlEffect(parent.statement) ? 'control-guard' : undefined;
    if (ts.isConditionalExpression(parent) && containsEvidence(parent.condition)) {
      current = parent;
      continue;
    }
    if (ts.isPropertyAssignment(parent) && containsEvidence(parent.initializer)) {
      if (entry.state === 'reserved-unapplied') {
        return isReservedReturnCopy(parent) ? 'reserved-copy' : undefined;
      }
      return isObjectFlowingToBoundary(parent) ? 'object-option-flow' : undefined;
    }
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent))
      && parent.arguments?.some((argument) => containsEvidence(argument))
    ) return isCallInputMeaningful(parent) ? 'call-input' : undefined;
    if (ts.isVariableDeclaration(parent) && containsEvidence(parent.initializer)) {
      return isDerivedControl(parent) ? 'derived-control' : undefined;
    }
    if (ts.isExpressionStatement(parent)) return undefined;
    if (ts.isFunctionLike(parent)) break;
    current = parent;
  }
  return undefined;
}

function getAstContainingStatementEnvelope(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
  node: import('typescript').Node,
): import('typescript').Node {
  let current = node;
  while (current.parent && !ts.isFunctionLike(current.parent)) {
    const parent = current.parent;
    if (
      (ts.isBlock(parent) || ts.isSourceFile(parent))
      && parent.statements.some((statement) => statement === current)
    ) return current;
    current = parent;
  }
  return current;
}

function getAstEvidenceEnvelopes(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
  start: number,
  end: number,
  role: TerminalResourceEvidenceRole,
): import('typescript').Node[] {
  const containsRange = (node: import('typescript').Node | undefined): boolean => (
    Boolean(node && node.getStart(sourceFile) <= start && end <= node.end)
  );
  let current: import('typescript').Node = getAstSmallestNodeContainingRange(sourceFile, start, end);
  if (role === 'derived-control') {
    let declaration: import('typescript').VariableDeclaration | undefined;
    let candidate: import('typescript').Node | undefined = current;
    while (candidate && !ts.isFunctionLike(candidate)) {
      if (ts.isVariableDeclaration(candidate)) {
        declaration = candidate;
        break;
      }
      candidate = candidate.parent;
    }
    if (declaration && ts.isIdentifier(declaration.name)) {
      const declarationStatement = getAstContainingStatementEnvelope(ts, sourceFile, declaration);
      let owner: import('typescript').Node = declaration;
      while (owner.parent && !ts.isFunctionLike(owner)) owner = owner.parent;
      let qualifyingControl: import('typescript').Node | undefined;
      const hasIdentifier = (node: import('typescript').Node | undefined): boolean => {
        if (!node) return false;
        let found = false;
        const visit = (child: import('typescript').Node): void => {
          if (found || ts.isFunctionLike(child)) return;
          if (ts.isIdentifier(child) && child.text === declaration?.name.getText(sourceFile)) found = true;
          else child.forEachChild(visit);
        };
        visit(node);
        return found;
      };
      const findControl = (node: import('typescript').Node): void => {
        if (qualifyingControl || node.end <= declaration!.end || (node !== owner && ts.isFunctionLike(node))) return;
        if (
          ((ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) && hasIdentifier(node.expression))
          || (ts.isForStatement(node) && hasIdentifier(node.condition))
        ) {
          qualifyingControl = node;
          return;
        }
        node.forEachChild(findControl);
      };
      owner.forEachChild(findControl);
      if (qualifyingControl) return [declarationStatement, qualifyingControl];
      return [declarationStatement];
    }
    return [getAstContainingStatementEnvelope(ts, sourceFile, current)];
  }
  while (current.parent && !ts.isFunctionLike(current.parent)) {
    const parent = current.parent;
    if (role === 'control-guard') {
      if (
        (ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent))
        && containsRange(parent.expression)
      ) return [parent];
      if (ts.isForStatement(parent) && containsRange(parent.condition)) return [parent];
    }
    if (role === 'reserved-copy' && ts.isReturnStatement(parent)) return [parent];
    current = parent;
  }
  return [getAstContainingStatementEnvelope(
    ts,
    sourceFile,
    getAstSmallestNodeContainingRange(sourceFile, start, end),
  )];
}

function hashAstEvidenceEnvelope(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
  envelopes: readonly import('typescript').Node[],
): string {
  const printer = ts.createPrinter({ removeComments: true });
  const payload = {
    schemaVersion: TERMINAL_RESOURCE_EVIDENCE_HASH_SCHEMA_VERSION,
    typescriptVersion: ts.version,
    nodes: envelopes.map((envelope) => printer.printNode(ts.EmitHint.Unspecified, envelope, sourceFile)),
  };
  return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function findAstEvidenceMatches(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
  source: string,
  entry: CatalogEntry,
  excludedRanges: readonly { start: number; end: number }[],
): AstEvidenceMatch[] {
  const matches: AstEvidenceMatch[] = [];
  let offset = 0;
  while (offset <= source.length) {
    const start = source.indexOf(entry.evidenceSignature, offset);
    if (start < 0) break;
    const end = start + entry.evidenceSignature.length;
    const scopeNames = getAstScopeNames(ts, sourceFile, start);
    const evidenceRole = deriveAstEvidenceRole(ts, sourceFile, start, end, entry);
    if (
      !isExcludedAstPosition(start, excludedRanges)
      && evidenceRole === entry.evidenceRole
      && consumerSymbolMatchesScope(entry.consumerSymbol, scopeNames)
    ) {
      const evidenceAstOccurrenceSha256 = hashAstEvidenceEnvelope(
        ts,
        sourceFile,
        getAstEvidenceEnvelopes(ts, sourceFile, start, end, evidenceRole),
      );
      matches.push({ entry, start, end, scopeNames, evidenceRole, evidenceAstOccurrenceSha256 });
    }
    offset = Math.max(start + 1, end);
  }
  return matches;
}

interface AstAliasScope {
  parent?: AstAliasScope;
  aliases: Map<string, string | null>;
}

function resolveAstAlias(scope: AstAliasScope, name: string): string | undefined {
  let current: AstAliasScope | undefined = scope;
  while (current !== undefined) {
    if (current.aliases.has(name)) return current.aliases.get(name) ?? undefined;
    current = current.parent;
  }
  return undefined;
}

function getAstBindingNames(
  ts: TypescriptModule,
  name: import('typescript').BindingName,
): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (
    ts.isOmittedExpression(element) ? [] : getAstBindingNames(ts, element.name)
  ));
}

function isAstResourceLimitsType(type: import('typescript').TypeNode | undefined): boolean {
  if (!type) return false;
  const normalized = type.getText().replace(/\s+/g, '');
  return normalized === 'ResourceLimitsConfig'
    || normalized === 'BrowserResourceLimitsRuntimeConfig'
    || normalized === 'Partial<ResourceLimitsConfig>'
    || normalized === 'Partial<BrowserResourceLimitsRuntimeConfig>';
}

function predeclareAstScopeBindings(
  ts: TypescriptModule,
  node: import('typescript').Node,
  scope: AstAliasScope,
): void {
  const sourceFile = node.getSourceFile();
  const sourceModuleId = normalizeAstModuleId(sourceFile.fileName);
  const tombstone = (name: import('typescript').BindingName): void => {
    for (const binding of getAstBindingNames(ts, name)) scope.aliases.set(binding, null);
  };
  if (ts.isFunctionLike(node)) {
    for (const parameter of node.parameters) {
      tombstone(parameter.name);
      if (
        ts.isIdentifier(parameter.name)
        && isAstResourceLimitsType(parameter.type)
      ) {
        scope.aliases.set(parameter.name.text, RESOURCE_LIMITS_ROOT);
      }
    }
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) tombstone(node.variableDeclaration.name);
  if (ts.isSourceFile(node) || ts.isBlock(node)) {
    for (const statement of node.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) tombstone(declaration.name);
      } else if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
        && statement.name
      ) {
        const resourceSection = ts.isFunctionDeclaration(statement)
          ? getTrustedAstResourceGetterSection(sourceModuleId, statement.name.text)
          : undefined;
        scope.aliases.set(
          statement.name.text,
          resourceSection === undefined ? null : toAstResourceGetterAlias(resourceSection),
        );
      } else if (ts.isImportDeclaration(statement) && statement.importClause) {
        if (statement.importClause.isTypeOnly || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const importedModuleId = resolveAstImportedModuleId(sourceFile, statement.moduleSpecifier.text);
        if (statement.importClause.name) scope.aliases.set(statement.importClause.name.text, null);
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          scope.aliases.set(
            bindings.name.text,
            importedModuleId !== undefined && TRUSTED_RESOURCE_GETTER_MODULES.has(importedModuleId)
              ? toAstResourceGetterNamespace(importedModuleId)
              : null,
          );
        }
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) {
              scope.aliases.set(element.name.text, null);
              continue;
            }
            const importedName = element.propertyName?.text ?? element.name.text;
            const resourceSection = getTrustedAstResourceGetterSection(importedModuleId, importedName);
            scope.aliases.set(
              element.name.text,
              resourceSection === undefined ? null : toAstResourceGetterAlias(resourceSection),
            );
          }
        }
      }
    }
  }
}

function discoverAstResourceAccesses(
  ts: TypescriptModule,
  sourceFile: import('typescript').SourceFile,
): AstResourceAccess[] {
  const accesses: AstResourceAccess[] = [];

  const expressionSection = (
    expression: import('typescript').Expression,
    scope: AstAliasScope,
  ): string | undefined => {
    if (ts.isParenthesizedExpression(expression)) return expressionSection(expression.expression, scope);
    if (
      ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression)
      || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression)
    ) {
      return expressionSection(expression.expression, scope);
    }
    if (ts.isIdentifier(expression)) {
      return resolveAstAlias(scope, expression.text);
    }
    if (ts.isCallExpression(expression)) {
      return fromAstResourceGetterAlias(expressionSection(expression.expression, scope));
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const parentSection = expressionSection(expression.expression, scope);
      const getterNamespace = fromAstResourceGetterNamespace(parentSection);
      const getterSection = getTrustedAstResourceGetterSection(getterNamespace, expression.name.text);
      if (getterSection !== undefined) return toAstResourceGetterAlias(getterSection);
      if (parentSection === RESOURCE_LIMITS_ROOT) return expression.name.text;
      if (expression.name.text === 'resourceLimits') return RESOURCE_LIMITS_ROOT;
    }
    if (ts.isElementAccessExpression(expression)) {
      const argument = expression.argumentExpression;
      const property = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ? argument.text
        : undefined;
      const parentSection = expressionSection(expression.expression, scope);
      const getterNamespace = fromAstResourceGetterNamespace(parentSection);
      const getterSection = property === undefined
        ? undefined
        : getTrustedAstResourceGetterSection(getterNamespace, property);
      if (getterSection !== undefined) return toAstResourceGetterAlias(getterSection);
      if (parentSection === RESOURCE_LIMITS_ROOT) return property;
      if (property === 'resourceLimits') return RESOURCE_LIMITS_ROOT;
    }
    return undefined;
  };

  const recordAccess = (
    node: import('typescript').Node,
    section: string,
    field: string | undefined,
  ): void => {
    const key = field === undefined ? undefined : RESOURCE_KEY_BY_SECTION_FIELD.get(`${section}.${field}`);
    accesses.push({
      key,
      start: node.getStart(sourceFile),
      end: node.end,
      symbol: field === undefined ? `${section}.[dynamic]` : `${section}.${field}`,
      scopeNames: getAstScopeNames(ts, sourceFile, node.getStart(sourceFile)),
      evidenceSignature: node.getText(sourceFile),
    });
  };

  const visit = (node: import('typescript').Node, inheritedScope: AstAliasScope): void => {
    const createsScope = ts.isFunctionLike(node) || ts.isBlock(node) || ts.isSourceFile(node) || ts.isCatchClause(node);
    const scope: AstAliasScope = createsScope
      ? { parent: inheritedScope, aliases: new Map<string, string | null>() }
      : inheritedScope;
    if (createsScope) predeclareAstScopeBindings(ts, node, scope);

    if (ts.isVariableDeclaration(node)) {
      for (const binding of getAstBindingNames(ts, node.name)) scope.aliases.set(binding, null);
      const initializer = node.initializer;
      let section = initializer ? expressionSection(initializer, scope) : undefined;
      if (
        section === undefined
        && ts.isIdentifier(node.name)
        && isAstResourceLimitsType(node.type)
      ) {
        section = RESOURCE_LIMITS_ROOT;
      }
      if (section !== undefined) {
        if (ts.isIdentifier(node.name)) {
          scope.aliases.set(node.name.text, section);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const field = (element.propertyName ?? element.name).getText(sourceFile).replace(/^['"]|['"]$/g, '');
            if (section === RESOURCE_LIMITS_ROOT && ts.isIdentifier(element.name)) {
              scope.aliases.set(element.name.text, field);
            } else {
              recordAccess(element, section, field);
            }
          }
        }
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const field = (element.propertyName ?? element.name).getText(sourceFile).replace(/^['"]|['"]$/g, '');
          if (field === 'resourceLimits' && ts.isIdentifier(element.name)) {
            scope.aliases.set(element.name.text, RESOURCE_LIMITS_ROOT);
          }
        }
      }
    }

    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
    ) {
      const section = expressionSection(node.right, scope);
      if (section === undefined) scope.aliases.set(node.left.text, null);
      else scope.aliases.set(node.left.text, section);
    }

    if (ts.isPropertyAccessExpression(node)) {
      const section = expressionSection(node.expression, scope);
      if (section !== undefined && section !== RESOURCE_LIMITS_ROOT) recordAccess(node, section, node.name.text);
    } else if (ts.isElementAccessExpression(node)) {
      const section = expressionSection(node.expression, scope);
      if (section !== undefined && section !== RESOURCE_LIMITS_ROOT) {
        const argument = node.argumentExpression;
        const field = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text
          : undefined;
        recordAccess(node, section, field);
      } else if (section === RESOURCE_LIMITS_ROOT) {
        const argument = node.argumentExpression;
        if (!(argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)))) {
          recordAccess(node, RESOURCE_LIMITS_ROOT, undefined);
        }
      }
    }

    node.forEachChild((child) => visit(child, scope));
  };

  visit(sourceFile, { aliases: new Map<string, string | null>() });
  return accesses;
}

function hashAstResourceAccessEvidence(accesses: readonly AstResourceAccess[]): string {
  const evidence = accesses.map((access) => ({
    resourceKey: access.key ?? null,
    owner: access.scopeNames[0] ?? '$module',
    evidenceSignature: access.evidenceSignature,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
}

function toRepositoryPath(repositoryRoot: string, path: string): string {
  if (isAbsolute(path) || path.includes('\\')) throw new Error(`terminal resource path must be repository-relative POSIX: ${path}`);
  const absolute = resolve(repositoryRoot, path);
  if (relative(repositoryRoot, absolute).startsWith('..')) throw new Error(`terminal resource path escapes repository root: ${path}`);
  return absolute;
}

async function readRequiredSource(repositoryRoot: string, path: string): Promise<string> {
  try {
    return await readFile(toRepositoryPath(repositoryRoot, path), 'utf8');
  } catch (error) {
    throw new Error(`required terminal resource source missing: ${path}`, { cause: error });
  }
}

async function listProductionSourceFiles(root: string, prefix: string): Promise<string[]> {
  const absolute = resolve(root, prefix);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listProductionSourceFiles(root, path));
    else if (
      /\.(?:ts|tsx)$/.test(entry.name)
      && !/\.test\.|\.spec\./.test(entry.name)
      && entry.name !== 'test-runner.ts'
    ) files.push(path);
  }
  return files;
}

export async function discoverTerminalResourceInventory(options: {
  repositoryRoot: string;
}): Promise<TerminalResourceInventory> {
  const loadedTypescript = await import('typescript');
  const ts = (('default' in loadedTypescript ? loadedTypescript.default : loadedTypescript) as TypescriptModule);
  const requiredPaths = [...new Set([
    ...CONSUMER_CATALOG.map((entry) => entry.consumerPath),
    ...PATH_CLASSIFICATIONS.map((entry) => entry.path),
  ])].sort((left, right) => left.localeCompare(right));
  const sourceContents = new Map<string, string>();
  const sourceFiles = new Map<string, import('typescript').SourceFile>();
  const excludedRangesByPath = new Map<string, Array<{ start: number; end: number }>>();
  const parseSource = (path: string, source: string): import('typescript').SourceFile => {
    const existing = sourceFiles.get(path);
    if (existing) return existing;
    const isTsx = path.endsWith('.tsx');
    const sourceFile = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    sourceFiles.set(path, sourceFile);
    excludedRangesByPath.set(
      path,
      getExcludedAstRanges(ts, source, sourceFile),
    );
    return sourceFile;
  };
  for (const path of requiredPaths) sourceContents.set(path, await readRequiredSource(options.repositoryRoot, path));
  const discoveredTuples: TerminalResourceConsumerManifestEntry[] = [];
  const evidenceMatches: AstEvidenceMatch[] = [];
  for (const entry of CONSUMER_CATALOG) {
    const source = sourceContents.get(entry.consumerPath) ?? '';
    const sourceFile = parseSource(entry.consumerPath, source);
    const matches = findAstEvidenceMatches(
      ts,
      sourceFile,
      source,
      entry,
      excludedRangesByPath.get(entry.consumerPath) ?? [],
    );
    if (matches.length === 0) {
      const rawOccurrence = source.includes(entry.evidenceSignature);
      const rawStart = source.indexOf(entry.evidenceSignature);
      const scopeDiagnostics: string[] = [];
      const roleDiagnostics: string[] = [];
      let diagnosticOffset = 0;
      while (diagnosticOffset <= source.length) {
        const diagnosticStart = source.indexOf(entry.evidenceSignature, diagnosticOffset);
        if (diagnosticStart < 0) break;
        scopeDiagnostics.push(getAstScopeNames(ts, sourceFile, diagnosticStart).join(','));
        roleDiagnostics.push(String(deriveAstEvidenceRole(
          ts,
          sourceFile,
          diagnosticStart,
          diagnosticStart + entry.evidenceSignature.length,
          entry,
        )));
        diagnosticOffset = diagnosticStart + Math.max(1, entry.evidenceSignature.length);
      }
      const scopeDiagnostic = scopeDiagnostics.length > 0 ? scopeDiagnostics.join('|') : 'none';
      const roleDiagnostic = roleDiagnostics.length > 0 ? roleDiagnostics.join('|') : 'none';
      const excludedDiagnostic = rawStart >= 0
        ? isExcludedAstPosition(rawStart, excludedRangesByPath.get(entry.consumerPath) ?? [])
        : false;
      throw new Error(
        rawOccurrence
          ? `required terminal resource consumer scope mismatch: ${entry.consumerPath}#${entry.consumerSymbol} scopes=${scopeDiagnostic} roles=${roleDiagnostic} expectedRole=${entry.evidenceRole} excluded=${excludedDiagnostic}`
          : `required terminal resource consumer signature missing: ${entry.consumerPath}#${entry.consumerSymbol}`,
      );
    }
    evidenceMatches.push(...matches);
    const evidenceAstSha256 = createHash('sha256').update(JSON.stringify(
      matches.map((match) => match.evidenceAstOccurrenceSha256).sort((left, right) => left.localeCompare(right)),
    ), 'utf8').digest('hex');
    discoveredTuples.push({ ...structuredClone(entry), evidenceAstSha256 });
  }
  for (const entry of PATH_CLASSIFICATIONS) {
    const source = sourceContents.get(entry.path) ?? '';
    parseSource(entry.path, source);
    if (!source.includes(entry.evidenceSignature)) {
      throw new Error(`required terminal resource classification signature missing: ${entry.path}#${entry.symbol}`);
    }
  }
  const classificationAccessEvidence = new Map<string, string>();
  for (const entry of PATH_CLASSIFICATIONS) {
    const source = sourceContents.get(entry.path) ?? '';
    const sourceFile = parseSource(entry.path, source);
    classificationAccessEvidence.set(
      entry.path,
      hashAstResourceAccessEvidence(discoverAstResourceAccesses(ts, sourceFile)),
    );
  }
  const pendingClassificationHashes = PATH_CLASSIFICATIONS.filter(
    (entry) => entry.accessEvidenceSha256 === 'pending',
  );
  if (pendingClassificationHashes.length > 0) {
    throw new Error(`pending terminal resource classification access evidence: ${JSON.stringify(
      pendingClassificationHashes.map((entry) => ({
        path: entry.path,
        accessEvidenceSha256: classificationAccessEvidence.get(entry.path),
      })),
    )}`);
  }
  const exactlyClassifiedPaths = new Set(PATH_CLASSIFICATIONS.filter(
    (entry) => classificationAccessEvidence.get(entry.path) === entry.accessEvidenceSha256,
  ).map((entry) => entry.path));

  const productionFiles = [
    ...await listProductionSourceFiles(options.repositoryRoot, 'server/src'),
    ...await listProductionSourceFiles(options.repositoryRoot, 'frontend/src'),
  ];
  const unregisteredCallSites: Array<{ path: string; symbol: string }> = [];
  for (const path of productionFiles.sort((left, right) => left.localeCompare(right))) {
    if (
      path === 'server/src/services/TerminalResourcePolicy.ts'
      || path === 'server/src/services/TerminalResourcePolicyInventory.ts'
      || path === 'server/src/services/TerminalResourcePolicyObservations.ts'
    ) continue;
    const source = sourceContents.get(path) ?? await readFile(toRepositoryPath(options.repositoryRoot, path), 'utf8');
    const sourceFile = parseSource(path, source);
    const accesses = discoverAstResourceAccesses(ts, sourceFile);
    const registeredMatches = evidenceMatches.filter((match) => match.entry.consumerPath === path);
    const residual = accesses.filter((access) => {
      if (exactlyClassifiedPaths.has(path)) return false;
      if (access.key === undefined) return true;
      return !registeredMatches.some((match) => (
        match.entry.resourceKey === access.key
        && match.start <= access.start
        && access.end <= match.end
        && consumerSymbolMatchesScope(match.entry.consumerSymbol, access.scopeNames)
      ));
    });
    if (residual.length > 0) {
      const first = residual.sort((left, right) => left.start - right.start)[0];
      unregisteredCallSites.push({ path, symbol: first.symbol });
    }
  }

  const evidenceSourcePaths = [...new Set([
    ...requiredPaths,
    ...INVENTORY_EVIDENCE_SUPPORT_PATHS,
  ])].sort((left, right) => left.localeCompare(right));
  const sourceHashes: Record<string, string> = {};
  for (const path of evidenceSourcePaths) {
    const source = sourceContents.get(path) ?? await readRequiredSource(options.repositoryRoot, path);
    sourceHashes[path] = createHash('sha256').update(source, 'utf8').digest('hex');
  }
  const sourceSetRows = Object.entries(sourceHashes)
    .map(([path, hash]) => `${path}:${hash}`)
    .join('\n');
  const sourceSetSha256 = createHash('sha256').update(sourceSetRows, 'utf8').digest('hex');

  const tuples = discoveredTuples;
  return {
    resourceKeys: [...TERMINAL_RESOURCE_KEYS],
    resourceUnits: Object.fromEntries(TERMINAL_RESOURCE_KEYS.map((key) => [key, getTerminalResourcePolicyUnit(key)])),
    consumerPaths: [...new Set(tuples.map((entry) => entry.consumerPath))].sort((left, right) => left.localeCompare(right)),
    gettersOrCallSites: [...new Map(
      tuples.map((entry) => [`${entry.consumerPath}#${entry.consumerSymbol}`, {
        path: entry.consumerPath,
        symbol: entry.consumerSymbol,
      }]),
    ).values()].sort((left, right) => `${left.path}#${left.symbol}`.localeCompare(`${right.path}#${right.symbol}`)),
    tuples,
    classifications: PATH_CLASSIFICATIONS.map((entry) => ({ ...entry })),
    unregisteredCallSites,
    evidenceHashSchemaVersion: TERMINAL_RESOURCE_EVIDENCE_HASH_SCHEMA_VERSION,
    typescriptVersion: ts.version,
    evidenceSourcePaths,
    sourceHashes,
    sourceSetSha256,
  };
}

export async function loadTerminalResourceConsumerManifest(options: {
  manifestPath: string;
}): Promise<TerminalResourceConsumerManifest> {
  const parsed = JSON.parse(await readFile(options.manifestPath, 'utf8')) as TerminalResourceConsumerManifest;
  if (!Array.isArray(parsed.consumers) || !Array.isArray(parsed.classifications)) {
    throw new Error('terminal resource consumer manifest consumers/classifications must be arrays');
  }
  return parsed;
}

export interface TerminalResourceManifestValidationResult {
  ok: boolean;
  errors: Array<{
    code: 'missing-resource-key' | 'orphan-resource-key' | 'missing-consumer' | 'orphan-consumer'
      | 'duplicate-source' | 'unit-mismatch' | 'missing-tuple' | 'orphan-tuple'
      | 'missing-classification' | 'orphan-classification' | 'unregistered-callsite'
      | 'evidence-version-mismatch' | 'source-hash-mismatch' | 'source-set-mismatch';
    reference: string;
  }>;
}

function tupleIdentity(entry: TerminalResourceConsumerManifestEntry): string {
  return [
    entry.consumerId,
    entry.category,
    entry.resourceKey,
    entry.unit,
    entry.source,
    entry.schemaVersion,
    entry.profileVersion,
    JSON.stringify([...entry.legacyAliases].sort((left, right) => left.localeCompare(right))),
    entry.applyBoundary,
    entry.consumerPath,
    entry.consumerSymbol,
    entry.evidenceSignature,
    entry.evidenceRole,
    entry.evidenceAstSha256,
    entry.state,
  ].join('|');
}

function classificationIdentity(entry: TerminalResourcePathClassification): string {
  return [
    entry.path,
    entry.classification,
    entry.symbol,
    entry.evidenceSignature,
    entry.accessEvidenceSha256,
    entry.reason,
  ].join('|');
}

export function validateTerminalResourceConsumerManifest(
  manifest: TerminalResourceConsumerManifest,
  inventory: TerminalResourceInventory,
): TerminalResourceManifestValidationResult {
  const errors: TerminalResourceManifestValidationResult['errors'] = [];
  const fingerprint = manifest.evidence?.consumerAstFingerprint as {
    schemaVersion?: unknown;
    typescriptVersion?: unknown;
  } | undefined;
  if (
    fingerprint?.schemaVersion !== inventory.evidenceHashSchemaVersion
    || fingerprint.typescriptVersion !== inventory.typescriptVersion
  ) {
    errors.push({
      code: 'evidence-version-mismatch',
      reference: `${String(fingerprint?.schemaVersion)}|${String(fingerprint?.typescriptVersion)}`,
    });
  }
  const manifestSourceHashes = manifest.evidence?.sourceHashes as Record<string, unknown> | undefined;
  const manifestSourcePaths = Object.keys(manifestSourceHashes ?? {}).sort((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(manifestSourcePaths) !== JSON.stringify(inventory.evidenceSourcePaths)
    || manifest.evidence?.sourceSetSha256 !== inventory.sourceSetSha256
  ) {
    errors.push({
      code: 'source-set-mismatch',
      reference: `${String(manifest.evidence?.sourceSetSha256)}|${inventory.sourceSetSha256}`,
    });
  }
  for (const [path, hash] of Object.entries(inventory.sourceHashes)) {
    if (manifestSourceHashes?.[path] !== hash) {
      errors.push({ code: 'source-hash-mismatch', reference: path });
    }
  }
  const manifestKeys = new Set(manifest.consumers.map((entry) => entry.resourceKey));
  const inventoryKeys = new Set(inventory.resourceKeys);
  for (const key of inventory.resourceKeys) if (!manifestKeys.has(key)) errors.push({ code: 'missing-resource-key', reference: key });
  for (const key of manifestKeys) if (!inventoryKeys.has(key)) errors.push({ code: 'orphan-resource-key', reference: key });

  const manifestTupleCounts = new Map<string, number>();
  for (const entry of manifest.consumers) {
    const id = tupleIdentity(entry);
    manifestTupleCounts.set(id, (manifestTupleCounts.get(id) ?? 0) + 1);
    if (inventory.resourceUnits[entry.resourceKey] !== entry.unit) errors.push({ code: 'unit-mismatch', reference: id });
  }
  const inventoryTuples = new Set(inventory.tuples.map(tupleIdentity));
  for (const [id, count] of manifestTupleCounts) {
    if (count > 1) errors.push({ code: 'duplicate-source', reference: id });
    if (!inventoryTuples.has(id)) errors.push({ code: 'orphan-tuple', reference: id });
  }
  for (const entry of inventory.tuples) {
    const id = tupleIdentity(entry);
    if (!manifestTupleCounts.has(id)) errors.push({ code: 'missing-tuple', reference: id });
  }

  const manifestClassifications = new Set(manifest.classifications.map(classificationIdentity));
  const inventoryClassifications = new Set(inventory.classifications.map(classificationIdentity));
  for (const id of inventoryClassifications) if (!manifestClassifications.has(id)) errors.push({ code: 'missing-classification', reference: id });
  for (const id of manifestClassifications) if (!inventoryClassifications.has(id)) errors.push({ code: 'orphan-classification', reference: id });
  for (const entry of inventory.unregisteredCallSites) {
    errors.push({ code: 'unregistered-callsite', reference: `${entry.path}#${entry.symbol}` });
  }

  return { ok: errors.length === 0, errors };
}
