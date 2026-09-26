import { AGENT_LABELS, type AgentKind } from './sessionSnapshotModel.ts';

/** An agent's name with its colour dot; the name always travels with the colour. */
export function AgentMark({ agent }: { agent: AgentKind }) {
  return (
    <span className={`agent-mark agent-mark-${agent}`}>
      <span className="agent-mark-dot" aria-hidden="true" />
      {AGENT_LABELS[agent]}
    </span>
  );
}
