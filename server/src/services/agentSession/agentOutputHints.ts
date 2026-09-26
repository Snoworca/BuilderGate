// FR-AITUI-006 AC-5 — session ids an agent prints on screen.
//
// Hermes keeps no per-process record, but it prints its session id in the
// start banner, on /resume and in the exit summary; the other agents print a
// resume command when they exit. This tracker watches PTY output for those
// lines and keeps the last one per session. It runs on the output hot path, so
// a chunk without any trigger word costs a few `includes` calls and nothing
// else.

import type { AgentKind, AgentOutputHint } from './agentSessionResolver.js';

const TRIGGERS = ['Session', 'session', 'resume', 'ses_'];
const TAIL_CHARS = 160;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HERMES = '\\d{8}_\\d{6}_[0-9a-f]{6}';

const PATTERNS: Array<{ agent: AgentKind; source: string; re: RegExp }> = [
  { agent: 'hermes', source: 'hermes-banner', re: new RegExp(`Session:\\s+(${HERMES})`, 'g') },
  { agent: 'hermes', source: 'hermes-status', re: new RegExp(`Session ID:\\s+(${HERMES})`, 'g') },
  { agent: 'hermes', source: 'hermes-resumed', re: new RegExp(`Resumed session\\s+(${HERMES})`, 'g') },
  { agent: 'hermes', source: 'hermes-exit-hint', re: new RegExp(`hermes\\s+(?:--tui\\s+)?--resume\\s+(${HERMES})`, 'g') },
  { agent: 'claude', source: 'claude-exit-hint', re: new RegExp(`claude\\s+(?:--worktree\\s+\\S+\\s+)?--resume\\s+(${UUID})`, 'gi') },
  { agent: 'codex', source: 'codex-exit-hint', re: new RegExp(`codex\\s+resume\\s+(${UUID})`, 'gi') },
  { agent: 'opencode', source: 'opencode-exit-hint', re: /opencode\s+-s\s+(ses_[0-9A-Za-z]{26})/g },
];

function hasTrigger(text: string): boolean {
  return TRIGGERS.some((word) => text.includes(word));
}

export class AgentOutputHintTracker {
  private readonly hints = new Map<string, AgentOutputHint>();
  private readonly tails = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(sessionId: string, chunk: string): void {
    const tail = this.tails.get(sessionId);
    if (tail === undefined && !hasTrigger(chunk)) return;
    const text = (tail ?? '') + chunk.replace(ANSI, '');
    let best: { index: number; agent: AgentKind; source: string; id: string } | null = null;
    for (const pattern of PATTERNS) {
      pattern.re.lastIndex = 0;
      for (const match of text.matchAll(pattern.re)) {
        const index = match.index ?? 0;
        if (!best || index >= best.index) best = { index, agent: pattern.agent, source: pattern.source, id: match[1] };
      }
    }
    if (best) {
      this.hints.set(sessionId, { agent: best.agent, sessionId: best.id, source: best.source, atMs: this.now() });
    }
    const rest = text.slice(-TAIL_CHARS);
    if (hasTrigger(rest) && !(best && text.length - best.index < TAIL_CHARS && /\s$/.test(text))) {
      this.tails.set(sessionId, rest);
    } else {
      this.tails.delete(sessionId);
    }
  }

  get(sessionId: string): AgentOutputHint | null {
    return this.hints.get(sessionId) ?? null;
  }

  forget(sessionId: string): void {
    this.hints.delete(sessionId);
    this.tails.delete(sessionId);
  }
}
