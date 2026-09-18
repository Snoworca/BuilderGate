#!/usr/bin/env node
// Seal census (issue #2 epic; authorised after #90/#92).
//
// WHY THIS EXISTS. Artifacts under docs/analysis/ record sha256 hashes of source
// files. Some are LIVE: a test asserts them against the current tree, so they go red
// when the source moves and must be re-sealed. Others are HISTORICAL: frozen records
// of a past run, where staleness is correct and re-sealing them would forge results
// of runs that never happened. Nothing distinguished the two, and nothing enumerated
// them at all.
//
// The cost was measured, not hypothesised. Over this epic three seals were found by
// three unrelated accidents: one because an issue was filed, one because a reviewer
// said so, one by tripping an unrelated suite while working a different issue. Each
// time, "I re-sealed after touching a sealed input" felt complete and was partial,
// because the next seal was not knowable without breaking it. A re-seal commit in
// this epic classified the remainder by intuition into a bucket labelled "deliberately
// not re-sealed" -- a label that reads as a decision and was a guess, and was wrong
// for canary-admission-evidence.json.
//
// WHAT IT CHECKS.
//   1. Every artifact recording source hashes is in REGISTRY. A new one fails until
//      classified. This is the tsconfig-membership shape from #82: the guard fails
//      when the list stops covering the directory, not when someone remembers.
//   2. Every `live` artifact's recorded hashes match the current files.
// `historical` and `undetermined` are reported and never fail: an `undetermined`
// entry is an honest "nobody has checked", which is strictly better than a confident
// wrong classification, and a census that flagged the historical baselines would
// train people to ignore it.
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANALYSIS = 'docs/analysis';
const W3 = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const W2 = 'docs/analysis/kiwi-coder-2026-07-15.projectmaster.wave2-hotpath';

// status: 'live' | 'historical' | 'undetermined'. Every entry carries its reason.
const REGISTRY = [
  { path: `${W3}/terminal-resource-consumer-manifest.current.json`, status: 'live', reason:
    'TerminalResourcePolicy.test.ts asserts evidence.sourceHashes against the tree, file by file. '
    + 'NOTE, and this is the least intuitive entry here: those 36 pinned files include '
    + 'tools/wave3/terminal-resource-consumer-manifest.test.mjs, the verifier itself. It is a seal '
    + 'that covers its own verifier, so editing the verifier invalidates the seal the verifier '
    + 'checks, and any such edit must be followed by terminal-resource-consumer-manifest-reseal.ts.' },
  { path: `${W3}/terminal-resource-consumer-manifest.lineage.json`, status: 'live', reason:
    'Written by the same reseal tool and read by the same verifier as the manifest above.' },
  { path: `${W3}/terminal-resource-consumer-manifest.json`, status: 'historical', reason:
    'The LEGACY sealed baseline. The reseal tool and the verifier both read it as history, so it '
    + 'holds pre-change hashes on purpose; re-sealing it would erase the baseline it exists to be.' },
  { path: `${W3}/canary-admission-evidence.json`, status: 'live', reason:
    'canary-admission-evidence.test.mjs asserts productionSourceHashes against the tree. This is '
    + 'the seal a re-seal commit wrongly filed as frozen. Regenerating it uses --regenerate-green, '
    + 'which rmSync()s this artifact up front and only rewrites it at the end -- a throw in between '
    + 'destroys it, so back it up before running that flag.' },
  { path: `${W3}/ph-002/green-evidence.json`, status: 'live', reason:
    'The GREEN corpus --regenerate-green rewrites; asserted against the current source set.' },
  ...[2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
    path: `${W3}/ph-002/red-evidence-iteration${n}.json`, status: 'historical', reason:
      'A RED baseline. It records the tree as it was when the failure was observed; a hash that '
      + 'MATCHED the current tree would itself be the defect.' })),
  { path: `${W3}/ph-002/red-evidence-primary.json`, status: 'historical', reason: 'RED baseline; see the iteration files.' },
  { path: `${W3}/ph-001/green-evidence-correction.json`, status: 'undetermined', reason: 'Not yet checked whether anything asserts it against the tree.' },
  { path: `${W3}/ph-001/historical-evidence-correction-red-evidence.json`, status: 'historical', reason: 'Named as a RED evidence correction; a match would be the defect.' },
  { path: `${W3}/ph-004/green-evidence.json`, status: 'undetermined', reason: 'Referenced by canary and manifest verifiers; not yet confirmed whether its source hashes are asserted.' },
  { path: `${W3}/retained-shadow-parity.json`, status: 'undetermined', reason: 'Read by retained-shadow-parity.test.mjs and authority-promotion-evidence.test.mjs; assertion against the tree not yet confirmed.' },
  { path: `${W3}/terminal-write-inventory.json`, status: 'undetermined', reason: 'Read by a Playwright e2e spec; not yet confirmed whether the hashes are asserted.' },
  { path: `${W2}/T-PH001-04/green-evidence.json`, status: 'undetermined', reason: 'Wave-2 evidence; no reader confirmed.' },
  { path: `${W2}/T-PH003-03/red-evidence.json`, status: 'historical', reason: 'RED baseline; a match would be the defect.' },
  { path: `${W2}/T-PH004-02/green-evidence.json`, status: 'undetermined', reason: 'Read by two wave3 verifiers; assertion against the tree not yet confirmed.' },
  { path: `${W2}/T-PH004-03/red-evidence.json`, status: 'historical', reason: 'RED baseline; a match would be the defect.' },
  { path: 'docs/analysis/kiwi-coder-2026-07-24.pm.evidence-diagnostic/scope-baseline.json', status: 'historical', reason: 'A baseline captured for a diagnostic; not a live gate.' },
  // #98 measured this one specifically, because an issue was filed calling its stale pin a
  // defect of the #90 class. It is not, and the distinction is the whole point of this
  // registry. #90's pin sat in a LIVE seal -- something asserts it against the tree, so a
  // mismatch means the claim is false. This file claims nothing about the current tree: each
  // row is {path, working_sha256, git_status, git_index_blob}, i.e. what the WORKING TREE
  // held at the moment that run executed. A row here matching HEAD today would mean the
  // record had been rewritten, which would be forging a run that never happened.
  //
  // The sharpest evidence is in the row the issue names: TerminalResourcePolicyInventory.ts
  // is pinned at 5a14b19d with git_status '??' -- UNTRACKED at capture. That pin never
  // corresponded to any commit, so there is no moment at which it "went" stale; it was a
  // snapshot of an uncommitted working file from the start. 12 commits have touched that
  // file since, which is expected rather than alarming.
  { path: 'docs/analysis/kiwi-coder-2026-07-24.pm.fair-admission/provenance-manifest.json', status: 'historical', reason: 'Provenance record of a past run, 108 files; frozen by construction. Rows are working-tree state at execution time, not claims about HEAD -- the Inventory.ts row is git_status "??" (untracked at capture), so it never matched any commit. Matching HEAD would mean the record was forged.' },
  { path: 'docs/analysis/kiwi-coder-2026-07-27.pm.fair-readmission-current/post-replay-provenance-manifest.json', status: 'historical', reason: 'Post-replay provenance record of a past run.' },
  { path: 'docs/analysis/kiwi-planner-2026-07-26.pm.fair-readmission/code_context.json', status: 'undetermined', reason: 'Planner context capture; no reader confirmed.' },
];

const SRC = /^(server|frontend|tools|docs)\/[A-Za-z0-9._/-]+\.(ts|tsx|mjs|cjs|js|json|md)$/;

// Which key names denote a digest OF FILE BYTES. Written as an allowlist, not a
// pattern, because the pattern `*[Ss]ha256` is wrong here and wrong in a way that
// looks right. Known keys that are NOT file digests, and must never be added:
//   accessEvidenceSha256  digest of an AST access multiset (see issue #90)
//   sourceSetSha256       digest of a set of path:hash rows, not of any one file
//   evidenceAstSha256     digest of an AST occurrence's position
//   semanticResultSha256  digest of a test-result summary
//   artifactSha256Before/After   digests of an artifact across a mutation, by design
//                                unequal to each other and to the current file
const CONTENT_HASH_KEYS = new Set(['sha256', 'fileSha256']);
const SHA = /^[0-9a-f]{64}$/;

// Only FILE-CONTENT digests count. These artifacts carry several other kinds of
// sha256 that are not digests of file bytes -- `accessEvidenceSha256` hashes an AST
// access multiset, `sourceSetSha256` hashes a set of rows, `evidenceAstSha256` hashes
// an occurrence. Comparing any of those to a file digest produces a confident,
// permanent, wrong "STALE" report. A first cut of this script did exactly that and
// emitted 12 false criticals -- one of them `sha256("[]")`, the empty access list --
// which would have trained readers to ignore the guard, the single worst outcome for
// a census. So: accept the `{ "<path>": "<digest>" }` map shape, and accept a sibling
// `path` ONLY when the key is exactly `sha256`.
function collect(node, out) {
  if (Array.isArray(node)) { for (const v of node) collect(v, out); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && SHA.test(v)) {
      if (SRC.test(k)) { out.set(k, v); continue; }
      const p = node.path ?? node.file ?? node.relPath;
      if (typeof p === 'string' && SRC.test(p) && CONTENT_HASH_KEYS.has(k)) out.set(p, v);
      continue;
    }
    collect(v, out);
  }
}

async function walk(dir, acc = []) {
  for (const entry of await readdir(join(repositoryRoot, dir))) {
    const rel = `${dir}/${entry}`;
    const info = await stat(join(repositoryRoot, rel));
    if (info.isDirectory()) await walk(rel, acc);
    else if (entry.endsWith('.json')) acc.push(rel);
  }
  return acc;
}

const found = new Map();
for (const rel of await walk(ANALYSIS)) {
  let parsed;
  try { parsed = JSON.parse(await readFile(join(repositoryRoot, rel), 'utf8')); } catch { continue; }
  const hashes = new Map();
  collect(parsed, hashes);
  if (hashes.size > 0) found.set(rel, hashes);
}

const registry = new Map(REGISTRY.map((e) => [e.path, e]));
const problems = [];

// 1. membership
for (const rel of found.keys()) {
  if (!registry.has(rel)) {
    problems.push(`UNCLASSIFIED source-hash artifact: ${rel}\n  Add it to REGISTRY in ${relative(repositoryRoot, fileURLToPath(import.meta.url))} `
      + 'with status live | historical | undetermined and a reason. Use "undetermined" if you have not checked.');
  }
}
for (const entry of REGISTRY) {
  if (!found.has(entry.path)) {
    problems.push(`STALE REGISTRY ENTRY: ${entry.path} records no source hashes (moved, renamed or deleted?).`);
  }
}

// 2. freshness, live entries only
let liveChecked = 0;
for (const entry of REGISTRY) {
  if (entry.status !== 'live') continue;
  const hashes = found.get(entry.path);
  if (!hashes) continue;
  for (const [path, recorded] of hashes) {
    let actual;
    try { actual = createHash('sha256').update(await readFile(join(repositoryRoot, path))).digest('hex'); }
    catch { problems.push(`${entry.path}\n  pins a file that cannot be read: ${path}`); continue; }
    liveChecked += 1;
    if (actual !== recorded) {
      problems.push(`STALE LIVE SEAL: ${entry.path}\n  ${path}\n    recorded ${recorded}\n    actual   ${actual}`);
    }
  }
}

const counts = REGISTRY.reduce((acc, e) => ({ ...acc, [e.status]: (acc[e.status] ?? 0) + 1 }), {});
console.log(`source-hash artifacts found: ${found.size}; registry: ${REGISTRY.length} `
  + `(live ${counts.live ?? 0}, historical ${counts.historical ?? 0}, undetermined ${counts.undetermined ?? 0})`);
console.log(`live pinned files verified against the tree: ${liveChecked}`);
if (counts.undetermined) {
  console.log(`\n${counts.undetermined} artifact(s) are UNDETERMINED -- nobody has checked whether they are asserted:`);
  for (const e of REGISTRY.filter((x) => x.status === 'undetermined')) console.log(`  ${e.path}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}
console.log('\nAll live seals are fresh and every source-hash artifact is classified.');
