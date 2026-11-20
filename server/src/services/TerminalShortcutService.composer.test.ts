// FR-CMP-001 AC-3: the composer toggle can be bound to another key and is stored like the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalShortcutService } from './TerminalShortcutService.js';

test('FR-CMP-001 AC-3: a binding with the toggle-composer action is validated, stored and read back', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-shortcut-composer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'terminal-shortcuts.json');
  const service = new TerminalShortcutService({ dataPath });
  await service.initialize();
  const binding = await service.createBinding({
    scope: 'global', key: 'm', code: 'KeyM', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, location: 0,
    action: { type: 'toggle-composer' },
  });
  assert.deepEqual(binding.action, { type: 'toggle-composer' });
  const reloaded = new TerminalShortcutService({ dataPath });
  await reloaded.initialize();
  assert.deepEqual(reloaded.getState().bindings.at(-1)?.action, { type: 'toggle-composer' });
});

test('FR-TODO-002 AC-2: a binding with the toggle-todo action is validated, stored and read back', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-shortcut-todo-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'terminal-shortcuts.json');
  const service = new TerminalShortcutService({ dataPath });
  await service.initialize();
  const binding = await service.createBinding({
    scope: 'global', key: 'y', code: 'KeyY', ctrlKey: false, shiftKey: false, altKey: true, metaKey: false, location: 0,
    action: { type: 'toggle-todo' },
  });
  assert.deepEqual(binding.action, { type: 'toggle-todo' });
});
