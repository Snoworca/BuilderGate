function confirmedExit(actor) {
  const state = actor.exitState;
  return state !== null && typeof state === 'object'
    && ((Number.isInteger(state.code) && state.code >= 0 && state.signal === null)
      || (state.code === null && typeof state.signal === 'string' && state.signal.length > 0));
}

function report(failures) {
  const distinct = [...new Set(failures)];
  if (distinct.length === 1) throw distinct[0];
  if (distinct.length > 1) throw new AggregateError(distinct, 'Actor cleanup failed');
}

export async function settleActorCleanup(entries, release, priorFailure) {
  const failures = priorFailure === undefined ? [] : [priorFailure.error];
  const owned = new Map();
  for (const { actor, releaseByte } of entries) {
    if (actor !== undefined && (!owned.has(actor) || owned.get(actor) === undefined)) owned.set(actor, releaseByte);
  }
  for (const [actor, byte] of owned) {
    if (byte !== undefined && !actor.released && !confirmedExit(actor)) {
      try { release(actor, byte); } catch (error) { failures.push(error); }
    }
  }
  const outcomes = await Promise.allSettled([...owned.keys()].map(actor => actor.exited));
  for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
  for (const actor of owned.keys()) {
    if (!confirmedExit(actor)) failures.push(new Error(`Actor exit unconfirmed: ${actor.actor ?? 'unnamed'}`));
  }
  report(failures);
}

export async function cleanupExitedActors(actors, paths, cleanup, priorFailure) {
  const failures = priorFailure === undefined ? [] : [priorFailure.error];
  const unconfirmed = [...new Set(actors)].filter(actor => actor !== undefined && !confirmedExit(actor));
  if (unconfirmed.length > 0) {
    failures.push(new Error(`Actor exit unconfirmed; preserved paths: ${paths.join(', ')}`));
  } else {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  report(failures);
}
