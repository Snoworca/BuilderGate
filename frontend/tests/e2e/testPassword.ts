/**
 * #57: the E2E login password comes from the environment and has no embedded fallback.
 *
 * The literal used to sit in 22 tracked files as `BUILDERGATE_PASSWORD || '<value>'`. It was
 * never a leak in the ordinary sense -- it is a local fixture value, the stored credential in
 * config.json5 is encrypted and does not open with it, and there is nothing to rotate. But the
 * organisation's rule ("never expose API keys, tokens or passwords in code, conversation,
 * documentation or images") carves out no exception for local test values, and this repository
 * is public.
 *
 * The fallback is removed rather than replaced with a different literal. A fallback is what let
 * the value be a literal in the first place: as long as one exists, the safe path is the one
 * someone has to remember, and the value has to live somewhere in the tree for the default to
 * work. Requiring the variable costs one line of setup and removes the value entirely.
 */
export function requireTestPassword(): string {
  const password = process.env.BUILDERGATE_PASSWORD;
  if (!password) {
    throw new Error(
      'BUILDERGATE_PASSWORD is not set. E2E login needs it; there is deliberately no default '
      + '(#57). Export it before running: BUILDERGATE_PASSWORD=<local dev password> npx playwright test',
    );
  }
  return password;
}
