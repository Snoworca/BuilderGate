import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { PLURAL_CATEGORIES, pluralCategoriesFor } from '../../src/i18n/catalog.ts';

// NFR-I18N-001, FR-I18N-002 AC-4, FR-I18N-003 AC-1, FR-I18N-005 AC-1 — the five
// catalog guards of the i18n design (docs/research/2026-09-27.i18n.md §4).

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(FRONTEND, 'src');
const LOCALES = path.join(FRONTEND, 'public/locales');
const HANGUL = /[가-힣ㄱ-ㆎ]/;

const manifest = JSON.parse(readFileSync(path.join(LOCALES, 'languages.json'), 'utf8')) as {
  default: string;
  languages: Record<string, string>;
};
const catalogs = new Map<string, Record<string, string>>(
  Object.keys(manifest.languages).map((lang) => [
    lang,
    JSON.parse(readFileSync(path.join(LOCALES, `messages.${lang}.json`), 'utf8')) as Record<string, string>,
  ]),
);
const en = catalogs.get('en')!;

/** Plural bases are the keys whose `.other` form exists in en. */
const pluralBases = new Set(
  Object.keys(en).filter((k) => k.endsWith('.other')).map((k) => k.slice(0, -'.other'.length)),
);

function baseKey(key: string): string {
  const cut = key.lastIndexOf('.');
  const last = key.slice(cut + 1);
  const base = key.slice(0, cut);
  return (PLURAL_CATEGORIES as readonly string[]).includes(last) && pluralBases.has(base) ? base : key;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const parsed = sourceFiles(SRC).map((file) => ({
  rel: path.relative(FRONTEND, file).replaceAll('\\', '/'),
  sf: ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
}));

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function where(sf: ts.SourceFile, node: ts.Node, rel: string): string {
  return `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}

test('guard 1 (NFR-I18N-001 AC-1): every catalog has en\'s base keys and its own CLDR plural categories', () => {
  const enBases = new Set(Object.keys(en).map(baseKey));
  for (const [lang, catalog] of catalogs) {
    const bases = new Set(Object.keys(catalog).map(baseKey));
    assert.deepEqual([...bases].filter((k) => !enBases.has(k)), [], `${lang} has keys en lacks`);
    assert.deepEqual([...enBases].filter((k) => !bases.has(k)), [], `${lang} lacks keys en has`);
    const expected = pluralCategoriesFor(lang);
    for (const base of pluralBases) {
      const got = Object.keys(catalog).filter((k) => baseKey(k) === base && k !== base).map((k) => k.slice(base.length + 1)).sort();
      assert.deepEqual(got, expected, `${lang} ${base} plural categories`);
    }
  }
});

test('guard 2 (NFR-I18N-001 AC-2): every en key (plural families by base) is used as a literal in src', () => {
  const literals = new Set<string>();
  for (const { sf } of parsed) {
    walk(sf, (n) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) literals.add(n.text);
    });
  }
  const unused = [...new Set(Object.keys(en).map(baseKey))].filter((k) => !literals.has(k));
  assert.deepEqual(unused, [], 'dead catalog keys');
});

test('guard 3 (FR-I18N-003 AC-1): no Hangul in string, template, JSX text or regex literals under src', () => {
  const found: string[] = [];
  for (const { rel, sf } of parsed) {
    if (rel.startsWith('src/i18n/')) continue;
    walk(sf, (n) => {
      let text: string | undefined;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n)) text = n.text;
      else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) text = n.text;
      else if (ts.isRegularExpressionLiteral(n)) text = n.text;
      if (text === undefined || !HANGUL.test(text)) return;
      // The one allowed range: the Hangul detector itself.
      if (rel === 'src/components/ui/uiClasses.ts' && ts.isRegularExpressionLiteral(n)) return;
      found.push(`${where(sf, n, rel)} ${text.trim().slice(0, 40)}`);
    });
  }
  assert.deepEqual(found, []);
});

// Callbacks these callees receive run later, not during module load.
const DEFERRED_CALLEES = new Set(['forwardRef', 'memo', 'lazy', 'addEventListener', 'of', 'setTimeout', 'queueMicrotask', 'then']);

function calleeName(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return '';
}

/** True when `fn` runs while its module loads: an IIFE or a callback handed to a call, at module scope. */
function runsAtLoad(fn: ts.Node): boolean {
  let parent = fn.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  const isIife = parent.expression === fn || (ts.isParenthesizedExpression(parent.expression) && parent.expression.expression === fn);
  if (!isIife && DEFERRED_CALLEES.has(calleeName(parent))) return false;
  return true;
}

test('guard 4 (FR-I18N-002 AC-4): t()/tn() are never evaluated during module load', () => {
  const found: string[] = [];
  for (const { rel, sf } of parsed) {
    if (rel.startsWith('src/i18n/')) continue;
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || !['t', 'tn'].includes(n.expression.text)) return;
      let node: ts.Node = n;
      let atLoad = true;
      while (node.parent && !ts.isSourceFile(node.parent)) {
        node = node.parent;
        if (ts.isFunctionLike(node) && !runsAtLoad(node)) {
          atLoad = false;
          break;
        }
      }
      if (atLoad) found.push(where(sf, n, rel));
    });
  }
  assert.deepEqual(found, []);
});

test('NFR-I18N-001: every catalog value is a non-empty string (a null renders as the key name)', () => {
  for (const [lang, catalog] of catalogs) {
    const bad = Object.entries(catalog).filter(([, v]) => typeof v !== 'string' || v.trim() === '').map(([k]) => k);
    assert.deepEqual(bad, [], `${lang} has non-string or empty values`);
  }
});

test('guard 5 (NFR-I18N-001 AC-4): no Hangul left in English values', () => {
  const korean = Object.entries(en).filter(([, v]) => HANGUL.test(v)).map(([k]) => k);
  assert.deepEqual(korean, []);
});

test('FR-I18N-005 AC-1: the ko catalog writes Workspace, never the transliteration', () => {
  const ko = catalogs.get('ko')!;
  const transliterated = Object.entries(ko).filter(([, v]) => v.includes('워크스페이스')).map(([k]) => k);
  assert.deepEqual(transliterated, []);
});
