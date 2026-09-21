import assert from 'node:assert/strict';
import test from 'node:test';

import { DefaultProcessTreeTerminator } from './processTreeTerminator.js';
import type { SessionProcessMetadata } from '../types/ws-protocol.js';

/**
 * PERF-BGSTAB-012 AC-3/AC-4.
 *
 * The post-kill verification asks whether each sampled descendant is still
 * alive. It used to ask that through `processInfoProvider`, whose Windows
 * implementation runs `Get-CimInstance Win32_Process` over every process on the
 * machine — measured on a 1289-process host at 3.0s, 3.4s and 3.6s. One such
 * enumeration per descendant put a session close at 16.8s for three descendants
 * and 32.8s for eight, while `WorkspaceService.deleteTab` awaited all of it.
 *
 * Liveness is a one-PID question, so it goes through a probe that answers it
 * directly. The number of full enumerations must not depend on how many
 * descendants were sampled.
 */

function metadata(overrides: Partial<SessionProcessMetadata> = {}): SessionProcessMetadata {
  return {
    rootPid: 123,
    shellCommand: 'powershell.exe',
    shellArgs: [],
    shellType: 'powershell',
    cwd: process.cwd(),
    platform: 'win32',
    backend: 'conpty',
    launchedAt: new Date().toISOString(),
    osStartIdentity: 'win32:123:started',
    ...overrides,
  } as SessionProcessMetadata;
}

function windowsTerminator(
  descendants: number[],
  live: Set<number>,
  probe?: (pid: number) => boolean,
) {
  const providerCalls: number[] = [];
  const probeCalls: number[] = [];
  let killed = false;
  const terminator = new DefaultProcessTreeTerminator({
    platform: 'win32',
    processInfoProvider: async (pid: number) => {
      providerCalls.push(pid);
      if (pid !== 123) {
        return { pid, running: live.has(pid), startIdentity: `win32:${pid}:started`, cwd: null, childPids: [] };
      }
      return killed
        ? { pid, running: false, startIdentity: null, cwd: null, childPids: [] }
        : { pid, running: true, startIdentity: 'win32:123:started', cwd: null, childPids: descendants };
    },
    processLivenessProbe: (pid: number) => {
      probeCalls.push(pid);
      return probe ? probe(pid) : live.has(pid);
    },
    execFileFn: ((file: string, _args: string[], _opts: unknown, cb: (error: null) => void) => {
      if (file === 'taskkill.exe') killed = true;
      setTimeout(() => cb(null), 0);
      return {} as never;
    }) as never,
  });
  return { terminator, providerCalls, probeCalls };
}

const OPTIONS = { gracefulWaitMs: 0, forceWaitMs: 0, descendantSampleLimit: 64 };

test('PERF-BGSTAB-012 AC-3 full process enumerations do not scale with the sampled descendant count', async () => {
  const one = windowsTerminator([201], new Set<number>());
  await one.terminator.terminate(metadata(), OPTIONS);

  const many = windowsTerminator([201, 202, 203, 204, 205, 206, 207, 208], new Set<number>());
  await many.terminator.terminate(metadata(), OPTIONS);

  // The claim is "constant", so measure the number itself, not just that the
  // two runs happen to match.
  assert.equal(one.providerCalls.length, 2, `one descendant: ${JSON.stringify(one.providerCalls)}`);
  assert.equal(many.providerCalls.length, 2, `eight descendants: ${JSON.stringify(many.providerCalls)}`);
  assert.deepEqual(many.providerCalls, [123, 123]);

  // Control: the descendants really were checked, just not by enumeration.
  assert.deepEqual(many.probeCalls, [201, 202, 203, 204, 205, 206, 207, 208]);
});

test('PERF-BGSTAB-012 AC-4 a sampled descendant that outlives the root is still reported unverified', async () => {
  const { terminator, probeCalls } = windowsTerminator([201, 202], new Set([202]));
  const result = await terminator.terminate(metadata(), OPTIONS);

  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.unverifiedPids, [202]);
  assert.deepEqual(probeCalls, [201, 202]);
});

test('PERF-BGSTAB-012 AC-4 control: cleanup completes when every sampled descendant is gone', async () => {
  const { terminator } = windowsTerminator([201, 202], new Set<number>());
  const result = await terminator.terminate(metadata(), OPTIONS);

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.unverifiedPids, []);
  assert.deepEqual(result.remainingPids, []);
});

test('PERF-BGSTAB-012 AC-4 a probe that throws is treated as a possible survivor', async () => {
  const { terminator, probeCalls } = windowsTerminator([201], new Set<number>(), () => {
    throw new Error('probe failed');
  });

  const result = await terminator.terminate(metadata(), OPTIONS);
  assert.deepEqual(probeCalls, [201], 'the probe must actually be consulted');
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.unverifiedPids, [201]);
});
