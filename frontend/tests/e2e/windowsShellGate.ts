import type { test as BaseTest } from '@playwright/test';

/**
 * Issue #85: specs that create a session with `shell: 'powershell'` fail on a
 * non-Windows host at their precondition rather than at an assertion.
 *
 * The product is not at fault. `normalizeShellForPlatform` in
 * server/src/utils/ptyPlatformPolicy.ts quietly downgrades a Windows-only shell
 * to 'auto' off win32, which is the right behaviour — but the spec never learns
 * that it happened and sits waiting for a `PS ` prompt that will never appear.
 * The run then goes red for a reason that has nothing to do with the product,
 * and, worse, produces zero evidence either way for the AC it was meant to
 * cover.
 *
 * So skip explicitly and say why, rather than leaving a silent timeout.
 * Call this at file scope, before the describe blocks.
 */

type PlaywrightTest = Pick<typeof BaseTest, 'skip'>;

export const WINDOWS_ONLY_SHELLS = ['powershell', 'wsl', 'cmd'] as const;

export function isWindowsShellHost(): boolean {
  return process.platform === 'win32';
}

let announced = false;

/**
 * Skip every test in the calling file when the host cannot run Windows-only
 * shells, and print the reason once so it is visible in plain stdout and not
 * only in the HTML report's annotations.
 */
export function requiresWindowsShell(test: PlaywrightTest, detail: string): void {
  const reason
    = `requires a Windows-only shell (${detail}); host platform is `
    + `${process.platform}, where normalizeShellForPlatform downgrades it to `
    + `'auto' and the expected prompt never appears`;

  if (!isWindowsShellHost() && !announced) {
    announced = true;
    // eslint-disable-next-line no-console
    console.warn(`[windows-shell-gate] skipping Windows-only shell specs on ${process.platform}`);
  }

  test.skip(() => !isWindowsShellHost(), reason);
}
