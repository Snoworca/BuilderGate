import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactRoot = 'docs/analysis/kiwi-coder-2026-07-16.projectmaster.wave3-authority-fairness';
const legacyManifestPath = join(repositoryRoot, artifactRoot, 'terminal-resource-consumer-manifest.json');
const currentManifestPath = join(repositoryRoot, artifactRoot, 'terminal-resource-consumer-manifest.current.json');
const lineagePath = join(repositoryRoot, artifactRoot, 'terminal-resource-consumer-manifest.lineage.json');
const differentialEvidencePath = join(repositoryRoot, artifactRoot, 'ph-001/differential-green-output.json');
const focusedEvidencePath = join(repositoryRoot, artifactRoot, 'ph-001/focused-green-output.txt');
const greenEvidencePath = join(repositoryRoot, artifactRoot, 'ph-001/green-evidence.json');
const greenEvidenceCorrectionPath = join(repositoryRoot, artifactRoot, 'ph-001/green-evidence-correction.json');
const greenEvidenceCorrectionRedEvidencePath = join(repositoryRoot, artifactRoot, 'ph-001/historical-evidence-correction-red-evidence.json');
const reportPath = join(repositoryRoot, artifactRoot, 'ph-001/report.md');
const legacyManifestBytes = readFileSync(legacyManifestPath);
const legacyManifest = JSON.parse(legacyManifestBytes.toString('utf8'));
const manifestBytes = readFileSync(currentManifestPath);
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const lineage = JSON.parse(readFileSync(lineagePath, 'utf8'));
const expectedCategories = [
  'server-config-schema-store',
  'pty-headless-model',
  'websocket-router-send-policy',
  'snapshot-replay-repair',
  'browser-runtime-residency-hidden-output',
  'terminal-write-recovery-scheduler',
  'persisted-snapshot-storage',
];
const expectedResourceKeys = [
  'resourceLimits.clientWs.hardReconnectBytes',
  'resourceLimits.clientWs.inputBackpressureBytes',
  'resourceLimits.headless.overflowPolicy',
  'resourceLimits.headless.pendingOutputMaxBytes',
  'resourceLimits.headless.pendingOutputMaxChunks',
  'resourceLimits.headless.writeBatchMaxBytes',
  'resourceLimits.headless.writeLagWarnMs',
  'resourceLimits.snapshots.maxEntries',
  'resourceLimits.snapshots.perSnapshotMaxChars',
  'resourceLimits.snapshots.tombstoneTtlMs',
  'resourceLimits.snapshots.totalStorageBudgetChars',
  'resourceLimits.terminal.checkpointChunkBytes',
  'resourceLimits.terminal.checkpointMaxBytes',
  'resourceLimits.terminal.checkpointMaxChunks',
  'resourceLimits.terminal.hiddenOutputPolicy',
  'resourceLimits.terminal.hiddenOutputTailBytes',
  'resourceLimits.terminal.inputQueueMaxBytes',
  'resourceLimits.terminal.inputQueueMaxCount',
  'resourceLimits.terminal.inputQueueTtlMs',
  'resourceLimits.terminal.scrollbackLines',
  'resourceLimits.terminal.transportOutboxMaxBytes',
  'resourceLimits.terminal.transportOutboxTtlMs',
  'resourceLimits.terminal.visibleFlushBudgetBytes',
  'resourceLimits.terminal.visibleFlushFrameBudgetMs',
  'resourceLimits.terminal.visibleOutputMaxChunks',
  'resourceLimits.terminal.visibleOutputQueueMaxBytes',
  'resourceLimits.workspaceRuntime.hiddenRuntimeTtlMs',
  'resourceLimits.workspaceRuntime.maxLiveTerminals',
  'resourceLimits.workspaceRuntime.maxLiveWorkspaces',
  'resourceLimits.ws.outputCoalesceWindowMs',
  'resourceLimits.ws.perClientControlQueueMaxBytes',
  'resourceLimits.ws.perClientOutputQueueMaxBytes',
  'resourceLimits.ws.serverBufferedHardLimitBytes',
  'resourceLimits.ws.serverBufferedHighWaterBytes',
];
const requiredTracePaths = [
  'frontend/src/components/Terminal/TerminalContainer.tsx',
  'frontend/src/components/Terminal/TerminalView.tsx',
  'frontend/src/contexts/WebSocketContext.tsx',
  'frontend/src/hooks/useTerminalRuntimeResidency.ts',
  'frontend/src/services/tokenStorage.ts',
  'frontend/src/utils/inputReliabilityMode.ts',
  'frontend/src/utils/terminalHiddenOutput.ts',
  'frontend/src/utils/terminalOutputHotPath.ts',
  'frontend/src/utils/terminalOutputScheduler.ts',
  'frontend/src/utils/terminalSnapshot.ts',
  'frontend/src/utils/visibleOutputRecovery.ts',
  'server/src/schemas/config.schema.ts',
  'server/src/services/ConfigFileRepository.ts',
  'server/src/services/RuntimeConfigStore.ts',
  'server/src/services/SessionManager.ts',
  'server/src/services/SettingsService.ts',
  'server/src/types/config.types.ts',
  'server/src/utils/headlessOutputQueue.ts',
  'server/src/utils/headlessTerminal.ts',
  'server/src/ws/WsRouter.ts',
  'server/src/ws/wsSendPolicy.ts',
];

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertHistoricalReportSeal(seal, rawReportBytes) {
  assert.deepEqual(seal, {
    path: `${artifactRoot}/ph-001/report.md`,
    sha256: historicalReportSha256,
  }, 'historical report seal mismatch');
  assert.equal(
    sha256(rawReportBytes),
    historicalReportSha256,
    'historical report seal mismatch',
  );
}

function canonicalConsumerTupleIdentity(entry) {
  return JSON.stringify({
    consumerId: entry.consumerId,
    category: entry.category,
    resourceKey: entry.resourceKey,
    unit: entry.unit,
    source: entry.source,
    schemaVersion: entry.schemaVersion,
    profileVersion: entry.profileVersion,
    legacyAliases: [...entry.legacyAliases].sort((left, right) => left.localeCompare(right)),
    applyBoundary: entry.applyBoundary,
    consumerPath: entry.consumerPath,
    consumerSymbol: entry.consumerSymbol,
    evidenceSignature: entry.evidenceSignature,
    evidenceRole: entry.evidenceRole,
    evidenceAstSha256: entry.evidenceAstSha256,
    state: entry.state,
  });
}

function canonicalClassificationIdentity(entry) {
  return JSON.stringify({
    path: entry.path,
    classification: entry.classification,
    symbol: entry.symbol,
    evidenceSignature: entry.evidenceSignature,
    accessEvidenceSha256: entry.accessEvidenceSha256,
    reason: entry.reason,
  });
}

function canonicalIdentitySet(entries, identity) {
  const values = entries.map(identity).sort((left, right) => left.localeCompare(right));
  assert.equal(new Set(values).size, values.length, 'canonical inventory identity must be unique');
  return values;
}

function semanticInventory(value) {
  return {
    schemaVersion: value.schemaVersion,
    profileVersion: value.profileVersion,
    tupleIdentities: canonicalIdentitySet(value.consumers, canonicalConsumerTupleIdentity),
    classificationIdentities: canonicalIdentitySet(value.classifications, canonicalClassificationIdentity),
  };
}

function decisionIdentity(entry) {
  return JSON.stringify({
    consumerId: entry.consumerId,
    category: entry.category,
    resourceKey: entry.resourceKey,
    unit: entry.unit,
    source: entry.source,
    schemaVersion: entry.schemaVersion,
    profileVersion: entry.profileVersion,
    legacyAliases: [...entry.legacyAliases].sort((left, right) => left.localeCompare(right)),
    applyBoundary: entry.applyBoundary,
    state: entry.state,
  });
}

function decisionLabel(entry) {
  return `${entry.consumerId}|${entry.resourceKey}|${entry.applyBoundary}|${entry.state}`;
}

function evidenceLocator(entry) {
  return `${entry.consumerPath}#${entry.consumerSymbol} :: ${entry.evidenceSignature} :: ${entry.evidenceRole}`;
}

function multisetDrift(before, after, identity) {
  const tally = (entries) => entries.reduce(
    (counts, entry) => counts.set(identity(entry), (counts.get(identity(entry)) ?? 0) + 1),
    new Map(),
  );
  const beforeCounts = tally([...before]);
  const afterCounts = tally([...after]);
  const retired = [];
  const introduced = [];
  for (const [id, total] of beforeCounts) {
    for (let missing = total - (afterCounts.get(id) ?? 0); missing > 0; missing -= 1) retired.push(id);
  }
  for (const [id, total] of afterCounts) {
    for (let extra = total - (beforeCounts.get(id) ?? 0); extra > 0; extra -= 1) introduced.push(id);
  }
  return {
    retired: retired.sort((left, right) => left.localeCompare(right)),
    introduced: introduced.sort((left, right) => left.localeCompare(right)),
  };
}

function relocatedEvidence(historicalConsumers, currentConsumers) {
  const relocations = [];
  for (const decision of new Set([...historicalConsumers, ...currentConsumers].map(decisionIdentity))) {
    const historicalGroup = historicalConsumers.filter((entry) => decisionIdentity(entry) === decision);
    const currentGroup = currentConsumers.filter((entry) => decisionIdentity(entry) === decision);
    if (historicalGroup.length === 0 || currentGroup.length === 0) continue;
    const drift = multisetDrift(historicalGroup, currentGroup, evidenceLocator);
    if (drift.retired.length === 0 && drift.introduced.length === 0) continue;
    relocations.push({
      decision: decisionLabel(currentGroup[0] ?? historicalGroup[0]),
      retired: drift.retired,
      introduced: drift.introduced,
    });
  }
  return relocations.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function evidenceHashOnlyChangedTuples(historicalConsumers, currentConsumers) {
  const groupHashes = (entries) => entries.reduce((grouped, entry) => {
    const place = `${decisionIdentity(entry)} ${evidenceLocator(entry)}`;
    return grouped.set(place, [...(grouped.get(place) ?? []), entry.evidenceAstSha256]);
  }, new Map());
  const historicalHashes = groupHashes(historicalConsumers);
  let changed = 0;
  for (const [place, hashes] of groupHashes(currentConsumers)) {
    const before = [...(historicalHashes.get(place) ?? [])].sort((left, right) => left.localeCompare(right));
    const after = [...hashes].sort((left, right) => left.localeCompare(right));
    if (before.length !== after.length) continue;
    changed += after.filter((hash, index) => hash !== before[index]).length;
  }
  return changed;
}

function evidenceRoleDistribution(consumers) {
  return Object.fromEntries(
    [...consumers]
      .reduce((counts, consumer) => counts.set(
        consumer.evidenceRole,
        (counts.get(consumer.evidenceRole) ?? 0) + 1,
      ), new Map())
      .entries(),
  );
}

function assertRepositoryPath(path) {
  assert.equal(isAbsolute(path), false);
  assert.doesNotMatch(path, /\\/);
  const absolute = resolve(repositoryRoot, path);
  assert.equal(relative(repositoryRoot, absolute).startsWith('..'), false);
  assert.equal(existsSync(absolute), true, `repository path missing: ${path}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    windowsHide: true,
  });
  const decode = (value) => {
    if (!value) return '';
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const looksUtf16Be = (bytes[0] === 0xfe && bytes[1] === 0xff)
      || (bytes.length >= 4 && bytes[0] === 0 && bytes[2] === 0);
    if (looksUtf16Be) {
      const body = bytes[0] === 0xfe && bytes[1] === 0xff ? bytes.subarray(2) : bytes;
      const swapped = Buffer.allocUnsafe(body.length);
      for (let index = 0; index + 1 < body.length; index += 2) {
        swapped[index] = body[index + 1];
        swapped[index + 1] = body[index];
      }
      return swapped.toString('utf16le').replace(/^\uFEFF/, '');
    }
    const looksUtf16Le = (bytes[0] === 0xff && bytes[1] === 0xfe)
      || (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0);
    return bytes.toString(looksUtf16Le ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
  };
  const stdout = decode(result.stdout);
  const stderr = decode(result.stderr);
  if (result.status !== 0) {
    if (result.error) process.stderr.write(`${result.error.stack ?? result.error.message}\n`);
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    process.exit(result.status ?? 1);
  }
  return stdout;
}

function parseLastJsonObject(output) {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line === '{');
  assert.notEqual(start, -1, 'executed differential output must contain JSON');
  return JSON.parse(lines.slice(start).join('\n'));
}

const legacyManifestSha256 = sha256(legacyManifestBytes);
assert.equal(legacyManifestSha256, '1d6dcff51115ed5760cf6a9f30a169060d052d46feaf465ec1d205d79f5bd155');
assert.equal(legacyManifest.schemaVersion, 'terminal-resource-policy/v1');
assert.equal(legacyManifest.profileVersion, 'legacy-effective/v1');
assert.deepEqual(legacyManifest.evidence.consumerAstFingerprint, {
  schemaVersion: 'terminal-resource-evidence-ast/v1',
  typescriptVersion: '5.9.3',
});
const manifestSha256 = sha256(manifestBytes);
const greenEvidenceBytes = readFileSync(greenEvidencePath);
const greenEvidenceSha256 = sha256(greenEvidenceBytes);
const greenEvidence = JSON.parse(greenEvidenceBytes.toString('utf8'));
const greenEvidenceCorrection = JSON.parse(readFileSync(greenEvidenceCorrectionPath, 'utf8'));
const reportBytes = readFileSync(reportPath);
const reportSha256 = sha256(reportBytes);
const historicalReportSha256 = 'bdb2df484b184d29121c71427329be20d79314e07eb6d57d38e278101f0a2f60';
const report = reportBytes.toString('utf8');
const rawGreenNestedRoleDistribution = {
  'object-option-flow': 38,
  'reserved-copy': 2,
  'control-guard': 21,
  'call-input': 5,
  'derived-control': 5,
};
const authoritativeHistoricalRoleDistribution = {
  'object-option-flow': 47,
  'reserved-copy': 2,
  'control-guard': 20,
  'call-input': 6,
  'derived-control': 5,
};
assert.equal(greenEvidenceSha256, '4c77265d5c26f6db94033e40109d0782d92290d37b10aa5d69e9031c74c5c725');
assert.equal(reportSha256, historicalReportSha256, 'historical report raw bytes must match the immutable report seal');
assert.deepEqual(greenEvidence.evidenceSeal, {
  manifestSha256: legacyManifestSha256,
  sourceCount: 34,
  exactConsumerTuples: 80,
  latestReviewIteration: 7,
});
assert.match(report, new RegExp(legacyManifestSha256));
assert.match(report, /84d05c72ed8ca2ba8045c0a66d4f167f471c51cce473b0c84d8294d54dcdc4b3/);
assert.match(report, /evidence source 34개/);
assert.match(report, /5차.*6차.*7차/s);
assert.match(report, /exact consumer tuple 80개/);
assert.match(report, /object-option-flow 47.*reserved-copy 2.*control-guard 20.*call-input 6.*derived-control 5/);
assert.equal(Object.keys(legacyManifest.evidence.sourceHashes).length, 34);
assert.deepEqual(greenEvidence.inventoryArchitecture.evidenceRoles, rawGreenNestedRoleDistribution);
assert.equal(
  greenEvidence.inventoryArchitecture.activeSourceHashGuard.sourceSetSha256,
  'e43f57a2bfb7b86f39fc2fa7d6b1d725a5f05b8e6068628541ce2462381b9a46',
);
assert.deepEqual(evidenceRoleDistribution(legacyManifest.consumers), authoritativeHistoricalRoleDistribution);
assertHistoricalReportSeal(greenEvidenceCorrection.historicalAuthoritativeReport, reportBytes);
assert.deepEqual(greenEvidenceCorrection, {
  schemaVersion: 'ph-001-green-evidence-correction/v1',
  requirementId: 'OBS-BGSTAB-005',
  phaseId: 'PH-001',
  correctionType: 'historical-evidence-reconciliation',
  rawGreenEvidence: {
    path: `${artifactRoot}/ph-001/green-evidence.json`,
    sha256: greenEvidenceSha256,
    staleNestedSummary: {
      sourceCount: greenEvidence.inventoryArchitecture.activeSourceHashGuard.sourceCount,
      sourceSetSha256: greenEvidence.inventoryArchitecture.activeSourceHashGuard.sourceSetSha256,
      evidenceRoles: greenEvidence.inventoryArchitecture.evidenceRoles,
    },
  },
  historicalAuthoritativeManifest: {
    path: `${artifactRoot}/terminal-resource-consumer-manifest.json`,
    sha256: legacyManifestSha256,
    sourceCount: Object.keys(legacyManifest.evidence.sourceHashes).length,
    sourceSetSha256: legacyManifest.evidence.sourceSetSha256,
    exactConsumerTuples: legacyManifest.consumers.length,
    evidenceRoles: evidenceRoleDistribution(legacyManifest.consumers),
  },
  historicalAuthoritativeReport: {
    path: `${artifactRoot}/ph-001/report.md`,
    sha256: historicalReportSha256,
  },
  currentManifestContext: {
    path: `${artifactRoot}/terminal-resource-consumer-manifest.current.json`,
    sourceValidation: 'not-claimed-by-historical-reconciliation',
  },
  reconciliation: {
    historicalAuthority: 'sealed-historical-manifest-and-report',
    retrospectiveExecution: 'not-performed',
    currentSourceValidation: 'not-claimed',
  },
});
const correctionWithMutatedHistoricalReportSeal = {
  ...greenEvidenceCorrection,
  historicalAuthoritativeReport: {
    ...greenEvidenceCorrection.historicalAuthoritativeReport,
    sha256: `${historicalReportSha256}-mutation`,
  },
};
assert.throws(
  () => assertHistoricalReportSeal(correctionWithMutatedHistoricalReportSeal.historicalAuthoritativeReport, reportBytes),
  /historical report seal mismatch/,
);
assert.equal(
  existsSync(greenEvidenceCorrectionRedEvidencePath),
  true,
  'historical evidence correction must retain its append-only RED evidence',
);
const greenEvidenceCorrectionRedEvidence = JSON.parse(readFileSync(greenEvidenceCorrectionRedEvidencePath, 'utf8'));
assertHistoricalReportSeal(
  greenEvidenceCorrectionRedEvidence.inputs.historicalAuthoritativeReport,
  reportBytes,
);
assert.deepEqual(greenEvidenceCorrectionRedEvidence, {
  schemaVersion: 'ph-001-historical-evidence-correction-red-evidence/v1',
  requirementId: 'OBS-BGSTAB-005',
  phaseId: 'PH-001',
  correctionPath: `${artifactRoot}/ph-001/green-evidence-correction.json`,
  originalMissingCorrection: {
    command: 'node tools/wave3/terminal-resource-consumer-manifest.test.mjs',
    cwd: '.',
    exitCode: 1,
    failureSignature: 'historicalAuthoritativeReport',
  },
  inputs: {
    rawGreenEvidence: {
      path: `${artifactRoot}/ph-001/green-evidence.json`,
      sha256: greenEvidenceSha256,
    },
    historicalAuthoritativeManifest: {
      path: `${artifactRoot}/terminal-resource-consumer-manifest.json`,
      sha256: legacyManifestSha256,
    },
    historicalAuthoritativeReport: {
      path: `${artifactRoot}/ph-001/report.md`,
      sha256: historicalReportSha256,
    },
  },
});
for (const iteration of ['fifthReview', 'sixthReview', 'seventhReview']) {
  assert.ok(Object.hasOwn(greenEvidence.reviewRepair, iteration), `green evidence missing ${iteration}`);
}

assert.equal(manifest.schemaVersion, 'terminal-resource-policy/v1');
assert.equal(manifest.profileVersion, 'legacy-effective/v1');
assert.deepEqual(manifest.evidence.consumerAstFingerprint, {
  schemaVersion: 'terminal-resource-evidence-ast/v1',
  typescriptVersion: '5.9.3',
});
// 83, not the sealed historical 80: REL-BGSTAB-023 registered
// resourceLimits.terminal.checkpointMaxBytes with its TerminalView consumer (81), and #101
// registered resourceLimits.terminal.visibleFlushFrameBudgetMs with two consumers -- the
// TerminalView option flow and the scheduler's own frame deadline (83). #70 added the
// checkpoint chunk budget as its own consumer (84); #72 repointed two existing consumers
// from the output chunk cap to the new input count key and added the getInputQueueLimits
// projection that carries it (85).
// The historical
// seals asserted above stay at 80 — they record the PH-001 run, not today's inventory.
assert.equal(manifest.consumers.length, 86);
assert.equal(manifest.classifications.length, 10);
const consumerEvidenceAstMutation = {
  ...manifest,
  consumers: manifest.consumers.map((entry, index) => (index === 0
    ? { ...entry, evidenceAstSha256: `${entry.evidenceAstSha256}-mutation` }
    : entry)),
};
assert.notDeepEqual(
  semanticInventory(manifest),
  semanticInventory(consumerEvidenceAstMutation),
  'semantic equality must fail when only consumer evidenceAstSha256 changes',
);
const classificationAccessEvidenceMutation = {
  ...manifest,
  classifications: manifest.classifications.map((entry, index) => (index === 0
    ? { ...entry, accessEvidenceSha256: `${entry.accessEvidenceSha256}-mutation` }
    : entry)),
};
assert.notDeepEqual(
  semanticInventory(manifest),
  semanticInventory(classificationAccessEvidenceMutation),
  'semantic equality must fail when only classification accessEvidenceSha256 changes',
);
assert.equal(manifest.schemaVersion, legacyManifest.schemaVersion);
assert.equal(manifest.profileVersion, legacyManifest.profileVersion);
// A classification's accessEvidenceSha256 pins the occurrence multiset that buys its file an
// exemption from consumer registration, so it has to move whenever that file's resource accesses
// legitimately change. Held strictly equal to the immutable historical seal it is unsatisfiable,
// not safe - it went red here the moment resourceLimits.telemetry.sampleIntervalMs was retired
// from ConfigFileRepository. Enumerated drift keeps the property the strict form was reaching for:
// the verifier accepts exactly the classification identities the sealed lineage names, and the
// re-seal tool refuses to write a moved pin without --accept-classification-change, the same
// operator gate the decision axis already had. Both halves are needed: enumeration alone would let
// a re-pin ride along with a routine re-seal, and a pin is a blanket exemption from the
// unregistered-call-site scan, so hiding a real consumer behind one is exactly the abuse.
const classificationDrift = multisetDrift(
  legacyManifest.classifications,
  manifest.classifications,
  canonicalClassificationIdentity,
);
assert.deepEqual(
  classificationDrift,
  lineage.semanticInventory?.divergence?.classificationDrift,
  'every classification exemption pin that drifts from the sealed historical inventory must be enumerated in the sealed lineage record',
);
const decisionDrift = multisetDrift(legacyManifest.consumers, manifest.consumers, decisionIdentity);
assert.deepEqual(
  decisionDrift,
  lineage.semanticInventory?.divergence?.decisionDrift,
  'every retired or introduced resource decision must be enumerated in the sealed lineage record',
);
const currentSemanticDivergence = {
  reason: lineage.semanticInventory?.divergence?.reason,
  decisionDrift,
  classificationDrift,
  relocatedEvidence: relocatedEvidence(legacyManifest.consumers, manifest.consumers),
  evidenceHashOnlyChangedTuples: evidenceHashOnlyChangedTuples(legacyManifest.consumers, manifest.consumers),
};
assert.equal(typeof currentSemanticDivergence.reason, 'string');
assert.ok(currentSemanticDivergence.reason.length > 0, 'recorded semantic divergence must carry a reason');
const semanticInventorySha256 = sha256(JSON.stringify(semanticInventory(manifest)));
assert.deepEqual(lineage, {
  schemaVersion: 'terminal-resource-consumer-manifest-lineage/v1',
  historical: {
    path: `${artifactRoot}/terminal-resource-consumer-manifest.json`,
    sha256: legacyManifestSha256,
    sourceSetSha256: legacyManifest.evidence.sourceSetSha256,
  },
  current: {
    path: `${artifactRoot}/terminal-resource-consumer-manifest.current.json`,
    sha256: manifestSha256,
    sourceCount: Object.keys(manifest.evidence.sourceHashes).length,
    sourceSetSha256: manifest.evidence.sourceSetSha256,
    exactConsumerTuples: manifest.consumers.length,
    classifications: manifest.classifications.length,
  },
  semanticInventory: {
    sha256: semanticInventorySha256,
    historicalEqualsCurrent: semanticInventorySha256 === sha256(JSON.stringify(semanticInventory(legacyManifest))),
    divergence: currentSemanticDivergence,
  },
  currentSlice: {
    requirementId: 'OBS-BGSTAB-005',
    scope: 'canonical semantic identity seals consumer evidenceAstSha256 and classification accessEvidenceSha256',
    red: {
      command: 'node tools/wave3/terminal-resource-consumer-manifest.test.mjs',
      exitCode: 1,
      result: 'semantic equality must fail when only consumer evidenceAstSha256 changes',
    },
    green: {
      guard: {
        command: 'node tools/wave3/terminal-resource-consumer-manifest.test.mjs',
        exitCode: 0,
        result: 'consumer and classification evidence-hash mutation assertions pass',
      },
      focusedTerminalResourcePolicy: {
        command: 'npx.cmd tsx --test src/services/TerminalResourcePolicy.test.ts',
        exitCode: 0,
        result: 'all focused TerminalResourcePolicy tests pass',
      },
    },
  },
  ph002RuntimeAnchor: {
    sha256: '2dfec602f8e22db0569e5ff67f75bceada37d1959af38ecdb52441ebca7b3b57',
    sourceStatus: 'unavailable',
    revalidationStatus: 'not-revalidated',
    authority: 'non-authoritative',
  },
  historicalEvidenceCorrection: {
    path: `${artifactRoot}/ph-001/green-evidence-correction.json`,
    relation: 'reconciles-preserved-raw-green-nested-summary-with-sealed-historical-manifest',
    redEvidence: {
      path: `${artifactRoot}/ph-001/historical-evidence-correction-red-evidence.json`,
      relation: 'records-the-original-missing-historical-report-seal-red-result',
    },
  },
});
assert.equal(Object.hasOwn(lineage.ph002RuntimeAnchor, 'sourcePath'), false);
assert.notEqual(manifestSha256, lineage.ph002RuntimeAnchor.sha256);
assert.notEqual(legacyManifestSha256, lineage.ph002RuntimeAnchor.sha256);
// 37, not 35: REL-BGSTAB-009 extracted the grace lane out of WebSocketProvider#bufferGraceMessage
// into terminalGraceBuffer#applyGraceBufferedMessage, so that file is now a consumer path and
// enters the evidence source set (36). WebSocketContext.tsx stays in the set - it still owns
// WebSocketProvider#send - so this is an addition, not a relocation of the source count. #78
// then registered the server-side checkpoint chunk size, whose consumer lives in
// TerminalAuthorityProductionAdapter.ts, adding that file to the set (37).
assert.equal(Object.keys(manifest.evidence.sourceHashes).length, 37);
assert.ok(Array.isArray(manifest.consumers));
assert.ok(Array.isArray(manifest.classifications));
assert.deepEqual(sortedUnique(manifest.consumers.map((entry) => entry.category)), sortedUnique(expectedCategories));
assert.deepEqual(sortedUnique(manifest.consumers.map((entry) => entry.resourceKey)), expectedResourceKeys);
assert.equal(manifest.consumers.find((entry) => entry.resourceKey === 'resourceLimits.snapshots.perSnapshotMaxChars').unit, 'chars');
assert.equal(manifest.consumers.find((entry) => entry.resourceKey === 'resourceLimits.snapshots.totalStorageBudgetChars').unit, 'chars');

const tupleIds = new Set();
for (const entry of manifest.consumers) {
  for (const key of [
    'consumerId', 'category', 'resourceKey', 'unit', 'source', 'schemaVersion', 'profileVersion',
    'legacyAliases', 'applyBoundary', 'consumerPath', 'consumerSymbol', 'evidenceSignature', 'state',
    'evidenceRole', 'evidenceAstSha256',
  ]) assert.ok(Object.hasOwn(entry, key), `manifest entry missing ${key}`);
  assertRepositoryPath(entry.consumerPath);
  const source = readFileSync(join(repositoryRoot, entry.consumerPath), 'utf8');
  assert.ok(source.includes(entry.evidenceSignature), `consumer signature drift: ${entry.consumerPath}#${entry.consumerSymbol}`);
  const tupleId = [
    entry.consumerId,
    entry.category,
    entry.resourceKey,
    entry.unit,
    entry.source,
    entry.schemaVersion,
    entry.profileVersion,
    JSON.stringify([...entry.legacyAliases].sort((left, right) => left.localeCompare(right))),
    entry.applyBoundary,
    entry.consumerPath,
    entry.consumerSymbol,
    entry.evidenceSignature,
    entry.evidenceRole,
    entry.evidenceAstSha256,
    entry.state,
  ].join('|');
  assert.equal(tupleIds.has(tupleId), false, `duplicate exact consumer tuple: ${tupleId}`);
  tupleIds.add(tupleId);
}
for (const entry of manifest.classifications) {
  assertRepositoryPath(entry.path);
  const source = readFileSync(join(repositoryRoot, entry.path), 'utf8');
  assert.ok(source.includes(entry.evidenceSignature), `classification signature drift: ${entry.path}#${entry.symbol}`);
  assert.ok(entry.reason.length > 0);
}
const classifiedPaths = sortedUnique([
  ...manifest.consumers.map((entry) => entry.consumerPath),
  ...manifest.classifications.map((entry) => entry.path),
]);
for (const path of requiredTracePaths) assert.ok(classifiedPaths.includes(path), `missing SRS trace classification: ${path}`);
for (const path of classifiedPaths) {
  assert.ok(Object.hasOwn(manifest.evidence.sourceHashes, path), `classified consumer source is not hashed: ${path}`);
}

const reserved = manifest.consumers
  .filter((entry) => entry.state === 'reserved-unapplied')
  .map((entry) => entry.resourceKey)
  .sort();
assert.deepEqual(reserved, [
  'resourceLimits.headless.writeBatchMaxBytes',
  'resourceLimits.headless.writeLagWarnMs',
]);
const scrollbackEntries = manifest.consumers.filter((entry) => entry.resourceKey === 'resourceLimits.terminal.scrollbackLines');
assert.equal(scrollbackEntries.length, 3);
assert.deepEqual(sortedUnique(scrollbackEntries.map((entry) => entry.source)), [
  'resourceLimits.terminal.scrollbackLines',
]);
assert.ok(scrollbackEntries.every((entry) => entry.state === 'consumed'));
assert.ok(
  scrollbackEntries.every((entry) => entry.legacyAliases.includes('pty.scrollbackLines')),
  'retiring the scrollback divergence must keep the legacy key reachable as an alias',
);
assert.deepEqual(sortedUnique(scrollbackEntries.map((entry) => entry.applyBoundary)), [
  'headless-terminal-construction',
  'session-generation',
  'terminal-runtime-construction',
]);

assert.equal(manifest.evidence.activation.eligible, false);
assert.match(manifest.evidence.activation.reason, /no stable candidate contract/i);
assert.equal(Object.hasOwn(manifest.evidence, 'observeParity'), false, 'parity claims must come from executed differential evidence');
for (const [path, expectedHash] of Object.entries(manifest.evidence.sourceHashes)) {
  assertRepositoryPath(path);
  assert.equal(sha256(readFileSync(join(repositoryRoot, path))), expectedHash, `source hash drift: ${path}`);
}
const sourceSetRows = Object.entries(manifest.evidence.sourceHashes)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([path, hash]) => `${path}:${hash}`)
  .join('\n');
assert.equal(sha256(sourceSetRows), manifest.evidence.sourceSetSha256);
for (const [path, expectedHash] of Object.entries(manifest.evidence.rawGreenEvidence)) {
  assertRepositoryPath(path);
  assert.equal(sha256(readFileSync(join(repositoryRoot, path))), expectedHash, `raw GREEN evidence drift: ${path}`);
}

const focused = run(
  process.execPath,
  [
    join(repositoryRoot, 'server/node_modules/tsx/dist/cli.mjs'),
    '--test',
    'src/services/TerminalResourcePolicy.test.ts',
    'src/services/RuntimeConfigStore.test.ts',
  ],
  join(repositoryRoot, 'server'),
);
if (process.argv.includes('--write-focused-evidence')) {
  writeFileSync(focusedEvidencePath, focused.replace(/\r\n/g, '\n'), 'utf8');
}
// These two assertions used to share one number, and that is unsatisfiable rather than strict.
// focusedEvidencePath is the PH-001 GREEN artifact: it records that run, and line 654 above pins
// its bytes by sha256, so it says `pass 24` permanently. The live run is today's, over two suites
// that later lanes legitimately added cases to, and it says `pass 31`. Requiring one regex to
// match both leaves only two exits - forge the sealed artifact, or freeze the two suites - and the
// conflict stayed invisible because this file goes red earlier whenever the inventory is red,
// which it was from the moment REL-BGSTAB-009 relocated the grace lane.
//
// So they are separated by what each one is evidence OF. `fail 0` carries the green claim; the
// live count is here so that tests DISAPPEARING is red too, which `fail 0` alone permits.
//
// Do NOT run --write-focused-evidence to reconcile these: it overwrites the sealed artifact and
// line 654 goes red, because the re-seal tool deliberately copies rawGreenEvidence hashes verbatim
// rather than re-deriving them.
// Normalised first: `$` in a JS multiline regex matches before \n and never before \r, and this
// child's output can carry CRLF - the --write-focused-evidence branch below already strips it. An
// anchored parse against the raw text would red on a Windows checkout for a reason unrelated to the
// suite. `fail 0` is anchored for the same reason it is load-bearing: unanchored it also matches
// "fail 0" inside a longer number or a test title.
const focusedNormalised = focused.replace(/\r\n/g, '\n');
const focusedPassMatch = /^\u2139 pass (\d+)$/m.exec(focusedNormalised);
const focusedTestsMatch = /^\u2139 tests (\d+)$/m.exec(focusedNormalised);
assert.ok(focusedPassMatch, 'the focused run must emit a parseable pass count');
assert.ok(focusedTestsMatch, 'the focused run must emit a parseable test count');
const focusedPassCount = Number(focusedPassMatch[1]);
const focusedTestCount = Number(focusedTestsMatch[1]);
// The pins here were the literals 31/31, sitting directly under a comment warning that
// a hardcoded count is how the 24 drifted. Retyping 31 -> 32 when a lane adds a case
// would have made that comment false in the same edit that proved it true.
//
// But a count derived from these two files would have been WORSE than the literal, and
// that is the point. The count was carrying two properties: `fail 0` makes the green
// claim, and the count is what makes a test DISAPPEARING red, which `fail 0` alone
// permits. Any count recomputed from the same two files moves with them -- delete a
// test and both the expectation and the observation drop together, so the guard keeps
// passing while the thing it guards is gone. Derivation would have preserved the
// appearance of the check and removed half of what it checks.
//
// So the count is replaced by the corpus it was standing in for, following the
// precedent of canary-admission-evidence.test.mjs, which replaced its own exactTests
// 42/133 pins with an enumerated registry. Names are semantic where a number is not: a
// renamed or deleted test is a real change that must be looked at, while a lane adding
// a case is not, and now costs nobody a retype.
//
// Captured from a real run, not transcribed.
const requiredFocusedTestNames = Object.freeze([
  'FR-BGSTAB-015 recentEventLimit capability is available with truthful constraints',
  'FR-BGSTAB-015 recentEventLimit rejects invalid values without clamping or changing observer state',
  // #94 audit note: these two titles are COMPOSED AT RUNTIME --
  //   RuntimeConfigStore.test.ts:208 builds them as
  //   test(`FR-BGSTAB-015 ${replacement} applies recentEventLimit ...`)
  // so `git grep -F` on either string finds nothing but log artifacts, and a name-based
  // source audit concludes they are phantom registrations. They are not; they are real and
  // they run. This is a second blind spot in name-based lookup, distinct from the one #94
  // names (a title that omits its requirement prefix): a title that exists only at runtime.
  // Verify by executing, never by grepping the source.
  'FR-BGSTAB-015 replaceFromConfig applies recentEventLimit to the existing observer immediately',
  'FR-BGSTAB-015 replaceValues applies recentEventLimit to the existing observer immediately',
  'FR-BGSTAB-025 runtime snapshot and capabilities contain no retired leaves',
  'IR-BGSTAB-001 AC-8 publishes terminalWireFormat and nothing else beyond the existing allowlist',
  'IR-BGSTAB-001 AC-8 republishes terminalWireFormat after a runtime config reload',
  'OBS-BGSTAB-005 a classification pin that does not match its recomputed evidence names itself',
  'OBS-BGSTAB-005 review regression — ConfigFileRepository previous/next provenance survives settings reload and rollback',
  'OBS-BGSTAB-005 review regression — compiler owns all 34 typed resources and records real legacy divergence',
  'OBS-BGSTAB-005 review regression — exact repository tuples validate bidirectionally and detect new callsites',
  'OBS-BGSTAB-005 review regression — invalid raw provenance is sanitized and never silently falls through',
  'OBS-BGSTAB-005 review regression — no candidate profile is available without a registered stable contract',
  'OBS-BGSTAB-005 review regression — observer differential preserves actual serialized legacy paths',
  'OBS-BGSTAB-005 review regression — raw provenance survives production loaders and replacements',
  'OBS-BGSTAB-005 review regression — telemetry is allowlisted, payload-free, bounded, and read-only on snapshot',
  'OBS-BGSTAB-005 second review regression — differential executes actual server and browser consumer helpers',
  'OBS-BGSTAB-005 second review regression — explicit non-scrollback keys retain truthful loader provenance',
  'OBS-BGSTAB-005 second review regression — production observe mode seeds bounded decisions on every config generation',
  'OBS-BGSTAB-005 third review regression — catalog evidence must be executable and remain in the intended symbol scope',
  'Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-1',
  'Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-2',
  'Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-3',
  'Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-4',
  'Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-5',
  'Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-6',
  'Observe-only TerminalResourcePolicy RED contract — OBS-BGSTAB-005 AC-7',
  'PERF-BGSTAB-010 AC-4 fair delivery policy projection is derived from typed WS resource limits',
  'RuntimeConfigStore builds a redacted editable snapshot',
  'RuntimeConfigStore exposes Wave6 resource capabilities without leaking server-only runtime config',
  'RuntimeConfigStore marks platform-specific capabilities and merges editable patches',
  'RuntimeConfigStore validates Wave 0 resource limit patches after merging',
]);

// Property 1: nothing is failing, skipped or todo. `pass === tests` catches the case the
// old comment named -- one todo makes `tests` exceed `pass` while `fail 0` still holds.
assert.equal(
  focusedPassCount, focusedTestCount,
  `focused run has non-passing cases: pass ${focusedPassCount} of tests ${focusedTestCount}`,
);

// Property 2: every required case is still THERE. This is what the literal was really
// for, and it now fails by name instead of by arithmetic.
const observedFocusedNames = new Set(
  [...focusedNormalised.matchAll(/^\u2714 (.+?)(?: \([\d.]+ms\))?$/gm)].map((m) => m[1]),
);
const missingFocusedNames = requiredFocusedTestNames.filter((name) => !observedFocusedNames.has(name));
assert.deepEqual(
  missingFocusedNames, [],
  `focused run no longer contains ${missingFocusedNames.length} required case(s); a renamed or deleted test must be reviewed, not re-pinned`,
);
// Non-vacuity: the name parse must actually have found cases. Without this, a change to
// the runner's output format would empty `observedFocusedNames`, and an empty required
// list would then be trivially satisfied -- the exact shape of defect this file exists to
// catch elsewhere.
assert.ok(requiredFocusedTestNames.length > 0, 'the required focused corpus is empty');
assert.ok(
  observedFocusedNames.size >= requiredFocusedTestNames.length,
  `parsed only ${observedFocusedNames.size} case names from the focused run; the output format likely changed`,
);
assert.match(focusedNormalised, /^\u2139 fail 0$/m);
// Anchored and normalised for the same reason as the live assertions three lines up. These are the
// two that matter most: the sealed artifact is the input an operator can regenerate or hand-edit,
// and unanchored `/pass 24/` also matches `pass 240` or a test title containing that text.
const sealedFocused = readFileSync(focusedEvidencePath, 'utf8').replace(/\r\n/g, '\n');
assert.match(sealedFocused, /^\u2139 pass 24$/m);
assert.match(sealedFocused, /^\u2139 fail 0$/m);

const differentialOutput = run(
  process.execPath,
  [
    join(repositoryRoot, 'server/node_modules/tsx/dist/cli.mjs'),
    join(repositoryRoot, 'tools/wave3/terminal-resource-policy-differential.ts'),
  ],
  repositoryRoot,
);
const executedDifferential = parseLastJsonObject(differentialOutput);
const recordedDifferential = JSON.parse(readFileSync(differentialEvidencePath, 'utf8'));
assert.deepEqual(executedDifferential, recordedDifferential);
const consumerDimensions = Object.values(executedDifferential.actualConsumers.dimensions);
const coverage = Object.values(executedDifferential.actualConsumers.coverage);
const claims = {
  actualConsumerByteParity: executedDifferential.actualConsumers.byteForByteEqual === true
    && consumerDimensions.every((value) => value === true),
  actualConsumerCoverage: coverage.every((value) => value === true),
  runtimeProjectionParity: executedDifferential.runtimeProjection.byteForByteEqual === true,
  legacyOnlyApplied: executedDifferential.candidate.appliedPolicyId === executedDifferential.candidate.legacyPolicyId,
  unregisteredCandidateUnavailable: executedDifferential.candidate.status === 'unavailable'
    && executedDifferential.candidate.reason === 'candidate-policy-not-registered',
  evidenceDoesNotClaimRuntimeApplication: executedDifferential.evidenceOwnership.runtimeApplicationClaimed === false,
  getterReadOnly: executedDifferential.telemetry.getterReadOnly === true,
  observerSeparation: executedDifferential.telemetry.disabledCount === 0
    && executedDifferential.telemetry.observedCount > 0,
  payloadFree: executedDifferential.telemetry.payloadFree === true,
};
assert.ok(Object.values(claims).every(Boolean), `executed differential claims failed: ${JSON.stringify(claims)}`);

// activationEligible was the literal `false`. Nothing computed it, and it was true of both
// the healthy state and the defective one: if enforcement ever became eligible, the line
// would keep reporting false. That is the vacuous-assertion class, but inside an evidence
// artifact rather than a test, which is worse -- VE rows cite it.
//
// The real gate lives in a sibling bundle (canary-admission-evidence's evaluateActivation)
// and takes inputs this verifier does not have. Importing it would couple two bundles for
// one boolean. But the executed differential already carries the gate's actual answer, from
// the same issue() call every claim above derives from, so that is the source used here.
//
// Non-vacuity matters and it fails in the dangerous direction: `undefined !== 'unavailable'`
// is true, so a missing field would silently report ELIGIBLE. Assert the field's presence
// before reading it.
assert.equal(
  typeof executedDifferential.candidate.status, 'string',
  'candidate.status is missing; activationEligible would silently report eligible',
);
const activationEligible = executedDifferential.candidate.status !== 'unavailable';
const activationReason = activationEligible ? null : executedDifferential.candidate.reason;

process.stdout.write(`${JSON.stringify({
  requirementId: 'OBS-BGSTAB-005',
  schemaVersion: manifest.schemaVersion,
  profileVersion: manifest.profileVersion,
  exactConsumerTuples: manifest.consumers.length,
  classifiedPaths: classifiedPaths.length,
  resourceKeys: expectedResourceKeys.length,
  focusedTests: focusedTestCount,
  focusedPass: focusedPassCount,
  claims,
  activationEligible,
  activationReason,
  // Every field above this line is measured. `requirementId` is the one declaration in the
  // report -- an identifier, not an observation. Stated so that a declaration cannot be read
  // as a measurement, which is the defect this field itself used to be.
  declaredFields: ['requirementId'],
    manifestSha256,
}, null, 2)}\n`);
