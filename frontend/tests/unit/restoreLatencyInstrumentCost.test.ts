import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { fnv1a64, stableStringify } from '../../src/utils/terminalRetainedState';

/**
 * Issue #113. An instrument that is a material share of what it measures.
 *
 * `captureRetainedState` hashes the entire retained state with fnv1a64 over a
 * canonical JSON serialisation — two BigInt operations per byte — and the specs
 * timing restore latency polled it every 100-200ms across the reload. Measured
 * 2026-09-20, one build, one execution, two instruments and two sizes:
 *
 *   instrument   300 lines        700 lines        main-thread stall
 *   cheap        4219 / 4170ms    4228 / 4246ms    none (<=112ms)
 *   hashing      5410 / 8558ms    6940 / 6713ms    1090-2857ms
 *
 * A CPU profile of a 700-line reload put that hash and its stringifier at the
 * top of the whole page's self-time. Two consequences, both of which had been
 * published as facts about the product:
 *
 *   - the headline "6-9s" was the product plus the instrument, not the product;
 *   - the latency looked SIZE-DEPENDENT only because the hash cost grows with
 *     the buffer. With the cheap probe, 300 and 700 lines differ by 9ms.
 *
 * This file is the guard that keeps the fix from being undone. It has two parts,
 * and the split matters: the source guard is the one that survives, and the cost
 * measurement is what makes the source guard worth obeying.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Specs that TIME a restore. Their polling loop may not call the hashing
 * capture. Listed explicitly rather than globbed: a glob would quietly stop
 * covering a spec that was renamed, which is the failure mode issue #115 is
 * about.
 */
const LATENCY_MEASURING_SPECS = [
  'frontend/tests/e2e/retained-range-refresh-characterization.spec.ts',
  'frontend/tests/e2e/retained-history-select-copy.spec.ts',
] as const;

/**
 * Specs deliberately allowed to poll the expensive capture, with the reason.
 * An exclusion list that can grow silently is the same defect in a new place, so
 * each entry is checked below for still being true of the file.
 */
const EXCLUDED: ReadonlyMap<string, string> = new Map([
  [
    'frontend/tests/e2e/issue113-restore-latency-probe.spec.ts',
    'This probe exists to COMPARE the two instruments — that comparison is the '
      + 'measurement that produced the numbers in the note above — so it must keep a '
      + 'wait loop on each. It reports both timings side by side rather than one as '
      + 'the truth.',
  ],
]);

/** The helper each spec polls in, and the capture that must not appear in it. */
const EXPENSIVE_CAPTURE = 'captureRetainedState';
const CHEAP_CAPTURE = 'captureTerminalScrollbackProbe';

function read(relativePath: string): string {
  return readFileSync(`${REPO_ROOT}${relativePath}`, 'utf8');
}

/**
 * Strips line and block comments.
 *
 * Without this the guard reads its own prose as a call: the first version failed
 * on `retained-range-refresh-characterization.spec.ts` because the note
 * explaining why the poll must NOT call captureRetainedState contains the words
 * `captureRetainedState`. This repository has already recorded that exact
 * failure — a guard reading prose in a comment as a call — and it came back the
 * moment a new guard was written. A scan for a call must look at code.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The body of a top-level `async function <name>(` up to the closing brace at column 0. */
function functionBody(source: string, name: string): string | null {
  const start = source.indexOf(`async function ${name}(`);
  if (start === -1) return null;
  const end = source.indexOf('\n}\n', start);
  return stripComments(end === -1 ? source.slice(start) : source.slice(start, end));
}

test('#113 the instrument exclusion list has no stale entries', () => {
  for (const [spec, reason] of EXCLUDED) {
    assert.ok(reason.trim().length > 0, `EXCLUDED entry ${spec} has no reason`);
    const source = read(spec);
    // Word-boundary match, not `includes`. Measured while mutation-testing this
    // guard: renaming the capture to `captureRetainedStateXX` left `includes`
    // satisfied, so the mutation that should have reddened this clause passed.
    const mentions = (token: string): boolean => new RegExp(`\\b${token}\\b`).test(source);
    assert.ok(
      mentions(EXPENSIVE_CAPTURE) && mentions(CHEAP_CAPTURE),
      `${spec} is excluded on the grounds that it compares both instruments, and it no longer `
        + 'mentions both. Either it stopped comparing — drop the exclusion and hold it to the '
        + 'rule — or the captures were renamed and this guard is reading for the wrong thing.',
    );
    assert.ok(
      !(LATENCY_MEASURING_SPECS as readonly string[]).includes(spec),
      `${spec} is both excluded and listed; drop one of the two`,
    );
  }
});

test('#113 the restore-latency wait loops poll the cheap capture, not the hashing one', () => {
  for (const spec of LATENCY_MEASURING_SPECS) {
    const source = read(spec);
    const waiters = [...source.matchAll(/async function (waitForRestored\w*)\(/g)]
      .map(match => match[1]);

    assert.ok(
      waiters.length > 0,
      `${spec} has no waitForRestored* helper, so this guard is covering nothing. Either the `
        + 'helper was renamed — update this list — or the spec stopped timing a restore and '
        + 'should come off it.',
    );

    for (const waiter of waiters) {
      const body = functionBody(source, waiter);
      assert.ok(body, `${spec}: could not read the body of ${waiter}`);
      assert.ok(
        !body.includes(EXPENSIVE_CAPTURE),
        `${spec}: ${waiter} polls ${EXPENSIVE_CAPTURE}, which hashes the whole retained state `
          + 'with two BigInt operations per byte. Measured, that made the reported latency 1.1-2.9s '
          + 'too high and made it look size-dependent when it is not. Poll '
          + `${CHEAP_CAPTURE} instead; the hashing capture is fine once, after the wait.`,
      );
      assert.ok(
        body.includes(CHEAP_CAPTURE),
        `${spec}: ${waiter} polls neither capture this guard knows about. If a third instrument `
          + 'was introduced, measure its cost before putting it in a loop that reports latency.',
      );
    }
  }
});

test('#113 the expensive capture really is expensive, and the guard above is not superstition', () => {
  // A source guard that forbids a call is worth obeying only while the reason
  // holds. This measures the reason, so the day fnv1a64 stops costing what it
  // costs, this test says so instead of the rule outliving its cause.
  //
  // Shape, not absolute time: CI machines vary, so the assertion is a RATIO
  // against a trivial baseline on the same machine in the same process.
  const line = 'RETAINED-123456 some ordinary terminal output line';
  const lines = Array.from({ length: 700 }, (_, index) => ({
    index,
    isWrapped: false,
    text: `${line}-${index}`,
  }));

  const cheapStart = process.hrtime.bigint();
  let cheapSink = 0;
  for (let round = 0; round < 700; round += 1) {
    // What the cheap probe does per poll: read one line's text and compare it.
    cheapSink += lines[round].text.trim() === 'RETAINED-1' ? 1 : 0;
  }
  const cheapNs = Number(process.hrtime.bigint() - cheapStart);

  const hashStart = process.hrtime.bigint();
  let hashSink = 0;
  for (const entry of lines) {
    hashSink += fnv1a64(stableStringify({ isWrapped: entry.isWrapped, text: entry.text })).length;
  }
  const hashNs = Number(process.hrtime.bigint() - hashStart);

  assert.ok(cheapSink >= 0 && hashSink > 0, 'both loops must actually have run');
  const ratio = hashNs / Math.max(cheapNs, 1);
  // eslint-disable-next-line no-console
  console.log(`[#113] per-poll cost over 700 lines: cheap=${Math.round(cheapNs / 1000)}us `
    + `hashing=${Math.round(hashNs / 1000)}us ratio=${ratio.toFixed(1)}x`);

  assert.ok(
    ratio > 20,
    'the hashing capture is no longer dramatically more expensive than reading a line, so the '
      + `source guard above has outlived its reason and should be re-derived. ratio=${ratio.toFixed(1)}x`,
  );
});
