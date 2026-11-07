import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { messengerErrorKey, messengerErrorParams } from '../../src/components/Messenger/messengerErrors.ts';

// FR-MSG-013 AC-5: every refusal the messenger server answers with ({ok:false, code}) is worded in
// both catalogs. The list is the servers' own (w-server-net, w-server-core, contract §5/§8).
const SERVER_CODES = [
  // w-server-net
  'INVALID_INPUT', 'INTERNAL_ERROR', 'NAME_EMPTY', 'NAME_HAS_SPACE', 'NAME_INVALID_CHAR', 'NAME_TOO_LONG', 'NAME_TAKEN',
  'NAME_HAS_CONTACTS', 'NAME_IS_SELF', 'LAN_OFF', 'CODE_INVALID', 'LINK_SAVE_FAILED', 'INVITE_UNSUPPORTED', 'ALREADY_MEMBER',
  'ADDRESS_INVALID', 'ADDRESS_UNREACHABLE', 'REQUEST_PENDING', 'TOO_MANY_REQUESTS', 'LAN_ADDRESS_DENIED', 'INVALID_REQUEST',
  'NOT_FOUND', 'REQUEST_REFUSED', 'CONTACT_NOT_FOUND', 'REQUEST_NOT_FOUND', 'LAN_TLS_UNAVAILABLE', 'LAN_PORT_IN_USE', 'LAN_PORT_INVALID',
  // w-server-core
  'AMBIGUOUS_TARGET', 'APPROVAL_NOT_FOUND', 'APPROVAL_PENDING', 'HOST_ERROR', 'HOST_OFFLINE', 'INVITE_NOT_FOUND', 'JOIN_FAILED',
  'MESSENGER_KEYS_UNAVAILABLE', 'NOT_CREATOR', 'NOT_HOST', 'NOT_INVITED', 'NOT_IN_ROOM', 'ROOM_LINK_INVALID', 'ROOM_NOT_FOUND',
  'SESSION_NOT_IN_ROOM', 'TARGET_OFFLINE', 'TRANSFER_FAILED',
  // contract §5 and the contact error field
  'TARGET_NOT_FOUND', 'TLS_FINGERPRINT_CHANGED', 'MESSENGER_UNAVAILABLE',
];

const catalog = (lang: string) => JSON.parse(readFileSync(new URL(`../../public/locales/messages.${lang}.json`, import.meta.url), 'utf8')) as Record<string, string>;

test('FR-MSG-013 AC-5: every messenger refusal code has a message in en and ko', () => {
  const en = catalog('en');
  const ko = catalog('ko');
  const missing = SERVER_CODES.filter((code) => {
    const key = messengerErrorKey(code);
    return key === null || en[key] === undefined || ko[key] === undefined;
  });
  assert.deepEqual(missing, []);
});

test('FR-MSG-013: an unknown code has no message of its own', () => {
  assert.equal(messengerErrorKey('SOMETHING_NEW'), null);
  assert.equal(messengerErrorKey(undefined), null);
});

test('FR-MSG-003 AC-3: the refusal body fills the message (candidates listed, numbers as text)', () => {
  assert.deepEqual(messengerErrorParams({ code: 'AMBIGUOUS_TARGET', candidates: ['a::x', 'b::x'], name: '@x', port: 3334, ok: false, nested: { a: 1 } }), {
    candidates: 'a::x, b::x',
    name: '@x',
    port: '3334',
    code: 'AMBIGUOUS_TARGET',
  });
});
