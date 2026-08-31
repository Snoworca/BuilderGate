import {
  createTerminalRawMutationAdapter,
  digestTerminalBytes as digestRawTerminalBytes,
  type TerminalRawMutationAdapterOptions,
} from './terminalRawMutationAdapter.ts';
import type { TerminalWriteCoordinatorAdapter } from './terminalWriteCoordinator.ts';

export function digestTerminalBytes(bytes: Uint8Array): string {
  return digestRawTerminalBytes(bytes);
}

// This is the only production composition root allowed to depend on the raw
// xterm mutation adapter. Components consume the coordinator-owned interface.
// @req FR-BGSTAB-022 AC-2
export function createTerminalWriteCoordinatorAdapter(
  options: TerminalRawMutationAdapterOptions,
): TerminalWriteCoordinatorAdapter {
  return createTerminalRawMutationAdapter(options);
}
