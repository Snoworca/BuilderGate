import {
  TERMINAL_PATH_GATE_KEYS,
  type TerminalPathGateKeyDescriptor,
  type TerminalPathGateKeyName,
} from './terminalPathGateKeys.js';
import type { TerminalPathGateKeyBackup } from './terminalPathGateKeyBackup.js';

/**
 * OPS-BGSTAB-013 — the gate-key rollback drill.
 *
 * Proves the rollback MECHANISM, not a flip: capture, change, observe, restore, observe,
 * over `stabilityModes.headlessQueueMode`, which is inventoried and has no runtime branch
 * on its value. Moving a gating key would be performing the default flip that
 * OPS-BGSTAB-012 AC-8 declines to authorise, so the drill refuses to run if the inventory
 * ever reclassifies this key (AC-4).
 *
 * The drill's own failure mode is passing while proving nothing: if the change silently
 * no-ops, then capture succeeds, restore "succeeds" because nothing moved, and the
 * comparison passes. `observe-change` exists to make that a failure (AC-6).
 *
 * @req OPS-BGSTAB-013
 */

export const DRILL_KEY = 'headlessQueueMode' as const;

export type DrillStepName =
  | 'capture'
  | 'change'
  | 'observe-change'
  | 'restore'
  | 'observe-restore';

export const DRILL_STEPS: readonly DrillStepName[] = [
  'capture',
  'change',
  'observe-change',
  'restore',
  'observe-restore',
];

export interface DrillStepResult {
  readonly step: DrillStepName;
  /**
   * Whether the step executed at all. A step that never ran and a step that ran and failed
   * are different outcomes, and today produced three findings that turned on exactly that
   * distinction, so they are never collapsed into one boolean (AC-1).
   */
  readonly ran: boolean;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DrillReport {
  readonly ok: boolean;
  readonly refusedReason?: string;
  readonly steps: readonly DrillStepResult[];
  /** Every key compared after the restore, not only the one that moved (AC-3). */
  readonly comparedKeys: readonly string[];
  /** Whether the post-restore artifact's `explicit` axis was re-read (AC-7). */
  readonly explicitRefreshed: boolean;
}

export interface GateKeyRollbackDrillDeps {
  /** Produce a backup artifact from live state. */
  readonly captureBackup: () => TerminalPathGateKeyBackup;
  /** Write the value through the real settings path and apply it. */
  readonly applyValue: (value: string) => void;
  /** Read the value back from live state -- never from what was written. */
  readonly readValue: () => string;
  /** The value the drill moves to; must differ from the captured one. */
  readonly changeTo: string;
  readonly configPath: string;
  /** True when this config belongs to the drill, not to an installation. */
  readonly ownsConfig: (configPath: string) => boolean;
  /**
   * The inventory to read the drill key's classification from. Defaults to the real one;
   * overridden only so the fail-closed branch can be exercised, because a classification
   * change is exactly the case that must not first be discovered in production.
   */
  readonly gateKeys?: ReadonlyMap<TerminalPathGateKeyName, TerminalPathGateKeyDescriptor>;
}

function refuse(reason: string): DrillReport {
  return {
    ok: false,
    refusedReason: reason,
    steps: DRILL_STEPS.map((step) => ({
      step,
      ran: false,
      ok: false,
      detail: 'not reached: the drill refused before starting',
    })),
    comparedKeys: [],
    explicitRefreshed: false,
  };
}

export function runGateKeyRollbackDrill(deps: GateKeyRollbackDrillDeps): DrillReport {
  const descriptor = (deps.gateKeys ?? TERMINAL_PATH_GATE_KEYS).get(DRILL_KEY);
  if (descriptor === undefined) {
    return refuse(`${DRILL_KEY} is no longer in the gate-key inventory`);
  }
  if (descriptor.gating) {
    // Inherits the inventory's protection rather than restating it: the moment this key is
    // measured as selecting a path, drilling on it becomes a flip.
    return refuse(`${DRILL_KEY} is now classified as gating; drilling it would perform a flip`);
  }
  if (!deps.ownsConfig(deps.configPath)) {
    // The change step rewrites the config file, so this is a property of the drill rather
    // than a rule someone has to remember when invoking it (AC-5).
    return refuse(`refusing to drill against a config this drill does not own: ${deps.configPath}`);
  }

  const steps: DrillStepResult[] = [];
  const unreached = (from: number): DrillStepResult[] =>
    DRILL_STEPS.slice(from).map((step) => ({
      step,
      ran: false,
      ok: false,
      detail: 'not reached: an earlier step failed',
    }));

  // 1. capture
  let before: TerminalPathGateKeyBackup;
  try {
    before = deps.captureBackup();
  } catch (error) {
    steps.push({ step: 'capture', ran: true, ok: false, detail: describe(error) });
    return { ok: false, steps: [...steps, ...unreached(1)], comparedKeys: [], explicitRefreshed: false };
  }
  const captured = entryFor(before, descriptor.path);
  if (captured === undefined) {
    steps.push({ step: 'capture', ran: true, ok: false, detail: `artifact has no ${descriptor.path}` });
    return { ok: false, steps: [...steps, ...unreached(1)], comparedKeys: [], explicitRefreshed: false };
  }
  const originalValue = captured.effectiveValue;
  steps.push({ step: 'capture', ran: true, ok: true, detail: `captured ${descriptor.path}=${originalValue}` });

  if (deps.changeTo === originalValue) {
    // A change to the value already held cannot be observed to have taken effect, so the
    // whole drill would be vacuous. Refuse rather than report a green run.
    steps.push({
      step: 'change',
      ran: false,
      ok: false,
      detail: `the drill would change ${originalValue} to itself; nothing would be observable`,
    });
    return { ok: false, steps: [...steps, ...unreached(2)], comparedKeys: [], explicitRefreshed: false };
  }

  // 2. change
  try {
    deps.applyValue(deps.changeTo);
    steps.push({ step: 'change', ran: true, ok: true, detail: `wrote ${deps.changeTo}` });
  } catch (error) {
    steps.push({ step: 'change', ran: true, ok: false, detail: describe(error) });
    return { ok: false, steps: [...steps, ...unreached(2)], comparedKeys: [], explicitRefreshed: false };
  }

  // 3. observe-change -- the control. Reads back rather than trusting the write.
  const changedValue = deps.readValue();
  if (changedValue !== deps.changeTo) {
    steps.push({
      step: 'observe-change',
      ran: true,
      ok: false,
      detail: `the change did not take: read ${changedValue}, wrote ${deps.changeTo}. `
        + 'Restoring now would pass against a mechanism that does nothing.',
    });
    return { ok: false, steps: [...steps, ...unreached(3)], comparedKeys: [], explicitRefreshed: false };
  }
  steps.push({ step: 'observe-change', ran: true, ok: true, detail: `read back ${changedValue}` });

  // 4. restore
  try {
    deps.applyValue(originalValue);
    steps.push({ step: 'restore', ran: true, ok: true, detail: `wrote ${originalValue}` });
  } catch (error) {
    steps.push({ step: 'restore', ran: true, ok: false, detail: describe(error) });
    return { ok: false, steps: [...steps, ...unreached(4)], comparedKeys: [], explicitRefreshed: false };
  }

  // 5. observe-restore -- against the captured artifact, over every key it holds.
  const after = deps.captureBackup();
  const comparedKeys = before.keys.map((row) => row.key);
  const mismatches = before.keys.flatMap((row) => {
    const now = entryFor(after, row.key);
    if (now === undefined) return [`${row.key}: absent after restore`];
    return now.effectiveValue === row.effectiveValue
      ? []
      : [`${row.key}: expected ${row.effectiveValue}, read ${now.effectiveValue}`];
  });

  if (mismatches.length > 0) {
    steps.push({ step: 'observe-restore', ran: true, ok: false, detail: mismatches.join('; ') });
    return { ok: false, steps, comparedKeys, explicitRefreshed: true };
  }
  steps.push({
    step: 'observe-restore',
    ran: true,
    ok: true,
    detail: `all ${comparedKeys.length} captured keys read back equal`,
  });

  return { ok: true, steps, comparedKeys, explicitRefreshed: true };
}

function entryFor(backup: TerminalPathGateKeyBackup, key: string) {
  return backup.keys.find((row) => row.key === key);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
