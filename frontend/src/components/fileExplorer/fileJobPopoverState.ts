// Whether the file-job popover is open. Three places change it — the status
// bar toggles it, the explorer window's '외 N개' button opens it, a press
// outside closes it — and they sit in unrelated parts of the tree, so a
// component's useState could never be the one the others see. A module value
// read with useSyncExternalStore is shared by all of them, like fileJobStore.
// @req FR-FEX-008

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  // An unchanged value wakes nobody, so a repeated close on every outside press costs no render.
  if (next === open) return;
  open = next;
  for (const listener of [...listeners]) listener();
}

/** @req FR-FEX-008 */
export function isFileJobPopoverOpen(): boolean {
  return open;
}

/** @req FR-FEX-008 */
export function openFileJobPopover(): void {
  set(true);
}

/** @req FR-FEX-008 */
export function closeFileJobPopover(): void {
  set(false);
}

/** @req FR-FEX-008 */
export function toggleFileJobPopover(): void {
  set(!open);
}

/** @req FR-FEX-008 */
export function subscribeFileJobPopover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
