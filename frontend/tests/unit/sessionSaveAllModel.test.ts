import './i18nTestSetup.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initialDraft,
  isValidSessionId,
  joinArgs,
  launcherOptions,
  needsReview,
  parseArgs,
  restoreCommandPreview,
  rowMatchesFilter,
  rowStatus,
  summarizeReport,
  reportAutoDismissMs,
  toSaveItem,
  type PreviewTab,
  type RestoreReportItem,
} from '../../src/components/SessionSave/sessionSaveAllModel.ts';

// FR-AITUI-015 — the rules the all-terminal save dialog and the restore report apply.

const CLAUDE_ID = '3f2a9c1e-5b7d-4c11-9a2e-0d6f81b4c7aa';
const CODEX_ID = '0199a2c4-7e1b-7d30-b1c2-44f0e9a1d3b8';

function tab(over: Partial<PreviewTab>): PreviewTab {
  return {
    tabId: 't1', workspaceId: 'w1', workspaceName: 'ProjectMaster', tabName: 'build', cwd: '/work',
    runningCommand: null, agent: null, launcher: null, args: [], sessionId: null, method: null, confidence: null, candidates: [],
    ...over,
  };
}

const claudeTab = tab({ agent: 'claude', launcher: 'claudep', args: ['--model', 'opus'], sessionId: CLAUDE_ID, confidence: 'exact', runningCommand: 'claudep --model opus' });
const codexGuess = tab({ tabId: 't2', agent: 'codex', launcher: 'codex', args: [], sessionId: CODEX_ID, confidence: 'estimated' });
const codexMissing = tab({ tabId: 't3', agent: 'codex', launcher: 'codexp', args: ['--full-auto'], confidence: 'missing' });
const devServer = tab({ tabId: 't4', runningCommand: 'npm run dev' });

test('AC-1/AC-2: every tab starts selected; only a guessed or missing id opens its editor', () => {
  const exact = initialDraft(claudeTab);
  assert.equal(exact.picked, true);
  assert.equal(exact.mode, 'agent');
  assert.equal(exact.launcher, 'claudep');
  assert.equal(exact.argsText, '--model opus');
  assert.equal(exact.open, false);
  assert.equal(initialDraft(codexGuess).open, true);
  assert.equal(initialDraft(codexMissing).open, true);
  const shell = initialDraft(devServer);
  assert.equal(shell.mode, 'shell', 'a command that is not an agent is not rerun unless the user asks');
  assert.equal(shell.command, 'npm run dev', 'but it is ready to be chosen');
});

test('AC-1: row status reads exact, estimated, missing, shell and command', () => {
  assert.equal(rowStatus(claudeTab, initialDraft(claudeTab)), 'exact');
  assert.equal(rowStatus(codexGuess, initialDraft(codexGuess)), 'estimated');
  assert.equal(rowStatus(codexMissing, initialDraft(codexMissing)), 'missing');
  assert.equal(rowStatus(devServer, initialDraft(devServer)), 'shell');
  assert.equal(rowStatus(devServer, { ...initialDraft(devServer), mode: 'command' }), 'command');
  assert.equal(rowStatus(codexGuess, { ...initialDraft(codexGuess), sessionId: CODEX_ID, edited: true }), 'edited');
});

test('AC-3: a session id is checked against the agent\'s own shape', () => {
  assert.equal(isValidSessionId('claude', CLAUDE_ID), true);
  assert.equal(isValidSessionId('claude', 'my-named-session'), true, 'Claude also resumes by name');
  assert.equal(isValidSessionId('codex', 'my-named-session'), false);
  assert.equal(isValidSessionId('hermes', '20260928_101500_a1b2c3'), true);
  assert.equal(isValidSessionId('opencode', 'ses_0123456789abcdefghijklmnop'), true);
  assert.equal(isValidSessionId('opencode', 'ses_short'), false);
  const bad = { ...initialDraft(codexGuess), sessionId: 'not-a-uuid', edited: true };
  assert.equal(rowStatus(codexGuess, bad), 'invalid');
  assert.equal(needsReview(codexGuess, bad), true);
});

test('AC-4: the filters pick all, those to review, agents and shells', () => {
  const rows = [claudeTab, codexGuess, codexMissing, devServer].map((t) => ({ tab: t, draft: initialDraft(t) }));
  const count = (filter: 'all' | 'review' | 'agent' | 'shell') => rows.filter(({ tab: t, draft }) => rowMatchesFilter(filter, t, draft)).length;
  assert.equal(count('all'), 4);
  assert.equal(count('review'), 2);
  assert.equal(count('agent'), 3);
  assert.equal(count('shell'), 1);
});

test('AC-2: the preview is the line typed after the restart, or a shell only', () => {
  assert.deepEqual(restoreCommandPreview(initialDraft(claudeTab)), { text: `claudep --model opus --resume ${CLAUDE_ID}`, shellOnly: false });
  assert.deepEqual(restoreCommandPreview(initialDraft(codexGuess)), { text: `codex resume ${CODEX_ID}`, shellOnly: false });
  assert.equal(restoreCommandPreview(initialDraft(codexMissing)).shellOnly, true, 'no id means the shell only');
  assert.deepEqual(restoreCommandPreview({ ...initialDraft(devServer), mode: 'command' }), { text: 'npm run dev', shellOnly: false });
  assert.equal(restoreCommandPreview(initialDraft(devServer)).shellOnly, true);
  const opencode = { ...initialDraft(tab({ agent: 'opencode', launcher: 'opencode' })), sessionId: 'ses_0123456789abcdefghijklmnop' };
  assert.equal(restoreCommandPreview(opencode).text, 'opencode --session ses_0123456789abcdefghijklmnop');
});

test('arguments round-trip through the text field, quotes kept together', () => {
  assert.deepEqual(parseArgs('--model opus --append "two words" \'x y\''), ['--model', 'opus', '--append', 'two words', 'x y']);
  assert.deepEqual(parseArgs('   '), []);
  assert.equal(joinArgs(['--append', 'two words']), '--append "two words"');
});

test('FR-AITUI-013 AC-3: a draft becomes the item the server saves', () => {
  assert.deepEqual(toSaveItem(initialDraft(claudeTab)), {
    tabId: 't1', mode: 'agent', agent: 'claude', launcher: 'claudep', args: ['--model', 'opus'], sessionId: CLAUDE_ID,
  });
  assert.deepEqual(toSaveItem({ ...initialDraft(devServer), mode: 'command' }), { tabId: 't4', mode: 'command', command: 'npm run dev' });
  assert.deepEqual(toSaveItem(initialDraft(devServer)), { tabId: 't4', mode: 'shell' });
});

test('AC-2: the launcher list is each agent\'s registered commands', () => {
  assert.deepEqual(launcherOptions({ claude: ['claude', 'claude-code', 'claudep'], codex: ['codex', 'codexp'], hermes: ['hermes'], opencode: ['opencode'] }), [
    { agent: 'claude', launchers: ['claude', 'claude-code', 'claudep'] },
    { agent: 'codex', launchers: ['codex', 'codexp'] },
    { agent: 'hermes', launchers: ['hermes'] },
    { agent: 'opencode', launchers: ['opencode'] },
  ]);
});

test('AC-6: the restore report counts resumed, failed and shells, and hides itself only when nothing failed', () => {
  const item = (tabId: string, result: RestoreReportItem['result']): RestoreReportItem => ({
    tabId, workspaceName: 'w', tabName: tabId, mode: 'agent', agent: 'claude', cwd: '/w', commandLine: 'claude', result,
  });
  const report = [item('a', 'confirmed'), item('b', 'typed'), item('c', 'unconfirmed'), item('d', 'failed'), item('e', 'shell'), item('f', 'waiting')];
  assert.deepEqual(summarizeReport(report), { resumed: 2, failed: 2, shell: 1, waiting: 1 });
  assert.equal(reportAutoDismissMs(report), null);
  assert.equal(reportAutoDismissMs([item('a', 'confirmed'), item('e', 'shell')]), 5000);
  assert.equal(reportAutoDismissMs([item('a', 'waiting')]), null, 'not while still waiting');
  assert.equal(reportAutoDismissMs([]), null);
});

test('AC-6: a failed resume opens its editor on what was tried; only failures can be retried', async () => {
  const { draftFromReport, isRetryable } = await import('../../src/components/SessionSave/sessionSaveAllModel.ts');
  const failed: RestoreReportItem = {
    tabId: 't2', workspaceName: 'w', tabName: 'reviewer', mode: 'agent', agent: 'codex', cwd: '/w',
    commandLine: `codexp --full-auto resume ${CODEX_ID}`, launcher: 'codexp', args: ['--full-auto'], sessionId: CODEX_ID, result: 'unconfirmed',
  };
  const draft = draftFromReport(failed);
  assert.equal(draft.launcher, 'codexp');
  assert.equal(draft.argsText, '--full-auto');
  assert.equal(draft.sessionId, CODEX_ID);
  assert.equal(restoreCommandPreview(draft).text, failed.commandLine);
  assert.equal(isRetryable(failed), true);
  assert.equal(isRetryable({ ...failed, result: 'confirmed' }), false);
  assert.equal(draftFromReport({ ...failed, mode: 'command', agent: null, commandLine: 'npm run dev' }).command, 'npm run dev');
});

test('AC-2: the launcher a row already uses is always among the options, even before the registered list loads', () => {
  const options = launcherOptions({ claude: ['claude'], codex: ['codex'], hermes: ['hermes'], opencode: ['opencode'] }, { agent: 'codex', launcher: 'codexp' });
  assert.deepEqual(options.find((o) => o.agent === 'codex')?.launchers, ['codex', 'codexp']);
  assert.deepEqual(options.find((o) => o.agent === 'claude')?.launchers, ['claude']);
});

// FR-AITUI-015 AC-7 is superseded by FR-AITUI-018 AC-3 (2026-10-08): see sessionRestoreModel.test.ts.
