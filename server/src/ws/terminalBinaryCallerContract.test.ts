import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * SDS-AC-8 (FR-BGSTAB-024 AC-1, IR-BGSTAB-001 AC-4): static caller contract.
 * Comments are blanked first — a guard that reads prose as code fired twice on
 * 2026-09-21 (OPS-BGSTAB-011); the same discipline applies here.
 */
function blankComments(src: string): string {
  let out = '', st: string = 'code';
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; out += '  '; i++; continue; }
      if (c === '/' && n === '*') { st = 'block'; out += '  '; i++; continue; }
      if (c === "'" || c === '"' || c === '`') st = c;
      out += c; continue;
    }
    if (st === 'line') { if (c === '\n') { st = 'code'; out += c; } else out += ' '; continue; }
    if (st === 'block') { if (c === '*' && n === '/') { st = 'code'; out += '  '; i++; } else out += c === '\n' ? '\n' : ' '; continue; }
    if (c === '\\') { out += c + (n ?? ''); i++; continue; }
    if (c === st) st = 'code';
    out += c;
  }
  return out;
}

const router = blankComments(readFileSync(new URL('./WsRouter.ts', import.meta.url), 'utf8'));
const policy = blankComments(readFileSync(new URL('./wsSendPolicy.ts', import.meta.url), 'utf8'));

test('SDS-AC-8 every terminal-payload createWsTransportMessage call in WsRouter goes through transportCodecFor', () => {
  const calls = [...router.matchAll(/createWsTransportMessage\(/g)].length;
  const routed = [...router.matchAll(/createWsTransportMessage\([^;]*?this\.transportCodecFor\(/gs)].length;
  assert.ok(calls > 0);
  assert.equal(calls - routed, 0, `${calls - routed} createWsTransportMessage call(s) bypass transportCodecFor`);
});

test('SDS-AC-8 coalescing in wsSendPolicy re-encodes with the caller-supplied codec, never bare', () => {
  const inCoalesce = policy.slice(policy.indexOf('function tryCoalesceOutputMessage'));
  const body = inCoalesce.slice(0, inCoalesce.indexOf('\nfunction ', 10));
  assert.match(body, /createWsTransportMessage\([\s\S]*?codecFor\(/, 'merged message must be rebuilt with codecFor');
});

test('SDS-AC-8 no production rollback path bypasses rollbackTerminalBinaryGroup', () => {
  // The four triggers call the one function; nothing else bumps codecEpoch or retires all channels.
  const bumps = [...router.matchAll(/\.(bumpCodecEpoch|retireAllChannels)\(/g)].length;
  const inRollback = router.slice(router.indexOf('rollbackTerminalBinaryGroup('), router.indexOf('rollbackTerminalBinaryGroup(') + 4000);
  const insideBumps = [...inRollback.matchAll(/\.(bumpCodecEpoch|retireAllChannels)\(/g)].length;
  assert.ok(router.includes('rollbackTerminalBinaryGroup('), 'the single rollback function must exist');
  assert.equal(bumps, insideBumps, 'codecEpoch/channel teardown must happen only inside the rollback function');
});
