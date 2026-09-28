// FR-AITUI-011: the alias editor's text field. Names are bare commands (no paths, no shell
// characters); the server applies the same rule and is the one that decides.
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/;

export function parseAliasInput(text: string, builtIn: readonly string[] = []): { names: string[]; invalid: string[] } {
  const names: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    if (raw === '') continue;
    const name = raw.toLowerCase();
    if (!ALIAS_PATTERN.test(name) || builtIn.includes(name)) {
      if (!invalid.includes(raw)) invalid.push(raw);
      continue;
    }
    if (!names.includes(name)) names.push(name);
  }
  return { names, invalid };
}

export function formatAliases(names: readonly string[]): string {
  return names.join(' ');
}
