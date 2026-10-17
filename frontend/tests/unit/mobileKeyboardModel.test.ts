// FR-MKB-008..011: the pure part of the mobile keyboard — panel tables, the
// right-block preference, the panel height, the drag threshold, the bar
// visibility rule and the switch's focus hand-over. Runs under
// test:unit:mobile-keyboard (plain node, no DOM, no asset stubs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_SPECIAL_PANEL_HEIGHT,
  RIGHT_BLOCK_STORAGE_KEY,
  SPECIAL_ARROW_BLOCK,
  SPECIAL_LEFT_BLOCK,
  SPECIAL_MIDDLE_BLOCK,
  SPECIAL_NUMPAD_BLOCK,
  SPECIAL_TOP_ROW,
  applySpecialKeyboardToggle,
  isDragBeyond,
  readRightBlock,
  shouldShowMobileKeyBar,
  specialPanelHeight,
  writeRightBlock,
  type SpecialKeyEntry,
} from '../../src/components/MobileKeyboard/mobileKeyboardModel.ts';

/** One readable cap per cell: the label, `(blank)` for the empty centre, `<switch:to>` for a block switch. */
function caps(rows: readonly (readonly SpecialKeyEntry[])[]): string[][] {
  return rows.map(row => row.map((entry) => {
    if (entry.kind === 'blank') return '(blank)';
    if (entry.kind === 'switch') return `<switch:${entry.to}>`;
    return entry.label;
  }));
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => { data.delete(key); },
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

function throwingStorage(): Storage {
  const fail = (): never => { throw new Error('storage blocked'); };
  return {
    get length(): number { return fail(); },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  };
}

// --- Panel tables -------------------------------------------------------------

test('FR-MKB-009 AC-1 / SDS-AC-6: the top row is Esc, Tab, Ctrl, Alt, Shift and only the three modifiers lock', () => {
  assert.deepEqual(SPECIAL_TOP_ROW.map(e => (e.kind === 'key' || e.kind === 'mod' ? e.label : e.kind)), ['Esc', 'Tab', 'Ctrl', 'Alt', 'Shift']);
  assert.deepEqual(SPECIAL_TOP_ROW.filter(e => e.kind === 'mod').map(e => (e.kind === 'mod' ? e.mod : '')), ['ctrl', 'alt', 'shift']);
});

test('FR-MKB-009 AC-2 / SDS-AC-6: the left block is F1..F12 in four rows of three', () => {
  assert.deepEqual(caps(SPECIAL_LEFT_BLOCK), [
    ['F1', 'F2', 'F3'], ['F4', 'F5', 'F6'], ['F7', 'F8', 'F9'], ['F10', 'F11', 'F12'],
  ]);
});

test('FR-MKB-009 AC-3 / SDS-AC-6: the middle block is Backspace / | ~ * - ` : + _ = Enter', () => {
  assert.deepEqual(caps(SPECIAL_MIDDLE_BLOCK), [
    ['⌫', '/', '|'], ['~', '*', '-'], ['`', ':', '+'], ['_', '=', 'Enter'],
  ]);
  const first = SPECIAL_MIDDLE_BLOCK[0][0];
  assert.ok(first.kind === 'key' && first.key === 'Backspace', 'the erase cap sends Backspace');
  const enter = SPECIAL_MIDDLE_BLOCK[3][2];
  assert.ok(enter.kind === 'key' && enter.key === 'Enter');
});

test('FR-MKB-009 AC-4 / SDS-AC-6: the arrow block is Home Up PgUp / Left (blank) Right / End Down PgDn / Ins Del Numpad, arrows marked', () => {
  assert.deepEqual(caps(SPECIAL_ARROW_BLOCK), [
    ['Home', '↑', 'PgUp'], ['←', '(blank)', '→'], ['End', '↓', 'PgDn'], ['Ins', 'Del', '<switch:numpad>'],
  ]);
  const arrows = SPECIAL_ARROW_BLOCK.flat().filter(e => e.kind === 'key' && e.variant === 'arrow').map(e => (e.kind === 'key' ? e.key : ''));
  assert.deepEqual(arrows.sort(), ['Down', 'Left', 'Right', 'Up']);
  const names = SPECIAL_ARROW_BLOCK.flat().filter(e => e.kind === 'key').map(e => (e.kind === 'key' ? e.key : ''));
  assert.deepEqual(names, ['Home', 'Up', 'PageUp', 'Left', 'Right', 'End', 'Down', 'PageDown', 'Insert', 'Delete']);
});

test('FR-MKB-010 AC-1 AC-3 / SDS-AC-8: the numpad block is 7 8 9 / 4 5 6 / 1 2 3 / 0 . Arrows and sends plain characters', () => {
  assert.deepEqual(caps(SPECIAL_NUMPAD_BLOCK), [
    ['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3'], ['0', '.', '<switch:arrows>'],
  ]);
  for (const entry of SPECIAL_NUMPAD_BLOCK.flat()) {
    if (entry.kind !== 'key') continue;
    assert.equal(entry.key, entry.label, `${entry.label} is sent as the plain character`);
    assert.equal(entry.key.length, 1);
  }
});

test('FR-MKB-009 AC-6 AC-7: every cap is an ASCII constant (arrows and erase as escapes), with no Win, AltGr, mouse or screenshot key', () => {
  const all = [SPECIAL_TOP_ROW, ...SPECIAL_LEFT_BLOCK, ...SPECIAL_MIDDLE_BLOCK, ...SPECIAL_ARROW_BLOCK, ...SPECIAL_NUMPAD_BLOCK].flat();
  for (const entry of all) {
    if (entry.kind !== 'key' && entry.kind !== 'mod') continue;
    assert.match(entry.label, /^[\x20-\x7e←-↓⌫]+$/, `${entry.label} is an ASCII constant`);
    assert.ok(entry.ariaKey.startsWith('mobileKeyboard.'), `${entry.label} has a catalog aria key`);
  }
  const labels = all.map(e => (e.kind === 'key' || e.kind === 'mod' ? e.label : '')).join(' ');
  for (const banned of ['Win', 'AltGr', 'Mouse', 'Screenshot']) assert.ok(!labels.includes(banned), `no ${banned}`);
});

// --- Right block preference ---------------------------------------------------

test('FR-MKB-010 AC-4 / SDS-AC-9: the right block choice round-trips through storage and defaults to arrows', () => {
  const storage = memoryStorage();
  assert.equal(readRightBlock(storage), 'arrows', 'nothing stored yet');
  writeRightBlock(storage, 'numpad');
  assert.equal(storage.getItem(RIGHT_BLOCK_STORAGE_KEY), 'numpad');
  assert.equal(readRightBlock(storage), 'numpad');
  writeRightBlock(storage, 'arrows');
  assert.equal(readRightBlock(storage), 'arrows');
  assert.equal(readRightBlock(memoryStorage({ [RIGHT_BLOCK_STORAGE_KEY]: 'garbage' })), 'arrows', 'an unknown value is arrows');
  assert.equal(readRightBlock(null), 'arrows', 'no storage at all');
  assert.doesNotThrow(() => writeRightBlock(null, 'numpad'));
});

test('FR-MKB-010 AC-4 / SDS-AC-9: storage that throws on read and write opens with arrows and never throws', () => {
  const storage = throwingStorage();
  assert.doesNotThrow(() => readRightBlock(storage));
  assert.equal(readRightBlock(storage), 'arrows');
  assert.doesNotThrow(() => writeRightBlock(storage, 'numpad'));
});

// --- Panel height -------------------------------------------------------------

test('FR-MKB-008 AC-2 / SDS-AC-2: the panel is 280 px until an inset was measured, then the last inset', () => {
  assert.equal(DEFAULT_SPECIAL_PANEL_HEIGHT, 280);
  assert.equal(specialPanelHeight(0), 280);
  assert.equal(specialPanelHeight(312), 312);
  assert.equal(specialPanelHeight(-5), 280, 'a negative reading is no reading');
});

test('FR-MKB-008 AC-2: a measured inset below 260 px is raised to the 260 px floor so no panel key is cut off', () => {
  assert.equal(specialPanelHeight(0), 280);
  assert.equal(specialPanelHeight(150), 260);
  assert.equal(specialPanelHeight(259), 260);
  assert.equal(specialPanelHeight(312), 312);
});

// --- Drag threshold -----------------------------------------------------------

test('FR-MKB-011 AC-3 / SDS-AC-10: a move beyond 8 px is a drag; 8 px or less is a tap', () => {
  assert.equal(isDragBeyond(0, 0), false);
  assert.equal(isDragBeyond(8, 0), false);
  assert.equal(isDragBeyond(0, -8), false);
  assert.equal(isDragBeyond(6, 6), true, 'distance, not each axis: 8.49 px');
  assert.equal(isDragBeyond(20, 0), true);
  assert.equal(isDragBeyond(0, -9), true);
});

// --- Bar visibility -----------------------------------------------------------

test('FR-MKB-008 AC-5 / SDS-AC-5: with the panel open the bar shows while the textarea is blurred, and never on desktop', () => {
  const base = { isMobile: true, screen: 'workspace', hasActiveTab: true, inputFocused: false, panelOpen: true };
  assert.equal(shouldShowMobileKeyBar(base), true, 'panel open, input blurred');
  assert.equal(shouldShowMobileKeyBar({ ...base, panelOpen: false }), false, 'neither focused nor open');
  assert.equal(shouldShowMobileKeyBar({ ...base, panelOpen: false, inputFocused: true }), true);
  assert.equal(shouldShowMobileKeyBar({ ...base, isMobile: false }), false, 'never on desktop');
  assert.equal(shouldShowMobileKeyBar({ ...base, screen: 'settings' }), false);
  assert.equal(shouldShowMobileKeyBar({ ...base, hasActiveTab: false }), false);
});

// --- Switch hand-over ---------------------------------------------------------

test('FR-MKB-008 AC-1 AC-3 / SDS-AC-1 SDS-AC-3: opening blurs then suppresses; closing releases then focuses, in that order', () => {
  const calls: string[] = [];
  const handle = {
    blurInput: () => { calls.push('blurInput'); },
    setFocusSuppressed: (on: boolean) => { calls.push(`setFocusSuppressed(${on})`); },
    focus: (reason?: string) => { calls.push(`focus(${reason ?? ''})`); },
  };
  assert.equal(applySpecialKeyboardToggle(false, handle), true, 'closed -> open');
  assert.deepEqual(calls, ['blurInput', 'setFocusSuppressed(true)']);
  calls.length = 0;
  assert.equal(applySpecialKeyboardToggle(true, handle), false, 'open -> closed');
  assert.deepEqual(calls, ['setFocusSuppressed(false)', 'focus(mobile-keyboard-switch)']);
  assert.equal(applySpecialKeyboardToggle(false, null), true, 'no terminal still opens the panel');
  assert.equal(applySpecialKeyboardToggle(true, null), false);
});

// --- Lock colour tokens -------------------------------------------------------

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBody(css: string, selector: string): string {
  const rules = [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').map(s => s.trim()).includes(selector));
  assert.equal(rules.length, 1, `exactly one rule for ${selector}`);
  return rules[0][2];
}

const LOCK_TOKENS = ['--lock', '--lock-text', '--lock-tint', '--lock-edge', '--lock-glow', '--lock-hold'] as const;

test('FR-MKB-011 AC-1 AC-2 / SDS-AC-12: tokens.css declares the orange lock family from the design, and the locked key uses it, not --warn', () => {
  const tokens = stripComments(readFileSync(new URL('../../src/styles/tokens.css', import.meta.url), 'utf8'));
  const declared = (name: string): string | undefined => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim();
  for (const name of LOCK_TOKENS) assert.ok(declared(name), `${name} is declared`);
  assert.equal(declared('--lock'), '#ffb02e');
  assert.equal(declared('--lock-text'), '#ffd27a');
  assert.equal(declared('--lock-hold'), 'rgba(255, 176, 46, 0.28)', 'the hold fill is the design 0.28 alpha');
  assert.notEqual(declared('--lock-hold'), declared('--lock-tint'), 'the hold fill is told apart from the locked background');

  const css = readFileSync(new URL('../../src/components/MobileKeyboard/mobileKeyboard.css', import.meta.url), 'utf8');
  const locked = ruleBody(css, '.mobile-key--mod[data-latch-state="locked"]');
  assert.match(locked, /color:\s*var\(--lock-text\)/);
  assert.match(locked, /background:\s*var\(--lock-tint\)/);
  assert.match(locked, /var\(--lock-edge\)/);
  const dot = ruleBody(css, '.mobile-key--mod[data-latch-state="locked"] > .mobile-key__dot');
  assert.match(dot, /background:\s*var\(--lock\)/);
  assert.match(dot, /var\(--lock-glow\)/);
  assert.match(ruleBody(css, '.mobile-key__hold'), /background:\s*var\(--lock-hold\)/);
  assert.ok(!/--warn/.test(stripComments(css)), 'the keyboard stylesheet no longer draws with the warn family');
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(stripComments(css)), 'no raw colour in the keyboard stylesheet');
});

// --- Fast-refresh boundary ----------------------------------------------------

const COMPONENT_FILES = ['MobileKeyBar.tsx', 'MobileSpecialKeyboard.tsx', 'LatchKey.tsx'] as const;
const MOVED_HELPERS = ['MOBILE_BAR_KEYS', 'shouldShowMobileKeyBar', 'useResetLatchWhenNotMobile'] as const;

function readKeyboardSource(file: string): string {
  const raw = readFileSync(new URL(`../../src/components/MobileKeyboard/${file}`, import.meta.url), 'utf8');
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('FR-MKB-011 AC-5: the .tsx files export only PascalCase components and types; the helpers live in mobileKeyboardModel.ts', () => {
  for (const file of COMPONENT_FILES) {
    const source = readKeyboardSource(file);
    const exports = [...source.matchAll(/^\s*export\b[^\n]*/gm)].map(m => m[0].trim());
    assert.ok(
      exports.some(line => /^export\s+function\s+[A-Z]\w*\s*\(/.test(line)),
      `${file} exports a component`,
    );
    for (const line of exports) {
      const allowed = /^export\s+function\s+[A-Z]\w*\s*[(<]/.test(line)
        || /^export\s+(interface|type)\s+[A-Z]\w*/.test(line);
      assert.ok(allowed, `${file}: only a PascalCase function component, interface or type may be exported, found: ${line}`);
    }
    for (const helper of MOVED_HELPERS) {
      assert.ok(
        !new RegExp(`\\b(const|let|var|function)\\s+${helper}\\b`).test(source),
        `${file} no longer declares ${helper}`,
      );
    }
  }
  const model = readKeyboardSource('mobileKeyboardModel.ts');
  assert.match(model, /^export\s+const\s+MOBILE_BAR_KEYS\b/m);
  assert.match(model, /^export\s+function\s+shouldShowMobileKeyBar\s*\(/m);
  assert.match(model, /^export\s+function\s+useResetLatchWhenNotMobile\s*\(/m);
  assert.equal(typeof shouldShowMobileKeyBar, 'function');
});
