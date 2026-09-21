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

/**
 * The control plane stays on JSON by contract (IR-BGSTAB-001 AC-5), so these two
 * sites must NOT take a codec. They are named rather than counted: a third
 * bypass has to be added to this list deliberately, which is the point.
 */
const CONTROL_PLANE_EXEMPT = [
  'routeTerminalAuthorityFrame',
  'sendPriorityControl',
] as const;

test('SDS-AC-8 every terminal-payload createWsTransportMessage call in WsRouter goes through transportCodecFor', () => {
  const sites = [...router.matchAll(/createWsTransportMessage\(/g)];
  assert.ok(sites.length >= 4, `only ${sites.length} call sites found — the scan is vacuous`);

  // A line that opens a block, not any `name(`: `if (` and `for (` are not
  // enclosing functions, and the line holding the call is truncated at the match
  // so it must not be read as a declaration of itself.
  const DECLARATION = /^[ \t]*(?:export\s+)?(?:private|public|protected)?\s*(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_]\w*)\s*\(.*\{\s*$/;
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'do']);
  const enclosingName = (index: number): string => {
    const lines = router.slice(0, index).split('\n');
    for (let i = lines.length - 2; i >= 0; i -= 1) {
      const name = DECLARATION.exec(lines[i])?.[1];
      if (name && !KEYWORDS.has(name)) return name;
    }
    return 'unknown';
  };

  const bypassing = sites
    .filter(match => !/this\.transportCodecFor\(/.test(router.slice(match.index, match.index + 900).split(';')[0]))
    .map(match => enclosingName(match.index));

  const unexpected = bypassing.filter(name => !CONTROL_PLANE_EXEMPT.includes(name as never));
  assert.deepEqual(unexpected, [], `send sites bypassing transportCodecFor: ${unexpected.join(', ')}`);
  for (const name of CONTROL_PLANE_EXEMPT) {
    assert.ok(router.includes(name), `exempt site ${name} no longer exists — remove it from the list`);
  }
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
