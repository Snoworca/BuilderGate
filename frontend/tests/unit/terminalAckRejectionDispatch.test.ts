import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { classifyWsFrame } from '../../src/utils/wsFrameDispatch.ts';
import { isTerminalBinaryControlMessage } from '../../src/utils/terminalBinaryNegotiationClient.ts';
import { parseTerminalDeliveryAckRejectedMessage } from '../../src/types/ws-protocol.ts';

// Execute the actual React callback body, without copying its dispatch algorithm
// or mounting unrelated application effects. This is unit evidence, not browser E2E.
const path = new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url);
const text = readFileSync(path, 'utf8');
const ast = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const callbacks: ts.ArrowFunction[] = [];
const recordGuards: ts.FunctionDeclaration[] = [];
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'handleMessage') {
    assert.ok(node.initializer && ts.isCallExpression(node.initializer));
    assert.equal(node.initializer.expression.getText(ast), 'useCallback');
    const callback = node.initializer.arguments[0];
    assert.ok(callback && ts.isArrowFunction(callback));
    callbacks.push(callback);
  }
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'isCheckpointProtocolRecord') recordGuards.push(node);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(callbacks.length, 1, 'must find exactly one production message callback');
assert.equal(recordGuards.length, 1, 'must find the production record guard');
const compiled = ts.transpileModule(`${recordGuards[0].getText(ast)}\nconst callback = ${callbacks[0].getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness() {
  const records: unknown[][] = [];
  const warnings: unknown[][] = [];
  const noDispatch = new Proxy({}, { get() { assert.fail('ACK rejection must not dispatch session/workspace mutations'); } });
  const dependencies = {
    classifyWsFrame, isTerminalBinaryControlMessage, parseTerminalDeliveryAckRejectedMessage,
    recordTerminalDebugEvent: (...args: unknown[]) => records.push(args),
    console: { warn: (...args: unknown[]) => warnings.push(args) },
    sessionHandlersRef: { current: noDispatch },
    workspaceHandlersRef: { current: noDispatch },
  };
  const callback = new Function(...Object.keys(dependencies), `${compiled}\nreturn callback;`)(...Object.values(dependencies)) as (event: { data: string }) => void;
  return { records, warnings, dispatch: (message: unknown) => callback({ data: JSON.stringify(message) }) };
}

const common = { type: 'terminal-delivery:ack-rejected', sessionId: 'session-a', connectionEpoch: 'epoch-a', reason: 'ACK_OVER_ACK' };
test('PERF-BGSTAB-010 AC-6 actual message callback records the rejected ACK domain exactly', () => {
  for (const identity of [
    { deliverySeq: 1 },
    { kind: 'deliverySeq', deliverySeq: 2 },
    { kind: 'sourceSeq', streamEpoch: '18446744073709551615', sourceSeq: '9007199254740993' },
  ]) {
    const h = harness();
    h.dispatch({ ...common, ...identity });
    assert.deepEqual(h.records, [[
      common.sessionId, 'terminal_delivery_ack_rejected',
      { connectionEpoch: common.connectionEpoch, ...identity, reason: common.reason },
      undefined, { includeInputReliabilityMode: false },
    ]]);
    assert.equal(h.warnings.length, 0);
  }
});

test('PERF-BGSTAB-010 AC-6 actual message callback warns about invalid rejection before session dispatch', () => {
  for (const [message, reason] of [
    [{ ...common, sessionId: undefined, deliverySeq: 1 }, 'invalid-identity'],
    [{ ...common, deliverySeq: 1, sourceSeq: '2' }, 'ACK_DOMAIN_CONFLICT'],
    [{ ...common }, 'ACK_DOMAIN_MISSING'],
    [{ ...common, kind: 'sourceSeq', streamEpoch: '7', sourceSeq: '01' }, 'ACK_DOMAIN_INVALID'],
    [{ ...common, deliverySeq: 1, reason: '' }, 'invalid-reason'],
  ] as const) {
    const h = harness();
    h.dispatch(message);
    assert.equal(h.records.length, 0);
    assert.equal(h.warnings.length, 1);
    assert.ok(JSON.stringify(h.warnings[0]).includes(reason), `warning must expose ${reason}`);
  }
});
