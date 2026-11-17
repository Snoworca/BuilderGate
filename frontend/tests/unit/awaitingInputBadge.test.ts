// FR-AITUI-024 AC-5: a tab whose agent waits on a choice carries an orange ? badge
// before its name, and the workspace list shows how many of its tabs wait.
// Runs through test:unit:terminal-view-behavior (tsx): the badges are TSX.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();
const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;
const ko = JSON.parse(readFileSync(new URL('../../public/locales/messages.ko.json', import.meta.url), 'utf8')) as Record<string, string>;
const { installCatalog } = await import('../../src/i18n/i18n.ts');
installCatalog('en', en);
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const {
  TabAwaitingInputBadge,
  WorkspaceAwaitingInputBadge,
  countAwaitingInputTabs,
} = await import('../../src/components/Workspace/AwaitingInputBadge.tsx');

function read(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

async function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  return {
    container,
    cleanup: async () => { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test('FR-AITUI-024 AC-5: the tab badge is a ? named from the catalog', async () => {
  const view = await render(React.createElement(TabAwaitingInputBadge));
  try {
    const badge = view.container.querySelector('.workspace-tab-awaiting');
    assert.ok(badge);
    assert.equal(badge.textContent, '?');
    assert.equal(badge.getAttribute('role'), 'img');
    assert.equal(badge.getAttribute('aria-label'), en['workspace.tabBar.awaitingInput']);
    assert.equal(badge.getAttribute('title'), en['workspace.tabBar.awaitingInput']);
  } finally {
    await view.cleanup();
  }
});

test('FR-AITUI-024 AC-5: the workspace badge shows ? and the count, and nothing at zero', async () => {
  const two = await render(React.createElement(WorkspaceAwaitingInputBadge, { count: 2 }));
  try {
    const badge = two.container.querySelector('.workspace-item-awaiting');
    assert.ok(badge);
    assert.equal(badge.textContent, '?2');
    assert.equal(badge.getAttribute('aria-label'), en['workspace.item.awaitingInput.other'].replace('{count}', '2'));
  } finally {
    await two.cleanup();
  }
  const one = await render(React.createElement(WorkspaceAwaitingInputBadge, { count: 1 }));
  try {
    assert.equal(one.container.querySelector('.workspace-item-awaiting')?.getAttribute('aria-label'), en['workspace.item.awaitingInput.one'].replace('{count}', '1'));
  } finally {
    await one.cleanup();
  }
  const none = await render(React.createElement(WorkspaceAwaitingInputBadge, { count: 0 }));
  try {
    assert.equal(none.container.innerHTML, '');
  } finally {
    await none.cleanup();
  }
});

test('FR-AITUI-024 AC-5: a workspace counts only its own waiting tabs', () => {
  const tabs = [
    { workspaceId: 'w1', awaitingInput: true },
    { workspaceId: 'w1', awaitingInput: false },
    { workspaceId: 'w1' },
    { workspaceId: 'w2', awaitingInput: true },
  ];
  assert.equal(countAwaitingInputTabs(tabs, 'w1'), 1);
  assert.equal(countAwaitingInputTabs(tabs, 'w2'), 1);
  assert.equal(countAwaitingInputTabs(tabs, 'w3'), 0);
});

test('FR-AITUI-024 AC-5: the catalog names the badges in en and ko', () => {
  for (const key of ['workspace.tabBar.awaitingInput', 'workspace.item.awaitingInput.other']) {
    assert.ok(en[key], `${key} in en`);
    assert.ok(ko[key], `${key} in ko`);
  }
  assert.ok(en['workspace.item.awaitingInput.one']);
});

test('FR-AITUI-024 AC-5: the tab bar, the workspace list and the tab type are wired', () => {
  const tabBar = read('../../src/components/Workspace/WorkspaceTabBar.tsx');
  assert.match(tabBar, /\{tab\.awaitingInput && <TabAwaitingInputBadge \/>\}/);
  assert.ok(
    tabBar.indexOf('<TabAwaitingInputBadge') < tabBar.indexOf('className="workspace-tab-name"'),
    'the badge sits before the tab name',
  );
  const item = read('../../src/components/Workspace/WorkspaceItem.tsx');
  assert.match(item, /awaitingCount: number;/);
  assert.match(item, /<WorkspaceAwaitingInputBadge count=\{awaitingCount\} \/>/);
  const sidebar = read('../../src/components/Workspace/WorkspaceSidebar.tsx');
  assert.match(sidebar, /awaitingCount=\{countAwaitingInputTabs\(tabs, ws\.id\)\}/);
  const types = read('../../src/types/workspace.ts');
  assert.match(types, /awaitingInput\?: boolean;/);
});

test('FR-AITUI-024 AC-5: both badges are orange (the attention token), apart from the amber running count', () => {
  const tokens = read('../../src/styles/tokens.css');
  assert.match(tokens, /--attention:\s*#[0-9a-f]{6};/i);
  const tabCss = read('../../src/components/Workspace/WorkspaceTabBar.css');
  assert.match(/\.workspace-tab-awaiting\s*\{([^}]*)\}/.exec(tabCss)?.[1] ?? '', /background:\s*var\(--attention\)/);
  const wsCss = read('../../src/components/Workspace/Workspace.css');
  assert.match(/\.workspace-item-awaiting\s*\{([^}]*)\}/.exec(wsCss)?.[1] ?? '', /background:\s*var\(--attention\)/);
});
