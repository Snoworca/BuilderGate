import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(import.meta.dirname, '../..');
const ANALYSIS_ROOT = resolve(
  PROJECT_ROOT,
  'docs/analysis/kiwi-planner-2026-07-15.projectmaster.wave1-baseline',
);
const ARTIFACT_PATH = resolve(ANALYSIS_ROOT, 'retained-state-characterization.json');
const DEFAULT_LIVE_RESULTS_PATH = resolve(ANALYSIS_ROOT, 'retained-state-live-cases.json');
const DEFAULT_MATRIX_REPORT_PATH = resolve(ANALYSIS_ROOT, 'playwright-reports/retained-state-live-matrix.json');
const DEFAULT_TC7004_REPORT_PATH = resolve(ANALYSIS_ROOT, 'playwright-reports/tc7004.json');
const DEFAULT_TC7004_OWNERSHIP_REPORT_PATH = resolve(ANALYSIS_ROOT, 'playwright-reports/tc7004-ownership.json');
const DEFAULT_SERVER_BOUNDARY_PATH = resolve(ANALYSIS_ROOT, 'legacy-server-snapshot-boundary.json');
const MATRIX_FILE = 'wave1-retained-state-characterization.spec.ts';
const MATRIX_TITLE = 'AC-1~7 executes the six-case matrix through real browser refresh';
const TC7004_FILE = 'header-context-menu-regression.spec.ts';
const TC7004_TITLE = 'TC-7004: reload should keep the active session visible and restore its snapshot without xterm runtime errors';
const TC7004_OWNERSHIP_TITLE = 'TC-OWNERSHIP-7004 cleanup guard refuses an exact-ID name/token mismatch';
const MATRIX_COMMAND = 'npx playwright test tests/e2e/wave1-retained-state-characterization.spec.ts --project "Desktop Chrome" --grep "AC-1~7 executes" --reporter=json';
const TC7004_COMMAND = 'npx playwright test tests/e2e/header-context-menu-regression.spec.ts --grep "TC-7004" --project "Desktop Chrome" --reporter=json';
const TC7004_OWNERSHIP_COMMAND = 'npx playwright test tests/e2e/header-context-menu-regression.spec.ts --grep "TC-OWNERSHIP-7004" --project "Desktop Chrome" --reporter=json';
const LIVE_EVIDENCE_ANCHORS = {
  'pre-post': ['pre', 'post', 'effectiveRuntimeBoundary', 'analysis'],
  'local-cache': ['localCache'],
  'debug-events': ['debugEventKinds'],
  refresh: ['refresh'],
  visibility: ['refresh'],
};

function resolveArgument(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((candidate) => candidate.startsWith(prefix));
  return argument ? resolve(PROJECT_ROOT, argument.slice(prefix.length)) : fallback;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('artifact must be JSON-serializable');
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
    .join(',')}}`;
}

async function readJsonWithBytes(filePath) {
  const bytes = await readFile(filePath);
  return {
    filePath,
    bytes,
    sha256: sha256(bytes),
    value: JSON.parse(bytes.toString('utf8')),
  };
}

function collectSpecs(suites, destination = []) {
  for (const suite of suites ?? []) {
    destination.push(...(suite.specs ?? []));
    collectSpecs(suite.suites, destination);
  }
  return destination;
}

function requirePassedSpec(reportRecord, expected) {
  const report = reportRecord.value;
  if (report.stats?.unexpected !== 0 || report.stats?.flaky !== 0 || report.stats?.expected !== 1) {
    throw new Error(`${expected.label} report stats do not prove one clean pass`);
  }
  const specs = collectSpecs(report.suites);
  if (specs.length !== 1) {
    throw new Error(`${expected.label} report must contain exactly one selected spec`);
  }
  const spec = specs[0];
  if (spec.file !== expected.file || spec.title !== expected.title || spec.ok !== true) {
    throw new Error(`${expected.label} report identity mismatch`);
  }
  if (spec.tests?.length !== 1) throw new Error(`${expected.label} requires one project result`);
  const test = spec.tests[0];
  if (
    test.projectName !== 'Desktop Chrome'
    || test.expectedStatus !== 'passed'
    || test.status !== 'expected'
    || test.results?.length !== 1
  ) {
    throw new Error(`${expected.label} project/status evidence is invalid`);
  }
  const result = test.results[0];
  if (result.status !== 'passed' || result.retry !== 0 || result.errors?.length !== 0) {
    throw new Error(`${expected.label} attempt evidence is not a first-attempt clean pass`);
  }
  return { report, spec, test, result };
}

function decodeJsonAttachment(result, attachmentName) {
  const attachments = (result.attachments ?? []).filter(
    (attachment) => attachment.name === attachmentName && attachment.contentType === 'application/json',
  );
  if (attachments.length !== 1 || typeof attachments[0].body !== 'string') {
    throw new Error(`${attachmentName} must be embedded once in the Playwright JSON report`);
  }
  const bytes = Buffer.from(attachments[0].body, 'base64');
  return { bytes, sha256: sha256(bytes), value: JSON.parse(bytes.toString('utf8')) };
}

function validateLiveResults(liveResults) {
  if (
    liveResults.schemaVersion !== '1.0.0'
    || liveResults.requirementId !== 'OBS-BGSTAB-004'
    || liveResults.evidenceKind !== 'live_browser_refresh_matrix'
    || liveResults.browserOrigin !== 'https://localhost:2222'
  ) {
    throw new Error('live retained-state artifact identity is invalid');
  }
  if (liveResults.testIdentity?.project !== 'Desktop Chrome' || liveResults.testIdentity?.retry !== 0) {
    throw new Error('live retained-state test identity is invalid');
  }
  if (!Array.isArray(liveResults.cases) || liveResults.cases.length !== 6) {
    throw new Error('live retained-state matrix must contain exactly six cases');
  }
  const caseIds = liveResults.cases.map((candidate) => candidate.caseId);
  if (new Set(caseIds).size !== 6 || canonicalize(caseIds) !== canonicalize(liveResults.manifestCaseIds)) {
    throw new Error('live retained-state manifest/result IDs differ');
  }
  const expectedPositions = new Map([
    ['before', 2 * 1024 * 1024 - 1],
    ['at', 2 * 1024 * 1024],
    ['after', 2 * 1024 * 1024 + 1],
  ]);
  const observedLineSeeds = new Set();
  const observedPayloadPositions = new Set();
  const axisValues = {
    localCache: new Set(),
    view: new Set(),
    text: new Set(),
    terminalBuffer: new Set(),
  };
  for (const candidate of liveResults.cases) {
    if (candidate.executionKind !== 'live_browser_refresh' || candidate.refresh?.performed !== true) {
      throw new Error(`${candidate.caseId} is not a live browser refresh result`);
    }
    if (candidate.isolation?.deletionScope !== 'exact-created-workspace-id-only') {
      throw new Error(`${candidate.caseId} workspace isolation is not exact-ID scoped`);
    }
    for (const axis of Object.keys(axisValues)) axisValues[axis].add(candidate.axes?.[axis]);
    if (candidate.input?.logicalLineSeed !== null) {
      observedLineSeeds.add(candidate.input.logicalLineSeed);
    }
    const seed = candidate.input?.legacySerializedPayloadSeed;
    if (seed !== null) {
      const exact = candidate.input?.clientLocalStorageJsonBoundary;
      if (
        expectedPositions.get(seed.position) !== seed.bytes
        || exact?.targetBytes !== seed.bytes
        || exact?.measuredUtf8Bytes !== seed.bytes
        || !/^[0-9a-f]{64}$/u.test(exact?.sha256 ?? '')
        || exact?.evidenceRole !== 'client-boundary-only-not-server-serializer'
      ) {
        throw new Error(`${candidate.caseId} client JSON byte evidence is invalid`);
      }
      observedPayloadPositions.add(seed.position);
    }
    const boundary = candidate.effectiveRuntimeBoundary;
    if (
      boundary?.source !== 'https://localhost:2222/api/runtime-config'
      || boundary.serializedPayloadBoundary?.unit !== 'characters'
      || boundary.serializedPayloadBoundary?.provenance
        !== 'https://localhost:2222/api/runtime-config#resourceLimits.snapshots.perSnapshotMaxChars'
      || canonicalize(candidate.analysis?.effectiveBoundary) !== canonicalize({
        retainedLineStart: boundary.retainedLineStart,
        retainedLineEnd: boundary.retainedLineEnd,
        serializedPayloadBoundary: boundary.serializedPayloadBoundary,
      })
      || typeof candidate.analysis?.classification?.expectedCurrentEviction !== 'number'
      || typeof candidate.analysis?.classification?.observedLoss !== 'number'
    ) {
      throw new Error(`${candidate.caseId} runtime boundary/analyzer evidence is invalid`);
    }
    for (const cause of candidate.causeSignals ?? []) {
      for (const reference of cause.evidenceReferences ?? []) {
        const match = /^live-case:\/\/([^#]+)#([a-z-]+)$/u.exec(reference);
        const anchor = match?.[2];
        if (
          match?.[1] !== candidate.caseId
          || !anchor
          || !(anchor in LIVE_EVIDENCE_ANCHORS)
          || LIVE_EVIDENCE_ANCHORS[anchor].some((field) => candidate[field] === undefined)
        ) {
          throw new Error(`${candidate.caseId} contains an unresolved cause evidence reference: ${reference}`);
        }
      }
    }
  }
  if (canonicalize([...observedLineSeeds].sort((left, right) => left - right)) !== canonicalize([24, 1000, 10000])) {
    throw new Error('logical-line seed coverage is incomplete');
  }
  if (canonicalize([...observedPayloadPositions].sort()) !== canonicalize(['after', 'at', 'before'])) {
    throw new Error('legacy payload boundary coverage is incomplete');
  }
  const expectedAxes = {
    localCache: ['absent', 'poisoned', 'valid'],
    view: ['active', 'hidden'],
    text: ['ASCII', 'CJK-wide', 'combining', 'emoji'],
    terminalBuffer: ['alternate', 'normal'],
  };
  for (const [axis, values] of Object.entries(expectedAxes)) {
    if (canonicalize([...axisValues[axis]].sort()) !== canonicalize(values)) {
      throw new Error(`${axis} axis coverage is incomplete`);
    }
  }
  const { contentDigest, ...withoutDigest } = liveResults;
  if (
    contentDigest?.algorithm !== 'sha256'
    || contentDigest.value !== sha256(JSON.stringify(withoutDigest))
  ) {
    throw new Error('live retained-state content digest is invalid');
  }
}

function validateServerBoundaryEvidence(evidence) {
  const { contentDigest, ...payload } = evidence;
  if (
    evidence.schemaVersion !== '1.0.0'
    || evidence.requirementId !== 'OBS-BGSTAB-004'
    || evidence.evidenceKind !== 'controlled_product_serializer_boundary'
    || evidence.maxSnapshotBytes !== 2 * 1024 * 1024
    || evidence.source?.file !== 'server/src/utils/headlessTerminal.ts'
    || evidence.source?.function !== 'serializeHeadlessTerminal'
    || contentDigest?.algorithm !== 'sha256'
    || contentDigest.value !== sha256(JSON.stringify(payload))
  ) {
    throw new Error('server serializer boundary evidence identity/digest is invalid');
  }
  const expected = [
    { position: 'before', bytes: 2 * 1024 * 1024 - 1, truncated: false },
    { position: 'at', bytes: 2 * 1024 * 1024, truncated: false },
    { position: 'after', bytes: 2 * 1024 * 1024 + 1, truncated: true },
  ];
  for (let index = 0; index < expected.length; index += 1) {
    const candidate = evidence.cases?.[index];
    const contract = expected[index];
    if (
      candidate?.position !== contract.position
      || candidate.requestedPayloadBytes !== contract.bytes
      || candidate.measuredPayloadBytes !== contract.bytes
      || candidate.truncated !== contract.truncated
      || candidate.returnedDataBytes !== (contract.truncated ? 0 : contract.bytes)
      || candidate.rawPayloadOmitted !== true
      || !/^[0-9a-f]{64}$/u.test(candidate.payloadSha256 ?? '')
    ) {
      throw new Error(`server serializer ${contract.position} boundary evidence is invalid`);
    }
  }
}

function validateTc7004Attachment(value) {
  if (
    value.schemaVersion !== '1.0.0'
    || value.testId !== 'TC-7004'
    || value.executionKind !== 'live_browser_refresh'
    || value.oldMarkerAfterReload !== 'absent'
    || value.latestMarkerAfterReload !== 'present'
    || value.fatalRuntimeErrorCount !== 0
    || value.rawTerminalTextOmitted !== true
    || value.workspaceIsolation?.deletionScope !== 'exact-created-workspace-id-only'
  ) {
    throw new Error('TC-7004 attachment does not prove the accepted current behavior');
  }
}

const liveResultsPath = resolveArgument('live-results', DEFAULT_LIVE_RESULTS_PATH);
const matrixReportPath = resolveArgument('matrix-report', DEFAULT_MATRIX_REPORT_PATH);
const tc7004ReportPath = resolveArgument('tc7004-report', DEFAULT_TC7004_REPORT_PATH);
const tc7004OwnershipReportPath = resolveArgument(
  'tc7004-ownership-report',
  DEFAULT_TC7004_OWNERSHIP_REPORT_PATH,
);
const serverBoundaryPath = resolveArgument('server-boundary', DEFAULT_SERVER_BOUNDARY_PATH);
const [
  liveRecord,
  matrixReportRecord,
  tc7004ReportRecord,
  tc7004OwnershipReportRecord,
  serverBoundaryRecord,
] = await Promise.all([
  readJsonWithBytes(liveResultsPath),
  readJsonWithBytes(matrixReportPath),
  readJsonWithBytes(tc7004ReportPath),
  readJsonWithBytes(tc7004OwnershipReportPath),
  readJsonWithBytes(serverBoundaryPath),
]);
const matrixExecution = requirePassedSpec(matrixReportRecord, {
  label: 'live matrix', file: MATRIX_FILE, title: MATRIX_TITLE,
});
const tc7004Execution = requirePassedSpec(tc7004ReportRecord, {
  label: 'TC-7004', file: TC7004_FILE, title: TC7004_TITLE,
});
const tc7004OwnershipExecution = requirePassedSpec(tc7004OwnershipReportRecord, {
  label: 'TC-7004 ownership guard', file: TC7004_FILE, title: TC7004_OWNERSHIP_TITLE,
});
const embeddedLiveRecord = decodeJsonAttachment(
  matrixExecution.result,
  'retained-state-live-cases',
);
const tc7004Attachment = decodeJsonAttachment(
  tc7004Execution.result,
  'tc7004-current-behavior',
);
if (embeddedLiveRecord.sha256 !== liveRecord.sha256) {
  throw new Error('live results file differs from the matrix report attachment');
}
validateLiveResults(liveRecord.value);
validateLiveResults(embeddedLiveRecord.value);
validateTc7004Attachment(tc7004Attachment.value);
validateServerBoundaryEvidence(serverBoundaryRecord.value);

const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
  execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }),
  execFileAsync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' }),
]);
const cases = liveRecord.value.cases;
const causeSignalCount = cases.reduce(
  (total, candidate) => total + candidate.causeSignals.length,
  0,
);
const artifactPayload = {
  schemaVersion: '2.0.0',
  requirementId: 'OBS-BGSTAB-004',
  gitCommit: commitOutput.trim(),
  workingTreeDirty: statusOutput.trim().length > 0,
  browserOrigin: liveRecord.value.browserOrigin,
  evidenceScope: {
    liveCurrentBehaviorCaseIds: ['TC-7004', ...liveRecord.value.manifestCaseIds],
    matrixExecutesLiveRefresh: true,
    capturesActualXtermPublicBufferState: true,
    fixtureObservedLossIsNotRuntimeIncidence: false,
  },
  evidenceReferenceScheme: {
    scheme: 'live-case',
    template: 'live-case://{caseId}#{anchor}',
    anchors: Object.fromEntries(Object.entries(LIVE_EVIDENCE_ANCHORS).map(([anchor, fields]) => [
      anchor,
      fields.map((field) => `#/results/{caseIndex}/${field}`),
    ])),
  },
  rawEvidenceByCase: Object.fromEntries(cases.map((candidate, caseIndex) => [
    candidate.caseId,
    Object.fromEntries(Object.entries(LIVE_EVIDENCE_ANCHORS).map(([anchor, fields]) => [
      anchor,
      fields.map((field) => `#/results/${caseIndex}/${field}`),
    ])),
  ])),
  results: cases,
  summary: {
    caseCount: cases.length,
    clientJsonPayloadByteCases: cases.filter(
      (candidate) => candidate.input.clientLocalStorageJsonBoundary !== null,
    ).length,
    serverSerializerByteCases: serverBoundaryRecord.value.cases.length,
    causeSignalCount,
    expectedCurrentEviction: cases.reduce(
      (total, candidate) => total + candidate.analysis.classification.expectedCurrentEviction,
      0,
    ),
    observedLoss: cases.reduce(
      (total, candidate) => total + candidate.analysis.classification.observedLoss,
      0,
    ),
    interpretation: 'live_current_behavior_characterization_no_product_budget_or_authority_promotion',
  },
  tc7004: {
    ...tc7004Attachment.value,
    evidenceKind: 'separate_current_behavior',
    snapshotScope: 'viewport-only',
    targetRetainedStateParity: false,
    futureRetentionPromise: false,
  },
  serverSerializedPayloadBoundary: {
    ...serverBoundaryRecord.value,
    artifactPath: serverBoundaryPath,
    artifactSha256: serverBoundaryRecord.sha256,
    executionCommand: 'npx tsx src/benchmarks/retainedStateLegacyBoundary.ts',
    focusedTestCommand: 'npx tsx --test src/benchmarks/retainedStateLegacyBoundary.test.ts',
  },
  executionEvidence: {
    matrix: {
      commandContract: MATRIX_COMMAND,
      reportPath: matrixReportPath,
      reportSha256: matrixReportRecord.sha256,
      selectedFile: matrixExecution.spec.file,
      selectedTitle: matrixExecution.spec.title,
      project: matrixExecution.test.projectName,
      resultStatus: matrixExecution.result.status,
      retry: matrixExecution.result.retry,
      attachmentSha256: embeddedLiveRecord.sha256,
      startTime: matrixExecution.result.startTime,
      durationMs: matrixExecution.result.duration,
    },
    tc7004: {
      commandContract: TC7004_COMMAND,
      reportPath: tc7004ReportPath,
      reportSha256: tc7004ReportRecord.sha256,
      selectedFile: tc7004Execution.spec.file,
      selectedTitle: tc7004Execution.spec.title,
      project: tc7004Execution.test.projectName,
      resultStatus: tc7004Execution.result.status,
      retry: tc7004Execution.result.retry,
      attachmentSha256: tc7004Attachment.sha256,
      startTime: tc7004Execution.result.startTime,
      durationMs: tc7004Execution.result.duration,
    },
    tc7004OwnershipGuard: {
      commandContract: TC7004_OWNERSHIP_COMMAND,
      reportPath: tc7004OwnershipReportPath,
      reportSha256: tc7004OwnershipReportRecord.sha256,
      selectedFile: tc7004OwnershipExecution.spec.file,
      selectedTitle: tc7004OwnershipExecution.spec.title,
      project: tc7004OwnershipExecution.test.projectName,
      resultStatus: tc7004OwnershipExecution.result.status,
      retry: tc7004OwnershipExecution.result.retry,
      startTime: tc7004OwnershipExecution.result.startTime,
      durationMs: tc7004OwnershipExecution.result.duration,
    },
  },
  limitations: [
    'This is current-behavior evidence and does not define a product retained range, memory budget, recovery SLO, or authority migration.',
    'The server 2 MiB product cap is exercised through serializeHeadlessTerminal; browser localStorage JSON byte seeds remain separate client-boundary evidence.',
    'The retained-state capture uses xterm public buffer APIs and records hashes/fingerprints instead of raw terminal text.',
  ],
  nonPromotionGuard: liveRecord.value.nonPromotionGuard,
  rawContentPolicy: {
    storesTerminalText: false,
    storesOnlyCanonicalHashesAndStateMetadata: true,
    exactPayloadRawOmitted: true,
  },
};
const artifact = {
  ...artifactPayload,
  digestAlgorithm: 'sha256',
  contentDigest: sha256(canonicalize(artifactPayload)),
};
const temporaryPath = `${ARTIFACT_PATH}.${process.pid}.${Date.now()}.tmp`;
await mkdir(dirname(ARTIFACT_PATH), { recursive: true });
await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
await rename(temporaryPath, ARTIFACT_PATH);
process.stdout.write(`${artifact.contentDigest}\n`);
