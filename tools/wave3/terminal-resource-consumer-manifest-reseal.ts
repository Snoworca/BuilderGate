/**
 * Deliberate re-seal tool for the terminal resource consumer manifest and its lineage record.
 *
 * This is NOT a verifier and it must never be wired into a test or a build step. The verifier is
 * `tools/wave3/terminal-resource-consumer-manifest.test.mjs` (plus the manifest assertions inside
 * `server/src/services/TerminalResourcePolicy.test.ts`); if generation and verification shared code
 * the comparison between them would be vacuous. So this tool derives every generated field straight
 * from the inventory (`discoverTerminalResourceInventory`) and from raw file bytes, and it imports
 * nothing from the verifier.
 *
 * It exists for the one case a verifier cannot cover: a human has deliberately moved the code the
 * sealed evidence points at, has confirmed the move is legitimate, and now wants the seals to
 * describe the code that actually exists.
 *
 * A default run writes nothing. It prints what a re-seal would change and exits 0.
 * Pass `--reseal` to write:
 *   docs/analysis/.../terminal-resource-consumer-manifest.current.json
 *   docs/analysis/.../terminal-resource-consumer-manifest.lineage.json
 *
 * `--accept-decision-change` is required when the set of resource decisions itself changed, i.e.
 * when a consumer stops or starts making a decision rather than merely making it somewhere else.
 * Without it the tool refuses to write and prints which decisions moved, so a behaviour change
 * can never be sealed as a side effect of a routine re-seal.
 *
 * `--rerun-differential` additionally re-executes tools/wave3/terminal-resource-policy-differential.ts
 * and refreshes the recorded GREEN snapshot the verifier replays it against, re-hashing that one
 * entry of `evidence.rawGreenEvidence`. It is a separate flag on purpose: every other recorded
 * evidence hash stays copied verbatim, so a drifting evidence file keeps the verifier RED until a
 * human decides the re-run is warranted.
 *
 * Recorded execution history inside the lineage file (`historical`, `currentSlice`,
 * `ph002RuntimeAnchor`, `historicalEvidenceCorrection`) and recorded evidence inside the manifest
 * (`evidence.activation`, `evidence.differentialEvidence`, `evidence.rawGreenEvidence`) are copied
 * through verbatim. Re-writing those would be forging results of runs that never happened.
 *
 * Usage (from the repository root):
 *   server/node_modules/.bin/tsx tools/wave3/terminal-resource-consumer-manifest-reseal.ts
 *   server/node_modules/.bin/tsx tools/wave3/terminal-resource-consumer-manifest-reseal.ts --reseal
 *   server/node_modules/.bin/tsx tools/wave3/terminal-resource-consumer-manifest-reseal.ts --reseal --rerun-differential
 *   server/node_modules/.bin/tsx tools/wave3/terminal-resource-consumer-manifest-reseal.ts --reseal --accept-decision-change
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverTerminalResourceInventory,
  type TerminalResourceConsumerManifestEntry,
  type TerminalResourcePathClassification,
} from '../../server/src/services/TerminalResourcePolicyInventory.js';
import {
  TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
  TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
} from '../../server/src/services/TerminalResourcePolicy.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const legacyManifestRelativePath = `${artifactRoot}/terminal-resource-consumer-manifest.json`;
const currentManifestRelativePath = `${artifactRoot}/terminal-resource-consumer-manifest.current.json`;
const lineageRelativePath = `${artifactRoot}/terminal-resource-consumer-manifest.lineage.json`;

const DIVERGENCE_REASON = 'evidence moved: xterm option assembly extracted to terminalViewAttributes, '
  + 'the scheduler byte enqueue was renamed, and the terminal runtime callbacks were named so the '
  + 'catalog can pin symbols instead of useEffect source offsets. decisions changed: REL-BGSTAB-007 '
  + 'AC-1 retired the scrollbackLines divergence, so all three scrollback consumers now read the '
  + 'canonical resourceLimits.terminal.scrollbackLines decision instead of a legacy source';

interface ManifestFile {
  schemaVersion: string;
  profileVersion: string;
  evidence: Record<string, unknown>;
  consumers: TerminalResourceConsumerManifestEntry[];
  classifications: TerminalResourcePathClassification[];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8')) as T;
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function byText(left: string, right: string): number {
  return left.localeCompare(right);
}

function decisionIdentity(entry: TerminalResourceConsumerManifestEntry): string {
  return JSON.stringify({
    consumerId: entry.consumerId,
    category: entry.category,
    resourceKey: entry.resourceKey,
    unit: entry.unit,
    source: entry.source,
    schemaVersion: entry.schemaVersion,
    profileVersion: entry.profileVersion,
    legacyAliases: [...entry.legacyAliases].sort(byText),
    applyBoundary: entry.applyBoundary,
    state: entry.state,
  });
}

function decisionLabel(entry: TerminalResourceConsumerManifestEntry): string {
  return `${entry.consumerId}|${entry.resourceKey}|${entry.applyBoundary}|${entry.state}`;
}

function evidenceLocator(entry: TerminalResourceConsumerManifestEntry): string {
  return `${entry.consumerPath}#${entry.consumerSymbol} :: ${entry.evidenceSignature} :: ${entry.evidenceRole}`;
}

function classificationIdentity(entry: TerminalResourcePathClassification): string {
  return JSON.stringify({
    path: entry.path,
    classification: entry.classification,
    symbol: entry.symbol,
    evidenceSignature: entry.evidenceSignature,
    accessEvidenceSha256: entry.accessEvidenceSha256,
    reason: entry.reason,
  });
}

function tupleIdentity(entry: TerminalResourceConsumerManifestEntry): string {
  return `${decisionIdentity(entry)} ${evidenceLocator(entry)} ${entry.evidenceAstSha256}`;
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const id = key(value);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

interface MultisetDrift {
  retired: string[];
  introduced: string[];
}

function multisetDrift<T>(
  before: readonly T[],
  after: readonly T[],
  key: (value: T) => string,
): MultisetDrift {
  const beforeCounts = countBy(before, key);
  const afterCounts = countBy(after, key);
  const retired: string[] = [];
  const introduced: string[] = [];
  for (const [id, count] of beforeCounts) {
    for (let index = count - (afterCounts.get(id) ?? 0); index > 0; index -= 1) retired.push(id);
  }
  for (const [id, count] of afterCounts) {
    for (let index = count - (beforeCounts.get(id) ?? 0); index > 0; index -= 1) introduced.push(id);
  }
  return { retired: retired.sort(byText), introduced: introduced.sort(byText) };
}

interface RelocatedEvidence {
  decision: string;
  retired: string[];
  introduced: string[];
}

interface Divergence {
  reason: string;
  decisionDrift: MultisetDrift;
  relocatedEvidence: RelocatedEvidence[];
  evidenceHashOnlyChangedTuples: number;
}

/**
 * Describes how the freshly extracted inventory stays reachable from the sealed historical
 * manifest, on two separate axes.
 *
 * `decisionDrift` is the policy axis: resource decisions the current inventory no longer reaches,
 * and decisions it newly reaches. A decision that appears here is a deliberate behaviour change,
 * not a refactor, so it has to be enumerated before the verifier will accept it.
 *
 * `relocatedEvidence` is the location axis, and it only covers decisions that survive on both
 * sides: same decision, evidence now found at a different path/symbol/signature.
 */
function describeDivergence(
  historical: readonly TerminalResourceConsumerManifestEntry[],
  current: readonly TerminalResourceConsumerManifestEntry[],
): Divergence {
  const decisions = new Set([...historical, ...current].map(decisionIdentity));
  const decisionDrift = multisetDrift(historical, current, decisionIdentity);
  const relocatedEvidence: RelocatedEvidence[] = [];
  for (const decision of decisions) {
    const historicalGroup = historical.filter((entry) => decisionIdentity(entry) === decision);
    const currentGroup = current.filter((entry) => decisionIdentity(entry) === decision);
    if (historicalGroup.length === 0 || currentGroup.length === 0) continue;
    const drift = multisetDrift(historicalGroup, currentGroup, evidenceLocator);
    if (drift.retired.length === 0 && drift.introduced.length === 0) continue;
    relocatedEvidence.push({
      decision: decisionLabel(currentGroup[0]),
      retired: drift.retired,
      introduced: drift.introduced,
    });
  }
  const placeKey = (entry: TerminalResourceConsumerManifestEntry): string => (
    `${decisionIdentity(entry)} ${evidenceLocator(entry)}`
  );
  const groupHashes = (entries: readonly TerminalResourceConsumerManifestEntry[]): Map<string, string[]> => {
    const grouped = new Map<string, string[]>();
    for (const entry of entries) {
      const place = placeKey(entry);
      grouped.set(place, [...(grouped.get(place) ?? []), entry.evidenceAstSha256]);
    }
    return grouped;
  };
  const historicalHashes = groupHashes(historical);
  let evidenceHashOnlyChangedTuples = 0;
  for (const [place, hashes] of groupHashes(current)) {
    const before = [...(historicalHashes.get(place) ?? [])].sort(byText);
    const after = [...hashes].sort(byText);
    if (before.length !== after.length) continue;
    evidenceHashOnlyChangedTuples += after.filter((hash, index) => hash !== before[index]).length;
  }
  return {
    reason: DIVERGENCE_REASON,
    decisionDrift,
    relocatedEvidence: relocatedEvidence.sort((left, right) => byText(JSON.stringify(left), JSON.stringify(right))),
    evidenceHashOnlyChangedTuples,
  };
}

function semanticInventorySha256(manifest: ManifestFile): string {
  return sha256(JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    profileVersion: manifest.profileVersion,
    tupleIdentities: manifest.consumers.map((entry) => JSON.stringify({
      consumerId: entry.consumerId,
      category: entry.category,
      resourceKey: entry.resourceKey,
      unit: entry.unit,
      source: entry.source,
      schemaVersion: entry.schemaVersion,
      profileVersion: entry.profileVersion,
      legacyAliases: [...entry.legacyAliases].sort(byText),
      applyBoundary: entry.applyBoundary,
      consumerPath: entry.consumerPath,
      consumerSymbol: entry.consumerSymbol,
      evidenceSignature: entry.evidenceSignature,
      evidenceRole: entry.evidenceRole,
      evidenceAstSha256: entry.evidenceAstSha256,
      state: entry.state,
    })).sort(byText),
    classificationIdentities: manifest.classifications.map(classificationIdentity).sort(byText),
  }));
}

function reportDrift(title: string, drift: MultisetDrift): void {
  if (drift.retired.length === 0 && drift.introduced.length === 0) {
    process.stdout.write(`  ${title}: unchanged\n`);
    return;
  }
  process.stdout.write(`  ${title}: -${drift.retired.length} / +${drift.introduced.length}\n`);
  for (const value of drift.retired) process.stdout.write(`    - ${value}\n`);
  for (const value of drift.introduced) process.stdout.write(`    + ${value}\n`);
}

/**
 * The decision axis is the one axis a re-seal must not settle on its own. Evidence locations and
 * source hashes follow the code mechanically, but a retired or introduced resource decision is a
 * behaviour change, so it is only sealed when the operator says so with --accept-decision-change.
 */
function assertDecisionChangeWasAccepted(sealed: MultisetDrift | undefined, computed: MultisetDrift): void {
  if (JSON.stringify(sealed) === JSON.stringify(computed)) return;
  const drift = multisetDrift(
    [...(sealed?.retired ?? []).map((id) => `- ${id}`), ...(sealed?.introduced ?? []).map((id) => `+ ${id}`)],
    [...computed.retired.map((id) => `- ${id}`), ...computed.introduced.map((id) => `+ ${id}`)],
    (value) => value,
  );
  if (process.argv.includes('--accept-decision-change')) {
    process.stdout.write('accepting a decision-axis change (--accept-decision-change)\n');
    for (const value of drift.retired) process.stdout.write(`  no longer enumerated: ${value}\n`);
    for (const value of drift.introduced) process.stdout.write(`  newly enumerated:    ${value}\n`);
    return;
  }
  const lines = [
    'refusing to re-seal: the resource decisions changed and the lineage record does not enumerate them.',
    'Evidence relocation and source hashes are re-sealed automatically; a decision change is not.',
    ...drift.retired.map((value) => `  no longer enumerated: ${value}`),
    ...drift.introduced.map((value) => `  newly enumerated:    ${value}`),
    'If this behaviour change is intended, re-run with --accept-decision-change.',
  ];
  throw new Error(lines.join('\n'));
}

interface DifferentialRerun {
  path: string;
  text: string;
  sealedSha256: string;
  sha256: string;
}

/**
 * Re-executes the differential probe and re-serializes just its JSON object, dropping any
 * unrelated preamble the probe's dependencies log to stdout.
 */
function rerunDifferential(sealedManifest: ManifestFile): DifferentialRerun {
  const differentialEvidence = sealedManifest.evidence.differentialEvidence as { rawPath?: unknown } | undefined;
  const rawPath = differentialEvidence?.rawPath;
  if (typeof rawPath !== 'string') {
    throw new Error('sealed manifest does not record evidence.differentialEvidence.rawPath');
  }
  const rawGreenEvidence = (sealedManifest.evidence.rawGreenEvidence ?? {}) as Record<string, string>;
  if (!Object.hasOwn(rawGreenEvidence, rawPath)) {
    throw new Error(`sealed manifest does not hash the differential raw output: ${rawPath}`);
  }
  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, 'server/node_modules/tsx/dist/cli.mjs'),
      join(repositoryRoot, 'tools/wave3/terminal-resource-policy-differential.ts'),
    ],
    { cwd: repositoryRoot, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    process.stderr.write(`${result.stdout?.toString('utf8') ?? ''}${result.stderr?.toString('utf8') ?? ''}`);
    throw new Error(`differential probe failed with status ${String(result.status)}`);
  }
  const lines = (result.stdout?.toString('utf8') ?? '').replace(/\r\n/g, '\n').split('\n');
  const start = lines.indexOf('{');
  if (start < 0) throw new Error('differential probe produced no JSON object');
  const text = serialize(JSON.parse(lines.slice(start).join('\n')));
  return {
    path: rawPath,
    text,
    sealedSha256: rawGreenEvidence[rawPath],
    sha256: sha256(Buffer.from(text, 'utf8')),
  };
}

async function main(): Promise<void> {
  const write = process.argv.includes('--reseal');
  const inventory = await discoverTerminalResourceInventory({ repositoryRoot });
  const sealedManifestBytes = readFileSync(join(repositoryRoot, currentManifestRelativePath));
  const sealedManifest = JSON.parse(sealedManifestBytes.toString('utf8')) as ManifestFile;
  const legacyManifest = readJson<ManifestFile>(legacyManifestRelativePath);
  const sealedLineage = readJson<Record<string, unknown>>(lineageRelativePath);
  if (!Object.hasOwn(sealedLineage, 'current') || !Object.hasOwn(sealedLineage, 'semanticInventory')) {
    throw new Error('lineage record is missing its current/semanticInventory blocks');
  }

  const evidence: Record<string, unknown> = {};
  for (const key of Object.keys(sealedManifest.evidence)) {
    if (key === 'sourceHashes') evidence[key] = inventory.sourceHashes;
    else if (key === 'sourceSetSha256') evidence[key] = inventory.sourceSetSha256;
    else if (key === 'consumerAstFingerprint') {
      evidence[key] = {
        schemaVersion: inventory.evidenceHashSchemaVersion,
        typescriptVersion: inventory.typescriptVersion,
      };
    } else evidence[key] = sealedManifest.evidence[key];
  }
  const differential = process.argv.includes('--rerun-differential')
    ? rerunDifferential(sealedManifest)
    : undefined;
  if (differential) {
    evidence.rawGreenEvidence = {
      ...(sealedManifest.evidence.rawGreenEvidence as Record<string, string>),
      [differential.path]: differential.sha256,
    };
  }
  const manifest: ManifestFile = {
    schemaVersion: TERMINAL_RESOURCE_POLICY_SCHEMA_VERSION,
    profileVersion: TERMINAL_RESOURCE_POLICY_PROFILE_VERSION,
    evidence,
    consumers: inventory.tuples,
    classifications: inventory.classifications,
  };
  const manifestText = serialize(manifest);
  const manifestSha256 = sha256(Buffer.from(manifestText, 'utf8'));

  const divergence = describeDivergence(legacyManifest.consumers, manifest.consumers);
  const currentSemanticSha256 = semanticInventorySha256(manifest);
  const historicalEqualsCurrent = semanticInventorySha256(legacyManifest) === currentSemanticSha256;
  const sealedCurrent = sealedLineage.current as Record<string, unknown>;
  const sealedSemantic = sealedLineage.semanticInventory as Record<string, unknown>;
  const sealedDecisionDrift = (sealedSemantic.divergence as { decisionDrift?: MultisetDrift } | undefined)?.decisionDrift;
  assertDecisionChangeWasAccepted(sealedDecisionDrift, divergence.decisionDrift);
  const lineage: Record<string, unknown> = {};
  for (const key of Object.keys(sealedLineage)) {
    if (key === 'current') {
      lineage[key] = {
        path: sealedCurrent.path,
        sha256: manifestSha256,
        sourceCount: Object.keys(inventory.sourceHashes).length,
        sourceSetSha256: inventory.sourceSetSha256,
        exactConsumerTuples: manifest.consumers.length,
        classifications: manifest.classifications.length,
      };
    } else if (key === 'semanticInventory') {
      lineage[key] = {
        sha256: currentSemanticSha256,
        historicalEqualsCurrent,
        divergence,
      };
    } else lineage[key] = sealedLineage[key];
  }
  const lineageText = serialize(lineage);

  process.stdout.write('terminal resource consumer manifest re-seal\n');
  process.stdout.write(`  mode: ${write ? 'WRITE (--reseal)' : 'dry run, no file is written'}\n`);
  process.stdout.write(`  typescript: ${inventory.typescriptVersion}\n`);
  process.stdout.write(`  unregistered call sites: ${inventory.unregisteredCallSites.length}\n`);
  for (const site of inventory.unregisteredCallSites) {
    process.stdout.write(`    ! ${site.path}#${site.symbol}\n`);
  }

  if (differential) {
    process.stdout.write(`${differential.path}\n`);
    process.stdout.write(`  re-executed differential sha256: ${differential.sealedSha256} -> ${differential.sha256}`
      + `${differential.sealedSha256 === differential.sha256 ? ' (unchanged)' : ''}\n`);
  }
  process.stdout.write(`${currentManifestRelativePath}\n`);
  const sealedManifestSha256 = sha256(sealedManifestBytes);
  process.stdout.write(`  sha256: ${sealedManifestSha256} -> ${manifestSha256}`
    + `${sealedManifestSha256 === manifestSha256 ? ' (unchanged)' : ''}\n`);
  process.stdout.write(`  consumers: ${sealedManifest.consumers.length} -> ${manifest.consumers.length}\n`);
  process.stdout.write(`  classifications: ${sealedManifest.classifications.length} -> ${manifest.classifications.length}\n`);
  reportDrift('exact consumer tuples', multisetDrift(sealedManifest.consumers, manifest.consumers, tupleIdentity));
  reportDrift('classifications', multisetDrift(
    sealedManifest.classifications,
    manifest.classifications,
    classificationIdentity,
  ));
  reportDrift('evidence source hashes', multisetDrift(
    Object.entries((sealedManifest.evidence.sourceHashes ?? {}) as Record<string, string>),
    Object.entries(inventory.sourceHashes),
    ([path, hash]) => `${path}:${hash}`,
  ));
  process.stdout.write(`  sourceSetSha256: ${String(sealedManifest.evidence.sourceSetSha256)} -> ${inventory.sourceSetSha256}\n`);

  process.stdout.write(`${lineageRelativePath}\n`);
  process.stdout.write(`  semanticInventory.sha256: ${String(sealedSemantic.sha256)} -> ${currentSemanticSha256}\n`);
  process.stdout.write(`  semanticInventory.historicalEqualsCurrent: ${String(sealedSemantic.historicalEqualsCurrent)}`
    + ` -> ${historicalEqualsCurrent}\n`);
  process.stdout.write('  resource decisions changed against the sealed historical manifest:'
    + ` -${divergence.decisionDrift.retired.length} / +${divergence.decisionDrift.introduced.length}\n`);
  for (const decision of divergence.decisionDrift.retired) process.stdout.write(`    - ${decision}\n`);
  for (const decision of divergence.decisionDrift.introduced) process.stdout.write(`    + ${decision}\n`);
  process.stdout.write(`  evidence relocated away from the sealed historical manifest: ${divergence.relocatedEvidence.length} decision(s)\n`);
  for (const relocation of divergence.relocatedEvidence) {
    process.stdout.write(`    ${relocation.decision}\n`);
    for (const value of relocation.retired) process.stdout.write(`      - ${value}\n`);
    for (const value of relocation.introduced) process.stdout.write(`      + ${value}\n`);
  }
  process.stdout.write(`  tuples whose evidence stayed put but whose AST hash moved: ${divergence.evidenceHashOnlyChangedTuples}\n`);

  if (!write) {
    process.stdout.write('\nnothing was written. re-run with --reseal to apply.\n');
    return;
  }
  if (differential) writeFileSync(join(repositoryRoot, differential.path), differential.text, 'utf8');
  writeFileSync(join(repositoryRoot, currentManifestRelativePath), manifestText, 'utf8');
  writeFileSync(join(repositoryRoot, lineageRelativePath), lineageText, 'utf8');
  process.stdout.write('\nwrote both seals.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
