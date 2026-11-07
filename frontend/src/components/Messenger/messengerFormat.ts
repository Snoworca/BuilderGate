// Times and dates in the active UI language (FR-I18N-008), and the local
// session list the pickers draw from.
// @req FR-MSG-013
import { useEffect, useState } from 'react';
import { activeLanguage, t } from '../../i18n/i18n.ts';
import { mcpControlApi } from '../../services/api.ts';
import type { McpSessionRecord } from '../../types';

export const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

const valid = (iso: string | undefined) => iso !== undefined && iso !== '' && !Number.isNaN(Date.parse(iso));

export function formatTime(iso: string | undefined): string {
  if (!valid(iso)) return '';
  return new Intl.DateTimeFormat(activeLanguage(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso as string));
}

export function formatDay(iso: string): string {
  return new Intl.DateTimeFormat(activeLanguage(), { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(iso));
}

export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** The room list's time column: today a time, yesterday a word, older a date. */
export function formatListTime(iso: string, now: Date = new Date()): string {
  if (!valid(iso)) return '';
  const date = new Date(iso);
  if (dayKey(iso) === dayKey(now.toISOString())) return formatTime(iso);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return t('messenger.room.yesterday');
  return new Intl.DateTimeFormat(activeLanguage(), { month: 'numeric', day: 'numeric' }).format(date);
}

/** 「3시간 전」 / "3 hours ago" in the active UI language. */
export function formatAgo(parts: { value: number; unit: 'minute' | 'hour' | 'day' }): string {
  return new Intl.RelativeTimeFormat(activeLanguage(), { numeric: 'auto' }).format(parts.value, parts.unit);
}

/** The viewport as a rect, following rotation and the phone's address bar (phone windows fill it). */
export function useViewportRect(): { x: number; y: number; width: number; height: number } {
  const read = () => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
  const [rect, setRect] = useState(read);
  useEffect(() => {
    const onResize = () => setRect(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return rect;
}

/** This server's live sessions, for the session pickers and the @ picker's status column. */
export function useLocalSessions(): { sessions: McpSessionRecord[]; error: string | null } {
  const [sessions, setSessions] = useState<McpSessionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    mcpControlApi.listSessions({ includeSelf: true })
      .then((result) => {
        if (!alive) return;
        const records = result.matches ?? result.sessions;
        setSessions(records.filter((record) => record.bindingLifecycle === undefined || record.bindingLifecycle === 'live'));
      })
      .catch((reason) => { if (alive) setError(errorText(reason)); });
    return () => { alive = false; };
  }, []);
  return { sessions, error };
}
