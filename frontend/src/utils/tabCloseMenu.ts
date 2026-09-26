// The tab context menu shared by the editor window and the file explorer
// window: 이 탭 닫기 · 다른 탭 닫기 · 모든 탭 닫기.
// @req FR-MDE-021
// @req FR-FEX-012
import type { ContextMenuItem } from '../components/ContextMenu/index.ts';

export interface TabCloseMenuOptions {
  /** How many tabs the window holds; with one there is no "other" tab. */
  tabCount: number;
  onCloseThis: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
}

export function buildTabCloseMenuItems(options: TabCloseMenuOptions): ContextMenuItem[] {
  return [
    { label: '이 탭 닫기', onClick: options.onCloseThis },
    { label: '다른 탭 닫기', onClick: options.onCloseOthers, disabled: options.tabCount <= 1 },
    { separator: true },
    { label: '모든 탭 닫기', onClick: options.onCloseAll },
  ];
}

export interface BulkTabClosePlan {
  /** Every tab to close, in tab order. */
  targets: string[];
  /** Targets with unsaved changes -- these need a question first. */
  dirty: string[];
  clean: string[];
}

/** The tabs a "close others" (keepId given) or "close all" (keepId null) acts on. */
export function planBulkTabClose(
  tabs: readonly { id: string; dirty: boolean }[],
  keepId: string | null,
): BulkTabClosePlan {
  const targets = tabs.filter(tab => tab.id !== keepId);
  return {
    targets: targets.map(tab => tab.id),
    dirty: targets.filter(tab => tab.dirty).map(tab => tab.id),
    clean: targets.filter(tab => !tab.dirty).map(tab => tab.id),
  };
}
