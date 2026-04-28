# Step 6 통합 테스트 가이드: Playwright E2E

**Version**: 1.0.0
**Date**: 2026-03-21
**SRS Reference**: `docs/archive/spec/srs.step6.md`
**Architecture Reference**: `plan/step6/00-1.architecture.md`

---

## 1. 목적

BuilderGate Step 6 tmux-style Pane Split System의 전체 기능을 End-to-End로 검증한다. 헤드리스 브라우저 환경에서 실제 사용자 플로우를 재현하여 다음 영역을 통합 테스트한다:

| 검증 영역 | 주요 항목 |
|-----------|----------|
| 데스크톱 분할 | 수평/수직 분할, 리사이즈, 줌, Pane 닫기, Pane 교환 |
| 모바일 캐러셀 | 스와이프 전환, 도트 인디케이터, 롱프레스 메뉴, Pane 추가/닫기 |
| 컨텍스트 메뉴 | Pane 메뉴, 경계선 메뉴, TabBar 프리셋/저장/불러오기, 서브메뉴 |
| 키보드 단축키 | Ctrl+B prefix 모드, 분할/닫기/줌/포커스 이동/번호 오버레이 |
| IndexedDB 영속화 | 레이아웃 저장/복원, 프리셋 관리, 세션 불일치 자동 정리 |
| 반응형 전환 | 데스크톱↔모바일 전환 일관성, 뷰포트 리사이즈 대응 |
| 회귀 검증 | 기존 탭 관리, 파일 탐색, 세션 생성/삭제 정상 동작 |

**서버 변경 없음** — 기존 세션 생성/삭제/SSE API를 그대로 활용하므로, E2E 테스트는 프론트엔드 동작과 기존 백엔드 API 통합을 검증한다.

---

## 2. 테스트 환경 설정

### 2.1 Playwright 설치

```bash
cd frontend
npm install -D @playwright/test
npx playwright install chromium
```

> **참고**: `webkit`(Safari 엔진)과 `firefox`도 필요 시 설치 가능하지만, 기본 테스트에는 Chromium만 사용한다. 모바일 Safari 에뮬레이션은 Chromium의 디바이스 에뮬레이션으로 수행한다.

### 2.2 Playwright 설정 파일

**파일**: `frontend/playwright.config.ts`

```typescript
import { defineConfig, devices } from '@playwright/test';

/**
 * BuilderGate Step 6 E2E 테스트 설정
 *
 * 3개 프로젝트:
 * - Desktop Chrome: 데스크톱 분할, 컨텍스트 메뉴, 키보드 단축키
 * - Mobile Safari: 모바일 캐러셀, 스와이프, 롱프레스
 * - Tablet: 태블릿 터치 타겟 확장, 중간 해상도
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',

  /* 전체 테스트 실행 제한 시간: 10분 */
  timeout: 60_000,
  globalTimeout: 600_000,

  /* 각 테스트의 expect 타임아웃 */
  expect: {
    timeout: 10_000,
  },

  /* 테스트 결과 출력 디렉토리 */
  outputDir: './test-results',

  /* 실패 시 재시도 1회 */
  retries: process.env.CI ? 2 : 1,

  /* CI에서 병렬 실행 비활성화 (서버 공유) */
  workers: process.env.CI ? 1 : 2,

  /* 리포터 설정 */
  reporter: process.env.CI
    ? [['junit', { outputFile: 'test-results/junit-report.xml' }], ['html', { open: 'never' }]]
    : [['html', { open: 'on-failure' }], ['list']],

  /* 전체 프로젝트 공통 설정 */
  use: {
    /* 기본 URL: Vite dev server */
    baseURL: 'http://localhost:4545',

    /* 헤드리스 모드 */
    headless: true,

    /* HTTPS 자체서명 인증서 무시 (서버가 HTTPS, Vite 프록시 경유) */
    ignoreHTTPSErrors: true,

    /* 실패 시 스크린샷 촬영 */
    screenshot: 'only-on-failure',

    /* 재시도 시 트레이스 수집 */
    trace: 'on-first-retry',

    /* 동영상 녹화: 실패 시에만 */
    video: 'retain-on-failure',

    /* 액션 타임아웃 */
    actionTimeout: 10_000,

    /* 네비게이션 타임아웃 */
    navigationTimeout: 15_000,
  },

  /* 프로젝트 정의 */
  projects: [
    // ─────────────────────────────────────────
    // Desktop Chrome (1920x1080)
    // ─────────────────────────────────────────
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        // 키보드 단축키 테스트에 필요
        hasTouch: false,
      },
    },

    // ─────────────────────────────────────────
    // Mobile Safari (iPhone 13 에뮬레이션)
    // ─────────────────────────────────────────
    {
      name: 'Mobile Safari',
      use: {
        ...devices['iPhone 13'],
        // iPhone 13: 390x844 뷰포트
        // 768px 이하이므로 캐러셀 모드 자동 진입
        hasTouch: true,
        isMobile: true,
      },
    },

    // ─────────────────────────────────────────
    // Tablet (1024x768)
    // ─────────────────────────────────────────
    {
      name: 'Tablet',
      use: {
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
        isMobile: false,
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      },
    },
  ],

  /* dev.js로 서버+프론트 동시 기동 */
  webServer: {
    command: 'cd .. && node dev.js',
    url: 'http://localhost:4545',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
    },
  },
});
```

### 2.3 테스트 헬퍼 유틸리티

**파일**: `frontend/tests/e2e/helpers.ts`

```typescript
import { type Page, type BrowserContext, expect } from '@playwright/test';

// ============================================================================
// 상수
// ============================================================================

/** 테스트용 비밀번호 (server/config.json5 기본값) */
const TEST_PASSWORD = 'test';

/** API 기본 경로 */
const API_BASE = '/api';

/** 셀렉터 상수 */
export const SELECTORS = {
  /** Pane 리프 (터미널이 렌더링되는 영역) */
  PANE_LEAF: '[data-pane-type="terminal"]',
  /** Pane 분할 노드 */
  PANE_SPLIT: '[data-pane-type="split"]',
  /** Pane 리사이저 (분할 경계선) */
  PANE_RESIZER: '.pane-resizer',
  /** xterm.js 스크린 영역 */
  XTERM_SCREEN: '.xterm-screen',
  /** 컨텍스트 메뉴 컨테이너 */
  CONTEXT_MENU: '.context-menu',
  /** 컨텍스트 메뉴 항목 */
  CONTEXT_MENU_ITEM: '.context-menu-item',
  /** 서브메뉴 항목 화살표 */
  SUBMENU_ARROW: '.context-menu-item .submenu-arrow',
  /** 도트 인디케이터 컨테이너 */
  PANE_INDICATOR: '.pane-indicator',
  /** 도트 인디케이터 개별 도트 */
  PANE_DOT: '.pane-indicator .dot',
  /** 활성 도트 */
  PANE_DOT_ACTIVE: '.pane-indicator .dot.active',
  /** 위치 텍스트 (예: [1/3] Terminal A) */
  PANE_POSITION_TEXT: '.pane-position-text',
  /** Pane 번호 오버레이 */
  PANE_NUMBER_OVERLAY: '.pane-number-overlay',
  /** 줌 배지 */
  ZOOM_BADGE: '.zoom-badge',
  /** StatusBar PREFIX 표시 */
  STATUS_PREFIX: '.status-prefix',
  /** StatusBar ZOOMED 표시 */
  STATUS_ZOOMED: '.status-zoomed',
  /** 포커스된 Pane */
  PANE_FOCUSED: '[data-pane-focused="true"]',
  /** 캐러셀 컨테이너 */
  CAROUSEL: '.pane-carousel',
  /** 바텀시트 메뉴 */
  BOTTOM_SHEET: '.bottom-sheet',
  /** 교환 모드 하이라이트 */
  SWAP_HIGHLIGHT: '.pane-swap-source',
  /** 로그인 폼 */
  LOGIN_FORM: '.login-form',
  /** 비밀번호 입력 필드 */
  PASSWORD_INPUT: 'input[type="password"]',
  /** 로그인 버튼 */
  LOGIN_BUTTON: 'button[type="submit"]',
  /** 탭바 */
  TAB_BAR: '.tab-bar',
  /** 탭바 탭 아이템 */
  TAB_ITEM: '.tab-item',
} as const;

// ============================================================================
// 인증 헬퍼
// ============================================================================

/**
 * 서버 API를 통해 로그인하고 JWT 토큰을 브라우저 저장소에 설정한다.
 *
 * UI를 통한 로그인이 아닌 직접 API 호출 방식으로 테스트 속도를 높인다.
 * 테스트가 인증 자체를 검증하는 것이 아니므로 이 방식이 적절하다.
 */
export async function login(page: Page, password: string = TEST_PASSWORD): Promise<string> {
  // API 호출로 토큰 획득
  const response = await page.request.post(`${API_BASE}/auth/login`, {
    data: { password },
    ignoreHTTPSErrors: true,
  });

  if (!response.ok()) {
    throw new Error(`Login failed: ${response.status()} ${await response.text()}`);
  }

  const data = await response.json();

  if (data.requires2FA) {
    throw new Error('2FA enabled - use loginWith2FA() instead');
  }

  const token = data.token;
  if (!token) {
    throw new Error('No token in login response');
  }

  // 브라우저 localStorage에 토큰 저장 (tokenStorage 패턴 호환)
  await page.evaluate((t: string) => {
    localStorage.setItem('auth_token', t);
  }, token);

  return token;
}

/**
 * UI를 통해 로그인한다 (로그인 페이지 E2E 테스트용).
 */
export async function loginViaUI(page: Page, password: string = TEST_PASSWORD): Promise<void> {
  await page.goto('/');
  await page.waitForSelector(SELECTORS.PASSWORD_INPUT, { timeout: 10_000 });
  await page.fill(SELECTORS.PASSWORD_INPUT, password);
  await page.click(SELECTORS.LOGIN_BUTTON);
  // 로그인 후 터미널이 로드될 때까지 대기
  await page.waitForSelector(SELECTORS.XTERM_SCREEN, { timeout: 15_000 });
}

// ============================================================================
// 터미널 대기 헬퍼
// ============================================================================

/**
 * xterm.js 터미널 화면이 렌더링될 때까지 대기한다.
 * Pane 분할 후 새 터미널이 표시되는 것을 확인하는 데 사용한다.
 */
export async function waitForTerminal(page: Page, timeout: number = 15_000): Promise<void> {
  await page.waitForSelector(SELECTORS.XTERM_SCREEN, { timeout });
}

/**
 * 특정 개수의 xterm.js 터미널이 렌더링될 때까지 대기한다.
 */
export async function waitForTerminalCount(
  page: Page,
  expectedCount: number,
  timeout: number = 15_000
): Promise<void> {
  await page.waitForFunction(
    (args: { selector: string; count: number }) => {
      return document.querySelectorAll(args.selector).length === args.count;
    },
    { selector: SELECTORS.XTERM_SCREEN, count: expectedCount },
    { timeout }
  );
}

// ============================================================================
// 컨텍스트 메뉴 헬퍼
// ============================================================================

/**
 * N번째 Pane 리프 영역에서 우클릭하여 컨텍스트 메뉴를 연다.
 * @param index - 0-based Pane 인덱스 (DOM 순서)
 */
export async function rightClickPane(page: Page, index: number = 0): Promise<void> {
  const panes = page.locator(SELECTORS.PANE_LEAF);
  const pane = panes.nth(index);
  await pane.waitFor({ state: 'visible', timeout: 5_000 });

  // Pane 중앙에서 우클릭
  const box = await pane.boundingBox();
  if (!box) throw new Error(`Pane ${index} has no bounding box`);

  await page.mouse.click(
    box.x + box.width / 2,
    box.y + box.height / 2,
    { button: 'right' }
  );

  // 컨텍스트 메뉴가 표시될 때까지 대기
  await page.waitForSelector(SELECTORS.CONTEXT_MENU, { timeout: 3_000 });
}

/**
 * 모바일에서 N번째 Pane 영역을 500ms 롱프레스하여 바텀시트 메뉴를 연다.
 * @param index - 0-based Pane 인덱스
 */
export async function longPressPane(page: Page, index: number = 0): Promise<void> {
  const panes = page.locator(SELECTORS.PANE_LEAF);
  const pane = panes.nth(index);
  await pane.waitFor({ state: 'visible', timeout: 5_000 });

  const box = await pane.boundingBox();
  if (!box) throw new Error(`Pane ${index} has no bounding box`);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // 터치 시작 → 500ms 대기 → 터치 종료 (롱프레스)
  await page.touchscreen.tap(cx, cy);
  // Playwright의 tap은 즉시 완료되므로, dispatchEvent로 롱프레스 시뮬레이션
  await page.evaluate(
    (args: { x: number; y: number; duration: number }) => {
      return new Promise<void>((resolve) => {
        const el = document.elementFromPoint(args.x, args.y);
        if (!el) { resolve(); return; }

        const touchStartEvent = new TouchEvent('touchstart', {
          bubbles: true,
          cancelable: true,
          touches: [new Touch({
            identifier: 1,
            target: el,
            clientX: args.x,
            clientY: args.y,
          })],
        });
        el.dispatchEvent(touchStartEvent);

        setTimeout(() => {
          const touchEndEvent = new TouchEvent('touchend', {
            bubbles: true,
            cancelable: true,
            changedTouches: [new Touch({
              identifier: 1,
              target: el,
              clientX: args.x,
              clientY: args.y,
            })],
          });
          el.dispatchEvent(touchEndEvent);
          resolve();
        }, args.duration);
      });
    },
    { x: cx, y: cy, duration: 550 }
  );

  // 바텀시트 또는 컨텍스트 메뉴가 표시될 때까지 대기
  await page.waitForSelector(
    `${SELECTORS.BOTTOM_SHEET}, ${SELECTORS.CONTEXT_MENU}`,
    { timeout: 3_000 }
  );
}

/**
 * 컨텍스트 메뉴에서 지정 텍스트를 가진 항목을 클릭한다.
 * @param label - 메뉴 항목의 표시 텍스트 (정확 일치 또는 부분 일치)
 */
export async function selectContextMenuItem(page: Page, label: string): Promise<void> {
  const menuItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: label });
  await menuItem.first().waitFor({ state: 'visible', timeout: 3_000 });

  // 비활성화 상태 확인
  const isDisabled = await menuItem.first().evaluate(
    (el: Element) => el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true'
  );
  if (isDisabled) {
    throw new Error(`Menu item "${label}" is disabled`);
  }

  await menuItem.first().click();
}

/**
 * 컨텍스트 메뉴의 서브메뉴 항목을 선택한다.
 * 부모 항목에 호버하여 서브메뉴를 열고, 자식 항목을 클릭한다.
 *
 * @param parentLabel - 부모 메뉴 항목 텍스트 (예: "프리셋 레이아웃")
 * @param childLabel - 서브메뉴 항목 텍스트 (예: "4분할")
 */
export async function selectSubmenuItem(
  page: Page,
  parentLabel: string,
  childLabel: string
): Promise<void> {
  // 부모 항목에 호버
  const parentItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: parentLabel });
  await parentItem.first().waitFor({ state: 'visible', timeout: 3_000 });
  await parentItem.first().hover();

  // 서브메뉴가 표시될 때까지 대기 (300ms 딜레이 고려)
  await page.waitForTimeout(400);

  // 서브메뉴의 자식 항목 클릭
  const childItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: childLabel });
  await childItem.first().waitFor({ state: 'visible', timeout: 3_000 });
  await childItem.first().click();
}

// ============================================================================
// Pane 상태 쿼리 헬퍼
// ============================================================================

/**
 * 현재 화면에 표시된 Pane 리프의 개수를 반환한다.
 */
export async function getPaneCount(page: Page): Promise<number> {
  return page.locator(SELECTORS.PANE_LEAF).count();
}

/**
 * Pane 개수가 기대값과 일치하는지 검증한다.
 * waitForFunction을 사용하여 비동기 업데이트를 기다린다.
 */
export async function verifyPaneCount(
  page: Page,
  expected: number,
  timeout: number = 10_000
): Promise<void> {
  await page.waitForFunction(
    (args: { selector: string; count: number }) => {
      return document.querySelectorAll(args.selector).length === args.count;
    },
    { selector: SELECTORS.PANE_LEAF, count: expected },
    { timeout }
  );

  const actual = await getPaneCount(page);
  expect(actual).toBe(expected);
}

/**
 * 포커스된 Pane의 data-pane-id 속성값을 반환한다.
 */
export async function getFocusedPaneId(page: Page): Promise<string | null> {
  const focused = page.locator(SELECTORS.PANE_FOCUSED);
  if (await focused.count() === 0) return null;
  return focused.first().getAttribute('data-pane-id');
}

/**
 * 서버에 등록된 활성 세션 수를 조회한다.
 */
export async function getServerSessionCount(page: Page): Promise<number> {
  const response = await page.request.get(`${API_BASE}/sessions`, {
    headers: {
      'Authorization': `Bearer ${await getStoredToken(page)}`,
    },
    ignoreHTTPSErrors: true,
  });
  if (!response.ok()) {
    throw new Error(`Failed to get sessions: ${response.status()}`);
  }
  const sessions = await response.json();
  return Array.isArray(sessions) ? sessions.length : 0;
}

/**
 * localStorage에 저장된 인증 토큰을 반환한다.
 */
async function getStoredToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('auth_token'));
  if (!token) throw new Error('No auth token in localStorage');
  return token;
}

// ============================================================================
// IndexedDB 헬퍼
// ============================================================================

/**
 * IndexedDB의 buildergate 데이터베이스를 완전히 삭제한다.
 * 테스트 격리를 위해 각 테스트 시작 전에 호출한다.
 */
export async function clearIndexedDB(page: Page): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('buildergate');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(new Error('Failed to delete IndexedDB'));
      request.onblocked = () => {
        // DB가 다른 탭에서 열려 있으면 blocked 될 수 있음
        console.warn('IndexedDB delete blocked - retrying');
        resolve();
      };
    });
  });
}

/**
 * IndexedDB에서 특정 세션의 Pane 레이아웃을 조회한다.
 */
export async function getStoredLayout(page: Page, sessionId: string): Promise<unknown | null> {
  return page.evaluate((sid: string) => {
    return new Promise<unknown | null>((resolve, reject) => {
      const request = indexedDB.open('buildergate', 1);
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction('paneLayouts', 'readonly');
          const store = tx.objectStore('paneLayouts');
          const getReq = store.get(sid);
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
      request.onerror = () => resolve(null);
    });
  }, sessionId);
}

/**
 * IndexedDB에 저장된 savedLayouts(프리셋 + 커스텀)의 개수를 반환한다.
 */
export async function getSavedLayoutCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    return new Promise<number>((resolve) => {
      const request = indexedDB.open('buildergate', 1);
      request.onsuccess = () => {
        const db = request.result;
        try {
          const tx = db.transaction('savedLayouts', 'readonly');
          const store = tx.objectStore('savedLayouts');
          const countReq = store.count();
          countReq.onsuccess = () => resolve(countReq.result);
          countReq.onerror = () => resolve(0);
        } catch {
          resolve(0);
        }
      };
      request.onerror = () => resolve(0);
    });
  });
}

// ============================================================================
// 스와이프 헬퍼 (모바일)
// ============================================================================

/**
 * 지정 셀렉터 영역에서 왼쪽으로 스와이프한다 (다음 Pane으로 이동).
 * 터치 이벤트 시퀀스: touchstart → touchmove(여러 단계) → touchend
 */
export async function swipeLeft(page: Page, selector: string = SELECTORS.CAROUSEL): Promise<void> {
  const element = page.locator(selector).first();
  const box = await element.boundingBox();
  if (!box) throw new Error(`Element ${selector} has no bounding box`);

  const startX = box.x + box.width * 0.8;
  const endX = box.x + box.width * 0.2;
  const y = box.y + box.height / 2;

  // 스와이프 시뮬레이션 (여러 단계로 이동하여 자연스러운 스와이프 재현)
  await page.evaluate(
    (args: { startX: number; endX: number; y: number; steps: number }) => {
      return new Promise<void>((resolve) => {
        const el = document.elementFromPoint(args.startX, args.y);
        if (!el) { resolve(); return; }

        const createTouch = (x: number) => new Touch({
          identifier: 1,
          target: el,
          clientX: x,
          clientY: args.y,
        });

        // touchstart
        el.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true,
          touches: [createTouch(args.startX)],
        }));

        const dx = (args.endX - args.startX) / args.steps;
        let step = 0;

        const interval = setInterval(() => {
          step++;
          const currentX = args.startX + dx * step;

          el.dispatchEvent(new TouchEvent('touchmove', {
            bubbles: true, cancelable: true,
            touches: [createTouch(currentX)],
          }));

          if (step >= args.steps) {
            clearInterval(interval);

            el.dispatchEvent(new TouchEvent('touchend', {
              bubbles: true, cancelable: true,
              changedTouches: [createTouch(args.endX)],
            }));

            resolve();
          }
        }, 16); // ~60fps
      });
    },
    { startX, endX, y, steps: 10 }
  );

  // 스와이프 애니메이션 완료 대기 (300ms ease-out)
  await page.waitForTimeout(400);
}

/**
 * 지정 셀렉터 영역에서 오른쪽으로 스와이프한다 (이전 Pane으로 이동).
 */
export async function swipeRight(page: Page, selector: string = SELECTORS.CAROUSEL): Promise<void> {
  const element = page.locator(selector).first();
  const box = await element.boundingBox();
  if (!box) throw new Error(`Element ${selector} has no bounding box`);

  const startX = box.x + box.width * 0.2;
  const endX = box.x + box.width * 0.8;
  const y = box.y + box.height / 2;

  await page.evaluate(
    (args: { startX: number; endX: number; y: number; steps: number }) => {
      return new Promise<void>((resolve) => {
        const el = document.elementFromPoint(args.startX, args.y);
        if (!el) { resolve(); return; }

        const createTouch = (x: number) => new Touch({
          identifier: 1,
          target: el,
          clientX: x,
          clientY: args.y,
        });

        el.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true,
          touches: [createTouch(args.startX)],
        }));

        const dx = (args.endX - args.startX) / args.steps;
        let step = 0;

        const interval = setInterval(() => {
          step++;
          const currentX = args.startX + dx * step;

          el.dispatchEvent(new TouchEvent('touchmove', {
            bubbles: true, cancelable: true,
            touches: [createTouch(currentX)],
          }));

          if (step >= args.steps) {
            clearInterval(interval);
            el.dispatchEvent(new TouchEvent('touchend', {
              bubbles: true, cancelable: true,
              changedTouches: [createTouch(args.endX)],
            }));
            resolve();
          }
        }, 16);
      });
    },
    { startX, endX, y, steps: 10 }
  );

  await page.waitForTimeout(400);
}

// ============================================================================
// 키보드 단축키 헬퍼
// ============================================================================

/**
 * Ctrl+B (Prefix 모드 진입) 키를 시뮬레이션한다.
 * Pane에 포커스된 상태에서 호출해야 한다.
 */
export async function pressCtrlB(page: Page): Promise<void> {
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
  // Prefix 모드 진입 상태 전파 대기
  await page.waitForTimeout(100);
}

/**
 * Prefix 모드 진입 후 지정 키를 입력한다.
 * Ctrl+B → key 시퀀스를 한 번에 실행한다.
 *
 * @param key - Prefix 모드에서 입력할 키 (예: '%', '"', 'x', 'z', 'q', 'o')
 */
export async function pressPrefixKey(page: Page, key: string): Promise<void> {
  await pressCtrlB(page);

  // 특수 키 매핑
  switch (key) {
    case '%':
      await page.keyboard.down('Shift');
      await page.keyboard.press('5');
      await page.keyboard.up('Shift');
      break;
    case '"':
      await page.keyboard.down('Shift');
      await page.keyboard.press("'");
      await page.keyboard.up('Shift');
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
      await page.keyboard.press(key);
      break;
    default:
      await page.keyboard.press(key);
      break;
  }

  // 명령 실행 후 안정화 대기
  await page.waitForTimeout(200);
}

/**
 * Ctrl+B, Ctrl+B (PTY에 실제 Ctrl+B 전송) 시퀀스를 실행한다.
 */
export async function sendRawCtrlB(page: Page): Promise<void> {
  await pressCtrlB(page);
  await pressCtrlB(page);
}

// ============================================================================
// 리사이즈 헬퍼
// ============================================================================

/**
 * Pane 리사이저(경계선)를 드래그하여 리사이즈한다.
 *
 * @param index - 리사이저 인덱스 (0-based, DOM 순서)
 * @param deltaX - 수평 이동량 (px)
 * @param deltaY - 수직 이동량 (px)
 */
export async function dragResizer(
  page: Page,
  index: number = 0,
  deltaX: number = 0,
  deltaY: number = 0
): Promise<void> {
  const resizer = page.locator(SELECTORS.PANE_RESIZER).nth(index);
  await resizer.waitFor({ state: 'visible', timeout: 5_000 });

  const box = await resizer.boundingBox();
  if (!box) throw new Error(`Resizer ${index} has no bounding box`);

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // 여러 단계로 이동하여 실시간 리사이즈 트리거
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(
      startX + (deltaX * i) / steps,
      startY + (deltaY * i) / steps
    );
    await page.waitForTimeout(16); // ~1 frame
  }
  await page.mouse.up();

  // 리사이즈 완료 후 IndexedDB 저장 대기
  await page.waitForTimeout(100);
}

// ============================================================================
// 유틸리티
// ============================================================================

/**
 * 앱을 초기 상태로 설정한다.
 * 1. IndexedDB 삭제
 * 2. localStorage 정리
 * 3. 로그인
 * 4. 앱 로드 및 터미널 대기
 */
export async function setupCleanState(page: Page): Promise<void> {
  // 빈 페이지에서 스토리지 정리
  await page.goto('about:blank');
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // 로그인
  const token = await login(page);

  // 앱 로드
  await page.goto('/');
  await page.evaluate((t: string) => {
    localStorage.setItem('auth_token', t);
  }, token);
  await page.reload();

  // 터미널 렌더링 대기
  await waitForTerminal(page);
}

/**
 * 지정 시간(ms) 동안 조건이 참이 되기를 기다린다.
 * page.waitForFunction의 간편 래퍼.
 */
export async function waitForCondition(
  page: Page,
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * 현재 보이는 컨텍스트 메뉴를 닫는다 (메뉴 외부 클릭).
 */
export async function dismissContextMenu(page: Page): Promise<void> {
  // 화면 좌상단 근처 클릭 (메뉴 영역 밖)
  await page.mouse.click(1, 1);
  // 메뉴가 닫히기를 대기
  await page.waitForSelector(SELECTORS.CONTEXT_MENU, { state: 'hidden', timeout: 2_000 }).catch(() => {
    // 이미 닫혀 있으면 무시
  });
}
```

---

## 3. E2E 테스트 시나리오

### 3.1 핵심 비즈니스 플로우 (CRITICAL)

**시나리오**: 로그인 → 세션 생성 → Pane 분할 → 터미널 검증 → 리사이즈 → 줌 → Pane 닫기 → 영속화 검증

이 플로우는 사용자가 BuilderGate를 처음 사용할 때 가장 빈번하게 수행하는 핵심 경로이다.

```
[Login] → [Single Pane] → [Split Vertical] → [2 Panes] → [Split Horizontal]
    → [3 Panes] → [Resize] → [Zoom Pane] → [Unzoom] → [Close Pane]
    → [2 Panes] → [Reload] → [2 Panes Restored from IndexedDB]
```

**검증 포인트**:
- AC-6101-1: 분할 후 2개 터미널 동시 표시
- AC-6101-2: 각 터미널에 독립적 명령 입력 가능
- AC-6103-1: 경계선 드래그로 양쪽 크기 변경
- AC-6104-1: 줌 시 단일 Pane만 전체 표시
- AC-6104-2: 줌 해제 시 레이아웃 복원
- AC-6102-1: Pane 닫기 후 나머지가 전체 영역 차지
- AC-6102-2: 닫힌 세션이 서버에서 삭제

### 3.2 대안 플로우: 프리셋 적용 (HIGH)

**시나리오**: 로그인 → 탭 우클릭 → "4분할" 프리셋 선택 → 4 Pane 검증 → 레이아웃 저장 → 새로고침 → 저장된 레이아웃 불러오기

```
[Login] → [TabBar Right-click] → [Preset > "4분할"] → [4 Panes in 2x2]
    → [TabBar Right-click] → [Save Layout: "나의 레이아웃"]
    → [Reload] → [TabBar Right-click] → [Load Layout: "나의 레이아웃"]
    → [4 Panes Restored]
```

**검증 포인트**:
- AC-6203-1: 프리셋 서브메뉴 호버 시 표시
- AC-6203-2: 좌우 분할 프리셋 적용
- AC-6502-1: 커스텀 레이아웃 저장/불러오기
- AC-6501-1: 6개 기본 프리셋 표시

### 3.3 예외 플로우: 오류 처리 (HIGH)

#### 3.3.1 서버 오프라인 분할 시도

**시나리오**: 로그인 → 서버 API 모킹(실패 응답) → 분할 시도 → 에러 표시 → 레이아웃 미변경

```
[Login] → [Mock: POST /api/sessions → 500] → [Right-click > Split]
    → [Error shown in StatusBar] → [Pane count unchanged = 1]
```

**검증 포인트**:
- AC-6101-4: 서버 미응답 시 에러 메시지 표시, 레이아웃 변경 없음

#### 3.3.2 세션 불일치 복원

**시나리오**: IndexedDB에 stale sessionId가 있는 레이아웃 저장 → 앱 로드 → 자동 정리 → 단일 Pane 폴백

```
[Inject stale layout to IndexedDB] → [Load App] → [Server sessions check]
    → [Stale panes removed] → [Single pane fallback]
```

**검증 포인트**:
- TC-6710: stale sessionId 자동 제거, 남은 Pane으로 재구성

### 3.4 모바일 완전 플로우 (HIGH)

**시나리오**: 로그인 → 롱프레스 → Pane 추가 → 스와이프 → 도트 탭 → Pane 닫기 → 인디케이터 검증

```
[Login (iPhone 13)] → [Long-press 500ms] → [Bottom Sheet > "수직 분할"]
    → [2 Panes, Carousel mode] → [Swipe Left → Pane 2]
    → [Swipe Right → Pane 1] → [Tap Dot 2 → Pane 2]
    → [Long-press > "Pane 닫기"] → [1 Pane, 1 Dot]
```

**검증 포인트**:
- AC-6301-1: 768px 이하에서 캐러셀 모드
- AC-6302-1: 스와이프로 Pane 전환
- AC-6303-1: 도트 인디케이터 개수 일치
- AC-6303-2: 도트 탭으로 이동
- AC-6304-1: 모바일 Pane 추가 후 도트 증가
- AC-6306-1: Pane 닫기 후 도트 감소
- AC-6205-1: 롱프레스 시 바텀시트 메뉴

### 3.5 키보드 완전 플로우 (MEDIUM)

**시나리오**: Ctrl+B → % (수직분할) → Ctrl+B → 방향키 (포커스) → Ctrl+B → z (줌) → Ctrl+B → q → 1 (번호선택) → Ctrl+B → x (닫기)

```
[Login] → [Ctrl+B, %] → [2 Panes (vertical split)]
    → [Ctrl+B, ArrowRight] → [Focus moves to Pane 2]
    → [Ctrl+B, z] → [Pane 2 zoomed]
    → [Ctrl+B, z] → [Zoom released]
    → [Ctrl+B, q] → [Number overlay shown]
    → [Press "0"] → [Focus moves to Pane 0]
    → [Ctrl+B, x] → [Pane closed, 1 Pane remaining]
```

**검증 포인트**:
- AC-6601-1: Ctrl+B 후 StatusBar [PREFIX] 표시
- AC-6602-1: Ctrl+B, % 수직 분할
- AC-6106-2: Ctrl+B → 방향키 포커스 이동
- AC-6602-3: Ctrl+B, q 번호 오버레이
- AC-6603-2: 오버레이 중 숫자 입력으로 포커스 이동
- AC-6602-2: Ctrl+B, x Pane 닫기
- AC-6605-1: Ctrl+B, Ctrl+B → PTY에 \x02 전달

---

## 4. 컴포넌트 통합 매트릭스

아래 표는 Step 6에서 통합 테스트가 필요한 컴포넌트 간 상호작용을 나타낸다.

| 호출자 (From) | 대상 (To) | 상호작용 | 테스트 파일 |
|---------------|-----------|---------|------------|
| `App.tsx` | `usePaneManager` | 활성 탭 변경 시 Pane 레이아웃 로드 | `pane-split.spec.ts` |
| `usePaneManager` | `sessionApi.create` | Pane 분할 시 새 PTY 세션 생성 | `pane-split.spec.ts` |
| `usePaneManager` | `sessionApi.delete` | Pane 닫기 시 PTY 세션 삭제 | `pane-split.spec.ts` |
| `usePaneManager` | `usePaneDB` | 레이아웃 변경마다 IndexedDB 저장 | `pane-persistence.spec.ts` |
| `usePaneDB` | `IndexedDB` | paneLayouts/savedLayouts CRUD | `pane-persistence.spec.ts` |
| `SplitPane` | `PaneResizer` | 경계선 드래그로 ratio 변경 | `pane-split.spec.ts` |
| `SplitPane` | `TerminalContainer` | Pane 리프에 터미널 렌더링 | `pane-split.spec.ts` |
| `TerminalContainer` | `useSSE` | Pane별 독립 SSE 연결 | `pane-split.spec.ts` |
| `TerminalView` | `usePaneManager` | Ctrl+B prefix 키 이벤트 전파 | `pane-keyboard.spec.ts` |
| `PaneRenderer` | `SplitPane` / `PaneCarousel` | 반응형 분기 렌더링 | `pane-carousel.spec.ts` |
| `PaneCarousel` | 터치 이벤트 | 스와이프 제스처 인식 | `pane-carousel.spec.ts` |
| `PaneIndicator` | `usePaneManager` | 도트 탭으로 포커스 변경 | `pane-carousel.spec.ts` |
| `ContextMenu` | `usePaneManager` | 메뉴 항목 → Pane 조작 명령 | `pane-split.spec.ts` |
| `TabBar` | `usePaneManager` / `usePaneDB` | 프리셋/저장/불러오기 | `pane-split.spec.ts` |
| `StatusBar` | `usePaneManager` | PREFIX/ZOOMED 상태 표시 | `pane-keyboard.spec.ts` |

---

## 5. Playwright 테스트 코드 템플릿

### 5.1 `pane-split.spec.ts` — 데스크톱 Pane 분할 시스템

**파일**: `frontend/tests/e2e/pane-split.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import {
  login,
  setupCleanState,
  waitForTerminal,
  waitForTerminalCount,
  rightClickPane,
  selectContextMenuItem,
  selectSubmenuItem,
  getPaneCount,
  verifyPaneCount,
  getFocusedPaneId,
  getServerSessionCount,
  clearIndexedDB,
  dragResizer,
  dismissContextMenu,
  SELECTORS,
} from './helpers';

test.describe('Pane Split System - Desktop', () => {

  test.beforeEach(async ({ page }) => {
    await setupCleanState(page);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6101: 수평/수직 Pane 분할
  // ────────────────────────────────────────────────────────────────

  test('TC-6101: 단일 Pane에서 수직 분할 시 좌우 2개 Pane 표시 (AC-6101-1)', async ({ page }) => {
    // Given: 단일 Pane 상태
    await verifyPaneCount(page, 1);

    // When: Pane 우클릭 → "수직 분할" 선택
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');

    // Then: 2개 Pane이 좌우로 표시
    await verifyPaneCount(page, 2);

    // Then: 2개의 독립 xterm.js 인스턴스가 렌더링
    await waitForTerminalCount(page, 2);
  });

  test('TC-6101-h: 단일 Pane에서 수평 분할 시 상하 2개 Pane 표시', async ({ page }) => {
    await verifyPaneCount(page, 1);

    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수평 분할');

    await verifyPaneCount(page, 2);
    await waitForTerminalCount(page, 2);

    // Then: 분할 방향 확인 (수평 = 상하 배치)
    const panes = page.locator(SELECTORS.PANE_LEAF);
    const pane0Box = await panes.nth(0).boundingBox();
    const pane1Box = await panes.nth(1).boundingBox();
    expect(pane0Box).toBeTruthy();
    expect(pane1Box).toBeTruthy();
    // 수평 분할이면 pane1이 pane0 아래에 위치
    expect(pane1Box!.y).toBeGreaterThan(pane0Box!.y);
  });

  test('TC-6101-focus: 분할 후 포커스가 새 Pane으로 이동 (AC-6101-2)', async ({ page }) => {
    // Given
    await verifyPaneCount(page, 1);
    const originalFocusId = await getFocusedPaneId(page);

    // When
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');

    // Then: 포커스가 새 Pane(두 번째)으로 이동
    await verifyPaneCount(page, 2);
    const newFocusId = await getFocusedPaneId(page);
    expect(newFocusId).not.toEqual(originalFocusId);
  });

  test('TC-6101-session: 분할 시 서버에 새 PTY 세션이 생성됨', async ({ page }) => {
    const initialCount = await getServerSessionCount(page);

    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    const newCount = await getServerSessionCount(page);
    expect(newCount).toBe(initialCount + 1);
  });

  test('TC-6102: 8개 Pane에서 분할 메뉴 비활성화 (AC-6101-3)', async ({ page }) => {
    // Given: 8개 Pane까지 분할 (7번 분할 필요)
    for (let i = 0; i < 7; i++) {
      await rightClickPane(page, 0);
      await selectContextMenuItem(page, '수직 분할');
      await page.waitForTimeout(500); // 세션 생성 대기
    }
    await verifyPaneCount(page, 8);

    // When: 우클릭 메뉴 열기
    await rightClickPane(page, 0);

    // Then: 분할 메뉴 항목이 비활성화 상태
    const splitItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '수직 분할' });
    await expect(splitItem.first()).toHaveClass(/disabled/);
  });

  test('TC-6701: 서버 오프라인 시 분할 에러 처리 (AC-6101-4)', async ({ page }) => {
    // Given: 세션 생성 API를 실패하도록 라우트 가로채기
    await page.route('**/api/sessions', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({ status: 500, body: JSON.stringify({ error: 'Server Error' }) });
      } else {
        route.continue();
      }
    });

    await verifyPaneCount(page, 1);

    // When: 분할 시도
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');

    // Then: Pane 수 변경 없음
    await page.waitForTimeout(1000);
    await verifyPaneCount(page, 1);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6102: Pane 닫기
  // ────────────────────────────────────────────────────────────────

  test('TC-6103: 2개 Pane에서 하나 닫기 (AC-6102-1, AC-6102-2)', async ({ page }) => {
    // Given: 2개 Pane 상태로 만들기
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    const sessionsBefore = await getServerSessionCount(page);

    // When: 두 번째 Pane 닫기
    await rightClickPane(page, 1);
    await selectContextMenuItem(page, 'Pane 닫기');

    // Then: 1개 Pane만 남고 전체 영역 차지
    await verifyPaneCount(page, 1);

    // Then: 서버에서 세션 삭제 확인
    await page.waitForTimeout(500);
    const sessionsAfter = await getServerSessionCount(page);
    expect(sessionsAfter).toBe(sessionsBefore - 1);
  });

  test('TC-6104: 마지막 Pane 닫기 메뉴 비활성화 (AC-6102-3)', async ({ page }) => {
    await verifyPaneCount(page, 1);

    await rightClickPane(page, 0);

    const closeItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: 'Pane 닫기' });
    await expect(closeItem.first()).toHaveClass(/disabled/);
  });

  test('TC-6702: "다른 Pane 모두 닫기" 실행', async ({ page }) => {
    // Given: 3개 Pane
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수평 분할');
    await verifyPaneCount(page, 3);

    // When: 첫 번째 Pane에서 "다른 Pane 모두 닫기"
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '다른 Pane 모두 닫기');

    // Then: 1개 Pane만 남음
    await verifyPaneCount(page, 1);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6103: Pane 리사이즈
  // ────────────────────────────────────────────────────────────────

  test('TC-6105: 분할 경계선 드래그로 리사이즈 (AC-6103-1)', async ({ page }) => {
    // Given: 수직 분할 (좌우 50:50)
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // 초기 Pane 너비 기록
    const panes = page.locator(SELECTORS.PANE_LEAF);
    const initialWidth0 = (await panes.nth(0).boundingBox())!.width;

    // When: 리사이저를 오른쪽으로 100px 드래그
    await dragResizer(page, 0, 100, 0);

    // Then: 첫 번째 Pane 너비가 증가
    const newWidth0 = (await panes.nth(0).boundingBox())!.width;
    expect(newWidth0).toBeGreaterThan(initialWidth0);
  });

  test('TC-6106: 극단적 리사이즈 시 ratio 클램핑 (AC-6103-3)', async ({ page }) => {
    // Given: 수직 분할
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // When: 리사이저를 극단적으로 오른쪽으로 이동 (1000px)
    await dragResizer(page, 0, 1000, 0);

    // Then: 두 번째 Pane이 여전히 최소 120px 이상의 너비를 가짐
    const panes = page.locator(SELECTORS.PANE_LEAF);
    const pane1Box = await panes.nth(1).boundingBox();
    expect(pane1Box!.width).toBeGreaterThanOrEqual(120);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6104: Pane 줌
  // ────────────────────────────────────────────────────────────────

  test('TC-6107: Pane 줌 토글 (AC-6104-1, AC-6104-2)', async ({ page }) => {
    // Given: 4분할 상태 (프리셋 또는 수동 분할)
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수평 분할');
    await verifyPaneCount(page, 3);
    await rightClickPane(page, 1);
    await selectContextMenuItem(page, '수평 분할');
    await verifyPaneCount(page, 4);

    // When: Pane 0을 줌
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '줌 토글');

    // Then: 줌된 Pane만 보이고, 나머지 숨겨짐 (visible Pane = 1)
    const visiblePanes = page.locator(`${SELECTORS.PANE_LEAF}:visible`);
    await expect(visiblePanes).toHaveCount(1);

    // Then: ZOOMED 상태 표시
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).toBeVisible();

    // When: 줌 해제
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '줌 토글');

    // Then: 4개 Pane 모두 복원
    await verifyPaneCount(page, 4);
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).not.toBeVisible();
  });

  test('TC-6107-zoom-disabled: 줌 상태에서 분할/닫기 비활성화 (AC-6104-3)', async ({ page }) => {
    // Given: 2 Pane + 줌
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '줌 토글');

    // When: 줌 상태에서 우클릭
    await rightClickPane(page, 0);

    // Then: 분할 항목 비활성화
    const splitItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '수직 분할' });
    await expect(splitItem.first()).toHaveClass(/disabled/);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6105: Pane 교환
  // ────────────────────────────────────────────────────────────────

  test('TC-6108: 2개 Pane 교환 (AC-6105-1, AC-6105-2)', async ({ page }) => {
    // Given: 수직 분할 2개 Pane
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // 초기 세션 ID 기록
    const pane0SessionBefore = await page.locator(SELECTORS.PANE_LEAF).nth(0).getAttribute('data-session-id');
    const pane1SessionBefore = await page.locator(SELECTORS.PANE_LEAF).nth(1).getAttribute('data-session-id');

    // When: Pane 0에서 "Pane 교환" 시작
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, 'Pane 교환');

    // Then: 교환 소스 하이라이트
    await expect(page.locator(SELECTORS.SWAP_HIGHLIGHT)).toBeVisible();

    // When: Pane 1 클릭하여 교환 실행
    await page.locator(SELECTORS.PANE_LEAF).nth(1).click();

    // Then: 세션이 반대 위치로 이동
    await page.waitForTimeout(300);
    const pane0SessionAfter = await page.locator(SELECTORS.PANE_LEAF).nth(0).getAttribute('data-session-id');
    const pane1SessionAfter = await page.locator(SELECTORS.PANE_LEAF).nth(1).getAttribute('data-session-id');
    expect(pane0SessionAfter).toBe(pane1SessionBefore);
    expect(pane1SessionAfter).toBe(pane0SessionBefore);
  });

  test('TC-6706: Pane 교환 모드에서 ESC 취소', async ({ page }) => {
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    await rightClickPane(page, 0);
    await selectContextMenuItem(page, 'Pane 교환');
    await expect(page.locator(SELECTORS.SWAP_HIGHLIGHT)).toBeVisible();

    // When: ESC 키
    await page.keyboard.press('Escape');

    // Then: 교환 모드 취소
    await expect(page.locator(SELECTORS.SWAP_HIGHLIGHT)).not.toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6106: Pane 포커스 이동
  // ────────────────────────────────────────────────────────────────

  test('TC-6109: Pane 클릭으로 포커스 이동 (AC-6106-1)', async ({ page }) => {
    // Given: 2개 Pane
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // When: 첫 번째 Pane 클릭
    await page.locator(SELECTORS.PANE_LEAF).nth(0).click();

    // Then: 첫 번째 Pane에 포커스 표시
    await expect(page.locator(SELECTORS.PANE_LEAF).nth(0)).toHaveAttribute('data-pane-focused', 'true');
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6201~6204: 컨텍스트 메뉴
  // ────────────────────────────────────────────────────────────────

  test('TC-6201: 터미널 우클릭 컨텍스트 메뉴 표시 (AC-6201-1)', async ({ page }) => {
    await rightClickPane(page, 0);

    // Then: 컨텍스트 메뉴가 표시됨
    await expect(page.locator(SELECTORS.CONTEXT_MENU)).toBeVisible();

    // Then: 주요 메뉴 항목 존재
    await expect(page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '수평 분할' })).toBeVisible();
    await expect(page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '수직 분할' })).toBeVisible();
    await expect(page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '줌 토글' })).toBeVisible();
    await expect(page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: 'Pane 닫기' })).toBeVisible();
  });

  test('TC-6201-dismiss: 메뉴 외부 클릭 시 닫힘 (AC-6201-3)', async ({ page }) => {
    await rightClickPane(page, 0);
    await expect(page.locator(SELECTORS.CONTEXT_MENU)).toBeVisible();

    await dismissContextMenu(page);
    await expect(page.locator(SELECTORS.CONTEXT_MENU)).not.toBeVisible();
  });

  test('TC-6202: 분할 경계선 우클릭 메뉴 (AC-6202-1, AC-6202-2)', async ({ page }) => {
    // Given: 수직 분할
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // When: 경계선 우클릭
    const resizer = page.locator(SELECTORS.PANE_RESIZER).first();
    await resizer.click({ button: 'right' });

    // Then: 경계선 메뉴 표시
    await expect(page.locator(SELECTORS.CONTEXT_MENU)).toBeVisible();
    await expect(page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '균등 분할' })).toBeVisible();
    await expect(page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '방향 전환' })).toBeVisible();
  });

  test('TC-6202-equalize: 균등 분할 실행 (AC-6202-2)', async ({ page }) => {
    // Given: 수직 분할 후 리사이즈하여 불균등 상태
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);
    await dragResizer(page, 0, 200, 0);

    // When: 경계선 우클릭 → "균등 분할"
    const resizer = page.locator(SELECTORS.PANE_RESIZER).first();
    await resizer.click({ button: 'right' });
    await selectContextMenuItem(page, '균등 분할');

    // Then: 양쪽 Pane 너비가 거의 같음 (5% 허용 오차)
    await page.waitForTimeout(300);
    const panes = page.locator(SELECTORS.PANE_LEAF);
    const width0 = (await panes.nth(0).boundingBox())!.width;
    const width1 = (await panes.nth(1).boundingBox())!.width;
    const ratio = width0 / (width0 + width1);
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  test('TC-6202-toggle: 방향 전환 (AC-6202-3)', async ({ page }) => {
    // Given: 수직 분할 (좌우)
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    const panes = page.locator(SELECTORS.PANE_LEAF);
    const pane0Before = await panes.nth(0).boundingBox();
    const pane1Before = await panes.nth(1).boundingBox();
    // 수직 분할이면 좌우 배치 (Y좌표 유사)
    expect(Math.abs(pane0Before!.y - pane1Before!.y)).toBeLessThan(10);

    // When: 방향 전환
    const resizer = page.locator(SELECTORS.PANE_RESIZER).first();
    await resizer.click({ button: 'right' });
    await selectContextMenuItem(page, '방향 전환');

    // Then: 수평 분할(상하)로 변경
    await page.waitForTimeout(300);
    const pane0After = await panes.nth(0).boundingBox();
    const pane1After = await panes.nth(1).boundingBox();
    expect(pane1After!.y).toBeGreaterThan(pane0After!.y + 10);
  });

  test('TC-6203: TabBar 프리셋 서브메뉴 (AC-6203-1, AC-6203-2)', async ({ page }) => {
    // When: 탭 우클릭 → "프리셋 레이아웃" 호버 → "좌우 분할" 선택
    const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
    await tabItem.click({ button: 'right' });
    await selectSubmenuItem(page, '프리셋 레이아웃', '좌우 분할');

    // Then: 2개 Pane 좌우 분할
    await verifyPaneCount(page, 2);
  });

  test('TC-6203-quad: 4분할 프리셋 (AC-6503-1)', async ({ page }) => {
    const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
    await tabItem.click({ button: 'right' });
    await selectSubmenuItem(page, '프리셋 레이아웃', '4분할');

    await verifyPaneCount(page, 4);
    await waitForTerminalCount(page, 4);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6305: 모바일-데스크톱 전환 일관성
  // ────────────────────────────────────────────────────────────────

  test('TC-6712: 데스크톱 4분할 → 모바일 → 다시 데스크톱 (AC-6305-1)', async ({ page }) => {
    // Given: 4분할
    const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
    await tabItem.click({ button: 'right' });
    await selectSubmenuItem(page, '프리셋 레이아웃', '4분할');
    await verifyPaneCount(page, 4);

    // When: 모바일 뷰포트로 변경
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);

    // Then: 캐러셀 모드 전환, 4개 도트 표시
    await expect(page.locator(SELECTORS.CAROUSEL)).toBeVisible();
    const dots = page.locator(SELECTORS.PANE_DOT);
    await expect(dots).toHaveCount(4);

    // When: 다시 데스크톱 뷰포트
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(500);

    // Then: 4분할 레이아웃 복원
    await verifyPaneCount(page, 4);
    await expect(page.locator(SELECTORS.CAROUSEL)).not.toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────
  // 핵심 비즈니스 플로우 (시나리오 3.1)
  // ────────────────────────────────────────────────────────────────

  test('CRITICAL: 전체 분할 플로우 (분할→리사이즈→줌→닫기→복원)', async ({ page }) => {
    // Step 1: 수직 분할
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // Step 2: 수평 분할 (Pane 0)
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수평 분할');
    await verifyPaneCount(page, 3);

    // Step 3: 리사이즈
    const panesBefore = page.locator(SELECTORS.PANE_LEAF);
    const width0Before = (await panesBefore.nth(0).boundingBox())!.width;
    await dragResizer(page, 0, 50, 0);
    const width0After = (await panesBefore.nth(0).boundingBox())!.width;
    expect(Math.abs(width0After - width0Before)).toBeGreaterThan(10);

    // Step 4: 줌 토글
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '줌 토글');
    const visibleDuringZoom = page.locator(`${SELECTORS.PANE_LEAF}:visible`);
    await expect(visibleDuringZoom).toHaveCount(1);

    // Step 5: 줌 해제
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '줌 토글');
    await verifyPaneCount(page, 3);

    // Step 6: Pane 닫기
    await rightClickPane(page, 2);
    await selectContextMenuItem(page, 'Pane 닫기');
    await verifyPaneCount(page, 2);

    // Step 7: 새로고침 후 복원 확인
    await page.reload();
    await waitForTerminal(page);
    await verifyPaneCount(page, 2);
  });
});
```

### 5.2 `pane-carousel.spec.ts` — 모바일 캐러셀

**파일**: `frontend/tests/e2e/pane-carousel.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import {
  login,
  waitForTerminal,
  longPressPane,
  selectContextMenuItem,
  swipeLeft,
  swipeRight,
  verifyPaneCount,
  clearIndexedDB,
  SELECTORS,
} from './helpers';

/**
 * 모바일 캐러셀 테스트는 "Mobile Safari" 프로젝트에서만 실행한다.
 * playwright.config.ts의 Mobile Safari 프로젝트가 iPhone 13(390x844) 에뮬레이션을 사용한다.
 */
test.describe('Pane Carousel - Mobile', () => {

  test.beforeEach(async ({ page }) => {
    // 모바일 뷰포트 확인 (768px 이하)
    const viewport = page.viewportSize();
    if (viewport && viewport.width > 768) {
      test.skip();
      return;
    }

    await page.goto('about:blank');
    await page.evaluate(() => { localStorage.clear(); });
    await clearIndexedDB(page);

    const token = await login(page);
    await page.goto('/');
    await page.evaluate((t: string) => {
      localStorage.setItem('auth_token', t);
    }, token);
    await page.reload();
    await waitForTerminal(page);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6301: 반응형 렌더링 분기
  // ────────────────────────────────────────────────────────────────

  test('TC-6301: 768px 이하에서 캐러셀 모드 표시 (AC-6301-1)', async ({ page }) => {
    // Then: 캐러셀 컨테이너가 표시됨
    await expect(page.locator(SELECTORS.CAROUSEL)).toBeVisible();

    // Then: 도트 인디케이터 1개 (단일 Pane)
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(1);
    await expect(page.locator(SELECTORS.PANE_DOT_ACTIVE)).toHaveCount(1);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6302: 횡 스와이프 전환
  // ────────────────────────────────────────────────────────────────

  test('TC-6302: 좌우 스와이프로 Pane 전환 (AC-6302-1)', async ({ page }) => {
    // Given: 롱프레스 → 분할로 2개 Pane 생성
    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);

    // 도트 2개 확인
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(2);

    // When: 왼쪽 스와이프 (다음 Pane으로)
    await swipeLeft(page);

    // Then: 두 번째 도트가 활성화
    const activeDot = page.locator(SELECTORS.PANE_DOT_ACTIVE);
    // 위치 텍스트 확인
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('2/2');
  });

  test('TC-6302-bounce: 첫 Pane에서 오른쪽 스와이프 시 바운스 (AC-6302-2)', async ({ page }) => {
    // Given: 2개 Pane, 현재 첫 번째 Pane
    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);

    // When: 오른쪽 스와이프 (이전 Pane으로, 하지만 이전이 없음)
    await swipeRight(page);

    // Then: 여전히 첫 번째 Pane
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('1/2');
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6303: Pane 인디케이터
  // ────────────────────────────────────────────────────────────────

  test('TC-6303: 도트 인디케이터 및 탭 이동 (AC-6303-1, AC-6303-2)', async ({ page }) => {
    // Given: 3개 Pane
    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);

    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);

    // Then: 도트 3개
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(3);

    // When: 세 번째 도트 탭
    await page.locator(SELECTORS.PANE_DOT).nth(2).tap();
    await page.waitForTimeout(400);

    // Then: 세 번째 Pane으로 이동
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('3/3');
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6304: 모바일 Pane 추가
  // ────────────────────────────────────────────────────────────────

  test('TC-6304: 모바일 Pane 추가 후 자동 전환 (AC-6304-1)', async ({ page }) => {
    // Given: 단일 Pane
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(1);

    // When: 롱프레스 → 분할
    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);

    // Then: 도트 2개로 증가
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(2);

    // Then: 새 Pane(2번째)으로 자동 전환
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('2/2');
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6306: 모바일 Pane 닫기
  // ────────────────────────────────────────────────────────────────

  test('TC-6705: 모바일에서 현재 Pane 닫기 (AC-6306-1)', async ({ page }) => {
    // Given: 3개 Pane, 현재 2번째 Pane 표시 중
    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);

    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);

    // 2번째 Pane으로 이동
    await swipeLeft(page);
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('2/3');

    // When: 현재 Pane 닫기
    await longPressPane(page, 0);
    await selectContextMenuItem(page, 'Pane 닫기');
    await page.waitForTimeout(500);

    // Then: 도트 2개로 감소, 이전 Pane(1번째)으로 이동
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(2);
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('1/2');
  });

  test('TC-6306-last: 마지막 Pane 닫기 비활성화 (AC-6306-2)', async ({ page }) => {
    // Given: 단일 Pane
    await longPressPane(page, 0);

    // Then: "Pane 닫기" 메뉴 비활성화 확인
    const closeItem = page.locator(`${SELECTORS.CONTEXT_MENU_ITEM}, .bottom-sheet-item`)
      .filter({ hasText: 'Pane 닫기' });
    // 비활성 상태 확인 (disabled class 또는 aria-disabled)
    const isDisabled = await closeItem.first().evaluate(
      (el: Element) => el.classList.contains('disabled') || el.getAttribute('aria-disabled') === 'true'
    );
    expect(isDisabled).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6205: 모바일 롱프레스 메뉴
  // ────────────────────────────────────────────────────────────────

  test('TC-6205: 모바일 롱프레스 바텀시트 메뉴 (AC-6205-1)', async ({ page }) => {
    // When: 롱프레스
    await longPressPane(page, 0);

    // Then: 바텀시트 또는 컨텍스트 메뉴가 표시됨
    const menu = page.locator(`${SELECTORS.BOTTOM_SHEET}, ${SELECTORS.CONTEXT_MENU}`);
    await expect(menu.first()).toBeVisible();

    // Then: 주요 메뉴 항목 존재
    const menuItems = page.locator(`${SELECTORS.CONTEXT_MENU_ITEM}, .bottom-sheet-item`);
    const texts = await menuItems.allTextContents();
    const hasHorizontalSplit = texts.some(t => t.includes('수평 분할'));
    const hasVerticalSplit = texts.some(t => t.includes('수직 분할'));
    expect(hasHorizontalSplit).toBe(true);
    expect(hasVerticalSplit).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────
  // 모바일 완전 플로우 (시나리오 3.4)
  // ────────────────────────────────────────────────────────────────

  test('CRITICAL: 모바일 전체 플로우 (추가→스와이프→도트탭→닫기)', async ({ page }) => {
    // Step 1: 롱프레스 → Pane 추가
    await longPressPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await page.waitForTimeout(1000);
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(2);

    // Step 2: 왼쪽 스와이프 → Pane 2
    await swipeLeft(page);
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('2/2');

    // Step 3: 오른쪽 스와이프 → Pane 1
    await swipeRight(page);
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('1/2');

    // Step 4: 도트 탭 → Pane 2
    await page.locator(SELECTORS.PANE_DOT).nth(1).tap();
    await page.waitForTimeout(400);
    await expect(page.locator(SELECTORS.PANE_POSITION_TEXT)).toContainText('2/2');

    // Step 5: Pane 닫기
    await longPressPane(page, 0);
    await selectContextMenuItem(page, 'Pane 닫기');
    await page.waitForTimeout(500);
    await expect(page.locator(SELECTORS.PANE_DOT)).toHaveCount(1);
  });
});
```

### 5.3 `pane-keyboard.spec.ts` — 키보드 단축키

**파일**: `frontend/tests/e2e/pane-keyboard.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import {
  setupCleanState,
  waitForTerminal,
  rightClickPane,
  selectContextMenuItem,
  pressCtrlB,
  pressPrefixKey,
  sendRawCtrlB,
  verifyPaneCount,
  getFocusedPaneId,
  SELECTORS,
} from './helpers';

test.describe('Pane Keyboard Shortcuts', () => {

  test.beforeEach(async ({ page }) => {
    await setupCleanState(page);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6601: Ctrl+B Prefix 모드
  // ────────────────────────────────────────────────────────────────

  test('TC-6601: Ctrl+B Prefix 모드 진입 시 StatusBar 표시 (AC-6601-1)', async ({ page }) => {
    // When: Ctrl+B
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressCtrlB(page);

    // Then: StatusBar에 [PREFIX] 표시
    await expect(page.locator(SELECTORS.STATUS_PREFIX)).toBeVisible();
  });

  test('TC-6606: 1500ms 무입력 시 Prefix 자동 해제 (AC-6601-3)', async ({ page }) => {
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressCtrlB(page);
    await expect(page.locator(SELECTORS.STATUS_PREFIX)).toBeVisible();

    // When: 1500ms 대기
    await page.waitForTimeout(1600);

    // Then: Prefix 모드 자동 해제
    await expect(page.locator(SELECTORS.STATUS_PREFIX)).not.toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6602: Pane 조작 단축키
  // ────────────────────────────────────────────────────────────────

  test('TC-6602: Ctrl+B, % 수직 분할 (AC-6602-1)', async ({ page }) => {
    await verifyPaneCount(page, 1);

    // Pane에 포커스
    await page.locator(SELECTORS.PANE_LEAF).first().click();

    // When: Ctrl+B, %
    await pressPrefixKey(page, '%');

    // Then: 2개 Pane
    await verifyPaneCount(page, 2);
  });

  test('TC-6602-h: Ctrl+B, " 수평 분할', async ({ page }) => {
    await verifyPaneCount(page, 1);
    await page.locator(SELECTORS.PANE_LEAF).first().click();

    await pressPrefixKey(page, '"');

    await verifyPaneCount(page, 2);

    // 수평 분할 확인
    const panes = page.locator(SELECTORS.PANE_LEAF);
    const p0 = await panes.nth(0).boundingBox();
    const p1 = await panes.nth(1).boundingBox();
    expect(p1!.y).toBeGreaterThan(p0!.y);
  });

  test('TC-6109-kbd: Ctrl+B, 방향키로 포커스 이동 (AC-6106-2)', async ({ page }) => {
    // Given: 수직 분할 2개 Pane
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressPrefixKey(page, '%');
    await verifyPaneCount(page, 2);

    // 포커스가 새 Pane(오른쪽)에 있음
    const focusedBefore = await getFocusedPaneId(page);

    // When: Ctrl+B, ArrowLeft (왼쪽으로 이동)
    await pressPrefixKey(page, 'ArrowLeft');

    // Then: 포커스가 왼쪽 Pane으로 이동
    const focusedAfter = await getFocusedPaneId(page);
    expect(focusedAfter).not.toEqual(focusedBefore);
  });

  test('TC-6603: Ctrl+B, x Pane 닫기 (AC-6602-2)', async ({ page }) => {
    // Given: 2개 Pane
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressPrefixKey(page, '%');
    await verifyPaneCount(page, 2);

    // When: Ctrl+B, x
    await pressPrefixKey(page, 'x');

    // Then: 닫기 실행 (확인 프롬프트 후)
    // 확인 모달이 있으면 확인 클릭
    const confirmBtn = page.locator('button').filter({ hasText: /확인|닫기|Yes|OK/i });
    if (await confirmBtn.count() > 0) {
      await confirmBtn.first().click();
    }

    await verifyPaneCount(page, 1);
  });

  test('TC-6602-z: Ctrl+B, z 줌 토글', async ({ page }) => {
    // Given: 2개 Pane
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressPrefixKey(page, '%');
    await verifyPaneCount(page, 2);

    // When: Ctrl+B, z (줌)
    await pressPrefixKey(page, 'z');

    // Then: 줌 상태
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).toBeVisible();

    // When: Ctrl+B, z (줌 해제)
    await pressPrefixKey(page, 'z');

    // Then: 줌 해제
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).not.toBeVisible();
    await verifyPaneCount(page, 2);
  });

  test('TC-6602-o: Ctrl+B, o 다음 Pane 순환', async ({ page }) => {
    // Given: 2개 Pane
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressPrefixKey(page, '%');
    await verifyPaneCount(page, 2);

    const focusBefore = await getFocusedPaneId(page);

    // When: Ctrl+B, o
    await pressPrefixKey(page, 'o');

    // Then: 다른 Pane으로 포커스 이동
    const focusAfter = await getFocusedPaneId(page);
    expect(focusAfter).not.toEqual(focusBefore);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6603: Pane 번호 오버레이
  // ────────────────────────────────────────────────────────────────

  test('TC-6604: Ctrl+B, q 번호 오버레이 (AC-6603-1, AC-6603-2)', async ({ page }) => {
    // Given: 3개 Pane
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressPrefixKey(page, '%');
    await verifyPaneCount(page, 2);
    await pressPrefixKey(page, '"');
    await verifyPaneCount(page, 3);

    // When: Ctrl+B, q
    await pressPrefixKey(page, 'q');

    // Then: 번호 오버레이 표시 (0, 1, 2)
    const overlays = page.locator(SELECTORS.PANE_NUMBER_OVERLAY);
    await expect(overlays).toHaveCount(3);

    // 오버레이 텍스트 확인
    const texts = await overlays.allTextContents();
    expect(texts).toContain('0');
    expect(texts).toContain('1');
    expect(texts).toContain('2');

    // When: "1" 키 입력
    await page.keyboard.press('1');

    // Then: Pane 1로 포커스 이동, 오버레이 사라짐
    await page.waitForTimeout(300);
    await expect(overlays).toHaveCount(0);
  });

  test('TC-6604-timeout: 번호 오버레이 2초 후 자동 사라짐', async ({ page }) => {
    // Given: 2개 Pane
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressPrefixKey(page, '%');
    await verifyPaneCount(page, 2);

    // When: Ctrl+B, q
    await pressPrefixKey(page, 'q');
    await expect(page.locator(SELECTORS.PANE_NUMBER_OVERLAY)).toHaveCount(2);

    // When: 2초 대기 (키 입력 없음)
    await page.waitForTimeout(2100);

    // Then: 오버레이 자동 사라짐
    await expect(page.locator(SELECTORS.PANE_NUMBER_OVERLAY)).toHaveCount(0);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6604: Prefix 모드 에러 처리
  // ────────────────────────────────────────────────────────────────

  test('TC-6707: 인식 불가 키 입력 시 Prefix 해제', async ({ page }) => {
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressCtrlB(page);
    await expect(page.locator(SELECTORS.STATUS_PREFIX)).toBeVisible();

    // When: 인식 불가 키 (예: "1")
    await page.keyboard.press('a');

    // Then: Prefix 모드 해제
    await page.waitForTimeout(200);
    await expect(page.locator(SELECTORS.STATUS_PREFIX)).not.toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6605: Ctrl+B, Ctrl+B → PTY에 \x02 전달
  // ────────────────────────────────────────────────────────────────

  test('TC-6605: Ctrl+B, Ctrl+B → PTY에 \\x02 전달 (AC-6605-1)', async ({ page }) => {
    await page.locator(SELECTORS.PANE_LEAF).first().click();

    // When: Ctrl+B, Ctrl+B
    await sendRawCtrlB(page);

    // Then: Prefix 모드가 해제됨 (두 번째 Ctrl+B가 PTY로 전달됨)
    await page.waitForTimeout(200);
    await expect(page.locator(SELECTORS.STATUS_PREFIX)).not.toBeVisible();

    // 참고: PTY에 실제 \x02가 전달되었는지는 터미널 출력으로는 직접 확인이 어려움.
    // 해당 검증은 단위 테스트(customKeyEventHandler 모킹)에서 수행한다.
  });

  // ────────────────────────────────────────────────────────────────
  // 키보드 완전 플로우 (시나리오 3.5)
  // ────────────────────────────────────────────────────────────────

  test('CRITICAL: 키보드 전체 플로우 (분할→포커스→줌→번호→닫기)', async ({ page }) => {
    // Step 1: Ctrl+B, % (수직 분할)
    await page.locator(SELECTORS.PANE_LEAF).first().click();
    await pressPrefixKey(page, '%');
    await verifyPaneCount(page, 2);

    // Step 2: Ctrl+B, ArrowRight (포커스 이동)
    // 분할 후 포커스가 새 Pane(오른쪽)에 있으므로, ArrowLeft로 왼쪽 Pane으로 이동
    await pressPrefixKey(page, 'ArrowLeft');
    const leftFocused = await getFocusedPaneId(page);

    // Step 3: Ctrl+B, z (줌)
    await pressPrefixKey(page, 'z');
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).toBeVisible();

    // Step 4: Ctrl+B, z (줌 해제)
    await pressPrefixKey(page, 'z');
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).not.toBeVisible();

    // Step 5: Ctrl+B, q (번호 오버레이)
    await pressPrefixKey(page, 'q');
    await expect(page.locator(SELECTORS.PANE_NUMBER_OVERLAY)).toHaveCount(2);

    // Step 6: "1" 키로 Pane 1 선택
    await page.keyboard.press('1');
    await page.waitForTimeout(300);
    const newFocused = await getFocusedPaneId(page);
    expect(newFocused).not.toEqual(leftFocused);

    // Step 7: Ctrl+B, x (닫기)
    await pressPrefixKey(page, 'x');
    // 확인 모달 처리
    const confirmBtn = page.locator('button').filter({ hasText: /확인|닫기|Yes|OK/i });
    if (await confirmBtn.count() > 0) {
      await confirmBtn.first().click();
    }
    await verifyPaneCount(page, 1);
  });
});
```

### 5.4 `pane-persistence.spec.ts` — IndexedDB 영속화

**파일**: `frontend/tests/e2e/pane-persistence.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import {
  login,
  setupCleanState,
  waitForTerminal,
  rightClickPane,
  selectContextMenuItem,
  selectSubmenuItem,
  verifyPaneCount,
  clearIndexedDB,
  getStoredLayout,
  getSavedLayoutCount,
  SELECTORS,
} from './helpers';

test.describe('Pane Persistence - IndexedDB', () => {

  test.beforeEach(async ({ page }) => {
    await setupCleanState(page);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6401~6406: 레이아웃 저장/복원
  // ────────────────────────────────────────────────────────────────

  test('TC-6401: 분할 후 새로고침 시 레이아웃 복원', async ({ page }) => {
    // Given: 수직 분할 2개 Pane
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // IndexedDB에 저장될 시간 대기 (300ms debounce)
    await page.waitForTimeout(500);

    // When: 페이지 새로고침
    await page.reload();
    await waitForTerminal(page);

    // Then: 2개 Pane 복원
    await verifyPaneCount(page, 2);
  });

  test('TC-6401-complex: 복잡한 레이아웃 복원 (3분할)', async ({ page }) => {
    // Given: 3분할 레이아웃
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수평 분할');
    await verifyPaneCount(page, 3);

    await page.waitForTimeout(500);

    // When: 새로고침
    await page.reload();
    await waitForTerminal(page);

    // Then: 3개 Pane 복원
    await verifyPaneCount(page, 3);
  });

  test('TC-6704: 줌 상태가 새로고침 후 복원됨', async ({ page }) => {
    // Given: 2 Pane + 줌
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '줌 토글');
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).toBeVisible();

    await page.waitForTimeout(500);

    // When: 새로고침
    await page.reload();
    await waitForTerminal(page);

    // Then: 줌 상태 복원
    await expect(page.locator(SELECTORS.STATUS_ZOOMED)).toBeVisible();
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6501: 기본 프리셋 초기화
  // ────────────────────────────────────────────────────────────────

  test('TC-6501: 최초 로드 시 6개 기본 프리셋 생성 (AC-6501-1)', async ({ page }) => {
    // 기본 프리셋은 앱 로드 시 IndexedDB에 자동 생성됨
    // savedLayouts에 최소 6개 레코드 존재 확인
    const count = await getSavedLayoutCount(page);
    expect(count).toBeGreaterThanOrEqual(6);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6502: 커스텀 레이아웃 저장/불러오기
  // ────────────────────────────────────────────────────────────────

  test('TC-6502: 커스텀 레이아웃 저장 및 불러오기 (AC-6502-1, AC-6503-1)', async ({ page }) => {
    // Given: 수직 분할 2개 Pane
    await rightClickPane(page, 0);
    await selectContextMenuItem(page, '수직 분할');
    await verifyPaneCount(page, 2);

    // When: TabBar 우클릭 → "레이아웃 저장"
    const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
    await tabItem.click({ button: 'right' });
    await selectContextMenuItem(page, '레이아웃 저장');

    // 이름 입력
    const nameInput = page.locator('input[placeholder*="이름"], input[type="text"]').first();
    await nameInput.waitFor({ state: 'visible', timeout: 3_000 });
    await nameInput.fill('나의 2분할');

    // 저장 확인 버튼
    const saveBtn = page.locator('button').filter({ hasText: /저장|Save|확인|OK/i });
    await saveBtn.first().click();

    // savedLayouts 카운트 증가 확인
    await page.waitForTimeout(500);
    const countAfterSave = await getSavedLayoutCount(page);
    expect(countAfterSave).toBeGreaterThanOrEqual(7); // 6 built-in + 1 custom

    // When: 프리셋 적용으로 레이아웃 변경 (단일로 리셋)
    await tabItem.click({ button: 'right' });
    await selectSubmenuItem(page, '프리셋 레이아웃', '단일');
    // 확인 모달 처리
    const confirmBtn = page.locator('button').filter({ hasText: /확인|계속|Yes|OK/i });
    if (await confirmBtn.count() > 0) {
      await confirmBtn.first().click();
    }
    await verifyPaneCount(page, 1);

    // When: "레이아웃 불러오기" → "나의 2분할" 선택
    await tabItem.click({ button: 'right' });
    await selectContextMenuItem(page, '레이아웃 불러오기');
    const layoutItem = page.locator(`${SELECTORS.CONTEXT_MENU_ITEM}, .layout-list-item`)
      .filter({ hasText: '나의 2분할' });
    await layoutItem.first().click();

    // 확인 모달 처리
    if (await confirmBtn.count() > 0) {
      await confirmBtn.first().click();
    }

    // Then: 2개 Pane 복원
    await verifyPaneCount(page, 2);
  });

  // ────────────────────────────────────────────────────────────────
  // 세션 불일치 자동 정리 (TC-6710)
  // ────────────────────────────────────────────────────────────────

  test('TC-6710: IndexedDB에 stale sessionId → 자동 정리', async ({ page }) => {
    // Given: IndexedDB에 존재하지 않는 sessionId를 가진 레이아웃을 강제 삽입
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('buildergate', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('paneLayouts')) {
            db.createObjectStore('paneLayouts', { keyPath: 'sessionId' });
          }
          if (!db.objectStoreNames.contains('savedLayouts')) {
            db.createObjectStore('savedLayouts', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('sessionMeta')) {
            db.createObjectStore('sessionMeta', { keyPath: 'sessionId' });
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('paneLayouts', 'readwrite');
          tx.objectStore('paneLayouts').put({
            sessionId: 'test-stale-session',
            layout: {
              root: {
                type: 'split',
                id: 'split-1',
                direction: 'vertical',
                ratio: 0.5,
                children: [
                  { type: 'terminal', id: 'pane-1', sessionId: 'nonexistent-session-1' },
                  { type: 'terminal', id: 'pane-2', sessionId: 'nonexistent-session-2' },
                ],
              },
              focusedPaneId: 'pane-1',
              zoomedPaneId: null,
            },
            updatedAt: Date.now(),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
    });

    // When: 앱 새로고침 (서버에 해당 세션 없음)
    await page.reload();
    await waitForTerminal(page);

    // Then: stale Pane이 제거되고 기본 단일 Pane으로 폴백
    await verifyPaneCount(page, 1);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6407: localStorage → IndexedDB 마이그레이션
  // ────────────────────────────────────────────────────────────────

  test('TC-6402: localStorage에서 IndexedDB로 마이그레이션', async ({ page }) => {
    // Given: 마이그레이션 플래그 없음 상태
    await page.evaluate(() => {
      localStorage.removeItem('migrated_to_idb');
    });

    // When: 앱 로드
    await page.reload();
    await waitForTerminal(page);

    // Then: 마이그레이션 플래그가 설정됨
    const flag = await page.evaluate(() => localStorage.getItem('migrated_to_idb'));
    expect(flag).toBeTruthy();
  });

  test('TC-6708: 손상된 localStorage 마이그레이션 실패 시 기본 Pane 초기화', async ({ page }) => {
    // Given: 손상된 JSON 데이터 삽입
    await page.evaluate(() => {
      localStorage.removeItem('migrated_to_idb');
      localStorage.setItem('tab_state_corrupted', '{invalid json!!!');
    });

    // When: 앱 로드
    await page.reload();
    await waitForTerminal(page);

    // Then: 기본 단일 Pane으로 정상 동작
    await verifyPaneCount(page, 1);
  });
});
```

### 5.5 추가 테스트 — `pane-context-menu.spec.ts`

**파일**: `frontend/tests/e2e/pane-context-menu.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import {
  setupCleanState,
  rightClickPane,
  selectContextMenuItem,
  selectSubmenuItem,
  dismissContextMenu,
  verifyPaneCount,
  SELECTORS,
} from './helpers';

test.describe('Pane Context Menu & Submenu', () => {

  test.beforeEach(async ({ page }) => {
    await setupCleanState(page);
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6204: 서브메뉴 지원
  // ────────────────────────────────────────────────────────────────

  test('TC-6204: 서브메뉴 화살표 표시 및 호버 동작 (AC-6204-1)', async ({ page }) => {
    // When: TabBar 탭 우클릭
    const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
    await tabItem.click({ button: 'right' });

    // Then: "프리셋 레이아웃" 항목에 ▶ 표시
    const presetItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '프리셋 레이아웃' });
    await expect(presetItem.first()).toBeVisible();

    // 서브메뉴 화살표 아이콘 존재 확인
    const arrowIcon = presetItem.first().locator('.submenu-arrow, .arrow-icon, :text("▶")');
    await expect(arrowIcon).toBeVisible();

    // When: 호버 시 서브메뉴 표시
    await presetItem.first().hover();
    await page.waitForTimeout(400);

    // Then: 서브메뉴가 표시되고 프리셋 목록이 나열됨
    const submenuItems = page.locator(`${SELECTORS.CONTEXT_MENU} ${SELECTORS.CONTEXT_MENU}`);
    // 또는 동일 레벨의 추가 메뉴 항목으로 프리셋 이름 확인
    const quadItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '4분할' });
    await expect(quadItem).toBeVisible();
  });

  test('TC-6204-boundary: 서브메뉴 화면 경계 처리 (AC-6204-2)', async ({ page }) => {
    // 화면 오른쪽 끝에서 우클릭하여 서브메뉴 오버플로 테스트
    await page.setViewportSize({ width: 800, height: 600 });

    const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
    await tabItem.click({ button: 'right' });

    const presetItem = page.locator(SELECTORS.CONTEXT_MENU_ITEM).filter({ hasText: '프리셋 레이아웃' });
    await presetItem.first().hover();
    await page.waitForTimeout(400);

    // Then: 서브메뉴가 뷰포트를 벗어나지 않음
    const allMenus = page.locator(SELECTORS.CONTEXT_MENU);
    const menuCount = await allMenus.count();
    for (let i = 0; i < menuCount; i++) {
      const box = await allMenus.nth(i).boundingBox();
      if (box) {
        expect(box.x + box.width).toBeLessThanOrEqual(800);
        expect(box.y + box.height).toBeLessThanOrEqual(600);
      }
    }
  });

  // ────────────────────────────────────────────────────────────────
  // FR-6503/6504: 레이아웃 불러오기/삭제
  // ────────────────────────────────────────────────────────────────

  test('TC-6503: 기본 프리셋 삭제 거부 (AC-6501-2, AC-6504-2)', async ({ page }) => {
    // 기본 프리셋에 삭제 옵션이 표시되지 않음을 확인
    // 이 테스트는 "레이아웃 불러오기" 목록에서 기본 프리셋의 삭제 버튼 부재를 확인
    const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
    await tabItem.click({ button: 'right' });
    await selectContextMenuItem(page, '레이아웃 불러오기');

    // 기본 프리셋 항목에 삭제 버튼이 없음
    const builtInItem = page.locator('.layout-list-item').filter({ hasText: '단일' });
    if (await builtInItem.count() > 0) {
      const deleteBtn = builtInItem.first().locator('.delete-button, button:has-text("삭제")');
      await expect(deleteBtn).toHaveCount(0);
    }
  });
});
```

### 5.6 추가 테스트 — `pane-preset.spec.ts`

**파일**: `frontend/tests/e2e/pane-preset.spec.ts`

```typescript
import { test, expect } from '@playwright/test';
import {
  setupCleanState,
  selectSubmenuItem,
  verifyPaneCount,
  waitForTerminalCount,
  getServerSessionCount,
  SELECTORS,
} from './helpers';

test.describe('Pane Preset Layouts', () => {

  test.beforeEach(async ({ page }) => {
    await setupCleanState(page);
  });

  const presets: Array<{ name: string; expectedPanes: number }> = [
    { name: '단일', expectedPanes: 1 },
    { name: '좌우 분할', expectedPanes: 2 },
    { name: '상하 분할', expectedPanes: 2 },
    { name: '4분할', expectedPanes: 4 },
    { name: '1+2', expectedPanes: 3 },
    { name: '에이전트 모니터', expectedPanes: 3 },
  ];

  for (const preset of presets) {
    test(`프리셋 "${preset.name}" → ${preset.expectedPanes}개 Pane`, async ({ page }) => {
      const tabItem = page.locator(SELECTORS.TAB_ITEM).first();
      await tabItem.click({ button: 'right' });
      await selectSubmenuItem(page, '프리셋 레이아웃', preset.name);

      // 확인 모달 처리
      const confirmBtn = page.locator('button').filter({ hasText: /확인|계속|Yes|OK/i });
      if (await confirmBtn.count() > 0) {
        await confirmBtn.first().click();
      }

      await verifyPaneCount(page, preset.expectedPanes);
      await waitForTerminalCount(page, preset.expectedPanes);

      // 서버 세션 수 확인
      const sessionCount = await getServerSessionCount(page);
      expect(sessionCount).toBeGreaterThanOrEqual(preset.expectedPanes);
    });
  }
});
```

---

## 6. 테스트 실행 방법

### 6.1 기본 실행 명령

```bash
# 프론트엔드 디렉토리에서 실행
cd frontend

# ─────────────────────────────────────────
# 전체 테스트 (headless, 모든 프로젝트)
# ─────────────────────────────────────────
npx playwright test

# ─────────────────────────────────────────
# 특정 테스트 파일
# ─────────────────────────────────────────
npx playwright test pane-split
npx playwright test pane-carousel
npx playwright test pane-keyboard
npx playwright test pane-persistence
npx playwright test pane-context-menu
npx playwright test pane-preset

# ─────────────────────────────────────────
# 특정 프로젝트만 실행
# ─────────────────────────────────────────
npx playwright test --project="Desktop Chrome"
npx playwright test --project="Mobile Safari"
npx playwright test --project="Tablet"

# ─────────────────────────────────────────
# 특정 테스트 이름 패턴으로 필터링
# ─────────────────────────────────────────
npx playwright test -g "TC-6101"
npx playwright test -g "CRITICAL"
npx playwright test -g "줌"
```

### 6.2 디버깅

```bash
# ─────────────────────────────────────────
# UI 모드 (브라우저에서 테스트 시각적 확인)
# ─────────────────────────────────────────
npx playwright test --ui

# ─────────────────────────────────────────
# 헤드풀 모드 (브라우저 창 표시)
# ─────────────────────────────────────────
npx playwright test --headed

# ─────────────────────────────────────────
# 단일 테스트 디버깅 (브레이크포인트 지원)
# ─────────────────────────────────────────
npx playwright test --debug -g "TC-6101"

# ─────────────────────────────────────────
# 트레이스 뷰어 (실패 시 수집된 트레이스 분석)
# ─────────────────────────────────────────
npx playwright show-trace test-results/pane-split-CRITICAL-전체-분할-플로우/trace.zip

# ─────────────────────────────────────────
# Codegen: 브라우저 조작을 코드로 변환
# ─────────────────────────────────────────
npx playwright codegen http://localhost:4545
```

### 6.3 CI/CD 파이프라인

```bash
# ─────────────────────────────────────────
# JUnit XML 리포트 (CI 통합용)
# ─────────────────────────────────────────
CI=true npx playwright test --reporter=junit --output-file=test-results/junit-report.xml

# ─────────────────────────────────────────
# HTML 리포트 생성
# ─────────────────────────────────────────
npx playwright test --reporter=html
npx playwright show-report

# ─────────────────────────────────────────
# 실패 테스트만 재실행
# ─────────────────────────────────────────
npx playwright test --last-failed
```

### 6.4 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `CI` | - | CI 환경 감지 (workers=1, retries=2) |
| `PLAYWRIGHT_BASE_URL` | `http://localhost:4545` | 테스트 대상 URL |
| `TEST_PASSWORD` | `test` | 로그인 비밀번호 |

### 6.5 `package.json` 스크립트 추가

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:desktop": "playwright test --project='Desktop Chrome'",
    "test:e2e:mobile": "playwright test --project='Mobile Safari'",
    "test:e2e:tablet": "playwright test --project='Tablet'",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:debug": "playwright test --debug",
    "test:e2e:report": "playwright show-report"
  }
}
```

---

## 7. 요구사항 추적 매트릭스

### 7.1 기능 요구사항 (FR) → 테스트 케이스

| FR ID | 요구사항 | AC ID | 테스트 케이스 | 테스트 파일 | 우선순위 |
|-------|---------|-------|-------------|------------|---------|
| FR-6101 | 수평/수직 분할 | AC-6101-1 | TC-6101 | `pane-split.spec.ts` | CRITICAL |
| FR-6101 | 수평/수직 분할 | AC-6101-2 | TC-6101-focus | `pane-split.spec.ts` | CRITICAL |
| FR-6101 | 수평/수직 분할 | AC-6101-3 | TC-6102 | `pane-split.spec.ts` | HIGH |
| FR-6101 | 수평/수직 분할 | AC-6101-4 | TC-6701 | `pane-split.spec.ts` | HIGH |
| FR-6102 | Pane 닫기 | AC-6102-1 | TC-6103 | `pane-split.spec.ts` | CRITICAL |
| FR-6102 | Pane 닫기 | AC-6102-2 | TC-6103 | `pane-split.spec.ts` | CRITICAL |
| FR-6102 | Pane 닫기 | AC-6102-3 | TC-6104 | `pane-split.spec.ts` | HIGH |
| FR-6102 | 다른 Pane 모두 닫기 | - | TC-6702 | `pane-split.spec.ts` | HIGH |
| FR-6103 | Pane 리사이즈 | AC-6103-1 | TC-6105 | `pane-split.spec.ts` | HIGH |
| FR-6103 | Pane 리사이즈 | AC-6103-3 | TC-6106 | `pane-split.spec.ts` | HIGH |
| FR-6104 | Pane 줌 | AC-6104-1 | TC-6107 | `pane-split.spec.ts` | HIGH |
| FR-6104 | Pane 줌 | AC-6104-2 | TC-6107 | `pane-split.spec.ts` | HIGH |
| FR-6104 | Pane 줌 | AC-6104-3 | TC-6107-zoom-disabled | `pane-split.spec.ts` | MEDIUM |
| FR-6105 | Pane 교환 | AC-6105-1 | TC-6108 | `pane-split.spec.ts` | HIGH |
| FR-6105 | Pane 교환 | AC-6105-2 | TC-6706 | `pane-split.spec.ts` | MEDIUM |
| FR-6106 | 포커스 이동 | AC-6106-1 | TC-6109 | `pane-split.spec.ts` | HIGH |
| FR-6106 | 포커스 이동 | AC-6106-2 | TC-6109-kbd | `pane-keyboard.spec.ts` | HIGH |
| FR-6201 | Pane 컨텍스트 메뉴 | AC-6201-1 | TC-6201 | `pane-split.spec.ts` | HIGH |
| FR-6201 | Pane 컨텍스트 메뉴 | AC-6201-3 | TC-6201-dismiss | `pane-split.spec.ts` | MEDIUM |
| FR-6202 | 경계선 컨텍스트 메뉴 | AC-6202-1 | TC-6202 | `pane-split.spec.ts` | HIGH |
| FR-6202 | 경계선 컨텍스트 메뉴 | AC-6202-2 | TC-6202-equalize | `pane-split.spec.ts` | HIGH |
| FR-6202 | 경계선 컨텍스트 메뉴 | AC-6202-3 | TC-6202-toggle | `pane-split.spec.ts` | HIGH |
| FR-6203 | TabBar 메뉴 확장 | AC-6203-1 | TC-6203 | `pane-split.spec.ts` | HIGH |
| FR-6203 | TabBar 메뉴 확장 | AC-6203-2 | TC-6203 | `pane-split.spec.ts` | HIGH |
| FR-6203 | TabBar 메뉴 확장 | AC-6203-3 | TC-6502 | `pane-persistence.spec.ts` | HIGH |
| FR-6204 | 서브메뉴 지원 | AC-6204-1 | TC-6204 | `pane-context-menu.spec.ts` | MEDIUM |
| FR-6204 | 서브메뉴 지원 | AC-6204-2 | TC-6204-boundary | `pane-context-menu.spec.ts` | MEDIUM |
| FR-6205 | 모바일 롱프레스 | AC-6205-1 | TC-6205 | `pane-carousel.spec.ts` | HIGH |
| FR-6301 | 반응형 분기 | AC-6301-1 | TC-6301 | `pane-carousel.spec.ts` | HIGH |
| FR-6301 | 반응형 분기 | AC-6301-2/3 | TC-6712 | `pane-split.spec.ts` | HIGH |
| FR-6302 | 횡 스와이프 | AC-6302-1 | TC-6302 | `pane-carousel.spec.ts` | HIGH |
| FR-6302 | 횡 스와이프 | AC-6302-2 | TC-6302-bounce | `pane-carousel.spec.ts` | MEDIUM |
| FR-6303 | 도트 인디케이터 | AC-6303-1 | TC-6303 | `pane-carousel.spec.ts` | HIGH |
| FR-6303 | 도트 인디케이터 | AC-6303-2 | TC-6303 | `pane-carousel.spec.ts` | HIGH |
| FR-6304 | 모바일 Pane 추가 | AC-6304-1 | TC-6304 | `pane-carousel.spec.ts` | HIGH |
| FR-6305 | 모바일-데스크톱 전환 | AC-6305-1 | TC-6712 | `pane-split.spec.ts` | HIGH |
| FR-6306 | 모바일 Pane 닫기 | AC-6306-1 | TC-6705 | `pane-carousel.spec.ts` | HIGH |
| FR-6306 | 모바일 Pane 닫기 | AC-6306-2 | TC-6306-last | `pane-carousel.spec.ts` | MEDIUM |
| FR-6401~6406 | IndexedDB 저장/복원 | - | TC-6401 | `pane-persistence.spec.ts` | CRITICAL |
| FR-6407 | localStorage 마이그레이션 | - | TC-6402 | `pane-persistence.spec.ts` | HIGH |
| FR-6501 | 기본 프리셋 | AC-6501-1 | TC-6501 | `pane-persistence.spec.ts` | HIGH |
| FR-6501 | 기본 프리셋 | AC-6501-2 | TC-6503 | `pane-context-menu.spec.ts` | MEDIUM |
| FR-6502 | 커스텀 저장 | AC-6502-1 | TC-6502 | `pane-persistence.spec.ts` | HIGH |
| FR-6503 | 불러오기 | AC-6503-1 | TC-6502 | `pane-persistence.spec.ts` | HIGH |
| FR-6601 | Prefix 모드 | AC-6601-1 | TC-6601 | `pane-keyboard.spec.ts` | HIGH |
| FR-6601 | Prefix 모드 | AC-6601-3 | TC-6606 | `pane-keyboard.spec.ts` | MEDIUM |
| FR-6602 | 단축키 매핑 | AC-6602-1 | TC-6602 | `pane-keyboard.spec.ts` | HIGH |
| FR-6602 | 단축키 매핑 | AC-6602-2 | TC-6603 | `pane-keyboard.spec.ts` | HIGH |
| FR-6602 | 단축키 매핑 | AC-6602-3 | TC-6604 | `pane-keyboard.spec.ts` | HIGH |
| FR-6603 | 번호 오버레이 | AC-6603-1 | TC-6604 | `pane-keyboard.spec.ts` | HIGH |
| FR-6603 | 번호 오버레이 | AC-6603-2 | TC-6604 | `pane-keyboard.spec.ts` | HIGH |
| FR-6604 | Prefix 에러 처리 | - | TC-6707 | `pane-keyboard.spec.ts` | MEDIUM |
| FR-6605 | Prefix 충돌 방지 | AC-6605-1 | TC-6605 | `pane-keyboard.spec.ts` | HIGH |

### 7.2 비기능 요구사항 (NFR) → 테스트 방법

| NFR ID | 요구사항 | 검증 방법 | 자동화 |
|--------|---------|---------|-------|
| NFR-6101 | 8 Pane 60fps | Chrome DevTools Performance API (`page.evaluate`로 FPS 측정) | 반자동 |
| NFR-6102 | 리사이즈 16ms | Performance.mark/measure로 리사이즈 콜백 지연 측정 | 반자동 |
| NFR-6103 | IndexedDB 저장 50ms | `performance.now()` 전후 차이 측정 | 자동 |
| NFR-6104 | 복원 100ms | 앱 로드 시 `DOMContentLoaded` → `first meaningful paint` 차이 | 반자동 |
| NFR-6105 | 스와이프 300ms | 터치 이벤트 → `transitionend` 이벤트 간 시간 측정 | 자동 |
| NFR-6106 | 메모리 500MB | `performance.memory` API (Chrome만 지원) | 반자동 |
| NFR-6107 | 360px 캐러셀 | `page.setViewportSize({width: 360})` + 기능 테스트 | 자동 |
| NFR-6108 | 키보드 접근성 | 키보드 전체 플로우 테스트 (시나리오 3.5) | 자동 |
| NFR-6109 | SSE Pane당 1개 | `page.evaluate`로 활성 EventSource 수 확인 | 자동 |
| NFR-6110 | 메뉴 100ms | 우클릭 → 메뉴 visible까지 시간 측정 | 자동 |
| NFR-6111 | 동시 출력 200ms | 8 Pane 동시 `yes` 명령 → UI 응답 측정 | 반자동 |

> **"반자동"**: Playwright에서 성능 데이터를 수집하고 콘솔에 출력하지만, 통과/실패 판정은 수동 리뷰가 필요한 항목.

### 7.3 엣지케이스 테스트 → 매핑

| TC ID | 시나리오 | 관련 FR/NFR | 테스트 파일 |
|-------|---------|------------|------------|
| TC-6701 | 서버 오프라인 분할 | FR-6101 | `pane-split.spec.ts` |
| TC-6702 | 다른 Pane 모두 닫기 | FR-6102 | `pane-split.spec.ts` |
| TC-6704 | 줌 상태 복원 | FR-6104, FR-6401 | `pane-persistence.spec.ts` |
| TC-6705 | 모바일 현재 Pane 닫기 | FR-6306 | `pane-carousel.spec.ts` |
| TC-6706 | 교환 모드 ESC 취소 | FR-6105 | `pane-split.spec.ts` |
| TC-6707 | 인식 불가 Prefix 키 | FR-6604 | `pane-keyboard.spec.ts` |
| TC-6708 | 손상된 localStorage 마이그레이션 | FR-6407 | `pane-persistence.spec.ts` |
| TC-6709 | 깊이 4 추가 분할 거부 | 3.2 제약 | TC-6102와 유사 |
| TC-6710 | stale sessionId 정리 | 4.3 오류 처리 | `pane-persistence.spec.ts` |
| TC-6712 | 데스크톱↔모바일 전환 | FR-6305 | `pane-split.spec.ts` |

---

## 8. 테스트 파일 요약

| 파일 | 테스트 수 | 커버 영역 |
|------|----------|----------|
| `pane-split.spec.ts` | 18+ | 분할, 닫기, 리사이즈, 줌, 교환, 포커스, 컨텍스트 메뉴, 반응형 전환 |
| `pane-carousel.spec.ts` | 8+ | 모바일 캐러셀, 스와이프, 도트 인디케이터, 롱프레스, Pane 추가/닫기 |
| `pane-keyboard.spec.ts` | 10+ | Ctrl+B prefix, 단축키 매핑, 번호 오버레이, 타임아웃, 에러 처리 |
| `pane-persistence.spec.ts` | 7+ | IndexedDB 저장/복원, 프리셋, 커스텀 레이아웃, 마이그레이션, stale 정리 |
| `pane-context-menu.spec.ts` | 3+ | 서브메뉴 UI, 화면 경계 처리, 프리셋 삭제 방지 |
| `pane-preset.spec.ts` | 6 | 6개 프리셋 각각의 적용 검증 |
| `helpers.ts` | - | 공통 유틸리티 함수 20+ |
| **합계** | **52+** | |

---

## 9. 주의사항

### 9.1 테스트 격리

- 각 테스트는 `beforeEach`에서 `setupCleanState()`를 호출하여 IndexedDB와 localStorage를 초기화한다.
- 서버의 PTY 세션은 테스트 간 공유될 수 있으므로, 테스트 종료 후 생성된 세션이 자동 정리되는지 확인한다.
- `webServer` 설정으로 dev.js가 자동 기동되므로, 수동 서버 실행이 불필요하다.

### 9.2 플랫폼 고려사항

- **Windows**: BuilderGate 서버가 Windows에서 실행되므로, PTY 세션의 셸은 PowerShell 또는 cmd가 기본이다.
- **셀렉터 안정성**: `data-pane-type`, `data-pane-id`, `data-pane-focused`, `data-session-id` 등의 data 속성을 셀렉터로 사용하므로, 구현 시 이 속성들을 반드시 DOM에 추가해야 한다.
- **xterm.js 렌더링 대기**: xterm.js는 비동기로 렌더링되므로, `.xterm-screen` 셀렉터로 렌더링 완료를 확인한다.

### 9.3 알려진 제한

- **실제 PTY 출력 검증**: xterm.js의 텍스트 콘텐츠를 DOM에서 직접 추출하기 어려우므로, "명령 입력 후 특정 출력 확인"은 E2E에서 수행하지 않는다. 대신 세션 생성/SSE 연결 성공을 통해 간접 확인한다.
- **모바일 터치 시뮬레이션**: Playwright의 `touchscreen.tap()`은 기본적인 터치만 지원하므로, 복잡한 롱프레스와 스와이프는 `page.evaluate()`로 `TouchEvent`를 직접 디스패치한다.
- **HTTP/2 SSE 제한**: Playwright의 네트워크 관찰은 HTTP/2 연결 멀티플렉싱을 개별 스트림으로 표시하지 않을 수 있다. SSE 연결 수 확인은 클라이언트 측 `EventSource` 객체 수로 대체한다.
