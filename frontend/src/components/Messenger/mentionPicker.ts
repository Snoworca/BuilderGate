// The composer's @ picker (mockup ②): people of this room first (connected
// first), then my sessions; choosing a person or typing `name::` switches to
// that person's sessions in this room.
// @req FR-MSG-003

import { findMentions, formatMention, resolveMention, type MentionRoom } from './mentions.ts';

export interface PickerSession {
  name: string;
  /** Agent status, shown on the right of the row. */
  status?: string;
}

export interface PickerPerson {
  node: string;
  connected: boolean;
  sessions: PickerSession[];
}

export interface PickerSource {
  people: PickerPerson[];
  mine: PickerSession[];
}

export interface PickerItem {
  section: 'people' | 'mine' | 'remote';
  label: string;
  /** What replaces the query when the row is chosen. */
  insert: string;
  /** False for a person: choosing it opens that person's sessions instead of ending the mention. */
  done: boolean;
  disabled: boolean;
  status?: string;
  /** For a person row: how many sessions they have in this room. */
  sessionCount?: number;
  /** For a person row: the 「사람만 지정」 insert, naming the person only (`@name `). */
  personInsert?: string;
}

export interface PickerModel {
  /** The person whose sessions are listed, after `::`. */
  crumb: string | null;
  /** The part of the query the rows are filtered by. */
  filter: string;
  items: PickerItem[];
}

/** The mention being typed just before the caret, or null when there is none. */
export function activeMentionQuery(beforeCaret: string): { start: number; query: string } | null {
  // The same start rule as mentions.ts: not right after a letter, digit, _ or @.
  const match = /(?:^|[^\p{L}\p{N}_@])@((?:[^\s@"]*::)?"[^"]*|[^\s@"]*)$/u.exec(beforeCaret);
  if (!match) return null;
  const query = match[1];
  return { start: beforeCaret.length - query.length - 1, query };
}

const contains = (value: string, filter: string) => value.toLowerCase().includes(filter.toLowerCase());

export function buildPickerModel(query: string, source: PickerSource): PickerModel {
  const split = query.indexOf('::');
  if (split >= 0) {
    const node = query.slice(0, split);
    const filter = query.slice(split + 2).replace(/^"/, '');
    const person = source.people.find((candidate) => candidate.node === node);
    if (!person) return { crumb: null, filter, items: [] };
    return {
      crumb: person.node,
      filter,
      items: person.sessions
        .filter((session) => contains(session.name, filter))
        .map((session) => ({
          section: 'remote',
          label: session.name,
          insert: `${formatMention(person.node, session.name)} `,
          done: true,
          disabled: !person.connected,
          status: session.status,
        })),
    };
  }
  const filter = query.replace(/^"/, '');
  const people = source.people
    .filter((person) => contains(person.node, filter))
    .sort((a, b) => Number(b.connected) - Number(a.connected));
  const mine = source.mine.filter((session) => contains(session.name, filter));
  return {
    crumb: null,
    filter,
    items: [
      ...people.map((person): PickerItem => ({
        section: 'people',
        label: person.node,
        insert: `@${person.node}::`,
        done: false,
        disabled: !person.connected,
        sessionCount: person.sessions.length,
        personInsert: `${formatMention(null, person.node)} `,
      })),
      ...mine.map((session): PickerItem => ({
        section: 'mine',
        label: session.name,
        insert: `${formatMention(null, session.name)} `,
        done: true,
        disabled: false,
        status: session.status,
      })),
    ],
  };
}

/** Replaces the query (from its `@` to the caret) with the chosen insert. */
export function applyPickerItem(value: string, caret: number, item: { start: number; insert: string }): { value: string; caret: number } {
  const next = value.slice(0, item.start) + item.insert + value.slice(caret);
  return { value: next, caret: item.start + item.insert.length };
}

export function movePickerSelection(current: number, count: number, step: 1 | -1): number {
  if (count <= 0) return 0;
  return (current + step + count) % count;
}

export interface RecipientChip {
  label: string;
  /** Index of the mention in the text, for removing it. */
  index: number;
}

export interface RecipientSummary {
  /**
   * `room`: no session is named, so every session but the sender's gets it. `blocked`: a name
   * does not resolve (unknown or ambiguous), so who gets it cannot be decided yet.
   */
  kind: 'room' | 'targets' | 'blocked';
  /** Sessions in the room (the 「방 전체 (n)」 count). */
  sessions: number;
  chips: RecipientChip[];
  missing: string[];
  ambiguous: string[];
}

/** The 받는 대상 row: which sessions the text names, and which names do not resolve. */
export function recipientSummary(text: string, room: MentionRoom): RecipientSummary {
  const chips: RecipientChip[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];
  findMentions(text).forEach((token, index) => {
    const target = resolveMention(token, room);
    if (target.kind === 'session') {
      chips.push({ label: token.node === null ? token.name : `${token.node}::${token.name}`, index });
    } else if (target.kind === 'missing') {
      missing.push(token.raw);
    } else if (target.kind === 'ambiguous') {
      ambiguous.push(token.raw);
    }
  });
  const kind = missing.length + ambiguous.length > 0 ? 'blocked' : chips.length > 0 ? 'targets' : 'room';
  return { kind, sessions: room.sessions.length, chips, missing, ambiguous };
}
