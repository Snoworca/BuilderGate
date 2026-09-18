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
  // Bounded span. The unbounded `[\s\S]*?` form this replaces matched 90,173
  // characters -- very nearly the whole file -- so it asserted only that the three
  // tokens each occur somewhere, in this order, not that they form one condition.
  // The real condition spans 289 characters.
  assert.match(
    terminalViewSource,
    /!terminalDisposedRef\.current[\s\S]{0,320}?&& isVisibleRef\.current[\s\S]{0,320}?&& clipboardViewGenerationRef\.current === target\.viewGeneration/,
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
  // Each reset is anchored to the site that must perform it, rather than counted
  // file-wide. The previous form was `resetCount >= 4` over the whole source with
  // the message "expected mount, clear and dispose resets" -- it named three sites,
  // required four occurrences, and constrained none of them to a location, so four
  // resets added to unrelated branches satisfied it while any named site losing its
  // reset still passed. The message was also wrong about the sites: there is no
  // mount reset. The five that exist are enumerated here.
  const RESET = String.raw`savedRightClickSelXtermGenerationRef\.current = 0;`;
  const resetSites: ReadonlyArray<readonly [string, string]> = [
    // Both imperative-handle clearSelection implementations: clearing the xterm
    // selection must also drop the saved right-click copy of it.
    ['clearSelection handle', String.raw`clearSelection: \(\) => \{`],
    // Transport restore: the buffer the selection referred to is being replaced.
    ['restore-pending', String.raw`transportBarrierReasonRef\.current = 'restore-pending';`],
    // Left mouse button: a new selection gesture invalidates the saved one.
    ['left-click clear', String.raw`else if \(e\.button === 0\) \{`],
    // Dispose: the xterm generation the saved selection was bound to is gone.
    ['dispose', String.raw`terminalWriteCoordinatorRef\.current = null;`],
  ];
  let anchoredResets = 0;
  for (const [label, anchor] of resetSites) {
    const matches = terminalViewSource.match(new RegExp(`${anchor}[\\s\\S]{0,240}?${RESET}`, 'g'));
    assert.ok(matches, `${label} does not reset savedRightClickSelXtermGenerationRef within its own block`);
    anchoredResets += matches.length;
  }
  // Every reset in the file belongs to one of the enumerated sites. A reset added
  // anywhere else fails here rather than silently raising a file-wide count.
  const totalResets = terminalViewSource.match(new RegExp(RESET, 'g'))?.length ?? 0;
  assert.equal(
    totalResets,
    anchoredResets,
    `${totalResets - anchoredResets} reset(s) outside the enumerated lifecycle sites`,
  );

  // Bounded span: the real sequence is 211 characters. Unbounded, this matched
  // 36,175 -- it bound an unrelated earlier clearBufferedOutput() call.
  assert.match(
    terminalViewSource,
    /clearBufferedOutput\(\);[\s\S]{0,320}?savedRightClickSelRef\.current = '';[\s\S]{0,320}?xtermGenerationRef\.current \+= 1;/,
  );
  // This one is genuinely long: the dispose cleanup block runs ~35 lines between
  // the adapter teardown and the xterm handle release, so the span is bounded at
  // the block's measured size rather than at the tighter window used above.
  assert.match(
    terminalViewSource,
    /terminalRestoreAdapterRef\.current = null;[\s\S]{0,2000}?savedRightClickSelRef\.current = '';[\s\S]{0,320}?xtermRef\.current = null;/,
  );
});

// Enumerates the handle from the AST instead of asserting that one dead token is
// absent. The previous form was `doesNotMatch(/\bpasteInput\s*:/)` against both
// sources; `pasteInput` occurs nowhere in the repository, so both assertions were
// vacuously true and could not fail for any bypass not spelled with that exact
// identifier. The test is named for a property -- no programmatic paste bypass --
// and was implemented as the absence of a string, which is the same divergence of
// name from predicate that the AC-5 raw-text guard had.
// Review found the previous form pinned the `TerminalHandle` INTERFACE, and the
// interface is not what ships. `useImperativeHandle<T, R extends T>` lets the
// object literal carry members the interface never declares, so a paste bypass
// added to the literal alone passed while the pinned set stayed unchanged -- the
// fourth appearance of the same proxy-for-property defect, this time at the type
// level. Three surfaces are pinned now: the interface, and both imperative-handle
// object literals, which are the objects callers actually receive.
//
// Each name carries the reason it is not a paste entry point, so that meeting a
// red here costs a decision rather than a keystroke. A bare list of names makes
// the cheapest resolution "paste the new name in", which turns a guard into a
// formality over time.
//
// What this test still cannot see, stated here rather than left to a report that
// gets read second. Pinning a membership set is itself a proxy for "no paste
// bypass exists":
//   - a member already in the pinned set whose body changes to deliver twice
//     without changing its callee text or arguments -- only the two paste members
//     have their delivery shape asserted, the other 32 are pinned by name;
//   - a paste path that never reaches either imperative handle at all, e.g. a
//     module-scope export or a context value;
//   - anything about runtime behaviour, since this parses both components and
//     executes neither. Selection-less Ctrl+C SIGINT ownership is invisible here.
//     That gap (issue #87) is now covered by tests/unit/terminalViewKeyboardBehavior
//     .test.ts, which renders TerminalView and invokes its real key handler. That
//     file owns AC-2 and AC-3 as BEHAVIOUR; this file continues to own the shape of
//     the handle surface as TEXT, and the two do not substitute for each other: a
//     paste member added to the literal is caught here and not there, and a branch
//     whose condition inverts is caught there and not here.
const TERMINAL_HANDLE_MEMBERS: Readonly<Record<string, string>> = {
  applyScreenRepair: 'applies a server screen repair; takes a message object, not a payload string',
  awaitOutputIdle: 'output-drain probe; no input',
  bindRestoreCoordinator: 'binds the restore adapter; no input',
  captureRetainedState: 'reads retained state; no input',
  clearSelection: 'clears selection; no input',
  clearVisibleOutputRecovery: 'clears recovery bookkeeping; no input',
  completeCheckpointTakeover: 'checkpoint lifecycle; no input',
  copySelection: 'clipboard COPY entry point; coordinator-owned, asserted below',
  fit: 'layout only',
  focus: 'focus only; its lone string is a debug reason, not a payload',
  getAuthorityViewGeneration: 'reads a generation; no input',
  getMouseTrackingActive: 'reads mouse mode; no input',
  getScreenRepairReadiness: 'reads readiness; no input',
  getSelection: 'reads selection text; no input',
  hasSelection: 'reads selection presence; no input',
  invalidateClipboardContext: 'bumps the clipboard view generation; no input',
  isCheckpointAuthorityActive: 'reads authority state; no input',
  isCompatibilityRecoveryPending: 'reads recovery state; no input',
  pasteClipboard: 'PASTE entry point; must delegate to the coordinator, asserted below',
  pasteText: 'PASTE entry point; must delegate to the coordinator, asserted below',
  probeOutputFifo: 'output probe; no input',
  releasePending: 'releases pending writes; no input',
  repairLayout: 'layout repair; its lone string is a reason, not a payload',
  replaceWithSnapshot: 'writes terminal OUTPUT from a snapshot; not user input',
  requestGridRepair: 'asks the grid to repair; no input',
  restoreSnapshot: 'restores terminal OUTPUT; not user input',
  sendInput: 'raw input path, deliberately NOT a clipboard paste: it is the shared '
    + 'transport every input source ends in, including the coordinator. Routing a '
    + 'clipboard payload here directly is the bypass this test exists to prevent.',
  setInputTransportState: 'transport bookkeeping; no input',
  setServerReady: 'readiness flag; no input',
  setWindowsPty: 'platform flag; no input',
  submitClear: 'clears the screen; no input',
  submitOutput: 'writes terminal OUTPUT; not user input',
  writeAndWait: 'writes terminal OUTPUT and awaits flush; its lone string is output, not input',
  writeRecoveryTailAndWait: 'writes recovery OUTPUT; not user input',
};

const PASTE_HANDLE_MEMBERS = ['pasteClipboard', 'pasteText'] as const;

// Members whose signature takes a lone `string`. Anything string-taking is a
// candidate payload sink, so each must be named here deliberately. This is what
// turns the pin from a tripwire into a predicate: adding `insertText: (data:
// string) => …` fails BOTH the membership pin and this list, and the second
// cannot be satisfied by copying a name without asserting what it does.
const LONE_STRING_PARAMETER_MEMBERS = ['focus', 'repairLayout', 'sendInput', 'writeAndWait'] as const;

// A `?? fallback` fires exactly when the primary target is missing, so anything
// that DELIVERS there is a live second input path. Not every call delivers,
// though: the container's fallbacks wrap a rejection result in Promise.resolve.
// Rather than accept any call (which admits a real bypass) or reject any call
// (which reddens correct code), the inert callees are named, and the fallback is
// additionally forbidden from naming any delivery seam.
const INERT_FALLBACK_CALLEES = ['Promise.resolve'] as const;
const DELIVERY_SEAMS = ['sendInput', 'submitProgrammaticPaste', 'clipboardCoordinator', 'terminalRef', 'onInput'] as const;

// `requestGridRepair` is optional on the interface and supplied by the container,
// so the view's literal is the pinned set minus that one.
const VIEW_LITERAL_OMISSIONS = ['requestGridRepair'] as const;

function parseTsx(absolutePath: string): ts.SourceFile {
  return ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  );
}

function terminalHandleInterface(source: ts.SourceFile): ts.InterfaceDeclaration {
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
  return found[0]!;
}

function memberNames(declaration: ts.InterfaceDeclaration, source: ts.SourceFile): string[] {
  const members = declaration.members;
  // Resolve quoted and computed names too. Restricting to ts.isIdentifier
  // silently dropped members, so `'pasteRaw': (data) => …` -- one pair of quotes
  // -- was absent from the "exact set" and the set still compared equal.
  const names = members
    .map(member => (member.name ? member.name.getText(source).replace(/^['"`]|['"`]$/g, '') : null))
    .filter((name): name is string => name !== null);
  // Nothing may be dropped between the member list and the names compared below;
  // an index or call signature has no name and would vanish silently.
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
              properties.set(
                property.name.getText(source).replace(/^['"`]|['"`]$/g, ''),
                property.initializer,
              );
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

// The delegation must BE the coordinator call, not merely mention it, and the
// call must carry the caller's own arguments. Review defeated three weaker
// forms: a block body that also called sendInput before returning the coordinator
// result; a `?? fallback` whose right-hand side was itself a delivery and fires
// exactly when the left is nullish; and `pasteText(data + data, source)`, which
// duplicates the payload -- the exactly-once class this row is cited for.
function assertSoleDelivery(
  initializer: ts.Expression,
  source: ts.SourceFile,
  expectedCallee: string,
  label: string,
): void {
  assert.ok(ts.isArrowFunction(initializer), `${label}: expected an arrow function`);
  const arrow = initializer as ts.ArrowFunction;
  const parameters = arrow.parameters.map(parameter => parameter.name.getText(source));

  let body: ts.Node = arrow.body;
  assert.ok(
    !ts.isBlock(body),
    `${label}: delegation must be a single expression; a block body can deliver more than once`,
  );
  while (ts.isParenthesizedExpression(body)) {
    body = body.expression;
  }
  if (ts.isBinaryExpression(body) && body.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    const fallback = body.right;
    // The fallback fires precisely when the primary target is missing, so a call
    // there is a live second delivery path, not inert decoration.
    const calls: string[] = [];
    const scan = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
      ts.forEachChild(node, scan);
    };
    scan(fallback);
    const delivering = calls.filter(callee => !INERT_FALLBACK_CALLEES.includes(callee as never));
    assert.deepEqual(
      delivering,
      [],
      `${label}: the ?? fallback fires when the primary is nullish, so it must not deliver. `
      + `Unrecognised callees: ${JSON.stringify(delivering)}`,
    );
    const fallbackText = fallback.getText(source);
    const seams = DELIVERY_SEAMS.filter(seam => fallbackText.includes(seam));
    assert.deepEqual(
      seams,
      [],
      `${label}: the ?? fallback must not reference a delivery seam. Found: ${JSON.stringify(seams)}`,
    );
    body = body.left;
  }
  while (ts.isParenthesizedExpression(body)) {
    body = body.expression;
  }
  assert.ok(ts.isCallExpression(body), `${label}: delegation must reduce to one call`);
  const call = body as ts.CallExpression;
  assert.equal(call.expression.getText(source), expectedCallee, `${label}: wrong delivery callee`);

  // Arguments must be the parameters themselves. `data + data` is a payload
  // duplication that a callee-only comparison accepts.
  const args = call.arguments.map(argument => argument.getText(source));
  for (const argument of args) {
    assert.ok(
      parameters.includes(argument),
      `${label}: argument \`${argument}\` is not one of the handler's parameters `
      + `${JSON.stringify(parameters)}; the payload must be forwarded unmodified`,
    );
  }
  assert.ok(args.length > 0, `${label}: expected the payload to be forwarded`);
}

test('Terminal imperative handles route every paste-capable member through the coordinator', () => {
  const view = parseTsx(fileURLToPath(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url)));
  const container = parseTsx(fileURLToPath(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url)));

  const pinned = Object.keys(TERMINAL_HANDLE_MEMBERS).sort();

  // 1. The declared type.
  assert.deepEqual(
    memberNames(terminalHandleInterface(view), view).sort(),
    pinned,
    'TerminalHandle membership changed; decide whether the new member is a paste entry point',
  );

  // 2. The objects callers actually receive. The interface is only a proxy for
  //    these: useImperativeHandle<T, R extends T> admits extra members, so a
  //    bypass can live in a literal that the interface never mentions.
  const viewProperties = imperativeHandleProperties(view);
  const containerProperties = imperativeHandleProperties(container);
  assert.deepEqual(
    [...viewProperties.keys()].sort(),
    pinned.filter(name => !VIEW_LITERAL_OMISSIONS.includes(name as never)),
    'TerminalView imperative handle exposes members the pinned set does not cover',
  );
  assert.deepEqual(
    [...containerProperties.keys()].sort(),
    pinned,
    'TerminalContainer imperative handle exposes members the pinned set does not cover',
  );

  // 3. Every string-taking member is deliberately named, so a new payload sink
  //    cannot be admitted by copying a name into the pin alone.
  const loneStringMembers = terminalHandleInterface(view).members
    .filter(member => {
      const type = (member as ts.PropertySignature).type;
      return !!type
        && ts.isFunctionTypeNode(type)
        && type.parameters.length === 1
        && type.parameters[0]!.type?.kind === ts.SyntaxKind.StringKeyword;
    })
    .map(member => member.name!.getText(view).replace(/^['"`]|['"`]$/g, ''))
    .sort();
  assert.deepEqual(
    loneStringMembers,
    [...LONE_STRING_PARAMETER_MEMBERS].slice().sort(),
    'a handle member now takes a lone string payload; say what it does before allowing it',
  );

  // 4. The two paste members deliver once, through the coordinator, unmodified.
  for (const member of PASTE_HANDLE_MEMBERS) {
    const viewInitializer = viewProperties.get(member);
    const containerInitializer = containerProperties.get(member);
    assert.ok(viewInitializer, `TerminalView must implement ${member}`);
    assert.ok(containerInitializer, `TerminalContainer must implement ${member}`);
    assertSoleDelivery(viewInitializer!, view, `clipboardCoordinator.${member}`, `TerminalView.${member}`);
    assertSoleDelivery(containerInitializer!, container, `terminalRef.current?.${member}`, `TerminalContainer.${member}`);
  }
});
