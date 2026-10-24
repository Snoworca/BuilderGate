/**
 * Watches a Windows repository for changes (PERF-GIT-001 AC-10).
 *
 * The chip asks for a summary every few seconds, and each one started `git status`: on Windows
 * a process costs tens to hundreds of milliseconds to create. While the watch has seen nothing
 * in the working tree or the git directory, the previous summary is still right and no git
 * starts. Anything the watch cannot vouch for runs git: an event, a watch error, or a summary
 * older than the service's limit.
 *
 * A deleted folder is the one case Windows does not report as an error: the recursive watch
 * then fires events without end (measured: 236,000 in 5 s, 70% of a core). So an event also
 * checks, one check at a time, that the watched folders still exist, and a missing one closes
 * the watch as failed.
 *
 * Only native repositories on Windows and macOS, where a recursive watch is one kernel handle.
 * WSL paths (\\wsl.localhost) do not deliver events reliably, and Linux would need one inotify
 * watch per directory.
 *
 * @req PERF-GIT-001
 */
import { watch, type FSWatcher } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import type { GitTarget } from './gitRunner.js';

export interface RepoWatch {
  /** True when something changed (or the watch failed) since the last call; clears the mark. */
  takeChanged(): boolean;
  /** The same answer without clearing the mark. */
  peekChanged(): boolean;
  failed(): boolean;
  close(): void;
}

export type WatchRepo = (target: GitTarget, info: { root: string; gitDir: string; commonDir: string }) => RepoWatch | null;

const inside = (dir: string, root: string) => {
  const rel = path.relative(root, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export function createRepoWatcher(platform: NodeJS.Platform = process.platform): WatchRepo {
  return (target, info) => {
    if (target.kind !== 'native' || (platform !== 'win32' && platform !== 'darwin')) return null;
    // A linked worktree keeps its git directory (and the shared refs) outside its root.
    const dirs = [info.root];
    for (const dir of [info.gitDir, info.commonDir]) {
      const abs = path.resolve(info.root, dir);
      if (!dirs.some((d) => inside(abs, d))) dirs.push(abs);
    }
    let changed = false;
    let broken = false;
    const watchers: FSWatcher[] = [];
    let checking = false;
    const fail = () => { broken = true; for (const w of watchers.splice(0)) w.close(); };
    const onEvent = () => {
      changed = true;
      if (checking || broken) return;
      checking = true;
      Promise.all(dirs.map((d) => access(d))).then(() => { checking = false; }, fail);
    };
    try {
      for (const dir of dirs) {
        const w = watch(dir, { recursive: true, persistent: false }, onEvent);
        w.on('error', fail);
        watchers.push(w);
      }
    } catch {
      fail();
      return null;
    }
    return {
      takeChanged() {
        const c = changed || broken;
        changed = false;
        return c;
      },
      peekChanged: () => changed || broken,
      failed: () => broken,
      close: () => { for (const w of watchers.splice(0)) w.close(); },
    };
  };
}
