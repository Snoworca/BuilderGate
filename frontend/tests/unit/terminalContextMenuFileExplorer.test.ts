import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTerminalContextMenuItems,
  type BuildTerminalMenuOptions,
} from '../../src/utils/contextMenuBuilder.ts';

// FR-FEX-010 AC-4 — the terminal right-click menu is one of the three ways to
// open the explorer.
//
// Where in the menu the entry sits is not decided by the requirement, so only
// its presence, its handler and its absence without the option are asserted.
// The absence matters because contextMenuBuilder.ts is under the stable
// FR-ARCH-004..006 contracts: a caller that does not opt in must get exactly the
// menu it got before.
//
// The option travels in a variable typed as the builder's options plus the new
// field, so this file type-checks before the field exists and the failure is the
// missing item rather than a compiler error.
type TerminalMenuOptionsWithExplorer = BuildTerminalMenuOptions & {
  onOpenFileExplorer?: () => void;
};

const EXPLORER_LABEL = '파일 탐색기 열기';

function terminalMenuBase(
  overrides: Partial<TerminalMenuOptionsWithExplorer> = {},
): TerminalMenuOptionsWithExplorer {
  return {
    tab: undefined,
    tabs: [],
    maxTabs: 8,
    onAddTab: () => undefined,
    onCloseTab: () => undefined,
    onCopy: async () => undefined,
    onPaste: async () => undefined,
    hasSelection: true,
    ...overrides,
  };
}

function labelsOf(items: ReturnType<typeof buildTerminalContextMenuItems>): string[] {
  return items.flatMap(item => (item.separator ? [] : [item.label]));
}

test('FR-FEX-010 AC-4 the terminal menu offers 파일 탐색기 열기 and it calls onOpenFileExplorer', () => {
  let calls = 0;
  const options = terminalMenuBase({ onOpenFileExplorer: () => { calls += 1; } });
  const items = buildTerminalContextMenuItems(options);

  const entry = items.find(item => !item.separator && item.label === EXPLORER_LABEL);
  assert.ok(entry && !entry.separator, `the terminal menu offers ${EXPLORER_LABEL}; got ${JSON.stringify(labelsOf(items))}`);
  assert.equal(typeof entry.onClick, 'function', `${EXPLORER_LABEL} carries a handler`);
  assert.notEqual(entry.disabled, true, `${EXPLORER_LABEL} is enabled`);

  entry.onClick?.();
  assert.equal(calls, 1, 'choosing the entry opens the explorer once');

  // The existing entries survive the addition.
  const labels = labelsOf(items);
  ['새 세션', '세션 닫기', '복사', '붙여넣기'].forEach((label) => {
    assert.ok(labels.includes(label), `${label} is still offered`);
  });
});

test('FR-FEX-010 AC-4 without onOpenFileExplorer the terminal menu has no explorer entry', () => {
  const items = buildTerminalContextMenuItems(terminalMenuBase());
  assert.equal(labelsOf(items).includes(EXPLORER_LABEL), false);
});
