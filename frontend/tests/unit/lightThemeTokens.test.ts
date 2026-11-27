// FR-UIDS-018: the light theme. The light token block (AC-1), the contrast of the
// light text tokens with the measured ratios printed (AC-3), the inline colours
// moved to tokens with their dark values unchanged (AC-2, AC-4), color-scheme
// (AC-5), and a night editor under the light app (AC-7).
// @req FR-UIDS-018
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { contrastRatio } from '../../src/components/Git/gitContrast.ts';

const SRC = new URL('../../src/', import.meta.url);
const read = (rel: string): string => readFileSync(new URL(rel, SRC), 'utf8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const normalizeSelector = (selector: string): string => selector.trim().replace(/'/g, '"').replace(/\s+/g, ' ');

interface Rule { selectorText: string; selectors: string[]; decls: Map<string, string> }

/** The flat rules of a stylesheet; @media and @keyframes give their inner rules. */
function rules(css: string): Rule[] {
  const out: Rule[] = [];
  for (const m of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Drop a leading @import or other statement that ends in ';'.
    const selectorText = normalizeSelector(m[1].split(';').pop() ?? '');
    const selectors = selectorText.split(',').map(normalizeSelector).filter(Boolean);
    const decls = new Map<string, string>();
    for (const declaration of m[2].split(';')) {
      const at = declaration.indexOf(':');
      if (at > 0) decls.set(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim());
    }
    out.push({ selectorText, selectors, decls });
  }
  return out;
}

/** The declarations of the rule whose selector list holds `selector`, if there is one. */
function findRule(css: string, selector: string): Map<string, string> | undefined {
  const wanted = normalizeSelector(selector);
  const found = rules(css).filter((rule) => rule.selectors.includes(wanted));
  assert.ok(found.length <= 1, `${found.length} rules select ${selector}`);
  return found[0]?.decls;
}

function ruleOf(css: string, selector: string): Map<string, string> {
  const found = findRule(css, selector);
  assert.ok(found, `no rule selects ${selector}`);
  return found;
}

const TOKENS = read('styles/tokens.css');
const DARK = ruleOf(TOKENS, ':root');
// Read without asserting, so a missing block fails the tests below one by one.
const LIGHT = findRule(TOKENS, ':root[data-theme="light"]') ?? new Map<string, string>();

/** A token's value with its var() references followed, first through `scopes[0]`. */
function resolve(name: string, scopes: ReadonlyArray<Map<string, string>>, seen: string[] = []): string {
  assert.ok(!seen.includes(name), `var() cycle: ${[...seen, name].join(' -> ')}`);
  const scope = scopes.find((s) => s.has(name));
  assert.ok(scope, `${name} is declared`);
  return scope.get(name)!.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, inner: string) => resolve(inner, scopes, [...seen, name]));
}
const light = (name: string): string => resolve(name, [LIGHT, DARK]);
const dark = (name: string): string => resolve(name, [DARK]);

/** One spelling per colour: #rgb as #rrggbb, white and black as hex, rgba() spacing. */
function normalize(value: string): string {
  return value.trim().toLowerCase()
    .replace(/(?<![\w-])white(?![\w-])/g, '#ffffff')
    .replace(/(?<![\w-])black(?![\w-])/g, '#000000')
    .replace(/#([0-9a-f])([0-9a-f])([0-9a-f])\b/g, '#$1$1$2$2$3$3')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/(^|[\s,(])\.(\d)/g, '$10.$2')
    .replace(/\s+/g, ' ');
}

const isColour = (value: string): boolean => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/i.test(value);
const ratio = (fg: string, bg: string, under = '#ffffff'): number => contrastRatio(fg, bg, under);

// ---- AC-1 / AC-3: the light block ------------------------------------------------

const AC3_TEXT = ['--fg', '--fg-strong', '--fg-muted'] as const;
const AC3_BACKGROUNDS = ['--bg-app', '--bg-chrome', '--bg-surface', '--bg-raised'] as const;

test('FR-UIDS-018 AC-1: under data-theme="light" the backgrounds are light and the text and lines are re-bound', () => {
  assert.ok(LIGHT.size > 0, 'tokens.css has a :root[data-theme="light"] block');
  for (const name of [...AC3_BACKGROUNDS, '--bg-sunken']) {
    assert.ok(LIGHT.has(name), `${name} has a light value`);
    assert.ok(ratio(light(name), '#000000') >= 15, `${name} ${light(name)} is a light colour`);
  }
  for (const name of [...AC3_TEXT, '--fg-faint', '--line', '--line-strong', '--accent-text', '--danger-text']) {
    assert.ok(LIGHT.has(name), `${name} has a light value`);
  }
});

test('FR-UIDS-018 AC-3: --fg, --fg-strong and --fg-muted reach 4.5:1 on every light background', () => {
  // Without a light value the pair would be measured on its dark value and could pass.
  for (const name of [...AC3_TEXT, ...AC3_BACKGROUNDS]) assert.ok(LIGHT.has(name), `${name} has a light value`);
  const lines: string[] = [];
  const low: string[] = [];
  for (const fg of AC3_TEXT) {
    for (const bg of AC3_BACKGROUNDS) {
      const value = ratio(light(fg), light(bg));
      const line = `  ${fg} ${light(fg)} on ${bg} ${light(bg)}: ${value.toFixed(2)}:1`;
      lines.push(line);
      if (value < 4.5) low.push(line);
    }
  }
  console.log(`FR-UIDS-018 AC-3 light contrast (WCAG 2.x):\n${lines.join('\n')}`);
  assert.deepEqual(low, [], 'pairs under 4.5:1');
});

/** [text token, background token, what a translucent background is laid over: a token or a colour]. */
const LIGHT_TEXT_PAIRS: ReadonlyArray<readonly [string, string, string?]> = [
  ...(['--accent-text', '--ok-text', '--warn-text', '--danger-text'] as const)
    .flatMap((fg) => AC3_BACKGROUNDS.map((bg) => [fg, bg] as const)),
  // --ok, --warn and --danger are also drawn as text (loop and usage dialogs), and the
  // messenger names its speakers in the --who colours.
  ...(['--ok', '--warn', '--danger', '--who-human', '--who-local', '--who-remote'] as const)
    .flatMap((fg) => (['--bg-chrome', '--bg-surface'] as const).map((bg) => [fg, bg] as const)),
  ['--accent-fg', '--accent'],
  ['--accent-fg', '--danger-fill'],
  ['--accent-fg', '--ok'],
  ['--on-signal', '--warn'],
  ['--on-signal', '--attention'],
  ['--lock-text', '--lock-tint', '--bg-raised'],
  ['--accent-text', '--accent-tint', '--bg-surface'],
  ['--accent-text', '--mention-bg', '--bg-surface'],
  ['--msgr-av-fg', '--who-human'],
  ['--msgr-av-fg', '--who-local'],
  ['--msgr-av-fg', '--who-remote'],
  ['--msgr-on-warn', '--warn'],
  ['--msgr-warn-fg', '--msgr-warn-bg', '--bg-surface'],
  ['--msgr-warn-strong', '--msgr-warn-bg', '--bg-surface'],
  ['--msgr-info-fg', '--msgr-info-bg', '--bg-surface'],
  ['--msgr-info-strong', '--msgr-info-bg', '--bg-surface'],
  ['--loop-prompt-text', '--bg-chrome'],
  ['--loop-prompt-text', '--bg-surface'],
  ['--meta-fg', '--meta-bg'],
  ['--meta-fg-dim', '--meta-bg'],
  ['--meta-strong', '--meta-bg'],
  ['--meta-copied', '--meta-bg'],
  ['--meta-copy-failed', '--meta-bg'],
  ['--meta-toggle-fg', '--meta-bg'],
  ['--meta-strong', '--meta-toggle-hover'],
  ['--composer-input-fg', '--bg-well'],
  ['--error-text', '--bg-panel'],
  ['--fg-dim', '--bg-panel'],
  ['--todo-fg', '--bg-panel'],
  ['--todo-heading', '--bg-panel'],
  ['--todo-chip-fg', '--bg-panel'],
  ['--todo-icon', '--bg-panel'],
  ['--todo-empty', '--bg-panel'],
  ['--todo-action', '--bg-panel'],
  ['--todo-meta', '--bg-panel'],
  ['--todo-done-on', '--bg-panel'],
  ['--todo-note-hidden', '--bg-panel'],
  ['--todo-clear', '--bg-panel'],
  ['--todo-fg', '--todo-row-hover'],
  ['--todo-fg', '--todo-row-selected'],
  ['--todo-meta', '--todo-row-selected'],
  ['--todo-author-fg', '--todo-author-bg'],
  ['--todo-author-session-fg', '--todo-author-session-bg'],
  ['--todo-detail-fg', '--todo-detail-bg'],
  ['--todo-detail-edit-fg', '--todo-detail-bg'],
  ['--todo-meta', '--todo-detail-hover'],
  ['--todo-detail-hide-hover', '--todo-detail-hover'],
  ['--todo-input-fg', '--bg-well'],
  // Over a session, whose terminal background follows the theme (FR-UIDS-019).
  ['--fg', '--bg-veil', '--terminal-bg'],
  ['--danger-text', '--bg-veil', '--terminal-bg'],
  ['--fg-muted', '--toolbar-float-bg', '--terminal-bg'],
];

test('FR-UIDS-018 AC-3 AC-4: the other light text tokens reach 4.5:1 on the surfaces they are drawn on', () => {
  const named = [...new Set(LIGHT_TEXT_PAIRS.flatMap(([fg, bg]) => [fg, bg]))];
  assert.deepEqual(named.filter((name) => !LIGHT.has(name) && !THEME_NEUTRAL.has(name)), [], 'tokens that would be measured on their dark value');
  const lines: string[] = [];
  const low: string[] = [];
  for (const [fg, bg, under] of LIGHT_TEXT_PAIRS) {
    const base = under === undefined ? '#ffffff' : under.startsWith('--') ? light(under) : under;
    const value = ratio(light(fg), light(bg), base);
    const line = `  ${fg} ${light(fg)} on ${bg} ${light(bg)}${under ? ` over ${under}` : ''}: ${value.toFixed(2)}:1`;
    lines.push(line);
    if (value < 4.5) low.push(line);
  }
  console.log(`FR-UIDS-018 light text tokens on their surfaces:\n${lines.join('\n')}`);
  assert.deepEqual(low, [], 'pairs under 4.5:1');
});

/** Colours that stay the same in both themes, each with the reason it may. */
const THEME_NEUTRAL: ReadonlyMap<string, string> = new Map([
  ['--bg-paper', 'the paper a document sits on in the day editor is white in either theme'],
  ['--accent', 'the one accent (#0078d4, pinned by designTokens); white text on it is 4.5:1 in either theme'],
  ['--accent-fg', 'text and marks on a filled accent, tab colour or status disc; the fill does not change'],
  ['--accent-hover', 'the filled accent under the pointer'],
  ['--danger-fill', 'the filled destructive button; white text on it is 4.6:1 in either theme'],
  ['--danger-fill-hover', 'the filled destructive button under the pointer'],
  ['--bg-standalone-inset', 'the strip under the status bar of the iOS home-screen app; black-translucent draws white text there in either theme'],
  ['--toast-bg', 'a toast over the terminal is a self-contained white-on-scrim pair'],
  ['--toast-fg', 'a toast over the terminal is a self-contained white-on-scrim pair'],
  ['--drop-preview-bg', 'the translucent blue drop target over the grid reads on either theme'],
  ['--drop-preview-line', 'the translucent blue drop target over the grid reads on either theme'],
]);

test('FR-UIDS-018 AC-1: every dark colour token has a light value, or is listed as theme-neutral with a reason', () => {
  const darkColours = [...DARK].filter(([name, value]) => name.startsWith('--') && isColour(value)).map(([name]) => name);
  assert.ok(darkColours.length > 100, `the first block read with ${darkColours.length} colours`);
  assert.deepEqual(darkColours.filter((name) => !LIGHT.has(name) && !THEME_NEUTRAL.has(name)), [], 'dark colours with no light value');
  for (const [name, reason] of THEME_NEUTRAL) {
    assert.ok(darkColours.includes(name), `${name} is listed as theme-neutral but is no colour of the first block`);
    assert.ok(!LIGHT.has(name), `${name} is listed as theme-neutral and also re-bound for light`);
    assert.ok(reason.length > 20, `${name} needs a reason`);
  }
  assert.deepEqual([...LIGHT.keys()].filter((name) => !DARK.has(name)), [], 'light names the first block does not declare');
  assert.deepEqual(
    [...LIGHT].filter(([name, value]) => normalize(value) === normalize(DARK.get(name) ?? '')).map(([name]) => name),
    [],
    'a light value equal to the dark one belongs on the theme-neutral list',
  );
});

// ---- AC-2 / AC-4: inline colours moved to tokens ------------------------------------

/**
 * Every token that took over an inline colour, the colour it replaced, and the files
 * that now read it. The dark value has to be that colour exactly (AC-2): a near
 * match such as #2a2a2a for #2b2b2b would change a computed colour.
 */
const REPLACED: ReadonlyArray<readonly [token: string, literal: string, files: readonly string[]]> = [
  ['--bg-panel', '#1f1f1f', ['components/Todo/TodoPanel.css', 'components/Terminal/SessionComposer.css']],
  ['--line', '#3a3a3a', ['components/Todo/TodoPanel.css', 'components/Terminal/SessionComposer.css']],
  ['--line-strong', '#4a4a4a', ['components/Terminal/SessionComposer.css']],
  ['--bg-well', '#141414', ['components/Todo/TodoPanel.css', 'components/Terminal/SessionComposer.css']],
  ['--error-text', '#f87171', ['components/Todo/TodoPanel.css', 'components/Terminal/SessionComposer.css']],
  ['--fg-dim', '#777', ['components/Todo/TodoPanel.css', 'components/Terminal/SessionComposer.css']],
  ['--accent-fg', '#fff', ['components/Todo/TodoPanel.css', 'components/Terminal/SessionComposer.css']],
  ['--accent-text', '#6cb6ff', ['components/Loop/LoopDialog.css']],
  ['--on-signal', '#202020', ['components/Workspace/Workspace.css', 'components/Workspace/WorkspaceTabBar.css']],
  ['--grip', '#555', ['components/Terminal/SessionComposer.css']],
  ['--grip-hover', '#888', ['components/Terminal/SessionComposer.css']],
  ['--scrim', 'rgba(0, 0, 0, 0.5)', ['components/Workspace/Workspace.css', 'styles/globals.css']],
  ['--scrim-dialog', 'rgba(0, 0, 0, 0.42)', ['components/dialog/WindowDialog.css', 'components/ContextMenu/ContextMenu.css']],
  ['--scrim-strong', 'rgba(0, 0, 0, 0.6)', ['components/Modal/RenameModal.css']],
  ['--bg-veil', 'rgba(0, 0, 0, 0.7)', ['components/Workspace/Workspace.css']],
  ['--scrollbar-track', '#1e1e1e', ['styles/globals.css']],
  ['--scrollbar-thumb', '#424242', ['styles/globals.css']],
  ['--scrollbar-thumb-hover', '#4f4f4f', ['styles/globals.css']],
  ['--bg-standalone-inset', '#1e1e1e', ['styles/globals.css']],
  ['--split-hover', 'rgba(255, 255, 255, 0.1)', ['components/Grid/MosaicOverrides.css']],
  ['--split-line', 'rgba(255, 255, 255, 0.04)', ['components/Grid/MosaicOverrides.css']],
  ['--grid-bg', 'rgba(255, 255, 255, 0.03)', ['components/Grid/MosaicOverrides.css']],
  ['--drop-preview-bg', 'rgba(100, 149, 237, 0.15)', ['components/Grid/MosaicOverrides.css']],
  ['--drop-preview-line', 'rgba(100, 149, 237, 0.5)', ['components/Grid/MosaicOverrides.css']],
  ['--toolbar-float-bg', 'rgba(47, 47, 47, 0.9)', ['components/Grid/MosaicToolbar.css']],
  ['--tile-focus', '#ffffff', ['components/Workspace/breathing.css']],
  ['--toast-bg', 'rgba(0, 0, 0, 0.8)', ['components/Terminal/InputDiscardedToast.css', 'components/Terminal/FontSizeToast.css']],
  ['--toast-fg', 'white', ['components/Terminal/InputDiscardedToast.css', 'components/Terminal/FontSizeToast.css']],
  // FR-UIDS-019: the terminal background (the var() fallbacks, and the inline value
  // TerminalView set from the xterm palette) and the file-drop label behind its text.
  ['--terminal-bg', '#1e1e1e', ['components/Terminal/TerminalView.css', 'components/Grid/MosaicTile.tsx']],
  ['--file-drop-label-bg', 'rgba(0, 0, 0, 0.6)', ['components/Terminal/terminalFileDrop.css']],
  ['--ok-line', 'rgba(76, 195, 138, 0.4)', ['components/Messenger/Messenger.css']],
  ['--warn-line', 'rgba(216, 165, 52, 0.4)', ['components/Messenger/Messenger.css']],
  ['--loop-prompt-text', '#c586c0', ['components/Loop/LoopDialog.css']],
  ['--msgr-on-warn', '#1b1b1b', ['components/Messenger/Messenger.css']],
  ['--msgr-av-fg', '#1a1a1a', ['components/Messenger/Messenger.css']],
  ['--msgr-warn-line', 'rgba(216, 165, 52, 0.5)', ['components/Messenger/Messenger.css']],
  ['--msgr-warn-bg', 'rgba(216, 165, 52, 0.1)', ['components/Messenger/Messenger.css']],
  ['--msgr-warn-fg', '#f0d38f', ['components/Messenger/Messenger.css']],
  ['--msgr-warn-strong', '#ffe2a0', ['components/Messenger/Messenger.css']],
  ['--msgr-info-line', 'rgba(108, 182, 255, 0.45)', ['components/Messenger/Messenger.css']],
  ['--msgr-info-bg', 'rgba(108, 182, 255, 0.08)', ['components/Messenger/Messenger.css']],
  ['--msgr-info-fg', '#cfe3f7', ['components/Messenger/Messenger.css']],
  ['--msgr-info-strong', '#e6f1ff', ['components/Messenger/Messenger.css']],
  ['--meta-bg', '#2a2a2a', ['components/MetadataBar/MetadataRow.tsx']],
  ['--meta-fg', '#e0e0e0', ['components/MetadataBar/MetadataRow.tsx']],
  ['--meta-fg-dim', '#d7d7d7', ['components/MetadataBar/MetadataRow.tsx']],
  ['--meta-strong', '#fff', ['components/MetadataBar/MetadataRow.tsx', 'components/Terminal/SessionComposer.css']],
  ['--meta-line', '#555', ['components/MetadataBar/MetadataRow.tsx']],
  ['--meta-underline', '#666', ['components/MetadataBar/MetadataRow.tsx']],
  ['--meta-copied', '#22c55e', ['components/MetadataBar/MetadataRow.tsx']],
  ['--meta-copy-failed', '#ef4444', ['components/MetadataBar/MetadataRow.tsx']],
  ['--meta-toggle-fg', '#bdbdbd', ['components/Terminal/SessionComposer.css']],
  ['--meta-toggle-hover', '#383838', ['components/Terminal/SessionComposer.css']],
  ['--meta-toggle-dot', '#facc15', ['components/Terminal/SessionComposer.css']],
  ['--composer-input-line', '#3f3f3f', ['components/Terminal/SessionComposer.css']],
  ['--composer-input-fg', '#e6e6e6', ['components/Terminal/SessionComposer.css']],
  ['--composer-placeholder', '#6b6b6b', ['components/Terminal/SessionComposer.css']],
  ['--composer-send-off-bg', '#3a3a3a', ['components/Terminal/SessionComposer.css']],
  ['--composer-drag-bg', 'rgba(74, 158, 255, 0.08)', ['components/Terminal/SessionComposer.css']],
  ['--todo-fg', '#ddd', ['components/Todo/TodoPanel.css']],
  ['--todo-resize-hover', 'rgba(120, 160, 255, 0.35)', ['components/Todo/TodoPanel.css']],
  ['--todo-chip-line', '#444', ['components/Todo/TodoPanel.css']],
  ['--todo-chip-fg', '#aaa', ['components/Todo/TodoPanel.css']],
  ['--todo-done-on', '#7fd17f', ['components/Todo/TodoPanel.css']],
  ['--todo-done-on-line', '#4a7a4a', ['components/Todo/TodoPanel.css']],
  ['--todo-icon', '#bbb', ['components/Todo/TodoPanel.css']],
  ['--todo-empty', '#888', ['components/Todo/TodoPanel.css']],
  ['--todo-row-hover', '#2a2a2a', ['components/Todo/TodoPanel.css']],
  ['--todo-row-selected', '#2f3b52', ['components/Todo/TodoPanel.css']],
  ['--todo-accent', '#6f95e6', ['components/Todo/TodoPanel.css']],
  ['--todo-drop-bg', '#263452', ['components/Todo/TodoPanel.css']],
  ['--todo-heading', '#f0f2f5', ['components/Todo/TodoPanel.css']],
  ['--todo-heading-done', '#8a9a8a', ['components/Todo/TodoPanel.css']],
  ['--todo-author-fg', '#9aa7c0', ['components/Todo/TodoPanel.css']],
  ['--todo-author-bg', '#2a3242', ['components/Todo/TodoPanel.css']],
  ['--todo-author-session-fg', '#c7b07a', ['components/Todo/TodoPanel.css']],
  ['--todo-author-session-bg', '#3a3326', ['components/Todo/TodoPanel.css']],
  ['--todo-tree-line', '#5b6578', ['components/Todo/TodoPanel.css']],
  ['--todo-status-hover', '#2f2f2f', ['components/Todo/TodoPanel.css']],
  ['--todo-status-ring', '#3d6fa0', ['components/Todo/TodoPanel.css']],
  ['--todo-meta', '#7a8aa8', ['components/Todo/TodoPanel.css']],
  ['--todo-action', '#999', ['components/Todo/TodoPanel.css']],
  ['--todo-input-line', '#555', ['components/Todo/TodoPanel.css']],
  ['--todo-input-fg', '#eee', ['components/Todo/TodoPanel.css']],
  ['--todo-detail-line', '#3b4a66', ['components/Todo/TodoPanel.css']],
  ['--todo-detail-bg', '#232731', ['components/Todo/TodoPanel.css']],
  ['--todo-detail-fg', '#b8c0cf', ['components/Todo/TodoPanel.css']],
  ['--todo-detail-hover', '#283040', ['components/Todo/TodoPanel.css']],
  ['--todo-detail-hide-hover', '#c8d4ee', ['components/Todo/TodoPanel.css']],
  ['--todo-detail-edit-fg', '#e4e9f2', ['components/Todo/TodoPanel.css']],
  ['--todo-note-hidden', '#8fb4ff', ['components/Todo/TodoPanel.css']],
  ['--todo-scroll-thumb', '#4a5468', ['components/Todo/TodoPanel.css']],
  ['--todo-clear', '#f08a8a', ['components/Todo/TodoPanel.css']],
];

test('FR-UIDS-018 AC-2: each token that replaced an inline colour holds exactly that colour in dark', () => {
  const differing = REPLACED
    .filter(([token, literal]) => !DARK.has(token) || normalize(dark(token)) !== normalize(literal))
    .map(([token, literal]) => `${token}: dark ${DARK.has(token) ? dark(token) : '(undeclared)'}, replaced ${literal}`);
  assert.deepEqual(differing, []);
  const unread = REPLACED.flatMap(([token, , files]) => files.filter((f) => !read(f).includes(`var(${token})`)).map((f) => `${f} does not read ${token}`));
  assert.deepEqual(unread, []);
});

// ---- AC-4: no inline colour left in live code -------------------------------------

/** Everything under src/, as paths relative to it. */
function sourceFiles(dir: URL = SRC, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory()
    ? sourceFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`)
    : [`${prefix}${entry.name}`]));
}

const DEAD = 'not reachable from App.tsx (CLAUDE.md, Project Structure)';
/** Paths the guard does not read; a trailing slash means the whole directory. */
const NOT_SCANNED: ReadonlyMap<string, string> = new Map([
  ['editor/', 'the vendored editor, re-imported from upstream'],
  ['styles/tokens.css', 'where the colours are declared'],
  ['components/Terminal/TerminalView.css', 'the terminal itself (FR-UIDS-019)'],
  ['utils/terminalViewAttributes.ts', 'the xterm palette (FR-UIDS-019); a sealed file'],
  ['components/Terminal/TerminalView.tsx', 'the terminal itself (FR-UIDS-019); a sealed file'],
  ['types/workspace.ts', 'TAB_COLORS, the user tab palette, is the same in either theme'],
  ['components/Git/gitContrast.ts', 'the contrast helper defaults its backdrop to black; nothing is drawn with it'],
  ['components/Sidebar/', DEAD],
  ['components/StatusBar/', DEAD],
  ['components/FileManager/', DEAD],
  ['components/Modal/ShellSelectModal.css', DEAD],
  ['components/Modal/ShellSelectModal.tsx', DEAD],
  ['components/Grid/EmptyCell.tsx', DEAD],
]);

const VENDORED_RE_BIND = 'the day editor re-binds the vendored editor palette (body text, code block); not ours to tokenize (AC-7)';
const FILE_DROP = 'FR-FEX-031 AC-1 pins the 15% yellow over the terminal; the yellow label sits on --file-drop-label-bg, which the light theme darkens (FR-UIDS-019)';
/** [file, rule selector, colour, reason]: the inline colours that stay. */
const ALLOWED: ReadonlyArray<readonly [string, string, string, string]> = [
  ['components/editor/EditorWindow.css', ".editor-window-surface [data-theme='light'] .atomic-cm-editor", '#000000', VENDORED_RE_BIND],
  ['components/editor/EditorWindow.css', ".editor-window-surface [data-theme='light'] .atomic-cm-editor", '#eef0f2', VENDORED_RE_BIND],
  ['components/editor/EditorWindow.css', ".editor-window-surface [data-theme='light'] .atomic-cm-editor", '#c9ced4', VENDORED_RE_BIND],
  ['components/Todo/TodoPanel.css', '.todo-check:checked', '#2c4058', 'FR-TODO-003 pins #2c4058; a dark filled box with its light check reads on either theme'],
  ['components/Todo/TodoPanel.css', '.todo-check:checked', '#3a5675', 'the edge of the same filled box'],
  ['components/Terminal/terminalFileDrop.css', '.terminal-file-drop-overlay', 'rgba(255, 214, 0, 0.15)', FILE_DROP],
  ['components/Terminal/terminalFileDrop.css', '.terminal-file-drop-overlay', 'rgba(255, 214, 0, 0.7)', FILE_DROP],
  ['components/Terminal/terminalFileDrop.css', '.terminal-file-drop-overlay-label', '#ffd600', FILE_DROP],
  ['styles/globals.css', '.no-session', '#6e6e6e', 'a dead rule: no element carries .no-session'],
];

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const NAMED_COLOUR = /(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|gray|grey|silver|pink|cyan|magenta|gold|navy|teal|maroon|olive|lime|aqua|fuchsia)(?![\w-])/gi;

/** A value with every var(…) and url(…) taken out: a var() fallback may name a colour. */
function withoutVarAndUrl(value: string): string {
  let out = '';
  for (let i = 0; i < value.length;) {
    const call = /^(?:var|url)\(/i.exec(value.slice(i));
    if (!call) { out += value[i]; i += 1; continue; }
    let depth = 0;
    let j = i + call[0].length - 1;
    for (; j < value.length; j += 1) {
      if (value[j] === '(') depth += 1;
      else if (value[j] === ')' && --depth === 0) break;
    }
    out += ' ';
    i = j + 1;
  }
  return out;
}

const scanned = (path: string): boolean => ![...NOT_SCANNED.keys()].some((key) => (key.endsWith('/') ? path.startsWith(key) : path === key));

test('FR-UIDS-018 AC-4: live stylesheets draw no colour of their own, outside a short list with reasons', () => {
  const allowed = ALLOWED.map(([file, selector, colour]) => `${file} | ${normalizeSelector(selector)} | ${normalize(colour)}`);
  const used = new Set<string>();
  const hits: string[] = [];
  const sheets = sourceFiles().filter((path) => path.endsWith('.css') && scanned(path));
  assert.ok(sheets.length > 30, `read ${sheets.length} stylesheets`);
  for (const file of sheets) {
    for (const rule of rules(read(file))) {
      for (const [property, value] of rule.decls) {
        const bare = withoutVarAndUrl(value);
        for (const colour of [...bare.matchAll(COLOUR_LITERAL), ...bare.matchAll(NAMED_COLOUR)].map((m) => m[0])) {
          const key = `${file} | ${rule.selectorText} | ${normalize(colour)}`;
          if (allowed.includes(key)) used.add(key);
          else hits.push(`${file}: ${rule.selectorText} { ${property}: ${colour} }`);
        }
      }
    }
  }
  assert.deepEqual(hits, [], 'inline colours; use a token from tokens.css');
  assert.deepEqual(allowed.filter((key) => !used.has(key)), [], 'stale ALLOWED entries');
});

test('FR-UIDS-018 AC-4: live scripts hold no colour literal in a string, outside the files not scanned', () => {
  const hits: string[] = [];
  const scripts = sourceFiles().filter((path) => /\.tsx?$/.test(path) && scanned(path));
  for (const file of scripts) {
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    for (const literal of code.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
      for (const colour of withoutVarAndUrl(literal[2]).matchAll(COLOUR_LITERAL)) hits.push(`${file}: ${literal[0]} -> ${colour[0]}`);
    }
  }
  assert.deepEqual(hits, [], 'colour literals in live scripts; use var(--token)');
  for (const key of NOT_SCANNED.keys()) assert.ok(existsSync(new URL(key, SRC)), `NOT_SCANNED entry ${key} no longer exists`);
});

// ---- AC-5: color-scheme ------------------------------------------------------------

test('FR-UIDS-018 AC-5: native controls follow the theme: dark by default, light under data-theme="light"', () => {
  const css = read('index.css');
  assert.equal(ruleOf(css, ':root').get('color-scheme'), 'dark');
  assert.equal(ruleOf(css, ':root[data-theme="light"]').get('color-scheme'), 'light');
});

// ---- AC-7: a night editor under the light app ---------------------------------------

test('FR-UIDS-018 AC-7: inside a night editor the first token block applies again, so its chrome stays dark', () => {
  const main = rules(TOKENS).filter((rule) => rule.selectors.includes(':root'));
  assert.equal(main.length, 1);
  assert.deepEqual(main[0].selectors, [':root[data-theme="light"] [data-editor-theme="dark"]', ':root']);
  assert.equal(ruleOf(read('index.css'), ':root[data-theme="light"] [data-editor-theme="dark"]').get('color-scheme'), 'dark');
});

test('FR-UIDS-018 AC-7: a night editor under the light app falls back to the vendored dark palette', () => {
  const vendored = [...ruleOf(read('editor/vendor/atomic-editor/styles/inline-preview.css'), '[data-theme="light"] .atomic-cm-editor').keys()]
    .filter((name) => name.startsWith('--atomic-editor-'));
  assert.ok(vendored.length >= 30, `the vendored light block read with ${vendored.length} variables`);
  const reset = ruleOf(read('components/editor/EditorWindow.css'), ':root[data-theme="light"] [data-theme="dark"] .atomic-cm-editor');
  assert.deepEqual(vendored.filter((name) => reset.get(name) !== 'initial'), [], 'vendored light variables a night editor would still take');
  assert.deepEqual([...reset.keys()].filter((name) => !vendored.includes(name)), [], 'only the vendored light variables are reset');
});
