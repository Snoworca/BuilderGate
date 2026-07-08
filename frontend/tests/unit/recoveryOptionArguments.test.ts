import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatRecoveryDraftArguments,
  parseRecoveryDraftArguments,
} from '../../src/utils/recoveryOptionArguments.ts';

test('recovery option argument draft codec preserves Windows paths with spaces', () => {
  const source = ['\\\\server\\share path', 'C:\\Program Files\\Tool'];

  const formatted = formatRecoveryDraftArguments(source);
  const parsed = parseRecoveryDraftArguments(formatted);

  assert.deepEqual(parsed, source);
});

test('recovery option argument draft codec preserves empty and whitespace arguments', () => {
  const source = ['', '   ', 'plain'];

  const formatted = formatRecoveryDraftArguments(source);
  const parsed = parseRecoveryDraftArguments(formatted);

  assert.deepEqual(parsed, source);
});
