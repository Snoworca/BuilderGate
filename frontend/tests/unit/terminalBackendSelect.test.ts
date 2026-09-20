import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TERMINAL_BACKEND_OPTIONS,
  terminalBackendFromUseConpty,
  useConptyFromTerminalBackend,
} from '../../src/components/Settings/settingsDraftHelpers.ts';

/**
 * Issue #117. The Windows PTY backend had two controls in two vocabularies: a
 * `Use ConPTY` checkbox whose name is node-pty's own option (`useConpty`, a
 * passthrough present since the first commit) and a `conpty | winpty | inherit`
 * select beside it. They are parent and child on one axis and the screen did
 * not say so.
 *
 * The fix is presentation only: the checkbox becomes a select in the SAME
 * vocabulary, `pty.useConpty` stays a boolean in the config, and no server code
 * or stored value changes.
 *
 * WHAT MUST NOT HAPPEN lives in settingsDraftHelpers.test.ts, beside the
 * fixture that patch building needs: the first idea was
 * to let the PowerShell select drive `useConpty`. That would turn a
 * PowerShell-scoped override into a global switch, so choosing conpty for
 * PowerShell would silently move cmd and bash too — the opposite of why the
 * override exists. It was added (a224f6e3, step18) because
 * `PowerShell/PSReadLine on ConPTY` corrupted the screen on rapid Enter, and
 * its whole point is to carve PowerShell OUT of the global choice.
 */

test('#117 the global backend select speaks the same vocabulary as the PowerShell one', () => {
  // The PowerShell select's options come from the server as
  // ['inherit', 'conpty', 'winpty']. The global one must read the same, or the
  // two controls still look unrelated.
  assert.deepEqual([...TERMINAL_BACKEND_OPTIONS], ['conpty', 'winpty']);
});

test('#117 the select value and the stored boolean map both ways', () => {
  assert.equal(terminalBackendFromUseConpty(true), 'conpty');
  assert.equal(terminalBackendFromUseConpty(false), 'winpty');
  assert.equal(useConptyFromTerminalBackend('conpty'), true);
  assert.equal(useConptyFromTerminalBackend('winpty'), false);

  for (const option of TERMINAL_BACKEND_OPTIONS) {
    assert.equal(
      terminalBackendFromUseConpty(useConptyFromTerminalBackend(option)),
      option,
      `round trip lost ${option}`,
    );
  }
});

test('#117 an unrecognised select value does not silently turn ConPTY off', () => {
  // The select cannot produce anything else today. It is pinned anyway because
  // the failure would be silent and in the dangerous direction: falling back to
  // false drops a Windows deployment to winpty, which is the backend this
  // project has measured corrupting PowerShell.
  assert.equal(useConptyFromTerminalBackend('nonsense', true), true);
  assert.equal(useConptyFromTerminalBackend('nonsense', false), false);
});
