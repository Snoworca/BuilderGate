import { relative, resolve, sep } from 'node:path';

/**
 * FR-BGSTAB-030 — which checkout is this runtime actually serving?
 *
 * Measured 2026-09-20: this checkout's `dist/index.js` was started from cmd.exe
 * and inherited fifteen BUILDERGATE_* variables set in the Windows environment,
 * every one of them pointing at the installed deployment. The server started,
 * `/health` answered 200, and the assets it served and the config it read were
 * the installed deployment's. WSL has none of those variables, so a procedure
 * written against WSL did not transfer — and nothing in the running system said
 * so. A wrong runtime looked exactly like a right one.
 *
 * The anchor that makes this decidable is already there and cannot be
 * overridden by an environment variable: the directory the running module was
 * loaded from. `dist/index.js` sits in exactly one checkout, whatever the
 * environment claims. So "did a resolved path leave the code that is running"
 * is a mechanical question rather than a matter of remembering to check.
 */

/** A path this runtime resolved, and the name it is known by. */
export interface ResolvedRuntimePath {
  name: 'serverRoot' | 'configPath' | 'webRoot';
  resolved: string;
}

export interface RuntimeProvenanceInput {
  /** Where the running module was loaded from — the anchor. */
  moduleDir: string;
  serverRoot: string;
  configPath: string;
  webRoot: string;
}

/**
 * The part of the provenance that is safe to hand an unauthenticated caller.
 * A verdict and a build id, never a path: `/health` takes no auth, and absolute
 * filesystem paths are a disclosure with no corresponding gain. The verdict is
 * what a scripted preflight actually needs.
 */
export interface RuntimeProvenanceHealthView {
  rootsForeign: boolean;
  buildId: string | null;
}

export interface RuntimeProvenance {
  /** The checkout the running code belongs to. */
  anchor: string;
  foreign: ResolvedRuntimePath[];
  hasForeignRoot: boolean;
  toHealthView(buildId: string | null): RuntimeProvenanceHealthView;
}

/**
 * True when `candidate` is `root` or sits under it.
 *
 * `startsWith` on the raw strings is wrong and the failure is quiet: a sibling
 * checkout named `checkout-a2` shares a prefix with `checkout-a` and is a
 * different tree. `relative()` answers the containment question directly — it
 * returns a path that escapes upwards, or an absolute path, when it does not.
 */
function contains(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '') return true;
  return !rel.startsWith(`..${sep}`) && rel !== '..' && !/^[A-Za-z]:/.test(rel);
}

export function describeRuntimeProvenance(input: RuntimeProvenanceInput): RuntimeProvenance {
  // The anchor is the CHECKOUT: `<checkout>/server/dist` -> `<checkout>`.
  //
  // Two off-by-ones are available here and both are quiet. Anchoring on the
  // module directory itself calls the ordinary layout foreign, because
  // `config.json5` sits beside `server/` one level above `dist/`, and a warning
  // that fires on every correct start is a warning nobody reads. Going one
  // level too far up anchors on the PARENT of the checkout, which makes every
  // sibling checkout look local — the guard then passes while measuring
  // nothing. The second one was caught by the sibling-prefix test.
  const anchor = resolve(input.moduleDir, '..', '..');

  const candidates: ResolvedRuntimePath[] = [
    { name: 'serverRoot', resolved: resolve(input.serverRoot) },
    { name: 'configPath', resolved: resolve(input.configPath) },
    { name: 'webRoot', resolved: resolve(input.webRoot) },
  ];

  const foreign = candidates.filter(entry => !contains(anchor, entry.resolved));

  return {
    anchor,
    foreign,
    hasForeignRoot: foreign.length > 0,
    toHealthView(buildId: string | null): RuntimeProvenanceHealthView {
      return { rootsForeign: foreign.length > 0, buildId };
    },
  };
}

/** The startup warning. Local log, so it names the paths — that is the point. */
export function formatForeignRootWarning(provenance: RuntimeProvenance): string[] {
  if (!provenance.hasForeignRoot) return [];
  return [
    '[Provenance] This runtime is serving files from outside the checkout it was loaded from.',
    `[Provenance]   running code: ${provenance.anchor}`,
    ...provenance.foreign.map(entry => `[Provenance]   ${entry.name} -> ${entry.resolved}`),
    '[Provenance] An inherited BUILDERGATE_* variable is the usual cause. A health check '
      + 'will still answer 200; it is answering for whatever is running, not for your build.',
  ];
}
