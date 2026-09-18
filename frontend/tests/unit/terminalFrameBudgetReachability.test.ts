// #101: resourceLimits.terminal.visibleFlushFrameBudgetMs must be operator-tunable.
//
// The frame deadline always WORKED -- normalizeFrameBudgetMs(undefined) returns the 7ms default
// and the live lane enforces it. What was missing was reachability: unlike its byte sibling
// visibleFlushBudgetBytes, no config key resolved to it, so an operator could not move it.
//
// "Present in the config" and "applied by the lane" are different claims, and #9 AC-4 and #95 are
// both cases where the first was proven and the second assumed. So the behavioural case below
// does not read the value back -- it runs the scheduler at TWO budgets and asserts the drain
// splits differently. A scheduler that ignored the option would produce the same split twice.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
import { createTerminalOutputScheduler } from '../../src/utils/terminalOutputScheduler.ts';

const decode = (chunk: string | Uint8Array): string => (
  typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
);

// Each write advances the clock by 3ms. With four 4-byte chunks and a per-chunk byte budget of 4,
// the number of chunks a frame drains is floor(budget / 3): 2 at 7ms, 5 (i.e. all four) at 16ms.
function drainCounts(visibleFlushFrameBudgetMs: number): number[] {
  const writes: string[] = [];
  const scheduled: Array<() => void> = [];
  let now = 0;
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 1024,
    visibleOutputMaxChunks: 16,
    visibleFlushBudgetBytes: 4,
    visibleFlushFrameBudgetMs,
    write: (data, onWritten) => { writes.push(decode(data)); now += 3; onWritten(); },
    schedule: (drain) => { scheduled.push(drain); },
    now: () => now,
  });
  for (const chunk of ['abcd', 'efgh', 'ijkl', 'mnop']) scheduler.enqueue(chunk);
  const perFrame: number[] = [];
  let guard = 0;
  while (scheduled.length > 0 && guard < 10) {
    const before = writes.length;
    scheduled.shift()!();
    perFrame.push(writes.length - before);
    guard += 1;
  }
  assert.equal(writes.join(''), 'abcdefghijklmnop', 'every chunk must still be written exactly once');
  assert.equal(scheduler.isIdle(), true, 'the scheduler must drain fully whatever the budget is');
  return perFrame;
}

test('#101 a configured frame budget changes how much one frame drains', () => {
  const tight = drainCounts(7);
  const generous = drainCounts(16);
  assert.deepEqual(tight, [3, 1], 'a 7ms budget must stop the frame after three writes');
  assert.deepEqual(generous, [4], 'a 16ms budget must finish all four in one frame');
  assert.notDeepEqual(tight, generous,
    'if both budgets produce the same split, the option never reached the drain loop');
});

test('#101 TerminalView forwards the configured frame budget at both scheduler call sites', () => {
  const path = new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const ast = ts.createSourceFile('TerminalView.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Both the creation call and the reconfiguration call must carry it: forwarding it only at
  // creation would leave a running terminal pinned to the budget it started with, which is the
  // failure mode an operator would report as "the setting does nothing".
  const callers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(ast);
      if (callee === 'createTerminalOutputScheduler' || callee.endsWith('.configure')) {
        const argument = node.arguments[0];
        if (argument && ts.isObjectLiteralExpression(argument)
          && argument.properties.some(property => property.name?.getText(ast) === 'visibleFlushFrameBudgetMs'
            && ts.isPropertyAssignment(property)
            && property.initializer.getText(ast) === 'limits.visibleFlushFrameBudgetMs')) {
          callers.push(callee);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(callers.includes('createTerminalOutputScheduler'),
    'the scheduler must be created with the configured frame budget');
  assert.ok(callers.some(callee => callee.endsWith('.configure')),
    'a reconfiguration must also carry the configured frame budget');
});
