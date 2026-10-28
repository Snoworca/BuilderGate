import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  bindAutomaticReplyInput,
  forgetAutomaticReplies,
  isAutomaticReplyRejection,
  noteAutomaticReplyCapture,
} from '../../src/utils/automaticInputReplies.ts';

// REL-BGSTAB-057: a refused input the terminal answered on its own (a parser-generated
// query reply) is not reported to the user as lost typing.

// @req REL-BGSTAB-057
test('REL-BGSTAB-057 AC-1/AC-2: a refused automatic reply is recognised by its input seq', () => {
  forgetAutomaticReplies('s1');
  noteAutomaticReplyCapture('s1', 7);
  bindAutomaticReplyInput('s1', { captureSeq: 7, inputSeqStart: 40, inputSeqEnd: 40 });
  assert.equal(isAutomaticReplyRejection('s1', { inputSeqStart: 40, inputSeqEnd: 40 }), true);
});

// @req REL-BGSTAB-057
test('REL-BGSTAB-057 AC-2: typed input, a mixed range or a missing range is still reported', () => {
  forgetAutomaticReplies('s1');
  bindAutomaticReplyInput('s1', { captureSeq: 8, inputSeqStart: 41, inputSeqEnd: 41 });
  assert.equal(isAutomaticReplyRejection('s1', { inputSeqStart: 41, inputSeqEnd: 41 }), false, 'never marked');
  noteAutomaticReplyCapture('s1', 9);
  bindAutomaticReplyInput('s1', { captureSeq: 9, inputSeqStart: 42, inputSeqEnd: 42 });
  assert.equal(isAutomaticReplyRejection('s1', { inputSeqStart: 41, inputSeqEnd: 42 }), false, 'mixed');
  assert.equal(isAutomaticReplyRejection('s1', {}), false, 'no range');
  bindAutomaticReplyInput('s1', { inputSeqStart: 43, inputSeqEnd: 43 });
  assert.equal(isAutomaticReplyRejection('s1', { inputSeqStart: 43, inputSeqEnd: 43 }), false, 'no capture seq');
});

// @req REL-BGSTAB-057
test('REL-BGSTAB-057 AC-1: sessions are kept apart', () => {
  forgetAutomaticReplies('s1');
  forgetAutomaticReplies('s2');
  noteAutomaticReplyCapture('s1', 1);
  bindAutomaticReplyInput('s2', { captureSeq: 1, inputSeqStart: 5, inputSeqEnd: 5 });
  assert.equal(isAutomaticReplyRejection('s2', { inputSeqStart: 5, inputSeqEnd: 5 }), false);
});

// @req REL-BGSTAB-057
test('REL-BGSTAB-057 AC-1: only the most recent replies are remembered', () => {
  forgetAutomaticReplies('s3');
  for (let i = 1; i <= 2000; i += 1) {
    noteAutomaticReplyCapture('s3', i);
    bindAutomaticReplyInput('s3', { captureSeq: i, inputSeqStart: i, inputSeqEnd: i });
  }
  assert.equal(isAutomaticReplyRejection('s3', { inputSeqStart: 1, inputSeqEnd: 1 }), false, 'the oldest is forgotten');
  assert.equal(isAutomaticReplyRejection('s3', { inputSeqStart: 2000, inputSeqEnd: 2000 }), true);
});

const viewSource = readFileSync(new URL('../../src/components/Terminal/TerminalView.tsx', import.meta.url), 'utf8');
const containerSource = readFileSync(new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url), 'utf8');
const contextSource = readFileSync(new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url), 'utf8');

// @req REL-BGSTAB-057
test('REL-BGSTAB-057 AC-1/AC-2: the reply is noted where it is sent, bound where it is numbered, and checked before the toast', () => {
  const replyBranch = viewSource.indexOf("isTerminalQueryReply(data, { provenance: 'parser-generated' })");
  assert.notEqual(replyBranch, -1);
  assert.match(viewSource.slice(replyBranch, replyBranch + 4000), /noteAutomaticReplyCapture\(sessionId,/);
  const deliver = containerSource.indexOf('const deliverSequencedInput = useCallback(');
  assert.match(containerSource.slice(deliver, deliver + 600), /bindAutomaticReplyInput\(sessionId,/);
  const rejected = contextSource.indexOf("if (msg.type === 'input:rejected') {");
  assert.match(
    contextSource.slice(rejected, rejected + 1600),
    /if \(shouldSurfaceInputRejection\(msg\.reason\)\) \{\s*if \(isAutomaticReplyRejection\(sessionId, msg\)\) \{[\s\S]{0,200}\} else \{\s*publishInputDiscard\(sessionId\);/,
  );
});
