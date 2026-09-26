import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type * as EditorThemeModule from '../../src/components/editor/editorTheme.ts';
import type * as EditorPathLabelModule from '../../src/components/editor/editorPathLabel.ts';

// FR-MDE-020 -- the one-line toolbar above each editor document: the absolute
// path on the left (click copies, `...\name` when it does not fit), the
// light/dark toggle on the right, and code mode's wrap toggle as an icon to its
// right; code documents use the full width of the editing area.
//
// Contracts fixed here:
//   editorTheme.ts
//     THEME_PREFERENCE_KEY
//     readThemePreference(storage?) -> 'light' | 'dark'   (light unless 'dark' is stored)
//     writeThemePreference(theme, storage?)
//   editorPathLabel.ts
//     pathFileName(path)        -> the last segment
//     truncatedPathLabel(path)  -> '...' + separator + name, using the path's own separator
//   EditorDocumentToolbar.tsx
//     props { filePath, theme, onToggleTheme, wrap?, onToggleWrap? }
//     the wrap button renders only when onToggleWrap is given
//
// Modules are imported inside the tests so a missing one fails its own cases
// rather than the whole runner.
const testDir = dirname(fileURLToPath(import.meta.url));
const editorDir = resolve(testDir, '../../src/components/editor');
const read = (name: string): string => readFileSync(resolve(editorDir, name), 'utf8');

async function themeModule(): Promise<typeof EditorThemeModule> {
  return await import('../../src/components/editor/editorTheme.ts') as typeof EditorThemeModule;
}
async function pathModule(): Promise<typeof EditorPathLabelModule> {
  return await import('../../src/components/editor/editorPathLabel.ts') as typeof EditorPathLabelModule;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
}

// TC-REQ-FR-MDE-020-AC4-01
test('TC-REQ-FR-MDE-020-AC4-01: the theme preference defaults to light and round-trips dark', async () => {
  const mod = await themeModule();
  assert.equal(mod.readThemePreference(memoryStorage()), 'light');
  assert.equal(mod.readThemePreference(memoryStorage({ [mod.THEME_PREFERENCE_KEY]: 'nonsense' })), 'light');

  const storage = memoryStorage();
  mod.writeThemePreference('dark', storage);
  assert.equal(storage.data.get(mod.THEME_PREFERENCE_KEY), 'dark');
  assert.equal(mod.readThemePreference(storage), 'dark');
  mod.writeThemePreference('light', storage);
  assert.equal(mod.readThemePreference(storage), 'light');
});

// TC-REQ-FR-MDE-020-AC4-02
test('TC-REQ-FR-MDE-020-AC4-02: blocked storage reads as light and a failed write does not throw', async () => {
  const mod = await themeModule();
  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  assert.equal(mod.readThemePreference(broken), 'light');
  assert.equal(mod.readThemePreference(null), 'light');
  assert.doesNotThrow(() => mod.writeThemePreference('dark', broken));
});

// TC-REQ-FR-MDE-020-AC6-01
test('TC-REQ-FR-MDE-020-AC6-01: a long path shortens to ...<sep><file name> with the path\'s own separator', async () => {
  const mod = await pathModule();
  assert.equal(mod.pathFileName('C:\\work\\git\\project\\src\\index.ts'), 'index.ts');
  assert.equal(mod.truncatedPathLabel('C:\\work\\git\\project\\src\\index.ts'), '...\\index.ts');
  assert.equal(mod.pathFileName('/home/me/notes/README.md'), 'README.md');
  assert.equal(mod.truncatedPathLabel('/home/me/notes/README.md'), '.../README.md');
  // A mixed path keeps the separator that precedes the name.
  assert.equal(mod.truncatedPathLabel('C:/work\\a/b.txt'), '.../b.txt');
});

// TC-REQ-FR-MDE-020-AC3-01
test('TC-REQ-FR-MDE-020-AC3-01: the toolbar draws moon/sun SVG icons and puts the theme toggle left of the wrap toggle', () => {
  const src = read('EditorDocumentToolbar.tsx');
  assert.match(src, /editor-theme-toggle/);
  assert.match(src, /editor-code-wrap-toggle/);
  // AC-3 / AC-8: theme, then the file tree toggle, then wrap at the right end.
  assert.ok(src.indexOf('editor-theme-toggle') < src.indexOf('editor-tree-toggle'),
    'the theme toggle must render before (left of) the file tree toggle');
  assert.ok(src.indexOf('editor-tree-toggle') < src.indexOf('editor-code-wrap-toggle'),
    'the file tree toggle must render before (left of) the wrap toggle');
  assert.match(src, /MoonIcon|data-icon="moon"/);
  assert.match(src, /SunIcon|data-icon="sun"/);
  assert.ok((src.match(/<svg\b/g) ?? []).length >= 3, 'moon, sun and wrap each need an <svg>');
});

// TC-REQ-FR-MDE-020-AC2-01
test('TC-REQ-FR-MDE-020-AC2-01: the wrap toggle is an icon button, not a text label', () => {
  for (const file of ['EditorDocumentToolbar.tsx', 'SvgFileTab.tsx', 'EditorDocumentPanel.tsx']) {
    const src = read(file);
    assert.doesNotMatch(src, /줄 바꿈 \{wrap \? '켜짐' : '꺼짐'\}/, `${file} still renders the text wrap button`);
  }
  const toolbar = read('EditorDocumentToolbar.tsx');
  assert.match(toolbar, /aria-pressed=\{wrap\}/);
  assert.match(toolbar, /onToggleWrap\s*!==\s*undefined|onToggleWrap\s*&&|onToggleWrap\s*\?/,
    'the wrap button renders only when onToggleWrap is given');
  const svg = read('SvgFileTab.tsx');
  assert.match(svg, /WrapIcon/, 'the SVG source view uses the same wrap icon');
});

// TC-REQ-FR-MDE-020-AC5-01
test('TC-REQ-FR-MDE-020-AC5-01: the panel draws the toolbar, with the wrap toggle for code mode only', () => {
  const panel = read('EditorDocumentPanel.tsx');
  assert.match(panel, /<EditorDocumentToolbar\b/);
  assert.match(panel, /onToggleWrap=\{view === 'code' \? toggleWrap : undefined\}/);
  assert.match(panel, /filePath=\{filePath\}/);
});

// TC-REQ-FR-MDE-020-AC4-03
test('TC-REQ-FR-MDE-020-AC4-03: the editor host follows the theme preference instead of a fixed light theme', () => {
  const panel = read('EditorDocumentPanel.tsx');
  assert.doesNotMatch(panel, /data-theme="light"/);
  assert.match(panel, /data-theme=\{theme\}/);
  assert.match(panel, /useEditorTheme\(\)/);
  const hook = read('useEditorTheme.ts');
  assert.match(hook, /readThemePreference\(\)/);
  assert.match(hook, /writeThemePreference\(/);
  const svg = read('SvgFileTab.tsx');
  assert.doesNotMatch(svg, /data-theme="light"/);
});

// TC-REQ-FR-MDE-020-AC7-01
test('TC-REQ-FR-MDE-020-AC7-01: clicking the path copies the full path and shows it was copied', () => {
  const src = read('EditorDocumentToolbar.tsx');
  assert.match(src, /clipboard\??\.writeText\(filePath\)/);
  assert.match(src, /editor-document-path/);
  assert.match(src, /title=\{copied \? COPIED_TITLE : filePath\}/);
  // Same as the session path at the bottom (MetadataRow): the label itself
  // reads '✓ 복사됨' for 1.5s, then the path comes back; the tooltip reads
  // '복사됨' meanwhile (FR-UIDS-003 AC-1 moved both off 'Copied').
  assert.match(src, /COPIED_LABEL = '✓ 복사됨'/);
  assert.match(src, /COPIED_TITLE = '복사됨'/);
  assert.match(src, /1500/);
  assert.doesNotMatch(src, /'✓ Copied'|'Copied!'/);
  const metadata = readFileSync(resolve(testDir, '../../src/components/MetadataBar/MetadataRow.tsx'), 'utf8');
  assert.match(metadata, /'✓ 복사됨'/, 'the session path uses the same label');
  assert.match(metadata, /title=\{copied \? '복사됨'/, 'the session path uses the same tooltip');
  assert.doesNotMatch(metadata, /'✓ Copied'|'Copied!'/);
});

// TC-REQ-FR-MDE-020-AC8-01
test('TC-REQ-FR-MDE-020-AC8-01: the file tree toggle moved from the title bar to the document toolbar', () => {
  const win = read('EditorWindow.tsx').replace(/\r\n/g, '\n');
  const actionsStart = win.indexOf('const titlebarActions');
  assert.ok(actionsStart >= 0, 'titlebarActions is gone');
  // The titlebarActions element ends at its own closing `</div>` + `);`.
  const actionsEnd = win.replace(/\r\n/g, '\n').indexOf('</div>\n  );', actionsStart);
  assert.ok(actionsEnd > actionsStart, 'titlebarActions end not found');
  const actions = win.slice(actionsStart, actionsEnd);
  assert.doesNotMatch(actions, /파일 트리/, 'the title bar no longer carries the file tree toggle');
  // The window hands the toggle to each document panel, which hands it to the toolbar.
  assert.match(win, /paneToggle=\{paneToggle\}/);
  const panel = read('EditorDocumentPanel.tsx');
  assert.match(panel, /paneToggle=\{paneToggle\}/);
  const toolbar = read('EditorDocumentToolbar.tsx');
  assert.match(toolbar, /editor-tree-toggle/);
  assert.match(toolbar, /aria-pressed=\{paneToggle\.pressed\}/);
  assert.match(toolbar, /disabled=\{paneToggle\.disabled\}/);
  assert.match(toolbar, /onClick=\{paneToggle\.onToggle\}/);
});

// TC-REQ-FR-MDE-020-AC9-01
test('TC-REQ-FR-MDE-020-AC9-01: dark mode reaches the tab bar and the file tree pane', () => {
  const win = read('EditorWindow.tsx');
  assert.match(win, /useEditorTheme\(\)/);
  assert.match(win, /className="editor-window-row"[^>]*data-editor-theme=\{theme\}/);
  assert.doesNotMatch(win, /data-surface="paper"/, 'the splitter follows the theme');
  const pane = read('EditorFileTreePane.tsx');
  assert.doesNotMatch(pane, /data-surface="paper"/, 'the pane follows the theme');
  assert.match(pane, /data-surface=\{theme === 'light' \? 'paper' : undefined\}/);
  const css = read('EditorWindow.css');
  assert.match(css, /\.editor-window-row\[data-editor-theme='dark'\][^{]*\.editor-tab-bar\b[^{]*\{/);
  assert.match(css, /\.editor-window-row\[data-editor-theme='dark'\][^{]*\.editor-tab\.is-active[^{]*\{/);
});

// TC-REQ-FR-MDE-020-AC1-01
test('TC-REQ-FR-MDE-020-AC1-01: code documents drop the centred reading column; markdown keeps it', () => {
  const css = read('EditorWindow.css');
  assert.match(css, /\[data-editor-mode='code'\][^{]*\.atomic-cm-editor[^{]*\{[^}]*--atomic-editor-measure:\s*none/);
  assert.match(css, /\.svg-file-tab-source[^{]*\.atomic-cm-editor[^{]*\{[^}]*--atomic-editor-measure:\s*none/);
  // The markdown column stays as it was.
  assert.match(css, /--atomic-editor-measure:\s*min\(95%,\s*1200px\)/);
  const panel = read('EditorDocumentPanel.tsx');
  assert.match(panel, /view === 'markdown' \? EDITOR_HOST_STYLE : FULL_HOST_STYLE/);
});

// TC-REQ-FR-MDE-020-AC10-01
test('TC-REQ-FR-MDE-020-AC10-01: the Ctrl+F search panel buttons, fields and checkboxes read the surface tokens', () => {
  const css = read('EditorWindow.css');
  const rule = (selector: RegExp) => {
    const m = css.match(new RegExp(`${selector.source}[^{]*\\{([^}]*)\\}`));
    assert.ok(m, `no rule for ${selector}`);
    return m![1];
  };
  const button = rule(/\.cm-panel\.cm-search \.cm-button/);
  assert.match(button, /background-image:\s*none/);
  assert.match(button, /background:\s*var\(--bg-surface\)/);
  assert.match(button, /color:\s*var\(--fg\)/);
  const field = rule(/\.cm-panel\.cm-search \.cm-textfield/);
  assert.match(field, /background:\s*var\(--bg-surface\)/);
  const checkbox = rule(/\.cm-panel\.cm-search input\[type='checkbox'\]/);
  assert.match(checkbox, /accent-color:\s*var\(--accent\)/);
  assert.match(css, /\[data-editor-theme='dark'\] \.cm-panel\.cm-search input\[type='checkbox'\][^{]*\{[^}]*color-scheme:\s*dark/);
  // No new colour values: every declaration in the search rules is a token.
  const searchRules = [...css.matchAll(/[^}]*\.cm-search[^{]*\{([^}]*)\}/g)].map(m => m[1]).join('\n');
  assert.doesNotMatch(searchRules, /#[0-9a-f]{3,8}\b|rgb\(/i);
});
