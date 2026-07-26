import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import test from 'node:test';

const trustedPowerShell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const batchEnvKey = 'FAIR_READMISSION_CLOSURE_V3_REPARSE_BATCH_PATHS_BASE64';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
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

function batchSuccess(options) {
  const paths = JSON.parse(Buffer.from(options.env[batchEnvKey], 'base64').toString('utf8'));
  const canonical = JSON.stringify(paths);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `FRRPB1:${paths.length}:${digest}\n`;
}

function recordSpawn(result) {
  const calls = [];
  return {
    calls,
    spawnSync(executable, argv, options) {
      calls.push({ executable, argv, options });
      return typeof result === 'function' ? result(options) : result;
    },
  };
}

function probeOptions(spawnSync, candidate = 'C:/Work/kiwi-run-output/ancestor') {
  return {
    path: candidate,
    spawnSync,
    fs: trustedPowerShellFs(),
    platform: 'win32',
  };
}

test('SDS-AC-1 delegates the public one-path wrapper to the same FRRPB1 batch child contract', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const candidate = 'C:/Work/kiwi-run-output/normal';
  const probe = recordSpawn(batchSuccess);

  assert.equal(typeof probeWindowsReparsePoint, 'function');
  assert.equal(probeWindowsReparsePoint(probeOptions(probe.spawnSync, candidate)), false);
  assert.equal(probe.calls.length, 1);
  assert.equal(probe.calls[0].executable, trustedPowerShell);
  assert.deepEqual(
    JSON.parse(Buffer.from(probe.calls[0].options.env[batchEnvKey], 'base64').toString('utf8')),
    [candidate],
    'the one-path wrapper must pass one path only through the batch Base64 input',
  );
  assert.equal(Object.hasOwn(probe.calls[0].options.env, 'FAIR_READMISSION_CLOSURE_V3_REPARSE_PATH_BASE64'), false);
  const commandIndex = probe.calls[0].argv.indexOf('-EncodedCommand');
  const encodedProgram = Buffer.from(probe.calls[0].argv[commandIndex + 1], 'base64').toString('utf16le');
  assert.match(encodedProgram, new RegExp(`\\$env:${batchEnvKey}`));
  assert.match(encodedProgram, /FRRPB1/);
});

test('SDS-AC-1 rejects the removed public leaf-only guard probe API', async () => {
  const { createSegmentReparseGuard } = await loadCollector();
  let legacyCalls = 0;

  assert.equal(typeof createSegmentReparseGuard, 'function');
  assert.throws(
    () => createSegmentReparseGuard({
      fs: { lstatSync: () => { throw new Error('must not lstat'); } },
      probe() {
        legacyCalls += 1;
        return false;
      },
    }),
    /probeBatch|batch|legacy|unsupported/i,
  );
  assert.equal(legacyCalls, 0);
});

test('SDS-AC-2 fails closed for an unsafe or malformed one-path batch result', async () => {
  const { probeWindowsReparsePoint } = await loadCollector();
  const cases = [
    ['unsafe reparse', { status: 1, stdout: '', stderr: '' }],
    ['malformed success', { status: 0, stdout: '0\n', stderr: '' }],
    ['child error', { error: new Error('child failed'), status: null, stdout: '', stderr: '' }],
    ['stderr', options => ({ status: 0, stdout: batchSuccess(options), stderr: 'warning\n' })],
  ];

  for (const [label, result] of cases) {
    const probe = recordSpawn(result);
    assert.throws(
      () => probeWindowsReparsePoint(probeOptions(probe.spawnSync)),
      /reparse|probe|batch|FRRPB1|fail.closed|PowerShell|stderr/i,
      `${label} must not admit the path`,
    );
    assert.equal(probe.calls.length, 1);
  }
});
