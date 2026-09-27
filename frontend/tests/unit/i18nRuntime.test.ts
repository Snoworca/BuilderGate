import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fill, pluralCategoriesFor } from '../../src/i18n/catalog.ts';
import {
  activeLanguage, initI18n, installCatalog, LANGUAGE_PREFERENCE_STORAGE_KEY, readLanguagePreference, t, tn, writeLanguagePreference,
} from '../../src/i18n/i18n.ts';
import type { MessageKey, PluralKey } from '../../src/i18n/i18n.ts';
import { pickLanguage } from '../../src/i18n/negotiate.ts';

// FR-I18N-001, FR-I18N-002 AC-1/AC-2, FR-I18N-004 — the runtime, without a DOM.

const SUPPORTED = new Set(['en', 'ko']);

test('FR-I18N-001 AC-1..AC-4: only the first browser language counts; unsupported or missing falls back to en', () => {
  assert.equal(pickLanguage('ko-KR', SUPPORTED, 'en'), 'ko');
  assert.equal(pickLanguage('ko', SUPPORTED, 'en'), 'ko');
  assert.equal(pickLanguage('en-US', SUPPORTED, 'en'), 'en');
  assert.equal(pickLanguage('ja', SUPPORTED, 'en'), 'en');
  assert.equal(pickLanguage(undefined, SUPPORTED, 'en'), 'en');
  assert.equal(pickLanguage('', SUPPORTED, 'en'), 'en');
});

test('FR-I18N-004 AC-1: named placeholders are filled; unknown names stay visible', () => {
  assert.equal(fill('{name} 저장', { name: 'ls' }), 'ls 저장');
  assert.equal(fill('{a} and {b}', { a: 1 }), '1 and {b}');
  assert.equal(fill('no params'), 'no params');
});

test('FR-I18N-004 AC-2: plural categories come from CLDR — en one/other, ko other', () => {
  assert.deepEqual(pluralCategoriesFor('en'), ['one', 'other']);
  assert.deepEqual(pluralCategoriesFor('ko'), ['other']);
  installCatalog('en', { 'x.count.one': '{count} file', 'x.count.other': '{count} files' });
  assert.equal(tn('x.count' as PluralKey, 1), '1 file');
  assert.equal(tn('x.count' as PluralKey, 2), '2 files');
  installCatalog('ko', { 'x.count.other': '{count}개' });
  assert.equal(tn('x.count' as PluralKey, 1), '1개');
});

test('FR-I18N-004 AC-3: a missing key shows its name and warns once', () => {
  installCatalog('en', {});
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    assert.equal(t('nope.missing' as MessageKey), 'nope.missing');
    assert.equal(t('nope.missing' as MessageKey), 'nope.missing');
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
});

test('FR-I18N-002 AC-1: only the chosen catalog is requested', async () => {
  const requested: string[] = [];
  const fetchJson = async (url: string) => {
    requested.push(url);
    if (url.endsWith('languages.json')) return { default: 'en', languages: { en: 'English', ko: '한국어' } };
    return { greeting: url.includes('.ko.') ? '안녕' : 'Hi' };
  };
  assert.equal(await initI18n('ko-KR', fetchJson), 'ko');
  assert.deepEqual(requested, ['/locales/languages.json', '/locales/messages.ko.json']);
  assert.equal(activeLanguage(), 'ko');
  assert.equal(t('greeting' as MessageKey), '안녕');
});

test('FR-I18N-002 AC-2: a failed catalog request retries the default language once', async () => {
  const requested: string[] = [];
  const fetchJson = async (url: string) => {
    requested.push(url);
    if (url.endsWith('languages.json')) return { default: 'en', languages: { en: 'English', ko: '한국어' } };
    if (url.includes('.ko.')) throw new Error('HTTP 404');
    return { greeting: 'Hi' };
  };
  const original = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await initI18n('ko', fetchJson), 'en');
  } finally {
    console.warn = original;
  }
  assert.deepEqual(requested, ['/locales/languages.json', '/locales/messages.ko.json', '/locales/messages.en.json']);
  assert.equal(t('greeting' as MessageKey), 'Hi');
});

test('FR-I18N-006 AC-1/AC-2: a supported Settings choice beats the browser language; an unsupported one is ignored', async () => {
  const fetchJson = async (url: string) => {
    if (url.endsWith('languages.json')) return { default: 'en', languages: { en: 'English', ko: '한국어' } };
    return { greeting: url.includes('.ko.') ? '안녕' : 'Hi' };
  };
  assert.equal(await initI18n('ko-KR', fetchJson, '/locales', 'en'), 'en');
  assert.equal(t('greeting' as MessageKey), 'Hi');
  assert.equal(await initI18n('ko-KR', fetchJson, '/locales', 'fr'), 'ko');
  assert.equal(await initI18n('ko-KR', fetchJson, '/locales', null), 'ko');
});

test('FR-I18N-006 AC-3: the choice is stored per browser and "auto" clears it', () => {
  const store = new Map<string, string>();
  const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    writeLanguagePreference('en');
    assert.equal(store.get(LANGUAGE_PREFERENCE_STORAGE_KEY), 'en');
    assert.equal(readLanguagePreference(), 'en');
    writeLanguagePreference('auto');
    assert.equal(readLanguagePreference(), null);
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
