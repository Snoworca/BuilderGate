import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

const systemRoot = 'C:\\Windows';
const pathEnvKey = 'FAIR_READMISSION_CLOSURE_V3_REPARSE_PATH_BASE64';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function recordExec(result) {
  const calls = [];
  return {
    calls,
    execFileSync(executable, argv, options) {
      calls.push({ executable, argv, options });
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function probeOptions(execFileSync, candidate = 'C:\\Work\\kiwi-run-output\\ancestor') {
  return {
    path: candidate,
    execFileSync,
    env: { SystemRoot: systemRoot },
  };
}

function assertFixedPowerShellInvocation(call, candidate) {
  assert.equal(
    call.executable,
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  );
  assert.equal(call.argv.includes(candidate), false, 'a dynamic candidate path must not appear in argv');
  assert.equal(call.argv.includes(Buffer.from(candidate, 'utf8').toString('base64')), false, 'the candidate Base64 value must not appear in argv');
  assert.equal(call.argv.includes('-EncodedCommand'), true);
  assert.match(call.argv[call.argv.indexOf('-EncodedCommand') + 1], /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(call.options.env[pathEnvKey], Buffer.from(candidate, 'utf8').toString('base64'));
  assert.equal(call.options.encoding, 'utf8');
  assert.equal(call.options.windowsHide, true);
  assert.equal(Number.isFinite(call.options.timeout) && call.options.timeout > 0, true);

  const encodedProgram = Buffer.from(call.argv[call.argv.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(encodedProgram, new RegExp(`\\$env:${pathEnvKey}`));
  assert.match(encodedProgram, /\[System\.IO\.File\]::GetAttributes/);
  assert.match(encodedProgram, /\[System\.IO\.FileAttributes\]::ReparsePoint/);
}

test('SDS-AC-1/2 accepts only a normal zero probe through fixed PowerShell argv and Base64 child env', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const first = recordExec('0\n');
  const second = recordExec('0\n');
  const firstCandidate = 'C:\\Work\\kiwi-run-output\\normal';
  const secondCandidate = 'C:\\Work\\kiwi-run-output\\different-normal';

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.equal(probeWindowsReparsePoint(probeOptions(first.execFileSync, firstCandidate)), false);
  assert.equal(probeWindowsReparsePoint(probeOptions(second.execFileSync, secondCandidate)), false);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assertFixedPowerShellInvocation(first.calls[0], firstCandidate);
  assertFixedPowerShellInvocation(second.calls[0], secondCandidate);
  assert.deepEqual(first.calls[0].argv, second.calls[0].argv, 'the encoded program and argv must remain fixed across candidate paths');
});

test('SDS-AC-1 rejects a Windows ReparsePoint result even without a symbolic-link result', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const probe = recordExec('1\n');

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.equal(probeWindowsReparsePoint(probeOptions(probe.execFileSync)), true);
  assert.equal(probe.calls.length, 1);
});

test('SDS-AC-3 fails closed on malformed probe output, child error, timeout, or missing SystemRoot', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const malformed = recordExec('0\nextra\n');
  const childError = recordExec(Object.assign(new Error('child process failed'), { code: 1 }));
  const timeout = recordExec(Object.assign(new Error('child timed out'), { code: 'ETIMEDOUT' }));
  const missingSystemRoot = recordExec('0\n');

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  for (const [name, probe] of [
    ['malformed output', malformed],
    ['child error', childError],
    ['timeout', timeout],
  ]) {
    assert.throws(
      () => probeWindowsReparsePoint(probeOptions(probe.execFileSync)),
      /reparse|probe|fail.closed|PowerShell/i,
      `${name} must fail closed`,
    );
    assert.equal(probe.calls.length, 1);
  }
  assert.throws(
    () => probeWindowsReparsePoint({
      path: 'C:\\Work\\kiwi-run-output\\missing-system-root',
      execFileSync: missingSystemRoot.execFileSync,
      env: {},
    }),
    /SystemRoot|reparse|probe|fail.closed/i,
  );
  assert.equal(missingSystemRoot.calls.length, 0, 'the probe must not launch without an absolute Windows PowerShell path');
});
