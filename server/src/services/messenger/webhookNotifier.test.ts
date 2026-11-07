// FR-MSG-015: the Google Chat style webhook — POST {text}; failures logged without the URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookNotifier } from './webhookNotifier.js';

const URL_WITH_KEY = 'https://chat.example/v1/spaces/x/messages?key=SECRET&token=SECRET2';

test('FR-MSG-015 AC-1/AC-2: posts {text} as JSON to the configured URL', async () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const notify = createWebhookNotifier({
    fetch: async (url, init) => { sent.push({ url: String(url), init: init ?? {} }); return new Response('{}', { status: 200 }); },
    log: () => assert.fail('no log on success'),
  });
  await notify(URL_WITH_KEY, '[BuilderGate 메신저] 결제팀: bob — hi');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, URL_WITH_KEY);
  assert.equal(sent[0]!.init.method, 'POST');
  assert.equal(JSON.parse(String(sent[0]!.init.body)).text, '[BuilderGate 메신저] 결제팀: bob — hi');
});

test('FR-MSG-015: a failure is logged without the URL, and never throws', async () => {
  const logs: string[] = [];
  for (const fetch of [
    async () => new Response('no', { status: 403 }),
    async () => { throw new Error(`connect failed ${URL_WITH_KEY}`); },
  ]) {
    const notify = createWebhookNotifier({ fetch, log: (event) => logs.push(JSON.stringify(event)) });
    await notify(URL_WITH_KEY, 'x');
  }
  assert.equal(logs.length, 2);
  for (const line of logs) {
    assert.ok(!line.includes('SECRET'), line);
    assert.ok(!line.includes('chat.example'), line);
  }
  assert.ok(logs[0]!.includes('403'));
});
