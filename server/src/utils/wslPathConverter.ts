/**
 * Linux paths a WSL shell reports, as the Windows paths the server opens.
 *
 * PERF-BGSTAB-025 AC-1: every file API call of a WSL session used to run
 * execSync('wsl.exe wslpath'), about 330 ms of the whole server stopped. The
 * conversion now runs wsl.exe asynchronously, with the path as an argument
 * rather than through a shell, and remembers each answer: a session's folder is
 * asked for many times and maps the same way every time.
 *
 * @req PERF-BGSTAB-025
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { toHostPath } from './pathValidator.js';

export type RunFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

const defaultRun: RunFile = async (file, args, options) => {
  const { stdout } = await execFileAsync(file, [...args], { ...options, encoding: 'utf8' });
  return { stdout };
};

/** Enough for every folder a session visits; the oldest answer goes first. */
const MAX_REMEMBERED = 256;

export function createWslPathConverter(options: { platform?: NodeJS.Platform; run?: RunFile } = {}): (p: string) => Promise<string> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRun;
  const remembered = new Map<string, Promise<string>>();

  return (p: string): Promise<string> => {
    if (platform !== 'win32') return Promise.resolve(p);
    if (/^[A-Za-z]:[\\/]/.test(p)) return Promise.resolve(p);
    const mounted = toHostPath(p, platform);
    if (mounted !== p) return Promise.resolve(mounted);
    if (!p.startsWith('/')) return Promise.resolve(p);

    const known = remembered.get(p);
    if (known) return known;
    const pending = run('wsl.exe', ['wslpath', '-w', p], { timeout: 3000, windowsHide: true })
      .then(({ stdout }) => stdout.trim() || p)
      .catch(() => {
        // Not remembered: wsl.exe may be starting up, and the next call should try again.
        remembered.delete(p);
        return p;
      });
    remembered.set(p, pending);
    if (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value as string);
    return pending;
  };
}
