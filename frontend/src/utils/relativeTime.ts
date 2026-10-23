/**
 * "3 minutes ago" in the active UI language, from Intl. Code never appends "ago".
 * Under 10 s: the caller's "just now". From 7 days: a date (with the year only when it differs).
 *
 * @req NFR-GIT-002
 */
// Building an Intl formatter costs far more than formatting with one; a Git list formats a
// time per row on every render (REL-BGSTAB-052).
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();

export function formatRelativeTime(ts: number, now: number, lang: string, justNow: string): string {
  const s = Math.round((ts - now) / 1000);
  const a = Math.abs(s);
  if (a < 10) return justNow;
  let rtf = relativeFormats.get(lang);
  if (!rtf) { rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }); relativeFormats.set(lang, rtf); }
  if (a < 60) return rtf.format(s, 'second');
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 7 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  const sameYear = new Date(ts).getFullYear() === new Date(now).getFullYear();
  const key = `${lang}|${sameYear ? 'md' : 'ymd'}`;
  let dtf = dateFormats.get(key);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat(lang, sameYear ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' });
    dateFormats.set(key, dtf);
  }
  return dtf.format(ts);
}
