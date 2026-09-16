import type { ZodType } from 'zod';

// @req OPS-BGSTAB-011 AC-1
//
// Derives the dotted path of every leaf in a configuration schema by walking the
// Zod tree, so the settings inventory can be pinned against the schema itself
// rather than against a hand-maintained second list that drifts out of date.
//
// The walk has to see through three wrappers the config schema actually uses:
//
//   defaultObject(x)            z.preprocess(fn, x)   -> a pipe whose `out` is the object
//   telemetryResourceLimits     a preprocess inside a preprocess, i.e. nested pipes
//   ptySchema                   xInput.transform(fn)  -> a pipe whose `out` is the transform
//
// The first two want the pipe's output; the last wants its input, because the
// operator writes the keys of `ptySchemaInput` and the transform only folds the
// legacy `maxBufferSize` alias into `maxSnapshotBytes` afterwards. Preferring
// `out` and falling back to `in` when `out` is not an object resolves both
// without special-casing either by name.

/** Guards against a cycle in a malformed schema turning the walk into a hang. */
const MAX_UNWRAP_DEPTH = 100;

/**
 * Kinds whose inner schema is the same value seen through a modifier.
 *
 * Only these are stripped. Chasing `innerType` for any kind that happens to have
 * one is what let `z.promise(z.object(...))` pass as its own payload object: the
 * promise is not a configuration value the operator writes, but the walk
 * silently descended through it and emitted the payload's keys as config leaves.
 * Restricting the strip to declared wrappers makes every other container reach
 * the leaf-kind allowlist below and be refused by name.
 */
const TRANSPARENT_WRAPPER_KINDS = new Set([
  'optional', 'ZodOptional',
  'nullable', 'ZodNullable',
  'default', 'ZodDefault',
  'prefault', 'ZodPrefault',
  'catch', 'ZodCatch',
  'readonly', 'ZodReadonly',
  'nonoptional', 'ZodNonOptional',
  'branded', 'ZodBranded',
  'effects', 'ZodEffects',
]);

interface ZodInternals {
  readonly _def?: {
    readonly type?: string;
    readonly typeName?: string;
    readonly innerType?: unknown;
    readonly schema?: unknown;
    readonly in?: unknown;
    readonly out?: unknown;
  };
  readonly shape?: unknown;
}

function defOf(schema: unknown): ZodInternals['_def'] | undefined {
  return (schema as ZodInternals | undefined)?._def;
}

function kindOf(schema: unknown): string | undefined {
  const def = defOf(schema);
  return def?.type ?? def?.typeName;
}

function isObjectSchema(schema: unknown): boolean {
  const kind = kindOf(schema);
  return kind === 'object' || kind === 'ZodObject';
}

/**
 * Strips wrappers until an object schema, or something that is not a wrapper at
 * all, is reached. `preferInput` exists only for the second pass over a pipe
 * whose output turned out not to be an object.
 */
function unwrap(schema: unknown, preferInput = false): unknown {
  let current = schema;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (isObjectSchema(current)) return current;
    const def = defOf(current);
    if (!def) return current;

    const pipeKind = kindOf(current);
    if (pipeKind === 'pipe' || pipeKind === 'ZodPipeline') {
      if (!preferInput && def.out !== undefined) {
        const out = unwrap(def.out, false);
        if (isObjectSchema(out)) return out;
      }
      if (def.in !== undefined) {
        const input = unwrap(def.in, true);
        if (isObjectSchema(input)) return input;
      }
      return current;
    }

    const kind = kindOf(current);
    if (kind !== undefined && TRANSPARENT_WRAPPER_KINDS.has(kind)) {
      if (def.innerType !== undefined) { current = def.innerType; continue; }
      if (def.schema !== undefined) { current = def.schema; continue; }
    }
    return current;
  }
  return current;
}

/**
 * Zod kinds that are genuine leaves: a single value the operator writes.
 *
 * This is an allowlist rather than a list of known-bad kinds, because the
 * failure it guards against is silent. A composite that is not an object and
 * not listed here — a union, record, lazy, intersection, tuple, map, set,
 * promise, function or custom — carries structure that `shapeOf` cannot see, so
 * it would collapse into one leaf with the leaf count still looking plausible.
 * A denylist only catches the kinds someone thought of in advance; an allowlist
 * makes every unanticipated kind an immediate, named failure.
 *
 * The allowlist therefore holds every kind that is a single written value,
 * including the rarely used scalars `bigint`, `symbol`, `nan` and
 * `template_literal`: refusing those bought nothing, since a scalar has no
 * children to lose, and only turned a usable config kind into a crash. The one
 * scalar still refused is `z.instanceof`, which reports itself as `custom` and
 * so cannot be told apart from a genuine `z.custom` composite by kind alone.
 *
 * `array` is deliberately present, and it is terminal BY POLICY rather than by
 * structure: `z.array(z.string())` is a genuine leaf because the operator sets
 * it as one value, and `fileManager.blockedExtensions` depends on staying one
 * leaf. The element schema of an array is deliberately not walked, so
 * `z.array(z.object({…}))` yields a single leaf silently — that is the one
 * anticipated gap in the "every unanticipated kind fails loudly" guarantee
 * above, and it is accepted because the config schema has no such array.
 *
 * Both the zod3 (`ZodString`) and zod4 (`string`) spellings are listed so the
 * walk does not silently start throwing on a major-version bump.
 */
const LEAF_KINDS = new Set([
  'string', 'ZodString',
  'number', 'ZodNumber',
  'boolean', 'ZodBoolean',
  'literal', 'ZodLiteral',
  'enum', 'ZodEnum',
  'nativeEnum', 'ZodNativeEnum',
  'array', 'ZodArray',
  'date', 'ZodDate',
  'null', 'ZodNull',
  'undefined', 'ZodUndefined',
  'any', 'ZodAny',
  'unknown', 'ZodUnknown',
  'bigint', 'ZodBigInt',
  'symbol', 'ZodSymbol',
  'nan', 'ZodNaN',
  'template_literal', 'ZodTemplateLiteral',
]);

/**
 * The kind a non-object node ultimately resolves to.
 *
 * `unwrap` stops at a pipe whose endpoints are not objects, which is what
 * `auth.password` (`z.preprocess(fn, z.string()).default('')`) resolves to. The
 * pipe is not itself a leaf kind, so the allowlist has to be applied to what the
 * pipe produces rather than to the pipe.
 */
function leafKindOf(schema: unknown): string | undefined {
  let current = schema;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const kind = kindOf(current);
    if (kind !== 'pipe' && kind !== 'ZodPipeline' && kind !== 'ZodEffects') return kind;
    const def = defOf(current);
    const next = def?.out ?? def?.in ?? def?.schema;
    if (next === undefined) return kind;
    current = unwrap(next);
  }
  return kindOf(current);
}

function shapeOf(schema: unknown, path: string): Record<string, unknown> | null {
  const unwrapped = unwrap(schema) as ZodInternals | undefined;
  if (!isObjectSchema(unwrapped)) {
    const kind = leafKindOf(unwrapped);
    if (kind === undefined || !LEAF_KINDS.has(kind)) {
      throw new Error(
        `configSchemaLeaves cannot walk ${kind ?? 'an unrecognised schema'} at ${path || '<root>'}: it is not an object and not an allowlisted leaf kind, so any child schemas it carries would collapse into a single leaf and any it does not carry would be counted as a value the walker never verified. Teach the walker this kind before using it in the config schema.`,
      );
    }
    return null;
  }
  const shape = unwrapped?.shape;
  const resolved = typeof shape === 'function'
    ? (shape as () => Record<string, unknown>)()
    : shape as Record<string, unknown> | undefined;
  if (resolved === undefined) {
    throw new Error(`configSchemaLeaves could not read the shape of the object at ${path || '<root>'}`);
  }
  // An empty object contributes neither a leaf nor any children, so it would
  // vanish from the inventory entirely rather than fail the coverage pin.
  if (Object.keys(resolved).length === 0) {
    throw new Error(
      `configSchemaLeaves found an object with no keys at ${path || '<root>'}: it would disappear from the leaf list instead of being classified.`,
    );
  }
  return resolved;
}

/**
 * Every leaf path in `schema`, dotted and sorted.
 *
 * A "leaf" is any node that is not an object once its wrappers are stripped, so
 * arrays such as `fileManager.blockedExtensions` are leaves rather than
 * containers: the operator sets them as a single value.
 */
export function listConfigSchemaLeafPaths(schema: ZodType): string[] {
  const leaves: string[] = [];

  const visit = (node: unknown, prefix: string): void => {
    const shape = shapeOf(node, prefix);
    if (!shape) {
      if (prefix) leaves.push(prefix);
      return;
    }
    for (const key of Object.keys(shape)) {
      visit(shape[key], prefix ? `${prefix}.${key}` : key);
    }
  };

  visit(schema, '');
  return leaves.sort();
}
