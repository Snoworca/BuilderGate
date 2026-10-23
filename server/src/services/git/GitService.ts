/**
 * Read-only git state of a terminal session's repository.
 *
 * Every call resolves the session's cwd and launch command into a git target
 * (gitRunner), so a WSL session reads its repository with WSL's git.
 *
 * @req FR-GIT-001
 * @req FR-GIT-008
 * @req PERF-GIT-001
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createGitRunner, gitTargetForSession, GitError, type GitTarget, type RunGit, type SessionGitSource } from './gitRunner.js';
import { parseStatusV2, type ParsedStatus } from './gitParsers.js';
import { createWslPathConverter } from '../../utils/wslPathConverter.js';

export type OperationKind = 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect';
export interface GitOperation { kind: OperationKind; step?: number; total?: number; branch?: string }

export interface RepoInfo { root: string; gitDir: string; commonDir: string; subdir: string }

export type GitSummary =
  | { repo: false; checkedAt: number }
  | {
    repo: true;
    root: string;
    subdir: string;
    branch: string | null;
    detached: boolean;
    head: string | null;
    upstream: string | null;
    ahead: number;
    behind: number;
    base: { ref: string; ahead: number } | null;
    operation: GitOperation | null;
    counts: ParsedStatus['counts'];
    untrackedScan: 'normal' | 'off';
    checkedAt: number;
  };

export interface GitServiceDeps {
  sessions: SessionGitSource;
  runGit?: RunGit;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Names in the git directory (MERGE_HEAD, rebase-merge, ...). */
  listGitDir?: (target: GitTarget, gitDir: string) => Promise<string[]>;
  readGitFile?: (target: GitTarget, gitDir: string, rel: string) => Promise<string | null>;
}

const SUMMARY_REUSE_MS = 1000;
const BASE_CANDIDATES = ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master'];

const shortRef = (ref: string) => ref.replace(/^refs\/(?:remotes|heads)\//, '');

export class GitService {
  private readonly runGit: RunGit;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly listGitDir: NonNullable<GitServiceDeps['listGitDir']>;
  private readonly readGitFile: NonNullable<GitServiceDeps['readGitFile']>;
  /** Repository identity per target. "Not a repository" is kept 10 s: the user may run git init. */
  private readonly repoCache = new Map<string, { info: RepoInfo | null; at: number }>();
  private readonly summaryCache = new Map<string, { at: number; value: GitSummary }>();
  private readonly summaryInFlight = new Map<string, Promise<GitSummary>>();
  private readonly timeouts = new Map<string, number>();
  private readonly baseAheadCache = new Map<string, number>();

  constructor(private readonly deps: GitServiceDeps) {
    this.runGit = deps.runGit ?? createGitRunner();
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    const toHost = createWslPathConverter({ platform: this.platform });
    const hostPath = async (target: GitTarget, p: string) => {
      if (target.kind === 'native') return p;
      if (target.distro) return `\\\\wsl.localhost\\${target.distro}${p.replace(/\//g, '\\')}`;
      return toHost(p);
    };
    this.listGitDir = deps.listGitDir ?? (async (target, gitDir) => {
      try { return await fs.readdir(await hostPath(target, gitDir)); } catch { return []; }
    });
    this.readGitFile = deps.readGitFile ?? (async (target, gitDir, rel) => {
      try { return (await fs.readFile(path.join(await hostPath(target, gitDir), rel), 'utf8')).trim(); } catch { return null; }
    });
  }

  /** The session's git target, or SESSION_NOT_FOUND. */
  target(sessionId: string): GitTarget {
    const t = gitTargetForSession(this.deps.sessions, sessionId, this.platform);
    if (!t) throw new GitError('SESSION_NOT_FOUND');
    return t;
  }

  /** Repository identity for a target; null outside any repository. */
  async repo(target: GitTarget): Promise<RepoInfo | null> {
    const key = JSON.stringify(target);
    const hit = this.repoCache.get(key);
    if (hit && (hit.info || this.now() - hit.at < 10_000)) return hit.info;
    let info: RepoInfo | null;
    try {
      const out = await this.runGit(target, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir', '--show-prefix'], { repoKey: target.cwd, quick: true, join: true });
      const [root, gitDir, commonDir, subdir = ''] = out.replace(/\r/g, '').split('\n');
      info = { root, gitDir, commonDir, subdir };
    } catch (err) {
      if (err instanceof GitError && err.code === 'NOT_A_REPO') info = null;
      else throw err;
    }
    this.repoCache.set(key, { info, at: this.now() });
    return info;
  }

  async summary(sessionId: string): Promise<GitSummary> {
    const target = this.target(sessionId);
    const key = `${sessionId}\0${JSON.stringify(target)}`;
    const cached = this.summaryCache.get(key);
    if (cached && this.now() - cached.at < SUMMARY_REUSE_MS) return cached.value;
    const pending = this.summaryInFlight.get(key);
    if (pending) return pending;
    const p = this.computeSummary(target).then((value) => {
      this.summaryCache.set(key, { at: this.now(), value });
      return value;
    }).finally(() => this.summaryInFlight.delete(key));
    this.summaryInFlight.set(key, p);
    return p;
  }

  private async computeSummary(target: GitTarget): Promise<GitSummary> {
    const info = await this.repo(target);
    const checkedAt = this.now();
    if (!info) return { repo: false, checkedAt };
    const scanOff = (this.timeouts.get(info.root) ?? 0) >= 2;
    let out: string;
    try {
      out = await this.runGit(target, ['status', '--porcelain=v2', '--branch', '-z', scanOff ? '-uno' : '-unormal', '--no-renames'], { repoKey: info.root, quick: true, join: true });
      if (!scanOff) this.timeouts.delete(info.root);
    } catch (err) {
      if (err instanceof GitError && err.code === 'GIT_TIMEOUT') this.timeouts.set(info.root, (this.timeouts.get(info.root) ?? 0) + 1);
      throw err;
    }
    const status = parseStatusV2(out);
    const operation = await this.operation(target, info);
    let branch = status.branch.head;
    let detached = status.branch.detached;
    if (operation?.kind === 'rebase' && operation.branch) { branch = operation.branch; detached = false; }
    const base = !status.branch.upstream && branch && status.branch.oid
      ? await this.baseAhead(target, info, branch, status.branch.oid)
      : null;
    return {
      repo: true,
      root: info.root,
      subdir: info.subdir,
      branch,
      detached,
      head: status.branch.oid,
      upstream: status.branch.upstream,
      ahead: status.branch.ahead,
      behind: status.branch.behind,
      base,
      operation,
      counts: status.counts,
      untrackedScan: scanOff ? 'off' : 'normal',
      checkedAt,
    };
  }

  private async operation(target: GitTarget, info: RepoInfo): Promise<GitOperation | null> {
    const names = new Set(await this.listGitDir(target, info.gitDir));
    const num = (s: string | null) => (s && /^\d+$/.test(s) ? Number(s) : undefined);
    for (const [dir, stepFile, totalFile] of [['rebase-merge', 'msgnum', 'end'], ['rebase-apply', 'next', 'last']] as const) {
      if (!names.has(dir)) continue;
      const [step, total, head] = await Promise.all([
        this.readGitFile(target, info.gitDir, `${dir}/${stepFile}`),
        this.readGitFile(target, info.gitDir, `${dir}/${totalFile}`),
        this.readGitFile(target, info.gitDir, `${dir}/head-name`),
      ]);
      return { kind: 'rebase', step: num(step), total: num(total), branch: head ? head.replace(/^refs\/heads\//, '') : undefined };
    }
    if (names.has('MERGE_HEAD')) return { kind: 'merge' };
    if (names.has('CHERRY_PICK_HEAD')) return { kind: 'cherryPick' };
    if (names.has('REVERT_HEAD')) return { kind: 'revert' };
    if (names.has('BISECT_LOG')) return { kind: 'bisect' };
    return null;
  }

  /** The base branch ref (full name) by the fixed order, or null. */
  async baseRef(target: GitTarget, info: RepoInfo): Promise<string | null> {
    const run = (args: string[]) => this.runGit(target, args, { repoKey: info.root, quick: true, join: true });
    const originHead = await run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then((s) => s.trim(), () => '');
    if (originHead) return originHead;
    const existing = (await run(['for-each-ref', '--format=%(refname)', ...BASE_CANDIDATES]).catch(() => '')).split(/\r?\n/).filter(Boolean);
    return BASE_CANDIDATES.find((c) => existing.includes(c)) ?? null;
  }

  private async baseAhead(target: GitTarget, info: RepoInfo, branch: string, head: string): Promise<{ ref: string; ahead: number } | null> {
    const ref = await this.baseRef(target, info);
    if (!ref || shortRef(ref) === branch || ref === `refs/heads/${branch}`) return null;
    const key = `${info.root}\0${head}\0${ref}`;
    let ahead = this.baseAheadCache.get(key);
    if (ahead === undefined) {
      const out = await this.runGit(target, ['rev-list', '--count', `${ref}..HEAD`], { repoKey: info.root, quick: true, join: true }).catch(() => null);
      if (out === null) return null;
      ahead = Number(out.trim()) || 0;
      if (this.baseAheadCache.size > 512) this.baseAheadCache.clear();
      this.baseAheadCache.set(key, ahead);
    }
    return { ref: shortRef(ref), ahead };
  }
}
