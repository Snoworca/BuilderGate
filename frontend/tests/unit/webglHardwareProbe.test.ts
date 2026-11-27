// PERF-BGSTAB-026: one probe per page decides whether WebGL is hardware accelerated.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebglHardwareProbe } from '../../src/utils/webglHardwareProbe.ts';

function fakeCanvasFactory(contextAvailable: boolean) {
  const calls: Array<{ type: string; attributes: unknown }> = [];
  let lost = 0;
  const createCanvas = () => ({
    getContext: (type: string, attributes?: unknown) => {
      calls.push({ type, attributes });
      if (!contextAvailable) return null;
      return { getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext: () => { lost += 1; } } : null) };
    },
  });
  return { createCanvas, calls, lost: () => lost };
}

test('PERF-BGSTAB-026 AC-3: asks for a context that refuses a major performance caveat, once', () => {
  const fake = fakeCanvasFactory(true);
  const probe = createWebglHardwareProbe(fake.createCanvas);
  assert.equal(probe(), true);
  assert.equal(probe(), true);
  assert.equal(fake.calls.length, 1, 'the answer is cached');
  assert.equal(fake.calls[0].type, 'webgl2');
  assert.deepEqual(fake.calls[0].attributes, { failIfMajorPerformanceCaveat: true });
  assert.equal(fake.lost(), 1, 'the probe context is released');
});

test('PERF-BGSTAB-026 AC-1: no context under that condition means no hardware acceleration', () => {
  const fake = fakeCanvasFactory(false);
  const probe = createWebglHardwareProbe(fake.createCanvas);
  assert.equal(probe(), false);
  assert.equal(probe(), false);
  assert.equal(fake.calls.length, 1);
});
