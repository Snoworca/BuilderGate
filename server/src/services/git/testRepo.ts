// Test helper: real git repositories in a temporary folder. Test-only; uses sync calls.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDENTITY = ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];

export interface TestRepo {
  dir: string;
  git: (...args: string[]) => string;
  gitMayFail: (...args: string[]) => string;
  write: (rel: string, content: string | Buffer) => void;
  commit: (message: string, files?: Record<string, string>) => string;
}

export function tempRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bg-git-test-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function repoAt(dir: string): TestRepo {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', [...IDENTITY, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const gitMayFail = (...args: string[]) => {
    try { return git(...args); } catch (e) { return String((e as { stdout?: string }).stdout ?? ''); }
  };
  const write = (rel: string, content: string | Buffer) => {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const commit = (message: string, files: Record<string, string> = {}) => {
    for (const [rel, content] of Object.entries(files)) write(rel, content);
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, gitMayFail, write, commit };
}

export function initRepo(dir: string): TestRepo {
  const r = repoAt(dir);
  r.git('init', '-q');
  // The service runs git without the helper's -c options; pin what the tests rely on.
  r.git('config', 'core.autocrlf', 'false');
  r.git('config', 'core.safecrlf', 'false');
  return r;
}
