// The special keyboard panel that takes the system keyboard's place under the
// key bar: Esc/Tab/Ctrl/Alt/Shift on top, then the F-key block, the editing and
// symbol block, and a right block that is either the arrows or a number pad.
// Design: docs/design/mobile-terminal-keyboard.html screens 2 and 3.
import { useCallback, useState } from 'react';
import type { ReactElement } from 'react';
import { t } from '../../i18n/i18n.ts';
import type { MobileKeyName } from '../../utils/mobileKeyEncoder.ts';
import { LatchKey } from './LatchKey.tsx';
import {
  SPECIAL_ARROW_BLOCK,
  SPECIAL_LEFT_BLOCK,
  SPECIAL_MIDDLE_BLOCK,
  SPECIAL_NUMPAD_BLOCK,
  SPECIAL_TOP_ROW,
  readRightBlock,
  useTapPress,
  writeRightBlock,
  type RightBlock,
  type SpecialKeyEntry,
} from './mobileKeyboardModel.ts';
import './mobileKeyboard.css';

export interface MobileSpecialKeyboardProps {
  height: number;
  onSendKey: (key: MobileKeyName | string) => void;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function renderEntry(entry: SpecialKeyEntry, slot: string): ReactElement {
  if (entry.kind === 'blank') {
    return <span key={slot} className="mobile-special-key mobile-special-key--blank" data-special-blank="" aria-hidden="true" />;
  }
  if (entry.kind === 'mod') {
    return <LatchKey key={slot} mod={entry.mod} label={entry.label} ariaLabel={t(entry.ariaKey)} className="mobile-special-key" />;
  }
  if (entry.kind === 'switch') {
    const aria = t(entry.ariaKey);
    return (
      <button
        key={slot}
        type="button"
        className="mobile-special-key mobile-special-key--switch"
        data-mobile-action="switch-block"
        data-special-switch={entry.to}
        aria-label={aria}
        title={aria}
      >
        <span className="mobile-key__label">{t(entry.labelKey)}</span>
      </button>
    );
  }
  const aria = t(entry.ariaKey, entry.ariaParams);
  const classes = ['mobile-special-key'];
  if (entry.variant) classes.push(`mobile-special-key--${entry.variant}`);
  return (
    <button
      key={slot}
      type="button"
      className={classes.join(' ')}
      data-mobile-key={entry.key}
      aria-label={aria}
      title={aria}
    >
      <span className="mobile-key__label">{entry.label}</span>
    </button>
  );
}

function renderBlock(name: string, rows: readonly (readonly SpecialKeyEntry[])[]): ReactElement {
  return (
    <div className={`mobile-special-keyboard__block mobile-special-keyboard__block--${name}`} data-special-block={name}>
      {rows.flatMap((row, r) => row.map((entry, c) => renderEntry(entry, `${name}-${r}-${c}`)))}
    </div>
  );
}

// @req FR-MKB-009
// @req FR-MKB-010
export function MobileSpecialKeyboard({ height, onSendKey }: MobileSpecialKeyboardProps): ReactElement {
  const [rightBlock, setRightBlock] = useState<RightBlock>(() => readRightBlock(browserStorage()));

  const onTap = useCallback((element: Element): void => {
    const to = element.getAttribute('data-special-switch');
    if (to === 'numpad' || to === 'arrows') {
      setRightBlock(to);
      writeRightBlock(browserStorage(), to);
      return;
    }
    const key = element.getAttribute('data-mobile-key');
    if (key) onSendKey(key);
  }, [onSendKey]);
  const press = useTapPress<HTMLDivElement>(onTap);

  return (
    <div
      className="mobile-special-keyboard"
      role="group"
      aria-label={t('mobileKeyboard.special.panel')}
      style={{ height: `${height}px` }}
      onPointerDown={press.onPointerDown}
      onPointerMove={press.onPointerMove}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
      onMouseDown={press.onMouseDown}
      onContextMenu={press.onContextMenu}
    >
      <div className="mobile-special-keyboard__top" data-special-block="top">
        {SPECIAL_TOP_ROW.map((entry, index) => renderEntry(entry, `top-${index}`))}
      </div>
      <div className="mobile-special-keyboard__grid">
        {renderBlock('left', SPECIAL_LEFT_BLOCK)}
        {renderBlock('middle', SPECIAL_MIDDLE_BLOCK)}
        {renderBlock('right', rightBlock === 'numpad' ? SPECIAL_NUMPAD_BLOCK : SPECIAL_ARROW_BLOCK)}
      </div>
    </div>
  );
}
