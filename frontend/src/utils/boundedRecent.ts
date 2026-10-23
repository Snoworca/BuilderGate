/** Adds an id to a set that keeps only the newest `limit` ids (insertion order). REL-BGSTAB-052. */
export function rememberRecent<T>(seen: Set<T>, id: T, limit: number): void {
  seen.delete(id);
  seen.add(id);
  while (seen.size > limit) seen.delete(seen.values().next().value as T);
}
