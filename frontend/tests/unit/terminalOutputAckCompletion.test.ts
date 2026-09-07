import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { createHiddenOutputState, resolveHiddenOutput } from '../../src/utils/terminalHiddenOutput.ts';
import { flushNextTerminalRestoreBufferedOutput } from '../../src/utils/terminalOutputScheduler.ts';
import type { TerminalOutputDelivery } from '../../src/utils/terminalOutputDelivery.ts';

// Execute the production Container callback and View settlement wrapper. The
// coordinator port exposes completion; neither ACK counting nor settlement is
// recreated here. This unit harness is not a mounted-browser/E2E claim.
function productionArrow(file: string, name: string, property: boolean): string {
  const path = new URL(file, import.meta.url);
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.ArrowFunction[] = [];
  function visit(node: ts.Node): void {
    if (property && ts.isPropertyAssignment(node) && node.name.getText(ast) === name && ts.isArrowFunction(node.initializer)) {
      matches.push(node.initializer);
    }
    if (!property && ts.isVariableDeclaration(node) && node.name.getText(ast) === name) {
      assert.ok(node.initializer && ts.isCallExpression(node.initializer));
      assert.equal(node.initializer.expression.getText(ast), 'useCallback');
      const callback = node.initializer.arguments[0];
      assert.ok(callback && ts.isArrowFunction(callback));
      matches.push(callback);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, `exactly one production ${name} is required`);
  return ts.transpileModule(`const callback = ${matches[0].getText(ast)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}
const containerCode = productionArrow('../../src/components/Terminal/TerminalContainer.tsx', 'onOutput', true);
const viewCode = productionArrow('../../src/components/Terminal/TerminalView.tsx', 'writeOutputDirect', false);
function bind(code: string, dependencies: Record<string, unknown>): (...args: any[]) => void {
  return new Function(...Object.keys(dependencies), `${code}\nreturn callback;`)(...Object.values(dependencies));
}
type Write = { onWritten: () => void; onRejected: () => void; data: unknown };
type Metadata = { onWritten?: () => void; onRejected?: () => void; connectionGeneration?: number };
const sourceIdentity = { connectionEpoch: 'fair-a', kind: 'sourceSeq', streamEpoch: '18446744073709551615', sourceSeq: '9007199254740993' } as const;
const legacyIdentity = { connectionEpoch: 'fair-a', deliverySeq: 1 } as const;
function delivery(wholeFallback = false, legacy = false): TerminalOutputDelivery {
  const whole = { data: new Uint8Array([65, 66]), byteLength: 2 };
  return {
    codec: legacy ? 'json' : 'binary', whole,
    chunks: wholeFallback ? null : [
      { data: whole.data.subarray(0, 1), byteLength: 1 },
      { data: whole.data.subarray(1), byteLength: 1 },
    ],
    hasSourceSegments: true, previewText: () => 'AB',
    ack: legacy ? legacyIdentity : sourceIdentity,
  };
}
function harness(deferRestore = false) {
  const sent: unknown[] = [];
  const debug: unknown[][] = [];
  const writes: Write[] = [];
  const submitted: Array<{ data: unknown; metadata: Metadata }> = [];
  const connection = { current: 4 };
  const session = { current: 2 };
  const visible = { current: true };
  const inFlight = { current: [] as unknown[] };
  const direct = bind(viewCode, {
    getTerminalWriteCoordinator: () => ({ submitCompatibility: (write: Write) => { writes.push(write); return { accepted: true }; } }),
    inFlightOutputRef: inFlight, xtermGenerationRef: { current: 7 },
    LARGE_WRITE_THRESHOLD: 10000, requestViewportSync: () => {}, scheduleSnapshotSave: () => {},
    containerRef: { current: null }, outputTimerRef: { current: null },
    setTimeout: () => 1, clearTimeout: () => {},
  });
  const terminal: { current: { submitOutput: (data: unknown, metadata: Metadata) => void } | null } = {
    current: { submitOutput: (data, metadata) => {
      submitted.push({ data, metadata });
      if (!deferRestore) direct({}, data, metadata.onWritten, metadata.onRejected);
    } },
  };
  const onOutput = bind(containerCode, {
    sessionId: 'session-a', compatibilityPostAckConvergenceRef: { current: null }, activeVisibleOutputResyncRef: { current: null },
    hiddenOutputStateRef: { current: createHiddenOutputState() }, isVisibleRef: visible,
    getCachedTerminalOutputResourceLimits: () => ({ hiddenOutputPolicy: 'snapshot-restore', hiddenOutputTailBytes: 0 }),
    resolveHiddenOutput, getUtf8ByteLength: (value: string) => new TextEncoder().encode(value).byteLength,
    terminalRef: terminal, wsConnectionGenerationRef: connection, sessionGenerationRef: session,
    recordTerminalDebugEvent: (...args: unknown[]) => debug.push(args),
    send: (message: unknown) => { sent.push(message); return { ok: true }; },
  });
  return { sent, debug, writes, submitted, connection, session, visible, terminal, inFlight, onOutput };
}

for (const wholeFallback of [false, true]) {
  for (const legacy of [false, true]) {
    const label = `${legacy ? 'legacy' : 'source'} ${wholeFallback ? 'whole' : 'chunks'}`;
    test(`PERF-BGSTAB-011 ${label} ACK waits for every accepted write and preserves identity`, () => {
      const h = harness();
      const input = delivery(wholeFallback, legacy);
      h.onOutput(input);
      assert.equal(h.writes.length, wholeFallback ? 1 : 2);
      assert.deepEqual(h.sent, []);
      for (const [index, write] of h.writes.entries()) {
        write.onWritten();
        if (index < h.writes.length - 1) assert.deepEqual(h.sent, []);
      }
      assert.deepEqual(h.sent, [{ type: 'terminal-delivery:ack', sessionId: 'session-a', ...input.ack }]);
      const attempted = h.debug.filter(record => record[1] === 'terminal_delivery_ack_attempted');
      assert.deepEqual(attempted, [['session-a', 'terminal_delivery_ack_attempted', { ...input.ack, accepted: true, reason: null }]]);
      assert.equal(h.inFlight.current.length, 0);
    });
    for (const generation of ['connection', 'session'] as const) {
      test(`PERF-BGSTAB-010 ${label} stale ${generation} completion emits no ACK`, () => {
        const h = harness();
        h.onOutput(delivery(wholeFallback, legacy));
        h[generation].current += 1;
        for (const write of h.writes) write.onWritten();
        assert.deepEqual(h.sent, []);
        const skipped = h.debug.filter(record => record[1] === 'terminal_delivery_ack_skipped');
        assert.equal(skipped.length, 1);
        assert.equal((skipped[0][2] as { reason: string }).reason, 'stale-generation');
      });
    }
    test(`PERF-BGSTAB-010 ${label} rejected write never earns an ACK`, () => {
      const h = harness();
      h.onOutput(delivery(wholeFallback, legacy));
      h.writes[0].onRejected();
      for (const write of h.writes.slice(1)) write.onWritten();
      assert.deepEqual(h.sent, []);
    });
  }
}

test('PERF-BGSTAB-010 actual View once-only settlement prevents duplicate chunk credit', () => {
  const h = harness();
  h.onOutput(delivery());
  h.writes[0].onWritten();
  h.writes[0].onWritten();
  h.writes[0].onRejected();
  assert.deepEqual(h.sent, []);
  h.writes[1].onWritten();
  h.writes[1].onWritten();
  assert.equal(h.sent.length, 1);
  assert.equal(h.inFlight.current.length, 0);
});

test('PERF-BGSTAB-010 absent identity, skipped hidden output, missing terminal and incomplete output earn no ACK', () => {
  for (const mode of ['identity-absent', 'hidden', 'terminal-absent', 'incomplete']) {
    const h = harness();
    const input = delivery();
    if (mode === 'hidden') h.visible.current = false;
    if (mode === 'terminal-absent') h.terminal.current = null;
    h.onOutput(mode === 'identity-absent' ? { ...input, ack: undefined } : input);
    for (const write of mode === 'incomplete' ? h.writes.slice(0, 1) : h.writes) write.onWritten();
    assert.deepEqual(h.sent, [], mode);
    if (mode === 'hidden' || mode === 'terminal-absent') assert.equal(h.writes.length, 0);
  }
});

test('REL-BGSTAB-010 retired restore attempt cannot complete the Container ACK', () => {
  const h = harness(true);
  h.onOutput(delivery(true));
  const callback = h.submitted[0].metadata.onWritten;
  assert.equal(typeof callback, 'function');
  let current = true;
  let complete: (() => void) | undefined;
  let commits = 0;
  flushNextTerminalRestoreBufferedOutput({
    peek: () => 'AB', commit: () => { commits += 1; return true; },
    write: (_data, onWritten) => { complete = onWritten; return true; },
    onWritten: callback!, onSettled: () => {}, isCurrent: () => current,
  });
  current = false;
  complete!();
  assert.equal(commits, 0);
  assert.deepEqual(h.sent, []);
});
