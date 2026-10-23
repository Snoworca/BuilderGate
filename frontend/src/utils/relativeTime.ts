/**
 * "3 minutes ago" in the active UI language, from Intl. Code never appends "ago".
 * Under 10 s: the caller's "just now". From 7 days: a date (with the year only when it differs).
 *
 * @req NFR-GIT-002
 */
export function formatRelativeTime(ts: number, now: number, lang: string, justNow: string): string {
  const s = Math.round((ts - now) / 1000);
  const a = Math.abs(s);
  if (a < 10) return justNow;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 7 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(lang, sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' }).format(ts);
}
