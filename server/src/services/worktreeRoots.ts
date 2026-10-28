/**
 * The worktrees of the git repository a folder belongs to, read from git's own
 * registry files rather than by running git (SEC-FOP-002 AC-1).
 *
 * A worktree's `.git` is either the repository's git directory (the main
 * worktree) or a file `gitdir: <path>` naming a private git directory under
 * `<common dir>/worktrees/<name>`. That private directory holds `commondir`
 * (the shared git directory, often relative) and `gitdir` (the linked
 * worktree's own `.git` file). `git worktree list` reads the same files.
 *
 * @req SEC-FOP-002
 */

import fs from 'fs/promises';
import path from 'path';

/** Turns a path written by git into one this host can open (WSL paths on Windows). */
export type WorktreePathMapper = (p: string) => Promise<string>;

const identity: WorktreePathMapper = async (p) => p;

async function readTrimmed(file: string): Promise<string | null> {
  try {
    return (await fs.readFile(file, 'utf8')).replace(/^﻿/, '').trim();
  } catch {
    return null;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isDirectory(), () => false);
}

async function resolveGitPath(base: string, written: string, mapPath: WorktreePathMapper): Promise<string> {
  const mapped = await mapPath(written);
  return path.resolve(base, mapped);
}

/** The git directory of the worktree containing `start`, or null outside any repository. */
async function findGitDir(start: string, mapPath: WorktreePathMapper): Promise<string | null> {
  let dir = path.resolve(start);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (await isDirectory(dotGit)) return dotGit;
    const pointer = await readTrimmed(dotGit);
    const match = pointer === null ? null : /^gitdir:\s*(.+)$/m.exec(pointer);
    if (match) return resolveGitPath(dir, match[1].trim(), mapPath);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function realOrNull(p: string): Promise<string | null> {
  try {
    const real = await fs.realpath(p);
    return (await isDirectory(real)) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Real paths of every worktree of the repository containing `start`: the main
 * worktree (when the repository is not bare) and each registered linked
 * worktree whose folder still exists. Empty outside a repository.
 */
export async function listWorktreeRoots(start: string, mapPath: WorktreePathMapper = identity): Promise<string[]> {
  const gitDir = await findGitDir(start, mapPath);
  if (gitDir === null) return [];
  const commonWritten = await readTrimmed(path.join(gitDir, 'commondir'));
  const commonDir = commonWritten === null ? gitDir : await resolveGitPath(gitDir, commonWritten, mapPath);

  const candidates: string[] = [];
  if (path.basename(commonDir).toLowerCase() === '.git') candidates.push(path.dirname(commonDir));
  let names: string[] = [];
  try {
    names = await fs.readdir(path.join(commonDir, 'worktrees'));
  } catch {
    names = [];
  }
  for (const name of names) {
    const written = await readTrimmed(path.join(commonDir, 'worktrees', name, 'gitdir'));
    if (written) candidates.push(path.dirname(await resolveGitPath(commonDir, written, mapPath)));
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const real = await realOrNull(candidate);
    if (real === null) continue;
    const key = process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(real);
  }
  return roots;
}
