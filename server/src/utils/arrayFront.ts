// Removes entries from the front of a list without copying the rest of it.
//
// Array.splice(0, n) builds the removed part and then moves every remaining element down:
// measured 43 us for one entry off a list of 10,000. Array.shift() on a large array only moves
// the start of the array (0.08 us). For a few entries off a long list that difference is the
// whole cost; past the threshold one splice is a single move and is the cheaper one again.
// @req PERF-BGSTAB-032 AC-2

const SHIFT_AT_MOST = 64;

/** Removes up to `count` entries from the front of `items` and returns them, oldest first. */
export function takeFromFront<T>(items: T[], count: number): T[] {
  const take = Math.min(items.length, Math.max(0, Math.trunc(count)));
  if (take > SHIFT_AT_MOST) return items.splice(0, take);
  const taken: T[] = [];
  for (let index = 0; index < take; index += 1) taken.push(items.shift() as T);
  return taken;
}
