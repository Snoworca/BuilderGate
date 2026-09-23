import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// CON-ARCH-001 — the design token contract.
//
// The repository has no DOM harness, so a token layer cannot be judged by
// rendering it. What can be judged is the declaration: whether every name the
// contract promises exists, whether the names written down — declared and
// referenced alike — are names that exist, whether the values a second surface
// binds are different in the direction that surface is for, and whether the
// file reaches the application at all.
//
// The last is the reason AC-9 exists. A token file that is never imported
// leaves every other assertion here passing while the screen is unchanged —
// a guard that approves and measures nothing.
//
// Two of the others are here because they once were that guard. Comparing
// re-bound values as text passed a paper surface flipped dark and a paper
// foreground set to the chrome grey in capitals; reading only the declared
// names on the paper block passed `var(--acent)`. Both were measured against
// this file on 2026-09-23, and the luminance and var() checks below are what
// those mutations now fail.

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
  assert.notEqual(open, -1, `unterminated block: ${selector}`);
  // Matched by depth, not by the next '}': a nested block (an @media or @supports
  // inside the selector's body) would otherwise end the slice at its own brace.
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  assert.fail(`unterminated block: ${selector}`);
}

/** Declared names inside one block, with their values. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

/**
 * Puts a value in one shape, so two spellings of one colour compare equal.
 *
 * The check below asks whether the paper surface changed anything. Compared as
 * written it answers yes for `#DCDCDC` against `#dcdcdc` — the same colour,
 * typed differently, and on white paper that is text nobody can read.
 */
function normalise(value: string): string {
  const flat = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(flat);
  return short ? `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}` : flat;
}

/** Relative luminance of a hex colour, as WCAG 2 defines it. */
function luminance(hex: string): number {
  const full = normalise(hex);
  assert.match(full, /^#[0-9a-f]{6}$/, `not a hex colour, so it has no luminance here: ${hex}`);

  const channel = (at: number): number => {
    const c = Number.parseInt(full.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };

  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Contrast ratio, from 1 (one colour twice) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2 AA: 4.5:1 for body text, 3:1 for large text and interface parts. */
const BODY_CONTRAST = 4.5;
const MUTED_CONTRAST = 3;

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
  // nothing, which is the whole point of the surface. Normalised first,
  // because `#DCDCDC` and `#dcdcdc` are one colour however they are typed and
  // a comparison of the text says otherwise.
  const root = declarations(block(source, ':root'));
  const unchanged = SURFACE_DEPENDENT.filter(
    name => normalise(paper.get(name)!) === normalise(root.get(name)!),
  );
  assert.deepEqual(unchanged, [], `paper repeats the chrome value for: ${unchanged.join(', ')}`);
});

test('CON-ARCH-001 AC-2 paper is the lighter surface, and its text is readable on it', () => {
  // Unequal is the cheapest thing "re-bound" can mean, and most unequal values
  // are wrong: paper re-bound darker satisfies it, and so does paper text left
  // at the chrome grey, which on white is a hair from invisible. What paper
  // has to be is lighter, and what its text has to be is readable against it.
  const source = css('../../src/styles/tokens.css');
  const root = declarations(block(source, ':root'));
  const paper = declarations(block(source, '[data-surface="paper"]'));

  for (const name of ['--bg-surface', '--bg-raised'] as const) {
    assert.ok(
      luminance(paper.get(name)!) > luminance(root.get(name)!),
      `${name}: paper ${paper.get(name)} is not lighter than chrome ${root.get(name)}`,
    );
  }

  const legibility = [
    ['--fg', BODY_CONTRAST],
    ['--fg-strong', BODY_CONTRAST],
    ['--fg-muted', MUTED_CONTRAST],
  ] as const;

  // Both surfaces. The paper block is what this AC is about, but a token layer
  // that makes one surface readable by ruining the other has not done the job.
  for (const [surface, tokens] of [['paper', paper], ['chrome', root]] as const) {
    const background = tokens.get('--bg-surface')!;

    for (const [name, floor] of legibility) {
      const ratio = contrast(tokens.get(name)!, background);
      assert.ok(
        ratio >= floor,
        `${surface} ${name} ${tokens.get(name)} on ${background} is ${ratio.toFixed(2)}:1, under ${floor}:1`,
      );
    }
  }
});

test('CON-ARCH-001 AC-11 every name declared and every name referenced exists', () => {
  // A typo is silent either way round: the CSS stays valid, the reference just
  // resolves to nothing, and the component keeps whatever it already had. The
  // two halves catch different typos and neither covers the other — one is a
  // re-binding of a name :root never declared, the other a var() pointing at a
  // name nothing declares anywhere.
  const source = css('../../src/styles/tokens.css');
  const root = declarations(block(source, ':root'));
  const paper = declarations(block(source, '[data-surface="paper"]'));

  const dead = [...paper.keys()].filter(name => !root.has(name));
  assert.deepEqual(dead, [], `paper declares names absent from :root: ${dead.join(', ')}`);

  // Declared anywhere in the file, not only under :root — [data-density] and
  // the paper block declare names too, and pointing at one of those is fine.
  const declared = new Set(declarations(source).keys());
  const referenced = [...source.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map(m => m[1]);

  // Without this the scan passes by finding nothing, which is exactly what it
  // would do if the pattern stopped matching how the file is written.
  assert.ok(referenced.length > 0, 'no var() reference found at all; this half measures nothing');

  const missing = [...new Set(referenced)].filter(name => !declared.has(name));
  assert.deepEqual(missing, [], `var() points at names nothing declares: ${missing.join(', ')}`);
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
  const indexCss = css('../../src/index.css');
  assert.match(
    indexCss,
    /@import\s+(url\()?['"]\.\/styles\/tokens\.css['"]\)?\s*;/,
    'index.css does not import ./styles/tokens.css',
  );
  // First statement, not merely present: a browser drops an @import that follows
  // any other rule, silently, and every assertion above would still pass.
  assert.match(
    indexCss.trimStart(),
    /^@import\s+(url\()?['"]\.\/styles\/tokens\.css['"]\)?\s*;/,
    'the tokens @import is not the first statement of index.css, so the browser ignores it',
  );
  // And index.css is itself on the entry point's import list. The chain is
  // main.tsx -> index.css -> tokens.css; this pins the first link.
  const entry = readFileSync(new URL('../../src/main.tsx', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.match(
    entry,
    /^\s*import\s+['"]\.\/index\.css['"]\s*;?\s*$/m,
    'main.tsx does not import ./index.css',
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
