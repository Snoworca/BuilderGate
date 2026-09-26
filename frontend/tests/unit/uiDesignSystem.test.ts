import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ICON_GLYPHS, isIconName } from '../../src/components/common/iconGlyphs.ts';
import {
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  CHIP_TONES,
  buttonClassName,
  chipClassName,
  containsHangul,
} from '../../src/components/ui/uiClasses.ts';

// CON-UIDS-001, FR-UIDS-001..004, NFR-UIDS-001 — the design system layer.
//
// There is no DOM harness here, so the layer is judged by what it declares:
// the token values the SRS fixes, the icon names the screens draw, the class
// rules the shared parts apply, and — for every file already moved onto the
// system — the absence of the hard-coded values and English copy the move
// exists to remove. A file joins MIGRATED when its move is done; the guard is
// what keeps it moved.

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rootBlock(source: string): string {
  const css = stripCssComments(source);
  const at = css.indexOf(':root');
  assert.notEqual(at, -1, ':root not found');
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error('unterminated :root');
}

function declared(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const tokens = declared(rootBlock(read('../../src/styles/tokens.css')));

test('CON-UIDS-001 AC-1..AC-7: size, weight, spacing, control, icon, radius and font tokens hold the SRS values', () => {
  const expected: Record<string, string> = {
    '--fs-2xs': '11px', '--fs-xs': '12px', '--fs-sm': '13px', '--fs-md': '14px', '--fs-lg': '16px', '--fs-xl': '18px',
    '--fw-regular': '400', '--fw-semibold': '600', '--fw-bold': '700',
    '--sp-1': '4px', '--sp-2': '8px', '--sp-3': '12px', '--sp-4': '16px', '--sp-5': '20px', '--sp-6': '24px', '--sp-8': '32px',
    '--ctl-sm': '28px', '--ctl-md': '32px', '--ctl-lg': '36px', '--ctl-touch': '44px',
    '--icon-sm': '16px', '--icon-md': '18px', '--icon-lg': '20px',
    '--r-pill': '999px',
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(tokens.get(name), value, `${name} should be ${value}`);
  }
  assert.match(tokens.get('--font-sans') ?? '', /Segoe UI/);
  assert.match(tokens.get('--font-mono') ?? '', /Cascadia Code/);
  // AC-1: no half pixels on the type scale.
  for (const [name, value] of tokens) {
    if (name.startsWith('--fs-')) assert.doesNotMatch(value, /\.\d/, `${name} is a half pixel`);
  }
});

test('NFR-UIDS-001 AC-5: text-on-dark meaning colours and the danger fill exist with the measured values', () => {
  assert.equal(tokens.get('--accent-text'), '#6cb6ff');
  assert.equal(tokens.get('--ok-text'), '#4cc38a');
  assert.equal(tokens.get('--warn-text'), '#e2b451');
  assert.equal(tokens.get('--danger-text'), '#ec8f8f');
  assert.equal(tokens.get('--danger-fill'), '#c94a4a');
  assert.ok(tokens.has('--accent-hover'), '--accent-hover is declared');
  assert.ok(tokens.has('--focus-ring'), '--focus-ring is declared');
});

test('FR-UIDS-001 AC-1: the shared icon set names every glyph the screens draw', () => {
  const required = [
    'menu', 'folder', 'document', 'terminal', 'grid', 'tabs', 'bookmark', 'bookmark-plus', 'bookmark-check',
    'resume', 'refresh', 'check', 'close', 'plus', 'trash', 'edit', 'copy', 'search', 'chevron-down',
    'chevron-right', 'more', 'tools', 'settings', 'power', 'alert', 'info', 'check-circle', 'lock', 'keyboard',
    'plug', 'maximize', 'minimize', 'restore', 'sidebar', 'save', 'external', 'download',
  ];
  for (const name of required) {
    assert.equal(isIconName(name), true, `${name} is missing from the icon set`);
    for (const d of ICON_GLYPHS[name as keyof typeof ICON_GLYPHS].paths) {
      assert.match(d, /^M/, `${name} has a path that is not path data`);
    }
  }
});

test('FR-UIDS-002 AC-1: buttons come in four variants and three sizes, and the class rule names both', () => {
  assert.deepEqual([...BUTTON_VARIANTS], ['primary', 'secondary', 'danger', 'danger-text']);
  assert.deepEqual([...BUTTON_SIZES], ['sm', 'md', 'lg']);
  assert.equal(buttonClassName('primary', 'lg'), 'ui-button ui-button-primary ui-button-lg');
  assert.equal(buttonClassName('secondary', 'sm', 'extra'), 'ui-button ui-button-secondary ui-button-sm extra');
});

test('FR-UIDS-002 AC-2: chips carry one of five tones', () => {
  assert.deepEqual([...CHIP_TONES], ['neutral', 'accent', 'ok', 'warn', 'danger']);
  assert.equal(chipClassName('warn'), 'ui-chip ui-chip-warn');
});

test('FR-UIDS-002: every shared part exists and is exported', () => {
  const index = read('../../src/components/ui/index.ts');
  for (const name of [
    'Button', 'Chip', 'Badge', 'Field', 'TextInput', 'NumberInput', 'Select', 'Switch', 'Checkbox',
    'DialogHeader', 'DialogFooter', 'SelectableRow', 'ProgressBar', 'Banner',
  ]) {
    assert.match(index, new RegExp(`\\b${name}\\b`), `${name} is not exported from components/ui`);
  }
  const css = stripCssComments(read('../../src/components/ui/ui.css'));
  assert.match(css, /:focus-visible/, 'FR-UIDS-002 AC-6: shared parts draw a focus ring');
  assert.match(read('../../src/index.css'), /components\/ui\/ui\.css/, 'ui.css reaches the application');
});

test('FR-UIDS-003 helper: Hangul detection', () => {
  assert.equal(containsHangul('도구'), true);
  assert.equal(containsHangul('Tools'), false);
});

// ---------------------------------------------------------------------------
// The migration guard (CON-UIDS-001 AC-8, FR-UIDS-001 AC-2, FR-UIDS-003 AC-1,
// FR-UIDS-004 AC-4). Paths are relative to frontend/src.
// ---------------------------------------------------------------------------

export const MIGRATED: readonly string[] = [
  'components/ui/ui.css',
  'components/ui/Button.tsx',
  'components/ui/Chip.tsx',
  'components/ui/Field.tsx',
  'components/ui/DialogParts.tsx',
  'components/ui/SelectableRow.tsx',
  'components/ui/ProgressBar.tsx',
  'components/ui/Banner.tsx',
  'components/common/IconButton.css',
  'App.tsx',
  'components/Auth/Auth.css',
  'components/Auth/AuthGuard.tsx',
  'components/Auth/BootstrapPasswordForm.tsx',
  'components/Auth/LoginForm.tsx',
  'components/Auth/TwoFactorForm.tsx',
  'components/CommandPresetManager/CommandPresetDialog.css',
  'components/CommandPresetManager/CommandPresetDialog.tsx',
  'components/ContextMenu/ContextMenu.css',
  'components/ContextMenu/ContextMenu.tsx',
  'components/Grid/MosaicContainer.tsx',
  'components/Grid/MosaicToolbar.css',
  'components/Grid/MosaicToolbar.tsx',
  'components/Header/Header.css',
  'components/Header/Header.tsx',
  'components/McpControlManager/McpControlDialog.css',
  'components/McpControlManager/McpControlDialog.tsx',
  'components/Modal/ConfirmModal.css',
  'components/Modal/ConfirmModal.tsx',
  'components/Modal/RenameModal.css',
  'components/Modal/RenameModal.tsx',
  'components/RecoveryOptionManager/RecoveryOptionDialog.tsx',
  'components/SessionSave/AgentMark.tsx',
  'components/SessionSave/SessionRestoreBanner.tsx',
  'components/SessionSave/SessionRestoreDialog.tsx',
  'components/SessionSave/SessionSave.css',
  'components/SessionSave/SessionSaveButton.tsx',
  'components/SessionSave/SessionSaveDialog.tsx',
  'components/Settings/SettingsPage.css',
  'components/Settings/SettingsPage.tsx',
  'components/TerminalShortcutManager/ShortcutActionEditor.tsx',
  'components/TerminalShortcutManager/ShortcutBindingList.tsx',
  'components/TerminalShortcutManager/ShortcutCapturePanel.tsx',
  'components/TerminalShortcutManager/TerminalShortcutDialog.css',
  'components/TerminalShortcutManager/TerminalShortcutDialog.tsx',
  'components/Workspace/DisconnectedOverlay.tsx',
  'components/Workspace/EmptyState.tsx',
  'components/Workspace/MobileDrawer.tsx',
  'components/Workspace/Workspace.css',
  'components/Workspace/WorkspaceItem.tsx',
  'components/Workspace/WorkspaceMoveDialog.css',
  'components/Workspace/WorkspaceMoveDialog.tsx',
  'components/Workspace/WorkspaceSidebar.tsx',
  'components/Workspace/WorkspaceTabBar.css',
  'components/Workspace/WorkspaceTabBar.tsx',
  'components/dialog/MessageBox.css',
  'components/dialog/MessageBox.tsx',
  'components/dialog/WindowDialog.css',
  'components/dialog/WindowDialog.tsx',
  'components/editor/EditorDocumentPanel.tsx',
  'components/editor/EditorDocumentToolbar.tsx',
  'components/editor/EditorFileTreePane.tsx',
  'components/editor/EditorTabBar.tsx',
  'components/editor/EditorWindow.css',
  'components/editor/EditorWindow.tsx',
  'components/editor/ImageFileViewer.css',
  'components/editor/ImageFileViewer.tsx',
  'components/editor/SvgFileTab.tsx',
  'components/fileExplorer/FileExplorer.css',
  'components/fileExplorer/FileExplorerPathBar.tsx',
  'components/fileExplorer/FileExplorerProgressRow.tsx',
  'components/fileExplorer/FileExplorerTabBar.tsx',
  'components/fileExplorer/FileJobPopover.tsx',
  'components/fileExplorer/FileJobStatus.css',
  'components/fileExplorer/FileListView.tsx',
  'components/fileExplorer/FileTreeView.tsx',
];

/**
 * FR-UIDS-004 AC-6: the session terminal area keeps its look, so these stay off
 * the list. They were given Korean text and equal-value tokens only.
 */
const FROZEN_TERMINAL_AREA: readonly string[] = [
  'components/Grid/MosaicTile.tsx',
  'components/Grid/MosaicOverrides.css',
  'components/MetadataBar/MetadataRow.tsx',
  // The terminal tiles' focus and output borders (white, and the green used
  // when a tab has no colour of its own).
  'components/Workspace/breathing.css',
];

/**
 * Narrow exemptions, each with the reason it is not an icon or a colour choice
 * of this layer. Anything else in these files is still checked.
 */
const GLYPH_EXEMPT: Readonly<Record<string, string>> = {
  // The built-in recovery icons are values a user picks and the server stores;
  // recoveryOptionIcon.test.ts (SEC-AITUI-002 AC-2) pins those literals.
  'components/RecoveryOptionManager/RecoveryOptionDialog.tsx': 'user-data emoji',
};

/** `✓ 복사됨`: a text mark in front of Korean copy, kept for the copy feedback E2E reads. */
const TEXT_MARK = /✓(?= [\uac00-\ud7a3])/gu;

/** The editor window re-binds the vendored editor's own palette, which is not ours to tokenize. */
const VENDORED_PALETTE = /--atomic-editor-[a-z0-9-]+\s*:\s*#[0-9a-fA-F]{3,8}\b/g;

/** Proper nouns, commands and paths that stay as written (FR-UIDS-003 AC-1). */
const ENGLISH_ALLOWED = /^(BuilderGate|Claude|Codex|Hermes|OpenCode|MCP|ConPTY|TERM|CORS|PowerShell|cmd|bash|zsh|WSL|JWT|TOTP|OTP|IP|URL|HTTP|HTTPS|SSH|PTY|ID|OK|AI|CLI|API|UUID|Ctrl|Shift|Alt|Enter|Esc|Tab|x|X|\s|[0-9.:/_\\+\-()[\]{}%·,|…])+$/;

function src(relativePath: string): string {
  return readFileSync(new URL(`../../src/${relativePath}`, import.meta.url), 'utf8');
}

test('guard: every migrated file exists', () => {
  for (const file of MIGRATED) {
    assert.equal(existsSync(new URL(`../../src/${file}`, import.meta.url)), true, `${file} is listed but missing`);
  }
});

test('guard FR-UIDS-004 AC-6: the session terminal area is not on the list', () => {
  for (const file of MIGRATED) {
    assert.equal(FROZEN_TERMINAL_AREA.includes(file) || file.startsWith('components/Terminal/'), false, `${file} is in the frozen terminal area`);
  }
});

test('guard CON-UIDS-001 AC-8: migrated files hold no hex colour, raw font size or raw radius', () => {
  for (const file of MIGRATED) {
    const text = (file.endsWith('.css') ? stripCssComments(src(file)) : src(file).replace(/\/\/.*$/gm, '')).replace(VENDORED_PALETTE, '');
    assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/, `${file} has a hex colour`);
    assert.doesNotMatch(text, /font-?[sS]ize['"]?\s*:\s*['"]?\d/, `${file} has a raw font size`);
    assert.doesNotMatch(text, /border-?[rR]adius['"]?\s*:\s*['"]?[1-9]\d*px/, `${file} has a raw radius`);
  }
});

test('guard FR-UIDS-001 AC-2: migrated files draw no letter or emoji icons', () => {
  for (const file of MIGRATED.filter((f) => f.endsWith('.tsx') && !(f in GLYPH_EXEMPT))) {
    assert.doesNotMatch(src(file).replace(TEXT_MARK, ''), /[⊞☰✕✓×▶◀▲▼⟳↻★☆✎⋯]|\p{Extended_Pictographic}/u, `${file} uses a glyph as an icon`);
  }
});

test('guard FR-UIDS-003 AC-1: user-facing strings in migrated files are Korean', () => {
  for (const file of MIGRATED.filter((f) => f.endsWith('.tsx'))) {
    const text = src(file).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/\b(?:title|aria-label|placeholder|label|alt)="([^"]+)"/g)) {
      const value = m[1];
      assert.ok(containsHangul(value) || ENGLISH_ALLOWED.test(value), `${file}: "${value}" is not Korean`);
    }
    // `=>` and `->` are code, not the end of a tag: `=> Promise<void>` is a type.
    for (const m of text.matchAll(/(?<![=\-])>\s*([A-Za-z][A-Za-z ,.'!?-]{2,})\s*</g)) {
      assert.ok(ENGLISH_ALLOWED.test(m[1]), `${file}: text "${m[1]}" is not Korean`);
    }
  }
});
