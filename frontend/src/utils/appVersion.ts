// FR-ARCH-007 — the running BuilderGate release version.

/** Replaced by Vite at build time (`define` in vite.config.ts) with the root package.json version. */
declare const __BUILDERGATE_VERSION__: string;

/**
 * Outside a Vite build (the node unit runner) the identifier is not defined, so this falls back
 * rather than throwing a ReferenceError.
 */
export const APP_VERSION: string =
  typeof __BUILDERGATE_VERSION__ === 'string' ? __BUILDERGATE_VERSION__ : 'dev';
