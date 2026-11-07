// The session checklist of mockups ③ and ⑤: grouped by workspace, with the
// folder under each name and the agent status chip on the right.
// @req FR-MSG-001 FR-MSG-010
import { t } from '../../i18n/i18n.ts';
import type { McpSessionRecord } from '../../types';
import { agentChip, groupSessions, sessionDisplayName, sessionHasAgent } from './messengerModel.ts';

export interface PickerWorkspace {
  id: string;
  name: string;
  sortOrder: number;
}

interface SessionPickerProps {
  sessions: McpSessionRecord[];
  workspaces: PickerWorkspace[];
  query: string;
  selected: ReadonlySet<string>;
  onToggle: (sessionKey: string) => void;
  /** Session keys that cannot be chosen (already in the room). */
  disabled?: ReadonlySet<string>;
}

export function SessionPicker({ sessions, workspaces, query, selected, onToggle, disabled }: SessionPickerProps) {
  const groups = groupSessions(sessions, workspaces, query);
  if (groups.length === 0) {
    return <div className="msgr-pick-list msgr-pick-empty">{t('messenger.form.noSessions')}</div>;
  }
  return (
    <div className="msgr-pick-list">
      {groups.map((group) => (
        <div key={group.workspaceId || 'loose'} role="group" aria-label={group.name || undefined}>
          {group.name !== '' && <div className="msgr-pick-ws">{group.name}</div>}
          {group.sessions.map((session) => {
            const chip = agentChip(session);
            const isDisabled = disabled?.has(session.sessionKey) ?? false;
            return (
              <label key={session.sessionKey} className={`msgr-pick-row${isDisabled ? ' is-disabled' : ''}`}>
                <input
                  type="checkbox"
                  checked={isDisabled || selected.has(session.sessionKey)}
                  disabled={isDisabled}
                  onChange={() => onToggle(session.sessionKey)}
                />
                <span className="msgr-pick-name">
                  {sessionDisplayName(session)}
                  {session.cwd && <span className="msgr-pick-cwd">{session.cwd}</span>}
                  {!sessionHasAgent(session) && <span className="msgr-pick-hint">{t('messenger.form.noAgentHint')}</span>}
                </span>
                <span className={`msgr-pill msgr-pill-${chip.tone}`}>{t(chip.key, chip.params)}</span>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}
