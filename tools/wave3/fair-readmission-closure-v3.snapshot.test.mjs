import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const analysisRoot = path.join(
  workspaceRoot,
  'docs',
  'analysis',
  'kiwi-coder-2026-07-27.pm.fair-readmission-closure-v3',
);

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function ownedManifestPath(label) {
  return path.join(analysisRoot, `.snapshot-${label}-${process.pid}.json`);
}

function removeOwnedManifest(manifestPath) {
  assert.equal(path.dirname(manifestPath), analysisRoot, 'snapshot cleanup must stay in the capture analysis directory');
  assert.equal(path.basename(manifestPath).startsWith('.snapshot-'), true, 'snapshot cleanup must target only its own leaf');
  if (existsSync(manifestPath)) unlinkSync(manifestPath);
}

test('SDS-AC-1 keeps the protected snapshot private and rejects a caller filesystem before native capture can read or publish', async () => {
  const collector = await loadCollector();
  const manifestPath = ownedManifestPath('forged-filesystem');
  let calls = 0;
  const fs = new Proxy({}, {
    get() {
      calls += 1;
      throw new Error('caller filesystem must not be observed');
    },
  });

  try {
    assert.equal(Object.hasOwn(collector, 'createProtectedInputSnapshot'), false, 'the protected snapshot has no public construction seam');
    assert.throws(
      () => collector.captureFrozenProvenance({ workspaceRoot, manifestPath, phase: 'snapshot-forged-filesystem', fs }),
      /capture options|native|authority|unsupported|forbid|reject/i,
    );
    assert.equal(calls, 0, 'native capture must reject the caller filesystem before any protected read');
    assert.equal(existsSync(manifestPath), false, 'rejected caller authority must not publish a manifest');
  } finally {
    removeOwnedManifest(manifestPath);
  }
});

test('SDS-AC-2 rejects caller reparse and snapshot state before a failed post-read claim can publish a row', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const manifestPath = ownedManifestPath('forged-snapshot');
  const events = [];
  const reparseGuard = { assertSafeMany() { events.push('guard'); } };
  const snapshot = { readWave() { events.push('snapshot'); } };

  try {
    assert.throws(
      () => captureFrozenProvenance({ workspaceRoot, manifestPath, phase: 'snapshot-forged-state', reparseGuard, snapshot }),
      /capture options|native|authority|unsupported|forbid|reject/i,
    );
    assert.deepEqual(events, [], 'native capture must reject caller state before it can claim a post-read guard result');
    assert.equal(existsSync(manifestPath), false, 'a rejected caller snapshot cannot publish a row');
  } finally {
    removeOwnedManifest(manifestPath);
  }
});

test('SDS-AC-3 publishes source, config, and fixture manifest rows whose digests match their native capture bytes', async () => {
  const { captureFrozenProvenance } = await loadCollector();
  const manifestPath = ownedManifestPath('native-rows');
  const inputs = [
    ['source', 'server/src/ws/WsRouter.ts'],
    ['config_lock', 'server/config.json5'],
    ['fixture', 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness/fair-scheduler-decision.json'],
  ];

  try {
    const manifest = captureFrozenProvenance({ workspaceRoot, manifestPath, phase: 'snapshot-native-rows' });
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), manifest, 'native capture must persist only its canonical manifest rows');
    const protectedRows = [
      ...manifest.protectedInput.value.sourceClosureRows,
      ...manifest.protectedInput.value.configLockRows,
      ...manifest.protectedInput.value.fixtureRows,
    ];
    for (const [kind, relativePath] of inputs) {
      const row = protectedRows.find(candidate => candidate.kind === kind && candidate.path === relativePath);
      assert.deepEqual(
        row,
        { kind, path: relativePath, sha256: sha256(readFileSync(path.join(workspaceRoot, relativePath))) },
        `${kind} manifest rows must preserve the digest of their exact native capture bytes`,
      );
    }
  } finally {
    removeOwnedManifest(manifestPath);
  }
});

test('SDS-AC-3 retains no already-guarded protected-read bypass while ingress consumers move to the snapshot', () => {
  const collectorSource = readFileSync(fileURLToPath(new URL('./fair-readmission-closure-v3.mjs', import.meta.url)), 'utf8');

  assert.equal(
    /\balreadyGuarded\b/.test(collectorSource),
    false,
    'every protected-byte consumer must enter the snapshot or execute its own full force-fresh pre/read/post sequence',
  );
});
