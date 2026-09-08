import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// PERF-BGSTAB-010 / SDS-AC-4: observe completion without signalling the child.
export function observeProcessUntilClose(executable, args, { cwd, env, deadlineMs, onDeadline }) {
  return new Promise(resolve => {
    const result = {
      code: null, signal: null, elapsedMs: 0, deadlineExceeded: false,
      stdout: '', stderr: '', spawnError: null, observationErrors: [],
    };
    let started, timer, closed = false, remainingStreams = 2;

    function recordDeadline() {
      if (result.deadlineExceeded) return;
      result.deadlineExceeded = true;
      try { onDeadline?.(); }
      catch (error) { result.observationErrors.push(error); }
    }

    function checkDeadline() {
      timer = undefined;
      if (closed) return;
      const remaining = deadlineMs - (performance.now() - started);
      if (remaining <= 0) recordDeadline();
      else timer = setTimeout(checkDeadline, Math.ceil(remaining));
    }

    function finish() {
      if (closed && remainingStreams === 0) resolve(result);
    }

    function collect(stream, key) {
      let finished = false;
      stream.setEncoding('utf8');
      stream.on('data', text => { result[key] += text; });
      stream.on('error', error => { result.observationErrors.push(error); });
      function finishStream() {
        if (finished) return;
        finished = true;
        remainingStreams--;
        finish();
      }
      let ended = false;
      stream.once('end', () => {
        ended = true;
        finishStream();
      });
      stream.once('close', () => {
        if (!ended) result.observationErrors.push(new Error(`${key} closed prematurely before end`));
        finishStream();
      });
    }

    let child;
    started = performance.now();
    try {
      child = spawn(executable, args, {
        cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      result.spawnError = error;
      result.elapsedMs = performance.now() - started;
      if (result.elapsedMs >= deadlineMs) recordDeadline();
      resolve(result);
      return;
    }

    collect(child.stdout, 'stdout');
    collect(child.stderr, 'stderr');
    child.on('error', error => {
      if (result.spawnError === null) result.spawnError = error;
      else result.observationErrors.push(error);
    });
    child.once('close', (code, signal) => {
      closed = true;
      result.code = code;
      result.signal = signal;
      result.elapsedMs = performance.now() - started;
      if (timer !== undefined) clearTimeout(timer);
      if (result.elapsedMs >= deadlineMs) recordDeadline();
      finish();
    });
    checkDeadline();
  });
}
