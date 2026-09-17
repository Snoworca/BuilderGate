import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import { createTerminalClipboardCoordinator } from '../../src/utils/terminalClipboardCoordinator.ts';

const terminalViewSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
  'utf8',
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

test('clipboard coordinator lifecycle epoch supports StrictMode cleanup/setup without reviving old work', async () => {
  const identity = {};
  const target = {
    terminalIdentity: identity,
    sessionId: 'strict-session',
    sessionGeneration: 3,
    viewGeneration: 5,
  };
  const write = deferred<void>();
  const cleared: object[] = [];
  const focused: object[] = [];
  const coordinator = createTerminalClipboardCoordinator({
    captureTarget: () => target,
    isTargetCurrent: (candidate) => candidate === target,
    captureSelection: () => ({ text: 'strict fixture', rangeKey: '1:0-1:14' }),
    isSelectionCurrent: () => true,
    readClipboardText: async () => 'paste fixture',
    writeClipboardText: () => write.promise,
    admitPaste: () => ({ ok: true }),
    clearSelection: (candidate) => { cleared.push(candidate.terminalIdentity); },
    focus: (candidate) => { focused.push(candidate.terminalIdentity); },
    observe: () => undefined,
  });

  const oldCompletion = coordinator.copySelection('keyboard');
  coordinator.dispose();
  coordinator.activate();
  write.resolve(undefined);

  assert.deepEqual(await oldCompletion, {
    ok: false,
    action: 'copy',
    source: 'keyboard',
    reason: 'context-changed',
  });
  assert.equal(cleared.length, 0);
  assert.equal(focused.length, 0);

  assert.deepEqual(await coordinator.copySelection('keyboard'), {
    ok: true,
    action: 'copy',
    source: 'keyboard',
  });
  assert.deepEqual(cleared, [identity]);
  assert.deepEqual(focused, [identity]);
});

test('TerminalView synchronously fences hidden views with a distinct clipboard view generation', () => {
  assert.match(
    terminalViewSource,
    /useLayoutEffect\(\(\) => \{[\s\S]*?committedVisibilityRef\.current = isVisible;[\s\S]*?clipboardViewGenerationRef\.current \+= 1;[\s\S]*?\}, \[isVisible\]\);/,
  );
  assert.match(
    terminalViewSource,
    /if \(!term \|\| terminalDisposedRef\.current \|\| !isVisibleRef\.current\) \{[\s\S]*?viewGeneration: clipboardViewGenerationRef\.current/,
  );
  assert.match(
    terminalViewSource,
    /!terminalDisposedRef\.current[\s\S]*?&& isVisibleRef\.current[\s\S]*?&& clipboardViewGenerationRef\.current === target\.viewGeneration/,
  );
});

test('TerminalView binds saved right-click selection to one xterm generation and clears it on lifecycle boundaries', () => {
  assert.match(
    terminalViewSource,
    /savedRightClickSelXtermGenerationRef\.current === xtermGenerationRef\.current/,
  );
  assert.match(
    terminalViewSource,
    /savedRightClickSelXtermGenerationRef\.current = xtermGenerationRef\.current;/,
  );
  const resetCount = terminalViewSource.match(
    /savedRightClickSelXtermGenerationRef\.current = 0;/g,
  )?.length ?? 0;
  assert.ok(resetCount >= 4, `expected mount, clear and dispose resets; observed ${resetCount}`);
  assert.match(
    terminalViewSource,
    /clearBufferedOutput\(\);[\s\S]*?savedRightClickSelRef\.current = '';[\s\S]*?xtermGenerationRef\.current \+= 1;/,
  );
  assert.match(
    terminalViewSource,
    /terminalRestoreAdapterRef\.current = null;[\s\S]*?savedRightClickSelRef\.current = '';[\s\S]*?xtermRef\.current = null;/,
  );
});

// Enumerates the handle from the AST instead of asserting that one dead token is
// absent. The previous form was `doesNotMatch(/\bpasteInput\s*:/)` against both
// sources; `pasteInput` occurs nowhere in the repository, so both assertions were
// vacuously true and could not fail for any bypass not spelled with that exact
// identifier. The test is named for a property -- no programmatic paste bypass --
// and was implemented as the absence of a string, which is the same divergence of
// name from predicate that the AC-5 raw-text guard had.
function parseTsx(absolutePath: string): ts.SourceFile {
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
}

// The full member list is pinned, not just the ones whose NAME matches /paste/.
// Gating on the name verified a naming convention rather than the property: a
// member called insertText or writeInput reaching sendInput is a programmatic
// paste bypass that /paste/i never sees. Pinning the whole set means any new
// handle member fails this test until someone decides whether it is one.
const EXPECTED_TERMINAL_HANDLE_MEMBERS = [
  'applyScreenRepair', 'awaitOutputIdle', 'bindRestoreCoordinator', 'captureRetainedState',
  'clearSelection', 'clearVisibleOutputRecovery', 'completeCheckpointTakeover', 'copySelection',
  'fit', 'focus', 'getAuthorityViewGeneration', 'getMouseTrackingActive', 'getScreenRepairReadiness',
  'getSelection', 'hasSelection', 'invalidateClipboardContext', 'isCheckpointAuthorityActive',
  'isCompatibilityRecoveryPending', 'pasteClipboard', 'pasteText', 'probeOutputFifo',
  'releasePending', 'repairLayout', 'replaceWithSnapshot', 'requestGridRepair', 'restoreSnapshot',
  'sendInput', 'setInputTransportState', 'setServerReady', 'setWindowsPty', 'submitClear',
  'submitOutput', 'writeAndWait', 'writeRecoveryTailAndWait',
] as const;

const PASTE_HANDLE_MEMBERS = ['pasteClipboard', 'pasteText'] as const;

function terminalHandleMemberNames(source: ts.SourceFile): string[] {
  // Collected into an array rather than assigned to a `let`: TypeScript does not
  // see assignments made inside the closure, narrows the variable to null, and
  // then types every later use as `never`.
  const found: ts.InterfaceDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TerminalHandle') {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(found.length, 1, `expected exactly one TerminalHandle interface, found ${found.length}`);

  const members = found[0]!.members;
  // Resolve quoted and computed names too. Restricting to ts.isIdentifier
  // silently dropped members, so `'pasteRaw': (data) => …` -- one pair of quotes
  // -- was absent from the "exact set" and the set still compared equal.
  const names = members
    .map(member => (member.name ? member.name.getText(source).replace(/^['"`]|['"`]$/g, '') : null))
    .filter((name): name is string => name !== null);
  // Nothing may be dropped between the member list and the names compared below.
  assert.equal(
    names.length,
    members.length,
    `TerminalHandle has ${members.length} members but only ${names.length} resolved to names`,
  );
  return names;
}

function imperativeHandleProperties(source: ts.SourceFile): Map<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'useImperativeHandle'
    ) {
      for (const argument of node.arguments) {
        let literal: ts.Node | undefined = ts.isArrowFunction(argument) ? argument.body : argument;
        // `() => ({ ... })` parenthesises the literal. Without unwrapping, this
        // map comes back empty and every per-member assertion below becomes a
        // statement about nothing that passes.
        while (literal && ts.isParenthesizedExpression(literal)) {
          literal = literal.expression;
        }
        if (literal && ts.isObjectLiteralExpression(literal)) {
          for (const property of literal.properties) {
            if (ts.isPropertyAssignment(property) && property.name) {
              properties.set(property.name.getText(source).replace(/^['"`]|['"`]$/g, ''), property.initializer);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return properties;
}

// The delegation must BE the coordinator call, not merely mention it. A body of
// `{ sendInputRef.current(data); return clipboardCoordinator.pasteText(data, source); }`
// contains the call and also delivers a second time -- the exactly-once
// violation this row is cited for -- so a substring match accepts it.
function soleDeliveryCallee(initializer: ts.Expression, source: ts.SourceFile): string {
  assert.ok(
    ts.isArrowFunction(initializer),
    `expected an arrow function, got: ${initializer.getText(source).slice(0, 80)}`,
  );
  let body: ts.Node = (initializer as ts.ArrowFunction).body;
  assert.ok(
    !ts.isBlock(body),
    'paste delegation must be a single expression; a block body can deliver more than once: '
    + `${initializer.getText(source).slice(0, 120)}`,
  );
  while (ts.isParenthesizedExpression(body)) {
    body = body.expression;
  }
  // `a?.b(...) ?? fallback` is the container's shape; the fallback is inert.
  if (ts.isBinaryExpression(body) && body.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    body = body.left;
  }
  while (ts.isParenthesizedExpression(body)) {
    body = body.expression;
  }
  assert.ok(
    ts.isCallExpression(body),
    `paste delegation must reduce to one call, got: ${body.getText(source).slice(0, 120)}`,
  );
  return (body as ts.CallExpression).expression.getText(source);
}

test('Terminal imperative handles route every paste-capable member through the coordinator', () => {
  const view = parseTsx(fileURLToPath(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url)));
  const container = parseTsx(fileURLToPath(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url)));

  // The whole surface is pinned. A new member of any name -- insertText,
  // writeInput, pasteRaw, quoted or not -- fails here until it is reviewed.
  assert.deepEqual(
    terminalHandleMemberNames(view).slice().sort(),
    [...EXPECTED_TERMINAL_HANDLE_MEMBERS].slice().sort(),
    'TerminalHandle membership changed; decide whether the new member is a paste entry point',
  );

  const viewProperties = imperativeHandleProperties(view);
  const containerProperties = imperativeHandleProperties(container);
  assert.ok(
    viewProperties.size > 10 && containerProperties.size > 10,
    `imperative handle enumeration looks empty: view=${viewProperties.size} container=${containerProperties.size}`,
  );

  for (const member of PASTE_HANDLE_MEMBERS) {
    const viewInitializer = viewProperties.get(member);
    const containerInitializer = containerProperties.get(member);
    assert.ok(viewInitializer, `TerminalView must implement ${member}`);
    assert.ok(containerInitializer, `TerminalContainer must implement ${member}`);
    assert.equal(
      soleDeliveryCallee(viewInitializer!, view),
      `clipboardCoordinator.${member}`,
      `TerminalView.${member} must deliver solely through the clipboard coordinator`,
    );
    assert.equal(
      soleDeliveryCallee(containerInitializer!, container),
      `terminalRef.current?.${member}`,
      `TerminalContainer.${member} must deliver solely through the inner terminal handle`,
    );
  }
});
