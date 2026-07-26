import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const pathEnvKey = 'FAIR_READMISSION_CLOSURE_V3_REPARSE_PATH_BASE64';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function recordSpawn(result) {
  const calls = [];
  return {
    calls,
    spawnSync(executable, argv, options) {
      calls.push({ executable, argv, options });
      if (result instanceof Error) return { error: result, status: null, stdout: '', stderr: '' };
      return result;
    },
  };
}

function trustedPowerShellFs() {
  return {
    lstatSync(candidate) {
      const isLeaf = path.win32.normalize(candidate) === trustedPowerShell;
      return {
        isFile: () => isLeaf,
        isSymbolicLink: () => false,
        isReparsePoint: () => false,
      };
    },
    realpathSync: {
      native: () => trustedPowerShell,
    },
  };
}

function probeOptions(spawnSync, candidate = 'C:\\Work\\kiwi-run-output\\ancestor') {
  return {
    path: candidate,
    spawnSync,
    fs: trustedPowerShellFs(),
    platform: 'win32',
  };
}

function assertFixedPowerShellInvocation(call, candidate) {
  assert.equal(
    call.executable,
    trustedPowerShell,
  );
  assert.equal(call.argv.includes(candidate), false, 'a dynamic candidate path must not appear in argv');
  assert.equal(call.argv.includes(Buffer.from(candidate, 'utf8').toString('base64')), false, 'the candidate Base64 value must not appear in argv');
  assert.equal(call.argv.includes('-EncodedCommand'), true);
  assert.match(call.argv[call.argv.indexOf('-EncodedCommand') + 1], /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(call.options.env[pathEnvKey], Buffer.from(candidate, 'utf8').toString('base64'));
  assert.equal(call.options.encoding, 'utf8');
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false, 'the strict probe must not invoke a shell');
  assert.equal(Number.isFinite(call.options.timeout) && call.options.timeout > 0, true);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe'], 'the strict probe must capture stderr');

  const encodedProgram = Buffer.from(call.argv[call.argv.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.match(encodedProgram, new RegExp(`\\$env:${pathEnvKey}`));
  assert.match(encodedProgram, /\[System\.IO\.File\]::GetAttributes/);
  assert.match(encodedProgram, /\[System\.IO\.FileAttributes\]::ReparsePoint/);
}

test('SDS-AC-1/2 accepts only a normal zero probe through fixed PowerShell argv and Base64 child env', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const first = recordSpawn({ status: 0, stdout: '0\n', stderr: '' });
  const second = recordSpawn({ status: 0, stdout: '0\n', stderr: '' });
  const firstCandidate = 'C:\\Work\\kiwi-run-output\\normal';
  const secondCandidate = 'C:\\Work\\kiwi-run-output\\different-normal';

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.equal(probeWindowsReparsePoint(probeOptions(first.spawnSync, firstCandidate)), false);
  assert.equal(probeWindowsReparsePoint(probeOptions(second.spawnSync, secondCandidate)), false);
  assert.equal(first.calls.length, 1);
  assert.equal(second.calls.length, 1);
  assertFixedPowerShellInvocation(first.calls[0], firstCandidate);
  assertFixedPowerShellInvocation(second.calls[0], secondCandidate);
  assert.deepEqual(first.calls[0].argv, second.calls[0].argv, 'the encoded program and argv must remain fixed across candidate paths');
});

test('SDS-AC-1 rejects a Windows ReparsePoint result even without a symbolic-link result', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const probe = recordSpawn({ status: 0, stdout: '1\n', stderr: '' });

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.equal(probeWindowsReparsePoint(probeOptions(probe.spawnSync)), true);
  assert.equal(probe.calls.length, 1);
});

test('SDS-AC-3 fails closed on malformed probe output, child error, timeout, or captured stderr', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const malformed = recordSpawn({ status: 0, stdout: '0\nextra\n', stderr: '' });
  const childError = recordSpawn(Object.assign(new Error('child process failed'), { code: 1 }));
  const timeout = recordSpawn(Object.assign(new Error('child timed out'), { code: 'ETIMEDOUT' }));
  const stderr = recordSpawn({ status: 0, stdout: '0\n', stderr: 'warning\n' });

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  for (const [name, probe] of [
    ['malformed output', malformed],
    ['child error', childError],
    ['timeout', timeout],
    ['captured stderr', stderr],
  ]) {
    assert.throws(
      () => probeWindowsReparsePoint(probeOptions(probe.spawnSync)),
      /reparse|probe|fail.closed|PowerShell/i,
      `${name} must fail closed`,
    );
    assert.equal(probe.calls.length, 1);
  }
});

function segmentStat(identity, { symbolicLink = false, reparsePoint = false } = {}) {
  return {
    dev: identity.dev,
    ino: identity.ino,
    mode: identity.mode,
    ctimeMs: identity.ctimeMs,
    mtimeMs: identity.mtimeMs,
    size: identity.size,
    isSymbolicLink: () => symbolicLink,
    isReparsePoint: () => reparsePoint,
  };
}

function segmentIdentity(seed) {
  return {
    dev: 1,
    ino: seed,
    mode: 0o100644,
    ctimeMs: 1000 + seed,
    mtimeMs: 2000 + seed,
    size: 3000 + seed,
  };
}

function lstatSequence(...entries) {
  const calls = [];
  let index = 0;
  return {
    calls,
    lstatSync(candidate) {
      calls.push(candidate);
      const entry = entries[Math.min(index, entries.length - 1)];
      index += 1;
      if (entry instanceof Error) throw entry;
      return entry;
    },
  };
}

test('SDS-AC-1 fresh-lstats an unchanged segment while reusing its one safe probe in one guard', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const candidate = 'C:/Work/kiwi-run-output/ancestor';
  const fs = lstatSequence(segmentStat(segmentIdentity(1)), segmentStat(segmentIdentity(1)));
  const probeCalls = [];
  const guard = createSegmentReparseGuard({
    fs,
    probe(pathname) {
      probeCalls.push(pathname);
      return false;
    },
  });

  assert.equal(typeof createSegmentReparseGuard, 'function');
  assert.equal(typeof guard?.assertSafe, 'function');
  guard.assertSafe(candidate);
  guard.assertSafe(candidate);
  assert.equal(fs.calls.length, 2, 'each ordinary read must fresh-lstat its segment');
  assert.deepEqual(probeCalls, [candidate], 'the unchanged identity may reuse only its safe same-capture probe');
});

test('SDS-AC-2 discards an identity cache entry, re-probes, and fails closed when the replacement is unsafe', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const candidate = 'C:/Work/kiwi-run-output/identity-changes';
  const fs = lstatSequence(segmentStat(segmentIdentity(1)), segmentStat(segmentIdentity(2)));
  const probeCalls = [];
  const guard = createSegmentReparseGuard({
    fs,
    probe(pathname) {
      probeCalls.push(pathname);
      return probeCalls.length === 2;
    },
  });

  assert.equal(typeof createSegmentReparseGuard, 'function');
  assert.equal(typeof guard?.assertSafe, 'function');
  guard.assertSafe(candidate);
  assert.throws(() => guard.assertSafe(candidate), /reparse|unsafe|link|fail.closed/i);
  assert.equal(fs.calls.length, 2);
  assert.deepEqual(probeCalls, [candidate, candidate], 'a changed identity must discard the safe cache and re-probe');
});

test('SDS-AC-2 never caches probe errors or unsafe probe results', async () => {
  const cases = [
    {
      name: 'probe error',
      values: [new Error('PowerShell failure'), false],
      failure: /PowerShell|probe|reparse|fail.closed/i,
    },
    {
      name: 'unsafe probe result',
      values: [true, false],
      failure: /reparse|unsafe|link|fail.closed/i,
    },
  ];

  for (const { name, values, failure } of cases) {
    const { createSegmentReparseGuard } = await loadCollector();
    const candidate = `C:/Work/kiwi-run-output/${name.replaceAll(' ', '-')}`;
    const fs = lstatSequence(segmentStat(segmentIdentity(3)), segmentStat(segmentIdentity(3)));
    const probeCalls = [];
    const guard = createSegmentReparseGuard({
      fs,
      probe(pathname) {
        probeCalls.push(pathname);
        const value = values.shift();
        if (value instanceof Error) throw value;
        return value;
      },
    });

    assert.equal(typeof createSegmentReparseGuard, 'function');
    assert.equal(typeof guard?.assertSafe, 'function');
    assert.throws(() => guard.assertSafe(candidate), failure, `${name} must fail closed`);
    guard.assertSafe(candidate);
    assert.equal(fs.calls.length, 2, `${name} still requires fresh lstat on retry`);
    assert.deepEqual(probeCalls, [candidate, candidate], `${name} must not poison or populate the safe cache`);
  }
});

test('SDS-AC-3 forceFresh bypasses the cache and issues a new probe at a boundary', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const candidate = 'C:/Work/kiwi-run-output/manifest-boundary';
  const fs = lstatSequence(
    segmentStat(segmentIdentity(4)),
    segmentStat(segmentIdentity(4)),
    segmentStat(segmentIdentity(4)),
  );
  const probeCalls = [];
  const guard = createSegmentReparseGuard({
    fs,
    probe(pathname) {
      probeCalls.push(pathname);
      return false;
    },
  });

  assert.equal(typeof createSegmentReparseGuard, 'function');
  assert.equal(typeof guard?.assertSafe, 'function');
  guard.assertSafe(candidate);
  guard.assertSafe(candidate);
  guard.assertSafe(candidate, { forceFresh: true });
  assert.equal(fs.calls.length, 3);
  assert.deepEqual(probeCalls, [candidate, candidate], 'forceFresh must bypass an unchanged safe cache entry');
});

test('SDS-AC-4 gives every guard an isolated cache and keeps path casing distinct after slash normalization', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const canonicalCandidate = 'C:/Work/kiwi-run-output/CaseSensitive/Segment';
  const caseVariant = 'C:/Work/kiwi-run-output/CaseSensitive/segment';
  const fs = lstatSequence(
    segmentStat(segmentIdentity(5)),
    segmentStat(segmentIdentity(5)),
    segmentStat(segmentIdentity(5)),
    segmentStat(segmentIdentity(5)),
  );
  const probeCalls = [];
  const probe = pathname => {
    probeCalls.push(pathname);
    return false;
  };
  const firstGuard = createSegmentReparseGuard({ fs, probe });
  const secondGuard = createSegmentReparseGuard({ fs, probe });

  assert.equal(typeof createSegmentReparseGuard, 'function');
  firstGuard.assertSafe(canonicalCandidate.replaceAll('/', '\\'));
  firstGuard.assertSafe(canonicalCandidate);
  firstGuard.assertSafe(caseVariant);
  secondGuard.assertSafe(canonicalCandidate);
  assert.equal(fs.calls.length, 4, 'every validation must fresh-lstat');
  assert.deepEqual(
    probeCalls,
    [canonicalCandidate.replaceAll('/', '\\'), caseVariant, canonicalCandidate],
    'slash spelling may normalize, but a case variant and a new guard must not share a cache entry',
  );
});
