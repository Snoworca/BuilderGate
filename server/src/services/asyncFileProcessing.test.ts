// PERF-BGSTAB-025: file access and helper processes on request, WebSocket and timer
// paths must not block the event loop. Measured 2026-10-22: every file API call of a
// WSL session ran execSync('wsl.exe wslpath'), about 330 ms of the whole server
// stopped (the cwd cache lasts 1 s), and a terminal menu's file check took ~1.8 s.
//
// The guard reads these sources and fails when a synchronous child process or a
// synchronous fs call comes back. Start-up-only loaders (config, certificates, TOTP)
// are not listed: they run once before the server listens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const GUARDED = [
  './FileService.ts',
  '../routes/uploadRoutes.ts',
  '../routes/archiveRoutes.ts',
  '../routes/sessionRoutes.ts',
  './upload/placeExclusively.ts',
  './SessionManager.ts',
  './WorkspaceService.ts',
  './SessionSnapshotService.ts',
  './agentSession/agentSessionResolver.ts',
  './git/gitRunner.ts',
];

// Named exceptions, each with its reason:
// - node:sqlite has no asynchronous API; the Hermes state database is read through it.
// - createSession is synchronous end to end; the requested start folder is stat'ed once
//   there (existsSyncFn). Making it async changes every caller of the session API.
// - the winpty backend probe (execFileSyncFn) runs once per process, then is remembered.
const ALLOWED = new Set([
  './agentSession/agentSessionResolver.ts DatabaseSync',
  './SessionManager.ts existsSyncFn',
  './SessionManager.ts execFileSyncFn',
]);

/** Comments and string contents removed, so a word in prose or a message is not a call. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
}

// @req PERF-BGSTAB-025
test('PERF-BGSTAB-025 AC-1·AC-3·AC-4·AC-5: guarded sources make no synchronous process or fs call', () => {
  const found: string[] = [];
  for (const file of GUARDED) {
    const code = codeOf(readFileSync(new URL(file, import.meta.url), 'utf8'));
    code.split('\n').forEach((line, index) => {
      // `SyncFn(` too: an injected synchronous function is still a synchronous call.
      for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*Sync(?:Fn)?)\s*\(/g)) {
        if (ALLOWED.has(`${file} ${match[1]}`)) continue;
        found.push(`${file}:${index + 1} ${match[1]}`);
      }
    });
  }
  assert.deepEqual(found, [], `synchronous calls on request paths:\n${found.join('\n')}`);
});

// @req PERF-BGSTAB-025
test('PERF-BGSTAB-025 AC-1: WSL paths convert through wsl.exe without a shell, once per path', async () => {
  const { createWslPathConverter } = await import('../utils/wslPathConverter.js');
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let fail = false;
  const convert = createWslPathConverter({
    platform: 'win32',
    run: async (file, args) => {
      calls.push({ file, args });
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (fail) throw new Error('wsl.exe missing');
      return { stdout: `\\\\wsl.localhost\\Ubuntu${args[2].replace(/\//g, '\\')}\r\n` };
    },
  });

  const [a, b] = await Promise.all([convert('/home/beom/x'), convert('/home/beom/x')]);
  assert.equal(a, '\\\\wsl.localhost\\Ubuntu\\home\\beom\\x');
  assert.equal(b, a);
  assert.equal(await convert('/home/beom/x'), a);
  assert.deepEqual(calls, [{ file: 'wsl.exe', args: ['wslpath', '-w', '/home/beom/x'] }], 'one process for the same path');

  // A name a shell would act on is passed as an argument, untouched.
  await convert('/home/beom/a "$(id)" b');
  assert.deepEqual(calls[1], { file: 'wsl.exe', args: ['wslpath', '-w', '/home/beom/a "$(id)" b'] });

  // No process for drive and mount forms.
  assert.equal(await convert('C:\\Work'), 'C:\\Work');
  assert.equal(await convert('/mnt/c/Work/a'), 'C:\\Work\\a');
  assert.equal(calls.length, 2);

  // A failure answers the path as given and is not remembered.
  fail = true;
  assert.equal(await convert('/opt/x'), '/opt/x');
  fail = false;
  assert.equal(await convert('/opt/x'), '\\\\wsl.localhost\\Ubuntu\\opt\\x');
});

// @req PERF-BGSTAB-025
test('PERF-BGSTAB-025 AC-1: off Windows a path is never converted', async () => {
  const { createWslPathConverter } = await import('../utils/wslPathConverter.js');
  let runs = 0;
  const convert = createWslPathConverter({ platform: 'linux', run: async () => { runs += 1; return { stdout: 'x' }; } });
  assert.equal(await convert('/home/me'), '/home/me');
  assert.equal(runs, 0);
});

// @req PERF-BGSTAB-025
test('PERF-BGSTAB-025 AC-4: the async name-collision check answers what the sync one does', async () => {
  const { resolveNameCollision, resolveNameCollisionAsync } = await import('./fileNameCollision.js');
  const cases: Array<[string, string[]]> = [
    ['a.txt', []],
    ['a.txt', ['a.txt']],
    ['a.txt', ['a.txt', 'a (2).txt', 'a (3).txt']],
    ['r (4).md', ['r (4).md']],
    ['.env', ['.env']],
  ];
  for (const [name, taken] of cases) {
    const set = new Set(taken);
    assert.equal(
      await resolveNameCollisionAsync(name, async (candidate) => set.has(candidate)),
      resolveNameCollision(name, (candidate) => set.has(candidate)),
      `${name} with ${taken.join(', ')}`,
    );
  }
  await assert.rejects(() => resolveNameCollisionAsync('a/b', async () => false), TypeError);
});
