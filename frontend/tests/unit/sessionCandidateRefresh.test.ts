import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { aiTabSignature } from '../../src/components/SessionSave/sessionSnapshotModel.ts';

// FR-AITUI-009 AC-6 — a tab that becomes an AI tab shows up on the save button
// at once, not on the next 15 s poll (a disabled button cannot be clicked, so
// the refresh on click never ran).

test('FR-AITUI-009 AC-6: the signature changes only when a tab gains or loses its AI command', () => {
  const plain = [{ id: 't1' }, { id: 't2', recoveryCommand: undefined }];
  const same = [{ id: 't1', name: 'renamed' }, { id: 't2' }];
  const ai = [{ id: 't1' }, { id: 't2', recoveryCommand: 'claude' }];
  assert.equal(aiTabSignature(plain), aiTabSignature(same), 'other tab changes do not trigger a refresh');
  assert.notEqual(aiTabSignature(plain), aiTabSignature(ai));
  assert.notEqual(aiTabSignature(ai), aiTabSignature([{ id: 't1' }]), 'a closed AI tab changes it too');
});

test('FR-AITUI-009 AC-6: App reads the candidates again when the signature changes', () => {
  const app = readFileSync(new URL('../../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /aiTabSignature\(wm\.tabs\)/);
  assert.match(app, /useEffect\(\(\) => \{\s*void refreshSessionCandidates\(\);\s*\}, \[sessionAiTabs, refreshSessionCandidates\]\)/);
});
