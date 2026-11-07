// FR-MSG-008, FR-MSG-014 (contract §9): the contacts and LAN REST surface over a fake MessengerNet.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withLocalHttpServer } from '../testing/localHttpTestServer.js';
import { createMessengerNetRoutes } from './messengerNetRoutes.js';
import type { MessengerNet } from '../services/messenger/contacts.js';

type Call = [string, unknown];

function fakeNet(calls: Call[]): Partial<MessengerNet> {
  return {
    renameMe: async (name) => { calls.push(['renameMe', name]); return name === 'a b' ? { ok: false, code: 'NAME_HAS_SPACE' } : { ok: true, name }; },
    connectionCode: () => ({ ok: true, code: 'bgc1.x', expiresAt: '2026-11-08T00:00:00.000Z' }),
    redeemCode: async (code) => { calls.push(['redeemCode', code]); return { ok: true, kind: 'contact', contact: { name: 'bob', state: 'disconnected' } }; },
    addContactByAddress: async (input) => { calls.push(['add', input]); return { ok: true, contact: { name: input.name, state: 'requested' } }; },
    removeContact: async (name) => { calls.push(['remove', name]); return name === 'nobody' ? { ok: false, code: 'CONTACT_NOT_FOUND' } : { ok: true }; },
    acceptRequest: async (id) => { calls.push(['accept', id]); return { ok: true }; },
    declineRequest: async (id) => { calls.push(['decline', id]); return { ok: true }; },
    lan: async () => ({ ok: true, receiving: false, port: 3334 }),
    setLan: async (input) => { calls.push(['setLan', input]); return input.port === 3334 ? { ok: false, code: 'LAN_PORT_IN_USE', port: 3334 } : { ok: true, receiving: input.receiving, port: input.port ?? 3334 }; },
  };
}

async function withRoutes(run: (req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>, calls: Call[]) => Promise<void>) {
  const calls: Call[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/messenger', createMessengerNetRoutes(fakeNet(calls) as MessengerNet));
  await withLocalHttpServer(app, async (fixture) => {
    await run(async (method, path, body) => {
      const response = await fixture.request({ method, path, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: response.statusCode, json: response.body ? JSON.parse(response.body) : null };
    }, calls);
  });
}

test('FR-MSG-008 AC-1/AC-2: PATCH /me renames, and a refused name answers 400 with its code', async () => {
  await withRoutes(async (req, calls) => {
    assert.deepEqual((await req('PATCH', '/api/messenger/me', { name: '홍길동' })).json, { ok: true, name: '홍길동' });
    const bad = await req('PATCH', '/api/messenger/me', { name: 'a b' });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.code, 'NAME_HAS_SPACE');
    assert.deepEqual(calls, [['renameMe', '홍길동'], ['renameMe', 'a b']]);
  });
});

test('FR-MSG-008 AC-3/AC-4/AC-6: code, redeem, add by address, delete, and request decisions', async () => {
  await withRoutes(async (req, calls) => {
    assert.equal((await req('GET', '/api/messenger/code')).json.code, 'bgc1.x');
    assert.equal((await req('POST', '/api/messenger/codes/redeem', { code: 'bgc1.y' })).json.kind, 'contact');
    assert.equal((await req('POST', '/api/messenger/contacts', { name: 'bob', address: '10.0.0.2' })).json.contact.state, 'requested');
    assert.equal((await req('DELETE', '/api/messenger/contacts/%EA%B9%80%EC%B2%A0%EC%88%98')).status, 200);
    assert.equal((await req('DELETE', '/api/messenger/contacts/nobody')).status, 404);
    assert.equal((await req('POST', '/api/messenger/requests/r1/accept')).status, 200);
    assert.equal((await req('POST', '/api/messenger/requests/r2/decline')).status, 200);
    assert.deepEqual(calls, [
      ['redeemCode', 'bgc1.y'],
      ['add', { name: 'bob', address: '10.0.0.2' }],
      ['remove', '김철수'],
      ['remove', 'nobody'],
      ['accept', 'r1'],
      ['decline', 'r2'],
    ]);
  });
});

test('FR-MSG-014: GET /lan reads receiving and port, PATCH /lan takes receiving and an optional port', async () => {
  await withRoutes(async (req, calls) => {
    assert.deepEqual((await req('GET', '/api/messenger/lan')).json, { ok: true, receiving: false, port: 3334 });
    assert.deepEqual((await req('PATCH', '/api/messenger/lan', { receiving: true })).json, { ok: true, receiving: true, port: 3334 });
    const busy = await req('PATCH', '/api/messenger/lan', { receiving: true, port: 3334 });
    assert.equal(busy.status, 400);
    assert.deepEqual(busy.json, { ok: false, code: 'LAN_PORT_IN_USE', port: 3334 });
    assert.equal((await req('PATCH', '/api/messenger/lan', { receiving: 'yes' })).status, 400);
    assert.equal((await req('PATCH', '/api/messenger/lan', { receiving: true, port: '80' })).status, 400);
    assert.deepEqual(calls, [['setLan', { receiving: true }], ['setLan', { receiving: true, port: 3334 }]]);
  });
});

test('FR-MSG-014: GET /code with receiving off answers 400 LAN_OFF', async () => {
  const calls: Call[] = [];
  const app = express();
  app.use(express.json());
  app.use('/api/messenger', createMessengerNetRoutes({ ...fakeNet(calls), connectionCode: () => ({ ok: false, code: 'LAN_OFF' }) } as MessengerNet));
  await withLocalHttpServer(app, async (fixture) => {
    const response = await fixture.request({ method: 'GET', path: '/api/messenger/code', headers: {} });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(JSON.parse(response.body), { ok: false, code: 'LAN_OFF' });
  });
});

test('contract §9: missing fields answer 400 INVALID_INPUT without calling the service', async () => {
  await withRoutes(async (req, calls) => {
    assert.equal((await req('PATCH', '/api/messenger/me', {})).json.code, 'INVALID_INPUT');
    assert.equal((await req('POST', '/api/messenger/codes/redeem', {})).json.code, 'INVALID_INPUT');
    assert.equal((await req('POST', '/api/messenger/contacts', { name: 'bob' })).json.code, 'INVALID_INPUT');
    assert.deepEqual(calls, []);
  });
});
