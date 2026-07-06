import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCommandPresetPasteInput } from '../../src/components/CommandPresetManager/commandPresetPaste.ts';

test('command preset paste keeps command text without Enter', () => {
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'command', value: 'npm test' }),
    { ok: true, data: 'npm test' },
  );
});

test('directory preset paste keeps the registered directory value', () => {
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'directory', value: 'C:\\Work\\Project' }),
    { ok: true, data: 'C:\\Work\\Project' },
  );
});

test('command and directory preset paste reject multiline values', () => {
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'command', value: 'echo one\nwhoami' }),
    { ok: false, reason: 'multiline-command' },
  );
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'directory', value: 'C:\\Work\rD:\\Other' }),
    { ok: false, reason: 'multiline-directory' },
  );
});

test('prompt preset paste allows multiline prompt values', () => {
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'prompt', value: 'first line\nsecond line' }),
    { ok: true, data: 'first line\nsecond line' },
  );
});

test('all command preset paste kinds reject tab and non-line-break control characters', () => {
  const unsafeValues = [
    'tab\tvalue',
    'nul\u0000value',
    'del\u007fvalue',
    'bell\u0007value',
  ];

  for (const kind of ['command', 'directory', 'prompt'] as const) {
    for (const value of unsafeValues) {
      assert.deepEqual(
        buildCommandPresetPasteInput({ kind, value }),
        { ok: false, reason: 'control-character' },
        `${kind}: ${JSON.stringify(value)}`,
      );
    }
  }
});

test('line break rejection reason stays specific for each registered preset kind', () => {
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'command', value: 'npm test\nwhoami' }),
    { ok: false, reason: 'multiline-command' },
  );
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'directory', value: 'C:\\Work\rD:\\Other' }),
    { ok: false, reason: 'multiline-directory' },
  );
  assert.deepEqual(
    buildCommandPresetPasteInput({ kind: 'prompt', value: 'first\nsecond' }),
    { ok: true, data: 'first\nsecond' },
  );
});
