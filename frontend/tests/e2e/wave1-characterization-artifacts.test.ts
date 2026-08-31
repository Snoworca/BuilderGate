import assert from 'node:assert/strict';
import { test } from 'node:test';

const CONTRACT_MODULE_PATH = './wave1-characterization-artifacts.ts';

async function loadContract(expectedFailureSignature: string) {
  try {
    return await import(CONTRACT_MODULE_PATH);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ERR_MODULE_NOT_FOUND' ||
      !error.message.includes('wave1-characterization-artifacts.ts')
    ) {
      throw error;
    }
    throw new Error(expectedFailureSignature, { cause: error });
  }
}

test('REL-BGSTAB-006 AC-1 RED contract', async () => {
  const contract = await loadContract(
    'REL-BGSTAB-006 AC-1 contract not implemented',
  );

  const observationInput = {
    observationKind: 'production_runtime_observed',
    buildId: 'commit:0123456789abcdef',
    effectiveWsTransportMode: 'unified',
    caseId: 'split-production-unified-01',
    sourceReference: 'server/src/index.ts:1468-1495',
    command: 'node characterize-split-production.mjs',
    observedResult: {
      controlSocketOpened: true,
      outputSocketOpened: false,
    },
  };
  const observation = contract.createSplitObservation(observationInput);

  assert.deepEqual(observation, {
    observationKind: 'production_runtime_observed',
    buildId: 'commit:0123456789abcdef',
    effectiveWsTransportMode: 'unified',
    caseId: 'split-production-unified-01',
    sourceReference: 'server/src/index.ts:1468-1495',
    command: 'node characterize-split-production.mjs',
    observedResult: {
      controlSocketOpened: true,
      outputSocketOpened: false,
    },
  });

  for (const observationKind of [
    'srs_expected',
    'production_runtime_observed',
    'test_observed',
  ]) {
    assert.equal(
      contract.createSplitObservation({
        ...observationInput,
        observationKind,
      }).observationKind,
      observationKind,
    );
  }

  assert.throws(
    () =>
      contract.createSplitObservation({
        ...observation,
        observationKind: 'runtime_observed',
      }),
    /unsupported observation kind/,
  );

  for (const field of [
    'buildId',
    'effectiveWsTransportMode',
    'caseId',
    'sourceReference',
    'command',
  ]) {
    assert.throws(
      () =>
        contract.createSplitObservation({
          ...observation,
          [field]: '',
        }),
      new RegExp(`${field} must be non-empty`),
    );
    assert.throws(
      () =>
        contract.createSplitObservation(
          Object.fromEntries(
            Object.entries(observation).filter(([key]) => key !== field),
          ),
        ),
      new RegExp(`${field} must be non-empty`),
    );
  }
});

test('REL-BGSTAB-006 AC-4 RED contract', async () => {
  const contract = await loadContract(
    'REL-BGSTAB-006 AC-4 contract not implemented',
  );

  const rows = [
    {
      comparisonTarget: 'FR-BGSTAB-006',
      productionObservation: 'split-production-unified-01',
      verdict: 'match',
      reproductionCaseId: 'split-production-unified-01',
      evidenceReference: 'artifacts/split-production-unified-01.json',
    },
    {
      comparisonTarget: 'WsRouterSplitHandshake.test.ts#split-output',
      productionObservation: 'split-production-unified-01',
      verdict: 'mismatch',
      reproductionCaseId: 'split-standalone-output-01',
      evidenceReference: 'artifacts/split-standalone-output-01.json',
    },
    {
      comparisonTarget: 'FR-BGSTAB-007',
      productionObservation: 'split-production-unified-01',
      verdict: 'not_exercised',
      reproductionCaseId: 'split-recovery-not-exercised-01',
      evidenceReference: 'artifacts/split-recovery-not-exercised-01.json',
    },
  ] as const;

  for (const row of rows) {
    assert.deepEqual(contract.createMismatchRow(row), row);
  }

  assert.deepEqual(contract.summarizeMismatchVerdicts(rows), {
    match: 1,
    mismatch: 1,
    not_exercised: 1,
  });

  for (const field of [
    'comparisonTarget',
    'productionObservation',
    'reproductionCaseId',
    'evidenceReference',
  ]) {
    assert.throws(
      () =>
        contract.createMismatchRow({
          ...rows[0],
          [field]: '',
        }),
      new RegExp(`${field} must be non-empty`),
    );
    assert.throws(
      () =>
        contract.summarizeMismatchVerdicts([
          {
            ...rows[0],
            [field]: '',
          },
        ]),
      new RegExp(`${field} must be non-empty`),
    );
    assert.throws(
      () =>
        contract.createMismatchRow(
          Object.fromEntries(
            Object.entries(rows[0]).filter(([key]) => key !== field),
          ),
        ),
      new RegExp(`${field} must be non-empty`),
    );
    assert.throws(
      () =>
        contract.summarizeMismatchVerdicts([
          Object.fromEntries(
            Object.entries(rows[0]).filter(([key]) => key !== field),
          ),
        ]),
      new RegExp(`${field} must be non-empty`),
    );
  }
  assert.throws(
    () =>
      contract.createMismatchRow({
        ...rows[0],
        verdict: 'unknown',
      }),
    /unsupported mismatch verdict/,
  );
  assert.throws(
    () =>
      contract.summarizeMismatchVerdicts([
        {
          ...rows[0],
          verdict: 'unknown',
        },
      ]),
    /unsupported mismatch verdict/,
  );
});

test('REL-BGSTAB-006 AC-5 RED contract', async () => {
  const contract = await loadContract(
    'REL-BGSTAB-006 AC-5 contract not implemented',
  );

  assert.doesNotThrow(() =>
    contract.assertObservationOnlyCharacterization({
      disposition: 'unresolved',
      splitActivationEnabled: false,
      mutatesExistingSrs: false,
    }),
  );
  for (const disposition of ['restore', 'supersede']) {
    assert.throws(
      () =>
        contract.assertObservationOnlyCharacterization({
          disposition,
          splitActivationEnabled: false,
          mutatesExistingSrs: false,
        }),
      /disposition must remain unresolved/,
    );
  }
  assert.throws(
    () =>
      contract.assertObservationOnlyCharacterization({
        disposition: 'unresolved',
        splitActivationEnabled: true,
        mutatesExistingSrs: false,
      }),
    /split activation must remain disabled/,
  );
  assert.throws(
    () =>
      contract.assertObservationOnlyCharacterization({
        disposition: 'unresolved',
        splitActivationEnabled: false,
        mutatesExistingSrs: true,
      }),
    /existing SRS mutation is forbidden/,
  );
});
