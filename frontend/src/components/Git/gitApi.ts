/**
 * Client for the read-only git routes. Network and auth are injected (api.ts wires
 * the real ones), as in htmlViewClient.ts. Errors keep the server's code so the UI
 * can say why (apiError.<CODE>).
 *
 * @req FR-GIT-001
 * @req FR-GIT-011
 */

export class GitApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = 'GitApiError';
    this.code = code;
    this.status = status;
  }
}

export type FileKind = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'X' | '?';
export type FileArea = 'staged' | 'unstaged' | 'untracked' | 'conflict';
export interface GitOperation { kind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'bisect'; step?: number; total?: number; branch?: string }
export interface GitCounts { staged: number; unstaged: number; untracked: number; conflicted: number; paths: number }

export type GitSummary =
  | { repo: false; checkedAt: number }
  | {
    repo: true; root: string; subdir: string; branch: string | null; detached: boolean; head: string | null;
    upstream: string | null; ahead: number; behind: number; base: { ref: string; ahead: number } | null;
    compare: { ref: string } | { blocked: 'noBase' | 'sameAsBase' };
    operation: GitOperation | null; counts: GitCounts; untrackedScan: 'normal' | 'off'; checkedAt: number;
  };
export type RepoSummary = Extract<GitSummary, { repo: true }>;

export interface SideInput { id: string | null; size?: number; mtimeMs?: number }
export interface GitStatusFile {
  path: string; origPath?: string; similarity?: number; kind: FileKind; area: FileArea;
  add: number; del: number; binary: boolean; inputs: { old: SideInput; new: SideInput };
}
export interface GitStatus { summary: RepoSummary; files: GitStatusFile[]; truncated: boolean }

export interface GitRef { kind: 'head' | 'local' | 'remote' | 'tag'; name: string }
export interface GitLogCommit { sha: string; parents: string[]; author: string; email: string; time: number; subject: string; refs: GitRef[] }
export type LogScope = 'head' | 'all' | 'cmp';
export interface GitLog { commits: GitLogCommit[]; hasMore: boolean; shallow: boolean; noCommits: boolean; sessions: Array<{ sessionId: string; head: string }> }

export interface ChangedFile { path: string; origPath?: string; similarity?: number; kind: FileKind; add: number; del: number; binary: boolean }
export interface GitCommitDetail { sha: string; parents: string[]; author: string; email: string; time: number; committer: string; refs: GitRef[]; message: string; files: ChangedFile[]; truncated: boolean }
export interface GitCompare { base: { ref: string; sha: string }; mergeBase: string; commits: string[]; files: ChangedFile[]; add: number; del: number; fetchedAt: number | null; truncated: boolean }

export type DiffSource = 'commit' | 'staged' | 'unstaged' | 'untracked' | 'cmp';
export interface DiffLine { k: ' ' | '+' | '-'; o: number | null; n: number | null; t: string }
export interface DiffHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; header: string; lines: DiffLine[] }
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
  inputs: { old: SideInput; new: SideInput }; hunks: DiffHunk[]; gapAfter?: number; special?: DiffSpecial;
  truncated: boolean; language?: string; full?: { old: string; new: string };
}
export interface DiffRequest { src: DiffSource; path: string; origPath?: string; sha?: string; wt?: boolean; ignoreWs?: boolean; full?: boolean; force?: boolean }

export interface GitClientDeps {
  apiBase: string;
  authFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getAuthHeaders: () => HeadersInit;
}

export interface GitClient {
  summary(sessionId: string, signal?: AbortSignal): Promise<GitSummary>;
  status(sessionId: string, signal?: AbortSignal): Promise<GitStatus>;
  log(sessionId: string, q: { scope: LogScope; limit?: number; after?: string }, signal?: AbortSignal): Promise<GitLog>;
  commit(sessionId: string, sha: string, signal?: AbortSignal): Promise<GitCommitDetail>;
  diff(sessionId: string, q: DiffRequest, signal?: AbortSignal): Promise<GitDiff>;
  compare(sessionId: string, wt: boolean, signal?: AbortSignal): Promise<GitCompare>;
}

export function createGitClient(deps: GitClientDeps): GitClient {
  const get = async <T>(sessionId: string, route: string, query: Record<string, string | number | boolean | undefined>, signal?: AbortSignal): Promise<T> => {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== false)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : String(v))}`)
      .join('&');
    const res = await deps.authFetch(`${deps.apiBase}/sessions/${encodeURIComponent(sessionId)}/git/${route}${qs ? `?${qs}` : ''}`, { headers: deps.getAuthHeaders(), signal });
    if (!res.ok) {
      let code = 'GIT_FAILED';
      try { code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? code; } catch { /* keep the fallback code */ }
      throw new GitApiError(code, res.status);
    }
    return await res.json() as T;
  };
  return {
    summary: (id, signal) => get(id, 'summary', {}, signal),
    status: (id, signal) => get(id, 'status', {}, signal),
    log: (id, q, signal) => get(id, 'log', { scope: q.scope, limit: q.limit, after: q.after }, signal),
    commit: (id, sha, signal) => get(id, `commit/${encodeURIComponent(sha)}`, {}, signal),
    diff: (id, q, signal) => get(id, 'diff', { src: q.src, path: q.path, origPath: q.origPath, sha: q.sha, wt: q.wt, ignoreWs: q.ignoreWs, full: q.full, force: q.force }, signal),
    compare: (id, wt, signal) => get(id, 'compare', { wt }, signal),
  };
}
