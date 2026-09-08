import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

// REL-BGSTAB-001 / B2 verification: exercise the existing E2E observation
// callbacks and diagnostic projections. No browser, polling timer or network.
// Proposed narrow contract: missing details never proves readiness, and is
// represented as details:null in failure diagnostics rather than throwing.
const source = readFileSync(new URL('../e2e/wave3-terminal-authority-promotion.spec.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('promotion.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const polls: ts.ArrowFunction[] = [];
const clientDeclarations: ts.VariableDeclaration[] = [];
const serverDeclarations: ts.VariableDeclaration[] = [];
const failureStatements: ts.ThrowStatement[] = [];
function walk(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'page.evaluate') {
    const callback = node.arguments[0];
    if (callback && ts.isArrowFunction(callback) && callback.getText(ast).includes('const latestGate =')) polls.push(callback);
  }
  if (ts.isVariableDeclaration(node)) {
    if (node.name.getText(ast) === 'clientEvents' && node.initializer?.getText(ast).includes('eventKey:')) clientDeclarations.push(node);
    if (node.name.getText(ast) === 'conciseServerEvents') serverDeclarations.push(node);
  }
  if (ts.isThrowStatement(node) && node.getText(ast).includes('JSON.stringify(conciseServerEvents)')) failureStatements.push(node);
  ts.forEachChild(node, walk);
}
walk(ast);
assert.equal(polls.length, 3, 'all three current readiness callbacks must be tested');
assert.equal(clientDeclarations.length, 1, 'client diagnostic projection must exist uniquely');
assert.equal(serverDeclarations.length, 1, 'server diagnostic projection must exist uniquely');
assert.equal(failureStatements.length, 1, 'the original failure builder must exist uniquely');

interface Event { eventId: number; kind: string; details?: Record<string, unknown> }
function value(text: string, dependencies: Record<string, unknown>): unknown {
  const compiled = ts.transpileModule(`const value = ${text};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${compiled}\nreturn value;`)(...Object.values(dependencies));
}
const debugWindow = (events: Event[]) => ({ __buildergateTerminalDebug: { getEvents: () => events } });
const ready = { inputReady: true, captureState: 'open', barrierReason: 'none' };
const observed = (details?: Record<string, unknown>): Event[] => [
  { eventId: 1, kind: 'input_gate_synced', details: ready },
  { eventId: 2, kind: 'focus_restored_after_gate' },
  { eventId: 3, kind: 'input_gate_synced', ...(details === undefined ? {} : { details }) },
];
for (const [index, node] of polls.entries()) {
  test(`B2 actual readiness callback ${index + 1} requires current detail evidence`, () => {
    const invoke = (events: Event[]) => (value(node.getText(ast), { window: debugWindow(events) }) as (input: unknown) => unknown)(
      ts.isObjectBindingPattern(node.parameters[0].name) ? { sessionId: 's', boundaryEventId: 0 } : 's');
    assert.equal(invoke([]), false);
    assert.equal(invoke(observed()), false, 'a newer detail-less gate must not reuse an older ready gate');
    assert.equal(invoke(observed({})), false);
    assert.equal(invoke(observed(ready)), true, 'positive ready evidence must remain sufficient');
    assert.equal(invoke(observed({ ...ready, inputReady: false })), false);
    assert.equal(invoke(observed({ ...ready, barrierReason: 'recovery-pending' })), false);
    assert.equal(invoke(observed({ ...ready, captureState: 'closed' })), false);
    if (node.getText(ast).includes('lastGridRepairStart')) {
      assert.equal(invoke([...observed(ready), { eventId: 4, kind: 'grid_layout_repair_started' }]), false);
    }
  });
}
function client(events: Event[]): unknown {
  const initializer = clientDeclarations[0].initializer;
  assert.ok(initializer && ts.isAwaitExpression(initializer) && ts.isCallExpression(initializer.expression));
  const callback = initializer.expression.arguments[0];
  assert.ok(callback && ts.isArrowFunction(callback));
  return (value(callback.getText(ast), { window: debugWindow(events) }) as (input: unknown) => unknown)({ sessionId: 's', boundaryEventId: 0 });
}
function server(events: Event[]): unknown {
  assert.ok(serverDeclarations[0].initializer);
  return value(serverDeclarations[0].initializer.getText(ast), { serverEvents: { server: events } });
}
const missing: Event = { eventId: 3, kind: 'input_rejected' };
test('B2 client diagnostic projection retains a detail-less event with explicit missing evidence', () => {
  assert.deepEqual(client([missing]), [{ eventId: 3, kind: 'input_rejected', details: null }]);
});
test('B2 server diagnostic projection retains a detail-less event with explicit missing evidence', () => {
  assert.deepEqual(server([missing]), [{ kind: 'input_rejected', details: null }]);
});
const details = { reason: 'protocol-failed', source: 'wire', inputReady: false, barrierReason: 'recovery', captureState: 'closed',
  activeElementIsHelper: false, helperDisabled: true, key: 'Enter', inputClass: 'command', nextStatus: 'idle', error: 'original protocol error' };
test('B2 client diagnostic projection preserves substantive error details', () => {
  assert.deepEqual(client([{ ...missing, details }]), [{ eventId: 3, kind: 'input_rejected', details: {
    reason: 'protocol-failed', source: 'wire', inputReady: false, barrierReason: 'recovery', captureState: 'closed',
    activeElementIsHelper: false, helperDisabled: true, eventKey: 'Enter',
  } }]);
});
test('B2 server diagnostic projection preserves substantive error details', () => {
  assert.deepEqual(server([{ ...missing, details }]), [{ kind: 'input_rejected', details: {
    reason: 'protocol-failed', inputClass: 'command', nextStatus: 'idle', source: 'wire', error: 'original protocol error',
  } }]);
});
test('B2 actual failure builder preserves the original failure when both diagnostic streams lack details', () => {
  assert.throws(() => {
    const dependencies = { error: new Error('original command-marker timeout'), clientEvents: client([missing]),
      conciseServerEvents: server([missing]), recentFrames: [], terminalViews: [], inputStateBeforeType: {} };
    const compiled = ts.transpileModule(failureStatements[0].getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText;
    new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
  }, error => error instanceof Error && !(error instanceof TypeError)
    && error.message.startsWith('original command-marker timeout; ')
    && error.message.includes('"details":null'));
});
