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
import type { RepoWatch, WatchRepo } from './gitRepoWatcher.js';
import { createGitRunner, gitTargetForSession, GitError, type GitTarget, type RunGit, type SessionGitSource } from './gitRunner.js';
import {
  LOG_FORMAT, parseLfsPointer, parseLog, parseNameStatusZ, parseNumstatZ, parseRefs, parseStatusV2, parseUnifiedDiff,
  type DiffHunk, type FileArea, type FileKind, type LogCommit, type ParsedStatus, type Ref, type StatusFile,
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
  /** PERF-GIT-001 AC-10: a file watch that lets a quiet repository skip git (none by default). */
  watchRepo?: WatchRepo;
}

/** `generation` goes up each time a change is taken; a status started before that cannot be reused. */
interface WatchEntry { watch: RepoWatch; usedAt: number; generation: number; results: Map<string, { summary: GitSummary; gitAt: number }> }

const SUMMARY_REUSE_MS = 1000;
/** PERF-GIT-001 AC-10: a quiet file watch stands in for git at most this long. */
const WATCH_TRUST_MS = 30_000;
const MAX_WATCHED_REPOS = 32;
/** A repository no summary asked about for this long has its watch closed (it holds the folder open). */
const WATCH_IDLE_MS = 10 * 60_000;
const MAX_KEPT_STATUS = 64;
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

/** A file's text, or null when it does not exist. Any other error (busy, denied) is thrown. */
async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw err;
  }
}

/** A repository-relative path that cannot escape the repository or read as an option. */
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.includes('\0') || p.startsWith('-') || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..');
}
export const MAX_FILES = 2000;
export const MAX_LOG_LIMIT = 500;
const SHA = /^[0-9a-f]{7,64}$/;
const COMMIT_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%D%x1f%B';
const INDEX_REFRESH_AFTER_MS = 150;
const INDEX_REFRESH_INTERVAL_MS = 60_000;

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
  private readonly indexRefreshedAt = new Map<string, number>();
  /** The last summary's status per target, for status() and diff inputs (PERF-GIT-001 AC-7). */
  private readonly statusCache = new Map<string, { checkedAt: number; parsed: ReturnType<typeof parseStatusV2> }>();
  private readonly summaryCache = new Map<string, { at: number; value: GitSummary }>();
  /** By repository root: one watch, and per target the last summary git produced while it watched. */
  private readonly watches = new Map<string, WatchEntry>();
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
    const targetKey = JSON.stringify(target);
    const watched = this.watchFor(target, info);
    if (watched) {
      // takeChanged() runs before status, so an event during this status marks the next summary.
      // A change makes every folder of the repository ask git again, since the mark is shared.
      if (watched.watch.takeChanged()) { watched.results.clear(); watched.generation += 1; }
      const kept = watched.results.get(targetKey);
      const status = this.statusCache.get(targetKey);
      if (kept && status && checkedAt - kept.gitAt < WATCH_TRUST_MS) {
        status.checkedAt = checkedAt;
        return { ...kept.summary, checkedAt };
      }
      watched.results.delete(targetKey); // a status that fails below leaves nothing to reuse
    }
    const generation = watched?.generation ?? 0;
    const scanOff = (this.timeouts.get(info.root) ?? 0) >= 2;
    // PERF-GIT-001: every git process costs tens of milliseconds to start on Windows, so the
    // base lookup and the git directory listing run alongside status rather than after it.
    const baseLookup = this.baseRef(target, info);
    baseLookup.catch(() => {});
    const operationLookup = this.operation(target, info);
    operationLookup.catch(() => {});
    let out: string;
    const statusStarted = this.now();
    const timing = { ms: -1 };
    try {
      out = await this.runGit(target, ['status', '--porcelain=v2', '--branch', '-z', scanOff ? '-uno' : '-unormal', '-M'], { repoKey: info.root, quick: true, join: true, timing });
      // The run itself, not the wait for a free slot: under load the wait alone passes 150 ms.
      const took = timing.ms >= 0 ? timing.ms : this.now() - statusStarted;
      if (took > INDEX_REFRESH_AFTER_MS) this.refreshIndexSoon(target, info);
      if (!scanOff) this.timeouts.delete(info.root);
    } catch (err) {
      if (err instanceof GitError && err.code === 'GIT_TIMEOUT') this.timeouts.set(info.root, (this.timeouts.get(info.root) ?? 0) + 1);
      throw err;
    }
    const status = parseStatusV2(out);
    // PERF-GIT-001 AC-7: the file list and the first diff reuse this status (with its blob ids).
    this.statusCache.delete(targetKey);
    this.statusCache.set(targetKey, { checkedAt, parsed: status });
    for (const k of this.statusCache.keys()) {
      if (this.statusCache.size <= MAX_KEPT_STATUS) break;
      this.statusCache.delete(k);
    }
    const operation = await operationLookup;
    let branch = status.branch.head;
    let detached = status.branch.detached;
    if (operation?.kind === 'rebase' && operation.branch) { branch = operation.branch; detached = false; }
    const base = !status.branch.upstream && branch && status.branch.oid
      ? await this.baseAhead(target, info, branch, status.branch.oid, await baseLookup)
      : null;
    const baseFull = await baseLookup;
    const compare = !baseFull ? { blocked: 'noBase' as const }
      : branch && (shortRef(baseFull) === branch || baseFull === `refs/heads/${branch}`) ? { blocked: 'sameAsBase' as const }
      : { ref: shortRef(baseFull) };
    const summary: GitSummary = {
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
    // Only when no change was taken (by any session or folder) since this status started.
    if (watched && watched.generation === generation) watched.results.set(targetKey, { summary, gitAt: checkedAt });
    return summary;
  }

  /** Closes idle watches even when no summary is asked any more (a watch holds the folder open). */
  private watchSweep: ReturnType<typeof setInterval> | null = null;
  private scheduleWatchSweep(): void {
    if (this.watchSweep) return;
    this.watchSweep = setInterval(() => {
      const now = this.now();
      for (const [k, old] of this.watches) {
        if (now - old.usedAt > WATCH_IDLE_MS) { old.watch.close(); this.watches.delete(k); }
      }
      if (!this.watches.size && this.watchSweep) { clearInterval(this.watchSweep); this.watchSweep = null; }
    }, 60_000);
    this.watchSweep.unref?.();
  }

  /** The repository's file watch, started (or restarted after a failure) before git runs. */
  private watchFor(target: GitTarget, info: RepoInfo): WatchEntry | null {
    if (!this.deps.watchRepo) return null;
    const now = this.now();
    for (const [k, old] of this.watches) {
      if (now - old.usedAt > WATCH_IDLE_MS) { old.watch.close(); this.watches.delete(k); }
    }
    const key = `${target.kind}\0${target.kind === 'wsl' ? target.distro ?? '' : ''}\0${info.root}`;
    let entry = this.watches.get(key);
    if (entry && entry.watch.failed()) { entry.watch.close(); this.watches.delete(key); entry = undefined; }
    if (entry) {
      this.watches.delete(key); this.watches.set(key, entry); // most recently used last
      entry.usedAt = now;
      return entry;
    }
    const watch = this.deps.watchRepo(target, { root: info.root, gitDir: info.gitDir, commonDir: this.commonDirOf(target, info) });
    if (!watch) return null;
    entry = { watch, usedAt: now, generation: 0, results: new Map() };
    this.scheduleWatchSweep();
    this.watches.set(key, entry);
    for (const [k, old] of this.watches) {
      if (this.watches.size <= MAX_WATCHED_REPOS) break;
      old.watch.close(); this.watches.delete(k);
    }
    return entry;
  }

  /**
   * PERF-GIT-001 AC-5 (threshold 150 ms, measured: a racy index made status ~4x slower): status runs with --no-optional-locks so it never takes the index lock
   * from the user's or an agent's git, which also means it never writes back what it learned.
   * When another git (WSL's, say) last wrote the index, every file's stat data looks stale
   * and each status re-reads every file: 3 s per summary in a 6,000-file repository. One
   * explicit refresh fixes that until the next foreign write. It is skipped while another git
   * holds index.lock, runs at most once a minute per repository, and never fails a summary.
   */
  private refreshIndexSoon(target: GitTarget, info: RepoInfo): void {
    const last = this.indexRefreshedAt.get(info.root);
    if (last !== undefined && this.now() - last < INDEX_REFRESH_INTERVAL_MS) return;
    this.indexRefreshedAt.set(info.root, this.now());
    void (async () => {
      try {
        const lock = path.join(await this.hostPath(target, info.gitDir), 'index.lock');
        if (await fs.access(lock).then(() => true, () => false)) return;
        await this.runGit(target, ['update-index', '-q', '--refresh'], { repoKey: info.root });
      } catch {
        // Unmerged or locked index: the next slow status tries again after the interval.
      }
    })();
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

  /** Absolute git common dir (rev-parse reports it relative to the cwd when it can). */
  private commonDirOf(target: GitTarget, info: RepoInfo): string {
    if (info.commonDir.startsWith('/') || /^[A-Za-z]:/.test(info.commonDir)) return info.commonDir;
    return target.kind === 'native' ? path.resolve(target.cwd, info.commonDir) : path.posix.resolve(target.cwd, info.commonDir);
  }

  /**
   * PERF-GIT-001 AC-6: refs read from the files git keeps them in, so no process is started:
   * loose refs, packed-refs, symbolic refs (HEAD, origin/HEAD). null when the repository uses
   * reftable or a file cannot be read; the caller then asks git.
   */
  private async refReader(target: GitTarget, info: RepoInfo): Promise<((ref: string) => Promise<string | null>) | null> {
    try {
      const common = await this.hostPath(target, this.commonDirOf(target, info));
      const gitDir = await this.hostPath(target, info.gitDir);
      if (await fs.access(path.join(common, 'reftable')).then(() => true, () => false)) return null;
      const readPacked = async () => {
        const packed = new Map<string, string>();
        for (const line of ((await readIfExists(path.join(common, 'packed-refs'))) ?? '').split(/\r?\n/)) {
          const m = /^([0-9a-f]{40,64}) (refs\/\S+)$/.exec(line);
          if (m) packed.set(m[2], m[1]);
        }
        return packed;
      };
      let packed = await readPacked();
      const resolve = async (ref: string, depth = 0): Promise<string | null> => {
        if (depth > 5) return null;
        // HEAD and other per-worktree refs live in the git dir; shared refs in the common dir.
        const dirs = ref.startsWith('refs/') ? [common] : [gitDir, common];
        for (const dir of dirs) {
          const text = (await readIfExists(path.join(dir, ...ref.split('/'))))?.trim() ?? null;
          if (text === null) continue;
          if (text.startsWith('ref: ')) return resolve(text.slice(5).trim(), depth + 1);
          if (/^[0-9a-f]{40,64}$/.test(text)) return text;
          throw new Error(`unreadable ref ${ref}`); // half-written: ask git
        }
        // pack-refs may have moved the ref after packed-refs was read: read it once more.
        if (!packed.has(ref)) packed = await readPacked();
        return packed.get(ref) ?? null;
      };
      return resolve;
    } catch {
      return null;
    }
  }

  /** The target of a symbolic ref file (e.g. refs/remotes/origin/HEAD), or null. */
  private async symbolicRef(target: GitTarget, info: RepoInfo, ref: string): Promise<string | null> {
    const common = await this.hostPath(target, this.commonDirOf(target, info));
    const text = (await readIfExists(path.join(common, ...ref.split('/'))))?.trim() ?? '';
    return text.startsWith('ref: ') ? text.slice(5).trim() : null;
  }

  /** HEAD's commit id, or null for an unborn branch; from the files when possible. */
  private async headOid(target: GitTarget, info: RepoInfo): Promise<string | null> {
    const read = await this.refReader(target, info);
    if (read) {
      try { return await read('HEAD'); } catch { /* a ref file could not be read: ask git */ }
    }
    return this.git(target, info, ['rev-parse', '-q', '--verify', 'HEAD'], true).then((s) => s.trim() || null, () => null);
  }

  private async findBaseRef(target: GitTarget, info: RepoInfo): Promise<string | null> {
    const read = await this.refReader(target, info);
    if (read) {
      try {
        const originHead = await this.symbolicRef(target, info, 'refs/remotes/origin/HEAD');
        if (originHead && await read(originHead)) return originHead;
        for (const candidate of BASE_CANDIDATES) if (await read(candidate)) return candidate;
        return null;
      } catch {
        // a ref file could not be read: ask git below
      }
    }
    // One git call: origin/HEAD's target (%(symref)) if it is set, else the first candidate that exists.
    const out = await this.runGit(target, ['for-each-ref', '--format=%(refname) %(symref)', 'refs/remotes/origin/HEAD', ...BASE_CANDIDATES], { repoKey: info.root, quick: true, join: true }).catch(() => '');
    const refs = new Map(out.split(/\r?\n/).filter(Boolean).map((line) => { const [name, sym = ''] = line.split(' '); return [name, sym] as const; }));
    const originHead = refs.get('refs/remotes/origin/HEAD');
    if (originHead) return originHead;
    return BASE_CANDIDATES.find((c) => refs.has(c)) ?? null;
  }


  private async baseAhead(target: GitTarget, info: RepoInfo, branch: string, head: string, ref: string | null): Promise<{ ref: string; ahead: number } | null> {
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

  /** The status the current summary was built from (same checkedAt), if still kept. */
  private latestStatus(target: GitTarget, summary: GitSummary): ReturnType<typeof parseStatusV2> | null {
    const kept = this.statusCache.get(JSON.stringify(target));
    return kept && summary.repo && kept.checkedAt === summary.checkedAt ? kept.parsed : null;
  }

  async status(sessionId: string): Promise<GitStatus> {
    const target = this.target(sessionId);
    const summary = await this.summary(sessionId);
    if (!summary.repo) throw new GitError('NOT_A_REPO');
    const info = await this.repoOrThrow(target);
    const scan = summary.untrackedScan === 'off' ? '-uno' : '-unormal';
    const parsed = this.latestStatus(target, summary)
      ?? parseStatusV2(await this.git(target, info, ['status', '--porcelain=v2', '-z', scan, '-M'], true));
    const truncated = parsed.files.length > MAX_FILES;
    const files = parsed.files.slice(0, MAX_FILES);
    // PERF-GIT-001 AC-7: numstat only for the paths status reported, so git does not stat the
    // whole working tree again; no process at all for an empty side.
    const numstat = async (area: 'staged' | 'unstaged') => {
      const paths = [...new Set(files.filter((f) => f.area === area).flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])))];
      if (!paths.length) return '';
      const spec = paths.join('').length < 16_000 ? ['--', ...paths] : [];
      const args = area === 'staged' ? ['diff', '--cached', '--numstat', '-z', '-M'] : ['diff', '--numstat', '-z'];
      return this.git(target, info, ['--literal-pathspecs', ...args, ...spec]).catch(() => '');
    };
    const [stagedNum, unstagedNum] = await Promise.all([numstat('staged'), numstat('unstaged')]);
    const numFor = (list: ReturnType<typeof parseNumstatZ>) => new Map(list.map((n) => [n.path, n]));
    const staged = numFor(parseNumstatZ(stagedNum));
    const unstaged = numFor(parseNumstatZ(unstagedNum));
    const entries = await Promise.all(files.map(async (f): Promise<StatusEntry> => {
      const base = { path: f.path, ...(f.origPath ? { origPath: f.origPath } : {}), ...(f.similarity !== undefined ? { similarity: f.similarity } : {}), kind: f.kind, area: f.area };
      if (f.area === 'staged') {
        const n = staged.get(f.path);
        return { ...base, add: n?.add ?? 0, del: n?.del ?? 0, binary: n?.binary ?? false,
          inputs: { old: { id: f.headId ?? null }, new: { id: f.indexId ?? null } } };
      }
      if (f.area === 'unstaged') {
        const n = unstaged.get(f.path);
        return { ...base, add: n?.add ?? 0, del: n?.del ?? 0, binary: n?.binary ?? false,
          inputs: { old: { id: f.indexId ?? null }, new: await this.worktreeInput(target, info, f.path) } };
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
    // PERF-GIT-001 AC-7: from the files (.git/shallow, HEAD), not two rev-parse processes.
    const common = await this.hostPath(target, this.commonDirOf(target, info));
    const [shallow, hasHead] = await Promise.all([
      fs.access(path.join(common, 'shallow')).then(() => true, () => false),
      this.headOid(target, info).then((oid) => oid !== null),
    ]);
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
        const head = (await this.headOid(target, info)) ?? '';
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

  /** The status record of a working-tree file from a summary at most 5 s old. */
  private recentStatusRecord(target: GitTarget, req: DiffRequest): StatusFile | undefined {
    if (req.src !== 'staged' && req.src !== 'unstaged') return undefined;
    const key = JSON.stringify(target);
    const kept = this.statusCache.get(key);
    if (!kept || this.now() - kept.checkedAt > 5_000) return undefined;
    // A change the watch saw since (a stage, say) makes the record's blob ids old.
    for (const entry of this.watches.values()) if (entry.results.has(key) && entry.watch.peekChanged()) return undefined;
    return kept.parsed.files.find((f) => f.area === req.src && f.path === req.path);
  }

  private async sideInput(target: GitTarget, info: RepoInfo, tree: string | null, rel: string, record?: StatusFile): Promise<SideInput> {
    if (tree === null) return { id: null };
    if (tree === 'worktree') return this.worktreeInput(target, info, rel);
    // PERF-GIT-001 AC-7: the status record already names the index and HEAD blobs.
    if (record && tree === 'index' && record.indexId !== undefined) return { id: record.indexId };
    if (record && tree !== 'index' && record.headId !== undefined && record.area === 'staged') return { id: record.headId };
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
    // The side inputs and the diff itself do not depend on each other: ask for them together.
    const record = this.recentStatusRecord(target, req);
    const inputsLookup = Promise.all([this.sideInput(target, info, oldTree, oldRel, record), this.sideInput(target, info, newTree, req.path, record)]);
    inputsLookup.catch(() => {});
    const pathspec = req.origPath ? ['--', req.origPath, req.path] : ['--', req.path];
    const base = ['diff', '-U3', '--no-color', '--no-ext-diff', '--no-textconv', '-M'];
    const runDiff = (extra: string[]) => this.runGit(target, [...base, ...extra, ...range, ...pathspec], {
      repoKey: info.root, raw: true, maxBuffer: (req.force ? FORCED_DIFF_BYTES : MAX_DIFF_BYTES) + 1,
    }).catch((err) => {
      if (err instanceof GitError && /maxBuffer/i.test(err.detail)) return null;
      throw err;
    });
    const [raw, [oldIn, newIn]] = await Promise.all([runDiff(req.ignoreWs ? ['-w'] : []), inputsLookup]);
    const inputs = { old: oldIn, new: newIn };
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
    // Only a change whose removed and added lines match once a trailing CR is dropped can be a
    // line-ending change; anything else skips the second git call (PERF-GIT-001).
    const strippedSide = (k: '+' | '-') => file.hunks.flatMap((h) => h.lines).filter((l) => l.k === k).map((l) => l.t.replace(/\r$/, '')).sort().join('\n');
    if (!req.ignoreWs && !req.force && strippedSide('+') === strippedSide('-')) {
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
