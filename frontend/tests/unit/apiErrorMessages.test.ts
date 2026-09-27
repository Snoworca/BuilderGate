import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installCatalog } from '../../src/i18n/i18n.ts';
import { parseApiErrorPayload } from '../../src/services/apiError.ts';
import { API_ERROR_KEYS, localizeApiError } from '../../src/services/apiErrorMessages.ts';

// FR-I18N-007 — server error codes reach the screen in the active language.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SERVER = path.join(REPO, 'server/src');
const read = (rel: string) => readFileSync(path.join(SERVER, rel), 'utf8');
const catalog = (lang: string) => JSON.parse(readFileSync(path.join(REPO, `frontend/public/locales/messages.${lang}.json`), 'utf8')) as Record<string, string>;

// Sources whose error codes are answered to the browser. The MCP JSON-RPC tool
// surface (McpToolService, McpNodeHttpBoundary) and the WS router answer agents
// and sockets, not the REST UI, so they are left out on purpose.
const BROWSER_FACING = [
  'index.ts',
  'middleware/debugCaptureGuards.ts',
  'middleware/requestBodyLimit.ts',
  ...readdirSync(path.join(SERVER, 'routes')).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => `routes/${f}`),
  'services/AgentLifecycleService.ts',
  'services/McpControlConfigCoordinator.ts',
  'services/McpControlConfigStore.ts',
  'services/McpControlService.ts',
  'services/McpSecurityContract.ts',
  'services/SessionInputGateway.ts',
  'services/WorkspaceService.ts',
  'services/WebhookInvocationService.ts',
];

function serverCodes(): string[] {
  const codes = new Set<string>();
  const errors = read('utils/errors.ts');
  const enumBody = errors.slice(errors.indexOf('export enum ErrorCode'), errors.indexOf('}', errors.indexOf('export enum ErrorCode')));
  for (const m of enumBody.matchAll(/^\s+([A-Z][A-Z0-9_]+)\s*=/gm)) codes.add(m[1]);
  const jobRoutes = read('routes/fileJobRoutes.ts');
  const jobTable = jobRoutes.slice(jobRoutes.indexOf('MANAGER_ERROR_STATUS'), jobRoutes.indexOf('};', jobRoutes.indexOf('MANAGER_ERROR_STATUS')));
  for (const m of jobTable.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)) codes.add(m[1]);
  for (const rel of BROWSER_FACING) {
    for (const m of read(rel).matchAll(/code:\s*'([A-Z][A-Z0-9_]+)'/g)) codes.add(m[1]);
  }
  return [...codes].sort();
}

test('FR-I18N-007 AC-1: the code table is exactly the codes the server can answer the browser with', () => {
  assert.deepEqual(Object.keys(API_ERROR_KEYS).sort(), serverCodes());
});

test('FR-I18N-007 AC-2: a known code is translated; English keeps the server message; unknown codes fall back', () => {
  installCatalog('ko', catalog('ko'));
  assert.equal(localizeApiError('SESSION_NOT_FOUND', 'Session not found'), '세션을 찾을 수 없습니다.');
  assert.equal(localizeApiError('SOMETHING_NEW', 'Something new'), 'Something new');
  installCatalog('en', catalog('en'));
  assert.equal(localizeApiError('NAME_TOO_LONG', 'Name too long (max 50 characters)'), 'Name too long (max 50 characters)');
  assert.equal(localizeApiError('NAME_TOO_LONG', undefined), 'Name is too long (max 50 characters).');
});

test('FR-I18N-007 AC-3: parseApiErrorPayload shows the translated message with the code, and a translated HTTP fallback', () => {
  installCatalog('ko', catalog('ko'));
  assert.equal(
    parseApiErrorPayload(404, 'Not Found', { error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } }),
    '세션을 찾을 수 없습니다. (Session not found; SESSION_NOT_FOUND)',
  );
  assert.equal(parseApiErrorPayload(502, 'Bad Gateway', null), '요청이 실패했습니다 (HTTP 502).');
});

test('FR-I18N-007 AC-4: no browser-facing server error answers with a string-only body (it would have no code to translate)', () => {
  const stringBodies: string[] = [];
  for (const rel of BROWSER_FACING) {
    const source = read(rel);
    for (const m of source.matchAll(/json\(\{\s*error:\s*['"`]/g)) {
      stringBodies.push(`${rel}:${source.slice(0, m.index).split('\n').length}`);
    }
  }
  assert.deepEqual(stringBodies, []);
});
