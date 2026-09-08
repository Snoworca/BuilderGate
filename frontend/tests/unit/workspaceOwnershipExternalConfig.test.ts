import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import ts from 'typescript';

// REL-BGSTAB-001: execute config exports only; no Playwright runner or browser.
const frontend = fileURLToPath(new URL('../../', import.meta.url));
const nativeRequire = createRequire(import.meta.url);
type Config = {
  testDir?: string; testMatch?: string | string[]; globalSetup?: unknown;
  globalTeardown?: unknown; webServer?: unknown; workers?: unknown; retries?: unknown;
  fullyParallel?: unknown; use?: Record<string, unknown>;
  projects?: Array<{ name?: string; use?: Record<string, unknown> }>;
};
function loadConfig(file: string): Config {
  const filename = resolve(frontend, file);
  const source = readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as { default?: Config } };
  new Function('require', 'module', 'exports', '__filename', '__dirname', compiled)((id: string) => {
    if (id === '@playwright/test') return nativeRequire(id); // Actual defineConfig/device data, no runner invocation.
    assert.ok(/^\.\/playwright\.config(?:\.ts)?$/.test(id), `Unexpected config dependency: ${id}`);
    return { default: loadConfig('playwright.config.ts'), __esModule: true };
  }, module, module.exports, filename, dirname(filename));
  assert.ok(module.exports.default, 'actual default config export is required');
  return module.exports.default;
}
const scopedFile = 'playwright.ownership-validation.config.ts';

test('REL001 scoped ownership config preserves global ownership setup and teardown', () => {
  const original = loadConfig('playwright.config.ts');
  const scoped = loadConfig(scopedFile);
  assert.equal(original.globalSetup, './tests/e2e/workspaceLeakGuard.ts');
  assert.equal(original.globalTeardown, './tests/e2e/workspaceTeardown.ts');
  assert.equal(scoped.globalSetup, original.globalSetup);
  assert.equal(scoped.globalTeardown, original.globalTeardown);
  assert.equal(scoped.testDir, original.testDir);
  assert.equal(scoped.use?.ignoreHTTPSErrors, true);
});

test('REL001 scoped ownership config rejects foreign or malformed explicit origins without changing the environment', () => {
  const previous = process.env.PLAYWRIGHT_BASE_URL;
  try {
    for (const value of ['https://foreign.invalid:2002', 'not-a-url', '']) {
      process.env.PLAYWRIGHT_BASE_URL = value;
      assert.throws(() => loadConfig(scopedFile), error => error instanceof Error
        && (/PLAYWRIGHT_BASE_URL|localhost:2222|origin/i.test(error.message)
          || (!URL.canParse(value) && Reflect.get(error, 'code') === 'ERR_INVALID_URL')));
      assert.equal(process.env.PLAYWRIGHT_BASE_URL, value);
    }
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
    else process.env.PLAYWRIGHT_BASE_URL = previous;
  }
});

test('REL001 scoped ownership config accepts unset or exact HTTPS2222 without starting a server', () => {
  const previous = process.env.PLAYWRIGHT_BASE_URL;
  try {
    for (const value of [undefined, 'https://localhost:2222']) {
      if (value === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
      else process.env.PLAYWRIGHT_BASE_URL = value;
      const scoped = loadConfig(scopedFile);
      const original = loadConfig('playwright.config.ts');
      assert.equal(scoped.use?.baseURL, 'https://localhost:2222');
      assert.equal(scoped.webServer, undefined, 'no auto-start or runner-owned server shutdown');
      assert.equal(scoped.globalSetup, original.globalSetup);
      assert.equal(scoped.globalTeardown, original.globalTeardown);
      assert.deepEqual(scoped.projects, original.projects?.filter(project => project.name === 'Desktop Chrome'));
      assert.equal(scoped.projects?.length, 1);
      assert.equal(scoped.workers, 1);
      assert.equal(scoped.retries, 0);
      assert.equal(process.env.PLAYWRIGHT_BASE_URL, value);
    }
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BASE_URL;
    else process.env.PLAYWRIGHT_BASE_URL = previous;
  }
});

test('REL001 scoped ownership config selects exactly one Desktop control without retries', () => {
  const scoped = loadConfig(scopedFile);
  const original = loadConfig('playwright.config.ts');
  assert.deepEqual(scoped.projects, original.projects?.filter(project => project.name === 'Desktop Chrome'));
  assert.equal(scoped.projects?.length, 1);
  assert.deepEqual(Array.isArray(scoped.testMatch) ? scoped.testMatch : [scoped.testMatch], ['workspace-ownership-validation.spec.ts']);
  assert.equal(scoped.workers, 1);
  assert.equal(scoped.retries, 0);
  assert.equal(scoped.fullyParallel, false);
});
