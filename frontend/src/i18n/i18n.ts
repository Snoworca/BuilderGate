/**
 * FR-I18N-002/004: one module-level translator. The language is fixed before
 * the first render (main.tsx) and never changes at runtime, so React context is
 * unnecessary and non-React modules may call t() — but only from code that runs
 * after module load (see i18nGuards.test.ts, guard 4).
 */
import { fill, type Params } from './catalog.ts';
import type { MessageKey, PluralKey } from './keys.ts';
import { pickLanguage } from './negotiate.ts';

export type { MessageKey, PluralKey } from './keys.ts';

const catalogs = new Map<string, Map<string, string>>();
let activeLang = 'en';
let active = new Map<string, string>();
const warned = new Set<string>();

export function installCatalog(lang: string, json: Readonly<Record<string, string>>): void {
  catalogs.set(lang, new Map(Object.entries(json)));
  activeLang = lang;
  active = catalogs.get(lang)!;
}

export function activeLanguage(): string {
  return activeLang;
}

function lookup(key: string, params?: Params): string {
  const template = active.get(key);
  if (template === undefined) {
    if (!warned.has(key)) {
      warned.add(key);
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  return fill(template, params);
}

export function t(key: MessageKey, params?: Params): string {
  return lookup(key, params);
}

export function tn(key: PluralKey, count: number, params?: Params): string {
  // The only place a key is composed: the plural category chosen by CLDR rules.
  return lookup(`${key}.${new Intl.PluralRules(activeLang).select(count)}`, { count, ...params });
}

interface LanguageManifest {
  default: string;
  languages: Record<string, string>;
}

type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
};

/**
 * Picks the language from the Settings choice or the browser, fetches only that catalog (retrying the
 * default once on failure) and installs it. On total failure the app still
 * renders — t() then shows key names.
 */
/** FR-I18N-006: the Settings language choice, kept per browser. Absent means "follow the browser". */
export const LANGUAGE_PREFERENCE_STORAGE_KEY = 'buildergate.language';

export function readLanguagePreference(): string | null {
  try {
    return globalThis.localStorage?.getItem(LANGUAGE_PREFERENCE_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Stores the choice ('auto' clears it). The caller reloads so the new catalog applies before render. */
export function writeLanguagePreference(value: string): void {
  try {
    if (value === 'auto') globalThis.localStorage?.removeItem(LANGUAGE_PREFERENCE_STORAGE_KEY);
    else globalThis.localStorage?.setItem(LANGUAGE_PREFERENCE_STORAGE_KEY, value);
  } catch {
    // Storage unavailable: the browser language keeps deciding.
  }
}

let supportedLanguages: Readonly<Record<string, string>> = { en: 'English' };

/** Languages from languages.json, as code → native name, for the Settings selector. */
export function availableLanguages(): Readonly<Record<string, string>> {
  return supportedLanguages;
}

export async function initI18n(
  browserLanguage: string | undefined,
  fetchJson: FetchJson = defaultFetchJson,
  base = '/locales',
  preference: string | null = readLanguagePreference(),
): Promise<string> {
  let manifest: LanguageManifest = { default: 'en', languages: { en: 'English' } };
  try {
    manifest = (await fetchJson(`${base}/languages.json`)) as LanguageManifest;
  } catch (error) {
    console.warn('[i18n] language list unavailable', error);
  }
  supportedLanguages = manifest.languages;
  const supported = new Set(Object.keys(manifest.languages));
  // FR-I18N-006: an explicit, still-supported choice wins over the browser language.
  const lang = preference && supported.has(preference)
    ? preference
    : pickLanguage(browserLanguage, supported, manifest.default);
  for (const candidate of lang === manifest.default ? [lang] : [lang, manifest.default]) {
    try {
      installCatalog(candidate, (await fetchJson(`${base}/messages.${candidate}.json`)) as Record<string, string>);
      return candidate;
    } catch (error) {
      console.warn(`[i18n] catalog ${candidate} unavailable`, error);
    }
  }
  return activeLang;
}
