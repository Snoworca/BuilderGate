import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const isolatedSpecUrl = new URL(
  '../e2e/perf-bgstab-010-ac9-isolated.spec.ts',
  import.meta.url,
);

test('PERF-BGSTAB-010 AC-9 isolated E2E has no historical-evidence writer dependency', () => {
  assert.equal(
    existsSync(isolatedSpecUrl),
    true,
    'the isolated AC-9 browser spec must exist before it can be used as current evidence',
  );

  const source = readFileSync(isolatedSpecUrl, 'utf8');
  assert.doesNotMatch(source, /wave3-terminal-authority-fairness\.spec/u);
  assert.doesNotMatch(source, /docs\/analysis\/kiwi-coder-2026-07-16\.projectmaster\.wave3-authority-fairness/u);
  assert.doesNotMatch(source, /\bwriteFileSync\s*\(/u);
});
