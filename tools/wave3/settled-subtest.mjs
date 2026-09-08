// A Node test can report timeout before its async body/finally settles.
// Fixture owners must wait for both; reporting failure is not cleanup completion.
export async function runSettledSubtest(context, name, options, body) {
  let bodySettlement;
  let result;
  const failures = [];
  try {
    result = await context.test(name, options, (...args) => {
      const pending = (async () => body(...args))();
      bodySettlement = pending.then(
        () => {},
        error => { if (!failures.includes(error)) failures.push(error); },
      );
      return pending;
    });
  } catch (error) {
    if (!failures.includes(error)) failures.push(error);
  }
  // A settled skipped/cancelled-before-start Node child cannot start later.
  if (bodySettlement) await bodySettlement;
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `Subtest and body failed: ${name}`);
  return result;
}
