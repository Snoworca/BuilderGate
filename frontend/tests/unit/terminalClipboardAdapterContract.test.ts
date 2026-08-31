import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createTerminalClipboardCoordinator } from '../../src/utils/terminalClipboardCoordinator.ts';

const terminalViewSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url),
  'utf8',
);
const terminalContainerSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
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

test('Terminal imperative handles expose no legacy programmatic paste bypass', () => {
  assert.doesNotMatch(terminalViewSource, /\bpasteInput\s*:/);
  assert.doesNotMatch(terminalContainerSource, /\bpasteInput\s*:/);
  assert.match(terminalViewSource, /pasteText: \(data, source = 'command-preset'\) => clipboardCoordinator\.pasteText/);
  assert.match(terminalContainerSource, /pasteText: \(data, source\) => terminalRef\.current\?\.pasteText/);
});
