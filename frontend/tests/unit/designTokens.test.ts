import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// CON-ARCH-001 — the design token contract.
//
// The repository has no DOM harness, so a token layer cannot be judged by
// rendering it. What can be judged is the declaration: whether every name the
// contract promises exists, whether the surface that re-binds them re-binds
// names that are actually there, and whether the file reaches the application
// at all. Those are the three ways this can be wrong without anyone noticing.
//
// The last one is the reason AC-9 exists. A token file that is never imported
// leaves every other assertion here passing while the screen is unchanged —
// a guard that approves and measures nothing.

/** Strips comments so prose about a token is never mistaken for a declaration. */
function css(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The contract, as design §10.2 states it. Held here rather than read out of
 * the stylesheet: a list derived from the file under test would agree with
 * whatever that file happens to say, including a typo.
 */
const CONTRACT = [
  '--bg-app', '--bg-chrome', '--bg-surface', '--bg-raised',
  '--bg-hover', '--bg-active', '--bg-paper',
  '--fg', '--fg-strong', '--fg-muted', '--fg-faint',
  '--line', '--line-strong',
  '--accent', '--accent-fg', '--sel-bar',
  '--danger', '--warn', '--ok',
  '--r-sm', '--r-md', '--r-lg',
  '--row-h',
] as const;

/** The subset whose value depends on the surface the component sits on. */
const SURFACE_DEPENDENT = [
  '--bg-surface', '--bg-raised', '--bg-hover', '--bg-active',
  '--fg', '--fg-strong', '--fg-muted', '--fg-faint',
  '--line', '--line-strong',
] as const;

/** Returns the body of the first block whose selector matches. */
function block(source: string, selector: string): string {
  const at = source.indexOf(selector);
  assert.notEqual(at, -1, `selector not found: ${selector}`);
  const open = source.indexOf('{', at);
  const close = source.indexOf('}', open);
  assert.ok(open !== -1 && close !== -1, `unterminated block: ${selector}`);
  return source.slice(open + 1, close);
}

/** Declared names inside one block, with their values. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

test('CON-ARCH-001 AC-1 every token the contract names is declared with a value', () => {
  const root = declarations(block(css('../../src/styles/tokens.css'), ':root'));

  const missing = CONTRACT.filter(name => !root.has(name));
  assert.deepEqual(missing, [], `tokens declared nowhere: ${missing.join(', ')}`);

  // A name with an empty value satisfies "is declared" and nothing else.
  const empty = CONTRACT.filter(name => (root.get(name) ?? '').length === 0);
  assert.deepEqual(empty, [], `tokens declared with no value: ${empty.join(', ')}`);
});

test('CON-ARCH-001 AC-2 the paper surface re-binds the surface-dependent tokens', () => {
  const source = css('../../src/styles/tokens.css');
  const paper = declarations(block(source, '[data-surface="paper"]'));

  const notRebound = SURFACE_DEPENDENT.filter(name => !paper.has(name));
  assert.deepEqual(notRebound, [], `paper surface leaves these at the chrome value: ${notRebound.join(', ')}`);

  // Re-binding to the same value would satisfy "is re-bound" while changing
  // nothing, which is the whole point of the surface.
  const root = declarations(block(source, ':root'));
  const unchanged = SURFACE_DEPENDENT.filter(name => paper.get(name) === root.get(name));
  assert.deepEqual(unchanged, [], `paper repeats the chrome value for: ${unchanged.join(', ')}`);
});

test('CON-ARCH-001 AC-11 the paper surface re-binds only names that exist', () => {
  // A typo here is silent: the declaration is valid CSS, nothing reads it, and
  // the component keeps the chrome value it was supposed to have left behind.
  const source = css('../../src/styles/tokens.css');
  const root = declarations(block(source, ':root'));
  const paper = declarations(block(source, '[data-surface="paper"]'));

  const dead = [...paper.keys()].filter(name => !root.has(name));
  assert.deepEqual(dead, [], `paper declares names absent from :root: ${dead.join(', ')}`);
});

test('CON-ARCH-001 AC-6 the row height is 28px, and the compact setting is 22px', () => {
  const source = css('../../src/styles/tokens.css');

  assert.equal(declarations(block(source, ':root')).get('--row-h'), '28px');
  assert.equal(declarations(block(source, '[data-density="compact"]')).get('--row-h'), '22px');
});

test('CON-ARCH-001 AC-7 the token layer does not reach into the vendored editor', () => {
  // The two palettes stay side by side. A reference in either direction makes
  // re-importing the vendored editor a merge instead of a copy.
  assert.ok(
    !/atomic-editor/.test(css('../../src/styles/tokens.css')),
    'tokens.css refers to --atomic-editor-*; design §10.4 keeps the two apart',
  );
});

test('CON-ARCH-001 AC-9 the application entry point actually loads the token layer', () => {
  // Without this every other assertion in this file passes over a stylesheet
  // the browser never sees.
  assert.match(
    css('../../src/index.css'),
    /@import\s+(url\()?['"]\.\/styles\/tokens\.css['"]\)?\s*;/,
    'index.css does not import ./styles/tokens.css',
  );
});

// The hygiene the single accent buys. Before this file the application carried
// three accent families — the two blues below, which nobody can tell apart on
// screen, and a violet set that belongs to the editor's syntax highlighting.
// Measured 2026-09-23: 146 distinct hex colours across 29 stylesheets.

/** The blues this layer replaces, and the violets that stay in the editor. */
const RETIRED_COLOURS = ['#007acc', '#0e639c', '#1177bb'] as const;
const EDITOR_ONLY_COLOURS = ['#7c3aed', '#8250df', '#a78bfa', '#6639ba'] as const;

test('CON-ARCH-001 AC-4 the accent is one colour, and the one it replaces is gone', () => {
  const source = css('../../src/styles/tokens.css');

  assert.equal(declarations(block(source, ':root')).get('--accent'), '#0078d4');

  const survivors = RETIRED_COLOURS.filter(hex => source.toLowerCase().includes(hex));
  assert.deepEqual(survivors, [], `retired accent still in the token layer: ${survivors.join(', ')}`);
});

test('CON-ARCH-001 AC-5 the violet family stays with the editor', () => {
  const source = css('../../src/styles/tokens.css').toLowerCase();

  const leaked = EDITOR_ONLY_COLOURS.filter(hex => source.includes(hex));
  assert.deepEqual(leaked, [], `editor syntax colours leaked into the UI layer: ${leaked.join(', ')}`);
});
