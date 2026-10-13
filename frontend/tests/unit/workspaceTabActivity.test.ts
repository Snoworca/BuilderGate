import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { workspaceTabClassName } from '../../src/components/Workspace/workspaceTabClass.ts';

// FR-UIDS-009. In tab mode only the sidebar dot told that a workspace was busy; the tab bar did
// not show which tab's session was working.

const base = { isActive: false, isDragging: false, isDropTarget: false };

test('FR-UIDS-009 AC-1 a running tab carries the activity marker', () => {
  assert.equal(workspaceTabClassName({ ...base, status: 'running' }).split(' ').includes('is-running'), true);
});

test('FR-UIDS-009 AC-1 an idle or disconnected tab does not', () => {
  for (const status of ['idle', 'disconnected'] as const) {
    assert.equal(workspaceTabClassName({ ...base, status }).split(' ').includes('is-running'), false, status);
  }
});

test('FR-UIDS-009 the existing tab states are kept', () => {
  assert.equal(
    workspaceTabClassName({ isActive: true, isDragging: true, isDropTarget: true, status: 'idle' }),
    'workspace-tab is-active is-dragging is-drop-target',
  );
  assert.equal(workspaceTabClassName({ ...base, status: 'idle' }), 'workspace-tab');
});

const css = readFileSync(new URL('../../src/components/Workspace/WorkspaceTabBar.css', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing rule ${selector}`);
  return css.slice(start, css.indexOf('}', start) + 1);
}

function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name}`);
  assert.notEqual(start, -1, `missing @keyframes ${name}`);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  assert.fail('unbalanced keyframes');
}

test('FR-UIDS-009 AC-2 the band sits on the color bar, about 10% wide and brighter', () => {
  const band = block('.workspace-tab.is-running::after');
  assert.match(band, /width:\s*10%/);
  assert.match(band, /top:\s*-2px/);
  assert.match(band, /height:\s*2px/);
  assert.match(band, /background:[^;]*var\(--tab-color/);
  assert.match(band, /background:[^;]*white/, 'the band is the tab colour mixed toward white');
  assert.match(band, /animation:\s*workspace-tab-activity\b[^;]*infinite[^;]*alternate/);
});

test('FR-UIDS-009 AC-3 the band animates only transform and opacity', () => {
  const frames = keyframes('workspace-tab-activity');
  const properties = [...frames.matchAll(/([a-z-]+)\s*:/g)].map(match => match[1]);
  assert.ok(properties.length > 0);
  for (const property of properties) {
    assert.ok(property === 'transform' || property === 'opacity', `animates ${property}`);
  }
});

test('FR-UIDS-009 AC-4 reduced motion stops the band and brightens the bar instead', () => {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.notEqual(start, -1, 'a reduced-motion rule is required');
  const media = css.slice(start, css.indexOf('\n}', start) + 2);
  assert.match(media, /\.workspace-tab\.is-running::after\s*{[^}]*animation:\s*none/);
  assert.match(media, /\.workspace-tab\.is-running\s*{[^}]*border-top-color:\s*var\(--tab-color/);
});

test('FR-UIDS-009 AC-1 the tab bar derives the marker from the tab status', () => {
  const source = readFileSync(new URL('../../src/components/Workspace/WorkspaceTabBar.tsx', import.meta.url), 'utf8');
  assert.match(source, /workspaceTabClassName\(\{[^}]*status:\s*tab\.status/);
});
