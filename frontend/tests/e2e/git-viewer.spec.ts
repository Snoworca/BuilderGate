// FR-GIT-001..010, NFR-GIT-001 (#188), end to end on 2222: a session in a git repository shows the
// branch chip; the chip opens the Git window; a commit and a file show the diff; a new file moves
// the chip's count; the keyboard alone reaches the diff; a phone stacks list, commit and diff.
//
// Runs only against the verified runtime on https://localhost:2222 with BUILDERGATE_PASSWORD.
// The repository is made with the host's git inside the owned test folder and goes with it.
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import { test, expect, type Page } from './workspaceOwnershipFixture';
import { ORIGIN, joinPath, newOwnedFolder, setUpOwnedFolder, tearDownOwnedFolder, type OwnedFolder } from './ownedFolderFixture';

const isPhone = (project: { use: { isMobile?: boolean; hasTouch?: boolean } }) =>
  project.use.isMobile === true && project.use.hasTouch === true;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
}

const chip = (page: Page) => page.locator('[data-git-chip]').first();
const gitWindow = (page: Page) => page.locator('.git-window, .git-mobile').first();
const shot = (page: Page, name: string) => page.screenshot({ path: `../.playwright-mcp/e2e-git-${name}.png` });

async function waitForChip(page: Page, text: RegExp): Promise<void> {
  // An idle session polls every 10 s; a reload asks at once.
  await expect(chip(page)).toContainText(text, { timeout: 25000 });
}

test.describe('git viewer: chip, window, diff', () => {
  let record: OwnedFolder;
  let repo: string;

  test.beforeEach(async ({ page, request }, testInfo) => {
    expect(process.env.PLAYWRIGHT_BASE_URL ?? ORIGIN, 'this spec runs only against the verified 2222 runtime').toBe(ORIGIN);
    test.setTimeout(150000);
    record = newOwnedFolder(`git-viewer/${testInfo.testId}/${testInfo.retry}/${randomUUID()}`);
    await setUpOwnedFolder(page, request, record, 'e2e-git', {
      'a.txt': 'one\ntwo\nthree\n',
    });
    repo = record.folder!;
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'first commit');
    writeFileSync(joinPath(repo, 'a.txt'), 'one\nTWO\nthree\n');
    git(repo, 'commit', '-q', '-am', 'second commit');
    writeFileSync(joinPath(repo, 'b.txt'), 'new file\n');
  });

  test.afterEach(async ({ request }) => {
    if (!record) return;
    await tearDownOwnedFolder(request, record);
  });

  // FR-GIT-001, FR-GIT-004..007, FR-GIT-009
  test('chip → window → uncommitted file → commit → diff; a new file moves the count', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop window');
    await waitForChip(page, /main/);
    await expect(chip(page)).toContainText('●1');
    await shot(page, 'chip');

    await chip(page).click();
    await expect(gitWindow(page)).toBeVisible({ timeout: 15000 });
    const worktree = gitWindow(page).locator('.git-row[data-key="WORKTREE"]');
    await expect(worktree).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await expect(gitWindow(page).locator('.git-file', { hasText: 'b.txt' })).toBeVisible({ timeout: 15000 });
    await expect(gitWindow(page).locator('.git-dl.add', { hasText: 'new file' })).toBeVisible({ timeout: 15000 });

    await gitWindow(page).locator('.git-row', { hasText: 'second commit' }).click();
    await expect(gitWindow(page).locator('.git-file', { hasText: 'a.txt' })).toBeVisible({ timeout: 15000 });
    await expect(gitWindow(page).locator('.git-dl.del', { hasText: 'two' })).toBeVisible({ timeout: 15000 });
    await expect(gitWindow(page).locator('.git-dl.add', { hasText: 'TWO' })).toBeVisible();
    await shot(page, 'window-diff');

    writeFileSync(joinPath(repo, 'c.txt'), 'another\n');
    await waitForChip(page, /●2/);
  });

  // NFR-GIT-001: the keyboard alone goes from the chip to the diff.
  test('keyboard only: chip → window → commit → file → diff', async ({ page }, testInfo) => {
    test.skip(isPhone(testInfo.project), 'desktop window');
    await waitForChip(page, /main/);
    await chip(page).focus();
    await page.keyboard.press('Enter');
    await expect(gitWindow(page)).toBeVisible({ timeout: 15000 });
    const list = gitWindow(page).locator('[data-pane="graph"] [role="listbox"]').first();
    await expect(gitWindow(page).locator('.git-row[data-key="WORKTREE"]')).toHaveAttribute('aria-selected', 'true', { timeout: 15000 });
    await list.focus();
    await expect(list).toBeFocused();
    // The commit rows arrive after the uncommitted row; a key pressed before them has nowhere to go.
    await expect(gitWindow(page).locator('.git-row', { hasText: 'second commit' })).toBeVisible({ timeout: 15000 });
    await page.keyboard.press('ArrowDown');
    await expect(gitWindow(page).locator('.git-row[aria-selected="true"]')).toContainText('second commit');
    const files = gitWindow(page).locator('.git-files');
    await files.focus();
    await expect(files).toBeFocused();
    await page.keyboard.press('Home');
    await expect(gitWindow(page).locator('.git-file[aria-selected="true"]')).toContainText('a.txt', { timeout: 15000 });
    await expect(gitWindow(page).locator('.git-dl.add', { hasText: 'TWO' })).toBeVisible({ timeout: 15000 });
  });

  // FR-GIT-010
  test('a phone stacks list, commit and diff; back steps out', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo.project), 'phone layout');
    await waitForChip(page, /●1/);
    await chip(page).tap();
    const shell = page.locator('.git-mobile');
    await expect(shell).toHaveAttribute('data-step', '0', { timeout: 15000 });
    await shell.locator('.git-row', { hasText: 'second commit' }).tap();
    await expect(shell).toHaveAttribute('data-step', '1');
    await shell.locator('.git-file', { hasText: 'a.txt' }).tap();
    await expect(shell).toHaveAttribute('data-step', '2');
    await expect(shell.locator('.git-dl.add', { hasText: 'TWO' })).toBeVisible({ timeout: 15000 });
    await expect(shell.locator('[data-nav="nextHunk"]')).toBeVisible();
    const box = await shell.locator('[data-nav="nextHunk"]').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await shot(page, 'phone-diff');
    await page.goBack();
    await expect(shell).toHaveAttribute('data-step', '1');
    await page.goBack();
    await expect(shell).toHaveAttribute('data-step', '0');
    await page.goBack();
    await expect(shell).toHaveCount(0);
  });
});
