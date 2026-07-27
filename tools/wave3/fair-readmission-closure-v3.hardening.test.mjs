import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const fixtureRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function regularStat({ file = false, link = false, reparse = false } = {}) {
  return {
    isFile: () => file,
    isSymbolicLink: () => link,
    isReparsePoint: () => reparse,
  };
}

function trustedPowerShellFs({ leaf = regularStat({ file: true }), realpath = trustedPowerShell } = {}) {
  return {
    lstatSync(candidate) {
      return path.win32.normalize(candidate) === trustedPowerShell ? leaf : regularStat();
    },
    realpathSync: {
      native() {
        return realpath;
      },
    },
  };
}

function batchSuccess(paths) {
  const canonicalPaths = JSON.stringify(paths.map(candidate => candidate.replaceAll('\\', '/')));
  const digest = createHash('sha256').update(canonicalPaths, 'utf8').digest('hex');
  return `FRRPB1:${paths.length}:${digest}\n`;
}

test('SDS-AC-1 uses an injected spawnSync result and rejects success-status stderr before admitting a batch', async () => {
  const { probeWindowsReparsePoints } = await loadCollector();
  const paths = ['C:/Work/closure/one'];
  const calls = [];
  const spawnSync = (executable, argv, options) => {
    calls.push({ executable, argv, options });
    return { status: 0, stdout: batchSuccess(paths), stderr: 'unexpected warning\n' };
  };

  assert.equal(typeof probeWindowsReparsePoints, 'function');
  assert.throws(
    () => probeWindowsReparsePoints({
      paths,
      spawnSync,
      fs: trustedPowerShellFs(),
      platform: 'win32',
      env: {
        SystemRoot: 'D:\\poisoned-system-root',
        WINDIR: 'D:\\poisoned-windir',
        PATH: 'D:\\poisoned-path',
        ComSpec: 'D:\\poisoned-comspec.exe',
      },
    }),
    /stderr|reparse|probe|fail.closed/i,
  );
  assert.equal(calls.length, 1, 'the injected child must be used exactly once');
  assert.equal(calls[0].executable, trustedPowerShell);
  assert.equal(calls[0].argv.includes('-EncodedCommand'), true);
  assert.equal(calls[0].options.encoding, 'utf8');
  assert.equal(calls[0].options.windowsHide, true);
});

test('SDS-AC-2 resolves only the literal trusted PowerShell binary despite poisoned process environment', async () => {
  const { resolveTrustedWindowsPowerShell } = await loadCollector();
  const prior = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'ComSpec'].map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    SystemRoot: 'D:\\poisoned-system-root',
    WINDIR: 'D:\\poisoned-windir',
    PATH: 'D:\\poisoned-path',
    ComSpec: 'D:\\poisoned-comspec.exe',
  });
  try {
    assert.equal(typeof resolveTrustedWindowsPowerShell, 'function');
    assert.equal(
      resolveTrustedWindowsPowerShell({ fs: trustedPowerShellFs(), platform: 'win32' }),
      trustedPowerShell,
    );
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('SDS-AC-2 rejects missing, non-file, link, reparse, and realpath-divergent trusted candidates before launch', async () => {
  const { resolveTrustedWindowsPowerShell } = await loadCollector();
  const failures = [
    ['missing', { fs: { ...trustedPowerShellFs(), lstatSync: () => { throw new Error('ENOENT'); } } }],
    ['non-file', { fs: trustedPowerShellFs({ leaf: regularStat() }) }],
    ['link', { fs: trustedPowerShellFs({ leaf: regularStat({ file: true, link: true }) }) }],
    ['reparse', { fs: trustedPowerShellFs({ leaf: regularStat({ file: true, reparse: true }) }) }],
    ['realpath mismatch', { fs: trustedPowerShellFs({ realpath: 'C:\\Windows\\System32\\not-powershell.exe' }) }],
  ];

  assert.equal(typeof resolveTrustedWindowsPowerShell, 'function');
  for (const [label, options] of failures) {
    assert.throws(
      () => resolveTrustedWindowsPowerShell({ ...options, platform: 'win32' }),
      /PowerShell|trusted|file|link|reparse|realpath|inspect/i,
      `${label} candidate must fail before any child launch`,
    );
  }
});

test('SDS-AC-3 rejects volume-qualified, absolute, UNC, and escaping fixture values before returning an evidence-root path', async () => {
  const { resolveFixturePath } = await loadCollector();

  assert.equal(typeof resolveFixturePath, 'function');
  assert.equal(
    resolveFixturePath({ workspaceRoot, fixtureRoot, value: 'raw/observed.json' }),
    path.win32.join(workspaceRoot, fixtureRoot, 'raw', 'observed.json'),
  );
  for (const value of [
    'C:/outside.json',
    'D:/outside.json',
    'D:relative.json',
    '\\\\server\\share\\outside.json',
    '/absolute.json',
    '..\\outside.json',
    'raw/../../outside.json',
  ]) {
    assert.throws(
      () => resolveFixturePath({ workspaceRoot, fixtureRoot, value }),
      /fixture|unsafe|absolute|volume|escape|root/i,
      `${value} must be rejected before an outside-root read`,
    );
  }
});

test('SDS-AC-4 low-level protected snapshot force-fresh checks a config lock identity immediately before and after its hash read', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  const events = [];
  const configPath = path.win32.join(workspaceRoot, 'server', 'config.json5').replaceAll('\\', '/');
  const fs = {
    existsSync(candidate) {
      events.push(`exists:${candidate}`);
      return true;
    },
    statSync(candidate) {
      events.push(`stat:${candidate}`);
      return regularStat({ file: true });
    },
    readFileSync(candidate) {
      events.push(`read:${candidate}`);
      return Buffer.from('{ "locked": true }\n', 'utf8');
    },
  };
  const reparseGuard = {
    assertSafeMany(paths, options) {
      events.push(`guard:${paths.join(',')}:${JSON.stringify(options)}`);
      assert.deepEqual(paths, [configPath]);
      assert.deepEqual(options, { forceFresh: true });
    },
  };

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  const input = createProtectedInputSnapshot({ fs, reparseGuard }).read({
    absolutePath: configPath,
    kind: 'config_lock',
    path: 'server/config.json5',
  });
  assert.deepEqual(
    {
      kind: input.kind,
      path: input.path,
      sha256: input.sha256,
    },
    {
      kind: 'config_lock',
      path: 'server/config.json5',
      sha256: createHash('sha256').update('{ "locked": true }\n', 'utf8').digest('hex'),
    },
  );
  const guardEvent = `guard:${configPath}:${JSON.stringify({ forceFresh: true })}`;
  assert.deepEqual(
    events.slice(-3),
    [guardEvent, `read:${configPath}`, guardEvent],
    'the success path must force-fresh guard immediately before and after the config byte read',
  );
});

test('SDS-AC-4 low-level protected snapshot fails before a config read when its force-fresh identity guard detects a change', async () => {
  const { createProtectedInputSnapshot } = await loadCollector();
  let readCount = 0;
  const fs = {
    existsSync: () => true,
    statSync: () => regularStat({ file: true }),
    readFileSync() {
      readCount += 1;
      return Buffer.from('must not be read', 'utf8');
    },
  };
  const reparseGuard = {
    assertSafeMany(_paths, options) {
      assert.deepEqual(options, { forceFresh: true });
      throw new Error('identity changed during reparse probe');
    },
  };

  assert.equal(typeof createProtectedInputSnapshot, 'function');
  assert.throws(
    () => createProtectedInputSnapshot({ fs, reparseGuard }).read({
      absolutePath: path.win32.join(workspaceRoot, 'server', 'config.json5'),
      kind: 'config_lock',
      path: 'server/config.json5',
    }),
    /identity|reparse|config/i,
  );
  assert.equal(readCount, 0, 'config content must not be read after a failed fresh identity check');
});
