import assert from 'node:assert/strict';
import { test } from 'node:test';

interface TerminalQueryReplyModule {
  isTerminalQueryReply(
    data: string,
    options: { provenance: 'parser-generated' | 'user-input' },
  ): boolean;
}

const EXPECTED_FAILURE =
  'MIG-BGSTAB-002 AC-3 view attribute reply contract missing';

async function loadContract(): Promise<TerminalQueryReplyModule> {
  const modulePath = '../../src/utils/terminalQueryReply.ts';
  try {
    return await import(modulePath) as TerminalQueryReplyModule;
  } catch (cause) {
    const expectedUrl = new URL(modulePath, import.meta.url).href;
    const isExpectedMissingContract = typeof cause === 'object'
      && cause !== null
      && 'code' in cause
      && cause.code === 'ERR_MODULE_NOT_FOUND'
      && 'url' in cause
      && cause.url === expectedUrl;
    if (isExpectedMissingContract) {
      throw new Error(EXPECTED_FAILURE, { cause });
    }
    throw cause;
  }
}

test('terminal query responder stays silent before driver view attributes and matches OSC color and DSR 996 replies after push', async () => {
  const contract = await loadContract();
  assert.equal(typeof contract.isTerminalQueryReply, 'function', EXPECTED_FAILURE);

  const replyFixtures = [
    ['CPR', '\x1b[3;1R'],
    // Orca documents the VT ambiguity: modified F3 is byte-identical to CPR.
    // Immediate routing preserves order; only debounce/activity accounting differs.
    ['modified F3 / CPR ambiguity', '\x1b[1;2R'],
    ['DECXCPR', '\x1b[?12;5R'],
    ['DSR', '\x1b[0n'],
    ['DA1', '\x1b[?1;2c'],
    ['ConPTY DA1', '\x1b[?61;4c'],
    ['DA2', '\x1b[>0;276;0c'],
    ['DECRPM private', '\x1b[?2026;2$y'],
    ['DECRPM ANSI', '\x1b[4;1$y'],
    ['OSC 4 palette', '\x1b]4;1;rgb:cccc/0000/0000\x1b\\'],
    ['OSC 10 foreground BEL', '\x1b]10;rgb:d0d0/d0d0/d0d0\x07'],
    ['OSC 11 background ST', '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'],
    ['OSC 12 cursor', '\x1b]12;rgb:ffff/9999/0000\x1b\\'],
    ['DSR 996 reply', '\x1b[?997;1n'],
    ['DECRQSS cursor', '\x1bP1$r5 q\x1b\\'],
    ['DECRQSS SGR', '\x1bP1$r0m\x1b\\'],
    ['DECRQSS unsupported report', '\x1bP0$r\x1b\\'],
    ['XTVERSION', '\x1bP>|xterm.js(6.0.0)\x1b\\'],
    ['window pixels', '\x1b[4;384;640t'],
    ['cell pixels', '\x1b[6;16;8t'],
    ['text area', '\x1b[8;24;80t'],
    ['kitty flags', '\x1b[?31u'],
  ] as const;

  for (const [label, data] of replyFixtures) {
    assert.equal(contract.isTerminalQueryReply(data, { provenance: 'parser-generated' }), true, label);
  }

  const parserGeneratedNonReplyFixtures = [
    ['empty', ''],
    ['plain text', 'ordinary-output'],
    ['partial CSI', '\x1b[?1;2'],
    ['partial OSC', '\x1b]11;rgb:1e1e/1e1e/2e2e'],
    ['partial DCS', '\x1bP1$r5 q'],
    ['arrow key', '\x1b[A'],
    ['bracketed paste', '\x1b[200~pasted\x1b[201~'],
    ['SGR mouse', '\x1b[<0;10;5M'],
    ['focus', '\x1b[I'],
    ['unknown CSI report', '\x1b[999z'],
    ['two concatenated replies', '\x1b[0n\x1b[?1;2c'],
  ] as const;
  for (const [label, data] of parserGeneratedNonReplyFixtures) {
    assert.equal(
      contract.isTerminalQueryReply(data, { provenance: 'parser-generated' }),
      false,
      `parser-generated non-reply: ${label}`,
    );
  }

  const userInputFixtures = [
    ['plain key', 'y'],
    ['IME Hangul commit', '한글 입력'],
    ['IME CJK commit', '中文入力'],
    ['Enter', '\r'],
    ['Ctrl-C', '\x03'],
    ['arrow up', '\x1b[A'],
    ['arrow down', '\x1b[B'],
    ['arrow right', '\x1b[C'],
    ['arrow left', '\x1b[D'],
    ['Home', '\x1b[H'],
    ['End', '\x1b[F'],
    ['Delete', '\x1b[3~'],
    ['function key', '\x1b[15~'],
    ['modified F1', '\x1b[1;2P'],
    ['modified F2', '\x1b[1;2Q'],
    ['modified F4', '\x1b[1;2S'],
    ['bare Escape', '\x1b'],
    ['Alt key', '\x1bb'],
    ['kitty modified key', '\x1b[97;5u'],
    ['kitty Enter key', '\x1b[13u'],
    ['bracketed paste start', '\x1b[200~'],
    ['bracketed paste payload', '\x1b[200~\x1b[?61;4c pasted\x1b[201~'],
    ['bracketed paste end', '\x1b[201~'],
    ['SGR mouse press', '\x1b[<0;10;5M'],
    ['SGR mouse release', '\x1b[<0;10;5m'],
    ['X10 mouse', '\x1b[M !!'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['incomplete OSC reply', '\x1b]11;rgb:1e1e/1e1e/2e2e'],
    ['incomplete DCS reply', '\x1bP1$r5 q'],
  ] as const;

  for (const [label, data] of userInputFixtures) {
    assert.equal(contract.isTerminalQueryReply(data, { provenance: 'user-input' }), false, label);
  }

  assert.equal(
    contract.isTerminalQueryReply('\x1b[1;2R', { provenance: 'user-input' }),
    false,
    'modified F3 provenance must win over byte-identical CPR grammar',
  );
});
