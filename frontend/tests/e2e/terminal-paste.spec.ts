import { test, expect } from '@playwright/test';
import { login, waitForTerminal } from './helpers';

/**
 * TC-PASTE-01: Ctrl+V 이중 붙여넣기 방지 테스트
 *
 * 재현 조건:
 *   Chrome/Windows 환경에서 xterm v6의 paste 핸들러가 clipboardData를 읽어
 *   triggerDataEvent를 호출한 뒤 preventDefault()를 호출하지 않아, 브라우저가
 *   textarea에 텍스트를 추가 삽입하고 insertText 타입 input 이벤트를 발생시킴.
 *   이 input 이벤트가 _inputEvent 핸들러로 두 번째 triggerDataEvent를 유발해
 *   이중 붙여넣기가 발생하는 버그.
 *
 * 수정 내용:
 *   termEl에 capture 단계 paste 리스너를 추가해 preventDefault()를 호출,
 *   브라우저의 textarea 삽입 동작만 차단. xterm 내부 clipboardData 읽기는 유지.
 */
test.describe('Terminal Paste', () => {
  test('TC-PASTE-01: Ctrl+V로 붙여넣기 시 단 한 번만 전송되어야 한다', async ({ page }) => {
    // WebSocket 리스너는 연결 생성 전에 등록해야 함
    const inputMessages: string[] = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          const payload = typeof frame.payload === 'string'
            ? frame.payload
            : Buffer.from(frame.payload as Buffer).toString('utf8');
          const data = JSON.parse(payload);
          if (data.type === 'input' && typeof data.data === 'string') {
            inputMessages.push(data.data);
          }
        } catch {
          // JSON이 아닌 프레임은 무시
        }
      });
    });

    await login(page);
    await waitForTerminal(page);

    // 터미널 클릭으로 포커스
    await page.click('.xterm-screen');
    await page.waitForTimeout(300);

    // 이전 입력(Enter 등 focus 이벤트) 초기화
    inputMessages.length = 0;

    // 클립보드에 고유 텍스트 설정
    const clipText = 'PASTE_ONCE_TEST_XYZ';
    await page.evaluate((text) => navigator.clipboard.writeText(text), clipText);

    // Ctrl+V 입력
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(500);

    // 해당 텍스트가 포함된 input 메시지 횟수 확인
    const pasteCount = inputMessages.filter(m => m.includes(clipText)).length;
    expect(pasteCount).toBe(1);
  });

  test('TC-PASTE-02: 연속 Ctrl+V 는 각각 한 번씩만 전송되어야 한다', async ({ page }) => {
    const inputMessages: string[] = [];
    page.on('websocket', ws => {
      ws.on('framesent', frame => {
        try {
          const payload = typeof frame.payload === 'string'
            ? frame.payload
            : Buffer.from(frame.payload as Buffer).toString('utf8');
          const data = JSON.parse(payload);
          if (data.type === 'input' && typeof data.data === 'string') {
            inputMessages.push(data.data);
          }
        } catch {
          // ignore
        }
      });
    });

    await login(page);
    await waitForTerminal(page);

    await page.click('.xterm-screen');
    await page.waitForTimeout(300);
    inputMessages.length = 0;

    const clipText = 'REPEAT_PASTE_ABC';
    await page.evaluate((text) => navigator.clipboard.writeText(text), clipText);

    // Ctrl+V 세 번 연속 입력
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(500);

    // 각 키입력마다 정확히 1번씩 → 총 3번
    const pasteCount = inputMessages.filter(m => m.includes(clipText)).length;
    expect(pasteCount).toBe(3);
  });
});
