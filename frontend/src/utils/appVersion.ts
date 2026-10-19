// FR-ARCH-007 — the running BuilderGate release version.

/** Replaced by Vite at build time (`define` in vite.config.ts) with the root package.json version. */
declare const __BUILDERGATE_VERSION__: string;

/**
 * Outside a Vite build (the node unit runner) the identifier is not defined, so this falls back
 * rather than throwing a ReferenceError.
 */
export const APP_VERSION: string =
  typeof __BUILDERGATE_VERSION__ === 'string' ? __BUILDERGATE_VERSION__ : 'dev';

/** Replaced by Vite at build time with the short commit the bundle was built from, or ''. */
declare const __BUILDERGATE_COMMIT__: string;

// @req FR-UIDS-012
export const APP_COMMIT: string =
  typeof __BUILDERGATE_COMMIT__ === 'string' ? __BUILDERGATE_COMMIT__ : '';

/** `v0.10.16 · 9964d23f`, or `v0.10.16` without a commit. */
// @req FR-UIDS-012
export function formatBuildLabel(version: string, commit: string): string {
  return commit ? `v${version} · ${commit}` : `v${version}`;
}
