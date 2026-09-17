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

function terminalHandleMemberNames(source: ts.SourceFile): string[] {
  let names: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'TerminalHandle') {
      names = node.members
        .map(member => (member.name && ts.isIdentifier(member.name) ? member.name.text : null))
        .filter((name): name is string => name !== null);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(names !== null, 'TerminalHandle interface not found; the enumeration below would be empty');
  return names!;
}

function imperativeHandleProperties(source: ts.SourceFile): Map<string, string> {
  const properties = new Map<string, string>();
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
            if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
              properties.set(property.name.text, property.initializer.getText(source));
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

test('Terminal imperative handles route every paste-capable member through the coordinator', () => {
  const view = parseTsx(fileURLToPath(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url)));
  const container = parseTsx(fileURLToPath(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url)));

  const members = terminalHandleMemberNames(view);
  // Guards the enumeration itself: a traversal that silently found nothing would
  // make the set comparison below trivially satisfiable.
  assert.ok(members.length > 10, `TerminalHandle enumeration looks empty: ${members.length} members`);

  // The exact set, not a subset. A newly added `pasteRaw: (data) => sendInput(data)`
  // is a genuine programmatic paste bypass, and only an exact comparison rejects it.
  assert.deepEqual(
    members.filter(name => /paste/i.test(name)).sort(),
    ['pasteClipboard', 'pasteText'],
    'every paste-capable handle member must be an explicit clipboard coordinator entry point',
  );

  const viewProperties = imperativeHandleProperties(view);
  const containerProperties = imperativeHandleProperties(container);
  assert.ok(viewProperties.size > 10 && containerProperties.size > 10, 'imperative handle enumeration looks empty');

  for (const member of ['pasteClipboard', 'pasteText']) {
    assert.match(
      viewProperties.get(member) ?? '',
      /clipboardCoordinator\./,
      `TerminalView.${member} must delegate to the clipboard coordinator`,
    );
    assert.match(
      containerProperties.get(member) ?? '',
      /terminalRef\.current\?\./,
      `TerminalContainer.${member} must delegate to the inner terminal handle`,
    );
  }

  // sendInput is a legitimate non-paste input API that sits on the same handle.
  // It must not become a paste path by name, which is what the old assertion was
  // reaching for and could not express.
  assert.ok(
    !/paste/i.test('sendInput') && members.includes('sendInput'),
    'sendInput is expected to remain a non-paste member of the handle',
  );
});
