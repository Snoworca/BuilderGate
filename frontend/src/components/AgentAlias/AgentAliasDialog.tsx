// FR-AITUI-011: the agent command editor (Tools menu). Built-in names are fixed; the user adds
// aliases such as claudep or codexp, which then count as the agent for detection, save and resume.
import { useEffect, useState } from 'react';
import { WindowDialog } from '../dialog';
import { Button, Field, TextInput } from '../ui';
import { t } from '../../i18n/i18n.ts';
import { agentAliasApi, type AgentAliasView } from '../../services/api.ts';
import { formatAliases, parseAliasInput } from './agentAliasModel.ts';
import './AgentAliasDialog.css';

type AgentKey = 'claude' | 'codex';
const AGENTS: ReadonlyArray<{ key: AgentKey; labelKey: 'agentCommands.claude' | 'agentCommands.codex' }> = [
  { key: 'claude', labelKey: 'agentCommands.claude' },
  { key: 'codex', labelKey: 'agentCommands.codex' },
];

export function AgentAliasDialog({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<AgentAliasView | null>(null);
  const [text, setText] = useState<Record<AgentKey, string>>({ claude: '', codex: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    agentAliasApi.get()
      .then((result) => {
        setView(result);
        setText({ claude: formatAliases(result.claude.aliases), codex: formatAliases(result.codex.aliases) });
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const parsed = {
    claude: parseAliasInput(text.claude, view?.claude.builtIn ?? []),
    codex: parseAliasInput(text.codex, view?.codex.builtIn ?? []),
  };
  const invalid = [...parsed.claude.invalid, ...parsed.codex.invalid];

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await agentAliasApi.update({ claude: parsed.claude.names, codex: parsed.codex.names });
      setView(result);
      setText({ claude: formatAliases(result.claude.aliases), codex: formatAliases(result.codex.aliases) });
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <WindowDialog
      dialogId="agent-command-manager"
      title={t('agentCommands.title')}
      mode="modal"
      defaultRect={{ x: 160, y: 110, width: 620, height: 440 }}
      minSize={{ width: 460, height: 360 }}
      onClose={onClose}
    >
      <div className="agent-alias-dialog" data-testid="agent-alias-dialog">
        <p className="agent-alias-help">{t('agentCommands.help')}</p>
        {AGENTS.map(({ key, labelKey }) => (
          <section key={key} className="agent-alias-section">
            <h3 className="agent-alias-title">{t(labelKey)}</h3>
            <div className="agent-alias-builtin">
              <span className="agent-alias-builtin-label">{t('agentCommands.builtIn')}</span>
              {(view?.[key].builtIn ?? []).map((name) => <code key={name} className="agent-alias-chip">{name}</code>)}
            </div>
            <Field label={t('agentCommands.aliases')} htmlFor={`agent-alias-${key}`}>
              <TextInput
                id={`agent-alias-${key}`}
                value={text[key]}
                placeholder={key === 'claude' ? 'claudep claudex' : 'codexp'}
                onChange={(event) => { setSaved(false); setText((current) => ({ ...current, [key]: event.target.value })); }}
              />
            </Field>
          </section>
        ))}
        {invalid.length > 0 && <div className="agent-alias-error" role="alert">{t('agentCommands.invalid', { names: invalid.join(', ') })}</div>}
        {error !== null && <div className="agent-alias-error" role="alert">{error}</div>}
        <div className="agent-alias-actions">
          {saved && <span className="agent-alias-saved" role="status">{t('agentCommands.saved')}</span>}
          <Button variant="secondary" size="md" onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" size="md" disabled={saving || view === null || invalid.length > 0} onClick={() => void save()}>{t('common.save')}</Button>
        </div>
      </div>
    </WindowDialog>
  );
}
