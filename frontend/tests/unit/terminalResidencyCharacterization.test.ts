import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * OBS-BGSTAB-010 AC-3 and AC-4 (issue #17).
 *
 * These pin two present-tense facts about residency so that if either changes,
 * it changes visibly rather than silently. Neither asserts that the current
 * behaviour is correct — the requirement's whole point is that the measurement
 * comes before the decision, and these guards exist so the thing being measured
 * does not move underneath the measurement.
 */

const SOURCE = fileURLToPath(
  new URL('../../src/hooks/useTerminalRuntimeResidency.ts', import.meta.url),
);

function source(): string {
  return readFileSync(SOURCE, 'utf8');
}

test('OBS-BGSTAB-010 AC-3 the residency decision consults no snapshot availability', () => {
  const signature = 'OBS-BGSTAB-010 AC-3: evicting a session that cannot be restored is the second '
    + 'defect issue #17 names, so the absence of any snapshot check must be visible when it changes';
  const text = source();

  // The decision path reads pinned status, hidden TTL, the live-terminal budget
  // and the workspace cap. It reads nothing about whether a snapshot exists to
  // restore the session from.
  const decisionInputs = ['pinnedTabIds', 'hiddenSince', 'hiddenRuntimeTtlMs', 'maxLiveTerminals', 'maxLiveWorkspaces'];
  for (const input of decisionInputs) {
    assert.ok(text.includes(input), `${signature} — expected decision input ${input} to still be read`);
  }

  // `hiddenRecovery` carries an 'authoritative-checkpoint-applied' outcome, but
  // it only decorates an already-computed result. Any OTHER snapshot or
  // checkpoint reference would mean the decision itself started consulting
  // restorability, which is the change this guard exists to surface.
  const restorabilityMentions = [...text.matchAll(/\b\w*(?:snapshot|checkpoint)\w*\b/gi)]
    .map(match => match[0])
    // Two names contain a restorability word without being about restorability:
    // the hiddenRecovery outcome literal, and TerminalRuntimeResidencyPolicySnapshot,
    // which is a snapshot OF THE POLICY (counts and limits before/after) and says
    // nothing about whether a session can be restored.
    .filter(name => !/^authoritative-checkpoint-applied$/i.test(name))
    .filter(name => !/^TerminalRuntimeResidencyPolicySnapshot$/i.test(name));
  const distinct = [...new Set(restorabilityMentions.map(name => name.toLowerCase()))].sort();

  assert.deepEqual(
    distinct,
    ['checkpoint'],
    `${signature} — the only restorability token expected is the 'checkpoint' inside the `
      + `hiddenRecovery outcome literal, which decorates the result rather than deciding it. `
      + `Found: ${distinct.join(', ')}`,
  );
});

test('OBS-BGSTAB-010 AC-4 the lifecycle metric is a pinned constant, not a measurement', () => {
  const signature = 'OBS-BGSTAB-010 AC-4: no policy decision may rest on this value while it is a stub';
  const text = source();

  // Pinned in the TYPE as literals, not merely assigned as values — so the
  // compiler refuses any other value and the stub cannot start carrying data
  // without that showing up as a type change.
  assert.match(
    text,
    /warmRuntimeDelta:\s*0;/,
    `${signature} — warmRuntimeDelta must remain pinned to the literal type 0`,
  );
  assert.match(text, /suspended:\s*false;/, signature);
  assert.match(text, /disposed:\s*false;/, signature);

  // And constructed as those same constants, with nothing computed.
  assert.match(
    text,
    /lifecycle:\s*\{\s*warmRuntimeDelta:\s*0,\s*suspended:\s*false,\s*disposed:\s*false,\s*\}/,
    `${signature} — the runtime value must stay a literal; if it ever becomes computed, this `
      + 'guard should fail so the measurement is redone against real numbers',
  );
});
