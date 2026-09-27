/**
 * FR-I18N-001: the display language is the primary subtag of the browser's
 * language when that language is supported, otherwise the default. Only the
 * first preference counts — 'ja' with 'ko' second still gets the default.
 */
export function pickLanguage(tag: string | undefined, supported: ReadonlySet<string>, fallback: string): string {
  const primary = (tag ?? '').split(/[-_]/)[0].toLowerCase();
  return supported.has(primary) ? primary : fallback;
}
