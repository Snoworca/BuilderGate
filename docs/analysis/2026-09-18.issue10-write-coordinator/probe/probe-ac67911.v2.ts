// Issue #10: personal re-verification of the AC-6 / AC-7 / AC-11 claims that came
// from delegated measurement, before any of them becomes an SRS criterion.
// Every arm carries its own control. Options mirror the committed
// BOUNDED_COORDINATOR_LIMITS fixture (terminalWriteCoordinator.test.ts:113);
// omitting settlementLedger* defaults them to 0 and poisons the arm (probe v1 bug).
import { createTerminalWriteCoordinator } from '/mnt/c/work/git/_Snoworca/ProjectMaster-issue2-20260916/frontend/src/utils/terminalWriteCoordinator.ts';

const L = {
  postCheckpointMaxBytes: 1024 * 1024, postCheckpointMaxChunks: 1024,
  pendingInputMaxBytes: 1024 * 1024, pendingInputMaxCount: 1024, pendingInputTtlMs: 60_000,
  settlementLedgerMaxEntries: 1024, settlementLedgerTtlMs: 60_000,
  checkpointMaxBytes: 1024 * 1024, checkpointMaxChunks: 1024,
};
const enc = new TextEncoder();
function rec() {
  const events: string[] = [], recoveries: string[] = [], settlements: any[] = [];
  const writes: Array<() => void> = [];
  let timers = 0, cleared = 0;
  return { events, recoveries, settlements, writes,
    get timers() { return timers; }, get cleared() { return cleared; },
    setTimer: (cb: () => void, _d: number) => { timers += 1; return { cb }; },
    clearTimer: (_h: unknown) => { cleared += 1; },
    adapter: {
      write: (c: any, onWritten: () => void) => { events.push(c.kind); writes.push(onWritten); },
      resetParser: () => { events.push('reset'); }, resize: () => {}, applyModes: () => {},
      clearScreen: () => {}, fit: () => ({ cols: 80, rows: 24 }), setWindowsPty: () => {},
      markReady: () => {}, releaseInput: () => {}, settleInput: (t: string, o: string) => { settlements.push({ t, o, lane: 'input' }); },
      requestFreshRecovery: (r: string) => { recoveries.push(r); },
      requestRuntimeRecreation: () => {}, compatibilityRecoveryDrained: () => {},
      checkpointApplied: () => {}, checkpointDrained: () => {},
      settle: (t: string, o: string) => { settlements.push({ t, o, lane: 'write' }); },
    } };
}
const mk = (h: any) => createTerminalWriteCoordinator({
  viewGeneration: 7, adapter: h.adapter, digestBytes: () => 'd'.repeat(16),
  setTimer: h.setTimer, clearTimer: h.clearTimer, ...L } as any);
const begin = (o: any = {}) => ({
  type: 'checkpoint-begin', streamEpoch: '1', checkpointEpoch: '1', sourceSeq: '10',
  snapshotSeq: '10', oldestRetainedSeq: '1', retentionPolicyId: 'p1', viewGeneration: 7,
  chunkCount: 1, encodedByteTotal: 8, digest: 'd'.repeat(16), cols: 80, rows: 24,
  modes: {}, parserTail: new Uint8Array(0), ...o });
const live = (o: any) => ({ type: 'live', streamEpoch: '1', viewGeneration: 7,
  data: enc.encode('x'), settlementToken: 'tok-' + Math.random(), ...o });
const out: string[] = [];
const say = (s: string) => { out.push(s); console.log(s); };

// ---- AC-6(i): older streamEpoch live frame ----
{
  const h = rec(); const c = mk(h);
  c.dispatch(begin({ chunkCount: 1 }) as any);
  c.dispatch({ ...begin(), type: 'checkpoint-chunk', index: 0, count: 1, data: enc.encode('snapshot') } as any);
  c.dispatch({ ...begin(), type: 'checkpoint-commit' } as any);
  const ctl = c.dispatch(live({ streamEpoch: '1', sourceSeq: '11' }) as any);   // control: same epoch
  const sub = c.dispatch(live({ streamEpoch: '0', sourceSeq: '12' }) as any);   // subject: OLDER epoch
  say('AC-6(i)  control same-epoch=' + JSON.stringify(ctl) + '  subject older-epoch=' + JSON.stringify(sub));
  say('AC-6(i)  DISCARDED_NOT_APPLIED=' + (sub.accepted === false) + '  reason=' + sub.reason);
}
// ---- AC-6(ii): sourceSeq exactly == snapshotSeq during an open checkpoint ----
{
  const h = rec(); const c = mk(h);
  c.dispatch(begin() as any);
  const at = c.dispatch(live({ sourceSeq: '10' }) as any);   // == snapshotSeq: must not apply
  say('AC-6(ii) sourceSeq==snapshotSeq -> ' + JSON.stringify(at));
  say('AC-6(ii) recoveries=' + JSON.stringify(h.recoveries) + '  writes-to-terminal=' + JSON.stringify(h.events));
  say('AC-6(ii) IS_DISCARD(no recovery)=' + (h.recoveries.length === 0)
    + '  IS_TRANSACTION_FAILURE=' + (h.recoveries.length > 0));
}
// ---- AC-7: second checkpoint-begin while one is open ----
{
  const h = rec(); const c = mk(h);
  const b1 = c.dispatch(begin({ checkpointEpoch: '1' }) as any);
  const b2 = c.dispatch(begin({ checkpointEpoch: '2', snapshotSeq: '20', sourceSeq: '20' }) as any);
  say('AC-7    first=' + JSON.stringify(b1) + ' nested=' + JSON.stringify(b2));
  say('AC-7    recoveries=' + JSON.stringify(h.recoveries) + ' terminalEvents=' + JSON.stringify(h.events));
  say('AC-7    COALESCED=' + (b2.accepted === true) + '  BOTH_DESTROYED=' + (b2.accepted === false && h.recoveries.length > 0));
}
// ---- AC-11: dispose WITH a queued entry and an in-flight write ----
{
  const h = rec(); const c = mk(h);
  c.dispatch(live({ sourceSeq: '1', settlementToken: 'in-flight' }) as any);  // goes in flight
  c.dispatch(live({ sourceSeq: '2', settlementToken: 'queued-1' }) as any);   // queued behind it
  c.dispatch(live({ sourceSeq: '3', settlementToken: 'queued-2' }) as any);
  const before = c.getState();
  say('AC-11   before dispose: pendingCommands=' + before.pendingCommands + ' writeInFlight=' + before.writeInFlight
    + ' timersCreated=' + h.timers + ' timersCleared=' + h.cleared);
  const d = c.dispatch({ type: 'dispose', viewGeneration: 7 } as any);
  const after = c.getState();
  say('AC-11   dispose=' + JSON.stringify(d) + ' after: pendingCommands=' + after.pendingCommands
    + ' disposed=' + after.disposed + ' timersCleared=' + h.cleared);
  say('AC-11   settlements=' + JSON.stringify(h.settlements));
  const toks = h.settlements.filter((s: any) => s.lane === 'write').map((s: any) => s.t);
  say('AC-11(i)   QUEUED_SETTLED=' + (toks.includes('queued-1') && toks.includes('queued-2')));
  say('AC-11(iii) IN_FLIGHT_SETTLED=' + toks.includes('in-flight'));
  // (iv) late callback after dispose must be a no-op
  const n = h.settlements.length;
  h.writes.shift()?.();
  say('AC-11(iv)  late callback after dispose added ' + (h.settlements.length - n) + ' settlements (0 = no-op)');
}
