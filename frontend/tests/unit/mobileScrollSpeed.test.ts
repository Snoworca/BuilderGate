import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MOBILE_SCROLL_SPEED_DEFAULT,
  MOBILE_SCROLL_SPEED_OPTIONS,
  clampMobileScrollSpeed,
  readMobileScrollSpeed,
  writeMobileScrollSpeed,
} from '../../src/utils/mobileScrollSettings.ts';
import { accumulatePanRows, mobilePanSpeed } from '../../src/utils/mobileTouchScroll.ts';

// FR-ARCH-015: a one-finger drag on a phone scrolled a full-screen program (Claude Code) too fast
// for the user (2026-10-28). A per-browser speed multiplies the drag before it becomes rows; the
// default stays 1 so nobody's scrolling changes until they choose to.

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

test('FR-ARCH-015 AC-1: with nothing stored the speed is 1', () => {
  assert.equal(MOBILE_SCROLL_SPEED_DEFAULT, 1);
  assert.equal(readMobileScrollSpeed(memoryStorage()), 1);
});

test('FR-ARCH-015 AC-1: at speed 1 a drag moves the rows it moved before', () => {
  // The old arithmetic: residual += delta; rows = trunc(residual / cell); residual -= rows * cell.
  const cell = 17;
  let residual = 0;
  let rows = 0;
  let oldResidual = 0;
  let oldRows = 0;
  for (const delta of [5, 9, 13, -2, 30, 4]) {
    const step = accumulatePanRows(residual, delta, 1, cell);
    residual = step.residualPx;
    rows += step.rows;
    oldResidual += delta;
    const r = Math.trunc(oldResidual / cell);
    oldResidual -= r * cell;
    oldRows += r;
  }
  assert.equal(rows, oldRows);
  assert.equal(residual, oldResidual);
});

test('FR-ARCH-015 AC-2: the drag is multiplied by the speed and the remainder carries over', () => {
  // 0.5: 40 px is 20 px of travel, one 17 px row with 3 px left.
  const half = accumulatePanRows(0, 40, 0.5, 17);
  assert.deepEqual(half, { rows: 1, residualPx: 3 });
  // A slow drag at a low speed still moves once the carried remainder reaches a row.
  let residual = 0;
  let rows = 0;
  for (let i = 0; i < 20; i += 1) {
    const step = accumulatePanRows(residual, 4, 0.25, 17);
    residual = step.residualPx;
    rows += step.rows;
  }
  assert.equal(rows, 1); // 20 * 4 * 0.25 = 20 px
  // 2: 34 px is 68 px of travel, four rows; upward drags give negative rows.
  assert.deepEqual(accumulatePanRows(0, 34, 2, 17), { rows: 4, residualPx: 0 });
  assert.deepEqual(accumulatePanRows(0, -34, 2, 17), { rows: -4, residualPx: 0 });
  // No measured cell height yet: nothing moves and the travel is kept.
  assert.deepEqual(accumulatePanRows(5, 10, 1, 0), { rows: 0, residualPx: 15 });
});

test('FR-ARCH-015 AC-2: only a full-screen program (the wheel route) is scaled; the scrollback follows the finger', () => {
  // 2026-10-28 user decision: the scrollback already moves one line per line dragged.
  for (const speed of [0.25, 0.5, 1, 2]) {
    assert.equal(mobilePanSpeed('scrollback', speed), 1);
    assert.equal(mobilePanSpeed('wheel', speed), speed);
  }
});

test('FR-ARCH-015 AC-3: the choices are 0.25 to 2 and a choice is stored in this browser', () => {
  assert.deepEqual([...MOBILE_SCROLL_SPEED_OPTIONS], [0.25, 0.5, 0.75, 1, 1.5, 2]);
  const storage = memoryStorage();
  writeMobileScrollSpeed(storage, 0.5);
  assert.equal(readMobileScrollSpeed(storage), 0.5);
});

test('FR-ARCH-015 AC-4: a bad or out-of-range value falls back or is clamped, and unreadable storage gives the default', () => {
  assert.equal(readMobileScrollSpeed(memoryStorage({ 'buildergate.mobileScroll.speed': 'fast' })), 1);
  assert.equal(readMobileScrollSpeed(memoryStorage({ 'buildergate.mobileScroll.speed': '9' })), 2);
  assert.equal(readMobileScrollSpeed(memoryStorage({ 'buildergate.mobileScroll.speed': '0.01' })), 0.25);
  assert.equal(clampMobileScrollSpeed(Number.NaN), 1);
  const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(readMobileScrollSpeed(throwing), 1);
  assert.doesNotThrow(() => writeMobileScrollSpeed(throwing, 0.5));
});

test('FR-ARCH-015 AC-2, AC-3: the terminal reads the speed when a drag starts and scales the drag by its route', () => {
  const source = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
  assert.match(source, /mobilePanSpeedRef\.current = readBrowserMobileScrollSpeed\(\)/);
  assert.match(source, /const route = routeMobilePan\(/);
  assert.match(source, /accumulatePanRows\(mobilePanResidualYRef\.current, deltaY, mobilePanSpeed\(route, mobilePanSpeedRef\.current\), cellHeight\)/);
  assert.match(source, /if \(route === 'wheel'\)/);
});

test('FR-ARCH-015 AC-3: the Settings page offers the speed and saves it in this browser', () => {
  const source = readFileSync(new URL('../../src/components/Settings/SettingsPage.tsx', import.meta.url), 'utf8');
  assert.match(source, /MOBILE_SCROLL_SPEED_OPTIONS\.map\(/);
  assert.match(source, /writeBrowserMobileScrollSpeed\(/);
  assert.match(source, /t\('settings\.mobileScroll\.speed'\)/);
});
