/**
 * Runs git for a terminal session.
 *
 * - No shell: execFile with an argument list the server builds.
 * - Fixed options: no optional locks (an agent may hold the index), no fsmonitor,
 *   no external diff, raw paths, no colour.
 * - A session launched with wsl.exe runs git inside WSL, in the session's own
 *   (default) distro; a Windows shell standing in a \\wsl.localhost share runs that
 *   distro's git. The shell type cannot tell: on Windows the "wsl" and "bash"
 *   settings both launch wsl.exe with shellType "bash".
 * - At most 4 git processes on the server and 2 per repository; identical requests
 *   in flight share one process.
 *
 * @req FR-GIT-001
 * @req PERF-GIT-001
 * @req SEC-GIT-001
 */

import { execFile } from 'node:child_process';
import path from 'node:path';

export type GitErrorCode =
  | 'GIT_UNAVAILABLE' | 'GIT_UNSAFE_REPO' | 'NOT_A_REPO' | 'GIT_TIMEOUT' | 'GIT_FAILED'
  | 'SESSION_NOT_FOUND' | 'NO_COMMITS' | 'SHALLOW_HISTORY' | 'COMMIT_NOT_FOUND'
  | 'PATH_OUTSIDE_REPO' | 'BASE_NOT_FOUND' | 'DIFF_TOO_LARGE' | 'INVALID_INPUT';

export class GitError extends Error {
  constructor(readonly code: GitErrorCode, readonly detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GitError';
  }
}

export type GitTarget =
  | { kind: 'native'; cwd: string }
  | { kind: 'wsl'; cwd: string; distro?: string };

export const COMMON_GIT_OPTIONS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '-c', 'core.quotepath=off',
  '-c', 'color.ui=never',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
];

const GIT_ENV = { LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } as const;

export interface GitCommand {
  file: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}

export function buildGitCommand(target: GitTarget, args: readonly string[]): GitCommand {
  const env = { ...process.env, ...GIT_ENV };
  if (target.kind === 'native') {
    return { file: 'git', args: [...COMMON_GIT_OPTIONS, ...args], cwd: target.cwd, env };
  }
  // WSLENV carries these variables into the Linux side.
  const wslenv = [process.env.WSLENV, ...Object.keys(GIT_ENV)].filter(Boolean).join(':');
  return {
    file: 'wsl.exe',
    args: [...(target.distro ? ['-d', target.distro] : []), '-e', 'git', '-C', target.cwd, ...COMMON_GIT_OPTIONS, ...args],
    env: { ...env, WSLENV: wslenv },
  };
}

const WSL_SHARE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i;

export function resolveGitTarget(input: { platform: NodeJS.Platform; launchCommand: string | null; cwd: string }): GitTarget {
  const { platform, launchCommand, cwd } = input;
  if (platform === 'win32') {
    const share = WSL_SHARE.exec(cwd);
    if (share) {
      const rest = (share[2] ?? '').replace(/\\/g, '/');
      return { kind: 'wsl', cwd: rest || '/', distro: share[1] };
    }
    const launcher = launchCommand ? path.win32.basename(launchCommand).toLowerCase() : '';
    if (launcher === 'wsl.exe' && cwd.startsWith('/')) return { kind: 'wsl', cwd };
  }
  return { kind: 'native', cwd };
}

export interface SessionGitSource {
  getLastCwd(sessionId: string): string | null;
  getSessionLaunchCommand(sessionId: string): string | null;
}

export function gitTargetForSession(sessions: SessionGitSource, sessionId: string, platform: NodeJS.Platform = process.platform): GitTarget | null {
  const cwd = sessions.getLastCwd(sessionId);
  if (!cwd) return null;
  return resolveGitTarget({ platform, launchCommand: sessions.getSessionLaunchCommand(sessionId), cwd });
}

export function classifyGitError(err: unknown): GitError {
  if (err instanceof GitError) return err;
  const e = err as { code?: unknown; killed?: boolean; signal?: unknown; stderr?: unknown; message?: string };
  const stderr = typeof e.stderr === 'string' ? e.stderr : Buffer.isBuffer(e.stderr) ? e.stderr.toString('utf8') : '';
  if (e.code === 'ENOENT' || /execvpe\(git\) failed|git: (?:command )?not found/i.test(stderr)) return new GitError('GIT_UNAVAILABLE');
  if (e.killed || e.code === 'ETIMEDOUT') return new GitError('GIT_TIMEOUT');
  if (/dubious ownership/i.test(stderr)) return new GitError('GIT_UNSAFE_REPO');
  if (/not a git repository/i.test(stderr)) return new GitError('NOT_A_REPO');
  const first = stderr.split(/\r?\n/).find((l) => l.trim()) ?? e.message ?? '';
  return new GitError('GIT_FAILED', first.trim());
}

export interface RunGitFileOptions {
  cwd?: string;
  env: Record<string, string | undefined>;
  timeout: number;
  maxBuffer: number;
  windowsHide: true;
  encoding: 'utf8' | 'buffer';
}
export type RunGitFile = (file: string, args: readonly string[], options: RunGitFileOptions) => Promise<{ stdout: string | Buffer }>;

const defaultRun: RunGitFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error) { reject(Object.assign(error, { stderr })); return; }
    resolve({ stdout });
  });
});

export interface RunGitOptions {
  /** Repository identity for the per-repository cap (the repository root, or the cwd before it is known). */
  repoKey: string;
  /** status/summary: 5 s. Everything else: 10 s. */
  quick?: boolean;
  /** Share one process with an identical request already in flight. */
  join?: boolean;
  raw?: boolean;
  maxBuffer?: number;
}

export interface GitRunnerOptions {
  run?: RunGitFile;
  maxGlobal?: number;
  maxPerRepo?: number;
}

export type RunGit = {
  (target: GitTarget, args: readonly string[], options: RunGitOptions & { raw: true }): Promise<Buffer>;
  (target: GitTarget, args: readonly string[], options: RunGitOptions): Promise<string>;
};

export function createGitRunner(options: GitRunnerOptions = {}): RunGit {
  const run = options.run ?? defaultRun;
  const maxGlobal = options.maxGlobal ?? 4;
  const maxPerRepo = options.maxPerRepo ?? 2;
  let active = 0;
  const perRepo = new Map<string, number>();
  const waiting: Array<{ repoKey: string; start: () => void }> = [];
  const inFlight = new Map<string, Promise<string | Buffer>>();

  const canStart = (repoKey: string) => active < maxGlobal && (perRepo.get(repoKey) ?? 0) < maxPerRepo;
  const pump = () => {
    for (let i = 0; i < waiting.length;) {
      if (canStart(waiting[i].repoKey)) waiting.splice(i, 1)[0].start();
      else i += 1;
    }
  };
  const acquire = (repoKey: string) => new Promise<void>((resolve) => {
    const start = () => { active += 1; perRepo.set(repoKey, (perRepo.get(repoKey) ?? 0) + 1); resolve(); };
    if (canStart(repoKey)) start(); else waiting.push({ repoKey, start });
  });
  const release = (repoKey: string) => {
    active -= 1;
    const n = (perRepo.get(repoKey) ?? 1) - 1;
    if (n > 0) perRepo.set(repoKey, n); else perRepo.delete(repoKey);
    pump();
  };

  const execute = async (target: GitTarget, args: readonly string[], opts: RunGitOptions): Promise<string | Buffer> => {
    await acquire(opts.repoKey);
    try {
      const cmd = buildGitCommand(target, args);
      const { stdout } = await run(cmd.file, cmd.args, {
        cwd: cmd.cwd,
        env: cmd.env,
        timeout: opts.quick ? 5000 : 10000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        windowsHide: true,
        encoding: opts.raw ? 'buffer' : 'utf8',
      });
      return stdout;
    } catch (err) {
      throw classifyGitError(err);
    } finally {
      release(opts.repoKey);
    }
  };

  return ((target: GitTarget, args: readonly string[], opts: RunGitOptions) => {
    if (!opts.join) return execute(target, args, opts);
    const key = JSON.stringify([target, args, !!opts.raw]);
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = execute(target, args, opts).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
  }) as RunGit;
}
