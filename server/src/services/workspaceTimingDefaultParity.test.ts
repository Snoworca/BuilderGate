import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { workspaceSchema } from '../schemas/config.schema.js';

// #63: terminalTitleDebounceMs (250) and restoreInputDelayMs (600) are each written twice --
// once as a zod default, once as a `?? <literal>` fallback in WorkspaceService. Nothing forced
// them to agree, so one could move and the other would sit there silently disagreeing.
//
// Today the service literals are unreachable: index.ts does not pass these as options, so the
// production path always goes through config and config carries the schema default. That is
// exactly why a pin is worth having and a behavioural test is not -- there is no behaviour to
// assert, only two numbers that must not drift apart until someone makes the fallback reachable.

const serviceSource = readFileSync(
  new URL('./WorkspaceService.ts', import.meta.url), 'utf8');

function serviceFallbackLiteral(field: string): number {
  // Matches `wsConfig?.field ?? 250` and `options.x ?? wsConfig?.field ?? 250`.
  const pattern = new RegExp(`wsConfig\\?\\.${field}\\s*\\?\\?\\s*(\\d+)`, 'u');
  const match = serviceSource.match(pattern);
  assert.ok(match, `could not find the ${field} fallback literal; the pin cannot be vacuous`);
  return Number(match[1]);
}

test('#63 terminalTitleDebounceMs agrees between the schema default and the service fallback', () => {
  const schemaDefault = workspaceSchema.parse({}).terminalTitleDebounceMs;
  assert.equal(serviceFallbackLiteral('terminalTitleDebounceMs'), schemaDefault);
});

test('#63 restoreInputDelayMs agrees between the schema default and the service fallback', () => {
  const schemaDefault = workspaceSchema.parse({}).restoreInputDelayMs;
  assert.equal(serviceFallbackLiteral('restoreInputDelayMs'), schemaDefault);
});
