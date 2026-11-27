// FR-UIDS-018 AC-6: the app theme preference and the boot script that applies it
// before the first paint. The preference module (src/theme/appTheme.ts) is what
// the settings card of FR-UIDS-020 will write through; public/theme-boot.js is a
// classic script in <head>, because the CSP (script-src 'self') blocks an inline
// one, and it has to reach the same answer as the module from the same key.
// @req FR-UIDS-018
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  APP_THEME_STORAGE_KEY,
  SYSTEM_DARK_QUERY,
  applyTheme,
  readThemePreference,
  resolveTheme,
  systemPrefersDark,
  writeThemePreference,
} from '../../src/theme/appTheme.ts';
import * as editorTheme from '../../src/components/editor/editorTheme.ts';

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

test('FR-UIDS-018 AC-6: a missing, unknown or unreadable preference reads as dark', () => {
  assert.equal(readThemePreference(memoryStorage()), 'dark');
  for (const stored of ['', 'Dark', 'LIGHT', 'night', 'auto', 'true', ' light']) {
    assert.equal(readThemePreference(memoryStorage({ [APP_THEME_STORAGE_KEY]: stored })), 'dark', JSON.stringify(stored));
  }
  assert.equal(readThemePreference(null), 'dark', 'no storage at all');
  assert.equal(readThemePreference(blockedStorage), 'dark', 'storage that throws');
});

test('FR-UIDS-018 AC-6: a stored dark, light or system preference reads back as itself', () => {
  for (const stored of ['dark', 'light', 'system'] as const) {
    assert.equal(readThemePreference(memoryStorage({ [APP_THEME_STORAGE_KEY]: stored })), stored);
  }
  assert.equal(APP_THEME_STORAGE_KEY, 'buildergate.theme');
});

test('FR-UIDS-018 AC-6: writing stores the preference under the shared key; a storage failure only loses it', () => {
  const storage = memoryStorage();
  writeThemePreference('light', storage);
  assert.equal(storage.data.get(APP_THEME_STORAGE_KEY), 'light');
  assert.equal(readThemePreference(storage), 'light');
  writeThemePreference('system', storage);
  assert.equal(readThemePreference(storage), 'system');

  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => { warned.push(args); };
  try {
    assert.doesNotThrow(() => writeThemePreference('dark', blockedStorage));
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1, 'the lost write is reported once');
  assert.doesNotThrow(() => writeThemePreference('dark', null));
});

test('FR-UIDS-018 AC-6: dark and light resolve to themselves; system follows the OS', () => {
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('FR-UIDS-018 AC-6: the OS preference comes from the media query, and is dark where it cannot be read', () => {
  const asked: string[] = [];
  const host = (matches: boolean) => ({ matchMedia: (query: string) => { asked.push(query); return { matches }; } });
  assert.equal(systemPrefersDark(host(true)), true);
  assert.equal(systemPrefersDark(host(false)), false);
  assert.deepEqual(asked, [SYSTEM_DARK_QUERY, SYSTEM_DARK_QUERY]);
  assert.equal(SYSTEM_DARK_QUERY, '(prefers-color-scheme: dark)');
  assert.equal(systemPrefersDark({}), true, 'no matchMedia');
  assert.equal(systemPrefersDark(null), true, 'no window');
  assert.equal(systemPrefersDark({ matchMedia: () => { throw new Error('unsupported'); } }), true, 'matchMedia throws');
});

test('FR-UIDS-018 AC-1 AC-6: applying a theme sets data-theme on the root element', () => {
  const root = { dataset: {} as DOMStringMap };
  applyTheme('light', root);
  assert.equal(root.dataset.theme, 'light');
  applyTheme('dark', root);
  assert.equal(root.dataset.theme, 'dark');
});

// ---- the boot script ---------------------------------------------------------

const BOOT = readFileSync(new URL('../../public/theme-boot.js', import.meta.url), 'utf8');

interface BootCase {
  stored: string | null;
  /** null: the browser has no matchMedia. */
  prefersDark: boolean | null;
  /** 'getItem': reading throws; 'access': touching window.localStorage throws. */
  blocked?: 'getItem' | 'access';
}

/** Runs public/theme-boot.js against a fake page and returns the data-theme it set. */
function runBoot(c: BootCase): string | undefined {
  const dataset: Record<string, string> = {};
  const documentElement = {
    dataset,
    setAttribute(name: string, value: string) {
      if (name === 'data-theme') dataset.theme = String(value);
    },
  };
  const values = new Map<string, string>(c.stored === null ? [] : [[APP_THEME_STORAGE_KEY, c.stored]]);
  const storage = {
    getItem(key: string) {
      if (c.blocked === 'getItem') throw new Error('storage blocked');
      return values.has(key) ? values.get(key)! : null;
    },
  };
  const window: Record<string, unknown> = {};
  if (c.blocked === 'access') {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  } else {
    window.localStorage = storage;
  }
  if (c.prefersDark !== null) {
    const prefersDark = c.prefersDark;
    window.matchMedia = (query: string) => ({ matches: query === SYSTEM_DARK_QUERY ? prefersDark : false });
  }
  const document = { documentElement };
  window.document = document;
  vm.runInNewContext(BOOT, { window, document });
  return dataset.theme;
}

/** What the module decides for the same page. */
function moduleDecision(c: BootCase): string {
  const storage = c.blocked === 'access' ? null
    : c.blocked === 'getItem' ? blockedStorage
    : memoryStorage(c.stored === null ? {} : { [APP_THEME_STORAGE_KEY]: c.stored });
  const host = c.prefersDark === null ? {} : { matchMedia: () => ({ matches: c.prefersDark === true }) };
  return resolveTheme(readThemePreference(storage), systemPrefersDark(host));
}

test('FR-UIDS-018 AC-6: the boot script reads the same key and resolves exactly as the module does', () => {
  const cases: BootCase[] = [];
  for (const stored of [null, 'dark', 'light', 'system', 'bogus', '']) {
    for (const prefersDark of [true, false, null]) cases.push({ stored, prefersDark });
  }
  cases.push({ stored: 'light', prefersDark: false, blocked: 'getItem' });
  cases.push({ stored: 'light', prefersDark: false, blocked: 'access' });
  cases.push({ stored: 'system', prefersDark: false, blocked: 'access' });

  const differing: string[] = [];
  for (const c of cases) {
    const boot = runBoot(c);
    const expected = moduleDecision(c);
    if (boot !== expected) differing.push(`${JSON.stringify(c)}: boot ${boot}, module ${expected}`);
  }
  assert.deepEqual(differing, []);
  // The parity above needs the key and the query to be the same strings, not just equivalent logic.
  assert.ok(BOOT.includes(`'${APP_THEME_STORAGE_KEY}'`), 'the boot script names the module key');
  assert.ok(BOOT.includes(`'${SYSTEM_DARK_QUERY}'`), 'the boot script asks the module media query');
});

test('FR-UIDS-018 AC-6: index.html runs the boot script as a classic script in <head>, before the app module', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';
  const tag = /<script\b([^>]*)\bsrc="\/theme-boot\.js"([^>]*)><\/script>/.exec(head);
  assert.ok(tag, 'the boot script is loaded from <head>');
  assert.doesNotMatch(`${tag[1]} ${tag[2]}`, /\b(type|async|defer)\b/, 'a classic, parser-blocking script runs before the first paint');
  assert.ok(html.indexOf('/theme-boot.js') < html.indexOf('/src/main.tsx'), 'it runs before the app module');
  // The CSP allows script-src 'self' only, so no script may be inline.
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(script[1], /\bsrc=/, 'every script names a file');
    assert.equal(script[2].trim(), '', 'no inline script body');
  }
});

test('FR-UIDS-018 AC-7: the app theme has its own key, so any app choice leaves the editor on its default (day)', () => {
  assert.notEqual(APP_THEME_STORAGE_KEY, editorTheme.THEME_PREFERENCE_KEY);
  for (const preference of ['dark', 'light', 'system'] as const) {
    const storage = memoryStorage();
    writeThemePreference(preference, storage);
    assert.equal(editorTheme.readThemePreference(storage), 'light', `app theme ${preference}`);
  }
});
