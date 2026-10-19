// FR-ARCH-011 AC-6: the root layout containers must not size themselves with vh.
// iOS Safari resolves 100vh to the toolbar-collapsed height, so a body with
// min-height: 100vh was 100px taller than the visible viewport (measured on an
// iPhone: html 654, body 754) and hid the terminal's bottom rows behind the
// Safari toolbar whenever the on-screen keyboard was closed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// .auth-container fills #root on the login screen, so it is a root container too.
const ROOT_SELECTORS = new Set(['html', 'body', '#root', '.app', ':root', '.auth-container']);
const STYLESHEETS = ['../../src/index.css', '../../src/styles/globals.css', '../../src/components/Auth/Auth.css'];

function rootHeightDeclarations(css: string): string[] {
  const found: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map((selector) => selector.trim());
    if (!selectors.some((selector) => ROOT_SELECTORS.has(selector))) continue;
    for (const declaration of match[2].split(';')) {
      const [property, value] = declaration.split(':').map((part) => part?.trim() ?? '');
      if (/^(min-|max-)?height$/.test(property)) found.push(`${match[1].trim()} { ${property}: ${value} }`);
    }
  }
  return found;
}

test('FR-ARCH-011 AC-6: html, body, #root and .app heights use no vh units', () => {
  const offending: string[] = [];
  for (const sheet of STYLESHEETS) {
    const css = readFileSync(new URL(sheet, import.meta.url), 'utf8');
    for (const declaration of rootHeightDeclarations(css)) {
      if (/\d(l|s|d)?vh\b/.test(declaration)) offending.push(`${sheet}: ${declaration}`);
    }
  }
  assert.deepEqual(offending, []);
});

// AC-5 cannot be scrolled under jsdom, so this holds the conditions a touch
// swipe depends on: the strip overflows horizontally, and neither the strip nor
// its tabs turn browser panning off. The swipe itself was checked on an iPhone.
test('FR-ARCH-011 AC-5: the workspace tab bar stays horizontally scrollable by touch', () => {
  const css = readFileSync(new URL('../../src/components/Workspace/WorkspaceTabBar.css', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const tabbar = css.match(/\.workspace-tabbar\s*\{([^}]*)\}/);
  assert.ok(tabbar, '.workspace-tabbar rule exists');
  assert.match(tabbar[1], /overflow-x:\s*(auto|scroll)\s*;/);
  assert.doesNotMatch(css, /touch-action:\s*none/);

  const component = readFileSync(new URL('../../src/components/Workspace/WorkspaceTabBar.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(component, /touchAction|onTouchMove/);
});

test('FR-ARCH-011 AC-6: the root containers keep a 100% height chain', () => {
  const globals = readFileSync(new URL('../../src/styles/globals.css', import.meta.url), 'utf8');
  const declarations = rootHeightDeclarations(globals);
  assert.ok(declarations.some((d) => d.startsWith('html, body, #root') && d.endsWith('height: 100% }')), declarations.join('\n'));
  assert.ok(declarations.some((d) => d.startsWith('.app') && d.includes('var(--app-height, 100%)')), declarations.join('\n'));
});
