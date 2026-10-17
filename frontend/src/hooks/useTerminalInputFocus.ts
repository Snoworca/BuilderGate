// Whether the active tab's terminal input (xterm's helper textarea) has focus.
// On a phone that is when the system keyboard is up for the terminal, which is
// when the mobile key bar is shown.
import { useMemo, useSyncExternalStore } from 'react';

const HELPER_TEXTAREA = 'xterm-helper-textarea';
// Focus that moves onto the key bar itself (a browser that ignores the
// pointerdown preventDefault) must not hide the bar in the middle of a press.
const KEY_BAR = '.mobile-key-bar';

function isInsideKeyBar(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(KEY_BAR) !== null;
}

function isActiveTerminalInput(target: EventTarget | null, activeTabId: string | null): boolean {
  if (activeTabId === null || !(target instanceof Element)) return false;
  if (!target.classList.contains(HELPER_TEXTAREA)) return false;
  return target.closest('[data-tab-id]')?.getAttribute('data-tab-id') === activeTabId;
}

/**
 * enabled is isMobile: on a desktop no listener is attached, so desktop focus
 * changes never re-render the caller, and the result is always false.
 */
// @req FR-MKB-006
// @req FR-MKB-011
export function useTerminalInputFocus(activeTabId: string | null, enabled: boolean): boolean {
  // One small store per (activeTabId, enabled): it reads the focused element
  // once when first asked, then follows focusin/focusout. A disabled store
  // subscribes to nothing and always answers false.
  const store = useMemo(() => {
    const cell = { value: false, initialized: false };
    return {
      subscribe(onChange: () => void): () => void {
        if (!enabled) return () => {};
        const set = (next: boolean): void => {
          cell.initialized = true;
          if (next === cell.value) return;
          cell.value = next;
          onChange();
        };
        const onFocusIn = (event: FocusEvent): void => {
          if (isInsideKeyBar(event.target)) return;
          set(isActiveTerminalInput(event.target, activeTabId));
        };
        const onFocusOut = (event: FocusEvent): void => {
          if (isInsideKeyBar(event.relatedTarget)) return;
          set(isActiveTerminalInput(event.relatedTarget, activeTabId));
        };
        document.addEventListener('focusin', onFocusIn);
        document.addEventListener('focusout', onFocusOut);
        // A focus change between the first read and this subscription.
        if (!isInsideKeyBar(document.activeElement)) set(isActiveTerminalInput(document.activeElement, activeTabId));
        return () => {
          document.removeEventListener('focusin', onFocusIn);
          document.removeEventListener('focusout', onFocusOut);
        };
      },
      getSnapshot(): boolean {
        if (!enabled) return false;
        if (!cell.initialized) {
          cell.initialized = true;
          cell.value = isActiveTerminalInput(document.activeElement, activeTabId);
        }
        return cell.value;
      },
    };
  }, [activeTabId, enabled]);

  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => false);
}
