// FR-UIDS-011 (#148): on a phone the header's right-hand buttons ran past the
// screen edge (193 + 236 + 32 = 461 px on a 412 px phone), cutting off Log out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/components/Header/Header.css', import.meta.url), 'utf8');

function mediaBlock(maxWidth: number): string {
  const start = css.indexOf(`@media (max-width: ${maxWidth}px)`);
  assert.ok(start >= 0, `no @media (max-width: ${maxWidth}px) block`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') { depth -= 1; if (depth === 0) return css.slice(start, i + 1); }
  }
  throw new Error('unclosed media block');
}

function rule(block: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(block);
  assert.ok(match, `no rule for ${selector}`);
  return match[1];
}

test('FR-UIDS-011 AC-1: phone header hides the title, tightens padding and drops the button gap', () => {
  const phone = mediaBlock(767);
  assert.match(rule(phone, '.header-title'), /display:\s*none/u);
  assert.match(rule(phone, '.header '), /padding:\s*0 var\(--sp-2\)/u);
  assert.match(rule(phone, '.header-center'), /padding:\s*0;/u);
  assert.match(rule(phone, '.header-right'), /gap:\s*0;/u);
});

test('FR-UIDS-011 AC-2: buttons are 36 px on phones and 32 px at 340 px', () => {
  // 2026-10-20: 44 px boxes spread the icons too far apart on a phone (user report).
  const phone = rule(mediaBlock(767), '.header .icon-button-md');
  assert.match(phone, /width:\s*var\(--ctl-lg\)/u);
  assert.match(phone, /height:\s*var\(--ctl-lg\)/u);
  const at340 = rule(mediaBlock(340), '.header .icon-button-md');
  assert.match(at340, /width:\s*32px/u);
  assert.match(at340, /height:\s*32px/u);
});
