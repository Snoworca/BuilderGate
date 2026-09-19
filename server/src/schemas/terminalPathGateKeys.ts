/**
 * The configuration keys that select between the old and the new terminal path.
 *
 * This is the single expression of that set. It was extracted from
 * `terminalPathGateKeys.test.ts` when OPS-BGSTAB-012 added a second reader: a guard and a
 * generator holding their own copies of "which keys are the gate keys" is the same defect
 * shape as a value expressed twice, and it fails the same way -- quietly, with each copy
 * internally consistent.
 *
 * Membership is decided by whether a runtime branch actually reads the value, not by how
 * many values the schema offers. `headlessQueueMode` is carried with `gating: false` for
 * exactly that reason: it is inventoried, and it is not a flip target.
 *
 * @req OPS-BGSTAB-012 AC-4
 * @see docs/analysis/2026-09-19.issue21-gate-key-inventory.md
 */

export type TerminalPathGateKeyName =
  | 'wsTransportMode'
  | 'terminalWireFormat'
  | 'headlessQueueMode'
  | 'wsSendMode'
  | 'frontendRuntimeResidency'
  | 'hiddenOutputPolicy';

export interface TerminalPathGateKeyDescriptor {
  /** Dotted configuration path, as an operator would write it in `config.json5`. */
  readonly path: string;
  readonly schemaDefault: string;
  /** The file holding the runtime read, not the files that merely plumb the value. */
  readonly consumer: string;
  /** False when the schema offers several values and no runtime branch consumes the difference. */
  readonly gating: boolean;
}

export const TERMINAL_PATH_GATE_KEYS: ReadonlyMap<TerminalPathGateKeyName, TerminalPathGateKeyDescriptor> = new Map([
  ['wsTransportMode', {
    path: 'realtime.wsTransportMode',
    schemaDefault: 'unified',
    consumer: 'server/src/services/RuntimeConfigStore.ts',
    gating: true,
  }],
  ['terminalWireFormat', {
    path: 'realtime.terminalWireFormat',
    schemaDefault: 'json',
    consumer: 'server/src/index.ts',
    gating: true,
  }],
  ['headlessQueueMode', {
    path: 'stabilityModes.headlessQueueMode',
    schemaDefault: 'observe',
    consumer: 'server/src/services/SessionManager.ts',
    gating: false,
  }],
  ['wsSendMode', {
    path: 'stabilityModes.wsSendMode',
    schemaDefault: 'direct',
    consumer: 'server/src/ws/WsRouter.ts',
    gating: true,
  }],
  ['frontendRuntimeResidency', {
    path: 'stabilityModes.frontendRuntimeResidency',
    schemaDefault: 'bounded',
    consumer: 'frontend/src/hooks/useTerminalRuntimeResidency.ts',
    gating: true,
  }],
  ['hiddenOutputPolicy', {
    path: 'resourceLimits.terminal.hiddenOutputPolicy',
    schemaDefault: 'snapshot-restore',
    consumer: 'server/src/services/TerminalResourcePolicy.ts',
    gating: true,
  }],
]);

/** Schema enums triaged as NOT selecting between the old and new terminal path. */
export const NON_GATE_CONFIG_ENUMS: ReadonlyMap<string, string> = new Map([
  ['mode', 'session.processCleanup.mode — process-tree termination, owned by FR-BGSTAB-019'],
  ['windowsPowerShellBackend', 'PTY backend selection, not a terminal-path axis'],
  ['shell', 'shell selection, not a terminal-path axis'],
  ['overflowPolicy', 'headless overflow handling, not a path selector'],
]);
