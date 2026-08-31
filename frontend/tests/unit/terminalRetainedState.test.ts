import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

const CONTRACT_MODULE_PATH = '../../src/utils/terminalRetainedState.ts';

async function loadContract(expectedFailureSignature: string) {
  try {
    return await import(CONTRACT_MODULE_PATH);
  } catch (error) {
    if (
      !(error instanceof Error)
      || !('code' in error)
      || error.code !== 'ERR_MODULE_NOT_FOUND'
      || !error.message.includes('terminalRetainedState.ts')
    ) {
      throw error;
    }
    throw new Error(expectedFailureSignature, { cause: error });
  }
}

const BASE_MODES = {
  applicationCursorKeysMode: false,
  applicationKeypadMode: false,
  bracketedPasteMode: true,
  insertMode: false,
  mouseTrackingMode: 'none',
  originMode: false,
  reverseWraparoundMode: false,
  sendFocusMode: false,
  synchronizedOutputMode: false,
  wraparoundMode: true,
} as const;

test('MIG-BGSTAB-002 streaming capture compacts xterm default-color blanks and preserves absolute DECSC cursor', async () => {
  const contract = await loadContract('MIG-BGSTAB-002 streaming retained-state contract unavailable');
  const defaultAttributes = {
    fgMode: 0,
    bgMode: 0,
    fg: -1,
    bg: -1,
    bold: false,
    italic: false,
    dim: false,
    underline: false,
    blink: false,
    inverse: false,
    invisible: false,
    strikethrough: false,
    overline: false,
  };
  const cell = (chars: string, code: number) => ({
    getChars: () => chars,
    getCode: () => code,
    getWidth: () => 1,
    getFgColorMode: () => 0,
    getBgColorMode: () => 0,
    getFgColor: () => -1,
    getBgColor: () => -1,
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
  });
  const cells = [cell('P', 80), cell('', 0), cell('', 0)];
  const terminal = {
    rows: 1,
    cols: 3,
    modes: BASE_MODES,
    _core: { buffer: { savedX: 1, savedY: 42 } },
    buffer: {
      active: {
        type: 'normal',
        length: 1,
        baseY: 0,
        cursorX: 1,
        cursorY: 0,
        getLine: () => ({
          isWrapped: false,
          translateToString: () => 'P',
          getCell: (column: number) => cells[column],
        }),
      },
    },
  };
  const evidence = contract.captureTerminalRetainedStateStreaming(terminal, {
    hashContract: 'ph005-retained-stream-v1',
    maxBufferedLines: 1,
    compactCellRuns: true,
  });
  const expectedCellPayload = JSON.stringify({
    index: 0,
    compactCellRuns: [
      { startColumn: 0, length: 1, chars: 'P', code: 80, width: 1, ...defaultAttributes },
      { startColumn: 1, length: 2, chars: '', code: 0, width: 1, ...defaultAttributes },
    ],
  });

  assert.equal(
    evidence.firstLine.cellAttributesSha256,
    createHash('sha256').update(expectedCellPayload, 'utf8').digest('hex'),
  );
  assert.deepEqual(evidence.savedCursor, { available: true, x: 1, y: 42 });
});

test('MIG-BGSTAB-002 streaming capture proves the exact retained overlap without absolute line indexes', async () => {
  const contract = await loadContract('MIG-BGSTAB-002 streaming retained overlap contract unavailable');
  const cell = (chars: string) => ({
    getChars: () => chars,
    getCode: () => chars.codePointAt(0) ?? 0,
    getWidth: () => 1,
    getFgColorMode: () => 0,
    getBgColorMode: () => 0,
    getFgColor: () => -1,
    getBgColor: () => -1,
    isBold: () => 0,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 0,
    isBlink: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
  });
  const capture = (texts: string[]) => contract.captureTerminalRetainedStateStreaming({
    rows: texts.length,
    cols: 1,
    modes: BASE_MODES,
    buffer: {
      active: {
        type: 'normal',
        length: texts.length,
        baseY: 0,
        cursorX: 0,
        cursorY: texts.length - 1,
        getLine: (index: number) => ({
          isWrapped: false,
          translateToString: () => texts[index],
          getCell: () => cell(texts[index]),
        }),
      },
    },
  }, {
    hashContract: 'ph005-retained-stream-v1',
    maxBufferedLines: 1,
    compactCellRuns: true,
  });

  const before = capture(['A', 'B', 'C']);
  const after = capture(['B', 'C', 'D']);
  const matchingShifts = before.overlap.shifts
    .filter((candidate: { shiftLines: number; suffixSha256: string }) => (
      after.overlap.shifts.some((replacement: { shiftLines: number; prefixSha256: string }) => (
        replacement.shiftLines === candidate.shiftLines
          && replacement.prefixSha256 === candidate.suffixSha256
      ))
    ))
    .map((candidate: { shiftLines: number }) => candidate.shiftLines);

  assert.equal(before.overlap.contract, 'ph005-retained-overlap-v1');
  assert.equal(before.overlap.canonicalLineFingerprint, 'logical-line-and-cell-attributes-without-index');
  assert.deepEqual(matchingShifts, [1]);
  assert.deepEqual(before.streaming, {
    fullCellObjectMaterializationCount: 0,
    maxBufferedLines: 1,
    compactCellRuns: true,
  });
});

function makeState(
  text: string,
  options: {
    activeBuffer?: 'normal' | 'alternate';
    lineIndex?: number;
    width?: number;
  } = {},
) {
  const lineIndex = options.lineIndex ?? 0;
  return {
    schemaVersion: 1,
    activeBuffer: options.activeBuffer ?? 'normal',
    geometry: { rows: 24, cols: 80 },
    cursor: { x: 3, y: 2, absoluteY: lineIndex + 2 },
    savedCursor: { available: false },
    modes: BASE_MODES,
    lines: [
      {
        index: lineIndex,
        isWrapped: false,
        text,
        cells: [
          {
            column: 0,
            chars: text,
            code: text.codePointAt(text.length > 1 ? text.length - 2 : 0) ?? 0,
            width: options.width ?? 1,
            fgMode: 0,
            bgMode: 0,
            fg: 0,
            bg: 0,
            bold: false,
            italic: false,
            dim: false,
            underline: false,
            blink: false,
            inverse: false,
            invisible: false,
            strikethrough: false,
            overline: false,
          },
        ],
      },
    ],
  };
}

test('OBS-BGSTAB-004 AC-4 canonical retained-state hash RED contract', async () => {
  const contract = await loadContract(
    'OBS-BGSTAB-004 AC-4 contract not implemented',
  );

  const fixtures = [
    makeState('ASCII'),
    makeState('한글', { width: 2 }),
    makeState('e\u0301'),
    makeState('😀', { activeBuffer: 'alternate', width: 2 }),
  ];

  for (const fixture of fixtures) {
    const first = contract.canonicalizeTerminalRetainedState(fixture);
    const second = contract.canonicalizeTerminalRetainedState({
      ...fixture,
      lines: [...fixture.lines].reverse(),
    });

    assert.equal(first.digest, second.digest);
    assert.match(first.digest, /^fnv1a64:[0-9a-f]{16}$/);
    assert.equal(first.logicalLinesHash, second.logicalLinesHash);
    assert.equal(first.cellContentAttributeHash, second.cellContentAttributeHash);
    assert.deepEqual(first.cursor, fixture.cursor);
    assert.deepEqual(first.savedCursor, fixture.savedCursor);
    assert.deepEqual(first.modes, fixture.modes);
    assert.equal(first.activeBuffer, fixture.activeBuffer);
    assert.deepEqual(first.geometry, fixture.geometry);

    const same = contract.diffTerminalRetainedState(first, second);
    assert.deepEqual(
      Object.values(same.fields),
      Array(Object.keys(same.fields).length).fill('equal'),
    );
  }

  const before = contract.canonicalizeTerminalRetainedState(fixtures[0]);
  const changed = contract.canonicalizeTerminalRetainedState({
    ...fixtures[0],
    cursor: undefined,
    lines: [{ ...fixtures[0].lines[0], text: 'changed' }],
  });
  assert.equal(
    contract.diffTerminalRetainedState(before, changed).fields.logicalLines,
    'changed',
  );
  assert.equal(
    contract.diffTerminalRetainedState(before, changed).fields.cursor,
    'missing',
  );
});

test('OBS-BGSTAB-004 AC-6 eviction and observed loss RED contract', async () => {
  const contract = await loadContract(
    'OBS-BGSTAB-004 AC-6 contract not implemented',
  );

  const pre = contract.canonicalizeTerminalRetainedState({
    ...makeState('old-line', { lineIndex: 0 }),
    cursor: { x: 3, y: 2, absoluteY: 12 },
    lines: [
      makeState('old-line', { lineIndex: 0 }).lines[0],
      makeState('retained-line', { lineIndex: 10 }).lines[0],
    ],
  });
  const post = contract.canonicalizeTerminalRetainedState(
    makeState('changed-retained-line', { lineIndex: 10 }),
  );
  const candidateCauses = [
    {
      kind: 'snapshot_truncation',
      status: 'candidate',
      evidenceReferences: ['raw/pre-snapshot.json#boundary'],
      details: { configuredStartLine: 10 },
    },
  ];

  const analysis = contract.analyzeTerminalRetainedState({
    pre,
    post,
    effectiveBoundary: {
      retainedLineStart: 10,
      retainedLineEnd: 10,
      serializedPayloadBoundary: {
        value: 2 * 1024 * 1024,
        unit: 'bytes',
        provenance: 'legacy-2MiB-characterization-seed',
      },
    },
    causeSignals: candidateCauses,
  });

  assert.equal(analysis.classification.expectedCurrentEviction, 1);
  assert.equal(analysis.classification.observedLoss, 1);
  assert.deepEqual(analysis.causeSignals, candidateCauses);
  assert.equal(analysis.fieldVerdicts.logicalLines, 'changed');
  assert.equal(analysis.fieldVerdicts.cells, 'changed');
  assert.deepEqual(analysis.expectedEvictedLineIndexes, [0]);
  assert.deepEqual(analysis.observedLostLineIndexes, [10]);
  assert.deepEqual(analysis.effectiveBoundary.serializedPayloadBoundary, {
    value: 2 * 1024 * 1024,
    unit: 'bytes',
    provenance: 'legacy-2MiB-characterization-seed',
  });
});

test('OBS-BGSTAB-004 AC-4 read-only xterm capture repair RED contract', async () => {
  const contract = await loadContract(
    'OBS-BGSTAB-004 AC-4 read-only capture contract not implemented',
  );
  assert.equal(
    typeof contract.captureTerminalRetainedState,
    'function',
    'OBS-BGSTAB-004 AC-4 read-only capture contract not implemented',
  );

  const cell = {
    getChars: () => '한',
    getCode: () => '한'.codePointAt(0),
    getWidth: () => 2,
    getFgColorMode: () => 1,
    getBgColorMode: () => 0,
    getFgColor: () => 2,
    getBgColor: () => 0,
    isBold: () => 1,
    isItalic: () => 0,
    isDim: () => 0,
    isUnderline: () => 1,
    isBlink: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
    isStrikethrough: () => 0,
    isOverline: () => 0,
  };
  const terminal = {
    rows: 24,
    cols: 80,
    modes: BASE_MODES,
    buffer: {
      active: {
        type: 'normal',
        cursorX: 4,
        cursorY: 3,
        baseY: 7,
        viewportY: 7,
        length: 1,
        getLine: () => ({
          isWrapped: false,
          length: 1,
          translateToString: () => '한',
          getCell: () => cell,
        }),
      },
    },
  };

  const captured = contract.captureTerminalRetainedState(terminal);
  assert.equal(captured.activeBuffer, 'normal');
  assert.deepEqual(captured.geometry, { rows: 24, cols: 80 });
  assert.deepEqual(captured.cursor, { x: 4, y: 3, absoluteY: 10 });
  assert.deepEqual(captured.savedCursor, { available: false });
  assert.equal(captured.lines[0].cells[0].chars, '한');
  assert.equal(captured.lines[0].cells[0].width, 2);
  assert.match(captured.digest, /^fnv1a64:[0-9a-f]{16}$/);
});

test('OBS-BGSTAB-004 AC-4/6 compact live fingerprint repair RED contract', async () => {
  const contract = await loadContract(
    'OBS-BGSTAB-004 AC-4/6 compact live fingerprint contract not implemented',
  );
  assert.equal(
    typeof contract.createTerminalRetainedStateEvidence,
    'function',
    'OBS-BGSTAB-004 AC-4/6 compact live fingerprint contract not implemented',
  );
  assert.equal(
    typeof contract.analyzeTerminalRetainedStateEvidence,
    'function',
    'OBS-BGSTAB-004 AC-4/6 compact live analyzer contract not implemented',
  );

  const pre = contract.canonicalizeTerminalRetainedState({
    ...makeState('old', { lineIndex: 0 }),
    cursor: { x: 3, y: 2, absoluteY: 12 },
    lines: [
      makeState('old', { lineIndex: 0 }).lines[0],
      makeState('retained', { lineIndex: 10 }).lines[0],
    ],
  });
  const post = contract.canonicalizeTerminalRetainedState(
    makeState('changed', { lineIndex: 10 }),
  );
  const preEvidence = contract.createTerminalRetainedStateEvidence(pre);
  const postEvidence = contract.createTerminalRetainedStateEvidence(post);
  assert.equal('lines' in preEvidence, false);
  assert.equal(preEvidence.lineFingerprints.length, 2);
  assert.match(preEvidence.lineFingerprints[0].logicalLineHash, /^fnv1a64:/);
  assert.match(preEvidence.lineFingerprints[0].cellContentAttributeHash, /^fnv1a64:/);

  const rebasedEvidence = contract.createTerminalRetainedStateEvidence({
    ...pre,
    lines: pre.lines.map((line) => ({
      ...line,
      index: line.index + 100,
      cells: line.cells.map((cell) => ({ ...cell })),
    })),
  });
  assert.equal(
    rebasedEvidence.lineFingerprints[0].logicalLineHash,
    preEvidence.lineFingerprints[0].logicalLineHash,
    'line content fingerprint must survive buffer-relative index rebasing',
  );
  assert.equal(
    rebasedEvidence.lineFingerprints[0].cellContentAttributeHash,
    preEvidence.lineFingerprints[0].cellContentAttributeHash,
    'cell fingerprint must survive buffer-relative index rebasing',
  );

  const analysis = contract.analyzeTerminalRetainedStateEvidence({
    pre: preEvidence,
    post: postEvidence,
    effectiveBoundary: {
      retainedLineStart: 10,
      retainedLineEnd: 10,
      serializedPayloadBoundary: {
        value: 2_000_000,
        unit: 'characters',
        provenance: '/api/runtime-config',
      },
    },
    causeSignals: [{
      kind: 'remount_handoff',
      status: 'observed',
      evidenceReferences: ['live-case://compact-test/remount'],
      details: { refreshed: true },
    }],
  });
  assert.deepEqual(analysis.expectedEvictedLineIndexes, [0]);
  assert.deepEqual(analysis.observedLostLineIndexes, [10]);
});

test('OBS-BGSTAB-004 AC-4/6 retained-range ordered evidence repair RED contract', async () => {
  const contract = await loadContract(
    'OBS-BGSTAB-004 AC-4/6 ordered retained-range analyzer not implemented',
  );
  const makeEvidence = (
    labels: string[],
    options: { startIndex?: number; activeBuffer?: 'normal' | 'alternate'; cursorX?: number } = {},
  ) => contract.createTerminalRetainedStateEvidence(
    contract.canonicalizeTerminalRetainedState({
      ...makeState(labels[0] ?? ''),
      activeBuffer: options.activeBuffer ?? 'normal',
      cursor: { x: options.cursorX ?? 0, y: 0, absoluteY: 4 },
      lines: labels.map((label, offset) => makeState(label, {
        lineIndex: (options.startIndex ?? 0) + offset,
      }).lines[0]),
    }),
  );
  const boundary = {
    retainedLineStart: 2,
    retainedLineEnd: 4,
    serializedPayloadBoundary: {
      value: 2_000_000,
      unit: 'characters' as const,
      provenance: 'https://localhost:2222/api/runtime-config#resourceLimits.snapshots.perSnapshotMaxChars',
    },
  };
  const causeSignals = [{
    kind: 'remount_handoff' as const,
    status: 'observed' as const,
    evidenceReferences: ['live-case://ordered-range/refresh'],
    details: { refreshed: true },
  }];
  const pre = makeEvidence(['outside-a', 'outside-b', 'duplicate', 'inside-c', 'inside-d']);

  const rebasedSuffix = contract.analyzeTerminalRetainedStateEvidence({
    pre,
    post: makeEvidence(['duplicate', 'inside-c', 'inside-d']),
    effectiveBoundary: boundary,
    causeSignals,
  });
  assert.deepEqual(rebasedSuffix.expectedEvictedLineIndexes, [0, 1]);
  assert.deepEqual(rebasedSuffix.observedLostLineIndexes, []);
  assert.equal(rebasedSuffix.classification.expectedCurrentEviction, 2);
  assert.equal(rebasedSuffix.classification.observedLoss, 0);

  const preservedOutsideHistory = contract.analyzeTerminalRetainedStateEvidence({
    pre,
    post: makeEvidence(['outside-a', 'duplicate', 'inside-c', 'inside-d']),
    effectiveBoundary: boundary,
    causeSignals,
  });
  assert.deepEqual(
    preservedOutsideHistory.expectedEvictedLineIndexes,
    [1],
    'boundary-outside lines are expected eviction only when actually absent',
  );
  assert.deepEqual(preservedOutsideHistory.observedLostLineIndexes, []);

  const reordered = contract.analyzeTerminalRetainedStateEvidence({
    pre,
    post: makeEvidence(['inside-c', 'duplicate', 'inside-d']),
    effectiveBoundary: boundary,
    causeSignals,
  });
  assert.equal(reordered.expectedEvictedLineIndexes.length, 2);
  assert.equal(reordered.observedLostLineIndexes.length, 1);
  assert.ok(reordered.classification.observedLoss >= 1);

  const insideChanged = contract.analyzeTerminalRetainedStateEvidence({
    pre,
    post: makeEvidence(['duplicate', 'changed-inside', 'inside-d']),
    effectiveBoundary: boundary,
    causeSignals,
  });
  assert.deepEqual(insideChanged.observedLostLineIndexes, [3]);

  const duplicatePre = makeEvidence(['outside-a', 'outside-b', 'duplicate', 'duplicate', 'inside-d']);
  const duplicateLoss = contract.analyzeTerminalRetainedStateEvidence({
    pre: duplicatePre,
    post: makeEvidence(['duplicate', 'inside-d']),
    effectiveBoundary: boundary,
    causeSignals,
  });
  assert.equal(duplicateLoss.observedLostLineIndexes.length, 1);

  const stateChanged = contract.analyzeTerminalRetainedStateEvidence({
    pre,
    post: makeEvidence(['duplicate', 'inside-c', 'inside-d'], {
      activeBuffer: 'alternate',
      cursorX: 7,
    }),
    effectiveBoundary: boundary,
    causeSignals,
  });
  assert.ok(stateChanged.stateFieldObservedLoss.includes('cursor'));
  assert.ok(stateChanged.stateFieldObservedLoss.includes('activeBuffer'));
  assert.ok(stateChanged.classification.observedLoss >= 2);
});
