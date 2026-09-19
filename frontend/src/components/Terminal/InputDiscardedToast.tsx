import './InputDiscardedToast.css';

interface Props {
  /** How many inputs have been discarded in the current run. `0` renders nothing. */
  discardedCount: number;
}

/**
 * REL-BGSTAB-016 (issue #109): input discarded while the capture gate is transient-blocked and
 * `inputReliabilityMode` is `observe` is discarded SILENTLY -- the call records a debug event
 * and returns, and nothing on screen changes. The user types and the characters simply are not
 * there; measured on a live server, the gate can hold that state for tens of seconds.
 *
 * The requirement forbids that silence rather than the discard: the shipped mode observes, and
 * telling the user is what it owes them.
 *
 * AC-5: the discarded text itself never appears here, and is not logged. Someone reading the
 * screen over a shoulder, or a screenshot in a bug report, must not carry what was typed.
 * AC-7: consecutive discards coalesce into this one surface with a count, because one surface
 * per keystroke would cover the screen and be worse than the discard it reports.
 */
export function InputDiscardedToast({ discardedCount }: Props) {
  if (discardedCount <= 0) return null;

  return (
    <div className="input-discarded-toast" role="status" data-testid="input-discarded-toast">
      입력이 전달되지 않았습니다
      <span className="input-discarded-toast__count" data-testid="input-discarded-count">
        {discardedCount}건
      </span>
    </div>
  );
}
