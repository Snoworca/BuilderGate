import { z } from 'zod';

import { configSchema } from './config.schema.js';

/**
 * #62: report configuration keys the schema does not know.
 *
 * zod strips unknown keys silently unless a block is `.strict()`, and only the
 * `resourceLimits` and `stabilityModes` subtrees are. Everywhere else -- server, pty,
 * session, ssl, security, twoFactor, bootstrap, auth, fileManager, workspace and the top
 * level -- a typo'd key was accepted, dropped, and never mentioned. The operator sees a
 * server that started normally and a setting that does nothing.
 *
 * This REPORTS rather than REJECTS, deliberately.
 *
 * Making those blocks `.strict()` would be the stronger fix and is the obvious one, but an
 * unknown key would then stop an existing deployment from booting at its next restart -- and
 * the deployments most likely to carry one are precisely the long-lived ones whose config
 * predates a rename. Turning a silent no-op into a boot failure is not a safe trade to make
 * on someone else's behalf, so the diagnosis is surfaced and the decision to enforce is left
 * to whoever can see the config that would break.
 */
export interface UnknownConfigKey {
  path: string;
  /** The keys the schema does know at that level, so a typo is obvious on sight. */
  knownSiblings: readonly string[];
}

function shapeOf(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  // Unwrap the wrappers this schema file actually uses: optional, default, effects
  // (superRefine/transform) and the defaultObject() helper, which is a default around an object.
  // zod 4 keeps the discriminator in `_def.type` (a string like 'object' / 'optional'), not in
  // the v3 `_def.typeName`. Reading the v3 field yields undefined for every node, the walk falls
  // straight through, and the reporter finds nothing -- which looks exactly like a clean config.
  // That is the vacuous pass this issue is about, so the shape is read directly instead.
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 12; depth += 1) {
    const shape = (current as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
    if (shape && typeof shape === 'object') return shape;
    const def = (current as unknown as { _def?: Record<string, unknown> })._def;
    if (!def) return null;
    // `out` covers the pipe nodes that defaultObject() builds (preprocess -> object); without it
    // the walk stops at the first defaulted block and reports nothing below it.
    const inner = (def.innerType ?? def.schema ?? def.out ?? def.in) as z.ZodTypeAny | undefined;
    if (!inner) return null;
    current = inner;
  }
  return null;
}

export function findUnknownConfigKeys(
  rawConfig: unknown,
  schema: z.ZodTypeAny = configSchema,
  prefix = '',
): UnknownConfigKey[] {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) return [];
  const shape = shapeOf(schema);
  if (!shape) return [];

  const known = Object.keys(shape);
  const found: UnknownConfigKey[] = [];
  for (const [key, value] of Object.entries(rawConfig as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (!Object.prototype.hasOwnProperty.call(shape, key)) {
      found.push({ path, knownSiblings: known });
      continue;
    }
    found.push(...findUnknownConfigKeys(value, shape[key], path));
  }
  return found;
}

export function warnUnknownConfigKeys(rawConfig: unknown, logger: (line: string) => void = console.warn): number {
  const unknown = findUnknownConfigKeys(rawConfig);
  for (const entry of unknown) {
    logger(`[Config] Unknown key ignored: ${entry.path} `
      + `(known at that level: ${entry.knownSiblings.join(', ')})`);
  }
  return unknown.length;
}
