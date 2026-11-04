// FR-MCP-022 AC-7/AC-8 (#235): session.search finds a session by the words of its name, in any
// order, with the stop words people add ("세션", "session", ...) and by workspace or folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMcpSessions } from './McpSessionRegistryContract.js';

type Row = Record<string, unknown>;

let order = 0;
function tab(id: string, fields: Row): Row {
  order += 1;
  return { id, sessionId: `sid-${id}`, sessionKey: `key-${id}`, workspaceId: 'ws-1', nameSource: 'user', sortOrder: order, ...fields };
}

const REGISTRY = [
  tab('restore', { name: '세션 복구 작업 판단', cwd: '/work/ProjectMaster' }),
  tab('git', { name: 'git viewer 개선', cwd: '/work/ProjectMaster/frontend' }),
  tab('title', { name: '✳ 원격 확장 애플리케이션 등록 기능 구현 연구', nameSource: 'terminal-title', terminalTitle: '✳ 원격 확장 애플리케이션 등록 기능 구현 연구', workspaceId: 'ws-2', cwd: '/home/me/AgentKernelX' }),
  tab('plain', { name: 'Terminal-2', nameSource: 'default', workspaceId: 'ws-2', cwd: '/home/me/DocuLightViewer' }),
];
const WORKSPACE_NAMES = { 'ws-1': 'BuilderGate', 'ws-2': 'Kernel Lab' };

function search(query: string) {
  return searchMcpSessions({ query, includeSelf: true, registry: REGISTRY, workspaceNames: WORKSPACE_NAMES }) as Row & { matches: Row[]; candidates?: Row[] };
}

function top(query: string): string | undefined {
  const result = search(query);
  return result.allowed === true ? String(result.matches[0].sessionKey) : undefined;
}

test('FR-MCP-022 AC-7: all words of the query, in any order, find the name', () => {
  assert.equal(top('복구 판단'), 'key-restore');
  assert.equal(top('판단 복구'), 'key-restore');
  assert.equal(top('세션 복구 세션'), 'key-restore', 'a repeated stop word does not drop the match');
  assert.equal(top('확장 등록'), 'key-title', 'words in the terminal title');
  assert.equal(search('세션 복원').allowed, false, 'a word that is not there is still a miss');
});

test('FR-MCP-022 AC-7: stop words are not required, and score when present', () => {
  assert.equal(top('git 세션'), 'key-git');
  assert.equal(top('viewer session'), 'key-git');
  const result = search('복구 세션');
  assert.equal(result.allowed, true);
  const withStop = Number(result.matches[0].score);
  const without = Number(search('판단 복구').matches[0].score);
  assert.ok(withStop > without, `stop word present scores higher: ${withStop} > ${without}`);
});

test('FR-MCP-022 AC-7: a query of stop words or one-letter words alone uses only exact and partial matching', () => {
  // "terminal" is a part of "Terminal-2" only: no word matching on every session.
  const result = search('terminal');
  assert.equal(result.allowed, true);
  assert.deepEqual(result.matches.map((m) => m.sessionKey), ['key-plain']);
  assert.equal(search('세 션').allowed, false);
});

test('FR-MCP-022 AC-7: a word match scores under a partial match of the same name', () => {
  const partial = search('세션 복구');
  assert.equal(partial.matches[0].matchType, 'partial-alias');
  const word = search('복구 판단');
  assert.equal(word.matches[0].matchType, 'word-alias');
  assert.ok(Number(word.matches[0].score) < Number(partial.matches[0].score));
});

test('FR-MCP-022 AC-8: the workspace name and the last folder of the working directory find a session', () => {
  const byFolder = search('AgentKernelX');
  assert.equal(byFolder.allowed, true);
  assert.equal(byFolder.matches[0].sessionKey, 'key-title');
  assert.equal(byFolder.matches[0].matchType, 'partial-cwd', 'the existing cwd match still wins');
  assert.equal(search('DocuLightViewer').matches[0].sessionKey, 'key-plain');
  const byWorkspace = search('kernel lab');
  assert.equal(byWorkspace.allowed, false, 'two sessions share the workspace');
  assert.deepEqual(byWorkspace.candidates?.map((m) => m.sessionKey).sort(), ['key-plain', 'key-title']);
  assert.equal(byWorkspace.candidates?.[0].score, 310);
  assert.equal(search('lab').candidates?.[0].score, 290);
  assert.equal(search('lab kernel').allowed, false, 'words only in the workspace name are not a split match');
});

test('FR-MCP-022 AC-8: words split over name, workspace and folder still find one session', () => {
  const result = search('BuilderGate 복구');
  assert.equal(result.allowed, true);
  assert.equal(result.matches[0].sessionKey, 'key-restore');
  assert.equal(result.matches[0].matchType, 'word-fields');
  assert.equal(result.matches[0].score, 320);
  assert.equal(top('frontend git'), 'key-git');
});

test('FR-MCP-022 AC-8: an exact or partial name match stays first', () => {
  assert.equal(search('세션 복구 작업 판단').matches[0].score, 1000);
  assert.equal(search('git viewer').matches[0].matchType, 'partial-alias');
  assert.equal(top('git viewer'), 'key-git');
});

test('FR-MCP-022 AC-8 (review M1): the new matches score under every existing match, so an existing winner stays first', () => {
  const registry = [
    tab('a', { name: 'alpha', terminalTitle: 'foo bar x', nameSource: 'user' }),
    tab('b', { name: 'bar foo', nameSource: 'user' }),
    tab('c', { name: 'gamma', agentAlias: 'reviewer-bot' }),
    tab('d', { name: 'delta', workspaceId: 'ws-r' }),
    tab('e', { name: 'echo', cwd: '/x/deploy-tools' }),
  ];
  const run = (query: string) => searchMcpSessions({ query, includeSelf: true, registry, workspaceNames: { 'ws-r': 'reviewer' } }) as Row & { matches: Row[] };
  assert.equal(run('foo bar').matches[0].sessionKey, 'key-a', 'partial terminal title over a user-alias word match');
  assert.equal(run('reviewer').matches[0].sessionKey, 'key-c', 'partial agent alias over an exact workspace name');
  for (const query of ['foo bar', 'reviewer', '복구 판단', 'BuilderGate 복구']) {
    for (const match of [...run(query).matches, ...search(query).matches]) {
      if (/^(word-|exact-workspace|partial-workspace|exact-cwd-folder)/.test(String(match.matchType))) {
        assert.ok(Number(match.score) < 350, `${query}: ${match.matchType} ${match.score}`);
      }
    }
  }
});
