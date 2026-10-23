// REL-BGSTAB-051 AC-4: MCP history kept in memory has a bounded recent size.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpToolService, MCP_HISTORY_LIMIT, rememberBounded, pushBounded } from './McpToolService.js';

test('REL-BGSTAB-051 AC-4: validation results keep only the most recent entries', () => {
  const service = createMcpToolService() as { recordValidationResult: (r: unknown) => unknown; getVerificationCoverage: () => { validations: Array<{ scenario: string }> } };
  for (let i = 0; i < MCP_HISTORY_LIMIT + 300; i += 1) service.recordValidationResult({ scenario: `s${i}`, status: 'covered' });
  const validations = service.getVerificationCoverage().validations;
  assert.equal(validations.length, MCP_HISTORY_LIMIT);
  assert.equal(validations.at(-1)?.scenario, `s${MCP_HISTORY_LIMIT + 299}`);
});

test('REL-BGSTAB-051 AC-4: the bounded helpers drop the oldest entries', () => {
  const list: number[] = [];
  for (let i = 0; i < 1000; i += 1) pushBounded(list, i, 256);
  assert.equal(list.length, 256);
  assert.deepEqual([list[0], list.at(-1)], [744, 999]);
  const map = new Map<string, number>();
  for (let i = 0; i < 1000; i += 1) rememberBounded(map, `a${i}`, i, 256);
  assert.equal(map.size, 256);
  assert.equal(map.has('a743'), false);
  assert.equal(map.get('a999'), 999);
});
