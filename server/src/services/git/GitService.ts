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
import {
  LOG_FORMAT, parseLfsPointer, parseLog, parseNameStatusZ, parseNumstatZ, parseRefs, parseStatusV2, parseUnifiedDiff,
  type DiffHunk, type FileArea, type FileKind, type LogCommit, type ParsedStatus, type Ref,
} from './gitParsers.js';
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
    /** Whether "compare with base" can run, and why not. */
    compare: { ref: string } | { blocked: 'noBase' | 'sameAsBase' };
    operation: GitOperation | null;
    counts: ParsedStatus['counts'];
    untrackedScan: 'normal' | 'off';
    checkedAt: number;
  };

export interface SideInput { id: string | null; size?: number; mtimeMs?: number }
export interface StatusEntry {
  path: string;
  origPath?: string;
  similarity?: number;
  kind: FileKind;
  area: FileArea;
  add: number;
  del: number;
  binary: boolean;
  inputs: { old: SideInput; new: SideInput };
}
export interface GitStatus { summary: Extract<GitSummary, { repo: true }>; files: StatusEntry[]; truncated: boolean }

export type LogScope = 'head' | 'all' | 'cmp';
export interface GitLog { commits: LogCommit[]; hasMore: boolean; shallow: boolean; noCommits: boolean; sessions: Array<{ sessionId: string; head: string }> }

export interface ChangedFile { path: string; origPath?: string; similarity?: number; kind: FileKind; add: number; del: number; binary: boolean }
export interface GitCommitDetail {
  sha: string; parents: string[]; author: string; email: string; time: number; committer: string;
  refs: Ref[]; message: string; files: ChangedFile[]; truncated: boolean;
}
export interface GitCompare {
  base: { ref: string; sha: string }; mergeBase: string; commits: string[];
  files: ChangedFile[]; add: number; del: number; fetchedAt: number | null; truncated: boolean;
}

export type DiffSource = 'commit' | 'staged' | 'unstaged' | 'untracked' | 'cmp';
export interface DiffRequest {
  src: DiffSource;
  path: string;
  origPath?: string;
  sha?: string;
  wt?: boolean;
  ignoreWs?: boolean;
  full?: boolean;
  force?: boolean;
}
export type DiffSpecial =
  | { kind: 'binary'; from: number | null; to: number | null }
  | { kind: 'large'; add: number; del: number }
  | { kind: 'mode'; from: string; to: string }
  | { kind: 'eol'; from: 'LF' | 'CRLF'; to: 'LF' | 'CRLF'; count: number }
  | { kind: 'wsOnly' }
  | { kind: 'symlink'; from: string | null; to: string | null }
  | { kind: 'lfs'; from: number | null; to: number | null }
  | { kind: 'submodule'; from: string | null; to: string | null }
  | { kind: 'encoding' }
  | { kind: 'emptyNew' };
export interface GitDiff {
  inputs: { old: SideInput; new: SideInput };
  hunks: DiffHunk[];
  gapAfter?: number;
  special?: DiffSpecial;
  truncated: boolean;
  language?: string;
  full?: { old: string; new: string };
}

export interface GitServiceDeps {
  sessions: SessionGitSource;
  runGit?: RunGit;
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Names in the git directory (MERGE_HEAD, rebase-merge, ...). */
  listGitDir?: (target: GitTarget, gitDir: string) => Promise<string[]>;
  readGitFile?: (target: GitTarget, gitDir: string, rel: string) => Promise<string | null>;
  /** All live session ids; lets "all branches" mark other sessions' HEADs. */
  listSessionIds?: () => string[];
}

const SUMMARY_REUSE_MS = 1000;
export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_DIFF_LINES = 5000;
const FORCED_DIFF_BYTES = 8 * 1024 * 1024;
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';
const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', json5: 'json', md: 'markdown', css: 'css', scss: 'css', html: 'html', py: 'python', go: 'go',
  rs: 'rust', java: 'java', kt: 'kotlin', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', sh: 'shell', ps1: 'powershell',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', xml: 'xml', vue: 'vue', svelte: 'svelte',
};
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A repository-relative path that cannot escape the repository or read as an option. */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.includes('\0') || p.startsWith('-') || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..');
}
export const MAX_FILES = 2000;
export const MAX_LOG_LIMIT = 500;
const SHA = /^[0-9a-f]{7,64}$/;
const COMMIT_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%D%x1f%B';
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
  private readonly baseRefCache = new Map<string, { ref: string | null; at: number }>();
  private readonly hostPath: (target: GitTarget, p: string) => Promise<string>;

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
    this.hostPath = hostPath;
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
    const baseFull = await this.baseRef(target, info);
    const compare = !baseFull ? { blocked: 'noBase' as const }
      : branch && (shortRef(baseFull) === branch || baseFull === `refs/heads/${branch}`) ? { blocked: 'sameAsBase' as const }
      : { ref: shortRef(baseFull) };
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
      compare,
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
    const hit = this.baseRefCache.get(info.root);
    if (hit && this.now() - hit.at < 30_000) return hit.ref;
    const ref = await this.findBaseRef(target, info);
    this.baseRefCache.set(info.root, { ref, at: this.now() });
    return ref;
  }

  private async findBaseRef(target: GitTarget, info: RepoInfo): Promise<string | null> {
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

  private async repoOrThrow(target: GitTarget): Promise<RepoInfo> {
    const info = await this.repo(target);
    if (!info) throw new GitError('NOT_A_REPO');
    return info;
  }

  private git(target: GitTarget, info: RepoInfo, args: string[], quick = false): Promise<string> {
    return this.runGit(target, args, { repoKey: info.root, quick, join: true });
  }

  /** Absolute host path of a repository-relative file, for lstat/read. */
  async worktreePath(target: GitTarget, info: RepoInfo, rel: string): Promise<string> {
    return this.hostPath(target, `${info.root.replace(/\/+$/, '')}/${rel}`);
  }

  private async worktreeInput(target: GitTarget, info: RepoInfo, rel: string): Promise<SideInput> {
    try {
      const st = await fs.lstat(await this.worktreePath(target, info, rel));
      return { id: null, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
    } catch {
      return { id: null };
    }
  }

  /** Blob ids by path: index (`ls-files -s`) or a tree (`ls-tree`). */
  private async blobIds(target: GitTarget, info: RepoInfo, source: 'index' | string, paths: string[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (!paths.length) return ids;
    const args = source === 'index' ? ['ls-files', '-s', '-z', '--', ...paths] : ['ls-tree', '-z', source, '--', ...paths];
    const out = await this.git(target, info, args).catch(() => '');
    for (const rec of out.split('\0')) {
      if (!rec) continue;
      const tab = rec.indexOf('\t');
      const meta = rec.slice(0, tab).split(' ');
      ids.set(rec.slice(tab + 1), source === 'index' ? meta[1] : meta[2]);
    }
    return ids;
  }

  private async untrackedStat(target: GitTarget, info: RepoInfo, rel: string): Promise<{ add: number; binary: boolean }> {
    try {
      const file = await this.worktreePath(target, info, rel);
      const st = await fs.lstat(file);
      if (!st.isFile() || st.size > 512 * 1024) return { add: 0, binary: false };
      const buf = await fs.readFile(file);
      if (buf.subarray(0, 8000).includes(0)) return { add: 0, binary: true };
      const text = buf.toString('utf8');
      return { add: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0, binary: false };
    } catch {
      return { add: 0, binary: false };
    }
  }

  async status(sessionId: string): Promise<GitStatus> {
    const target = this.target(sessionId);
    const summary = await this.summary(sessionId);
    if (!summary.repo) throw new GitError('NOT_A_REPO');
    const info = await this.repoOrThrow(target);
    const scan = summary.untrackedScan === 'off' ? '-uno' : '-unormal';
    const [statusOut, stagedNum, unstagedNum] = await Promise.all([
      this.git(target, info, ['status', '--porcelain=v2', '-z', scan, '-M'], true),
      this.git(target, info, ['diff', '--cached', '--numstat', '-z', '-M']).catch(() => ''),
      this.git(target, info, ['diff', '--numstat', '-z']).catch(() => ''),
    ]);
    const parsed = parseStatusV2(statusOut);
    const truncated = parsed.files.length > MAX_FILES;
    const files = parsed.files.slice(0, MAX_FILES);
    const numFor = (list: ReturnType<typeof parseNumstatZ>) => new Map(list.map((n) => [n.path, n]));
    const staged = numFor(parseNumstatZ(stagedNum));
    const unstaged = numFor(parseNumstatZ(unstagedNum));
    const paths = [...new Set(files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])))];
    const [indexIds, headIds] = await Promise.all([
      this.blobIds(target, info, 'index', paths),
      summary.head ? this.blobIds(target, info, 'HEAD', paths) : Promise.resolve(new Map<string, string>()),
    ]);
    const entries = await Promise.all(files.map(async (f): Promise<StatusEntry> => {
      const base = { path: f.path, ...(f.origPath ? { origPath: f.origPath } : {}), ...(f.similarity !== undefined ? { similarity: f.similarity } : {}), kind: f.kind, area: f.area };
      if (f.area === 'staged') {
        const n = staged.get(f.path);
        return { ...base, add: n?.add ?? 0, del: n?.del ?? 0, binary: n?.binary ?? false,
          inputs: { old: { id: headIds.get(f.origPath ?? f.path) ?? null }, new: { id: indexIds.get(f.path) ?? null } } };
      }
      if (f.area === 'unstaged') {
        const n = unstaged.get(f.path);
        return { ...base, add: n?.add ?? 0, del: n?.del ?? 0, binary: n?.binary ?? false,
          inputs: { old: { id: indexIds.get(f.path) ?? null }, new: await this.worktreeInput(target, info, f.path) } };
      }
      if (f.area === 'untracked') {
        const u = await this.untrackedStat(target, info, f.path);
        return { ...base, add: u.add, del: 0, binary: u.binary, inputs: { old: { id: null }, new: await this.worktreeInput(target, info, f.path) } };
      }
      return { ...base, add: 0, del: 0, binary: false, inputs: { old: { id: null }, new: await this.worktreeInput(target, info, f.path) } };
    }));
    return { summary, files: entries, truncated };
  }

  private async revsFor(target: GitTarget, info: RepoInfo, scope: LogScope): Promise<string[]> {
    if (scope === 'all') return ['--branches', '--remotes', '--tags', 'HEAD'];
    if (scope === 'cmp') {
      const base = await this.baseRef(target, info);
      if (!base) throw new GitError('BASE_NOT_FOUND');
      return ['HEAD', base];
    }
    return ['HEAD'];
  }

  async log(sessionId: string, opts: { scope: LogScope; limit?: number; after?: string }): Promise<GitLog> {
    const target = this.target(sessionId);
    const info = await this.repoOrThrow(target);
    const limit = Math.max(1, Math.min(MAX_LOG_LIMIT, Math.floor(opts.limit ?? 200)));
    if (opts.after !== undefined && !SHA.test(opts.after)) throw new GitError('INVALID_INPUT', 'after');
    const shallow = (await this.git(target, info, ['rev-parse', '--is-shallow-repository'], true).catch(() => 'false')).trim() === 'true';
    const hasHead = await this.git(target, info, ['rev-parse', '-q', '--verify', 'HEAD'], true).then(() => true, () => false);
    if (!hasHead) return { commits: [], hasMore: false, shallow, noCommits: true, sessions: [] };
    const revs = await this.revsFor(target, info, opts.scope);
    let skip = 0;
    if (opts.after) {
      const order = (await this.git(target, info, ['rev-list', '--topo-order', ...revs])).split(/\r?\n/);
      const i = order.findIndex((sha) => sha.startsWith(opts.after!));
      if (i < 0) throw new GitError('COMMIT_NOT_FOUND');
      skip = i + 1;
    }
    const out = await this.git(target, info, ['log', '--topo-order', '--decorate=full', `--format=${LOG_FORMAT}`, `--skip=${skip}`, `-n${limit + 1}`, ...revs, '--']);
    const commits = parseLog(out);
    const sessions = opts.scope === 'all' ? await this.otherSessionHeads(sessionId, info) : [];
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit, shallow, noCommits: false, sessions };
  }

  private async changedFiles(target: GitTarget, info: RepoInfo, range: string[]): Promise<{ files: ChangedFile[]; truncated: boolean }> {
    const [ns, num] = await Promise.all([
      this.git(target, info, [...range.slice(0, 1), '-r', '-z', '-M', '--name-status', ...range.slice(1), '--']),
      this.git(target, info, [...range.slice(0, 1), '-r', '-z', '-M', '--numstat', ...range.slice(1), '--']),
    ]);
    const nums = new Map(parseNumstatZ(num).map((n) => [n.path, n]));
    const all = parseNameStatusZ(ns).map((f): ChangedFile => {
      const n = nums.get(f.path);
      return { ...f, add: n?.add ?? 0, del: n?.del ?? 0, binary: n?.binary ?? false };
    });
    return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
  }

  async commit(sessionId: string, sha: string): Promise<GitCommitDetail> {
    if (!SHA.test(sha)) throw new GitError('INVALID_INPUT', 'sha');
    const target = this.target(sessionId);
    const info = await this.repoOrThrow(target);
    let head: string;
    try {
      head = await this.git(target, info, ['show', '-s', '--decorate=full', `--format=${COMMIT_FORMAT}`, sha, '--']);
    } catch (err) {
      if (err instanceof GitError && err.code === 'GIT_FAILED') throw new GitError('COMMIT_NOT_FOUND');
      throw err;
    }
    const [full, parents, author, email, time, committer, d, ...body] = head.split('\x1f');
    const parentList = parents ? parents.split(' ').filter(Boolean) : [];
    const range = parentList.length ? ['diff', `${full}^1`, full] : ['diff-tree', '--no-commit-id', '--root', full];
    const { files, truncated } = await this.changedFiles(target, info, range);
    return { sha: full, parents: parentList, author, email, time: Number(time), committer, refs: parseRefs(d ?? ''), message: body.join('\x1f').replace(/\s+$/, ''), files, truncated };
  }

  async compare(sessionId: string, opts: { wt: boolean }): Promise<GitCompare> {
    const target = this.target(sessionId);
    const info = await this.repoOrThrow(target);
    const baseFull = await this.baseRef(target, info);
    if (!baseFull) throw new GitError('BASE_NOT_FOUND');
    const current = (await this.git(target, info, ['symbolic-ref', '-q', '--short', 'HEAD'], true).catch(() => '')).trim();
    if (current && (shortRef(baseFull) === current || baseFull === `refs/heads/${current}`)) throw new GitError('BASE_NOT_FOUND', 'sameAsBase');
    const baseSha = (await this.git(target, info, ['rev-parse', baseFull], true)).trim();
    const mergeBase = (await this.git(target, info, ['merge-base', baseFull, 'HEAD']).catch(() => '')).trim();
    if (!mergeBase) throw new GitError('SHALLOW_HISTORY');
    const commits = (await this.git(target, info, ['rev-list', `${mergeBase}..HEAD`])).split(/\r?\n/).filter(Boolean);
    const range = opts.wt ? ['diff', mergeBase] : ['diff', mergeBase, 'HEAD'];
    const { files, truncated } = await this.changedFiles(target, info, range);
    if (opts.wt) {
      const untracked = parseStatusV2(await this.git(target, info, ['status', '--porcelain=v2', '-z', '-unormal'], true)).files.filter((f) => f.area === 'untracked');
      for (const u of untracked) {
        if (files.length >= MAX_FILES) break;
        const st = await this.untrackedStat(target, info, u.path);
        files.push({ kind: 'A', path: u.path, add: st.add, del: 0, binary: st.binary });
      }
    }
    let fetchedAt: number | null = null;
    try {
      const commonAbs = info.commonDir.startsWith('/') || /^[A-Za-z]:/.test(info.commonDir) ? info.commonDir : `${info.root}/${info.commonDir}`;
      fetchedAt = Math.floor((await fs.stat(path.join(await this.hostPath(target, commonAbs), 'FETCH_HEAD'))).mtimeMs);
    } catch { /* never fetched */ }
    return {
      base: { ref: shortRef(baseFull), sha: baseSha }, mergeBase, commits, files,
      add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0), fetchedAt, truncated,
    };
  }

  private commonKey(info: RepoInfo): string {
    const abs = info.commonDir.startsWith('/') || /^[A-Za-z]:/.test(info.commonDir) ? info.commonDir : `${info.root}/${info.commonDir}`;
    return path.posix.normalize(abs.replace(/\\/g, '/')).toLowerCase();
  }

  /** Other sessions whose repository shares this one's common git directory (worktrees included). */
  private async otherSessionHeads(sessionId: string, info: RepoInfo): Promise<Array<{ sessionId: string; head: string }>> {
    const ids = this.deps.listSessionIds?.() ?? [];
    const mine = this.commonKey(info);
    const result: Array<{ sessionId: string; head: string }> = [];
    for (const id of ids) {
      if (id === sessionId) continue;
      try {
        const t = this.target(id);
        const other = await this.repo(t);
        if (!other || this.commonKey(other) !== mine) continue;
        const head = (await this.git(t, other, ['rev-parse', '-q', '--verify', 'HEAD'], true)).trim();
        if (head) result.push({ sessionId: id, head });
      } catch { /* a session without a readable repository is skipped */ }
    }
    return result;
  }

  private async emptyTree(target: GitTarget, info: RepoInfo): Promise<string> {
    const fmt = (await this.git(target, info, ['rev-parse', '--show-object-format'], true).catch(() => 'sha1')).trim();
    return fmt === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
  }

  /** The two tree-ish sides of a source; null for the index or the working tree. */
  private async sides(target: GitTarget, info: RepoInfo, req: DiffRequest): Promise<{ range: string[]; oldTree: string | 'index' | null; newTree: string | 'index' | 'worktree' }> {
    switch (req.src) {
      case 'commit': {
        const sha = req.sha!;
        const parent = await this.git(target, info, ['rev-parse', '-q', '--verify', `${sha}^1`], true).then((s) => s.trim(), () => '');
        const oldTree = parent || await this.emptyTree(target, info);
        return { range: [oldTree, sha], oldTree: parent || null, newTree: sha };
      }
      case 'staged': {
        const head = await this.git(target, info, ['rev-parse', '-q', '--verify', 'HEAD'], true).then((s) => s.trim(), () => '');
        return { range: ['--cached', head || await this.emptyTree(target, info)], oldTree: head || null, newTree: 'index' };
      }
      case 'unstaged':
        return { range: [], oldTree: 'index', newTree: 'worktree' };
      case 'cmp': {
        const base = await this.baseRef(target, info);
        if (!base) throw new GitError('BASE_NOT_FOUND');
        const mb = (await this.git(target, info, ['merge-base', base, 'HEAD']).catch(() => '')).trim();
        if (!mb) throw new GitError('SHALLOW_HISTORY');
        return req.wt ? { range: [mb], oldTree: mb, newTree: 'worktree' } : { range: [mb, 'HEAD'], oldTree: mb, newTree: 'HEAD' };
      }
      default:
        return { range: [], oldTree: null, newTree: 'worktree' };
    }
  }

  private async sideInput(target: GitTarget, info: RepoInfo, tree: string | null, rel: string): Promise<SideInput> {
    if (tree === null) return { id: null };
    if (tree === 'worktree') return this.worktreeInput(target, info, rel);
    const ids = await this.blobIds(target, info, tree === 'index' ? 'index' : tree, [rel]);
    return { id: ids.get(rel) ?? null };
  }

  private async sideText(target: GitTarget, info: RepoInfo, input: SideInput, tree: string | null, rel: string): Promise<Buffer | null> {
    if (tree === 'worktree') {
      try {
        const file = await this.worktreePath(target, info, rel);
        const st = await fs.lstat(file);
        if (st.isSymbolicLink()) return Buffer.from(await fs.readlink(file));
        return st.size > MAX_DIFF_BYTES ? null : await fs.readFile(file);
      } catch { return null; }
    }
    if (!input.id) return tree === null ? Buffer.alloc(0) : null;
    const size = Number((await this.git(target, info, ['cat-file', '-s', input.id], true).catch(() => '0')).trim());
    if (size > MAX_DIFF_BYTES) return null;
    return this.runGit(target, ['cat-file', 'blob', input.id], { repoKey: info.root, raw: true }).catch(() => null);
  }

  async diff(sessionId: string, req: DiffRequest): Promise<GitDiff> {
    if (!isSafeRepoPath(req.path) || (req.origPath !== undefined && !isSafeRepoPath(req.origPath))) throw new GitError('PATH_OUTSIDE_REPO');
    if (req.src === 'commit' && !(req.sha && SHA.test(req.sha))) throw new GitError('INVALID_INPUT', 'sha');
    const target = this.target(sessionId);
    const info = await this.repoOrThrow(target);
    const ext = req.path.includes('.') ? req.path.slice(req.path.lastIndexOf('.') + 1).toLowerCase() : '';
    const language = LANGUAGES[ext];
    if (req.src === 'untracked') return this.untrackedDiff(target, info, req, language);

    const { range, oldTree, newTree } = await this.sides(target, info, req);
    const oldRel = req.origPath ?? req.path;
    const [oldIn, newIn] = await Promise.all([this.sideInput(target, info, oldTree, oldRel), this.sideInput(target, info, newTree, req.path)]);
    const inputs = { old: oldIn, new: newIn };
    const pathspec = req.origPath ? ['--', req.origPath, req.path] : ['--', req.path];
    const base = ['diff', '-U3', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];
    const runDiff = (extra: string[]) => this.runGit(target, [...base, ...extra, ...range, ...pathspec], {
      repoKey: info.root, raw: true, maxBuffer: (req.force ? FORCED_DIFF_BYTES : MAX_DIFF_BYTES) + 1,
    }).catch((err) => {
      if (err instanceof GitError && /maxBuffer/i.test(err.detail)) return null;
      throw err;
    });
    const raw = await runDiff(req.ignoreWs ? ['-w'] : []);
    if (raw === null) return { inputs, hunks: [], special: { kind: 'large', add: 0, del: 0 }, truncated: true, language };
    let text: string;
    try { text = UTF8.decode(raw); } catch { return { inputs, hunks: [], special: { kind: 'encoding' }, truncated: false, language }; }
    const file = parseUnifiedDiff(text)[0];
    if (!file) {
      if (req.ignoreWs && (await runDiff([]))?.length) return { inputs, hunks: [], special: { kind: 'wsOnly' }, truncated: false, language };
      return { inputs, hunks: [], truncated: false, language };
    }
    const changed = (k: '+' | '-') => file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.k === k).length, 0);
    if (file.binary) {
      const size = async (inp: SideInput, tree: string | null, rel: string) => {
        if (tree === 'worktree') return inp.size ?? null;
        if (!inp.id) return tree === null ? 0 : null;
        return Number((await this.git(target, info, ['cat-file', '-s', inp.id], true).catch(() => '')).trim()) || null;
      };
      return { inputs, hunks: [], special: { kind: 'binary', from: await size(oldIn, oldTree, oldRel), to: await size(newIn, newTree, req.path) }, truncated: false, language };
    }
    if (file.mode === '160000') {
      const sub = (k: '+' | '-') => file.hunks.flatMap((h) => h.lines).find((l) => l.k === k)?.t.replace(/^Subproject commit /, '').slice(0, 12) ?? null;
      return { inputs, hunks: [], special: { kind: 'submodule', from: sub('-'), to: sub('+') }, truncated: false, language };
    }
    if (file.mode === '120000' || file.oldMode === '120000' || file.newMode === '120000') {
      const t = (k: '+' | '-') => file.hunks.flatMap((h) => h.lines).find((l) => l.k === k)?.t ?? null;
      return { inputs, hunks: [], special: { kind: 'symlink', from: t('-'), to: t('+') }, truncated: false, language };
    }
    if (!file.hunks.length) {
      if (file.oldMode && file.newMode && file.oldMode !== file.newMode) return { inputs, hunks: [], special: { kind: 'mode', from: file.oldMode, to: file.newMode }, truncated: false, language };
      if (file.isNew) return { inputs, hunks: [], special: { kind: 'emptyNew' }, truncated: false, language };
      return { inputs, hunks: [], truncated: false, language };
    }
    const sideOf = (k: '+' | '-') => file.hunks.flatMap((h) => h.lines).filter((l) => l.k !== (k === '+' ? '-' : '+')).map((l) => l.t).join('\n') + '\n';
    const lfsOld = parseLfsPointer(sideOf('-'));
    const lfsNew = parseLfsPointer(sideOf('+'));
    if (lfsOld || lfsNew) return { inputs, hunks: [], special: { kind: 'lfs', from: lfsOld?.size ?? null, to: lfsNew?.size ?? null }, truncated: false, language };
    if (!req.force && (raw.length > MAX_DIFF_BYTES || changed('+') + changed('-') > MAX_DIFF_LINES)) {
      return { inputs, hunks: [], special: { kind: 'large', add: changed('+'), del: changed('-') }, truncated: true, language };
    }
    if (!req.ignoreWs && !req.force) {
      const crlf = await runDiff(['--ignore-cr-at-eol']);
      if (crlf !== null && crlf.length === 0) {
        const plus = file.hunks.flatMap((h) => h.lines).filter((l) => l.k === '+');
        const toCrlf = plus.some((l) => l.t.endsWith('\r'));
        return { inputs, hunks: [], special: { kind: 'eol', from: toCrlf ? 'LF' : 'CRLF', to: toCrlf ? 'CRLF' : 'LF', count: plus.length }, truncated: false, language };
      }
    }
    const newText = await this.sideText(target, info, newIn, newTree, req.path);
    let gapAfter: number | undefined;
    if (newText) {
      const s = newText.toString('utf8');
      const total = s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;
      const last = file.hunks[file.hunks.length - 1];
      gapAfter = Math.max(0, total - (last.newStart + last.newLines - 1));
    }
    const result: GitDiff = { inputs, hunks: file.hunks, truncated: false, language, ...(gapAfter !== undefined ? { gapAfter } : {}) };
    if (req.full) {
      const oldText = await this.sideText(target, info, oldIn, oldTree, oldRel);
      if (!oldText || !newText) throw new GitError('DIFF_TOO_LARGE');
      result.full = { old: oldText.toString('utf8'), new: newText.toString('utf8') };
    }
    return result;
  }

  private async untrackedDiff(target: GitTarget, info: RepoInfo, req: DiffRequest, language?: string): Promise<GitDiff> {
    const inputs = { old: { id: null } as SideInput, new: await this.worktreeInput(target, info, req.path) };
    const file = await this.worktreePath(target, info, req.path);
    let st;
    try { st = await fs.lstat(file); } catch { return { inputs, hunks: [], truncated: false, language }; }
    if (st.isSymbolicLink()) return { inputs, hunks: [], special: { kind: 'symlink', from: null, to: await fs.readlink(file).catch(() => null) }, truncated: false, language };
    if (st.size === 0) return { inputs, hunks: [], special: { kind: 'emptyNew' }, truncated: false, language };
    if (st.size > (req.force ? FORCED_DIFF_BYTES : MAX_DIFF_BYTES)) return { inputs, hunks: [], special: { kind: 'large', add: 0, del: 0 }, truncated: true, language };
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { inputs, hunks: [], special: { kind: 'binary', from: null, to: st.size }, truncated: false, language };
    let text: string;
    try { text = UTF8.decode(buf); } catch { return { inputs, hunks: [], special: { kind: 'encoding' }, truncated: false, language }; }
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    const rows = body.split('\n');
    if (!req.force && rows.length > MAX_DIFF_LINES) return { inputs, hunks: [], special: { kind: 'large', add: rows.length, del: 0 }, truncated: true, language };
    const hunk: DiffHunk = {
      oldStart: 0, oldLines: 0, newStart: 1, newLines: rows.length, header: `@@ -0,0 +1,${rows.length} @@`,
      lines: rows.map((t, i) => ({ k: '+' as const, o: null, n: i + 1, t })),
    };
    return { inputs, hunks: [hunk], truncated: false, language, gapAfter: 0, ...(req.full ? { full: { old: '', new: text } } : {}) };
  }
}
