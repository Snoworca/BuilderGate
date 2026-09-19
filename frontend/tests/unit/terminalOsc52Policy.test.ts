// SEC-BGSTAB-001: the OSC52 clipboard escape policy.
//
// 실측 2026-09-19 (병합 전): OSC52 는 어느 방향으로도 구현되어 있지 않았다. xterm 6.0.0
// 번들은 OSC 0,1,2,4,8,10,11,12,104,110,111,112 만 등록하고 52 는 등록하지 않으며,
// @xterm/addon-clipboard 는 설치되어 있지 않고, osc52 / allowWrite 는 config.schema.ts
// 어디에도 없다. 즉 오늘의 안전은 결정이 아니라 의존성 그래프의 사고였고, 누군가
// addon 을 추가하는 순간 읽기와 쓰기가 한꺼번에, 상한도 검증도 없이 켜진다.
// 이 파일은 정책을 결정으로 만든다.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateOsc52Request,
  OSC52_MAX_DECODED_BYTES,
} from '../../src/utils/terminalOsc52.ts';

const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64');

test('AC-1: a read request is denied even when writes are allowed', () => {
  // 읽기 응답은 PTY 의 input 채널로 주입된다. 사용자가 마지막으로 복사한 것 -- 이
  // 제품의 사용자 집단에서는 대개 키나 토큰 -- 을 그대로 넘겨주는 원시 유출수단이다.
  const decision = evaluateOsc52Request('c;?', { allowWrite: true });

  assert.equal(decision.kind, 'deny-read');
});

test('AC-1: a read request is denied with writes disabled too, by the same rule', () => {
  const decision = evaluateOsc52Request('c;?', { allowWrite: false });

  assert.equal(decision.kind, 'deny-read');
});

test('AC-1: the read denial does not depend on the selection parameter', () => {
  for (const pc of ['c', 'p', 's', '', 'cp']) {
    const decision = evaluateOsc52Request(`${pc};?`, { allowWrite: true });
    assert.equal(decision.kind, 'deny-read', `Pc=${pc}`);
  }
});

test('AC-2: a write is allowed by default', () => {
  const decision = evaluateOsc52Request(`c;${b64('hello')}`, { allowWrite: true });

  assert.equal(decision.kind, 'allow-write');
  assert.equal(decision.kind === 'allow-write' && decision.text, 'hello');
});

test('AC-2: a write is denied when terminal.osc52.allowWrite is false', () => {
  const decision = evaluateOsc52Request(`c;${b64('hello')}`, { allowWrite: false });

  assert.equal(decision.kind, 'deny-write-disabled');
});

test('AC-3: an oversized payload is refused, never truncated', () => {
  const oversized = b64('a'.repeat(OSC52_MAX_DECODED_BYTES + 1));
  const decision = evaluateOsc52Request(`c;${oversized}`, { allowWrite: true });

  assert.equal(decision.kind, 'refuse-oversize');
  // 잘라서 통과시키면 피해 범위 제한이 아니라 피해 범위 조정이 된다.
  assert.equal('text' in decision, false, 'an oversize refusal must not carry any payload');
});

test('AC-3: the cap boundary itself is allowed', () => {
  const atCap = b64('a'.repeat(OSC52_MAX_DECODED_BYTES));
  const decision = evaluateOsc52Request(`c;${atCap}`, { allowWrite: true });

  assert.equal(decision.kind, 'allow-write');
  assert.equal(decision.kind === 'allow-write' && decision.decodedBytes, OSC52_MAX_DECODED_BYTES);
});

test('AC-3: the cap is measured in decoded bytes, not characters', () => {
  // 3바이트 UTF-8 문자로 상한을 넘긴다. 문자 수로 재면 통과하고 바이트로 재면 막힌다.
  const text = '가'.repeat(OSC52_MAX_DECODED_BYTES / 3 + 1);
  const decision = evaluateOsc52Request(`c;${b64(text)}`, { allowWrite: true });

  assert.equal(decision.kind, 'refuse-oversize');
});

test('AC-4: invalid base64 is refused rather than silently emptying the clipboard', () => {
  const decision = evaluateOsc52Request('c;not valid base64!!', { allowWrite: true });

  assert.equal(decision.kind, 'refuse-malformed');
  assert.equal(decision.kind === 'refuse-malformed' && decision.detail, 'base64');
});

test('AC-4: unpadded base64 is refused, because strict means strict', () => {
  // 'aGVsbG8' 는 패딩이 빠진 'aGVsbG8=' 다. 관대하게 받으면 무엇이 유효한지가
  // 구현 세부사항이 되고, 그것은 검증이 아니다.
  const decision = evaluateOsc52Request('c;aGVsbG8', { allowWrite: true });

  assert.equal(decision.kind, 'refuse-malformed');
  assert.equal(decision.kind === 'refuse-malformed' && decision.detail, 'base64');
});

test('AC-4: valid base64 that is not valid UTF-8 is refused', () => {
  // 0xff 는 어떤 UTF-8 시퀀스로도 시작할 수 없다.
  const decision = evaluateOsc52Request('c;/w==', { allowWrite: true });

  assert.equal(decision.kind, 'refuse-malformed');
  assert.equal(decision.kind === 'refuse-malformed' && decision.detail, 'utf8');
});

test('AC-4: a payload with no selection separator is refused as malformed syntax', () => {
  const decision = evaluateOsc52Request('nonsense', { allowWrite: true });

  assert.equal(decision.kind, 'refuse-malformed');
  assert.equal(decision.kind === 'refuse-malformed' && decision.detail, 'syntax');
});

test('AC-4: an explicitly empty payload is a valid clear, not a malformed decode', () => {
  // 빈 base64 는 OSC52 에서 클립보드 비우기다. 이것을 거절하면 정상 동작을 막고,
  // 디코드 실패를 이것과 같이 취급하면 AC-4 가 금지한 '조용히 비우기' 가 된다.
  const decision = evaluateOsc52Request('c;', { allowWrite: true });

  assert.equal(decision.kind, 'allow-write');
  assert.equal(decision.kind === 'allow-write' && decision.text, '');
  assert.equal(decision.kind === 'allow-write' && decision.decodedBytes, 0);
});

test('AC-4: the write decision is reached for every selection parameter form', () => {
  for (const pc of ['c', 'p', 's', 'q', '', '0', 'cp']) {
    const decision = evaluateOsc52Request(`${pc};${b64('x')}`, { allowWrite: true });
    assert.equal(decision.kind, 'allow-write', `Pc=${pc}`);
  }
});

test('AC-3 + AC-2: the disabled switch is checked before the size cap', () => {
  // 쓰기가 꺼져 있으면 크기를 재 볼 이유가 없고, 거부 사유도 크기가 아니라 정책이어야
  // 운영자가 무엇을 바꿔야 하는지 안다.
  const oversized = b64('a'.repeat(OSC52_MAX_DECODED_BYTES + 1));
  const decision = evaluateOsc52Request(`c;${oversized}`, { allowWrite: false });

  assert.equal(decision.kind, 'deny-write-disabled');
});

test('AC-1 + AC-2: a read is denied before the write switch is consulted', () => {
  // 읽기는 정책이 아니라 금지다. allowWrite 가 무엇이든 deny-read 여야 한다.
  assert.equal(evaluateOsc52Request(';?', { allowWrite: true }).kind, 'deny-read');
  assert.equal(evaluateOsc52Request(';?', { allowWrite: false }).kind, 'deny-read');
});

test('#18: the decoded byte cap is 100 KB', () => {
  assert.equal(OSC52_MAX_DECODED_BYTES, 102400);
});
