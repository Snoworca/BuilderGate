// FR-LOOP-003 AC-5: does a new-session loop's folder exist? The same rule session creation uses
// (SessionManager.resolveSpawnCwd): on a Windows host a WSL mount path (/mnt/<drive>/…) is the
// Windows folder it names. Any other Linux path (/home/…, /tmp) lives inside WSL and cannot be
// checked from Windows, so it is not refused here.
import { toHostPath } from '../../utils/pathValidator.js';

const WSL_MOUNT = /^\/mnt\/[a-zA-Z](?:\/|$)/u;

export async function loopDirectoryExists(
  cwd: string,
  platform: NodeJS.Platform,
  isDirectory: (path: string) => Promise<boolean>,
): Promise<boolean> {
  if (platform === 'win32' && cwd.startsWith('/') && !WSL_MOUNT.test(cwd)) return true;
  return isDirectory(toHostPath(cwd, platform));
}
