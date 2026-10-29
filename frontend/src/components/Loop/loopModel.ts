// FR-LOOP-006: the loop editor's rules, apart from React so they can be tested.
import type { LoopInput, LoopStep } from './loopTypes.ts';

/**
 * AC-4: `codex delay 2000 "금일 주식 시황 분석하시오"` — a command runs until `delay <ms>` or a
 * quoted prompt; `\"` inside a prompt is a quote. `exit` is an ordinary command.
 */
export function parseLoopLine(line: string): LoopStep[] {
  const steps: LoopStep[] = [];
  const pattern = /\s*(?:delay\s+(\d+)(?=\s|$)|"((?:[^"\\]|\\.)*)"|(\S(?:(?!\s+delay\s+\d|\s+").)*))/gy;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null && match[0].trim() !== '') {
    if (match[1] !== undefined) steps.push({ kind: 'delay', ms: Number(match[1]) });
    else if (match[2] !== undefined) steps.push({ kind: 'prompt', text: match[2].replace(/\\(.)/g, '$1') });
    else if (match[3] !== undefined) steps.push({ kind: 'command', text: match[3].trim() });
  }
  return steps;
}

/** AC-3: the session-end step is always the last one. */
export function canAddStep(steps: readonly LoopStep[]): boolean {
  return steps.at(-1)?.kind !== 'end';
}

/** Adds steps at the end, up to and including a session end; nothing once the list has ended. */
export function appendSteps(steps: LoopStep[], added: readonly LoopStep[]): LoopStep[] {
  if (!canAddStep(steps)) return steps;
  const end = added.findIndex((step) => step.kind === 'end');
  return [...steps, ...(end >= 0 ? added.slice(0, end + 1) : added)];
}

/** Moves a step one place; the session end neither moves nor has anything moved below it. */
export function moveStep(steps: LoopStep[], index: number, by: -1 | 1): LoopStep[] {
  const target = index + by;
  if (target < 0 || target >= steps.length) return steps;
  if (steps[index].kind === 'end' || steps[target].kind === 'end') return steps;
  const next = [...steps];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A local `YYYY-MM-DD`. */
export function localDate(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A new loop: weekdays at the next whole hour, no folder and no steps yet. */
export function newLoopDraft(now: Date): LoopInput {
  const hour = (now.getHours() + 1) % 24;
  return {
    name: '',
    enabled: true,
    schedule: { kind: 'weekly', days: [1, 2, 3, 4, 5], times: [`${pad(hour)}:00`] },
    shell: 'auto',
    cwd: '',
    keepTabs: 1,
    steps: [],
  };
}

/** A number field's value; an emptied field is NaN, which JSON sends as null and the server refuses. */
export function numberField(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}
