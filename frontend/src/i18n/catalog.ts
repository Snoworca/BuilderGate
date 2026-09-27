/** FR-I18N-004: placeholder filling for `{name}` templates. */
export type Params = Readonly<Record<string, string | number>>;

export function fill(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

/** The CLDR plural categories a catalog for `lang` must carry for each plural key. */
export function pluralCategoriesFor(lang: string): string[] {
  return [...new Intl.PluralRules(lang).resolvedOptions().pluralCategories].sort();
}
