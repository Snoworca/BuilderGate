import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const outputDir = 'C:/Work/kiwi-run-output/2026-07-27.pm.fair-readmission-closure-v3/ac9-playwright';
const workspaceRoot = 'C:/Work/git/_Snoworca/ProjectMaster';
const browserGrep = 'PERF-BGSTAB-010 AC-9 isolated browser evidence.*visible fair-delivery ACK preserves idle through the real HTTPS WebSocket';

async function loadCollector() {
  return import('./fair-readmission-closure-v3.mjs');
}

function safeFs() {
  return {
    existsSync: () => false,
    lstatSync: () => ({ isSymbolicLink: () => false }),
  };
}

test('closure-v3 freezes the exact external Playwright contract in every argv representation', async () => {
  const { FROZEN_CONTRACT } = await loadCollector();
  const browser = FROZEN_CONTRACT.commandFamilies.find(({ id }) => id === 'browser-ac9-isolated');

  assert.equal(FROZEN_CONTRACT.procedureVersion, 'closure-v3');
  assert.equal(FROZEN_CONTRACT.playwright.outputDir, outputDir);
  assert.deepEqual(FROZEN_CONTRACT.playwright.environment, { PLAYWRIGHT_BASE_URL: 'https://localhost:2222' });
  assert.equal(FROZEN_CONTRACT.playwright.retries, 0);
  assert.equal(FROZEN_CONTRACT.playwright.workers, 1);
  assert.deepEqual(browser.posixArgv, [
    'npx', '--no-install', 'playwright', 'test',
    'tests/e2e/perf-bgstab-010-ac9-isolated.spec.ts', '--project', 'Desktop Chrome',
    '--retries=0', '--workers=1', '--output', outputDir, '--grep', browserGrep,
  ]);
  assert.deepEqual(browser.windowsArgv, ['npx.cmd', ...browser.posixArgv.slice(1)]);
});

test('closure-v3 rejects unsafe external output before launch or cleanup', async () => {
  const { FROZEN_CONTRACT, validateFrozenContract } = await loadCollector();

  assert.doesNotThrow(() => validateFrozenContract({ workspaceRoot, contract: FROZEN_CONTRACT, fs: safeFs() }));
  assert.throws(() => validateFrozenContract({
    workspaceRoot,
    contract: { ...FROZEN_CONTRACT, playwright: { ...FROZEN_CONTRACT.playwright, outputDir: 'C:/Users/beom/AppData/Local/Temp/BuilderGateFairReadmission-old' } },
    fs: safeFs(),
  }), /output/i);
  assert.throws(() => validateFrozenContract({
    workspaceRoot,
    contract: FROZEN_CONTRACT,
    fs: { ...safeFs(), existsSync: path => path === outputDir },
  }), /exist|absent/i);
  assert.throws(() => validateFrozenContract({
    workspaceRoot,
    contract: FROZEN_CONTRACT,
    fs: {
      ...safeFs(),
      lstatSync: path => ({ isSymbolicLink: () => path === 'C:/Work/kiwi-run-output' }),
    },
  }), /reparse|link/i);
});

test('closure-v3 emits a canonical digest that binds collector, runtime, contract, argv, and protected rows', async () => {
  const { FROZEN_CONTRACT, buildCanonicalManifest } = await loadCollector();
  const manifest = buildCanonicalManifest({
    contract: FROZEN_CONTRACT,
    phase: 'baseline',
    collector: { path: 'tools/wave3/fair-readmission-closure-v3.mjs', sha256: 'a'.repeat(64) },
    nodeRuntime: { path: 'C:/Program Files/nodejs/node.exe', sha256: 'b'.repeat(64), versionStdoutLf: 'v24.0.0\n' },
    selectedCommands: [{ id: 'browser-ac9-isolated', cwd: 'frontend', argv: FROZEN_CONTRACT.commandFamilies[0].windowsArgv }],
    sourceClosureRows: [{ kind: 'source', path: 'server/src/ws/WsRouter.ts', sha256: 'c'.repeat(64) }],
    fixtureRows: [{ kind: 'fixture', path: 'docs/analysis/fair.json', sha256: 'd'.repeat(64) }],
    configLockRows: [{ kind: 'config_lock', path: 'server/config.json5', sha256: 'e'.repeat(64) }],
    externalSpecifierRows: [{ from: 'server/src/ws/WsRouter.ts', specifier: 'node:crypto', resolvedOrBuiltin: 'builtin' }],
    git: { head: 'f'.repeat(40), statusRows: [{ xy: '!!', path: 'server/config.json5' }], indexRows: [] },
  });

  assert.equal(manifest.schemaVersion, 'fair-readmission-provenance/v3');
  assert.equal(manifest.protectedInput.canonicalJson.includes('\r'), false);
  assert.equal(manifest.protectedInput.canonicalJson.charCodeAt(0), 0x7b);
  assert.equal(
    manifest.protectedInput.sha256,
    createHash('sha256').update(manifest.protectedInput.canonicalJson, 'utf8').digest('hex'),
  );
  assert.equal(manifest.protectedInput.value.runtime.playwrightOutputDir, outputDir);
  assert.equal(manifest.protectedInput.value.collector.sha256, 'a'.repeat(64));
  assert.equal(manifest.protectedInput.value.nodeRuntime.sha256, 'b'.repeat(64));
});

test('closure-v3 fails closed on config-lock ambiguity or unresolved protected inputs', async () => {
  const { validateConfigLockRows, validateProtectedRows } = await loadCollector();

  assert.doesNotThrow(() => validateConfigLockRows({
    statusRows: [{ xy: '!!', path: 'server/config.json5' }], indexRows: [],
  }));
  assert.throws(() => validateConfigLockRows({
    statusRows: [{ xy: ' M', path: 'server/config.json5' }], indexRows: [],
  }), /config|!!/i);
  assert.throws(() => validateConfigLockRows({
    statusRows: [{ xy: '!!', path: 'server/config.json5' }],
    indexRows: [{ mode: '100644', object: 'a'.repeat(40), stage: '0', path: 'server/config.json5' }],
  }), /config|index/i);
  assert.throws(() => validateProtectedRows({
    sourceClosureRows: [], fixtureRows: [], externalSpecifierRows: [
      { from: 'frontend/src/components/Terminal/TerminalView.tsx', specifier: './missing', unresolved: true },
    ],
    gitDiagnostics: ['unparseable status row'],
  }), /unresolved|Git/i);
});
