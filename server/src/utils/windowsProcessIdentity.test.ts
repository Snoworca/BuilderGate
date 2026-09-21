import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DefaultProcessTreeTerminator,
  WINDOWS_IDENTITY_UNAVAILABLE,
  buildWindowsProcessIdentityScript,
  createDefaultProcessInfoProvider,
  readProcessStartIdentity,
} from './processTreeTerminator.js';
import type { ProcessInfoSnapshot } from './processTreeTerminator.js';
import type { SessionProcessMetadata } from '../types/ws-protocol.js';

/**
 * PERF-BGSTAB-013.
 *
 * Measured 2026-09-21 on a 1289-process host, same PID each time:
 *
 *   Get-CimInstance Win32_Process (full)       3.59 / 3.01 / 3.38 s
 *   Get-CimInstance ... -Filter ProcessId=N    6.08 / 2.46 / 2.16 s
 *   [Diagnostics.Process]::GetProcessById(N)   0.29 / 0.27 s
 *   powershell.exe -NoProfile 'exit 0'         0.41 / 0.42 s
 *
 * The cost is neither the enumeration size nor the shell start: it is WMI.
 * `GetProcessById` throws for an exited process even while a handle is still
 * open, so it carries the same liveness meaning Win32_Process does and does not
 * mistake a handle-held zombie for a running process (measured: absent at +0ms
 * after taskkill, with our own handle still held).
 */

type ExecCall = { file: string; args: readonly string[] };

function recordingExecFile(calls: ExecCall[], stdout: string, error: Error | null = null) {
  return ((
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ file, args });
    queueMicrotask(() => callback(error, stdout, ''));
    return {} as never;
  }) as never;
}

function metadata(overrides: Partial<SessionProcessMetadata> = {}): SessionProcessMetadata {
  return {
    rootPid: 4321,
    shellCommand: 'powershell.exe',
    shellArgs: [],
    shellType: 'powershell',
    cwd: 'C:/work',
    platform: 'win32',
    backend: 'conpty',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'win32net:4321:2026-09-21T01:00:00.0000000Z',
    ...overrides,
  } as SessionProcessMetadata;
}

// --- AC-1: capture and verification share one implementation ---------------

test('PERF-BGSTAB-013 AC-1 the capture and the verification issue the identical query', async () => {
  const livePid = process.pid;
  const stdout = '2026-09-21T01:00:00.0000000Z\r\n';

  const verificationCalls: ExecCall[] = [];
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile(verificationCalls, stdout),
  });
  const snapshot = await provider(livePid);

  const captureCalls: ExecCall[] = [];
  const captured = await readProcessStartIdentity(
    livePid,
    'win32',
    recordingExecFile(captureCalls, stdout),
  );

  assert.equal(verificationCalls.length, 1);
  assert.equal(captureCalls.length, 1);
  // Same executable, same arguments: the two halves cannot drift apart.
  assert.deepEqual(captureCalls[0], verificationCalls[0]);
  // And the same identity string comes out of both.
  assert.equal(captured, snapshot.startIdentity);
  assert.notEqual(captured, null);
});

// --- AC-2: no WMI ----------------------------------------------------------

test('PERF-BGSTAB-013 AC-2 the Windows identity query does not go through WMI', () => {
  const script = buildWindowsProcessIdentityScript(4321);
  for (const banned of ['Get-CimInstance', 'Get-WmiObject', 'Win32_Process', 'cim', 'wmi']) {
    assert.ok(
      !script.toLowerCase().includes(banned.toLowerCase()),
      `identity script must not reference ${banned}: ${script}`,
    );
  }
  assert.match(script, /System\.Diagnostics\.Process/);
  assert.match(script, /GetProcessById\(4321\)/);
});

// --- AC-3: generations must not compare equal ------------------------------

test('PERF-BGSTAB-013 AC-3 the identity carries a source prefix distinct from the WMI generation', async () => {
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile([], '2026-09-21T01:00:00.0000000Z\n'),
  });
  const snapshot = await provider(4321);
  assert.equal(snapshot.startIdentity, 'win32net:4321:2026-09-21T01:00:00.0000000Z');
  // The cheapest way to "add a prefix" would be to keep the old one.
  assert.ok(!snapshot.startIdentity!.startsWith('win32:'));
});

test('PERF-BGSTAB-013 AC-3 a WMI-generation identity is refused and nothing is killed', async () => {
  const calls: ExecCall[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    execFileFn: recordingExecFile(calls, '2026-09-21T01:00:00.0000000Z\n'),
  });

  const result = await terminator.terminate(
    // Captured before the change, by Win32_Process, to microsecond precision.
    metadata({ osStartIdentity: 'win32:4321:2026-09-21T01:00:00.000000Z' }),
    { gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 64 },
  );

  assert.equal(result.status, 'skipped-unverified');
  assert.deepEqual(calls.filter(call => call.file === 'taskkill.exe'), []);
});

// --- AC-4: found but unreadable identity is not "absent" -------------------

test('PERF-BGSTAB-013 AC-4 a process whose start time cannot be read stays running with a null identity', async () => {
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile([], `${WINDOWS_IDENTITY_UNAVAILABLE}\n`),
  });
  const snapshot = await provider(4321);
  assert.equal(snapshot.running, true, 'must not be reported as stopped, or the kill is skipped');
  assert.equal(snapshot.startIdentity, null);
});

test('PERF-BGSTAB-013 AC-4 an absent process is reported stopped', async () => {
  // Control for the test above: reporting everything as running would pass it.
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile([], '\r\n'),
  });
  const snapshot = await provider(4321);
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.startIdentity, null);
});

test('PERF-BGSTAB-013 AC-4 an unreadable identity yields skipped-unverified, not a false completion', async () => {
  const calls: ExecCall[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    execFileFn: recordingExecFile(calls, `${WINDOWS_IDENTITY_UNAVAILABLE}\n`),
  });
  const result = await terminator.terminate(metadata(), {
    gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 64,
  });
  assert.equal(result.status, 'skipped-unverified');
  assert.deepEqual(calls.filter(call => call.file === 'taskkill.exe'), []);
});

// --- AC-5: no graceful sleep before the first post-kill check ---------------

function windowsTerminator(afterKill: Partial<ProcessInfoSnapshot>) {
  const providerCalls: number[] = [];
  let killed = false;
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    processInfoProvider: async (pid: number) => {
      providerCalls.push(pid);
      if (!killed) {
        return { pid, running: true, startIdentity: metadata().osStartIdentity, cwd: null, childPids: [] };
      }
      return {
        pid,
        running: false,
        startIdentity: null,
        cwd: null,
        childPids: [],
        ...afterKill,
      } as ProcessInfoSnapshot;
    },
    execFileFn: ((file: string, _args: string[], _opts: unknown, cb: (error: null) => void) => {
      if (file === 'taskkill.exe') killed = true;
      queueMicrotask(() => cb(null));
      return {} as never;
    }) as never,
  });
  return { terminator, providerCalls };
}

test('PERF-BGSTAB-013 AC-5 win32 termination does not sleep the graceful budget when the tree is already gone', async () => {
  const { terminator, providerCalls } = windowsTerminator({});
  const started = Date.now();
  const result = await terminator.terminate(metadata(), {
    gracefulWaitMs: 3000, forceWaitMs: 0, descendantSampleLimit: 64,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'completed');
  assert.ok(elapsed < 500, `expected no graceful sleep, took ${elapsed}ms`);
  // Control: it did actually verify rather than skipping the check to be fast.
  assert.deepEqual(providerCalls, [4321, 4321]);
});

test('PERF-BGSTAB-013 AC-5 a root that outlives the kill is re-checked within the budget', async () => {
  // Control for the test above: deleting the wait outright would pass it too.
  const { terminator, providerCalls } = windowsTerminator({
    running: true,
    startIdentity: metadata().osStartIdentity,
  });
  const started = Date.now();
  const result = await terminator.terminate(metadata(), {
    gracefulWaitMs: 300, forceWaitMs: 0, descendantSampleLimit: 64,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.remainingPids, [4321]);
  assert.ok(providerCalls.length > 2, `expected retries, saw ${providerCalls.length} probes`);
  assert.ok(elapsed >= 250, `expected the budget to be used, took ${elapsed}ms`);
  assert.ok(elapsed < 2000, `expected the budget to bound the wait, took ${elapsed}ms`);
});

// --- AC-6: no descendant sampling on Windows -------------------------------

test('PERF-BGSTAB-013 AC-6 the Windows snapshot reports no sampled descendants', async () => {
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile([], '2026-09-21T01:00:00.0000000Z\n'),
  });
  const snapshot = await provider(4321);
  assert.deepEqual(snapshot.childPids, []);
});

test('PERF-BGSTAB-013 AC-6 a verified Windows kill still runs taskkill with the PID-only tree flags', async () => {
  const calls: ExecCall[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    execFileFn: recordingExecFile(calls, '2026-09-21T01:00:00.0000000Z\n'),
  });
  const result = await terminator.terminate(metadata(), {
    gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 64,
  });

  // FR-BGSTAB-011 AC-3 is unchanged by this requirement.
  const kills = calls.filter(call => call.file === 'taskkill.exe');
  assert.equal(kills.length, 1);
  assert.deepEqual(kills[0].args, ['/PID', '4321', '/T', '/F']);
  assert.equal(result.method, 'windows-taskkill-tree');
});

// --- query failure keeps the conservative fallback -------------------------

test('PERF-BGSTAB-013 a failed identity query reports a null identity, never a match', async () => {
  const provider = createDefaultProcessInfoProvider({
    platform: 'win32',
    execFileFn: recordingExecFile([], '', new Error('timeout')),
  });
  const snapshot = await provider(process.pid);
  assert.equal(snapshot.startIdentity, null);
  assert.equal(snapshot.running, true, 'the process is live; only the identity read failed');
});

// --- non-Windows: this requirement must not reach POSIX --------------------

function posixTerminator(rootAliveAfterSignal: boolean) {
  const providerCalls: number[] = [];
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  let signalled = false;
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid: number, signal?: NodeJS.Signals | number) => {
      killCalls.push({ pid, signal });
      signalled = true;
    },
    processInfoProvider: async (pid: number) => {
      providerCalls.push(pid);
      return {
        pid,
        running: signalled ? rootAliveAfterSignal : true,
        startIdentity: 'procfs:4321:99887766',
        cwd: '/work',
        processGroupId: 999,
        childPids: [],
      };
    },
  });
  return { terminator, providerCalls, killCalls };
}

function posixMetadata(): SessionProcessMetadata {
  return {
    rootPid: 4321,
    shellCommand: 'bash',
    shellArgs: [],
    shellType: 'bash',
    cwd: '/work',
    platform: 'linux',
    backend: 'unix',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'procfs:4321:99887766',
  } as SessionProcessMetadata;
}

test('PERF-BGSTAB-013 AC-5 POSIX returns as soon as the tree is gone instead of sleeping the budget', async () => {
  const { terminator, killCalls, providerCalls } = posixTerminator(false);
  const started = Date.now();
  const result = await terminator.terminate(posixMetadata(), {
    gracefulWaitMs: 3000, forceWaitMs: 3000, descendantSampleLimit: 16,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'completed');
  assert.equal(result.method, 'posix-leaf-first');
  assert.deepEqual(killCalls, [{ pid: 4321, signal: 'SIGTERM' }]);
  assert.ok(elapsed < 200, `expected no sleep once the tree is gone, took ${elapsed}ms`);
  // Control: it verified rather than skipping the check to be fast.
  assert.deepEqual(providerCalls, [4321, 4321]);
});

test('PERF-BGSTAB-013 AC-7 POSIX still gives a slow exit its grace before escalating', async () => {
  // The budget is an upper bound, not a toll. A process that takes 150ms to
  // handle SIGTERM must be waited for, and must not be SIGKILLed for it.
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  let signalledAt: number | null = null;
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid, signal) => {
      killCalls.push({ pid, signal });
      signalledAt ??= Date.now();
    },
    processInfoProvider: async (pid: number) => ({
      pid,
      running: signalledAt === null || Date.now() - signalledAt < 150,
      startIdentity: 'procfs:4321:99887766',
      cwd: '/work',
      processGroupId: 999,
      childPids: [],
    }),
  });

  const started = Date.now();
  const result = await terminator.terminate(posixMetadata(), {
    gracefulWaitMs: 3000, forceWaitMs: 3000, descendantSampleLimit: 16,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'completed');
  assert.deepEqual(killCalls, [{ pid: 4321, signal: 'SIGTERM' }], 'a timely exit must not be SIGKILLed');
  assert.ok(elapsed >= 140, `the grace period must actually be granted, returned after ${elapsed}ms`);
  assert.ok(elapsed < 1500, `grace must end when the process exits, took ${elapsed}ms`);
});

test('PERF-BGSTAB-013 AC-7 POSIX escalates to SIGKILL when the process outlives the budget', async () => {
  const { terminator, killCalls } = posixTerminator(true);
  const started = Date.now();
  const result = await terminator.terminate(posixMetadata(), {
    gracefulWaitMs: 200, forceWaitMs: 200, descendantSampleLimit: 16,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.status, 'degraded');
  assert.deepEqual(killCalls, [
    { pid: 4321, signal: 'SIGTERM' },
    { pid: 4321, signal: 'SIGKILL' },
  ]);
  assert.ok(elapsed >= 200, `both budgets must be spent on a survivor, took ${elapsed}ms`);
  assert.ok(elapsed < 2000, `the budgets must still bound the wait, took ${elapsed}ms`);
});

test('PERF-BGSTAB-013 AC-2 POSIX identity is read from procfs and never spawns PowerShell', async () => {
  const calls: ExecCall[] = [];
  const identity = await readProcessStartIdentity(
    process.pid,
    'linux',
    recordingExecFile(calls, 'should never be used'),
  );
  assert.deepEqual(calls, [], 'the POSIX path must not shell out');
  if (identity !== null) {
    assert.match(identity, /^procfs:\d+:\d+$/);
  }
});

test('PERF-BGSTAB-013 AC-6 POSIX still samples descendants', async () => {
  // C-1 is scoped to Windows: taskkill /T has no POSIX counterpart, so the
  // leaf-first signalling there depends on the sampled descendant list.
  const providerCalls: number[] = [];
  const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
  let signalled = false;
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'linux',
    killFn: (pid, signal) => { killCalls.push({ pid, signal }); signalled = true; },
    processInfoProvider: async (pid: number) => {
      providerCalls.push(pid);
      return {
        pid,
        running: !signalled,
        startIdentity: `procfs:${pid}:99887766`,
        cwd: '/work',
        processGroupId: 999,
        childPids: pid === 4321 && !signalled ? [5001, 5002] : [],
      };
    },
  });

  const result = await terminator.terminate(posixMetadata(), {
    gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 16,
  });

  assert.equal(result.status, 'completed');
  assert.deepEqual(killCalls, [
    { pid: 5002, signal: 'SIGTERM' },
    { pid: 5001, signal: 'SIGTERM' },
    { pid: 4321, signal: 'SIGTERM' },
  ]);
});

/**
 * Characterization, not an endorsement.
 *
 * `readPosixProcessInfo` reads `/proc/<pid>/stat`, which macOS does not have,
 * so on darwin the identity is null, `inspect` refuses, and enforce mode never
 * terminates a process tree -- it always answers `skipped-unverified`. The PTY
 * is still killed by `finalizeSession`, so the shell dies; its descendants may
 * not. This pins that behaviour so a macOS implementation replaces it
 * deliberately rather than changing it by accident. It has not been executed on
 * macOS; the claim is about the code path, which is platform-dispatched only
 * between win32 and everything else.
 */
test('PERF-BGSTAB-013 a process with no procfs entry yields no identity and no kill', async () => {
  const calls: ExecCall[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'darwin',
    execFileFn: recordingExecFile(calls, ''),
    killFn: () => { throw new Error('nothing may be signalled without a verified identity'); },
  });

  const result = await terminator.terminate(
    { ...posixMetadata(), platform: 'darwin', backend: 'unix', osStartIdentity: null } as SessionProcessMetadata,
    { gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 16 },
  );

  assert.equal(result.status, 'skipped-unverified');
  assert.deepEqual(result.unverifiedPids, [4321]);
  assert.deepEqual(calls, []);
});
