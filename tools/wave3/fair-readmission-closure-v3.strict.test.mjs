import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const fixtureRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function regularStat(seed = 1, { file = false, link = false, reparse = false } = {}) {
  return {
    dev: 1,
    ino: seed,
    mode: file ? 0o100755 : 0o040755,
    ctimeMs: 1000 + seed,
    mtimeMs: 2000 + seed,
    size: 3000 + seed,
    isFile: () => file,
    isSymbolicLink: () => link,
    isReparsePoint: () => reparse,
  };
}

function trustedPowerShellFs() {
  return {
    lstatSync(candidate) {
      return regularStat(1, { file: path.win32.normalize(candidate) === trustedPowerShell });
    },
    realpathSync: {
      native: () => trustedPowerShell,
    },
  };
}

function batchSuccess(paths) {
  const canonical = JSON.stringify(paths.map(candidate => candidate.replaceAll('\\', '/')));
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `FRRPB1:${paths.length}:${digest}\n`;
}

function strictProbeOptions(spawnSync) {
  return {
    spawnSync,
    fs: trustedPowerShellFs(),
    platform: 'win32',
    env: {
      SystemRoot: 'D:\\poisoned-system-root',
      SYSTEMROOT: 'D:\\poisoned-system-root-uppercase',
      WINDIR: 'D:\\poisoned-windir',
      PATH: 'D:\\poisoned-path',
      ComSpec: 'D:\\poisoned-comspec.exe',
    },
  };
}

function existingFrontier(candidate) {
  const normalized = candidate.replaceAll('\\', '/');
  const segments = normalized.split('/').filter(Boolean);
  return segments.slice(1).map((_, index) => `${segments[0]}/${segments.slice(1, index + 2).join('/')}`);
}

test('SDS-AC-1 batch probe never admits an execFileSync compatibility branch selected by a poisoned environment', async () => {
  const { probeWindowsReparsePoints } = await loadCollector();
  const paths = ['C:/Work/closure/legacy-batch'];
  let legacyCalls = 0;

  assert.equal(typeof probeWindowsReparsePoints, 'function');
  assert.throws(
    () => probeWindowsReparsePoints({
      paths,
      execFileSync(executable) {
        legacyCalls += 1;
        assert.equal(executable, 'D:\\poisoned-system-root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        return batchSuccess(paths);
      },
      env: { SystemRoot: 'D:\\poisoned-system-root' },
      platform: 'linux',
    }),
    /Windows|spawnSync|strict|reparse|probe/i,
    'a legacy function must be ignored instead of turning poisoned SystemRoot into an executable path',
  );
  assert.equal(legacyCalls, 0, 'the batch probe must never invoke execFileSync');
});

test('SDS-AC-1 one-path probe never admits an execFileSync compatibility branch selected by a poisoned environment', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  let legacyCalls = 0;

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.throws(
    () => probeWindowsReparsePoint({
      path: 'C:/Work/closure/legacy-one',
      execFileSync(executable) {
        legacyCalls += 1;
        assert.equal(executable, 'D:\\poisoned-system-root\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        return '0\n';
      },
      env: { SystemRoot: 'D:\\poisoned-system-root' },
      platform: 'linux',
    }),
    /Windows|spawnSync|strict|reparse|probe/i,
    'a one-path legacy function must be ignored instead of turning poisoned SystemRoot into an executable path',
  );
  assert.equal(legacyCalls, 0, 'the one-path probe must never invoke execFileSync');
});

test('SDS-AC-1 accepts only strict injected spawnSync child result objects for both exported probes', async () => {
  const { probeWindowsReparsePoint, probeWindowsReparsePoints } = await loadCollector();
  const cases = [
    ['child error', () => ({ error: new Error('spawn failure'), status: null, stdout: '', stderr: '' })],
    ['missing status', () => ({ stdout: '', stderr: '' })],
    ['nonzero status', () => ({ status: 1, stdout: '', stderr: '' })],
    ['stderr', () => ({ status: 0, stdout: '0\n', stderr: 'warning\n' })],
    ['malformed stdout', () => ({ status: 0, stdout: 'unexpected\n', stderr: '' })],
  ];

  for (const [label, result] of cases) {
    const pointCalls = [];
    assert.throws(
      () => probeWindowsReparsePoint({
        path: 'C:/Work/closure/strict-one',
        ...strictProbeOptions((...args) => {
          pointCalls.push(args);
          return result();
        }),
      }),
      /reparse|probe|PowerShell|fail.closed|stderr/i,
      `one-path ${label} result must fail closed`,
    );
    assert.equal(pointCalls.length, 1, `one-path ${label} must use the injected strict executor once`);
    assert.equal(pointCalls[0][0], trustedPowerShell);

    const batchCalls = [];
    const paths = ['C:/Work/closure/strict-batch'];
    assert.throws(
      () => probeWindowsReparsePoints({
        paths,
        ...strictProbeOptions((...args) => {
          batchCalls.push(args);
          const value = result();
          return value.status === 0 && value.stdout === '0\n'
            ? { ...value, stdout: batchSuccess(paths) }
            : value;
        }),
      }),
      /reparse|probe|PowerShell|fail.closed|stderr|FRRPB1/i,
      `batch ${label} result must fail closed`,
    );
    assert.equal(batchCalls.length, 1, `batch ${label} must use the injected strict executor once`);
    assert.equal(batchCalls[0][0], trustedPowerShell);
  }
});

test('SDS-AC-2 batches every existing ancestor and leaf segment before any protected path is admitted', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const candidate = 'C:/Work/closure/frontier/leaf.json';
  const frontier = existingFrontier(candidate);
  const batches = [];
  const lstatCalls = [];
  const fs = {
    lstatSync(pathname) {
      lstatCalls.push(pathname.replaceAll('\\', '/'));
      return regularStat(frontier.indexOf(pathname.replaceAll('\\', '/')) + 1);
    },
  };
  const guard = createSegmentReparseGuard({
    fs,
    probeBatch(paths) {
      batches.push(paths);
    },
  });

  assert.equal(typeof guard?.assertSafe, 'function');
  assert.doesNotThrow(() => guard.assertSafe(candidate));
  assert.deepEqual(batches, [frontier], 'one successful admission must bind the complete existing segment frontier');
  assert.deepEqual([...new Set(lstatCalls)], frontier, 'every existing ancestor and leaf must be lstat-checked');
});

test('SDS-AC-2 rejects an unsafe ancestor and does not retain a safe cache after a frontier identity change', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  const candidate = 'C:/Work/closure/mutation/leaf.json';
  const frontier = existingFrontier(candidate);
  const batches = [];
  let unsafeAncestor = true;
  let generation = 1;
  const fs = {
    lstatSync(pathname) {
      const normalized = pathname.replaceAll('\\', '/');
      if (unsafeAncestor && normalized === 'C:/Work/closure') return regularStat(generation, { link: true });
      return regularStat(generation + frontier.indexOf(normalized));
    },
  };
  const guard = createSegmentReparseGuard({
    fs,
    probeBatch(paths) {
      batches.push(paths);
      if (batches.length === 1) generation += 100;
    },
  });

  assert.throws(() => guard.assertSafe(candidate), /reparse|link|unsafe|guard/i, 'an unsafe ancestor must fail before batch admission');
  assert.deepEqual(batches, [], 'an unsafe ancestor must not be cached or batched as safe');

  unsafeAncestor = false;
  assert.throws(() => guard.assertSafe(candidate), /identity|changed|reparse|guard/i, 'a frontier identity change during probing must fail closed');
  assert.doesNotThrow(() => guard.assertSafe(candidate), 'a retry must re-probe rather than reuse the rejected frontier');
  assert.deepEqual(batches, [frontier, frontier], 'a rejected identity must never populate the safe cache');
});

test('SDS-AC-3 rejects caller-provided config snapshot authority before native capture can read or publish a row', async () => {
  const collector = await loadCollector();
  const configPath = path.win32.join(workspaceRoot, 'server', 'config.json5').replaceAll('\\', '/');
  const guardCalls = [];
  let reads = 0;
  const fs = {
    existsSync: () => true,
    statSync: () => regularStat(1, { file: true }),
    readFileSync() {
      reads += 1;
      return Buffer.from('{ "changed-during-read": true }\n', 'utf8');
    },
  };
  const reparseGuard = {
    assertSafeMany(paths, options) {
      guardCalls.push({ paths, options });
      assert.deepEqual(paths, [configPath]);
      assert.deepEqual(options, { forceFresh: true });
      if (guardCalls.length === 2) throw new Error('config identity changed during digest read');
    },
  };

  assert.equal(Object.hasOwn(collector, 'createProtectedInputSnapshot'), false, 'the low-level protected snapshot must remain private');
  assert.throws(
    () => collector.captureFrozenProvenance({
      workspaceRoot,
      manifestPath: path.win32.join(workspaceRoot, 'docs', 'analysis', 'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3', 'strict-forged-config.json'),
      phase: 'strict-forged-config',
      fs,
      reparseGuard,
    }),
    /capture options|native|authority|unsupported|forbid|reject/i,
  );
  assert.equal(reads, 0, 'the caller filesystem must not be reached before native admission rejects it');
  assert.equal(guardCalls.length, 0, 'the caller guard must not be reached before native admission rejects it');
});

test('SDS-AC-4 rejects unsafe Windows fixture components while resolving an ordinary descendant exactly below the fixed evidence root', async () => {
  const { resolveFixturePath } = await loadCollector();
  const expected = path.win32.join(workspaceRoot, fixtureRoot, 'raw', 'observed.json');

  assert.equal(typeof resolveFixturePath, 'function');
  assert.equal(
    resolveFixturePath({ workspaceRoot, fixtureRoot, value: 'raw/observed.json' }),
    expected,
  );
  const reserved = ['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)];
  const unsafe = [
    '/absolute.json',
    '\\\\server\\share\\outside.json',
    'C:/outside.json',
    'D:relative.json',
    '../outside.json',
    'raw/../outside.json',
    'raw/stream:alternate',
    'raw/name.',
    'raw/name ',
    ...reserved.flatMap(name => [`raw/${name}`, `raw/${name.toLowerCase()}.json`]),
  ];
  for (const value of unsafe) {
    assert.throws(
      () => resolveFixturePath({ workspaceRoot, fixtureRoot, value }),
      /fixture|unsafe|absolute|volume|escape|root|component/i,
      `${value} must be rejected before an outside-root read or hash`,
    );
  }
});
