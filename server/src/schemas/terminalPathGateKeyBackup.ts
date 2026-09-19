import {
  TERMINAL_PATH_GATE_KEYS,
  type TerminalPathGateKeyName,
} from './terminalPathGateKeys.js';

/**
 * OPS-BGSTAB-012 — the terminal-path gate key backup artifact.
 *
 * Records where the gate keys stood at a point in time so that a later default flip has a
 * recorded starting position to return to. It is a reference for a human-performed
 * restore, never a mechanism: there is no apply path here, and this module deliberately
 * reaches no filesystem or settings-mutation surface, so producing one is safe on a live
 * deployment (AC-6).
 *
 * @req OPS-BGSTAB-012
 */

export interface TerminalPathGateKeyStateEntry {
  /**
   * The value held by the running server's own state -- the RuntimeConfigStore's editable
   * values, its realtime getters, or the compiled terminal policy. Never a re-parse of
   * `config.json5`, and never a schema default substituted for a missing read (AC-2).
   */
  readonly effectiveValue: string;
  /** Declared in the deployment's config file, whatever value it declares. */
  readonly explicit: boolean;
  /**
   * The value the runtime consumer actually reads, when that can differ from the store's.
   * `realtime.terminalWireFormat` is the known case: the store reassigns its copy on
   * config reload while the router holds what it read from module-top-level `config` at
   * boot. Omit it when the consumer reads the store.
   */
  readonly consumerValue?: string;
}

export type TerminalPathGateKeyState = Record<TerminalPathGateKeyName, TerminalPathGateKeyStateEntry>;

/**
 * Whether the deployment's config file DECLARES a key, which is not answerable from the
 * parsed config: zod fills defaults in, so a parsed `realtime.wsTransportMode` is present
 * whether or not the file said anything. `explicit` therefore has to be read from the raw
 * pre-parse object, and this walks the dotted path rather than trusting the parsed shape.
 *
 * @req OPS-BGSTAB-012 AC-1
 */
export function declaredInRawConfig(rawConfig: unknown, dottedPath: string): boolean {
  let cursor: unknown = rawConfig;
  for (const segment of dottedPath.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return false;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor !== undefined;
}

/**
 * Pairs the running server's effective values with declaration presence read from the raw
 * config. Effective values come from the caller's live state -- never re-parsed and never
 * defaulted in here (AC-2).
 *
 * @req OPS-BGSTAB-012 AC-2
 */
export function collectTerminalPathGateKeyState(input: {
  readonly effectiveValues: Record<TerminalPathGateKeyName, string>;
  readonly rawConfig: unknown;
  /** What the boot-time consumer holds, where it can differ from the store. */
  readonly consumerValues?: Partial<Record<TerminalPathGateKeyName, string>>;
}): TerminalPathGateKeyState {
  const state = {} as Record<TerminalPathGateKeyName, TerminalPathGateKeyStateEntry>;
  for (const [name, descriptor] of TERMINAL_PATH_GATE_KEYS) {
    const consumerValue = input.consumerValues?.[name];
    state[name] = {
      effectiveValue: input.effectiveValues[name],
      explicit: declaredInRawConfig(input.rawConfig, descriptor.path),
      ...(consumerValue !== undefined ? { consumerValue } : {}),
    };
  }
  return state;
}

export interface TerminalPathGateKeyProvenance {
  readonly serverBuild: string;
  readonly configSourcePath: string;
  readonly schemaShapeId: string;
}

export interface TerminalPathGateKeyBackupEntry {
  readonly name: TerminalPathGateKeyName;
  /** Dotted path, as an operator would write it to restore this value by hand. */
  readonly key: string;
  /** What the runtime reads today. Where store and consumer disagree, this is the consumer's. */
  readonly effectiveValue: string;
  readonly schemaDefault: string;
  /**
   * Declared in the config file. Independent of `nonDefault`: `wsTransportMode` is pinned
   * to `unified`, which IS the schema default, so a single boolean gets that key wrong in
   * both directions (AC-1).
   */
  readonly explicit: boolean;
  readonly nonDefault: boolean;
  /** False for a key that is inventoried but has no runtime branch on its value (AC-5). */
  readonly gating: boolean;
  readonly consumer: string;
  /** Present only when the store and the runtime consumer hold different values (AC-2). */
  readonly divergence?: {
    readonly storeValue: string;
    readonly consumerValue: string;
  };
}

export interface TerminalPathGateKeyBackup {
  readonly artifactKind: 'terminal-path-gate-key-backup/v1';
  readonly capturedAt: string;
  readonly provenance: TerminalPathGateKeyProvenance;
  readonly keys: readonly TerminalPathGateKeyBackupEntry[];
}

/**
 * Assembles the artifact. Throws rather than emitting a short or a widened one: an
 * artifact missing a key looks exactly like a complete one to its reader, and omission is
 * precisely how issue #21's own gate-key table went stale (AC-4).
 */
export function buildTerminalPathGateKeyBackup(
  state: TerminalPathGateKeyState,
  provenance: TerminalPathGateKeyProvenance,
  capturedAt: Date,
): TerminalPathGateKeyBackup {
  const supplied = new Set(Object.keys(state));

  const missing = [...TERMINAL_PATH_GATE_KEYS.keys()].filter((name) => !supplied.has(name));
  if (missing.length > 0) {
    throw new Error(`terminal-path gate key backup is missing: ${missing.join(', ')}`);
  }
  const unknown = [...supplied].filter((name) => !TERMINAL_PATH_GATE_KEYS.has(name as TerminalPathGateKeyName));
  if (unknown.length > 0) {
    throw new Error(`terminal-path gate key backup carries untriaged keys: ${unknown.join(', ')}`);
  }

  const keys = [...TERMINAL_PATH_GATE_KEYS].map(([name, descriptor]): TerminalPathGateKeyBackupEntry => {
    const entry = state[name];
    const diverged = entry.consumerValue !== undefined && entry.consumerValue !== entry.effectiveValue;
    // When the two disagree, the value worth recording is the one the runtime reads.
    // Recording the store's would be recording a state nothing observes.
    const effectiveValue = diverged ? entry.consumerValue! : entry.effectiveValue;

    return {
      name,
      key: descriptor.path,
      effectiveValue,
      schemaDefault: descriptor.schemaDefault,
      explicit: entry.explicit,
      nonDefault: effectiveValue !== descriptor.schemaDefault,
      gating: descriptor.gating,
      consumer: descriptor.consumer,
      ...(diverged
        ? { divergence: { storeValue: entry.effectiveValue, consumerValue: entry.consumerValue! } }
        : {}),
    };
  });

  return {
    artifactKind: 'terminal-path-gate-key-backup/v1',
    capturedAt: capturedAt.toISOString(),
    provenance,
    keys,
  };
}
