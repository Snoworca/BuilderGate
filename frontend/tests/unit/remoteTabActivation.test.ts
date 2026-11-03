// REL-BGSTAB-058 AC-9: the active tab is shared. A phone switching tabs switches the desktop
// showing the same workspace too, and that desktop terminal coming back into view resent its
// size and nudged the program, taking the PTY back from the phone the user was holding.
// Measured 2026-10-31 on https://localhost:2222 with a desktop page and an iPhone-sized page:
// 12 ms after the phone's reveal resend, the idle desktop sent 90x22 and a 90x21/90x22 nudge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRemoteTabActivations } from '../../src/components/Terminal/remoteTabActivation.ts';

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test('REL-BGSTAB-058 AC-9: a session another screen just activated reads as revealed remotely', () => {
  const time = clock();
  const activations = createRemoteTabActivations({ windowMs: 2_000, now: time.now });
  activations.mark('session-a');
  assert.equal(activations.isRemote('session-a'), true);
  assert.equal(activations.isRemote('session-b'), false, 'other sessions are not affected');
});

test('REL-BGSTAB-058 AC-9: the mark lapses, so a later reveal is this screen\'s own', () => {
  const time = clock();
  const activations = createRemoteTabActivations({ windowMs: 2_000, now: time.now });
  activations.mark('session-a');
  time.advance(2_001);
  assert.equal(activations.isRemote('session-a'), false);
});

test('REL-BGSTAB-058 AC-9: choosing the tab on this screen clears the mark', () => {
  const time = clock();
  const activations = createRemoteTabActivations({ windowMs: 2_000, now: time.now });
  activations.mark('session-a');
  activations.clear('session-a');
  assert.equal(activations.isRemote('session-a'), false);
});

const managerSource = readFileSync(new URL('../../src/hooks/useWorkspaceManager.ts', import.meta.url), 'utf8');
const containerSource = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');

function sliceFrom(source: string, marker: string, end: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} is in the source`);
  return source.slice(start, source.indexOf(end, start));
}

test('REL-BGSTAB-058 AC-9: an active tab arriving from another screen is marked, one chosen here is cleared', () => {
  const updated = sliceFrom(managerSource, "'workspace:updated': (data) => {", '\n      },');
  assert.ok(updated.includes('remoteTabActivations.mark('), 'the broadcast marks the session it shows');
  const setActive = sliceFrom(managerSource, 'const setActiveTab = useCallback(', '}, [');
  assert.ok(setActive.includes('remoteTabActivations.clear('), 'a local choice is not taken for a remote one');
});

test('REL-BGSTAB-058 AC-9: a terminal shown by another screen\'s tab switch neither resends its size nor nudges', () => {
  const resend = sliceFrom(containerSource, 'const previousVisibleForResizeRef = useRef(isVisible);', '}, [isVisible');
  const remote = resend.indexOf('remoteTabActivations.isRemote(sessionId)');
  const sent = resend.indexOf("'reveal-resend'");
  assert.ok(remote > 0 && sent > remote, 'the reveal resend asks first');
  const surface = sliceFrom(containerSource, 'const nextSurface = isVisible', '}, [isGridSurface');
  const asked = surface.indexOf('remoteTabActivations.isRemote(sessionId)');
  const scheduled = surface.indexOf("runGridLayoutRepair('workspace')");
  assert.ok(asked > 0 && scheduled > asked, 'the reveal repair asks first');
});

test('REL-BGSTAB-058 AC-9: the delayed redraw after a tab switch skips a switch another screen made', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  const effect = sliceFrom(app, 'const previousAutoRedrawRef = useRef(', '}, [autoRedrawWorkspaceId');
  const asked = effect.indexOf('remoteTabActivations.isRemote(');
  const scheduled = effect.indexOf("'if-resized-elsewhere')");
  assert.ok(asked > 0 && scheduled > asked, 'the tab-switch redraw asks first');
});
