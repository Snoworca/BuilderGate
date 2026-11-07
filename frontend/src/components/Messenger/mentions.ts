// The @ grammar of docs/design/messenger.contract.md §5, the same as the server's
// messenger/mentions.ts: `@name`, `@node::name`, `@node::"name with spaces"`,
// `@"name with spaces"`. The first `::` splits. An `@` after a letter, digit, `_` or `@` is not a
// mention (a@b.com); an unquoted name loses trailing punctuation (`@a,` names `a`).
// @req FR-MSG-003

export interface MentionRef {
  node: string | null;
  name: string;
}

export interface MentionToken extends MentionRef {
  /** Offset of the `@`. */
  start: number;
  /** Offset just past the token. */
  end: number;
  raw: string;
}

const STOP = /[\s@"]/;
/** What may not stand right before a mention's `@`. */
const GLUED = /[\p{L}\p{N}_@]/u;
/** Trailing characters an unquoted name does not keep. */
const TRAILING = /[.,;:!?)\]}>'\u2019]+$/u;

function readQuoted(text: string, at: number): { value: string; end: number } | null {
  if (text[at] !== '"') return null;
  const close = text.indexOf('"', at + 1);
  if (close < 0 || close === at + 1) return null;
  return { value: text.slice(at + 1, close), end: close + 1 };
}

function readRun(text: string, at: number): number {
  let end = at;
  while (end < text.length && !STOP.test(text[end])) end += 1;
  return end;
}

function parseAt(text: string, start: number): MentionToken | null {
  const from = start + 1;
  const quoted = readQuoted(text, from);
  if (quoted) {
    return { start, end: quoted.end, raw: text.slice(start, quoted.end), node: null, name: quoted.value };
  }
  const runEnd = readRun(text, from);
  const run = text.slice(from, runEnd);
  const split = run.indexOf('::');
  if (split < 0) {
    const name = run.replace(TRAILING, '');
    if (name === '') return null;
    const end = from + name.length;
    return { start, end, raw: text.slice(start, end), node: null, name };
  }
  const node = run.slice(0, split);
  const rest = run.slice(split + 2);
  if (node === '') return null;
  if (rest !== '') {
    const name = rest.replace(TRAILING, '');
    if (name === '') return null;
    const end = from + split + 2 + name.length;
    return { start, end, raw: text.slice(start, end), node, name };
  }
  const tail = readQuoted(text, runEnd);
  if (!tail) return null;
  return { start, end: tail.end, raw: text.slice(start, tail.end), node, name: tail.value };
}

/** Every mention in a text, in order. */
export function findMentions(text: string): MentionToken[] {
  const found: MentionToken[] = [];
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    const wordStart = at === 0 || !GLUED.test(text[at - 1]);
    const token = wordStart ? parseAt(text, at) : null;
    if (token) {
      found.push(token);
      index = token.end;
    } else {
      index = at + 1;
    }
  }
  return found;
}

function needsQuotes(name: string): boolean {
  return /[\s@"]/.test(name) || name.includes('::');
}

/** The exact text that names a member, with quotes when the name needs them. */
export function formatMention(node: string | null, name: string): string {
  const body = needsQuotes(name) ? `"${name}"` : name;
  return node === null ? `@${body}` : `@${node}::${body}`;
}

export interface MentionRoom {
  me: string;
  people: string[];
  sessions: Array<{ id: string; node: string; name: string }>;
}

export type MentionTarget =
  | { kind: 'session'; id: string }
  | { kind: 'person'; node: string }
  | { kind: 'ambiguous' }
  | { kind: 'missing' };

const sameNode = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What a mention names in a room (§5): my session first, then a person. */
export function resolveMention(ref: MentionRef, room: MentionRoom): MentionTarget {
  const owner = ref.node ?? room.me;
  const sessions = room.sessions.filter((session) => sameNode(session.node, owner) && session.name === ref.name);
  if (sessions.length > 1) return { kind: 'ambiguous' };
  if (sessions.length === 1) return { kind: 'session', id: sessions[0].id };
  if (ref.node === null) {
    const person = room.people.find((node) => sameNode(node, ref.name));
    if (person !== undefined) return { kind: 'person', node: person };
  }
  return { kind: 'missing' };
}

/** The text with the `index`-th mention (and one space after it) taken out. */
export function removeMentionAt(text: string, index: number): string {
  const token = findMentions(text)[index];
  if (!token) return text;
  const end = text[token.end] === ' ' ? token.end + 1 : token.end;
  return text.slice(0, token.start) + text.slice(end);
}

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'block'; text: string }
  | ({ kind: 'mention'; text: string } & MentionRef);

function splitInline(text: string, out: TextSegment[]): void {
  const pushText = (value: string) => {
    if (value === '') return;
    let cursor = 0;
    for (const token of findMentions(value)) {
      if (token.start > cursor) out.push({ kind: 'text', text: value.slice(cursor, token.start) });
      out.push({ kind: 'mention', text: token.raw, node: token.node, name: token.name });
      cursor = token.end;
    }
    if (cursor < value.length) out.push({ kind: 'text', text: value.slice(cursor) });
  };
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('`', cursor);
    const close = open < 0 ? -1 : text.indexOf('`', open + 1);
    if (open < 0 || close < 0 || close === open + 1) {
      pushText(text.slice(cursor));
      return;
    }
    pushText(text.slice(cursor, open));
    out.push({ kind: 'code', text: text.slice(open + 1, close) });
    cursor = close + 1;
  }
}

/**
 * A message body as the log draws it: only `code`, fenced code blocks and
 * mentions are recognised; everything else is plain text (FR-MSG-002 AC-5).
 */
export function splitMessageText(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('```', cursor);
    const bodyStart = open < 0 ? -1 : text.indexOf('\n', open + 3);
    const close = bodyStart < 0 ? -1 : text.indexOf('```', bodyStart + 1);
    if (open < 0 || bodyStart < 0 || close < 0) {
      splitInline(text.slice(cursor), out);
      break;
    }
    splitInline(text.slice(cursor, open), out);
    out.push({ kind: 'block', text: text.slice(bodyStart + 1, close) });
    cursor = close + 3;
    if (text[cursor] === '\n') cursor += 1;
  }
  return out;
}

export type LabeledSegment =
  | Exclude<TextSegment, { kind: 'mention' }>
  | ({ kind: 'mention'; text: string; shownNode: string | null; shownName: string } & MentionRef);

/**
 * Mentions shown with the CURRENT names of the members they named (FR-MSG-003 AC-5). `to` holds
 * the member ids fixed at send time. A mention that still resolves to one of them uses it; one
 * whose session was renamed takes the next unused id of the same owner; anything else keeps its
 * own text.
 */
export function labelMentions(segments: TextSegment[], to: string[], room: MentionRoom): LabeledSegment[] {
  const unused = [...to];
  const take = (id: string) => { unused.splice(unused.indexOf(id), 1); };
  const show = (id: string): { shownNode: string | null; shownName: string } => {
    const session = room.sessions.find((candidate) => candidate.id === id);
    if (!session) return { shownNode: null, shownName: id };
    return session.node.toLowerCase() === room.me.toLowerCase()
      ? { shownNode: null, shownName: session.name }
      : { shownNode: session.node, shownName: session.name };
  };
  return segments.map((segment): LabeledSegment => {
    if (segment.kind !== 'mention') return segment;
    const own = { shownNode: segment.node, shownName: segment.name };
    const target = resolveMention(segment, room);
    if (target.kind === 'session' && unused.includes(target.id)) {
      take(target.id);
      return { ...segment, ...show(target.id) };
    }
    if (target.kind === 'person' && unused.some((id) => sameNode(id, target.node))) {
      take(unused.find((id) => sameNode(id, target.node)) as string);
      return { ...segment, shownNode: null, shownName: target.node };
    }
    const owner = segment.node ?? room.me;
    const fallback = unused.find((id) => {
      const split = id.indexOf('::');
      return split > 0 && sameNode(id.slice(0, split), owner);
    });
    if (target.kind !== 'session' && fallback !== undefined) {
      take(fallback);
      return { ...segment, ...show(fallback) };
    }
    return { ...segment, ...own };
  });
}

/**
 * D9: C0 and C1 control characters (and DEL) never reach the screen; new lines and tabs stay.
 * The server sanitizes at store time too; this guards an older copy of the log.
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}
