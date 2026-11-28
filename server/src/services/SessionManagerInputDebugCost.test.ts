// PERF-BGSTAB-032 AC-1: a key press is analysed for debug capture only while capture is on.
import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionManager } from './SessionManager.js';

function createHarness() {
  const manager = new SessionManager({
    pty: {
      termName: 'xterm-256color',
      defaultCols: 80,
      defaultRows: 24,
      useConpty: true,
      scrollbackLines: 1000,
      maxSnapshotBytes: 16,
      shell: 'bash',
    },
    session: { idleDelayMs: 40, runningDelayMs: 30 },
  } as never, {
    platform: 'linux',
    spawnPty: ((spawnShell: string, _args: string[], options: { cols?: number; rows?: number }) => ({
      pid: 1,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      process: spawnShell,
      handleFlowControl: false,
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
      write() {},
      resize() {},
      kill() {},
    })) as never,
  } as never);
  (manager as unknown as { isCommandAvailable: (cmd: string) => boolean }).isCommandAvailable = cmd => cmd === 'bash' || cmd === 'sh';
  const session = manager.createSession('input debug cost', 'bash', process.cwd());
  return { manager, id: session.id };
}

/** Counts grapheme segmentations, the costly part of the input debug details. */
function countSegmentations(run: () => void): number {
  const intl = Intl as unknown as { Segmenter: new (...args: unknown[]) => { segment(input: string): unknown } };
  const Original = intl.Segmenter;
  let count = 0;
  intl.Segmenter = class extends Original {
    segment(input: string): unknown {
      count += 1;
      return super.segment(input);
    }
  };
  try {
    run();
  } finally {
    intl.Segmenter = Original;
  }
  return count;
}

test('PERF-BGSTAB-032 AC-1: with capture off a key press is not segmented into graphemes', () => {
  const { manager, id } = createHarness();
  try {
    const count = countSegmentations(() => {
      for (const key of ['a', '가', '\r', '\x1b[A']) assert.equal(manager.writeInput(id, key), true);
    });
    assert.equal(count, 0);
  } finally {
    manager.deleteSession(id);
  }
});

test('PERF-BGSTAB-032 AC-1: with capture on the input event carries the same details as before', () => {
  const { manager, id } = createHarness();
  try {
    manager.enableDebugCapture(id);
    const count = countSegmentations(() => {
      assert.equal(manager.writeInput(id, '가a', undefined, { inputSeqStart: 3, inputSeqEnd: 4 }), true);
    });
    assert.ok(count > 0, 'capture needs the grapheme count');
    const event = manager.getDebugCapture(id).find(entry => entry.kind === 'input');
    assert.ok(event, 'the input event was captured');
    assert.deepEqual(event.details, {
      byteLength: 4,
      codePointCount: 2,
      graphemeCount: 2,
      graphemeApproximate: false,
      hasHangul: true,
      hasCjk: false,
      hasEnter: false,
      spaceCount: 0,
      backspaceCount: 0,
      enterCount: 0,
      escapeCount: 0,
      controlCount: 0,
      printableCount: 2,
      inputClass: 'printable',
      containsPrintable: true,
      safePreview: false,
      inputSeqStart: 3,
      inputSeqEnd: 4,
    });
  } finally {
    manager.deleteSession(id);
  }
});
