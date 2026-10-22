import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  applyGraceBufferedMessage,
  createGraceBufferedSessionState,
  flushGraceBufferedSession,
} from '../../src/utils/terminalGraceBuffer.ts';
import { describeEditorWait } from '../../src/components/Terminal/editorWaitNotice.ts';

// FR-ARCH-014: the server says when a session waits on a GUI editor on its own
// desktop (measured 2026-10-21: Claude Code's Ctrl+G left a notepad open for
// 2.5 hours that no phone could see), and the terminal shows it with a button
// that closes that editor.

type GraceMessage = Parameters<typeof applyGraceBufferedMessage>[2];
type FlushHandlers = Parameters<typeof flushGraceBufferedSession>[1];
type EditorWait = { pid: number; name: string; startedAtMs: number | null };

const NOTEPAD: EditorWait = { pid: 400, name: 'Notepad.exe', startedAtMs: 3_100 };

function editorWaitMessage(editor: EditorWait | null): GraceMessage {
  return { type: 'session:editor-wait', sessionId: 's1', editor } as unknown as GraceMessage;
}

function flushEditorWaits(messages: GraceMessage[]): Array<EditorWait | null> {
  let state = createGraceBufferedSessionState();
  for (const message of messages) state = applyGraceBufferedMessage(state, 's1', message);
  const seen: Array<EditorWait | null> = [];
  const handlers = { onEditorWait: (editor: EditorWait | null) => seen.push(editor) } as unknown as FlushHandlers;
  flushGraceBufferedSession(state, handlers);
  return seen;
}

test('FR-ARCH-014 AC-2: an editor wait that arrives before the terminal mounts reaches it', () => {
  assert.deepEqual(flushEditorWaits([editorWaitMessage(NOTEPAD)]), [NOTEPAD]);
});

test('FR-ARCH-014 AC-2: the latest state wins, an ended wait included', () => {
  assert.deepEqual(flushEditorWaits([editorWaitMessage(NOTEPAD), editorWaitMessage(null)]), [null]);
  assert.deepEqual(flushEditorWaits([]), [], 'no message, no call');
});

test('FR-ARCH-014 AC-3: the notice names the editor and offers to close it', () => {
  assert.equal(describeEditorWait(null), null);
  assert.deepEqual(describeEditorWait(NOTEPAD), {
    message: '서버 PC에서 편집기(Notepad.exe)가 열려 이 세션이 기다리고 있습니다.',
    closeLabel: '편집기 닫기',
  });
});

test('FR-ARCH-014 AC-2·AC-3: the live message reaches the terminal, which shows the notice', () => {
  const context = readFileSync(new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url), 'utf8');
  assert.match(context, /case 'session:editor-wait':\s*handlers\.onEditorWait\?\.\(msg\.editor\);/u);
  const container = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');
  assert.match(container, /onEditorWait: handleEditorWait,/u);
  assert.match(container, /<EditorWaitBanner\b/u);
});

test('FR-ARCH-014 AC-2: a terminal that attaches reads the wait that began before it came', () => {
  // WsRouter.ts is a sealed authority source, so the current state is read over
  // REST when the terminal mounts instead of being pushed by the subscribe path.
  const api = readFileSync(new URL('../../src/services/api.ts', import.meta.url), 'utf8');
  const start = api.indexOf('getEditorWait: async (');
  assert.ok(start > 0, 'sessionApi.getEditorWait exists');
  const body = api.slice(start, api.indexOf('\n  },', start));
  assert.match(body, /\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/editor-wait`/u);
  const container = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');
  const effect = container.slice(container.indexOf('sessionApi.getEditorWait(sessionId)') - 400, container.indexOf('sessionApi.getEditorWait(sessionId)') + 400);
  assert.ok(effect.includes('sessionApi.getEditorWait(sessionId)'), 'the container reads it on mount');
  assert.match(effect, /editorWaitLiveSeenRef\.current/u, 'a live message that came first is not overwritten');
});

test('FR-ARCH-014 AC-4: closing posts the pid the notice showed', () => {
  const api = readFileSync(new URL('../../src/services/api.ts', import.meta.url), 'utf8');
  const start = api.indexOf('closeEditorWait: async (');
  assert.ok(start > 0, 'sessionApi.closeEditorWait exists');
  const body = api.slice(start, api.indexOf('\n  },', start));
  assert.match(body, /\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/editor-wait\/close/u);
  assert.match(body, /method: 'POST'/u);
  assert.match(body, /JSON\.stringify\(\{ pid \}\)/u);
});
