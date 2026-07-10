import { test, expect, type Page } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

const MCP_CONTROL_BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:2222';

test.describe('MCP Control Dialog', () => {
  test.use({
    baseURL: MCP_CONTROL_BASE_URL,
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
    isMobile: false,
  });

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== '' && testInfo.project.name !== 'Desktop Chrome',
      'Desktop-only MCP control dialog coverage',
    );
    await login(page);
    await waitForTerminal(page);
  });

  async function openMcpControlDialog(page: Page) {
    await page.locator('.header-tools-button').click();
    const mcpSettingsItem = page.getByRole('menuitem', { name: 'MCP 설정', exact: true });
    await expect(mcpSettingsItem).toBeVisible();
    await mcpSettingsItem.click();

    const dialog = page.getByTestId('mcp-control-dialog');
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('opens from desktop Tools menu and exposes Korean MCP settings labels', async ({ page }) => {
    const dialog = await openMcpControlDialog(page);

    await expect(dialog.getByRole('tab', { name: '보안' })).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByLabel('MCP 엔드포인트 사용')).toBeVisible();
    await expect(dialog.getByLabel('바인드 모드')).toBeVisible();
    await expect(dialog.getByLabel('외부 IP/CIDR 허용 목록')).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: '신뢰 프록시' })).toBeVisible();
    await expect(dialog.getByLabel('허용 오리진')).toBeVisible();
    await expect(dialog.getByLabel('웹훅 헤더')).toBeVisible();
    await expect(dialog.getByLabel('웹훅 요청 제한 시간(초)')).toBeVisible();
    await expect(dialog.getByLabel('웹훅 순간 요청 한도')).toBeVisible();

    await dialog.getByRole('tab', { name: '에이전트 프로필' }).click();
    await expect(dialog.getByLabel('프로필 이름')).toBeVisible();
    await expect(dialog.getByLabel('실행 명령')).toBeVisible();
    await expect(dialog.getByLabel('설정 방식')).toBeVisible();
    await expect(dialog.getByLabel('시작 프롬프트')).toBeVisible();

    await dialog.getByRole('tab', { name: '웹훅' }).click();
    await expect(dialog.getByLabel('대상 세션')).toBeVisible();
    await expect(dialog.getByLabel('프로필 ID')).toBeVisible();
    await expect(dialog.getByLabel('전달 방식')).toHaveValue('붙여넣기');
    await expect(dialog.getByLabel('권한 범위')).toBeVisible();

    await dialog.getByRole('tab', { name: '세션' }).click();
    await expect(dialog.getByLabel('검색')).toBeVisible();
    await expect(dialog.getByLabel('전달 테스트 프롬프트')).toHaveValue('Hello, World!');

    await dialog.getByRole('tab', { name: '감사/상태' }).click();
    await expect(dialog.getByText('감사 기록', { exact: true })).toBeVisible();
    const listenerStatus = dialog.locator('.mcp-control-status-grid dt')
      .filter({ hasText: /^상태$/ })
      .locator('xpath=following-sibling::dd[1]');
    await expect(listenerStatus).toHaveText(/^(수신 대기|중지됨|오류|시작 중|알 수 없음)$/);
  });

  test('confirms fixed access key generation and exposes only the latest key for copying', async ({ page }) => {
    const generatedKey = 'bgmcp_e2e_one_time_access_key';
    const regeneratedKey = 'bgmcp_e2e_regenerated_access_key';
    let rotationRequests = 0;
    let failNextRotation = false;
    await page.route('**/api/mcp-control/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, fixedAccessKeyConfigured: false } });
    });
    await page.route('**/api/mcp-control/access-key/rotate', async (route) => {
      rotationRequests += 1;
      if (failNextRotation) {
        failNextRotation = false;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, code: 'MCP_CONTROL_CONFIG_PERSIST_FAILED', message: '인증키 저장 실패' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          accessKey: rotationRequests >= 3 ? regeneratedKey : generatedKey,
        }),
      });
    });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            (window as Window & { __copiedFixedAccessKey?: string }).__copiedFixedAccessKey = value;
          },
        },
      });
    });
    const dialog = await openMcpControlDialog(page);
    const createButton = dialog.getByRole('button', { name: '고정 인증키 생성', exact: true });

    await createButton.click();
    const createConfirm = page.getByRole('alertdialog', { name: '고정 인증키 생성' });
    await expect(createConfirm).toContainText('새 고정 인증키를 생성하시겠습니까?');
    expect(rotationRequests).toBe(0);
    await createConfirm.getByRole('button', { name: '취소' }).click();
    expect(rotationRequests).toBe(0);
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveCount(0);

    await createButton.click();
    await page.getByRole('alertdialog', { name: '고정 인증키 생성' })
      .getByRole('button', { name: '생성', exact: true })
      .click();
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveValue(generatedKey);
    expect(rotationRequests).toBe(1);

    await dialog.getByRole('button', { name: '복사', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (
      window as Window & { __copiedFixedAccessKey?: string }
    ).__copiedFixedAccessKey)).toBe(generatedKey);

    await dialog.getByRole('button', { name: '고정 인증키 재생성', exact: true }).click();
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveCount(0);
    await page.getByRole('alertdialog', { name: '고정 인증키 재생성' })
      .getByRole('button', { name: '취소' })
      .click();
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveCount(0);

    failNextRotation = true;
    await dialog.getByRole('button', { name: '고정 인증키 재생성', exact: true }).click();
    const failedRegeneration = page.getByRole('alertdialog', { name: '고정 인증키 재생성' });
    await failedRegeneration.getByRole('button', { name: '재생성', exact: true }).click();
    await expect(failedRegeneration.getByRole('alert')).toContainText('인증키 저장 실패');
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveCount(0);
    await failedRegeneration.getByRole('button', { name: '취소' }).click();

    await dialog.getByRole('button', { name: '고정 인증키 재생성', exact: true }).click();
    await page.getByRole('alertdialog', { name: '고정 인증키 재생성' })
      .getByRole('button', { name: '재생성', exact: true })
      .click();
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveValue(regeneratedKey);
    await dialog.getByRole('button', { name: '새로고침', exact: true }).click();
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveCount(0);
    expect(rotationRequests).toBe(3);
  });

  test('discards a fixed access key response completed after leaving the security tab', async ({ page }) => {
    let releaseRotation: (() => void) | undefined;
    const rotationReleased = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    await page.route('**/api/mcp-control/config', async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, fixedAccessKeyConfigured: false } });
    });
    await page.route('**/api/mcp-control/access-key/rotate', async (route) => {
      await rotationReleased;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, accessKey: 'bgmcp_stale_response_must_not_render' }),
      });
    });
    const dialog = await openMcpControlDialog(page);
    await dialog.getByRole('button', { name: '고정 인증키 생성', exact: true }).click();
    await page.getByRole('alertdialog', { name: '고정 인증키 생성' })
      .getByRole('button', { name: '생성', exact: true })
      .click();

    await page.evaluate(() => {
      (document.querySelector('#mcp-control-tab-agents') as HTMLButtonElement | null)?.click();
    });
    releaseRotation?.();
    await expect(dialog.getByRole('tab', { name: '에이전트 프로필' })).toHaveAttribute('aria-selected', 'true');
    await dialog.getByRole('tab', { name: '보안' }).click();
    await expect(dialog.getByLabel('새 고정 인증키')).toHaveCount(0);
  });

  test('blocks unsafe whitelist config before saving', async ({ page }) => {
    let patchRequests = 0;
    await page.route('**/api/mcp-control/config', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchRequests += 1;
        await route.fulfill({ status: 500, body: 'unexpected PATCH' });
        return;
      }
      await route.continue();
    });
    const dialog = await openMcpControlDialog(page);

    await dialog.getByLabel('바인드 모드').selectOption('whitelist');
    await dialog.getByLabel('외부 IP/CIDR 허용 목록').fill('0.0.0.0/0');
    await dialog.getByRole('button', { name: '저장' }).click();

    await expect(dialog.getByRole('alert')).toContainText('0.0.0.0/0');
    expect(patchRequests).toBe(0);
  });

  test('blocks invalid whitelist security contract states before saving', async ({ page }) => {
    let patchRequests = 0;
    await page.route('**/api/mcp-control/config', async (route) => {
      if (route.request().method() === 'PATCH') {
        patchRequests += 1;
        await route.fulfill({ status: 500, body: 'unexpected PATCH' });
        return;
      }
      await route.continue();
    });
    const dialog = await openMcpControlDialog(page);

    await dialog.getByLabel('바인드 모드').selectOption('loopback');
    await dialog.getByLabel('호스트 주소').fill('0.0.0.0');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/로컬|127/i);

    await dialog.getByLabel('호스트 주소').fill('127.0.0.1');
    await dialog.getByLabel('바인드 모드').selectOption('whitelist');
    await dialog.getByLabel('외부 IP/CIDR 허용 목록').fill('not-a-cidr');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/CIDR|IPv4/i);

    await dialog.getByLabel('외부 IP/CIDR 허용 목록').fill('203.0.113.7/32');
    await dialog.getByLabel('전송 보안').selectOption('none');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/전송 보안|TLS/i);

    await dialog.getByLabel('전송 보안').selectOption('trusted_tls_proxy');
    await dialog.getByRole('textbox', { name: '신뢰 프록시' }).fill('');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/신뢰 프록시/i);
    expect(patchRequests).toBe(0);
  });

  test('issues a one-time claim code for the selected live session', async ({ page }) => {
    await page.route('**/api/mcp-control/sessions/*/claim-code', async (route) => {
      const sessionKey = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, sessionKey, claimCode: 'claim_e2e_mocked' }),
      });
    });
    const dialog = await openMcpControlDialog(page);
    await dialog.getByRole('tab', { name: '세션' }).click();

    const issueButton = dialog.getByRole('button', { name: '연결 코드 발급' }).first();
    await expect(issueButton).toBeVisible();
    await issueButton.click();

    await expect(dialog.getByLabel('일회성 연결 코드')).toHaveValue('claim_e2e_mocked');
    await expect(dialog.getByLabel('세션 키')).not.toHaveValue('');
  });
});
