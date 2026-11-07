// FR-MSG-001/002/010/015 (contract §9): the messenger REST surface the window uses. Served over
// withLocalHttpServer's pipe/socket, so no TCP port is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { createMessengerRoutes } from './messengerRoutes.js';
import { FakeNetwork } from '../services/messenger/testHarness.js';

type Req = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;

async function withRoutes(run: (req: Req, net: FakeNetwork) => Promise<void>) {
  const net = new FakeNetwork();
  const alice = await net.add('alice', [{ sessionKey: 'a1', name: 'worker' }]);
  await net.add('bob', [{ sessionKey: 'b1', name: 'api' }]);
  net.befriend('alice', 'bob');
  const app = express();
  app.use(express.json());
  app.use('/api/messenger', createMessengerRoutes({
    rooms: alice.svc,
    net: {
      contactsView: () => [{ name: 'bob', state: 'connected' }],
      requestsView: () => [],
    },
    lan: () => ({ receiving: false }),
  }));
  await withLocalHttpServer(app, async (fixture) => {
    await run(async (method, p, data) => {
      const response = await fixture.request({
        method,
        path: p,
        headers: data === undefined ? {} : { 'content-type': 'application/json' },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return { status: response.statusCode, json: JSON.parse(response.body || 'null') };
    }, net);
  });
}

test('FR-MSG-001 AC-1, contract §9: create a room, read it, post, read state', async () => {
  await withRoutes(async (req, net) => {
    const created = await req('POST', '/api/messenger/rooms', { name: '결제팀', sessions: ['a1'], people: ['bob'] });
    assert.equal(created.status, 200);
    const id = created.json.room.id as string;
    await net.idle();
    const posted = await req('POST', `/api/messenger/rooms/${id}/messages`, { text: '안녕 @worker' });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.status, 'sequenced');
    const room = await req('GET', `/api/messenger/rooms/${id}?limit=50`);
    assert.equal(room.status, 200);
    assert.deepEqual(room.json.messages.map((m: any) => m.text), ['', '안녕 @worker']);
    assert.equal(room.json.host.online, true);
    const state = await req('GET', '/api/messenger/state');
    assert.equal(state.json.me.name, 'alice');
    assert.deepEqual(state.json.lan, { receiving: false });
    assert.deepEqual(state.json.contacts, [{ name: 'bob', state: 'connected' }]);
    assert.deepEqual(state.json.requests, []);
    assert.equal(state.json.rooms[0].name, '결제팀');
    assert.deepEqual(state.json.sessionRooms, { a1: ['결제팀'] });
    assert.equal((await req('POST', `/api/messenger/rooms/${id}/read`, { seq: 2 })).json.ok, true);
    const search = await req('GET', `/api/messenger/search?q=${encodeURIComponent('안녕')}`);
    assert.equal(search.json.messages.length, 1);
  });
});

test('contract §9: errors carry their code and an HTTP status', async () => {
  await withRoutes(async (req) => {
    const missing = await req('GET', '/api/messenger/rooms/rm_nothere');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, 'ROOM_NOT_FOUND');
    const created = await req('POST', '/api/messenger/rooms', { name: 'r', sessions: [], people: [] });
    const bad = await req('POST', `/api/messenger/rooms/${created.json.room.id}/messages`, { text: '@ghost hi' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { ok: false, code: 'TARGET_NOT_FOUND', name: 'ghost' });
    assert.equal((await req('POST', '/api/messenger/rooms', { name: '' })).status, 400);
  });
});

test('FR-MSG-015: the webhook URL is stored but never returned', async () => {
  await withRoutes(async (req) => {
    const saved = await req('PATCH', '/api/messenger/settings', { webhookUrl: 'https://chat.example/hook?key=SECRET' });
    assert.deepEqual(saved.json, { ok: true, hasWebhook: true });
    const state = await req('GET', '/api/messenger/state');
    assert.equal(state.json.hasWebhook, true);
    assert.ok(!JSON.stringify(state.json).includes('SECRET'));
  });
});

test('FR-MSG-010 AC-2, FR-MSG-005 AC-3, FR-MSG-012: invite, session settings, resume, transfer, continue, leave', async () => {
  await withRoutes(async (req, net) => {
    const created = await req('POST', '/api/messenger/rooms', { name: '팀', sessions: [], people: [] });
    const id = created.json.room.id as string;
    assert.equal((await req('POST', `/api/messenger/rooms/${id}/invite`, { sessions: ['a1'], people: ['bob'] })).json.ok, true);
    await net.idle();
    const bob = net.servers.get('bob')!;
    assert.equal(bob.svc.state().invites.length, 1);
    assert.equal((await req('PATCH', `/api/messenger/rooms/${id}/sessions/a1`, { enter: false })).json.ok, true);
    const room = await req('GET', `/api/messenger/rooms/${id}`);
    assert.equal(room.json.room.sessions[0].enter, false);
    assert.equal((await req('POST', `/api/messenger/rooms/${id}/resume`)).json.ok, true);
    assert.equal((await req('PATCH', `/api/messenger/rooms/${id}/settings`, { holdLimit: 5 })).json.room.settings.holdLimit, 5);
    assert.match((await req('POST', `/api/messenger/rooms/${id}/invite-code`, {})).json.code, /^bgi1\./);
    assert.equal((await req('POST', `/api/messenger/rooms/${id}/transfer`, { node: 'bob' })).json.code, 'TARGET_NOT_FOUND');
    assert.equal((await req('POST', `/api/messenger/rooms/${id}/continue`)).json.ok, true);
    assert.equal((await req('DELETE', `/api/messenger/rooms/${id}/members/${encodeURIComponent('alice::a1')}`)).json.ok, true);
    assert.equal((await req('POST', `/api/messenger/rooms/${id}/leave`)).json.ok, true);
    assert.equal((await req('POST', '/api/messenger/invites/inv_none/accept', { sessions: [], personOnly: true })).status, 404);
    assert.equal((await req('POST', '/api/messenger/approvals/apr_none', { approve: true })).status, 404);
  });
});
