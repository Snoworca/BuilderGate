import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DefaultProcessTreeTerminator,
  buildWindowsProcessTreeKillScript,
  parseWindowsKilledPids,
} from './processTreeTerminator.js';
import type { SessionProcessMetadata } from '../types/ws-protocol.js';

/**
 * PERF-BGSTAB-014 — replacing `taskkill /T /F` on the verified-kill path.
 *
 * `taskkill` is WMI-bound. Measured 2026-09-21 on this host: `taskkill /?`
 * returns in 0.06s but `taskkill /PID N /T /F` takes 1.46-2.55s, and dropping
 * `/T` changes nothing (1.46-1.48s), so the cost is the WMI round trip rather
 * than the tree walk. Every WMI transport measured the same -- CIM 2.3-3.1s,
 * Get-WmiObject 2.4-3.3s, raw ManagementObjectSearcher 2.5-2.9s -- so this is
 * WMI itself, not the cmdlet or the protocol.
 *
 * A toolhelp snapshot answers the same question without WMI. Paired against
 * `Get-CimInstance Win32_Process` on a three-level tree with six descendants,
 * the two produced the *identical* descendant set in 4 runs out of 4, and the
 * replacement killed the whole tree in 1388-1623ms against taskkill's
 * 2401-2545ms measured in the same session.
 *
 * Routes that were measured and rejected:
 * - Killing only the verified root: descendants survived (1 of 2, 3 runs of 3).
 * - node-pty's console process list: it is not the descendant tree. For a live
 *   conpty session it returned [queryingAgentPid, shellPid] while the actual
 *   descendants were two other PIDs. Using it would silently leak processes.
 */

function metadata(rootPid = 4321): SessionProcessMetadata {
  return {
    rootPid,
    shellCommand: 'powershell.exe',
    shellArgs: [],
    shellType: 'powershell',
    cwd: 'C:/work',
    platform: 'win32',
    backend: 'conpty',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'win32net:4321:2026-09-21T01:00:00.0000000Z',
  } as SessionProcessMetadata;
}

type ExecCall = { file: string; args: readonly string[] };

function recordingExecFile(calls: ExecCall[], stdoutFor: (call: ExecCall) => string | Error) {
  return ((
    file: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const call = { file, args };
    calls.push(call);
    const outcome = stdoutFor(call);
    queueMicrotask(() => {
      if (outcome instanceof Error) callback(outcome, '', '');
      else callback(null, outcome, '');
    });
    return {} as never;
  }) as never;
}

const IDENTITY_STDOUT = '2026-09-21T01:00:00.0000000Z\n';
const OPTIONS = { gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 64 };

/** Identity query answers live before the kill and absent after it. */
function winTerminator(killStdout: string | Error) {
  const calls: ExecCall[] = [];
  let killed = false;
  const execFileFn = recordingExecFile(calls, (call) => {
    const script = String(call.args[call.args.length - 1]);
    if (script.includes('CreateToolhelp32Snapshot')) {
      if (killStdout instanceof Error) return killStdout;
      killed = true;
      return killStdout;
    }
    return killed ? '\n' : IDENTITY_STDOUT;
  });
  return { terminator: new DefaultProcessTreeTerminator({ platform: 'win32', execFileFn }), calls };
}

// --- the tool itself -------------------------------------------------------

test('PERF-BGSTAB-014 AC-1 the verified kill no longer shells out to taskkill', async () => {
  const { terminator, calls } = winTerminator('killed=4321\n');
  const result = await terminator.terminate(metadata(), OPTIONS);

  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.filter(call => call.file === 'taskkill.exe'), []);
  assert.ok(
    calls.some(call => call.file === 'powershell.exe' && String(call.args.at(-1)).includes('CreateToolhelp32Snapshot')),
    'the kill must run the toolhelp script',
  );
});

test('PERF-BGSTAB-014 AC-2 the kill script enumerates without WMI', () => {
  const script = buildWindowsProcessTreeKillScript(4321);
  assert.match(script, /CreateToolhelp32Snapshot/);
  for (const banned of ['Get-CimInstance', 'Get-WmiObject', 'Win32_Process', 'ManagementObjectSearcher']) {
    assert.ok(!script.includes(banned), `kill script must not use ${banned}`);
  }
});

// --- the safety content AC-3 of FR-BGSTAB-011 protects ---------------------

test('PERF-BGSTAB-014 AC-3 the kill script targets PIDs only, never image names', () => {
  const script = buildWindowsProcessTreeKillScript(4321);
  // The whole point of the requirement being superseded: no name-based kill.
  for (const banned of ['/IM', '-IM', '-Name', 'ProcessName', 'szExeFile', 'taskkill', 'killall', 'pkill']) {
    assert.ok(!script.includes(banned), `kill script must not reference ${banned}`);
  }
  // Every kill goes through a numeric PID lookup.
  assert.match(script, /GetProcessById/);
  assert.ok(!/Stop-Process/i.test(script), 'Stop-Process takes names and is not used');
});

test('PERF-BGSTAB-014 AC-3 the root pid is interpolated as a bare integer', () => {
  const script = buildWindowsProcessTreeKillScript(4321);
  assert.match(script, /\$root\s*=\s*4321\b/);
  // A non-integer can never reach the script: the caller normalises first, but
  // pin it here too because this string is handed to a shell interpreter.
  assert.throws(() => buildWindowsProcessTreeKillScript(Number('12; whoami') as number));
  assert.throws(() => buildWindowsProcessTreeKillScript(-1));
  assert.throws(() => buildWindowsProcessTreeKillScript(1.5));
});

test('PERF-BGSTAB-014 AC-3 the walk is rooted at the verified pid and kills leaves first', () => {
  const script = buildWindowsProcessTreeKillScript(4321);
  // Descendants are reversed before the root is touched, so a parent is never
  // killed while its children are still being discovered.
  assert.match(script, /for\s*\(\$i\s*=\s*\$order\.Count\s*-\s*1/);
  const rootKillIndex = script.lastIndexOf('$root');
  const descendantKillIndex = script.indexOf('$order[$i]');
  assert.ok(descendantKillIndex > -1 && rootKillIndex > descendantKillIndex, 'root must be killed last');
});

// --- reporting -------------------------------------------------------------

test('PERF-BGSTAB-014 AC-4 terminatedPids come from what the script reported killing', async () => {
  const { terminator } = winTerminator('descendants=5001,5002 killed=5002,5001,4321\n');
  const result = await terminator.terminate(metadata(), OPTIONS);

  assert.equal(result.method, 'windows-verified-tree-kill');
  assert.deepEqual(result.terminatedPids, [5002, 5001, 4321]);
  assert.equal(result.status, 'completed');
});

test('PERF-BGSTAB-014 AC-4 parseWindowsKilledPids ignores anything that is not a pid list', () => {
  assert.deepEqual(parseWindowsKilledPids('killed=5002,5001,4321'), [5002, 5001, 4321]);
  assert.deepEqual(parseWindowsKilledPids('descendants=1,2 killed=3'), [3]);
  assert.deepEqual(parseWindowsKilledPids('killed='), []);
  assert.deepEqual(parseWindowsKilledPids(''), []);
  assert.deepEqual(parseWindowsKilledPids('unexpected output'), []);
  // A duplicate or a nonsense entry must not become a reported termination.
  assert.deepEqual(parseWindowsKilledPids('killed=7,7,0,-3,abc,8'), [7, 8]);
});

test('PERF-BGSTAB-014 AC-5 a failed kill is reported as failed, not silently completed', async () => {
  const { terminator } = winTerminator(new Error('powershell exited 1'));
  const result = await terminator.terminate(metadata(), OPTIONS);

  assert.equal(result.status, 'failed');
  assert.equal(result.method, 'windows-verified-tree-kill');
  assert.deepEqual(result.remainingPids, [4321]);
});

test('PERF-BGSTAB-014 AC-5 an unverified root is never handed to the kill script', async () => {
  const calls: ExecCall[] = [];
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    execFileFn: recordingExecFile(calls, () => IDENTITY_STDOUT),
  });
  const result = await terminator.terminate(
    metadata() && { ...metadata(), osStartIdentity: 'win32:4321:2026-09-21T01:00:00.000000Z' } as SessionProcessMetadata,
    OPTIONS,
  );
  assert.equal(result.status, 'skipped-unverified');
  assert.ok(
    !calls.some(call => String(call.args.at(-1)).includes('CreateToolhelp32Snapshot')),
    'identity mismatch must stop before the kill',
  );
});
