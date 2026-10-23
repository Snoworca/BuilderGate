/**
 * Git viewer routes, mounted under /api/sessions behind authMiddleware.
 * Read-only. The client sends no git arguments: every value is checked here and the
 * service builds the command.
 *
 * @req SEC-GIT-001
 * @req FR-GIT-001
 * @req FR-GIT-005
 * @req FR-GIT-006
 * @req FR-GIT-007
 * @req FR-GIT-008
 */

import { Router, type Request, type Response } from 'express';
import type { GitService, DiffSource, LogScope } from '../services/git/GitService.js';
import { isSafeRepoPath } from '../services/git/GitService.js';
import { GitError, type GitErrorCode } from '../services/git/gitRunner.js';

const STATUS: Record<GitErrorCode, number> = {
  INVALID_INPUT: 400,
  PATH_OUTSIDE_REPO: 400,
  SESSION_NOT_FOUND: 404,
  NOT_A_REPO: 404,
  COMMIT_NOT_FOUND: 404,
  BASE_NOT_FOUND: 404,
  NO_COMMITS: 409,
  SHALLOW_HISTORY: 409,
  GIT_UNSAFE_REPO: 409,
  DIFF_TOO_LARGE: 413,
  GIT_FAILED: 500,
  GIT_UNAVAILABLE: 503,
  GIT_TIMEOUT: 504,
};

const SHA = /^[0-9a-f]{7,64}$/;
const SCOPES = new Set<LogScope>(['head', 'all', 'cmp']);
const SOURCES = new Set<DiffSource>(['commit', 'staged', 'unstaged', 'untracked', 'cmp']);

const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const flag = (v: unknown) => one(v) === '1' || one(v) === 'true';

function send(res: Response, err: unknown): void {
  const e = err instanceof GitError ? err : new GitError('GIT_FAILED', err instanceof Error ? err.message : String(err));
  if (e.code === 'GIT_FAILED') console.warn('[git] failed:', e.detail);
  res.status(STATUS[e.code] ?? 500).json({ error: { code: e.code, message: e.code, ...(e.code === 'GIT_FAILED' && e.detail ? { detail: e.detail } : {}) } });
}

function route(handler: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await handler(req));
    } catch (err) {
      send(res, err);
    }
  };
}

export function createGitRoutes(git: GitService): Router {
  const router = Router();

  router.get('/:id/git/summary', route((req) => git.summary(req.params.id)));

  router.get('/:id/git/status', route((req) => git.status(req.params.id)));

  router.get('/:id/git/log', route(async (req) => {
    const scope = (one(req.query.scope) ?? 'head') as LogScope;
    if (!SCOPES.has(scope)) throw new GitError('INVALID_INPUT', 'scope');
    const limitText = one(req.query.limit);
    if (limitText !== undefined && !/^\d{1,4}$/.test(limitText)) throw new GitError('INVALID_INPUT', 'limit');
    const after = one(req.query.after);
    if (after !== undefined && !SHA.test(after)) throw new GitError('INVALID_INPUT', 'after');
    return git.log(req.params.id, { scope, limit: limitText === undefined ? undefined : Number(limitText), after });
  }));

  router.get('/:id/git/commit/:sha', route(async (req) => {
    if (!SHA.test(req.params.sha)) throw new GitError('INVALID_INPUT', 'sha');
    return git.commit(req.params.id, req.params.sha);
  }));

  router.get('/:id/git/diff', route(async (req) => {
    const src = one(req.query.src) as DiffSource;
    if (!SOURCES.has(src)) throw new GitError('INVALID_INPUT', 'src');
    const filePath = one(req.query.path) ?? '';
    const origPath = one(req.query.origPath);
    if (!isSafeRepoPath(filePath) || (origPath !== undefined && !isSafeRepoPath(origPath))) throw new GitError('PATH_OUTSIDE_REPO');
    const sha = one(req.query.sha);
    if (src === 'commit' && !(sha && SHA.test(sha))) throw new GitError('INVALID_INPUT', 'sha');
    return git.diff(req.params.id, {
      src, path: filePath, origPath, sha,
      wt: flag(req.query.wt), ignoreWs: flag(req.query.ignoreWs), full: flag(req.query.full), force: flag(req.query.force),
    });
  }));

  router.get('/:id/git/compare', route((req) => git.compare(req.params.id, { wt: flag(req.query.wt) })));

  return router;
}
