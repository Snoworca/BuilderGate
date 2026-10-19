import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { renderMissingWebRootPage } from './missingWebRootPage.js';

// OPS-BGSTAB-023 (#149): a missing index.html used to fall through to Express's
// bare "Not Found", which said nothing about where the server had looked.

test('OPS-BGSTAB-023 AC-2: a loopback request sees the escaped path that was checked', () => {
  const html = renderMissingWebRootPage('/Applications/Builder<Gate>.app/web/index.html', true);
  assert.match(html, /<!doctype html>/iu);
  assert.match(html, /\/Applications\/Builder&lt;Gate&gt;\.app\/web\/index\.html/u);
  assert.doesNotMatch(html, /Builder<Gate>/u);
});

test('OPS-BGSTAB-023 AC-2: a remote request gets no path, only a pointer to the server log', () => {
  const html = renderMissingWebRootPage('/secret/install/web/index.html', false);
  assert.doesNotMatch(html, /secret/u);
  assert.match(html, /server log/iu);
});

test('OPS-BGSTAB-023 AC-1 AC-3: the HTML fallback answers 503 with the page and logs the path', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('res.sendFile(PRODUCTION_INDEX_HTML');
  const block = source.slice(start, source.indexOf('console.log(`[Static] Production assets served from', start));
  assert.match(block, /status\(503\)/u);
  assert.match(block, /renderMissingWebRootPage\(PRODUCTION_INDEX_HTML,\s*isLoopbackSocketAddress\(req\.socket\.remoteAddress\)\)/u);
  assert.match(block, /console\.warn\(`\[Static\] Production index not found at \$\{PRODUCTION_INDEX_HTML\}`\)/u);
});
