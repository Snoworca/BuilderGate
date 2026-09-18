// Issue #92. Some wave3 suites exercise code that is Windows-only by construction:
// fair-readmission-closure-v3.mjs probes NTFS reparse points through PowerShell,
// and resolveTrustedWindowsPowerShell throws 'trusted PowerShell probe requires
// Windows' on anything else. Run on Linux they did not skip -- they FAILED, with
// 'reparse guard path must be an absolute Windows path', because the harness fed
// real /mnt/c/... paths to a guard demanding C:\... .
//
// A permanently-red suite is worse than a skipped one: red is its normal state, so
// nobody looks again, and a real regression landing in the same file is
// indistinguishable from the standing failure (issue #89). This states the
// platform requirement once, out loud, and skips.
//
// This is the wave3 counterpart of frontend/tests/e2e/windowsShellGate.ts, which
// does the same for the e2e specs of issue #85.
let announced = false;

export function isWindowsHost() {
  return process.platform === 'win32';
}

/**
 * Returns node:test options that skip with a stated reason off Windows, and
 * prints the reason once per process so the skip is never silent.
 */
export function windowsOnly(detail) {
  if (isWindowsHost()) return {};
  const reason = `requires Windows (${detail}); host platform is ${process.platform}, `
    + 'where resolveTrustedWindowsPowerShell refuses by design and the reparse guard '
    + 'rejects posix paths';
  if (!announced) {
    announced = true;
    console.warn(`[windowsOnlyGate] skipping Windows-only cases: ${reason}`);
  }
  return { skip: reason };
}
