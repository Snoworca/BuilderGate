// #18 / SEC-BGSTAB-001 AC-8: keyboard Ctrl+V must take the same path as every other source.
//
// 병합 전 실측 2026-09-19: termEl 의 capture 단계 paste 리스너는
// markUserXtermDataProvenance() 와 preventDefault() 만 호출했다. clipboardData 를 읽지도,
// sanitize 하지도, stopPropagation 하지도 않았다. 진짜 클립보드 읽기는 xterm 자신의
// Clipboard.handlePasteEvent 안에서 일어나 term.paste() -> bracketTextForPaste ->
// triggerDataEvent -> onData 로 직행했고, 그 onData 는 평범한 타이핑이 쓰는 바로 그
// 콜백이며 source 는 'xterm' 으로 떨어졌다. 결과: 키보드 붙여넣기는 (1) sanitize 를
// 전혀 거치지 않았고 (2) submitProgrammaticPaste 안의 여러 줄 가드를 통째로 우회했으며
// (3) onData 에서 키 입력과 구분조차 되지 않았다.
//
// 이 파일은 그 세 가지를 컴포넌트를 실제로 실행해서 고정한다. 소스 텍스트를 읽는
// 단언이 아니라 동작 단언이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installTerminalViewModuleMocks,
  renderTerminalView,
  type FakeTerminalState,
} from './terminalViewHarness.ts';
import { sanitizeTerminalPasteText } from '../../src/utils/terminalPasteSanitizer.ts';

const ESC = '\u001b';

function freshState(): FakeTerminalState {
  return {
    selection: '', keyHandler: null, dataHandler: null, writes: [],
    clearSelectionCalls: 0, pasted: [], bracketedPasteMode: true, oscHandlers: new Map(),
  };
}

const sharedState = freshState();
installTerminalViewModuleMocks(sharedState, { sent: [] });

test('AC-8: a keyboard paste carrying a close marker is sanitized before it is bracketed', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  view.pasteFromClipboard(`echo safe${ESC}[201~ && rm -rf /`);
  await view.flush();

  assert.equal(sharedState.pasted.length, 1, 'the paste must reach the terminal exactly once');
  // 이것이 공격 그 자체다. 마커가 살아남으면 셸이 여기서 paste mode 를 빠져나가고
  // 뒤따르는 ` && rm -rf /` 는 붙여넣은 텍스트가 아니라 실행된 명령이 된다.
  assert.equal(
    sharedState.pasted[0].includes(`${ESC}[201~`), false,
    'the embedded bracketed-paste close marker must not reach term.paste()',
  );
  assert.equal(sharedState.pasted[0], 'echo safe && rm -rf /');

  await view.unmount();
});

test('AC-8: the capture listener owns the paste so xterm cannot paste it a second time', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  const { defaultPrevented, reachedXtermListener } = view.pasteFromClipboard('hello');
  await view.flush();

  assert.equal(defaultPrevented, true, 'the browser must not also insert into the textarea');
  // xterm 은 paste 를 element 와 textarea 에 버블 단계로 건다. 그 단계에 도달했다면
  // xterm 의 핸들러도 돌았다는 뜻이고, 같은 텍스트가 두 번 붙는다.
  assert.equal(
    reachedXtermListener, false,
    'propagation must stop before xterm\'s own bubble-phase paste handlers',
  );
  assert.deepEqual(sharedState.pasted, ['hello']);

  await view.unmount();
});

test('AC-8: keyboard paste obeys the multiline guard it used to bypass entirely', async () => {
  Object.assign(sharedState, freshState());
  sharedState.bracketedPasteMode = false;
  const view = await renderTerminalView({ state: sharedState });

  view.pasteFromClipboard('first line\nsecond line');
  await view.flush();

  // bracketed paste 가 없으면 xterm 의 prepareTextForTerminal 이 개행을 CR 로 바꿔
  // 두 줄이 그대로 두 번의 Enter 가 된다. 그 경우 붙여넣기는 거절되어야 한다.
  assert.deepEqual(
    sharedState.pasted, [],
    'a multiline paste with bracketed paste off must be refused, not executed',
  );

  // 이 단언 하나만 떼어 놓으면 red-proof 가 아니다. 수정 전에도 통과한다 --
  // 그때는 '거절돼서' 가 아니라 키보드 경로가 stub 된 터미널에 애초에 도달하지
  // 못해서 pasted 가 비어 있었기 때문이다(실측: TerminalView.tsx 만 stash 하면
  // AC-8 넷 중 셋이 red, 이것만 green).
  //
  // 판별력은 바로 아래 테스트와의 **쌍**에 있다. 같은 입력을 bracketedPasteMode
  // 만 바꿔 두 번 넣고, 수정 후에는 결과가 갈린다(빈 배열 vs 붙여넣어짐).
  // 그 짝(on 쪽)은 수정 전 red 이므로, 둘을 함께 읽을 때만 '가드가 동작한다' 가
  // 증명된다. 이 테스트 혼자로는 경계 검사일 뿐이다.

  await view.unmount();
});

test('AC-8: with bracketed paste on, a multiline paste is admitted', async () => {
  Object.assign(sharedState, freshState());
  sharedState.bracketedPasteMode = true;
  const view = await renderTerminalView({ state: sharedState });

  view.pasteFromClipboard('first line\nsecond line');
  await view.flush();

  // 경계값: 가드가 여러 줄을 무조건 막는 것이 아니라 bracketed paste 여부로 나뉜다.
  assert.deepEqual(sharedState.pasted, ['first line\nsecond line']);

  await view.unmount();
});

test('#18: ordinary typing does not enter the paste path', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  // 이 변경의 회귀 위험은 '붙여넣기 경로가 타이핑을 삼키는 것' 이다. 그것을 고정한다.
  view.pressKey({ key: 'a' });
  sharedState.dataHandler?.('a');
  await view.flush();

  assert.deepEqual(sharedState.pasted, [], 'typing must not go through term.paste()');

  // 이 하네스가 덮지 못하는 것: onInput 까지의 실제 전달. 입력 전달은 transport
  // readiness 게이트 뒤에 있고 이 하네스는 그 상태에 도달하지 않아, 기존 behavior
  // 테스트들도 onInput 의 긍정 전달을 단언하지 않고 부정만 단언한다.
  // onData 안의 IME 이음매(observeXtermData 호출 위치)는 이 작업에서 건드리지
  // 않았고, 그 보증은 terminalViewKeyboardBehavior 의 IME 테스트가 계속 green 인
  // 것으로 유지된다.
  await view.unmount();
});

// --- SEC-BGSTAB-001: the OSC52 handler as actually registered ---------------------

test('AC-1: the OSC52 handler is registered at all, so the policy is a decision', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  // 이 단언이 지키는 것: 오늘의 안전이 '아무도 배선하지 않아서' 가 아니라 '정책이
  // 있어서' 라는 사실. 등록이 사라지면 OSC52 는 다시 의존성 그래프의 사고가 된다.
  assert.equal(
    typeof sharedState.oscHandlers?.get(52), 'function',
    'TerminalView must own OSC 52 rather than leaving it to whatever addon is installed',
  );

  await view.unmount();
});

test('AC-1: a read request writes nothing and is consumed rather than passed on', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  const handled = await sharedState.oscHandlers?.get(52)?.('c;?');
  await view.flush();

  // true = 처리했다. false 를 돌리면 언젠가 응답을 만드는 경로로 흘러갈 수 있고,
  // 그 응답은 PTY 의 input 채널로 주입된다.
  assert.equal(handled, true, 'a read must be consumed, not passed along');
  assert.deepEqual(view.clipboardWrites, [], 'a read must not touch the clipboard');

  await view.unmount();
});

test('AC-5: an allowed OSC52 write reaches the clipboard through the coordinator', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  await sharedState.oscHandlers?.get(52)?.(`c;${Buffer.from('agent output', 'utf-8').toString('base64')}`);
  await view.flush();

  assert.deepEqual(view.clipboardWrites, ['agent output']);

  await view.unmount();
});

test('AC-4: a malformed OSC52 payload leaves the clipboard untouched', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  const handled = await sharedState.oscHandlers?.get(52)?.('c;not valid base64!!');
  await view.flush();

  assert.equal(handled, true);
  // 조용히 빈 문자열을 쓰면 사용자의 클립보드를 지운다. 거부는 '아무것도 하지 않음' 이다.
  assert.deepEqual(view.clipboardWrites, [], 'a decode failure must not empty the clipboard');

  await view.unmount();
});

test('AC-3: an oversized OSC52 payload is refused without writing a truncated prefix', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  const oversized = Buffer.from('a'.repeat(102_401), 'utf-8').toString('base64');
  await sharedState.oscHandlers?.get(52)?.(`c;${oversized}`);
  await view.flush();

  assert.deepEqual(view.clipboardWrites, [], 'oversize must refuse, never truncate');

  await view.unmount();
});

// --- #18 criterion 8: the size cap on the shared paste path ----------------------

test('AC-8/criterion 8: an oversize paste is refused locally instead of reaching the terminal', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  // One byte over the server's own 64 KiB limit. Before the cap this reached the
  // transport and came back as `invalid-payload` -- the server blaming the client for a
  // message that was never malformed.
  view.pasteFromClipboard('a'.repeat(64 * 1024 + 1));
  await view.flush();

  assert.deepEqual(sharedState.pasted, [], 'an oversize paste must not reach term.paste()');

  await view.unmount();
});

test('AC-8/criterion 8: a paste exactly at the cap still goes through', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  // Boundary on the allowed side, so the cap cannot quietly become off-by-one and
  // start refusing pastes that used to work.
  const atCap = 'a'.repeat(64 * 1024);
  view.pasteFromClipboard(atCap);
  await view.flush();

  assert.deepEqual(sharedState.pasted, [atCap]);

  await view.unmount();
});

test('AC-8/criterion 8: the cap counts bytes, so multi-byte text is refused earlier', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  // Well under the cap in characters, over it in UTF-8 bytes. A character-based cap
  // would admit this and the server would then refuse it as invalid-payload.
  view.pasteFromClipboard('가'.repeat(30 * 1024));
  await view.flush();

  assert.deepEqual(sharedState.pasted, [], 'the cap must be measured in encoded bytes');

  await view.unmount();
});

// --- #18 criterion 1: what typing shares with paste, and what it must not ---------
//
// "Single coordinator" cannot mean "same treatment". Stripping an embedded ESC from a
// paste is the whole point of the sanitizer; stripping it from a user pressing Escape
// would break vi, less, menus -- the terminal. So the two paths share IDENTITY,
// SEQUENCING and the QUEUE/GATE, and they already do: both typing and paste leave
// TerminalView through submitCapturedInput -> onInput -> TerminalInputSequencer, which is
// where the operation id and sequence range are assigned. What stays on the paste path is
// paste POLICY: sanitize, the multiline guard, and the clipboard generation guard.

test('#18 criterion 1: a real Escape keypress is delegated to xterm untouched', async () => {
  Object.assign(sharedState, freshState());
  const view = await renderTerminalView({ state: sharedState });

  const { handlerResult, defaultPrevented } = view.pressKey({ key: 'Escape' });

  // Returning true hands the key to xterm, which encodes it and emits it on onData.
  // Returning false, or preventing the default, would swallow Escape; running it through
  // the paste sanitizer would delete it outright, since that is exactly what the
  // sanitizer does to a bare ESC (see terminalPasteSanitizer.test.ts).
  assert.equal(handlerResult, true, 'Escape must reach xterm');
  assert.equal(defaultPrevented, false, 'Escape must not be swallowed by TerminalView');
  assert.deepEqual(sharedState.pasted, [], 'a keypress must never enter the paste path');

  await view.unmount();
});

test('#18 criterion 1: the sanitizer would destroy Escape, which is why typing must not share it', () => {
  // This is the concrete reason the two paths are not unified further. It is asserted
  // rather than left as a comment so that anyone who later routes typing through
  // sanitizeTerminalPasteText meets a red test explaining what breaks.
  assert.equal(sanitizeTerminalPasteText('').text, '');
  assert.equal(sanitizeTerminalPasteText('[A').text, '[A');
});
