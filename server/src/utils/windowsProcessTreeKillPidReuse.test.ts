import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';

import {
  DefaultProcessTreeTerminator,
  buildWindowsProcessTreeKillScript,
} from './processTreeTerminator.js';
import type { SessionProcessMetadata } from '../types/ws-protocol.js';

/**
 * REL-BGSTAB-029 — the Windows tree kill must not take processes that only
 * look like descendants because a PID was reused.
 *
 * The walk links processes by parent PID alone, and Windows keeps a process's
 * parent PID after the parent dies. Observed 2026-09-26: 2222 was started from
 * a PowerShell that exited three minutes later, so the server's parent PID was
 * a dead number. When Windows handed that number to a terminal tab's shell,
 * deleting the tab walked straight into the server, and the server vanished in
 * the middle of an E2E run with nothing in its logs. A real child is always
 * created after its parent, which is the test the walk now applies; the server
 * is also protected by PID outright.
 */

const isWindows = process.platform === 'win32';

test('REL-BGSTAB-029 AC-1: a process created before its linked parent is neither killed nor walked', () => {
  const script = buildWindowsProcessTreeKillScript(4321);
  assert.match(script, /StartTime/, 'the walk reads start times');
  assert.match(script, /\$childStart -lt \$parentStart/, 'a child older than its parent is skipped');
  assert.match(script, /\$null -eq \$childStart/, 'a child whose start time cannot be read is skipped');
  const walk = script.slice(script.indexOf('while ($pending.Count'));
  assert.ok(walk.indexOf('$childStart -lt $parentStart') < walk.indexOf('$order.Add($child)'), 'the check comes before the child joins the kill list');
});

test('REL-BGSTAB-029 AC-2: protected pids are bare integers, never killed or walked', () => {
  const script = buildWindowsProcessTreeKillScript(4321, [100, 200]);
  assert.match(script, /\$protected = @\{\}/);
  assert.match(script, /\$protected\[100\] = \$true/);
  assert.match(script, /\$protected\[200\] = \$true/);
  assert.match(script, /\$protected\[\$PID\] = \$true/, 'the kill script never kills itself');
  assert.match(script, /\$protected\.ContainsKey\(\$child\)/);
  assert.throws(() => buildWindowsProcessTreeKillScript(4321, [Number('1; whoami')]));
  assert.throws(() => buildWindowsProcessTreeKillScript(4321, [-5]));
});

test('REL-BGSTAB-029 AC-2: the terminator protects the server process in every kill', async () => {
  const scripts: string[] = [];
  let killed = false;
  const execFileFn = ((_file: string, args: readonly string[], _options: unknown, callback: (e: Error | null, out: string, err: string) => void) => {
    const script = String(args[args.length - 1]);
    let out = killed ? '\n' : '2026-09-21T01:00:00.0000000Z\n';
    if (script.includes('CreateToolhelp32Snapshot')) {
      scripts.push(script);
      killed = true;
      out = 'descendants= killed=4321\n';
    }
    queueMicrotask(() => callback(null, out, ''));
    return {} as never;
  }) as never;
  const terminator = new DefaultProcessTreeTerminator({ platform: 'win32', execFileFn });
  await terminator.terminate({
    rootPid: 4321,
    shellCommand: 'powershell.exe',
    shellArgs: [],
    shellType: 'powershell',
    cwd: 'C:/work',
    platform: 'win32',
    backend: 'conpty',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'win32net:4321:2026-09-21T01:00:00.0000000Z',
  } as SessionProcessMetadata, { gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 64 });
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], new RegExp(`\\$protected\\[${process.pid}\\] = \\$true`), 'the server pid is protected');
});

// --- a real tree on Windows -----------------------------------------------

function runPowerShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 60_000 }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startTree(): Promise<{ root: number; child: number }> {
  // cmd.exe is the root, ping.exe its only child; both live for 60 s unless killed.
  const root = spawn('cmd.exe', ['/c', 'ping -n 60 127.0.0.1 >nul'], { windowsHide: true, stdio: 'ignore' });
  const rootPid = root.pid;
  if (!rootPid) throw new Error('cmd.exe did not start');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const out = await runPowerShell(`(Get-CimInstance Win32_Process -Filter "ParentProcessId=${rootPid} AND Name='PING.EXE'").ProcessId`);
    const child = Number(out.trim().split(/\s+/)[0]);
    if (Number.isInteger(child) && child > 0) return { root: rootPid, child };
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('ping.exe did not appear under cmd.exe');
}

test('REL-BGSTAB-029 AC-3: a real tree is still killed, root and child', { skip: !isWindows && 'Windows only' }, async () => {
  const { root, child } = await startTree();
  const out = await runPowerShell(buildWindowsProcessTreeKillScript(root, [process.pid]));
  console.log(`[pid-reuse] kill output: ${out.trim()}`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(isAlive(child), false, 'the real child was killed');
  assert.equal(isAlive(root), false, 'the root was killed');
  assert.equal(isAlive(process.pid), true);
});

test('REL-BGSTAB-029 AC-3: a descendant named as protected survives', { skip: !isWindows && 'Windows only' }, async () => {
  const { root, child } = await startTree();
  try {
    await runPowerShell(buildWindowsProcessTreeKillScript(root, [process.pid, child]));
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(isAlive(root), false, 'the root was killed');
    assert.equal(isAlive(child), true, 'the protected child was left alone');
  } finally {
    // Our own ping.exe, found above as the child of the cmd.exe we spawned.
    if (isAlive(child)) process.kill(child);
  }
});
