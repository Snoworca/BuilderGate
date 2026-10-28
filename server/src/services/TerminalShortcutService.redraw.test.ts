// REL-BGSTAB-053 AC-7: the redraw action can be bound to a key and is stored like the others.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalShortcutService } from './TerminalShortcutService.js';

// @req REL-BGSTAB-053
test('REL-BGSTAB-053 AC-7: a binding with the redraw action is validated, stored and read back', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-shortcut-redraw-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dataPath = path.join(dir, 'terminal-shortcuts.json');
  const service = new TerminalShortcutService({ dataPath });
  await service.initialize();
  const binding = await service.createBinding({
    scope: 'global', key: 'd', code: 'KeyD', ctrlKey: true, shiftKey: false, altKey: true, metaKey: false, location: 0,
    action: { type: 'redraw' },
  });
  assert.deepEqual(binding.action, { type: 'redraw' });
  const reloaded = new TerminalShortcutService({ dataPath });
  await reloaded.initialize();
  assert.deepEqual(reloaded.getState().bindings.at(-1)?.action, { type: 'redraw' });
});
