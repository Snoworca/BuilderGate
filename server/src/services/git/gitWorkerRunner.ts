/**
 * Starts git processes from a worker thread (PERF-GIT-001 AC-8).
 *
 * child_process.execFile creates the process synchronously on the calling thread. On Windows
 * that is CreateProcess plus the antivirus scan it triggers: measured 5-8 ms typically and up
 * to 312 ms, during which the event loop (terminal output, WebSocket traffic) stood still.
 * Several git processes at once put the event loop's p99 at 185 ms; from a worker it was 22 ms.
 *
 * The worker only spawns and collects output; parsing stays on the main thread. Its code is
 * passed as a string (eval) so it also runs from the single-file packaged executable.
 *
 * @req PERF-GIT-001
 */
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import type { RunGitFile, RunGitFileOptions } from './gitRunner.js';

const WORKER_SOURCE = `
const { parentPort, threadId } = require('node:worker_threads');
const { execFile } = require('node:child_process');
parentPort.on('message', (job) => {
  const reply = (error, stdout, stderr) => {
    const out = typeof stdout === 'string' ? stdout : Buffer.from(stdout ?? []);
    if (error) {
      parentPort.postMessage({
        id: job.id, threadId,
        error: { message: String(error.message), code: error.code, killed: !!error.killed, signal: error.signal ?? null,
          stderr: typeof stderr === 'string' ? stderr : Buffer.from(stderr ?? []).toString('utf8') },
      });
      return;
    }
    parentPort.postMessage({ id: job.id, threadId, stdout: out });
  };
  // execFile throws for arguments it refuses (a NUL byte): that fails this command only.
  try { execFile(job.file, job.args, job.options, reply); } catch (error) { reply(error, '', ''); }
});
`;

interface WorkerReply {
  id: number;
  threadId: number;
  stdout?: string | Uint8Array;
  error?: { message: string; code: unknown; killed: boolean; signal: string | null; stderr: string };
}

export type WorkerRunGitFile = ((...args: Parameters<RunGitFile>) => Promise<{ stdout: string | Buffer; threadId?: number }>) & {
  close(): void;
};

/** Runs on the calling thread: the fallback when a worker cannot be started. */
const inThread: RunGitFile = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error) { reject(Object.assign(error, { stderr })); return; }
    resolve({ stdout });
  });
});

function createSingleWorkerRun(): WorkerRunGitFile & { busy(): number } {
  let worker: Worker | null = null;
  let broken = false;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: { stdout: string | Buffer; threadId: number }) => void; reject: (e: unknown) => void; raw: boolean }>();

  const failAll = (reason: unknown) => {
    for (const job of pending.values()) job.reject(reason);
    pending.clear();
  };
  const start = (): Worker | null => {
    if (worker || broken) return worker;
    try {
      // execArgv: [] so the worker does not load the parent's loaders (tsx in tests): the code
      // is plain CommonJS, and an inherited loader can hold handles that keep the process alive.
      const w = new Worker(WORKER_SOURCE, { eval: true, execArgv: [] });
      worker = w;
      w.on('message', (reply: WorkerReply) => {
        const job = pending.get(reply.id);
        if (!job) return;
        pending.delete(reply.id);
        if (!pending.size) w.unref();
        if (reply.error) {
          job.reject(Object.assign(new Error(reply.error.message), reply.error));
          return;
        }
        const out = reply.stdout ?? '';
        job.resolve({ stdout: job.raw ? Buffer.from(out as Uint8Array) : String(out), threadId: reply.threadId });
      });
      // A worker that dies takes its jobs with it; the next call starts a new one.
      // Only while this is still the current worker: a late 'exit' of a replaced one must not
      // fail the new worker's jobs or drop the reference to it.
      w.on('error', (err) => { if (worker !== w) return; worker = null; failAll(err); });
      w.on('exit', () => { if (worker !== w) return; worker = null; if (pending.size) failAll(new Error('git worker exited')); });
      // Held only while a job is in flight, so an idle worker never keeps the process alive.
      w.unref();
    } catch {
      broken = true;
      worker = null;
    }
    return worker;
  };

  const run = ((file: string, args: readonly string[], options: RunGitFileOptions) => {
    const w = start();
    if (!w) return inThread(file, args, options);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, raw: options.encoding === 'buffer' });
      w.ref();
      w.postMessage({ id, file, args: [...args], options });
    });
  }) as WorkerRunGitFile & { busy(): number };
  run.close = () => {
    const w = worker;
    worker = null;
    failAll(new Error('git worker closed'));
    void w?.terminate();
  };
  run.busy = () => pending.size;
  return run;
}

/**
 * A small pool: one worker starts processes one after another (CreateProcess is synchronous on
 * that thread), so commands that may run at once (the runner allows 4) each get a worker. Each
 * command goes to the least busy one. Workers start only when first needed.
 */
export function createWorkerRunGitFile(size = 4): WorkerRunGitFile {
  const pool: Array<WorkerRunGitFile & { busy(): number }> = [];
  const run = ((file: string, args: readonly string[], options: RunGitFileOptions) => {
    let member = pool.find((m) => m.busy() === 0);
    if (!member && pool.length < size) { member = createSingleWorkerRun(); pool.push(member); }
    member ??= pool.reduce((a, b) => (b.busy() < a.busy() ? b : a));
    return member(file, args, options);
  }) as WorkerRunGitFile;
  run.close = () => { for (const m of pool.splice(0)) m.close(); };
  return run;
}
