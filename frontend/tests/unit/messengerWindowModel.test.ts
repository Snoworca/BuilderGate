import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoOpenRoomId,
  isImeEnter,
  mergeChangedRoom,
  openRoomGone,
  parseLanPort,
  roomDotLabelInput,
} from '../../src/components/Messenger/messengerWindowModel.ts';

// The window's decisions, as values (reviewer findings 1, 2, 4, 5, 7 and the LAN port field).

const rooms = [
  { id: 'old', lastAt: '2026-11-05T01:00:00Z' },
  { id: 'new', lastAt: '2026-11-05T03:00:00Z' },
];

test('finding 1: a room that left the list is closed; one still listed or not loaded yet is kept', () => {
  assert.equal(openRoomGone(['new'], 'old'), true);
  assert.equal(openRoomGone(['new', 'old'], 'old'), false);
  assert.equal(openRoomGone(null, 'old'), false);
  assert.equal(openRoomGone(['new'], null), false);
});

test('finding 7 / FR-MSG-013 AC-2: no room opens on its own before the width is measured or in one-pane mode', () => {
  assert.equal(autoOpenRoomId(null, false, null, rooms), null);
  assert.equal(autoOpenRoomId(500, false, null, rooms), null);
  assert.equal(autoOpenRoomId(900, true, null, rooms), null);
  assert.equal(autoOpenRoomId(900, false, null, rooms), 'new');
  assert.equal(autoOpenRoomId(900, false, 'old', rooms), null);
  assert.equal(autoOpenRoomId(900, false, null, []), null);
});

test('finding 2: broadcasts in one burst name a room only when they all named the same one', () => {
  assert.equal(mergeChangedRoom(null, 'a'), 'a');
  assert.equal(mergeChangedRoom('a', 'a'), 'a');
  assert.equal(mergeChangedRoom('a', 'b'), undefined);
  assert.equal(mergeChangedRoom('a', undefined), undefined);
  assert.equal(mergeChangedRoom(undefined, 'a'), undefined);
  assert.equal(mergeChangedRoom(null, undefined), undefined);
});

test('finding 4: an Enter that ends a Hangul composition is not a send (Chrome isComposing, Safari keyCode 229)', () => {
  assert.equal(isImeEnter({ isComposing: true, keyCode: 13 }), true);
  assert.equal(isImeEnter({ isComposing: false, keyCode: 229 }), true);
  assert.equal(isImeEnter({ isComposing: false, keyCode: 13 }), false);
});

test('finding 5 / FR-MSG-013 AC-3: a session in rooms gets a dot with the room names; others none', () => {
  assert.deepEqual(roomDotLabelInput({ k1: ['a', 'b'] }, 'k1'), { count: 2, rooms: 'a, b' });
  assert.equal(roomDotLabelInput({ k1: [] }, 'k1'), null);
  assert.equal(roomDotLabelInput({ k1: ['a'] }, 'k2'), null);
  assert.equal(roomDotLabelInput(undefined, 'k1'), null);
  assert.equal(roomDotLabelInput({ k1: ['a'] }, undefined), null);
});

test('FR-MSG-014: the LAN port field takes 1..65535, empty means "keep the current port"', () => {
  assert.deepEqual(parseLanPort(''), { ok: true, port: undefined });
  assert.deepEqual(parseLanPort(' 3334 '), { ok: true, port: 3334 });
  assert.deepEqual(parseLanPort('0'), { ok: false });
  assert.deepEqual(parseLanPort('65536'), { ok: false });
  assert.deepEqual(parseLanPort('33a'), { ok: false });
});

import { visibleConnectionCode } from '../../src/components/Messenger/messengerWindowModel.ts';

test('D3: a connection code is shown only while company-network connections are accepted', () => {
  assert.equal(visibleConnectionCode('bgc1.x', true), 'bgc1.x');
  assert.equal(visibleConnectionCode('bgc1.x', false), null);
  assert.equal(visibleConnectionCode(null, true), null);
});

import { fitMessengerWindow, MESSENGER_MIN_SIZE } from '../../src/components/Messenger/messengerWindowModel.ts';

test('D6: the messenger window is pulled back inside the viewport, bottom included', () => {
  assert.deepEqual(fitMessengerWindow({ x: 160, y: 500, width: 720, height: 540 }, { width: 1280, height: 800 }), { x: 160, y: 260, width: 720, height: 540 });
  assert.deepEqual(fitMessengerWindow({ x: 900, y: 70, width: 720, height: 540 }, { width: 1280, height: 800 }), { x: 560, y: 70, width: 720, height: 540 });
  // A viewport smaller than the window shrinks it, never below the minimum the viewport allows.
  assert.deepEqual(fitMessengerWindow({ x: 160, y: 70, width: 720, height: 540 }, { width: 700, height: 500 }), { x: 0, y: 0, width: 700, height: 500 });
  assert.ok(MESSENGER_MIN_SIZE.width <= 320);
});
