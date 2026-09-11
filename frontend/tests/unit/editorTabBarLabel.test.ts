// The tab row's dirty marker, guarded where it is composed.
//
// `EditorTabBar` is a component and this suite has no DOM, so the rendered row
// cannot be read here. What can be read is the source: the label and the title
// must both go through `windowDialogTitleText`, the same function the window
// title uses. If one of them stopped, the row and the title would disagree
// about what a dirty document looks like and nothing would say so.
//
// @req FR-MDE-010

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { windowDialogTitleText } from '../../src/components/dialog/windowDialogModel.ts';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/components/editor/EditorTabBar.tsx', import.meta.url)),
  'utf8',
);

test('a dirty document is marked with a trailing asterisk', () => {
  assert.equal(windowDialogTitleText('CLAUDE.md', true), 'CLAUDE.md*');
  assert.equal(windowDialogTitleText('CLAUDE.md', false), 'CLAUDE.md');
});

test('the tab label composes its text through the window title function', () => {
  assert.match(
    SOURCE,
    /\{windowDialogTitleText\(fileNameOf\(tab\.filePath\), tab\.dirty\)\}/,
    'the visible label must be composed by windowDialogTitleText, not by the row itself',
  );
});

test('the tab tooltip carries the full path through the same function', () => {
  assert.match(
    SOURCE,
    /title=\{windowDialogTitleText\(tab\.filePath, tab\.dirty\)\}/,
    'the tooltip must show the whole path, since nearly every tab is named CLAUDE.md',
  );
});

test('the marker is drawn per tab rather than for the active one only', () => {
  // `active` decides styling and `aria-selected`; it must not reach the label
  // text, or a dirty document behind another tab would look clean.
  const labelBlock = SOURCE.slice(
    SOURCE.indexOf('className="editor-tab-label"'),
    SOURCE.indexOf('className="editor-tab-close"'),
  );
  assert.notEqual(labelBlock.length, 0, 'the label block anchor was not found');
  assert.doesNotMatch(
    labelBlock,
    /active \?[^\n]*windowDialogTitleText/,
    'the label text must not branch on whether the tab is the active one',
  );
});
