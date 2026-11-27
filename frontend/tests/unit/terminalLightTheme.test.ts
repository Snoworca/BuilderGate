// FR-UIDS-019: the terminal under the light theme. The light xterm palette, with every
// ANSI colour measured against its background and the ratios printed (AC-1); the dark
// palette and options as they were, with contrast help in light only (AC-2); the theme
// switch reaching its subscribers and the terminal background token that follows it
// (AC-3); and the colour information WebSocketContext sends the server in server mode,
// pinned for one registration and taken from the current theme for the next (AC-4).
// The repaint of mounted terminals is tests/unit/terminalThemeRepaint.test.ts.
// @req FR-UIDS-019
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { contrastRatio, parseTokenBlock } from '../../src/components/Git/gitContrast.ts';
import * as appTheme from '../../src/theme/appTheme.ts';
import * as viewAttributes from '../../src/utils/terminalViewAttributes.ts';
import type {
  TerminalCheckpointCapabilityMessage,
  TerminalCheckpointRegisteredView,
} from '../../src/types/ws-protocol.ts';

const SRC = new URL('../../src/', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SRC), 'utf8');

const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
] as const;

/** TERMINAL_XTERM_THEME as it was before FR-UIDS-019; AC-2 keeps it. */
const DARK_BEFORE = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  cursor: '#d4d4d4',
  cursorAccent: '#1e1e1e',
  selectionBackground: '#264f78',
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#ffffff',
} as const;

const rgb = (hex: string): number[] => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));

function lightTheme() {
  const theme = viewAttributes.TERMINAL_XTERM_LIGHT_THEME;
  assert.ok(theme, 'terminalViewAttributes exports TERMINAL_XTERM_LIGHT_THEME');
  return theme;
}

// ---- AC-1: the light palette -------------------------------------------------------

test('FR-UIDS-019 AC-1: the light terminal background is light and all 16 ANSI colours reach 4.5:1 on it', () => {
  const theme = lightTheme();
  assert.ok(Object.isFrozen(theme), 'frozen, like the dark palette');
  assert.ok(contrastRatio(theme.background, '#000000') >= 15, `${theme.background} is a light colour`);
  const lines: string[] = [];
  const low: string[] = [];
  for (const key of ANSI_KEYS) {
    const colour = theme[key];
    assert.match(colour, /^#[0-9a-f]{6}$/u, `${key} is #rrggbb, the form the view attributes are built from`);
    const value = contrastRatio(colour, theme.background);
    const line = `  ${key.padEnd(13)} ${colour} on ${theme.background}: ${value.toFixed(2)}:1`;
    lines.push(line);
    if (value < 4.5) low.push(line);
  }
  console.log(`FR-UIDS-019 AC-1 light terminal ANSI contrast (WCAG 2.x):\n${lines.join('\n')}`);
  assert.deepEqual(low, [], 'ANSI colours under 4.5:1 on the light terminal');
});

test('FR-UIDS-019 AC-1: the light foreground, cursor and selection read on the light background', () => {
  const theme = lightTheme();
  const pairs: ReadonlyArray<readonly [string, string, string, number]> = [
    ['foreground on the background', theme.foreground, theme.background, 4.5],
    ['cursor on the background', theme.cursor, theme.background, 3],
    ['the character under the block cursor (cursorAccent on cursor)', theme.cursorAccent, theme.cursor, 4.5],
    // The WebGL renderer fills a selected cell with the opaque selection colour.
    ['foreground on the selection', theme.foreground, theme.selectionBackground, 4.5],
    ['the selection against the background', theme.selectionBackground, theme.background, 1.3],
  ];
  const lines: string[] = [];
  const low: string[] = [];
  for (const [what, fg, bg, floor] of pairs) {
    const value = contrastRatio(fg, bg);
    const line = `  ${what}: ${fg} on ${bg}: ${value.toFixed(2)}:1 (needs ${floor})`;
    lines.push(line);
    if (value < floor) low.push(line);
  }
  console.log(`FR-UIDS-019 AC-1 light terminal text, cursor and selection:\n${lines.join('\n')}`);
  assert.deepEqual(low, []);
});

// ---- AC-2: dark as it was, contrast help in light only -----------------------------

test('FR-UIDS-019 AC-2: the dark terminal palette and its view attributes are the ones before FR-UIDS-019', () => {
  assert.deepEqual({ ...viewAttributes.TERMINAL_XTERM_THEME }, DARK_BEFORE);
  assert.ok(Object.isFrozen(viewAttributes.TERMINAL_XTERM_THEME));
  const attributes = viewAttributes.TERMINAL_AUTHORITY_VIEW_ATTRIBUTES;
  assert.equal(attributes.colorSchemeMode, 'dark');
  assert.deepEqual(attributes.foreground, rgb(DARK_BEFORE.foreground));
  assert.deepEqual(attributes.background, rgb(DARK_BEFORE.background));
  assert.deepEqual(attributes.cursor, rgb(DARK_BEFORE.cursor));
  assert.deepEqual(attributes.ansi.slice(0, 16), ANSI_KEYS.map((key) => rgb(DARK_BEFORE[key])));
});

const require = createRequire(import.meta.url);
type XtermLike = { options: Record<string, unknown>; dispose(): void };
const { Terminal: Xterm } = require('@xterm/xterm') as {
  Terminal: new (options?: Record<string, unknown>) => XtermLike;
};

test('FR-UIDS-019 AC-2: minimumContrastRatio is raised in light only; dark sets exactly the xterm default', () => {
  assert.equal(typeof viewAttributes.resolveTerminalXtermThemeOptions, 'function', 'terminalViewAttributes exports resolveTerminalXtermThemeOptions');
  const dark = viewAttributes.resolveTerminalXtermThemeOptions('dark');
  const light = viewAttributes.resolveTerminalXtermThemeOptions('light');
  assert.equal(dark.theme, viewAttributes.TERMINAL_XTERM_THEME, 'dark is the same frozen palette object as before');
  assert.equal(light.theme, lightTheme());
  assert.equal(light.minimumContrastRatio, 4.5, 'WCAG AA, for the colours a program picks itself (256-colour, truecolor, its own backgrounds)');
  assert.ok(Object.isFrozen(dark) && Object.isFrozen(light));
  assert.deepEqual(Object.keys(dark).sort(), ['minimumContrastRatio', 'theme']);
  assert.deepEqual(Object.keys(light).sort(), ['minimumContrastRatio', 'theme']);
  // Before FR-UIDS-019 the option was never set, so the terminal ran on xterm's default.
  const plain = new Xterm({});
  try {
    assert.equal(dark.minimumContrastRatio, plain.options.minimumContrastRatio, "dark is xterm's own default");
  } finally {
    plain.dispose();
  }
  for (const options of [dark, light]) {
    const term = new Xterm({ ...options });
    try {
      assert.equal(term.options.minimumContrastRatio, options.minimumContrastRatio, 'xterm takes the ratio as given');
      assert.deepEqual(term.options.theme, options.theme, 'xterm takes the palette as given');
    } finally {
      term.dispose();
    }
  }
});

// ---- AC-4: what the server is told -------------------------------------------------

test('FR-UIDS-019 AC-4: the view attributes of each theme are its xterm palette, so the server answers what the browser draws', () => {
  assert.equal(typeof viewAttributes.resolveTerminalAuthorityViewAttributes, 'function', 'terminalViewAttributes exports resolveTerminalAuthorityViewAttributes');
  assert.equal(viewAttributes.resolveTerminalAuthorityViewAttributes('dark'), viewAttributes.TERMINAL_AUTHORITY_VIEW_ATTRIBUTES, 'dark is the constant it always was');
  const darkAnsi = viewAttributes.TERMINAL_AUTHORITY_VIEW_ATTRIBUTES.ansi;
  for (const theme of ['dark', 'light'] as const) {
    const attributes = viewAttributes.resolveTerminalAuthorityViewAttributes(theme);
    const palette = viewAttributes.resolveTerminalXtermThemeOptions(theme).theme;
    assert.ok(Object.isFrozen(attributes), theme);
    assert.equal(attributes.colorSchemeMode, theme);
    assert.deepEqual(attributes.foreground, rgb(palette.foreground), theme);
    assert.deepEqual(attributes.background, rgb(palette.background), theme);
    assert.deepEqual(attributes.cursor, rgb(palette.cursor), theme);
    assert.deepEqual(attributes.ansi.slice(0, 16), ANSI_KEYS.map((key) => rgb(palette[key])), `${theme}: OSC 4 indexes 0-15`);
    // 16-255 are xterm's fixed cube and greys in either theme; the palette does not set them.
    assert.deepEqual(attributes.ansi.slice(16), darkAnsi.slice(16), `${theme}: OSC 4 indexes 16-255`);
    assert.equal(attributes.cursorStyle, 'block');
    assert.equal(attributes.cursorBlink, true);
    // The shape the server accepts (server/src/utils/terminalQueryResponder.ts isValidViewAttributes).
    assert.equal(attributes.ansi.length, 256);
    for (const colour of [attributes.foreground, attributes.background, attributes.cursor, ...attributes.ansi]) {
      assert.ok(colour.length === 3 && colour.every((c) => Number.isInteger(c) && c >= 0 && c <= 255), `${theme}: ${JSON.stringify(colour)}`);
    }
  }
});

function capabilityWith(...views: TerminalCheckpointRegisteredView[]): TerminalCheckpointCapabilityMessage {
  return {
    type: 'terminal-checkpoint:capability',
    protocolVersion: 1,
    accepted: true,
    authorityMode: 'checkpoint',
    checkpointDeliveryActive: true,
    ordinalEncoding: 'canonical-uint64-decimal',
    digestAlgorithms: ['sha256'],
    registeredViews: views,
  };
}

const VIEW: TerminalCheckpointRegisteredView = Object.freeze({
  sessionId: 'session-a',
  viewGeneration: 7,
  driverLeaseGeneration: '11',
  acceptedViewAttributesGeneration: '13',
  viewAttributesChallengeId: 'challenge-1',
});

test('FR-UIDS-019 AC-4: one registration re-sends its first attributes after a theme change; a new one takes the current theme', () => {
  assert.equal(typeof viewAttributes.createTerminalViewAttributesPin, 'function', 'terminalViewAttributes exports createTerminalViewAttributesPin');
  let theme: 'dark' | 'light' = 'dark';
  const pin = viewAttributes.createTerminalViewAttributesPin(() => theme);
  const attributesFor = (view: TerminalCheckpointRegisteredView, connectionId: string) => {
    const messages = viewAttributes.buildTerminalAuthorityViewAttributeMessages(
      capabilityWith(view),
      (registration) => pin.resolve(connectionId, registration),
    );
    assert.equal(messages.length, 1);
    return messages[0];
  };

  const first = attributesFor(VIEW, 'connection-1');
  assert.equal(first.attributes.colorSchemeMode, 'dark');

  theme = 'light';
  // The server keeps the first attributes of an identity and refuses different ones
  // for it (same-generation-attributes-changed), even when the challenge is new.
  const again = attributesFor({ ...VIEW, viewAttributesChallengeId: 'challenge-2' }, 'connection-1');
  assert.equal(again.attributes, first.attributes, 'the same identity re-sends exactly the first attributes');
  assert.equal(again.viewAttributesChallengeId, 'challenge-2', 'while answering the current challenge');

  const changes: ReadonlyArray<readonly [string, TerminalCheckpointRegisteredView]> = [
    ['a new view generation', { ...VIEW, viewGeneration: 8 }],
    ['a new driver lease generation', { ...VIEW, driverLeaseGeneration: '12' }],
    ['a new view-attributes generation', { ...VIEW, acceptedViewAttributesGeneration: '14' }],
    ['another session', { ...VIEW, sessionId: 'session-b' }],
  ];
  for (const [what, view] of changes) {
    assert.equal(attributesFor(view, 'connection-1').attributes.colorSchemeMode, 'light', what);
  }
  assert.equal(attributesFor(VIEW, 'connection-1').attributes, first.attributes, 'the first identity is still pinned');

  const reconnected = attributesFor(VIEW, 'connection-2');
  assert.equal(reconnected.attributes, viewAttributes.resolveTerminalAuthorityViewAttributes('light'), 'a new connection (reconnect, reload) takes the current theme');
  theme = 'dark';
  assert.equal(attributesFor(VIEW, 'connection-2').attributes, reconnected.attributes, 'and keeps it for that registration');

  // respond… passes the resolver through to what it sends.
  const sent: unknown[] = [];
  const response = viewAttributes.respondToTerminalAuthorityViewAttributeCapability(
    capabilityWith(VIEW),
    (message) => { sent.push(message.attributes); return { ok: true }; },
    (registration) => pin.resolve('connection-2', registration),
  );
  assert.deepEqual(response, { attempted: 1, accepted: 1, failures: [] });
  assert.deepEqual(sent, [reconnected.attributes]);
});

test('FR-UIDS-019 AC-4: the pin keeps a bounded number of registrations', () => {
  let theme: 'dark' | 'light' = 'dark';
  const pin = viewAttributes.createTerminalViewAttributesPin(() => theme, 2);
  const views = [1, 2, 3].map((viewGeneration) => ({ ...VIEW, viewGeneration }));
  for (const view of views) pin.resolve('connection-1', view);
  theme = 'light';
  assert.equal(pin.resolve('connection-1', views[2]).colorSchemeMode, 'dark', 'the newest are kept');
  assert.equal(pin.resolve('connection-1', views[1]).colorSchemeMode, 'dark');
  assert.equal(pin.resolve('connection-1', views[0]).colorSchemeMode, 'light', 'the oldest was let go');
});

test('FR-UIDS-019 AC-4: the bound lets go of the registration unused longest, not one still answering', () => {
  let theme: 'dark' | 'light' = 'dark';
  const pin = viewAttributes.createTerminalViewAttributesPin(() => theme, 2);
  const oldest = { ...VIEW, viewGeneration: 1 };
  const other = { ...VIEW, viewGeneration: 2 };
  const added = { ...VIEW, viewGeneration: 3 };
  pin.resolve('connection-1', oldest);
  pin.resolve('connection-1', other);
  theme = 'light';
  // The first registration answers another capability, so it is the one used last.
  assert.equal(pin.resolve('connection-1', oldest).colorSchemeMode, 'dark');
  pin.resolve('connection-1', added);
  // Letting it go would send the new theme for an identity the server holds to the old
  // one, which the server refuses (same-generation-attributes-changed).
  assert.equal(pin.resolve('connection-1', oldest).colorSchemeMode, 'dark', 'the registration used last keeps its first attributes');
  assert.equal(pin.resolve('connection-1', other).colorSchemeMode, 'light', 'the one unused longest was let go');
});

test('FR-UIDS-019 AC-4: the pin keeps the registrations of the current connection only', () => {
  let theme: 'dark' | 'light' = 'dark';
  // Far below the bound, so only the change of connection can let a registration go.
  const pin = viewAttributes.createTerminalViewAttributesPin(() => theme);
  const otherSession = { ...VIEW, sessionId: 'session-b' };
  pin.resolve('connection-1', VIEW);
  pin.resolve('connection-2', otherSession);
  theme = 'light';
  assert.equal(pin.resolve('connection-2', VIEW).colorSchemeMode, 'light', 'a connection that ended leaves nothing behind');
  assert.equal(pin.resolve('connection-2', otherSession).colorSchemeMode, 'dark', 'while the current connection keeps its own');
});

test('FR-UIDS-019 AC-4: both places WebSocketContext answers a capability go through one pin', () => {
  const source = read('contexts/WebSocketContext.tsx');
  const calls = [...source.matchAll(/respondToTerminalAuthorityViewAttributeCapability\(([\s\S]*?)\n\s+\);/gu)];
  assert.equal(calls.length, 2, 'the capability branch and the deferred publication');
  for (const call of calls) {
    assert.match(call[1], /registration => terminalViewAttributesPin\.resolve\(controlSocketId, registration\)/u);
  }
  assert.match(source, /const \[terminalViewAttributesPin\] = useState\(\(\) => createTerminalViewAttributesPin\(readAppliedTheme\)\)/u, 'one pin for the provider, reading the applied theme');
});

// ---- AC-3: the theme switch and the background around the terminal ----------------

test('FR-UIDS-019 AC-3: applying a different theme tells each subscriber once; the same theme tells nobody', () => {
  assert.equal(typeof appTheme.subscribeAppliedTheme, 'function', 'appTheme exports subscribeAppliedTheme');
  const root = { dataset: {} as DOMStringMap };
  appTheme.applyTheme('dark', root);
  const first: string[] = [];
  const second: string[] = [];
  const stopFirst = appTheme.subscribeAppliedTheme((theme) => { first.push(theme); });
  const stopSecond = appTheme.subscribeAppliedTheme((theme) => { second.push(theme); });
  try {
    appTheme.applyTheme('dark', root);
    appTheme.applyTheme('light', root);
    appTheme.applyTheme('light', root);
    stopSecond();
    appTheme.applyTheme('dark', root);
  } finally {
    stopFirst();
    stopSecond();
  }
  appTheme.applyTheme('light', root);
  assert.deepEqual(first, ['light', 'dark']);
  assert.deepEqual(second, ['light']);
  assert.equal(root.dataset.theme, 'light');
});

test('FR-UIDS-019 AC-3: a subscriber that throws stops neither the others nor the theme change', () => {
  const root = { dataset: { theme: 'dark' } as DOMStringMap };
  const heard: string[] = [];
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...args: unknown[]) => { warned.push(args); };
  const stopFailing = appTheme.subscribeAppliedTheme(() => { throw new Error('listener failed'); });
  const stopHearing = appTheme.subscribeAppliedTheme((theme) => { heard.push(theme); });
  try {
    assert.doesNotThrow(() => appTheme.applyTheme('light', root));
  } finally {
    stopFailing();
    stopHearing();
    console.warn = warn;
  }
  assert.equal(root.dataset.theme, 'light');
  assert.deepEqual(heard, ['light']);
  assert.equal(warned.length, 1, 'the failure is reported once');
});

test('FR-UIDS-019 AC-3: readAppliedTheme reads data-theme; anything but light reads as dark', () => {
  assert.equal(typeof appTheme.readAppliedTheme, 'function', 'appTheme exports readAppliedTheme');
  assert.equal(appTheme.readAppliedTheme({ dataset: { theme: 'light' } as DOMStringMap }), 'light');
  for (const value of [undefined, 'dark', 'Light', 'system', '']) {
    const dataset = (value === undefined ? {} : { theme: value }) as DOMStringMap;
    assert.equal(appTheme.readAppliedTheme({ dataset }), 'dark', JSON.stringify(value));
  }
  assert.equal(appTheme.readAppliedTheme(null), 'dark', 'no root');
  assert.equal(appTheme.readAppliedTheme(), 'dark', 'no document (node)');
});

const TOKENS = read('styles/tokens.css');
const DARK_TOKENS = parseTokenBlock(TOKENS, ':root');
const LIGHT_TOKENS = parseTokenBlock(TOKENS, ':root[data-theme="light"]');

/** A token's value in a theme: the light block re-binds, the first block is the rest. */
function token(theme: 'dark' | 'light', name: string): string {
  const value = (theme === 'light' ? LIGHT_TOKENS[name] : undefined) ?? DARK_TOKENS[name];
  assert.ok(value, `${name} is declared`);
  const reference = /^var\(\s*(--[\w-]+)\s*\)$/u.exec(value);
  return reference ? token(theme, reference[1]) : value;
}

test('FR-UIDS-019 AC-3: --terminal-bg follows the theme and is the background xterm paints in each', () => {
  assert.ok(DARK_TOKENS['--bg-app'] && LIGHT_TOKENS['--bg-app'], 'both token blocks were read');
  assert.equal(DARK_TOKENS['--terminal-bg'], viewAttributes.TERMINAL_XTERM_THEME.background, 'dark');
  assert.equal(LIGHT_TOKENS['--terminal-bg'], lightTheme().background, 'light');
});

/** Everything under src/, as paths relative to it. */
function sourceFiles(dir: URL = SRC, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? sourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));
}

test('FR-UIDS-019 AC-3: nothing pins the terminal background to dark', () => {
  assert.doesNotMatch(
    read('components/Terminal/TerminalView.tsx'),
    /setProperty\(\s*['"]--terminal-bg['"]/u,
    'an inline --terminal-bg on <html> outranks both token blocks, so the dark colour stayed',
  );
  const withFallback: string[] = [];
  let reads = 0;
  for (const file of sourceFiles().filter((path) => /\.(css|tsx?)$/u.test(path))) {
    for (const match of read(file).matchAll(/var\(\s*--terminal-bg\s*([,)])/gu)) {
      if (match[1] === ',') withFallback.push(file);
      else reads += 1;
    }
  }
  assert.deepEqual(withFallback, [], 'a var(--terminal-bg, …) fallback names the dark colour');
  assert.ok(reads >= 5, `the grid cell, its placeholder and the terminal read the token (${reads} reads)`);
});

const FILE_DROP_CSS = read('components/Terminal/terminalFileDrop.css');

function declaration(selector: string, property: string): string {
  const start = FILE_DROP_CSS.indexOf(`${selector} {`);
  assert.ok(start >= 0, `terminalFileDrop.css has ${selector}`);
  const body = FILE_DROP_CSS.slice(start, FILE_DROP_CSS.indexOf('}', start));
  const value = new RegExp(`[\\s{;]${property}\\s*:\\s*([^;]+);`, 'u').exec(body)?.[1].trim();
  assert.ok(value, `${selector} sets ${property}`);
  return value;
}

/** A translucent rgba() laid over an opaque #rrggbb, as #rrggbb. */
function flatten(top: string, under: string): string {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/u.exec(top);
  assert.ok(m, `${top} is rgba()`);
  const alpha = Number(m[4]);
  const base = rgb(under);
  return `#${[m[1], m[2], m[3]].map((channel, i) => Math.round(Number(channel) * alpha + base[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
}

test('FR-UIDS-019 AC-3: what is drawn on the terminal reads on the light one too', () => {
  const lines: string[] = [];
  const low: string[] = [];
  const measure = (what: string, value: number, floor: number) => {
    const line = `  ${what}: ${value.toFixed(2)}:1 (needs ${floor})`;
    lines.push(line);
    if (value < floor) low.push(line);
  };
  const tint = declaration('.terminal-file-drop-overlay', 'background');
  const labelColour = declaration('.terminal-file-drop-overlay-label', 'color');
  const labelBackground = declaration('.terminal-file-drop-overlay-label', 'background');
  const labelTokenName = /^var\(\s*(--[\w-]+)\s*\)$/u.exec(labelBackground)?.[1];
  for (const theme of ['dark', 'light'] as const) {
    const terminal = token(theme, '--terminal-bg');
    const focus = token(theme, '--tile-focus');
    measure(`${theme}: focus frame --tile-focus ${focus} on --terminal-bg ${terminal}`, contrastRatio(focus, terminal), 3);
    const label = labelTokenName ? token(theme, labelTokenName) : labelBackground;
    const tinted = flatten(tint, terminal);
    measure(
      `${theme}: file-drop label ${labelColour} on ${label} over the ${tint} overlay over ${terminal}`,
      contrastRatio(labelColour, label, tinted),
      4.5,
    );
    const toastBg = token(theme, '--toast-bg');
    const toastFg = token(theme, '--toast-fg');
    measure(`${theme}: toast ${toastFg} on ${toastBg} over ${terminal}`, contrastRatio(toastFg, toastBg, terminal), 4.5);
  }
  console.log(`FR-UIDS-019 AC-3 drawn on the terminal:\n${lines.join('\n')}`);
  assert.deepEqual(low, []);
});
