import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldInlineAsset } from '../../vite.assetInlining.ts';

test('a font is never inlined, because the CSP is font-src \'self\'', () => {
  for (const font of [
    'node_modules/katex/dist/fonts/KaTeX_Size3-Regular.woff2',
    '/abs/path/Inter.woff',
    'src/assets/Mono.ttf',
    'src/assets/Mono.otf',
    'legacy.eot',
    'UPPERCASE.WOFF2',
  ]) {
    assert.equal(shouldInlineAsset(font), false, font);
  }
});

test('everything else keeps Vite\'s inlining, so the fix costs no extra requests elsewhere', () => {
  for (const asset of [
    'src/assets/icon.svg',
    'src/assets/logo.png',
    'src/styles/theme.css',
    'fonts.css',
    'woff2-named-but-not-a-font.png',
  ]) {
    assert.equal(shouldInlineAsset(asset), true, asset);
  }
});
