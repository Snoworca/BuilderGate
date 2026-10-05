// Fenced code blocks and Ctrl+B in the markdown editor, measured in a real browser.
// Reported 2026-10-04: a plain ``` fence should read as a grey block, a fence with a
// language (```java, ```python) should be syntax highlighted, and Ctrl+B should toggle bold
// on and off.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test, expect, type Locator, type Page } from '@playwright/test';

import { login } from './helpers';

const TAB_NAME_PREFIX = 'e2e-mde-code';
const createdDirs: string[] = [];

const DOC = [
  '# code blocks',
  '',
  'intro line',
  '',
  '```',
  'plain fenced text',
  '```',
  '',
  '```java',
  'public class Demo { private int count = 42; }',
  '```',
  '',
  '```python',
  'def greet(name): return "hi " + name',
  '```',
  '',
  'bold target',
  '',
  '```json',
  '{ "name": "demo", "count": 42, "ok": true }',
  '```',
  '',
  '```xml',
  '<project version="1"><name>demo</name></project>',
  '```',
  '',
  '```yaml',
  'name: demo  # comment',
  '```',
  '',
  '```elixir',
  'defmodule Demo do def run(x), do: x + 1 end',
  '```',
  '',
].join('\n');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeWorkdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-mdcode-'));
  writeFileSync(join(dir, 'CLAUDE.md'), DOC, 'utf-8');
  createdDirs.push(dir);
  return dir;
}

async function ensureTabMode(page: Page): Promise<void> {
  const toTabs = page.locator('button[title="탭 보기로 전환"]');
  if (await toTabs.count()) await toTabs.click();
  await expect(page.locator('button[title="그리드 보기로 전환"]')).toBeVisible({ timeout: 15000 });
}

async function activeWorkspaceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const token = localStorage.getItem('cws_auth_token');
    const stored = localStorage.getItem('active_workspace_id');
    const res = await fetch('/api/workspaces', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`workspace fetch failed: ${res.status}`);
    const state = await res.json();
    const workspace = state.workspaces.find((item: { id: string }) => item.id === stored) ?? state.workspaces[0];
    return workspace.id as string;
  });
}

async function addTabAt(page: Page, workspaceId: string, cwd: string, name: string): Promise<void> {
  await page.evaluate(async ({ workspaceId, cwd, name }) => {
    const token = localStorage.getItem('cws_auth_token');
    const res = await fetch(`/api/workspaces/${workspaceId}/tabs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ name, cwd }),
    });
    if (!res.ok) throw new Error(`tab create failed: ${res.status}`);
  }, { workspaceId, cwd, name });
}

async function removeOwnTabs(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(async ({ workspaceId, prefix }) => {
    const token = localStorage.getItem('cws_auth_token');
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch('/api/workspaces', { headers });
    if (!res.ok) return;
    const state = await res.json();
    const owned = state.tabs.filter((tab: { id: string; name?: string; workspaceId?: string }) =>
      typeof tab.name === 'string' && tab.name.startsWith(prefix)
      && (tab.workspaceId === undefined || tab.workspaceId === workspaceId));
    for (const tab of owned) {
      await fetch(`/api/workspaces/${workspaceId}/tabs/${tab.id}`, { method: 'DELETE', headers });
    }
  }, { workspaceId, prefix: TAB_NAME_PREFIX });
}

async function openDoc(page: Page, workspaceId: string, label: string): Promise<Locator> {
  const workdir = makeWorkdir();
  const name = `${TAB_NAME_PREFIX}-${label}`;
  await addTabAt(page, workspaceId, workdir, name);
  await page.locator('.workspace-tabbar [role="tab"]', { hasText: name }).first().click();
  await expect(page.locator('.metadata-cwd-path:visible').first())
    .toHaveAttribute('title', new RegExp(escapeRegExp(workdir), 'i'), { timeout: 30000 });
  await page.locator('.metadata-cwd-path:visible').first().click({ button: 'right' });
  const menu = page.locator('.context-menu[role="menu"]').first();
  await expect(menu).toBeVisible({ timeout: 10000 });
  await menu.locator('.context-menu-item').filter({ has: page.getByText('CLAUDE.md', { exact: true }) }).first().click();
  const surface = page.locator('.window-dialog-surface.editor-window-surface').first();
  await expect(surface.locator('.cm-content').first()).toBeVisible({ timeout: 15000 });
  return surface;
}

/** The painted background of the first editor line containing `text`, walking up to the first non-transparent ancestor. */
async function lineBackground(surface: Locator, text: string): Promise<string> {
  return surface.locator('.cm-line', { hasText: text }).first().evaluate((line) => {
    let el: Element | null = line;
    while (el) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
      el = el.parentElement;
    }
    return 'none';
  });
}

/** Distinct text colours used inside the element(s) holding `text`, rendered either as editor lines or as a highlighted widget. */
async function colourCount(surface: Locator, text: string): Promise<number> {
  return surface.locator('.cm-content').first().evaluate((content, needle) => {
    const hosts = [...content.querySelectorAll('.cm-line, pre')].filter((el) => el.textContent?.includes(needle));
    // The colour each piece of text is painted in: that of the element directly holding it.
    // Counting every element's colour would also count an outer span whose colour an inner
    // span overrides, which is how a one-colour line once passed this check.
    const colours = new Set<string>();
    for (const host of hosts) {
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent?.trim() && node.parentElement) colours.add(getComputedStyle(node.parentElement).color);
      }
    }
    return colours.size;
  }, text);
}

function rgb(value: string): [number, number, number] | null {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(value);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Neutral (channels within 6) and at least 8 levels darker than the page. */
function isVisibleGrey(value: string, page: string): boolean {
  const c = rgb(value);
  const p = rgb(page);
  if (!c || !p) return false;
  const spread = Math.max(...c) - Math.min(...c);
  const darker = (p[0] + p[1] + p[2]) / 3 - (c[0] + c[1] + c[2]) / 3;
  return spread <= 6 && darker >= 8;
}

test.describe('markdown editor code blocks and bold', () => {
  let workspaceId: string | null = null;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'Desktop Chrome', 'Desktop-only');
    await login(page);
    await ensureTabMode(page);
    workspaceId = await activeWorkspaceId(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.project.name !== 'Desktop Chrome' || workspaceId === null) return;
    try { await removeOwnTabs(page, workspaceId); } catch { /* not a test result */ }
  });

  test.afterAll(() => {
    for (const dir of createdDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* reclaimed by the OS */ }
    }
  });

  test('a plain fence is a grey block and a fence with a language is highlighted', async ({ page }) => {
    const surface = await openDoc(page, workspaceId!, 'fence');
    // Put the cursor on the intro line, outside every block.
    await surface.locator('.cm-line', { hasText: 'intro line' }).first().click();
    await page.waitForTimeout(1500); // shiki loads its grammar asynchronously
    await page.screenshot({ path: '../.playwright-mcp/mde-codeblock-outside.png' });

    const pageBg = await surface.locator('.cm-line', { hasText: 'intro line' }).first().evaluate((line) => {
      let el: Element | null = line;
      while (el) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
        el = el.parentElement;
      }
      return 'none';
    });
    const plainBg = await lineBackground(surface, 'plain fenced text');
    const javaColours = await colourCount(surface, 'private int count');
    const pythonColours = await colourCount(surface, 'def greet');
    const widgetBg = await surface.locator('pre.dl-code').first().evaluate((el) => getComputedStyle(el).backgroundColor).catch(() => 'none');
    console.log(`outside: page=${pageBg} plain=${plainBg} widget=${widgetBg} javaColours=${javaColours} pythonColours=${pythonColours}`);

    // Cursor inside the java block: the source is shown, and must still be highlighted.
    await surface.locator('pre.dl-code[data-language="java"]').first().click();
    // The block is revealed as source only when the cursor is really in it.
    await expect(surface.locator('.cm-line', { hasText: '```java' }).first(), 'the java fence is revealed as source').toBeVisible();
    await expect(surface.locator('pre.dl-code[data-language="java"]')).toHaveCount(0);
    await page.waitForTimeout(800); // the java grammar loads lazily
    await page.screenshot({ path: '../.playwright-mcp/mde-codeblock-inside.png' });
    const javaInside = await colourCount(surface, 'private int count');
    const plainInsideBg = await lineBackground(surface, 'plain fenced text');
    console.log(`inside java: javaColours=${javaInside} plain=${plainInsideBg}`);

    // Grey, not merely different: the old faint lavender (#f3f1fb) also differed from white.
    expect(isVisibleGrey(plainBg, pageBg), `a plain fence is a visible grey block (${plainBg} on ${pageBg})`).toBe(true);
    expect(isVisibleGrey(widgetBg, pageBg), `a highlighted fence is the same grey block (${widgetBg})`).toBe(true);
    expect(javaColours, 'java is highlighted with the cursor outside').toBeGreaterThan(2);
    expect(pythonColours, 'python is highlighted with the cursor outside').toBeGreaterThan(2);
    expect(javaInside, 'java is highlighted with the cursor inside').toBeGreaterThan(2);
  });

  // FR-MDE-026 AC-4: data formats, and a language CodeMirror has no parser for (elixir).
  for (const [language, sample] of [
    ['json', '"count": 42'],
    ['xml', '<name>demo</name>'],
    ['yaml', 'name: demo'],
    ['elixir', 'defmodule Demo'],
  ] as const) {
    test(`a ${language} fence is highlighted outside and inside the block`, async ({ page }) => {
      const surface = await openDoc(page, workspaceId!, `lang-${language}`);
      await surface.locator('.cm-line', { hasText: 'intro line' }).first().click();
      const widget = surface.locator(`pre.dl-code[data-language="${language}"]`).first();
      await widget.scrollIntoViewIfNeeded();
      await expect.poll(() => colourCount(surface, sample), { timeout: 10_000, message: `${language} outside` }).toBeGreaterThan(2);
      await widget.click();
      await expect(surface.locator('.cm-line', { hasText: '```' + language }).first(), `${language} revealed as source`).toBeVisible();
      await expect.poll(() => colourCount(surface, sample), { timeout: 10_000, message: `${language} inside` }).toBeGreaterThan(2);
      await page.screenshot({ path: `../.playwright-mcp/mde-codeblock-${language}-inside.png` });
    });
  }

  test('Ctrl+B makes the selection bold and a second Ctrl+B removes it', async ({ page }) => {
    const surface = await openDoc(page, workspaceId!, 'bold');
    const line = surface.locator('.cm-line', { hasText: 'bold target' }).first();
    await line.click();
    await page.keyboard.press('End');
    for (let i = 0; i < 'target'.length; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    const docText = () => surface.locator('.cm-content').first().evaluate((el) => {
      const view = (el as HTMLElement & { cmView?: { view?: { state: { doc: { toString(): string } } } } }).cmView?.view;
      return view ? view.state.doc.toString() : (el as HTMLElement).innerText;
    });
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(300);
    const afterFirst = await docText();
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(300);
    const afterSecond = await docText();
    console.log(`after 1st: ${JSON.stringify(afterFirst.split('\n').find((l) => l.includes('target')))}`);
    console.log(`after 2nd: ${JSON.stringify(afterSecond.split('\n').find((l) => l.includes('target')))}`);
    expect(afterFirst).toContain('bold **target**');
    expect(afterSecond).toContain('bold target');
    expect(afterSecond).not.toContain('**target**');
  });
});
