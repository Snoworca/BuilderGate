// FR-AITUI-015 AC-2/AC-3 — how one terminal comes back after a restart: the
// command to resume with (the agents' registered commands, shell only, or a
// typed command), its arguments and the session id.
import { useId } from 'react';
import { Select, TextInput } from '../ui/index.ts';
import { AGENT_LABELS, type AgentKind } from './sessionSnapshotModel.ts';
import {
  isValidSessionId,
  launcherOptions,
  restoreCommandPreview,
  type LauncherMap,
  type RowDraft,
  type SessionCandidate,
} from './sessionSaveAllModel.ts';
import { t } from '../../i18n/i18n.ts';

export interface RestoreEditorProps {
  draft: RowDraft;
  launchers: LauncherMap;
  candidates?: SessionCandidate[];
  /** The command that was running, offered back when the row is a shell. */
  runningCommand?: string | null;
  onChange: (next: RowDraft) => void;
}

function howValue(draft: RowDraft): string {
  if (draft.mode === 'shell') return 'shell';
  if (draft.mode === 'command') return 'command';
  return `agent:${draft.agent}:${draft.launcher || draft.agent}`;
}

function candidateLabel(candidate: SessionCandidate): string {
  if (!candidate.startedAtMs) return candidate.sessionId;
  const at = new Date(candidate.startedAtMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${candidate.sessionId} · ${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function RestoreEditor({ draft, launchers, candidates = [], runningCommand, onChange }: RestoreEditorProps) {
  const id = useId();
  const update = (patch: Partial<RowDraft>) => onChange({ ...draft, ...patch, edited: true });
  const onHow = (value: string) => {
    if (value === 'shell' || value === 'command') {
      update({ mode: value, command: value === 'command' ? (draft.command || runningCommand || '') : draft.command });
      return;
    }
    const [, agent, launcher] = value.split(':') as [string, AgentKind, string];
    update({ mode: 'agent', agent, launcher });
  };
  const preview = restoreCommandPreview(draft);
  const idInvalid = draft.mode === 'agent' && draft.agent !== null && draft.sessionId !== '' && !isValidSessionId(draft.agent, draft.sessionId);

  return (
    <div className="session-editor">
      <label className="session-editor-field" htmlFor={`${id}-how`}>
        <span className="session-editor-label">{t('sessionSave.editor.how')}</span>
        <Select id={`${id}-how`} value={howValue(draft)} onChange={(event) => onHow(event.target.value)}>
          {launcherOptions(launchers, draft.mode === 'agent' ? { agent: draft.agent, launcher: draft.launcher } : undefined).map(({ agent, launchers: names }) => (
            <optgroup key={agent} label={AGENT_LABELS[agent]}>
              {names.map((name) => <option key={name} value={`agent:${agent}:${name}`}>{name}</option>)}
            </optgroup>
          ))}
          <optgroup label={t('sessionSave.editor.shellGroup')}>
            <option value="shell">{t('sessionSave.editor.shellOnly')}</option>
            <option value="command">{t('sessionSave.editor.custom')}</option>
          </optgroup>
        </Select>
        <span className="session-editor-hint">{t('sessionSave.editor.launcherHint')}</span>
      </label>

      {draft.mode === 'agent' && (
        <>
          <label className="session-editor-field" htmlFor={`${id}-args`}>
            <span className="session-editor-label">{t('sessionSave.editor.args')}</span>
            <TextInput id={`${id}-args`} mono value={draft.argsText} onChange={(event) => update({ argsText: event.target.value })} />
            <span className="session-editor-hint">{t('sessionSave.editor.argsHint')}</span>
          </label>
          <div className="session-editor-field">
            <label className="session-editor-label" htmlFor={`${id}-sid`}>{t('sessionSave.editor.sessionId')}</label>
            <span className="session-editor-combo">
              <TextInput
                id={`${id}-sid`}
                mono
                className={idInvalid ? 'is-invalid' : undefined}
                aria-invalid={idInvalid}
                value={draft.sessionId}
                placeholder={t('sessionSave.editor.sessionIdPlaceholder')}
                onChange={(event) => update({ sessionId: event.target.value.trim() })}
              />
              {candidates.length > 0 && (
                <Select
                  aria-label={t('sessionSave.editor.candidates')}
                  title={t('sessionSave.editor.candidates')}
                  className="session-editor-candidates"
                  value=""
                  onChange={(event) => { if (event.target.value) update({ sessionId: event.target.value }); }}
                >
                  <option value="" />
                  {candidates.map((candidate) => (
                    <option key={candidate.sessionId} value={candidate.sessionId}>{candidateLabel(candidate)}</option>
                  ))}
                </Select>
              )}
            </span>
            <span className={idInvalid ? 'session-editor-hint is-error' : 'session-editor-hint'}>
              {idInvalid ? t('sessionSave.editor.idInvalid') : draft.sessionId ? '' : t('sessionSave.editor.idEmpty')}
            </span>
          </div>
        </>
      )}

      {draft.mode === 'command' && (
        <label className="session-editor-field session-editor-wide" htmlFor={`${id}-cmd`}>
          <span className="session-editor-label">{t('sessionSave.editor.command')}</span>
          <TextInput
            id={`${id}-cmd`}
            mono
            value={draft.command}
            placeholder={t('sessionSave.editor.commandPlaceholder')}
            onChange={(event) => update({ command: event.target.value })}
          />
          <span className="session-editor-hint">{t('sessionSave.editor.commandHint')}</span>
        </label>
      )}

      {draft.mode === 'shell' && (
        <div className="session-editor-field session-editor-wide">
          <span className="session-editor-label">&nbsp;</span>
          <span className="session-editor-note">
            {t('sessionSave.editor.shellNote')}
            {runningCommand && (
              <>
                {' '}
                <button type="button" className="session-editor-link" onClick={() => update({ mode: 'command', command: runningCommand })}>
                  {t('sessionSave.editor.rerun')}
                </button>
              </>
            )}
          </span>
        </div>
      )}

      <div className="session-editor-preview">
        <span>{t('sessionSave.editor.preview')}</span>
        <code className={preview.shellOnly ? 'is-shell' : undefined}>
          {preview.shellOnly ? t('sessionSave.editor.shellOnly') : preview.text}
        </code>
      </div>
    </div>
  );
}
