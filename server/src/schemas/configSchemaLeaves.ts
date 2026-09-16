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

    if (kindOf(current) === 'pipe') {
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

    if (def.innerType !== undefined) { current = def.innerType; continue; }
    if (def.schema !== undefined) { current = def.schema; continue; }
    return current;
  }
  return current;
}

/**
 * Zod kinds that carry child schemas the walk would otherwise swallow.
 *
 * A union, record, lazy, intersection or tuple is not an object schema, so
 * `shapeOf` returns null for it and the whole subtree collapses into a single
 * leaf — silently, and with the leaf count still looking plausible. None of
 * these occurs in the config schema today, which is exactly why the failure
 * would go unnoticed if one were introduced. `array` is deliberately absent:
 * `z.array(z.string())` is a genuine leaf, because the operator sets it as one
 * value.
 */
const UNSUPPORTED_COMPOSITE_KINDS = new Set([
  'union', 'ZodUnion',
  'discriminatedUnion', 'ZodDiscriminatedUnion',
  'record', 'ZodRecord',
  'lazy', 'ZodLazy',
  'intersection', 'ZodIntersection',
  'tuple', 'ZodTuple',
]);

function shapeOf(schema: unknown, path: string): Record<string, unknown> | null {
  const unwrapped = unwrap(schema) as ZodInternals | undefined;
  if (!isObjectSchema(unwrapped)) {
    const kind = kindOf(unwrapped);
    if (kind !== undefined && UNSUPPORTED_COMPOSITE_KINDS.has(kind)) {
      throw new Error(
        `configSchemaLeaves cannot walk ${kind} at ${path || '<root>'}: its child schemas would collapse into a single leaf. Teach the walker this kind before using it in the config schema.`,
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
