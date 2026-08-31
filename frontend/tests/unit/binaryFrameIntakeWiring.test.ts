import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * The two wiring sites `binaryFrameIntake.test.ts` cannot reach.
 *
 * `WebSocketContext.tsx` and `TerminalContainer.tsx` are JSX, and the unit
 * runner (`node --experimental-strip-types`) strips types without compiling
 * JSX — so neither can be imported. Their behaviour is pinned here by source
 * text, which is weaker than a behavioural test and is used only for the lines
 * that hand the collaborators over.
 *
 * Anchors are searched for, never sliced at a fixed offset: a fixed window
 * silently stops covering its subject as soon as the surrounding code grows.
 */

const IDENTIFIER_CHAR = /[A-Za-z0-9_]/u;

const contextSource = readFileSync(
  new URL('../../src/contexts/WebSocketContext.tsx', import.meta.url),
  'utf8',
);
const containerSource = readFileSync(
  new URL('../../src/components/Terminal/TerminalContainer.tsx', import.meta.url),
  'utf8',
);

/** The body of the object literal that starts at `anchor`, brace-matched. */
function objectLiteralAfter(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, `anchor not found: ${anchor}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `no object literal after: ${anchor}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced object literal after: ${anchor}`);
}

// ---------------------------------------------------------------------------
// WebSocketContext — the arriving frame is decoded rather than discarded.
// ---------------------------------------------------------------------------

test('the binary branch hands the buffer to the intake', () => {
  const branch = objectLiteralAfter(contextSource, 'intakeBinaryFrames(frame.buffer, ');

  for (const collaborator of [
    'maxBodyBytes:',
    'channelState:',
    'lookupChannel:',
    'liveTokens:',
    'deliverOutput:',
  ]) {
    assert.ok(branch.includes(collaborator), `the intake call is missing ${collaborator}`);
  }
});

test('the binary branch no longer drops the frame with a warning', () => {
  // A negative assertion is only meaningful while the string it denies is the
  // one that used to be there, so it is asserted to have existed in git rather
  // than merely being absent now — the closest available proxy is that the
  // replacement is present.
  assert.ok(
    contextSource.includes('intakeBinaryFrames('),
    'the intake must be called for the absence below to mean anything',
  );
  assert.ok(!contextSource.includes("'[WS] binary frame before negotiation'"));
});

test('the channel registry supplies both channel accessors', () => {
  const branch = objectLiteralAfter(contextSource, 'intakeBinaryFrames(frame.buffer, ');

  assert.match(branch, /channelState:\s*channelRegistryRef\.current\.channelState/);
  assert.match(branch, /lookupChannel:\s*channelRegistryRef\.current\.lookup/);
});

// ---------------------------------------------------------------------------
// TerminalContainer — the token seam, and the generation it must resolve at
// call time.
// ---------------------------------------------------------------------------

test('the container exposes the live tokens to the context', () => {
  assert.ok(
    containerSource.includes('getLiveOutputTokens'),
    'the container must supply the handler the context calls',
  );
});

test('the token lookup resolves its generation at call time', () => {
  const start = containerSource.indexOf('getLiveOutputTokens');
  assert.notEqual(start, -1, 'getLiveOutputTokens is missing');
  const end = containerSource.indexOf('\n', containerSource.indexOf('liveOutputTokenRef', start));
  assert.notEqual(end, -1, 'the lookup body was not found after the handler');
  const body = containerSource.slice(start, end);

  // `liveOutputTokenGeneration()` — invoked here, not a value captured earlier.
  // A captured generation would let a token outlive the authority it belongs
  // to, which is the whole reason the store is generation-stamped.
  assert.match(body, /liveOutputTokenRef\.current\.get\(\s*sessionId,\s*liveOutputTokenGeneration\(\)/);
});

// ---------------------------------------------------------------------------
// WebSocketContext — the three negotiation control messages are routed.
// ---------------------------------------------------------------------------

test('the negotiation control branch delegates to the client module', () => {
  assert.ok(
    contextSource.includes('isTerminalBinaryControlMessage(rawMessage)'),
    'the context does not ask the client module which messages are its own',
  );
  assert.ok(
    contextSource.includes('applyTerminalBinaryControlMessage(rawMessage, channelRegistryRef.current)'),
    'the context does not hand the live registry to the client module',
  );
});

test('the negotiation branch is placed before the generic message handling', () => {
  const branch = contextSource.indexOf('isTerminalBinaryControlMessage(rawMessage)');
  const generic = contextSource.indexOf('isCheckpointProtocolRecord(rawMessage)');
  assert.notEqual(branch, -1, 'the negotiation branch is missing');
  assert.notEqual(generic, -1, 'the checkpoint branch anchor moved');
  // A control message that reached the generic path would be logged as unknown.
  assert.ok(branch < generic, 'the negotiation branch runs too late');
});

// ---------------------------------------------------------------------------
// WebSocketContext — the client half of the handshake and of recovery.
// ---------------------------------------------------------------------------

test('the offer accompanies every checkpoint request made on a freshly usable socket', () => {
  // A bare substring search would also match `requestCurrentTerminalCheckpoint-
  // Capability(`, which is a different function, so the preceding character is
  // checked instead of using a lookbehind.
  const sitesOf = (name: string): number[] => {
    const needle = `${name}(`;
    const found: number[] = [];
    for (let at = contextSource.indexOf(needle); at !== -1;
      at = contextSource.indexOf(needle, at + 1)) {
      const before = at === 0 ? '' : contextSource.charAt(at - 1);
      if (!IDENTIFIER_CHAR.test(before)) found.push(at);
    }
    return found;
  };

  // The first site of each is the function declaration, not a call.
  const binaryCalls = sitesOf('requestTerminalBinaryCapability').slice(1);
  const checkpointCalls = sitesOf('requestTerminalCheckpointCapability').slice(1);
  assert.ok(binaryCalls.length >= 3, `the binary offer is sent from ${binaryCalls.length} sites`);

  // Each offer sits beside a checkpoint request, which is what marks the places
  // a socket has just become usable. The remaining checkpoint request is a
  // view-release renegotiation and must NOT re-offer binary: that would bump the
  // codec epoch for a reason that has nothing to do with the codec.
  for (const site of binaryCalls) {
    assert.ok(
      checkpointCalls.some(at => at >= site - 400 && at < site),
      `a binary offer at ${site} is not on a freshly usable socket`,
    );
  }
});
test('the offer is built by the client module rather than hand written', () => {
  assert.ok(
    contextSource.includes('buildTerminalBinaryOffer()'),
    'the context hand-builds the offer instead of using the module',
  );
});

test('unroutable channels are turned into a recovery request', () => {
  assert.ok(
    contextSource.includes('buildUnknownChannelRequest(report.unroutable)'),
    'unroutable channels are reported but never recovered',
  );
});
