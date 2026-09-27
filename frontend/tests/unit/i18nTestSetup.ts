// Installs the Korean catalog for node tests that assert on user-visible text.
// Import it before (or alongside) the module under test; t() resolves at call time.
import { readFileSync } from 'node:fs';
import { installCatalog } from '../../src/i18n/i18n.ts';

const ko = JSON.parse(readFileSync(new URL('../../public/locales/messages.ko.json', import.meta.url), 'utf8')) as Record<string, string>;
installCatalog('ko', ko);

export const koCatalog: Readonly<Record<string, string>> = ko;
