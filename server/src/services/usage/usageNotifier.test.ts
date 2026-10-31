import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatUsageAlert, sendGoogleChat, sendTelegram } from './usageNotifier.js';

const WEBHOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=SECRETKEY123&token=SECRETTOKEN456';
const BOT = '123456:SECRET-BOT-TOKEN-XYZ';

function fakeFetch(status: number, body = '{}', fail?: Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (fail) throw fail;
    return new Response(body, { status });
  };
  return { calls, fetchFn: fetchFn as unknown as typeof fetch };
}

test('FR-USAGE-006 AC-3: the message names the agent, account, window, remaining, threshold, reset and machine', () => {
  const text = formatUsageAlert({
    agent: 'claude', accountLabel: '회사 팀', window: 'fiveHour', remainingPercent: 12, thresholdPercent: 20,
    resetsAt: Date.parse('2026-10-31T11:10:00.000Z'), now: Date.parse('2026-10-31T09:00:00.000Z'), machine: 'DESKTOP-1',
  });
  assert.equal(text, '[BuilderGate] Claude(회사 팀) 5시간 한도 남은 양 12% (기준 20%) · 2시간 10분 후 초기화 · DESKTOP-1');
});

test('FR-USAGE-006 AC-3: Google Chat gets a POST of {text} to the webhook', async () => {
  const f = fakeFetch(200);
  const result = await sendGoogleChat({ webhookUrl: WEBHOOK }, 'hello', f.fetchFn);
  assert.deepEqual(result, { ok: true, status: 200 });
  assert.equal(f.calls[0].url, WEBHOOK);
  assert.equal(f.calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { text: 'hello' });
});

test('FR-USAGE-006 AC-3: Telegram gets sendMessage with the chat id', async () => {
  const f = fakeFetch(200, '{"ok":true}');
  const result = await sendTelegram({ botToken: BOT, chatId: '-100123' }, 'hello', f.fetchFn);
  assert.equal(result.ok, true);
  assert.equal(f.calls[0].url, `https://api.telegram.org/bot${BOT}/sendMessage`);
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { chat_id: '-100123', text: 'hello' });
});

test('FR-USAGE-006 AC-4/AC-5: failures report status and reason without the webhook or token', async () => {
  const bad = await sendTelegram({ botToken: BOT, chatId: '1' }, 'x', fakeFetch(401, '{"ok":false,"description":"Unauthorized"}').fetchFn);
  assert.deepEqual({ ok: bad.ok, status: bad.status }, { ok: false, status: 401 });
  assert.match(bad.error ?? '', /Unauthorized/u);
  const down = await sendGoogleChat({ webhookUrl: WEBHOOK }, 'x', fakeFetch(0, '', new Error(`connect failed ${WEBHOOK}`)).fetchFn);
  assert.equal(down.ok, false);
  for (const result of [bad, down]) {
    const text = JSON.stringify(result);
    for (const secret of ['SECRETKEY123', 'SECRETTOKEN456', 'SECRET-BOT-TOKEN-XYZ']) assert.equal(text.includes(secret), false, secret);
  }
});

test('FR-USAGE-006: missing values are refused before any request', async () => {
  const f = fakeFetch(200);
  assert.equal((await sendGoogleChat({ webhookUrl: '' }, 'x', f.fetchFn)).ok, false);
  assert.equal((await sendGoogleChat({ webhookUrl: 'http://example.com/hook' }, 'x', f.fetchFn)).ok, false, 'only https webhooks');
  assert.equal((await sendTelegram({ botToken: BOT, chatId: '' }, 'x', f.fetchFn)).ok, false);
  assert.equal(f.calls.length, 0);
});

test('FR-USAGE-006 AC-4: query values of the webhook are hidden even when echoed alone', async () => {
  const echo = fakeFetch(400, '{"error":{"message":"bad key SECRETKEY123 / SECRETTOKEN456"}}');
  const result = await sendGoogleChat({ webhookUrl: WEBHOOK }, 'x', echo.fetchFn);
  const text = JSON.stringify(result);
  assert.equal(text.includes('SECRETKEY123'), false);
  assert.equal(text.includes('SECRETTOKEN456'), false);
});

test('FR-USAGE-006: only Google Chat webhook hosts are accepted', async () => {
  const f = fakeFetch(200);
  assert.equal((await sendGoogleChat({ webhookUrl: 'https://intranet.example/hook' }, 'x', f.fetchFn)).ok, false);
  assert.equal(f.calls.length, 0);
});
