// The message box (mockups ①, ②): Enter sends, Shift+Enter breaks the line,
// `@` opens the picker, and the 받는 대상 row shows who will get it.
// @req FR-MSG-002 FR-MSG-003
import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Icon } from '../common';
import { Button } from '../ui';
import { t, tn } from '../../i18n/i18n.ts';
import { removeMentionAt, type MentionRoom } from './mentions.ts';
import { isImeEnter } from './messengerWindowModel.ts';
import {
  activeMentionQuery,
  applyPickerItem,
  buildPickerModel,
  movePickerSelection,
  recipientSummary,
  type PickerItem,
  type PickerSource,
} from './mentionPicker.ts';

interface ComposerProps {
  room: MentionRoom;
  picker: PickerSource;
  /** Resolves to an error text when the server refused, or null when it went out. */
  onSend: (text: string) => Promise<string | null>;
  notice?: string | null;
}

export function Composer({ room, picker, onSend, notice }: ComposerProps) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [selection, setSelection] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const beforeCaret = value.slice(0, caret);
  const query = activeMentionQuery(beforeCaret);
  const model = query === null ? null : buildPickerModel(query.query, picker);
  const pickerOpen = query !== null && model !== null && dismissedAt !== beforeCaret;
  const items = pickerOpen && model ? model.items : [];
  const current = Math.min(selection, Math.max(items.length - 1, 0));
  const summary = useMemo(() => recipientSummary(value, room), [value, room]);
  const blocked = summary.missing.length > 0 || summary.ambiguous.length > 0;
  const canSend = value.trim() !== '' && !blocked && !sending;

  const syncCaret = () => setCaret(areaRef.current?.selectionStart ?? value.length);

  const setText = (next: string, nextCaret: number) => {
    setValue(next);
    setCaret(nextCaret);
    setSelection(0);
    setError(null);
    window.requestAnimationFrame(() => {
      const area = areaRef.current;
      if (!area) return;
      area.focus();
      area.selectionStart = nextCaret;
      area.selectionEnd = nextCaret;
    });
  };

  /** `personOnly`: the 「사람만 지정」 choice of a person row, `@name ` without `::`. */
  const choose = (item: PickerItem | undefined, personOnly = false) => {
    if (!item || query === null) return;
    const insert = personOnly && item.personInsert !== undefined ? item.personInsert : item.insert;
    const result = applyPickerItem(value, caret, { start: query.start, insert });
    setText(result.value, result.caret);
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const refusal = await onSend(value.trim());
    setSending(false);
    if (refusal === null) {
      setText('', 0);
    } else {
      setError(refusal);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeEnter({ isComposing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return;
    if (pickerOpen && items.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setSelection(movePickerSelection(current, items.length, event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(items[current], event.key === 'Enter' && event.shiftKey);
        return;
      }
    }
    if (pickerOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(beforeCaret);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="msgr-composer">
      {pickerOpen && model && (
        <div className="msgr-picker" role="listbox" aria-label={t('messenger.picker.label')}>
          {model.crumb !== null && (
            <div className="msgr-crumb"><span>@{model.crumb}::</span><span className="msgr-faint">{t('messenger.picker.crumb')}</span></div>
          )}
          {items.length === 0 && <div className="msgr-pk is-disabled">{t('messenger.picker.none')}</div>}
          {items.map((item, index) => {
            const heading = item.section === 'people' && (index === 0 || items[index - 1].section !== 'people')
              ? 'messenger.picker.people'
              : item.section === 'mine' && (index === 0 || items[index - 1].section !== 'mine') ? 'messenger.picker.mine' : null;
            return (
              <div key={`${item.section}:${item.label}`}>
                {heading !== null && <div className="msgr-pk-sec">{t(heading)}</div>}
                <div
                  role="option"
                  aria-selected={index === current}
                  className={`msgr-pk${index === current ? ' is-selected' : ''}${item.disabled ? ' is-disabled' : ''}`}
                  onMouseDown={(event) => { event.preventDefault(); choose(item); }}
                >
                  {item.section === 'people'
                    ? <span className="msgr-pk-ic msgr-av-human">{Array.from(item.label)[0]}</span>
                    : <span className={`msgr-pk-ic msgr-pk-term${item.section === 'remote' ? ' is-remote' : ''}`}><Icon name="terminal" size={12} /></span>}
                  <span className={item.section === 'people' ? 'msgr-pk-name is-person' : 'msgr-pk-name'}>
                    <Highlight text={item.label} filter={model.filter} />
                  </span>
                  <span className="msgr-pk-sub">
                    {item.section === 'people'
                      ? (item.disabled ? t('messenger.picker.offline') : tn('messenger.picker.sessionCount', item.sessionCount ?? 0))
                      : item.status ?? ''}
                  </span>
                  {item.personInsert !== undefined && (
                    <button
                      type="button"
                      className="msgr-pk-person"
                      title={t('messenger.picker.personOnlyHint')}
                      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); choose(item, true); }}
                    >
                      {t('messenger.picker.personOnly')}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="msgr-to-row">
        <span>{t('messenger.composer.to')}</span>
        {summary.kind === 'blocked'
          ? <span className="msgr-err msgr-err-inline">{t('messenger.composer.toBlocked')}</span>
          : summary.chips.length === 0
          ? <span className="msgr-faint">{t('messenger.composer.toRoom', { count: summary.sessions })}</span>
          : (
            <>
              {summary.chips.map((chip) => (
                <span key={chip.index} className="msgr-chip">
                  @{chip.label}
                  <button
                    type="button"
                    aria-label={t('messenger.composer.removeTarget')}
                    onClick={() => setText(removeMentionAt(value, chip.index), Math.min(caret, value.length))}
                  ><Icon name="close" size={12} /></button>
                </span>
              ))}
              <span className="msgr-faint">{`1:${summary.chips.length}`}</span>
            </>
          )}
      </div>
      {summary.missing.length > 0 && <div className="msgr-err">{t('messenger.composer.missing', { names: summary.missing.join(', ') })}</div>}
      {summary.ambiguous.length > 0 && <div className="msgr-err">{t('messenger.composer.ambiguous', { names: summary.ambiguous.join(', ') })}</div>}
      {error !== null && <div className="msgr-err" role="alert">{error}</div>}
      {notice && <div className="msgr-note">{notice}</div>}
      <div className="msgr-inbox">
        <textarea
          ref={areaRef}
          className="msgr-ta"
          rows={1}
          value={value}
          aria-label={t('messenger.composer.label')}
          placeholder={t('messenger.composer.placeholder')}
          onChange={(event) => { setValue(event.target.value); setCaret(event.target.selectionStart); setSelection(0); setError(null); }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={onKeyDown}
        />
        <Button variant="primary" size="md" disabled={!canSend} onClick={() => void send()}>{t('messenger.composer.send')}</Button>
      </div>
      <div className="msgr-hintline">
        {pickerOpen
          ? <><kbd>↑</kbd><kbd>↓</kbd> {t('messenger.picker.hintChoose')} · <kbd>Enter</kbd>/<kbd>Tab</kbd> {t('messenger.picker.hintInsert')} · <kbd>Shift</kbd>+<kbd>Enter</kbd> {t('messenger.picker.personOnly')} · <kbd>Esc</kbd> {t('messenger.picker.hintClose')}</>
          : <><kbd>Enter</kbd> {t('messenger.composer.hintSend')} · <kbd>Shift</kbd>+<kbd>Enter</kbd> {t('messenger.composer.hintNewline')} · {t('messenger.composer.hintRoom')}</>}
      </div>
    </div>
  );
}

function Highlight({ text, filter }: { text: string; filter: string }) {
  const at = filter === '' ? -1 : text.toLowerCase().indexOf(filter.toLowerCase());
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + filter.length)}</mark>{text.slice(at + filter.length)}</>;
}
