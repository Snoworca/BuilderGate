// PERF-BGSTAB-027 AC-2: a throttled terminal still keeps up with its output. The real output
// scheduler runs behind the throttle with real timers; xterm's write callback is modelled as a
// 1 ms macrotask and an animation frame as 16 ms.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTerminalOutputScheduler } from '../../src/utils/terminalOutputScheduler.ts';
import { createTerminalRenderThrottle } from '../../src/utils/terminalRenderThrottle.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('PERF-BGSTAB-027 AC-2: a background terminal fed 60 messages a second does not fall behind', async () => {
  const throttle = createTerminalRenderThrottle({ requestFrame: (run) => { setTimeout(run, 16); } });
  const foreground = throttle.register('fg');
  foreground.setVisible(true);
  const background = throttle.register('bg');
  background.setVisible(true);
  throttle.noteFocus('fg');
  const scheduler = createTerminalOutputScheduler({
    visibleOutputQueueMaxBytes: 4_194_304,
    visibleOutputMaxChunks: 512,
    visibleFlushBudgetBytes: 262_144,
    visibleFlushFrameBudgetMs: 7,
    write: (_chunk, onWritten) => { setTimeout(onWritten, 1); },
    schedule: (drain) => background.schedule(drain),
  });
  let sent = 0;
  let written = 0;
  const feed = setInterval(() => { sent += 1; scheduler.enqueue('x'.repeat(200), () => { written += 1; }); }, 1000 / 60);
  await sleep(3000);
  clearInterval(feed);
  const backlogAtStop = sent - written;
  await sleep(600);
  background.dispose();
  foreground.dispose();
  assert.ok(backlogAtStop < 30, `backlog ${backlogAtStop} of ${sent} after 3 s`);
  assert.equal(sent - written, 0, 'everything is written once the input stops');
});
