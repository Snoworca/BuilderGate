// FR-UIDS-020: the theme choice the settings card makes. setThemePreference stores it and
// applies it at once; 'system' follows the OS for as long as it is the choice; startAppTheme
// takes over at app start from public/theme-boot.js, which applied the stored choice before
// the first paint. The card itself is rendered in themeSettingsCard.test.ts.
// @req FR-UIDS-020
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  APP_THEME_STORAGE_KEY,
  SYSTEM_DARK_QUERY,
  currentThemePreference,
  setThemePreference,
  startAppTheme,
  subscribeAppliedTheme,
} from '../../src/theme/appTheme.ts';

type Store = { data: Map<string, string>; getItem(key: string): string | null; setItem(key: string, value: string): void };

function memoryStorage(initial: Record<string, string> = {}): Store {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key)! : null),
    setItem: (key, value) => { data.set(key, value); },
  };
}

const blockedStorage = {
  getItem: (): string | null => { throw new Error('storage blocked'); },
  setItem: (): void => { throw new Error('storage blocked'); },
};

/** The root element as theme-boot.js left it; undefined: the boot script never ran. */
function rootWith(theme?: 'dark' | 'light') {
  const dataset = {} as DOMStringMap;
  if (theme) dataset.theme = theme;
  return { dataset };
}

type ChangeListener = (event: { matches: boolean }) => void;

/** An OS whose dark preference can be flipped, delivered as MediaQueryList 'change' events. */
function fakeOs(prefersDark: boolean) {
  const listeners = new Set<ChangeListener>();
  const asked: string[] = [];
  const query = {
    get matches() { return prefersDark; },
    addEventListener(type: string, listener: ChangeListener) { if (type === 'change') listeners.add(listener); },
    removeEventListener(type: string, listener: ChangeListener) { if (type === 'change') listeners.delete(listener); },
  };
  return {
    host: { matchMedia: (media: string) => { asked.push(media); return query; } },
    asked,
    listeners,
    flip(next: boolean) {
      prefersDark = next;
      for (const listener of [...listeners]) listener({ matches: next });
    },
  };
}

function recordAppliedThemes() {
  const seen: string[] = [];
  const stop = subscribeAppliedTheme((theme) => { seen.push(theme); });
  return { seen, stop };
}

function silenceWarnings<T>(run: () => T): { result: T; warned: unknown[][] } {
  const warn = console.warn;
  const warned: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    return { result: run(), warned };
  } finally {
    console.warn = warn;
  }
}

test('FR-UIDS-020 AC-2 AC-3: choosing light stores it and applies it at once, telling the open terminals', () => {
  const storage = memoryStorage();
  const root = rootWith('dark');
  const os = fakeOs(true);
  const applied = recordAppliedThemes();
  try {
    setThemePreference('light', { storage, host: os.host, root });
  } finally {
    applied.stop();
  }
  assert.equal(storage.data.get(APP_THEME_STORAGE_KEY), 'light', 'kept for the next visit');
  assert.equal(root.dataset.theme, 'light', 'the app screens switch now');
  assert.deepEqual(applied.seen, ['light'], 'the terminals are told once');
  assert.equal(currentThemePreference(storage), 'light');
  assert.equal(os.listeners.size, 0, 'a fixed choice does not watch the OS');

  setThemePreference('dark', { storage, host: os.host, root });
  assert.equal(storage.data.get(APP_THEME_STORAGE_KEY), 'dark');
  assert.equal(root.dataset.theme, 'dark');
});

test('FR-UIDS-020 AC-4: follow-system applies what the OS asks for now and on every change, without a reload', () => {
  const storage = memoryStorage();
  const root = rootWith('dark');
  const os = fakeOs(false);
  const applied = recordAppliedThemes();
  try {
    setThemePreference('system', { storage, host: os.host, root });
    assert.equal(storage.data.get(APP_THEME_STORAGE_KEY), 'system');
    assert.equal(root.dataset.theme, 'light', 'the OS asks for light now');
    assert.ok(os.asked.length > 0 && os.asked.every((media) => media === SYSTEM_DARK_QUERY), 'it asks the dark query');
    assert.equal(os.listeners.size, 1, 'it watches the OS');

    os.flip(true);
    assert.equal(root.dataset.theme, 'dark');
    os.flip(false);
    assert.equal(root.dataset.theme, 'light');
    assert.deepEqual(applied.seen, ['light', 'dark', 'light'], 'each change reaches the terminals');

    setThemePreference('system', { storage, host: os.host, root });
    assert.equal(os.listeners.size, 1, 'choosing it again does not watch twice');
  } finally {
    applied.stop();
  }
});

test('FR-UIDS-020 AC-4: after switching away from follow-system the OS is no longer followed and its listener is gone', () => {
  const storage = memoryStorage();
  const root = rootWith('dark');
  const os = fakeOs(true);
  setThemePreference('system', { storage, host: os.host, root });
  assert.equal(os.listeners.size, 1);

  setThemePreference('dark', { storage, host: os.host, root });
  assert.equal(os.listeners.size, 0, 'the change listener is removed');
  os.flip(false);
  assert.equal(root.dataset.theme, 'dark', 'an OS change no longer moves the theme');

  setThemePreference('system', { storage, host: os.host, root });
  assert.equal(root.dataset.theme, 'light', 'back on follow-system it reads the OS again');
  setThemePreference('light', { storage, host: os.host, root });
  assert.equal(os.listeners.size, 0);
  os.flip(true);
  assert.equal(root.dataset.theme, 'light');
});

test('FR-UIDS-020 AC-2: storage that refuses the write still gets the choice applied to this page; the next start is dark', () => {
  const root = rootWith('dark');
  const os = fakeOs(true);
  const { warned } = silenceWarnings(() => setThemePreference('light', { storage: blockedStorage, host: os.host, root }));
  assert.equal(root.dataset.theme, 'light', 'applied although it could not be stored');
  assert.equal(warned.length, 1, 'the lost write is reported');
  assert.equal(currentThemePreference(blockedStorage), 'light', 'the card keeps showing the choice in effect');

  silenceWarnings(() => setThemePreference('system', { storage: blockedStorage, host: os.host, root }));
  assert.equal(root.dataset.theme, 'dark');
  os.flip(false);
  assert.equal(root.dataset.theme, 'light', 'follow-system works on this page without storage');

  for (const storage of [blockedStorage, null]) {
    const nextVisit = rootWith();
    startAppTheme({ storage, host: fakeOs(false).host, root: nextVisit });
    assert.equal(nextVisit.dataset.theme, 'dark', `unusable storage (${storage === null ? 'none' : 'throws'}) starts dark`);
    assert.equal(currentThemePreference(storage), 'dark');
  }
  assert.equal(os.listeners.size, 0, 'the old page follower was stopped');
});

test('FR-UIDS-020 AC-4: at start the module takes over what the boot script applied and keeps following the OS', () => {
  const storage = memoryStorage({ [APP_THEME_STORAGE_KEY]: 'system' });
  const os = fakeOs(false);
  const root = rootWith('light');
  const applied = recordAppliedThemes();
  try {
    startAppTheme({ storage, host: os.host, root });
    assert.equal(root.dataset.theme, 'light');
    assert.deepEqual(applied.seen, [], 'nothing to repaint: the boot script already put this theme on');
    assert.equal(currentThemePreference(storage), 'system');
    assert.equal(os.listeners.size, 1, 'follow-system keeps watching after the boot script');

    os.flip(true);
    assert.equal(root.dataset.theme, 'dark');
    assert.deepEqual(applied.seen, ['dark']);
  } finally {
    applied.stop();
  }
});

test('FR-UIDS-020 AC-2: at start a stored dark or light is applied as it is, even where the boot script did not run', () => {
  for (const stored of ['dark', 'light'] as const) {
    for (const prefersDark of [true, false]) {
      const os = fakeOs(prefersDark);
      const root = rootWith();
      startAppTheme({ storage: memoryStorage({ [APP_THEME_STORAGE_KEY]: stored }), host: os.host, root });
      assert.equal(root.dataset.theme, stored, `${stored}, OS dark ${prefersDark}`);
      assert.equal(os.listeners.size, 0, 'a fixed choice does not watch the OS');
    }
  }
  const root = rootWith('light');
  startAppTheme({ storage: memoryStorage({ [APP_THEME_STORAGE_KEY]: 'bogus' }), host: fakeOs(false).host, root });
  assert.equal(root.dataset.theme, 'dark', 'an unknown value starts dark');
});

// ---- the card's words ---------------------------------------------------------

function catalog(lang: 'en' | 'ko'): Record<string, string> {
  return JSON.parse(readFileSync(new URL(`../../public/locales/messages.${lang}.json`, import.meta.url), 'utf8')) as Record<string, string>;
}

const CARD_KEYS = [
  'settings.theme.title',
  'settings.theme.description',
  'settings.theme.label',
  'settings.theme.help',
  'settings.theme.dark',
  'settings.theme.light',
  'settings.theme.system',
];

test('FR-UIDS-020 AC-5: the card title, description and choices are in both catalogs under the same keys', () => {
  const en = catalog('en');
  const ko = catalog('ko');
  for (const key of CARD_KEYS) {
    assert.ok(typeof en[key] === 'string' && en[key].trim() !== '', `en ${key}`);
    assert.ok(typeof ko[key] === 'string' && ko[key].trim() !== '', `ko ${key}`);
  }
  assert.deepEqual(
    [en['settings.theme.dark'], en['settings.theme.light'], en['settings.theme.system']],
    ['Dark', 'Light', 'Follow system setting'],
  );
  assert.deepEqual(
    [ko['settings.theme.dark'], ko['settings.theme.light'], ko['settings.theme.system']],
    ['다크', '라이트', '시스템 설정 따름'],
  );
});

test('FR-UIDS-020 AC-4: main.tsx starts the app theme before the first render', () => {
  const main = readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8');
  const start = main.indexOf('startAppTheme()');
  assert.ok(start >= 0, 'main.tsx calls startAppTheme()');
  assert.ok(start < main.indexOf('createRoot('), 'before the first render');
});
