// FR-UIDS-015: a phone turned to landscape keeps the mobile layout. One media query decides the
// layout; the hook reads it and every stylesheet rule that switches layouts repeats it exactly.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MOBILE_LAYOUT_QUERY } from '../../src/utils/layoutMode.ts';

const SRC = new URL('../../src/', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, SRC), 'utf8');

function cssFiles(rel = ''): string[] {
  return readdirSync(new URL(rel, SRC), { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : cssFiles(`${rel}${entry.name}/`);
    return entry.name.endsWith('.css') ? [`${rel}${entry.name}`] : [];
  });
}

// @req FR-UIDS-015
test('FR-UIDS-015 AC-1/AC-2: narrow screens, or a touch screen at most 500 px high', () => {
  assert.equal(MOBILE_LAYOUT_QUERY, '(max-width: 767px), (pointer: coarse) and (max-height: 500px)');
});

// @req FR-UIDS-015
test('FR-UIDS-015 AC-3/AC-4: the hook follows the query, at mount and on every change', () => {
  const hook = read('hooks/useResponsive.ts');
  assert.match(hook, /matchMedia\(MOBILE_LAYOUT_QUERY\)/);
  assert.doesNotMatch(hook, /innerWidth/);
  assert.match(read('components/Git/GitWindow.tsx'), /MOBILE_LAYOUT_QUERY/, 'the Git window follows the app layout');
});

// @req FR-UIDS-015
test('FR-UIDS-015 AC-3: every layout media rule in the stylesheets is the same query', () => {
  const found: string[] = [];
  for (const rel of cssFiles()) {
    for (const match of read(rel).matchAll(/@media\s*([^{]*)\{/g)) {
      const query = match[1].trim();
      if (/max-width:\s*76[78]px/.test(query)) found.push(`${rel}: ${query}`);
    }
  }
  assert.ok(found.length >= 5, `found ${found.length}`);
  for (const entry of found) assert.ok(entry.endsWith(`: ${MOBILE_LAYOUT_QUERY}`), entry);
});
