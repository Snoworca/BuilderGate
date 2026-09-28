// FR-AITUI-008 AC-3 — the command that resumes one saved session.
//
// The tab's recovery option (FR-AITUI-001) is kept: a wrapper such as
// `claudep` and flags such as `--dangerously-skip-permissions` survive; only
// the session selector is swapped for the saved id.

import type { AgentKind } from './agentSessionResolver.js';

export interface ResumeCommand {
  command: string;
  args: string[];
}

interface SelectorRule {
  /** Flags removed together with the value that follows them. */
  withValue: string[];
  /** Flags removed alone. */
  alone: string[];
  /** Flags removed with a following value only when one is present. */
  optionalValue: string[];
}

const RULES: Record<Exclude<AgentKind, 'codex'>, SelectorRule> = {
  claude: { withValue: ['--resume', '-r', '--session-id'], alone: ['--continue', '-c', '--fork-session'], optionalValue: [] },
  hermes: { withValue: ['--resume', '-r'], alone: [], optionalValue: ['--continue', '-c'] },
  opencode: { withValue: ['--session', '-s'], alone: ['--continue', '-c', '--fork'], optionalValue: [] },
};

function stripSelectors(args: readonly string[], rule: SelectorRule): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (rule.withValue.includes(flag)) {
      if (!arg.includes('=') && i + 1 < args.length) i += 1;
      continue;
    }
    if (rule.alone.includes(arg)) continue;
    if (rule.optionalValue.includes(flag)) {
      if (!arg.includes('=') && i + 1 < args.length && !args[i + 1].startsWith('-')) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function stripCodexResume(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === 'resume') {
      // `resume --last`, `resume <id>` and `resume --all` all go; the new
      // selector is appended once at the end.
      while (i + 1 < args.length && (args[i + 1] === '--last' || args[i + 1] === '--all' || !args[i + 1].startsWith('-'))) {
        i += 1;
      }
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** FR-AITUI-013 AC-2: the launch arguments without any session selector. */
export function stripSessionSelectors(agent: AgentKind, args: readonly string[]): string[] {
  return agent === 'codex' ? stripCodexResume(args) : stripSelectors(args, RULES[agent]);
}

export function buildResumeCommand(
  agent: AgentKind,
  sessionId: string,
  option: { command: string; args: readonly string[] } | null,
): ResumeCommand {
  const command = option?.command?.trim() || agent;
  const args = option ? [...option.args] : [];
  if (agent === 'codex') {
    return { command, args: [...stripCodexResume(args), 'resume', sessionId] };
  }
  const selector = agent === 'opencode' ? '--session' : '--resume';
  return { command, args: [...stripSelectors(args, RULES[agent]), selector, sessionId] };
}
