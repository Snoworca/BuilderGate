// The accessory key bar shown above the system keyboard (or above the special
// keyboard panel) while a terminal is in use on a phone. Keys act on pointerup
// so a horizontal drag can scroll the bar without sending anything, and every
// press keeps the terminal textarea focused unless the special keyboard panel
// is open, when the terminal is meant to stay blurred.
import { useCallback } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import { t } from '../../i18n/i18n.ts';
import type { MobileKeyName } from '../../utils/mobileKeyEncoder.ts';
import { LatchKey } from './LatchKey.tsx';
import { MOBILE_BAR_KEYS, useTapPress } from './mobileKeyboardModel.ts';
import './mobileKeyboard.css';

const KEYBOARD_GLYPH = '⌨';

export interface MobileKeyBarProps {
  onSendKey: (key: MobileKeyName) => void;
  onToggleKeyboard: () => void;
  /** The special keyboard panel is open: the switch offers the way back (ABC). */
  keyboardOpen: boolean;
  /**
   * Called after a press that left focus on the bar (a browser that ignores the
   * pointerdown preventDefault), so the owner can focus the terminal again and
   * the system keyboard stays up. Applies to every button, Ctrl/Alt included.
   * Not called while the panel is open: the terminal must stay blurred then.
   */
  onRestoreFocus?: () => void;
}

// @req FR-MKB-006
// @req FR-MKB-008
export function MobileKeyBar({ onSendKey, onToggleKeyboard, keyboardOpen, onRestoreFocus }: MobileKeyBarProps): ReactElement {
  const onTap = useCallback((element: Element): void => {
    if (element.getAttribute('data-mobile-action') === 'toggle-keyboard') {
      onToggleKeyboard();
      return;
    }
    const key = element.getAttribute('data-mobile-key');
    if (key) onSendKey(key as MobileKeyName);
  }, [onSendKey, onToggleKeyboard]);
  const press = useTapPress<HTMLDivElement>(onTap);
  const pressUp = press.onPointerUp;

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const bar = event.currentTarget;
    pressUp(event);
    if (keyboardOpen || !onRestoreFocus) return;
    // LatchKey handles its own press before this bubbles here; any button that
    // took focus (Ctrl, Alt, the switch, a plain key) hands it back.
    const focused = bar.ownerDocument.activeElement;
    if (focused !== null && bar.contains(focused)) onRestoreFocus();
  }, [pressUp, keyboardOpen, onRestoreFocus]);

  const toggleAria = t(keyboardOpen ? 'mobileKeyboard.switch.toSystem' : 'mobileKeyboard.switch.toSpecial');
  const toggleText = t(keyboardOpen ? 'mobileKeyboard.switch.systemLabel' : 'mobileKeyboard.switch.specialLabel');

  return (
    <div
      className="mobile-key-bar"
      role="toolbar"
      aria-label={t('mobileKeyboard.bar')}
      style={{ touchAction: 'pan-x' }}
      onPointerDown={press.onPointerDown}
      onPointerMove={press.onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={press.onPointerCancel}
      onMouseDown={press.onMouseDown}
      onContextMenu={press.onContextMenu}
    >
      {MOBILE_BAR_KEYS.map((entry, index) => {
        if (entry.kind === 'sep') {
          return <span key={`sep-${index}`} className="mobile-key-bar__sep" data-mobile-sep="" aria-hidden="true" />;
        }
        const aria = t(entry.ariaKey);
        if (entry.kind === 'mod') {
          return <LatchKey key={entry.mod} mod={entry.mod} label={entry.label} ariaLabel={aria} />;
        }
        return (
          <button
            key={entry.key}
            type="button"
            className={entry.arrow ? 'mobile-key mobile-key--arrow' : 'mobile-key'}
            data-mobile-key={entry.key}
            aria-label={aria}
            title={aria}
          >
            <span className="mobile-key__label">{entry.label}</span>
          </button>
        );
      })}
      <button
        type="button"
        className="mobile-key mobile-key--toggle"
        data-mobile-action="toggle-keyboard"
        aria-label={toggleAria}
        title={toggleAria}
        aria-pressed={keyboardOpen}
      >
        <span className="mobile-key__label">{`${KEYBOARD_GLYPH} ${toggleText}`}</span>
      </button>
    </div>
  );
}
