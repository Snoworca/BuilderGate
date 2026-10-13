import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createCachedFairDeliveryCandidateArtifactValidator,
  fingerprintFairSchedulerAuthority,
} from './TerminalResourcePolicyCanary.js';

/**
 * PERF-BGSTAB-010 AC-3. The published-artifact validation walks and hashes the whole evidence
 * generation. It ran on every `terminal-delivery:capability`, i.e. once per page load, and it is
 * synchronous: measured 2026-10-14 at ~150 ms on Windows and ~3.8 s on WSL over /mnt/c, during
 * which the server sent nothing to anyone. Restore of the visible terminal waited behind it, and
 * input typed in that window expired from the 1.5 s queue.
 *
 * The cache keeps AC-3: any change to the pointer or to a file of the current generation changes
 * the fingerprint, and the next call validates from disk again.
 */

function counting(result: { accepted: boolean; reason: string }) {
  const calls: Array<{ runtimePolicy?: unknown } | undefined> = [];
  const validate = (input?: { runtimePolicy?: unknown }) => {
    calls.push(input);
    return result;
  };
  return { validate, calls };
}

const ACCEPTED = { accepted: true, reason: 'decision-artifact-verified' };

test('an unchanged authority is validated once for the same runtime policy', () => {
  const inner = counting(ACCEPTED);
  const cached = createCachedFairDeliveryCandidateArtifactValidator(inner.validate, () => 'fp-1');

  assert.deepEqual(cached({ runtimePolicy: { a: 1 } }), ACCEPTED);
  assert.deepEqual(cached({ runtimePolicy: { a: 1 } }), ACCEPTED);
  assert.deepEqual(cached({ runtimePolicy: { a: 1 } }), ACCEPTED);

  assert.equal(inner.calls.length, 1);
});

test('a changed fingerprint validates from disk again', () => {
  const inner = counting(ACCEPTED);
  let fingerprint = 'fp-1';
  const cached = createCachedFairDeliveryCandidateArtifactValidator(inner.validate, () => fingerprint);

  cached({ runtimePolicy: { a: 1 } });
  fingerprint = 'fp-2';
  cached({ runtimePolicy: { a: 1 } });

  assert.equal(inner.calls.length, 2);
});

test('a different runtime policy is validated on its own', () => {
  const inner = counting(ACCEPTED);
  const cached = createCachedFairDeliveryCandidateArtifactValidator(inner.validate, () => 'fp-1');

  cached({ runtimePolicy: { a: 1 } });
  cached({ runtimePolicy: { a: 2 } });
  cached();

  assert.equal(inner.calls.length, 3);
});

test('a rejection is never cached', () => {
  const inner = counting({ accepted: false, reason: 'decision-artifact-digest-mismatch' });
  const cached = createCachedFairDeliveryCandidateArtifactValidator(inner.validate, () => 'fp-1');

  assert.equal(cached({ runtimePolicy: { a: 1 } }).accepted, false);
  assert.equal(cached({ runtimePolicy: { a: 1 } }).accepted, false);

  assert.equal(inner.calls.length, 2);
});

test('an authority that cannot be fingerprinted is validated every time', () => {
  const inner = counting(ACCEPTED);
  const cached = createCachedFairDeliveryCandidateArtifactValidator(inner.validate, () => undefined);

  cached({ runtimePolicy: { a: 1 } });
  cached({ runtimePolicy: { a: 1 } });

  assert.equal(inner.calls.length, 2);
});

function authorityFixture() {
  const authorityRoot = mkdtempSync(join(tmpdir(), 'bg-authority-fp-'));
  const generationId = 'a'.repeat(64);
  const generationRoot = join(authorityRoot, 'generations', generationId);
  mkdirSync(join(generationRoot, 'raw'), { recursive: true });
  const locatorPath = join(authorityRoot, 'current.json');
  writeFileSync(locatorPath, JSON.stringify({ generation_id: generationId }));
  writeFileSync(join(generationRoot, 'fair-scheduler-decision.json'), '{"x":1}');
  writeFileSync(join(generationRoot, 'raw', 'trial-1.json'), '{"y":1}');
  return { authorityRoot, locatorPath, generationRoot };
}

test('the fingerprint is stable while nothing changes', () => {
  const f = authorityFixture();
  try {
    const first = fingerprintFairSchedulerAuthority(f);
    assert.equal(typeof first, 'string');
    assert.equal(fingerprintFairSchedulerAuthority(f), first);
  } finally {
    rmSync(f.authorityRoot, { recursive: true, force: true });
  }
});

test('editing a file of the current generation changes the fingerprint', () => {
  const f = authorityFixture();
  try {
    const before = fingerprintFairSchedulerAuthority(f);
    writeFileSync(join(f.generationRoot, 'raw', 'trial-1.json'), '{"y":2, "tampered": true}');
    assert.notEqual(fingerprintFairSchedulerAuthority(f), before);
  } finally {
    rmSync(f.authorityRoot, { recursive: true, force: true });
  }
});

test('adding a file to the current generation changes the fingerprint', () => {
  const f = authorityFixture();
  try {
    const before = fingerprintFairSchedulerAuthority(f);
    writeFileSync(join(f.generationRoot, 'raw', 'extra.json'), '{}');
    assert.notEqual(fingerprintFairSchedulerAuthority(f), before);
  } finally {
    rmSync(f.authorityRoot, { recursive: true, force: true });
  }
});

test('repointing the locator changes the fingerprint', () => {
  const f = authorityFixture();
  try {
    const before = fingerprintFairSchedulerAuthority(f);
    writeFileSync(f.locatorPath, JSON.stringify({ generation_id: 'b'.repeat(64) }));
    assert.notEqual(fingerprintFairSchedulerAuthority(f), before);
  } finally {
    rmSync(f.authorityRoot, { recursive: true, force: true });
  }
});

test('replacing a file with a link changes the fingerprint', (t) => {
  const f = authorityFixture();
  try {
    const before = fingerprintFairSchedulerAuthority(f);
    const target = join(f.generationRoot, 'raw', 'trial-1.json');
    const elsewhere = join(f.authorityRoot, 'outside.json');
    writeFileSync(elsewhere, '{"y":1}');
    unlinkSync(target);
    try {
      symlinkSync(elsewhere, target);
    } catch {
      t.skip('symbolic links are not permitted here');
      return;
    }
    assert.notEqual(fingerprintFairSchedulerAuthority(f), before);
  } finally {
    rmSync(f.authorityRoot, { recursive: true, force: true });
  }
});

test('a missing locator cannot be fingerprinted', () => {
  const f = authorityFixture();
  try {
    unlinkSync(f.locatorPath);
    assert.equal(fingerprintFairSchedulerAuthority(f), undefined);
  } finally {
    rmSync(f.authorityRoot, { recursive: true, force: true });
  }
});
