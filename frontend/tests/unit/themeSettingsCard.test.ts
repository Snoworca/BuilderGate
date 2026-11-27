// FR-UIDS-020 AC-1 AC-3 AC-5: the theme card on the real Settings page, rendered under jsdom
// with the server calls faked. The choice is a per-browser setting applied at once, like the
// language card above it, so it must not touch the settings form: Save stays off and Close
// leaves without the discard dialog. A real form change is made at the end to show both
// probes do react to a dirty form. Runs through test:unit:terminal-view-behavior
// (tsx + module mocks + asset stubs).
// @req FR-UIDS-020
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { SettingsSnapshot } from '../../src/types/settings.ts';
import { installJsdomEnvironment } from './jsdomEnvironment.ts';

installJsdomEnvironment();
const en = JSON.parse(readFileSync(new URL('../../public/locales/messages.en.json', import.meta.url), 'utf8')) as Record<string, string>;
const { installCatalog } = await import('../../src/i18n/i18n.ts');
installCatalog('en', en);

const capability = { applyScope: 'immediate', available: true, writeOnly: false } as const;

/** Only what the page reads while it renders; the resource-limit cards stay hidden. */
const snapshot = {
  values: {
    auth: { durationMs: 86_400_000, localhostNoAuth: false, refreshGraceSeconds: 180 },
    twoFactor: { enabled: false, externalOnly: false, issuer: 'BuilderGate', accountName: 'admin' },
    security: { cors: { allowedOrigins: [], credentials: true, maxAge: 86_400 } },
    pty: { termName: 'xterm-256color', defaultCols: 80, defaultRows: 24, useConpty: true, windowsPowerShellBackend: 'inherit', shell: 'auto' },
    session: { idleDelayMs: 2_000, autoSave: { enabled: true, intervalMinutes: 5 }, snapshotRetention: 10 },
    fileManager: {
      maxFileSize: 10_485_760,
      maxDirectoryEntries: 1_000,
      blockedExtensions: [],
      blockedPaths: [],
      cwdCacheTtlMs: 30_000,
      gitQuickTimeoutMs: 10_000,
      gitTimeoutMs: 20_000,
    },
    resourceLimits: {},
    stabilityModes: {},
  },
  capabilities: {
    'pty.shell': { ...capability, options: ['auto'] },
    'pty.useConpty': { ...capability, available: false },
  },
  secretState: { authPasswordConfigured: true, smtpPasswordConfigured: false },
  excludedSections: [],
} as unknown as SettingsSnapshot;

mock.module('../../src/services/api.ts', {
  namedExports: {
    settingsApi: { getSettings: async () => structuredClone(snapshot) },
    sessionSnapshotApi: { getStatus: async () => ({ autoSave: null }) },
    authApi: { getTotpQr: async () => null },
    // The usage form below the theme card stays on its loading line.
    usageLimitsApi: { get: () => new Promise(() => {}) },
  },
});

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { SettingsPage } = await import('../../src/components/Settings/SettingsPage.tsx');
const { APP_THEME_STORAGE_KEY, subscribeAppliedTheme, setThemePreference } = await import('../../src/theme/appTheme.ts');

const view = () => document.defaultView as Window & typeof globalThis;

const mounted = new Set<() => Promise<void>>();
test.afterEach(async () => {
  for (const cleanup of [...mounted]) await cleanup();
});

async function renderSettings() {
  const backCalls: string[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(SettingsPage, { visible: true, onBack: () => { backCalls.push('back'); } }));
  });
  // Lets the faked settings load settle into the page.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const cleanup = async () => {
    if (!mounted.delete(cleanup)) return;
    await act(async () => { root.unmount(); });
    container.remove();
  };
  mounted.add(cleanup);

  const cards = [...container.querySelectorAll('.settings-grid > .settings-card')] as HTMLElement[];
  const themeCard = cards.find((card) => card.querySelector('#settings-theme'));
  const toolbarButtons = [...container.querySelectorAll('.settings-toolbar-actions button')] as HTMLButtonElement[];
  return {
    container,
    cards,
    themeCard,
    select: themeCard?.querySelector('select#settings-theme') as HTMLSelectElement | null | undefined,
    saveButton: container.querySelector('[data-testid="settings-save-button"]') as HTMLButtonElement,
    closeButton: toolbarButtons.find((button) => button.textContent === en['common.close'])!,
    backCalls,
  };
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new (view().Event)('change', { bubbles: true }));
  });
}

test('FR-UIDS-020 AC-1 AC-5: a theme card right after the language card offers dark, light and follow-system, dark by default', async () => {
  localStorage.removeItem(APP_THEME_STORAGE_KEY);
  const page = await renderSettings();
  assert.ok(page.cards.length > 2, 'the settings cards rendered');
  const titles = page.cards.map((card) => card.querySelector('.settings-card-heading h3')?.textContent);
  assert.equal(titles[0], en['settings.language.title']);
  assert.equal(titles[1], en['settings.theme.title'], 'the theme card follows the language card');
  assert.ok(page.themeCard && page.select, 'the theme card has its select');
  assert.equal(page.cards.indexOf(page.themeCard), 1);

  const card = page.themeCard;
  assert.equal(card.querySelector('.settings-card-heading p')?.textContent, en['settings.theme.description']);
  const label = card.querySelector('label[for="settings-theme"]');
  assert.ok(label, 'the select has a label, as the language select does');
  assert.ok(label.textContent?.startsWith(en['settings.theme.label']));
  assert.equal(label.querySelector('.settings-local-badge')?.textContent, en['settings.field.localOnly'], 'marked as kept in this browser');
  assert.equal(card.querySelector('.ui-field-help')?.textContent, en['settings.theme.help']);

  assert.deepEqual(
    [...page.select.options].map((option) => [option.value, option.textContent]),
    [
      ['dark', en['settings.theme.dark']],
      ['light', en['settings.theme.light']],
      ['system', en['settings.theme.system']],
    ],
  );
  assert.equal(page.select.value, 'dark', 'dark by default');
});

test('FR-UIDS-020 AC-3: choosing a theme applies and stores it at once, and leaves the settings form untouched', async () => {
  localStorage.removeItem(APP_THEME_STORAGE_KEY);
  const page = await renderSettings();
  assert.ok(page.select);
  assert.equal(page.saveButton.disabled, true, 'nothing to save yet');

  const applied: string[] = [];
  const stop = subscribeAppliedTheme((theme) => { applied.push(theme); });
  try {
    await choose(page.select, 'light');
    assert.equal(document.documentElement.dataset.theme, 'light', 'the app screens switch now');
    assert.deepEqual(applied, ['light'], 'the open terminals are told');
    assert.equal(localStorage.getItem(APP_THEME_STORAGE_KEY), 'light', 'kept for the next visit');
    assert.equal(page.select.value, 'light');

    // jsdom's matchMedia answers "not dark", so following the system means light here.
    await choose(page.select, 'system');
    assert.equal(localStorage.getItem(APP_THEME_STORAGE_KEY), 'system');
    assert.equal(document.documentElement.dataset.theme, 'light');
    await choose(page.select, 'dark');
    assert.equal(localStorage.getItem(APP_THEME_STORAGE_KEY), 'dark');
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.deepEqual(applied, ['light', 'dark']);
  } finally {
    stop();
  }

  assert.equal(page.saveButton.disabled, true, 'the theme is not part of the form, so Save stays off');
  await act(async () => { page.closeButton.click(); });
  assert.deepEqual(page.backCalls, ['back'], 'Close leaves at once');
  assert.equal(document.querySelector('[role="alertdialog"]'), null, 'no discard dialog');

  // The control: a real form change turns both probes, so they are not blind.
  const checkbox = page.container.querySelector('[data-testid="auth-localhost-no-auth"]') as HTMLInputElement;
  await act(async () => { checkbox.click(); });
  assert.equal(page.saveButton.disabled, false, 'a form change can be saved');
  await act(async () => { page.closeButton.click(); });
  assert.deepEqual(page.backCalls, ['back'], 'a dirty form does not leave at once');
  assert.ok(document.querySelector('[role="alertdialog"]'), 'it asks first');
});

test('FR-UIDS-020 AC-2: the card opens on the theme this page runs, not on the default', async () => {
  // A light or follow-system choice from an earlier visit must show as such; a card stuck on
  // "dark" would also make choosing dark a no-op (the select value would not change).
  for (const pref of ['light', 'system'] as const) {
    setThemePreference(pref);
    const page = await renderSettings();
    assert.ok(page.select);
    assert.equal(page.select.value, pref, `the card shows ${pref}`);
    for (const cleanup of [...mounted]) await cleanup();
  }
  setThemePreference('dark');
});
