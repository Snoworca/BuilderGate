import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decideTerminalClickFocus } from '../../src/components/Terminal/sessionComposerModel.ts';

// FR-CMP-003 AC-6: a plain click on the terminal of a session whose composer is open puts the
// caret in the composer; a selection, another button, a closed composer or a phone leave it be.

const base = { composerOpen: true, button: 0, hasSelection: false, mobile: false };

test('FR-CMP-003 AC-6: a plain left click with the composer open goes to the composer', () => {
  assert.equal(decideTerminalClickFocus(base), 'composer');
});

test('FR-CMP-003 AC-6: a selection, another button, a closed composer or a phone keep the terminal', () => {
  assert.equal(decideTerminalClickFocus({ ...base, hasSelection: true }), 'terminal');
  assert.equal(decideTerminalClickFocus({ ...base, button: 2 }), 'terminal');
  assert.equal(decideTerminalClickFocus({ ...base, button: 1 }), 'terminal');
  assert.equal(decideTerminalClickFocus({ ...base, composerOpen: false }), 'terminal');
  assert.equal(decideTerminalClickFocus({ ...base, mobile: true }), 'terminal');
});

test('FR-CMP-003 AC-6: the app watches clicks on terminals and hands them to the session composer', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf-8');
  assert.match(app, /decideTerminalClickFocus\(/);
  assert.match(app, /closest<HTMLElement>\('\[data-tab-id\]'\)/);
  assert.match(app, /sessionComposerStore\.requestFocus\(/);
  // The click still reaches the terminal: the listener only moves focus afterwards.
  assert.doesNotMatch(app.slice(app.indexOf('decideTerminalClickFocus(')), /^[\s\S]{0,400}(stopPropagation|preventDefault)\(\)/);
});
