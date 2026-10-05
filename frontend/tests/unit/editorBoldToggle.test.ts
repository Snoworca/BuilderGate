// FR-MDE-025: Ctrl+B turns bold on, and pressing it again turns it off.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';

import { toggleBoldTransaction } from '../../src/editor/core/bold-toggle.ts';

function apply(doc: string, anchor: number, head = anchor): { doc: string; from: number; to: number } {
  const state = EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
  const next = state.update(toggleBoldTransaction(state)).state;
  const range = next.selection.main;
  return { doc: next.doc.toString(), from: range.from, to: range.to };
}

test('FR-MDE-025 AC-1: a selected word becomes bold and stays selected', () => {
  assert.deepEqual(apply('bold target', 5, 11), { doc: 'bold **target**', from: 7, to: 13 });
});

test('FR-MDE-025 AC-2: pressing it again on the same selection removes the bold', () => {
  const once = apply('bold target', 5, 11);
  assert.deepEqual(apply(once.doc, once.from, once.to), { doc: 'bold target', from: 5, to: 11 });
});

test('FR-MDE-025 AC-2: a selection that includes the markers is unwrapped too', () => {
  assert.deepEqual(apply('bold **target**', 5, 15), { doc: 'bold target', from: 5, to: 11 });
});

test('FR-MDE-025 AC-3: with no selection it inserts a bold pair around the cursor, and removes an empty one', () => {
  assert.deepEqual(apply('ab', 1), { doc: 'a****b', from: 3, to: 3 });
  assert.deepEqual(apply('a****b', 3), { doc: 'ab', from: 1, to: 1 });
});

test('FR-MDE-025: a selection inside bold text that is not the whole of it gets its own bold', () => {
  // `**ab**cd`: selecting "cd" is not bold, so it is wrapped rather than unwrapping a neighbour.
  assert.deepEqual(apply('**ab**cd', 6, 8), { doc: '**ab****cd**', from: 8, to: 10 });
});
