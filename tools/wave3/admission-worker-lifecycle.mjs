import path from 'node:path';
import { reportCleanupFailures } from './fixture-actor-cleanup.mjs';

export function describeWorkerFailure(error) {
  const description = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  if (!(error instanceof AggregateError)) return description;
  return [description, ...error.errors.map(describeWorkerFailure)].join('\n');
}

// PERF-BGSTAB-010: test-only observation; no Worker termination or path deletion.
export function waitForWorkerCondition(predicate, { timeoutMs, pollMs = 5, label = 'Worker condition' }) {
  return new Promise((resolve, reject) => {
    let deadline, poll, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (poll !== undefined) clearTimeout(poll);
      if (error) reject(error.error);
      else resolve();
    };
    const check = () => {
      poll = undefined;
      if (settled) return;
      try {
        if (predicate()) { finish(); return; }
      } catch (error) { finish({ error }); return; }
      poll = setTimeout(check, pollMs);
    };
    deadline = setTimeout(() => finish({ error: Error(`timed out waiting for ${label}`) }), timeoutMs);
    check();
  });
}

export function registerWorker(ownerSet, create, release) {
  const worker = create();
  let exited;
  const entry = { worker, release, exitCode: undefined, errors: [], released: false,
    exited: new Promise(resolve => { exited = resolve; }), ready: undefined, captured: undefined };
  worker.on('error', error => entry.errors.push(error));
  worker.once('exit', code => { entry.exitCode = code; exited(code); });
  ownerSet.add(entry);
  return entry;
}

export async function releaseAndAwaitWorkers(ownerSet, priorFailure) {
  const failures = priorFailure === undefined ? [] : [priorFailure.error];
  const entries = [...ownerSet];
  for (const entry of entries) {
    if (entry.released) continue;
    entry.released = true;
    try { entry.release(); } catch (error) { failures.push(error); }
  }
  await Promise.all(entries.map(async entry => {
    try { await entry.exited; } catch (error) { failures.push(error); }
    failures.push(...entry.errors);
    if (!Number.isInteger(entry.exitCode) || entry.exitCode < 0) failures.push(Error('Worker exit remains unconfirmed'));
    else if (entry.exitCode !== 0) failures.push(Error(`Worker exited with code ${entry.exitCode}`));
  }));
  reportCleanupFailures(failures, 'Worker release and exit cleanup failed');
}

export function recordWorkerPhase(entry, message, { index, analysisRoot, seenPaths }) {
  if (!message || typeof message !== 'object' || !Number.isInteger(index) || index < 0
    || message.index !== index || !['ready', 'captured'].includes(message.phase)
    || typeof message.manifestPath !== 'string') throw Error('Invalid Worker phase or index');
  const candidate = message.manifestPath;
  const normalized = path.win32.normalize(candidate);
  const parent = path.win32.resolve(analysisRoot);
  if (!path.win32.isAbsolute(candidate) || candidate.split(/[\\/]/).includes('..')
    || path.win32.dirname(normalized).toLowerCase() !== parent.toLowerCase()
    || !/^[A-Za-z0-9._-]+\.json$/.test(path.win32.basename(normalized))) throw Error('Worker manifest path escapes its direct analysis parent');
  const identity = normalized.toLowerCase();
  if (message.phase === 'ready') {
    if (entry.ready !== undefined || seenPaths.has(identity)) throw Error('Duplicate Worker ready phase or manifest path');
    seenPaths.add(identity);
    entry.ready = { ...message };
  } else {
    if (entry.ready === undefined || entry.captured !== undefined) throw Error('Worker captured phase is missing ready or duplicated');
    if (message.manifestPath !== entry.ready.manifestPath) throw Error('Worker captured path does not match ready path');
    entry.captured = { ...message };
  }
}
