export interface StaleRepeatedTerminalKeyInput {
  event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'repeat' | 'timeStamp'>;
  now?: number;
  staleThresholdMs?: number;
}

export const STALE_TERMINAL_REPEAT_THRESHOLD_MS = 250;

const STALE_REPEAT_GUARDED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'Insert',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export function shouldDropStaleRepeatedTerminalKey(input: StaleRepeatedTerminalKeyInput): boolean {
  const { event } = input;
  if (!event.repeat || event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }
  if (!STALE_REPEAT_GUARDED_KEYS.has(event.key)) {
    return false;
  }

  const now = input.now ?? performance.now();
  const ageMs = normalizeEventAgeMs(event.timeStamp, now);
  return ageMs > (input.staleThresholdMs ?? STALE_TERMINAL_REPEAT_THRESHOLD_MS);
}

function normalizeEventAgeMs(timeStamp: number, now: number): number {
  if (!Number.isFinite(timeStamp) || !Number.isFinite(now)) {
    return 0;
  }

  const ageMs = now - timeStamp;
  return ageMs >= 0 ? ageMs : 0;
}
