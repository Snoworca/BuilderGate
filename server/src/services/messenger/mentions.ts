// FR-MSG-003: @ mentions (contract §5). Pure. The frontend keeps a copy of the tokenizer for
// highlighting (frontend/src/components/Messenger/mentions.ts); keep the two in step.
import { sameNode as sameName } from './types.js';

export interface MentionToken {
  /** The text as written, e.g. `@bob::"api server"`. */
  raw: string;
  start: number;
  end: number;
  /** Set for `@node::name`. */
  node?: string;
  name: string;
}

export interface MentionRoster {
  /** The server resolving the mention (the sender's server). */
  selfNode: string;
  people: string[];
  sessions: Array<{ id: string; node: string; name: string }>;
}

export type MentionResult =
  | { ok: true; to: string[] }
  | { ok: false; code: 'AMBIGUOUS_TARGET'; name: string; candidates: string[] }
  | { ok: false; code: 'TARGET_NOT_FOUND'; name: string };

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const BARE_STOP = /[\s"@]/u;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'’]+$/u;

export function tokenizeMentions(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at < 0) break;
    const token = at > 0 && (WORD_CHAR.test(text[at - 1]!) || text[at - 1] === '@') ? undefined : readToken(text, at);
    if (token) {
      tokens.push(token);
      i = token.end;
    } else {
      i = at + 1;
    }
  }
  return tokens;
}

function readToken(text: string, at: number): MentionToken | undefined {
  let pos = at + 1;
  if (text[pos] === '"') {
    const quoted = readQuoted(text, pos);
    return quoted && quoted.value ? { raw: text.slice(at, quoted.end), start: at, end: quoted.end, name: quoted.value } : undefined;
  }
  while (pos < text.length && !BARE_STOP.test(text[pos]!)) pos += 1;
  const bare = text.slice(at + 1, pos);
  const split = bare.indexOf('::');
  if (split < 0) {
    const name = bare.replace(TRAILING_PUNCTUATION, '');
    if (!name) return undefined;
    const end = at + 1 + name.length;
    return { raw: text.slice(at, end), start: at, end, name };
  }
  const node = bare.slice(0, split);
  const rest = bare.slice(split + 2);
  if (!node) return undefined;
  if (rest === '' && text[pos] === '"') {
    const quoted = readQuoted(text, pos);
    return quoted && quoted.value ? { raw: text.slice(at, quoted.end), start: at, end: quoted.end, node, name: quoted.value } : undefined;
  }
  const name = rest.replace(TRAILING_PUNCTUATION, '');
  if (!name) return undefined;
  const end = at + 1 + split + 2 + name.length;
  return { raw: text.slice(at, end), start: at, end, node, name };
}

function readQuoted(text: string, quoteAt: number): { value: string; end: number } | undefined {
  const close = text.indexOf('"', quoteAt + 1);
  return close < 0 ? undefined : { value: text.slice(quoteAt + 1, close), end: close + 1 };
}

/** FR-MSG-003 AC-1..AC-5: the member ids named in `text` ([] = whole room). */
export function resolveMentions(text: string, roster: MentionRoster): MentionResult {
  return collect(tokenizeMentions(text).map((token) => () => resolveToken(token, roster)));
}

/** FR-MSG-007 AC-2: `to` entries of room.send — mention texts (`@…`) or member ids. */
export function resolveTargets(entries: string[], roster: MentionRoster): MentionResult {
  return collect(entries.map((entry) => () => resolveEntry(entry.trim(), roster)));
}

function resolveEntry(entry: string, roster: MentionRoster): MentionResult {
  if (entry.startsWith('@')) {
    const token = tokenizeMentions(entry)[0];
    return token ? resolveToken(token, roster) : { ok: false, code: 'TARGET_NOT_FOUND', name: entry };
  }
  const session = roster.sessions.find((candidate) => candidate.id === entry);
  if (session) return { ok: true, to: [session.id] };
  const person = roster.people.find((node) => sameName(node, entry));
  if (person) return { ok: true, to: [person] };
  const split = entry.indexOf('::');
  return resolveToken(split > 0
    ? { raw: entry, start: 0, end: entry.length, node: entry.slice(0, split), name: entry.slice(split + 2) }
    : { raw: entry, start: 0, end: entry.length, name: entry }, roster);
}

function resolveToken(token: MentionToken, roster: MentionRoster): MentionResult {
  if (token.node !== undefined) {
    const matches = roster.sessions.filter((session) => sameName(session.node, token.node!) && session.name === token.name);
    return pick(matches.map((session) => session.id), `${token.node}::${token.name}`);
  }
  const local = roster.sessions.filter((session) => sameName(session.node, roster.selfNode) && session.name === token.name);
  if (local.length > 0) return pick(local.map((session) => session.id), token.name);
  const person = roster.people.find((node) => sameName(node, token.name));
  return person ? { ok: true, to: [person] } : { ok: false, code: 'TARGET_NOT_FOUND', name: token.name };
}

function pick(ids: string[], name: string): MentionResult {
  if (ids.length === 1) return { ok: true, to: ids };
  if (ids.length === 0) return { ok: false, code: 'TARGET_NOT_FOUND', name };
  return { ok: false, code: 'AMBIGUOUS_TARGET', name, candidates: ids };
}

function collect(resolvers: Array<() => MentionResult>): MentionResult {
  const to: string[] = [];
  for (const resolve of resolvers) {
    const result = resolve();
    if (!result.ok) return result;
    for (const id of result.to) if (!to.includes(id)) to.push(id);
  }
  return { ok: true, to };
}
