// FR-MCP-015 AC-7 (#232): the server's key encoder (buildergate.message.send keys) and the browser's
// mobile key encoder (FR-MKB-001) are two copies of one table, kept apart because the two packages
// share no source folder. This test is what keeps them one table: every key name and a set of
// characters, under every modifier combination and both cursor modes, must give the same bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMobileKey, type ModifierState } from '../../src/utils/mobileKeyEncoder.ts';
import type * as ServerKeys from '../../../server/src/services/terminalKeys.ts';

async function loadServer(): Promise<typeof ServerKeys> {
  return await import('../../../server/src/services/terminalKeys.ts') as typeof ServerKeys;
}

const NAMED_KEYS = [
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Insert', 'Delete', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Esc', 'Tab', 'Enter', 'Backspace',
] as const;
const CHARACTERS = ['a', 'z', 'A', 'Z', 'm', 'j', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'é', '한', '😀', ' ', '@', '[', '\\', ']', '^', '_', '-', '?', '/', '+', '.'];

function allModifiers(): ModifierState[] {
  const out: ModifierState[] = [];
  for (const ctrl of [false, true]) for (const alt of [false, true]) for (const shift of [false, true]) out.push({ ctrl, alt, shift });
  return out;
}

test('FR-MCP-015 AC-7: the server key encoder gives the same bytes as the mobile key encoder for every key, modifier and cursor mode', async () => {
  const { encodeTerminalKey } = await loadServer();
  let compared = 0;
  for (const key of [...NAMED_KEYS, ...CHARACTERS]) {
    for (const mods of allModifiers()) {
      for (const applicationCursor of [false, true]) {
        assert.equal(
          JSON.stringify(encodeTerminalKey(key, mods, applicationCursor)),
          JSON.stringify(encodeMobileKey(key, mods, applicationCursor)),
          `${key} ${JSON.stringify(mods)} applicationCursor=${applicationCursor}`,
        );
        compared += 1;
      }
    }
  }
  assert.equal(compared, (NAMED_KEYS.length + CHARACTERS.length) * 8 * 2);
});
