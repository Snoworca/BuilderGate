import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAliases, parseAliasInput } from '../../src/components/AgentAlias/agentAliasModel.ts';

// FR-AITUI-011 AC-1/AC-2 — the alias editor's text field.

test('FR-AITUI-011 AC-2 aliases split on spaces, commas and new lines, lower-cased and de-duplicated', () => {
  assert.deepEqual(parseAliasInput('claudep, claudex\nClaudeP  cc'), { names: ['claudep', 'claudex', 'cc'], invalid: [] });
  assert.deepEqual(parseAliasInput('   '), { names: [], invalid: [] });
});

test('FR-AITUI-011 AC-2 path-like or shell-special names are reported, not kept', () => {
  assert.deepEqual(parseAliasInput('ok bin/claudep c:\\x a;b'), { names: ['ok'], invalid: ['bin/claudep', 'c:\\x', 'a;b'] });
});

test('FR-AITUI-011 AC-2 a built-in name is not an alias', () => {
  assert.deepEqual(parseAliasInput('claude codexp', ['claude', 'claude-code']), { names: ['codexp'], invalid: ['claude'] });
});

test('FR-AITUI-011 the list is shown back as one space-separated line', () => {
  assert.equal(formatAliases(['claudep', 'claudex']), 'claudep claudex');
});
