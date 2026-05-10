import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  TerminalShortcutBinding,
  TerminalShortcutKeyDescriptor,
  TerminalShortcutState,
} from '../../src/types/terminalShortcut.ts';
import {
  CODEX_NEWLINE_ACTION_LABEL,
  CODEX_NEWLINE_SEND_DATA,
  buildTerminalShortcutKeyDescriptor,
  describeTerminalShortcutKey,
  getActiveTerminalShortcutProfile,
  resolveTerminalShortcut,
} from '../../src/utils/terminalShortcutBindings.ts';

const now = '2026-05-10T00:00:00.000Z';

function state(overrides: Partial<TerminalShortcutState> = {}): TerminalShortcutState {
  return {
    version: 1,
    lastUpdated: now,
    profileSelections: [{ scope: 'global', profile: 'xterm-default', updatedAt: now }],
    bindings: [],
    ...overrides,
  };
}

function descriptor(overrides: Partial<TerminalShortcutKeyDescriptor> = {}): TerminalShortcutKeyDescriptor {
  return {
    key: 'Enter',
    code: 'Enter',
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    location: 0,
    repeat: false,
    ...overrides,
  };
}

function binding(overrides: Partial<TerminalShortcutBinding> = {}): TerminalShortcutBinding {
  return {
    id: 'binding-1',
    scope: 'global',
    key: 'Enter',
    code: 'Enter',
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    location: 0,
    repeat: false,
    action: { type: 'send', data: '\n', label: 'LF' },
    enabled: true,
    allowRepeat: false,
    matchByKeyFallback: false,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('ai-tui-compat resolves Shift+Enter and Ctrl+J to Codex newline send actions', () => {
  const shortcutState = state({
    profileSelections: [{ scope: 'global', profile: 'ai-tui-compat', updatedAt: now }],
  });

  const shiftEnter = resolveTerminalShortcut({
    event: descriptor(),
    state: shortcutState,
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.equal(shiftEnter.kind, 'matched');
  assert.equal(shiftEnter.kind === 'matched' ? shiftEnter.action.type : null, 'send');
  assert.equal(shiftEnter.kind === 'matched' && shiftEnter.action.type === 'send' ? shiftEnter.action.data : null, CODEX_NEWLINE_SEND_DATA);
  assert.equal(shiftEnter.kind === 'matched' && shiftEnter.action.type === 'send' ? shiftEnter.action.label : null, CODEX_NEWLINE_ACTION_LABEL);

  const ctrlJ = resolveTerminalShortcut({
    event: descriptor({ key: 'j', code: 'KeyJ', ctrlKey: true, shiftKey: false }),
    state: shortcutState,
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.equal(ctrlJ.kind, 'matched');
  assert.equal(ctrlJ.kind === 'matched' && ctrlJ.action.type === 'send' ? ctrlJ.action.data : null, CODEX_NEWLINE_SEND_DATA);
});

test('reserved Ctrl+V skips user bindings even when a matching binding exists', () => {
  const resolution = resolveTerminalShortcut({
    event: descriptor({ key: 'v', code: 'KeyV', ctrlKey: true, shiftKey: false }),
    state: state({
      bindings: [binding({
        key: 'v',
        code: 'KeyV',
        ctrlKey: true,
        shiftKey: false,
        action: { type: 'send', data: '\x16' },
      })],
    }),
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });

  assert.deepEqual(resolution, { kind: 'skipped', reason: 'reserved' });
});

test('user bindings override ai-tui-compat profile bindings with pass-through or block actions', () => {
  const shortcutState = state({
    profileSelections: [{ scope: 'global', profile: 'ai-tui-compat', updatedAt: now }],
    bindings: [binding({ action: { type: 'pass-through' } })],
  });

  assert.deepEqual(
    resolveTerminalShortcut({
      event: descriptor(),
      state: shortcutState,
      workspaceId: null,
      sessionId: 'session-1',
      imeActive: false,
      hasSelection: false,
    }),
    { kind: 'pass-through', reason: 'action-pass-through' },
  );

  const blockState = state({
    profileSelections: [{ scope: 'global', profile: 'ai-tui-compat', updatedAt: now }],
    bindings: [binding({ id: 'block', action: { type: 'block' } })],
  });
  const block = resolveTerminalShortcut({
    event: descriptor(),
    state: blockState,
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.equal(block.kind, 'matched');
  assert.equal(block.kind === 'matched' ? block.action.type : null, 'block');
});

test('scope priority uses session before workspace before global', () => {
  const shortcutState = state({
    profileSelections: [
      { scope: 'global', profile: 'xterm-default', updatedAt: now },
      { scope: 'workspace', workspaceId: 'workspace-1', profile: 'ai-tui-compat', updatedAt: now },
      { scope: 'session', sessionId: 'session-1', profile: 'custom', updatedAt: now },
    ],
    bindings: [
      binding({ id: 'global', action: { type: 'send', data: 'g' }, sortOrder: 0 }),
      binding({ id: 'workspace', scope: 'workspace', workspaceId: 'workspace-1', action: { type: 'send', data: 'w' }, sortOrder: 0 }),
      binding({ id: 'session', scope: 'session', sessionId: 'session-1', action: { type: 'send', data: 's' }, sortOrder: 0 }),
    ],
  });

  assert.equal(getActiveTerminalShortcutProfile(shortcutState, 'workspace-1', 'session-1'), 'custom');
  const resolution = resolveTerminalShortcut({
    event: descriptor(),
    state: shortcutState,
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.equal(resolution.kind === 'matched' ? resolution.bindingId : null, 'session');
});

test('disabled binding, repeat-disabled, location mismatch, and key fallback are distinct', () => {
  const disabled = resolveTerminalShortcut({
    event: descriptor(),
    state: state({ bindings: [binding({ enabled: false })] }),
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.deepEqual(disabled, { kind: 'skipped', reason: 'disabled' });

  const repeat = resolveTerminalShortcut({
    event: descriptor({ repeat: true }),
    state: state({ bindings: [binding()] }),
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.deepEqual(repeat, { kind: 'skipped', reason: 'repeat-disabled' });

  const mismatch = resolveTerminalShortcut({
    event: descriptor({ location: 1 }),
    state: state({ bindings: [binding()] }),
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.deepEqual(mismatch, { kind: 'pass-through', reason: 'no-match' });

  const fallback = resolveTerminalShortcut({
    event: descriptor({ code: 'NumpadEnter', location: 3 }),
    state: state({ bindings: [binding({ matchByKeyFallback: true })] }),
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });
  assert.equal(fallback.kind, 'matched');
});

test('disabled user binding suppresses built-in profile fallback', () => {
  const resolution = resolveTerminalShortcut({
    event: descriptor(),
    state: state({
      profileSelections: [{ scope: 'global', profile: 'ai-tui-compat', updatedAt: now }],
      bindings: [binding({ enabled: false })],
    }),
    workspaceId: null,
    sessionId: 'session-1',
    imeActive: false,
    hasSelection: false,
  });

  assert.deepEqual(resolution, { kind: 'skipped', reason: 'disabled' });
});

test('descriptor builder and labels keep safe key metadata', () => {
  const event = {
    key: 'Enter',
    code: 'Enter',
    ctrlKey: true,
    shiftKey: true,
    altKey: false,
    metaKey: false,
    location: 0,
    repeat: false,
  } as KeyboardEvent;

  const built = buildTerminalShortcutKeyDescriptor(event);
  assert.equal(built.ctrlKey, true);
  assert.equal(describeTerminalShortcutKey(built), 'Ctrl+Shift+Enter');
});
