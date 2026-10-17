// Whether the active tab's terminal input (xterm's helper textarea) has focus.
// On a phone that is when the system keyboard is up for the terminal, which is
// when the mobile key bar is shown.
import { useEffect, useState } from 'react';

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

// @req FR-MKB-006
export function useTerminalInputFocus(activeTabId: string | null): boolean {
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setFocused(isActiveTerminalInput(document.activeElement, activeTabId));
    const onFocusIn = (event: FocusEvent): void => {
      if (isInsideKeyBar(event.target)) return;
      setFocused(isActiveTerminalInput(event.target, activeTabId));
    };
    const onFocusOut = (event: FocusEvent): void => {
      if (isInsideKeyBar(event.relatedTarget)) return;
      setFocused(isActiveTerminalInput(event.relatedTarget, activeTabId));
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [activeTabId]);

  return focused;
}
