// #55: `tsc -b` writes node_modules/.tmp (tsbuildinfo + the editor project's declaration
// output). Three callers produce those same bytes -- `npm run build`, `npm run typecheck`,
// and tests/unit/e2eOwnershipTypecheck.test.ts -- and until now nothing stopped two of them
// from writing at once. The test could not simply build somewhere private: a private
// declarationDir stops exercising the project reference the config actually declares, which
// is the thing the test exists to verify.
//
// So the artifact stays shared and the writers serialize on it. The lock is a DIRECTORY,
// because mkdir is the one filesystem primitive that is atomic and fails loudly when the
// name is taken on every platform this repo runs on.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_DIR = join(FRONTEND_ROOT, 'node_modules', '.tmp', '.tsc-build.lock');
const OWNER_FILE = join(LOCK_DIR, 'owner.json');
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 100;

function holderIsGone() {
  // A lock whose owner died is not a lock. Reading the owner can race with the owner
  // writing it, so an unreadable or half-written owner file is treated as "still alive":
  // waiting a bit longer is recoverable, stealing a live lock is not.
  let owner;
  try { owner = JSON.parse(readFileSync(OWNER_FILE, 'utf8')); }
  catch { return false; }
  if (typeof owner?.pid !== 'number') return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export async function acquireTscBuildLock({ timeoutMs = DEFAULT_TIMEOUT_MS, label = 'unnamed' } = {}) {
  mkdirSync(dirname(LOCK_DIR), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, label, since: Date.now() }));
      let released = false;
      return () => { if (!released) { released = true; rmSync(LOCK_DIR, { recursive: true, force: true }); } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (holderIsGone()) { rmSync(LOCK_DIR, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) {
        throw Error(`Timed out after ${timeoutMs}ms waiting for the tsc build lock at ${LOCK_DIR}. `
          + 'Another build, typecheck or ownership typecheck test is holding it; if none is running, remove that directory.');
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }
}
