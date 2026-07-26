import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const compiledCanaryUrl = pathToFileURL(
  resolve(serverRoot, 'dist/services/TerminalResourcePolicyCanary.js'),
).href;

test('PERF-BGSTAB-010 compiled runtime resolves only its staged evidence bundle and rejects escaped references', async () => {
  const compiled = await import(`${compiledCanaryUrl}?evidence-bundle-red=${Date.now()}`) as {
    resolveFairSchedulerEvidenceRoot?: () => string;
    validateFairSchedulerEvidenceReference?: (root: string, declaredPath: string) => {
      accepted: boolean;
      reason?: string;
    };
  };
  assert.equal(typeof compiled.resolveFairSchedulerEvidenceRoot, 'function');
  assert.equal(typeof compiled.validateFairSchedulerEvidenceReference, 'function');
  const evidenceRoot = compiled.resolveFairSchedulerEvidenceRoot?.();
  assert.match(evidenceRoot ?? '', /dist[\\/]benchmarks[\\/]fair-scheduler-evidence$/u);
  assert.deepEqual(
    compiled.validateFairSchedulerEvidenceReference?.(evidenceRoot!, '../outside.json'),
    { accepted: false, reason: 'evidence-reference-invalid' },
  );
});
