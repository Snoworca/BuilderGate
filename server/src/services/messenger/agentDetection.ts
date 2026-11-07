// Security (FR-MSG-004): room text is pasted only where an AI agent runs. Two sources:
// 1. foreground detection — SessionManager.getAgentRuntimeInfo().foregroundAppId (claude, codex,
//    hermes, opencode), the same detection the session save and its AI-session count use; it sees a
//    Claude Code the user started by hand;
// 2. the MCP session registry's agentKind/agentStatus, set for agents launched or reporting over MCP.
// Pure, so the rule is tested without a PTY.
import type { SessionAgent } from './types.js';

const NOT_AN_AGENT = new Set(['', 'terminal', 'unknown']);
const FINISHED = new Set(['completed', 'failed']);

export function detectSessionAgent(
  registry: { agentKind?: string; agentStatus?: string },
  runtime: { foregroundAppId: string | null } | null,
  activity: string | undefined,
): SessionAgent | null {
  const registryKind = registry.agentKind && !NOT_AN_AGENT.has(registry.agentKind) ? registry.agentKind : undefined;
  const foreground = runtime?.foregroundAppId ?? null;
  if (foreground) {
    const status = registryKind === foreground && registry.agentStatus ? registry.agentStatus : activity ?? 'running';
    return { kind: foreground, status };
  }
  if (!registryKind) return null;
  const status = registry.agentStatus ?? 'unknown';
  return FINISHED.has(status) ? null : { kind: registryKind, status };
}
