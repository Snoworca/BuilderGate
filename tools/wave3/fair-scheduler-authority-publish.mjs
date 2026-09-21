#!/usr/bin/env node
/**
 * Publish a new canonical fair-scheduler authority generation.
 *
 * WHY THIS EXISTS (#101, and the blocker #76 recorded)
 * ----------------------------------------------------
 * `docs/analysis/terminal-fairness-authority/current.json` pins a decision artifact whose
 * `sourceDigest` covers six server sources:
 *
 *   src/benchmarks/terminalFairnessCharacterization.ts, src/benchmarks/fairSchedulerAuthorityLocator.ts,
 *   src/ws/wsSendPolicy.ts, src/ws/WsRouter.ts,
 *   src/services/TerminalResourcePolicy.ts, src/services/TerminalResourcePolicyCanary.ts
 *
 * Editing ANY of them makes the Canary refuse the canonical authority with
 * `decision-artifact-source-digest-mismatch` -- correctly, because the fair-scheduler decision
 * was measured against those exact sources. Two issues stalled on that with no way forward:
 * #76 (WsRouter.ts) and #101 (the resource key table in TerminalResourcePolicy.ts).
 *
 * The publication API already existed -- `publishFairSchedulerAuthorityGeneration`, which stages a
 * generation and promotes the pointer atomically. What was missing was an entry point, so the
 * procedure lived only in a hand-run canonical-validation ritual. This is that entry point.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not rewrite history: every prior generation directory stays. It re-runs the benchmark
 * with the SEALED workload below -- the same one tools/wave3/fair-scheduler-decision.test.mjs
 * verifies against -- so the new generation is a re-measurement, never a re-labelling. Changing
 * the workload here would make the numbers incomparable with every generation before it, so the
 * profile is not configurable.
 *
 * Usage (from the repository root, after `npm --prefix server run build`):
 *   node tools/wave3/fair-scheduler-authority-publish.mjs [--dry-run]
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const authorityRoot = join(repositoryRoot, 'docs/analysis/terminal-fairness-authority');
const pointerPath = join(authorityRoot, 'current.json');
const compiled = join(repositoryRoot, 'server/dist/benchmarks/terminalFairnessCharacterization.js');

// Sealed workload. Identical to the profileArgs in fair-scheduler-decision.test.mjs.
const PROFILE = {
  clients: [1, 2, 8],
  wanLatencyMs: 150,
  wanJitterMs: 20,
  wanLossPercent: 0,
  seed: 20260723,
  repeats: 5,
  samples: 30,
};

if (!existsSync(compiled)) {
  console.error(`Build the server first: ${compiled} is missing.\n  npm --prefix server run build`);
  process.exit(2);
}

const before = existsSync(pointerPath) ? JSON.parse(readFileSync(pointerPath, 'utf8')) : null;
console.log(`current generation: ${before?.generation_id ?? '(none)'}`);

if (process.argv.includes('--dry-run')) {
  console.log('dry run: nothing was written.');
  process.exit(0);
}

const benchmark = await import(`file://${compiled}`);
// NOTE: no `outputPath`. The raw aggregate that `rawEvidenceDigest` covers is built as
// `{ ...input }`, so an outputPath passed here would be digested into the authority -- while the
// Canary, which rebuilds that aggregate from the published trial files, has no outputPath to put
// back. The generation would verify nowhere. Publishing writes through a staging directory and
// needs no output path of its own.
const result = await benchmark.publishFairSchedulerAuthorityGeneration({
  ...PROFILE,
  authorityRoot,
});

const after = JSON.parse(readFileSync(result.currentPointerPath, 'utf8'));
console.log(`published generation: ${result.generationId}`);
console.log(`  root:    ${result.generationRoot}`);
console.log(`  pointer: ${result.currentPointerPath}`);
console.log(`  decision_sha256: ${after.decision_sha256}`);
if (before && before.generation_id === after.generation_id) {
  console.log('the pointer did not move: the sources and the measurement both reproduced.');
}
