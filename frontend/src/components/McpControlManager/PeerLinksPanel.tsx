// FR-MCP-020 (#233): Tools > MCP settings > Remote links. Shows the link state (refreshed while the
// tab is open) and edits this server's name, the remotes it connects to, and heartbeat/queue limits.
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../common/Icon';
import { Button, Checkbox, Field, Switch, TextInput } from '../ui';
import { mcpControlApi } from '../../services/api';
import { t } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import {
  buildPeerLinksPatch,
  createPeerLinksDraft,
  describePeerFieldErrors,
  effectivePeerTimeoutSeconds,
  emptyPeerLinkRow,
  peerStateLabelKey,
  type PeerLinkRow,
  type PeerLinksDraft,
  type PeerLinksResponse,
} from './peerLinksModel';

const STATUS_REFRESH_MS = 5_000;

const SCOPE_LABELS: Record<string, MessageKey> = {
  'mcp:sessions.list': 'mcp.peers.scope.sessionsList',
  'mcp:sessions.search': 'mcp.peers.scope.sessionsSearch',
  'mcp:message.paste': 'mcp.peers.scope.messagePaste',
  'mcp:message.submit': 'mcp.peers.scope.messageSubmit',
};

type NumberField = 'heartbeatSecondsText' | 'timeoutSecondsText' | 'queueTtlSecondsText' | 'keyQueueTtlSecondsText' | 'maxQueuedMessagesText';

export function PeerLinksPanel({ active }: { active: boolean }) {
  const [data, setData] = useState<PeerLinksResponse | null>(null);
  const [draft, setDraft] = useState<PeerLinksDraft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<NumberField, MessageKey>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string; lines?: string[] } | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (resetDraft: boolean) => {
    try {
      const next = await mcpControlApi.getPeers();
      setData(next);
      if (resetDraft) setDraft(createPeerLinksDraft(next.settings));
    } catch (error) {
      if (resetDraft) setMessage({ kind: 'error', text: t('mcp.peers.loadFailed') });
      console.warn('[PeerLinks] load failed', error);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void load(true);
    const timer = window.setInterval(() => void load(false), STATUS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const update = <K extends keyof PeerLinksDraft>(key: K, value: PeerLinksDraft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };
  const updateRow = (index: number, patch: Partial<PeerLinkRow>) => {
    setDraft((current) => (current
      ? { ...current, links: current.links.map((row, i) => (i === index ? { ...row, ...patch } : row)) }
      : current));
  };

  const save = async () => {
    if (!draft) return;
    const built = buildPeerLinksPatch(draft);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    setMessage(null);
    try {
      // The messenger adds and renames links while this panel is open: merge onto a fresh read
      // rather than writing the list this panel loaded back over them.
      const current = await mcpControlApi.getPeers();
      const merged = buildPeerLinksPatch(draft, current.settings);
      if (!merged.ok) {
        setErrors(merged.errors);
        return;
      }
      const next = await mcpControlApi.putPeers(merged.patch);
      if (next.ok === false) {
        setMessage({
          kind: 'error',
          text: t('mcp.peers.saveFailed', { detail: next.code }),
          lines: describePeerFieldErrors(next.fieldErrors ?? {}),
        });
        return;
      }
      setData(next);
      setDraft(createPeerLinksDraft(next.settings));
      setMessage({ kind: 'ok', text: t('mcp.peers.saved') });
    } catch (error) {
      setMessage({ kind: 'error', text: t('mcp.peers.saveFailed', { detail: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setSaving(false);
    }
  };

  if (!draft || !data) {
    return <div className="mcp-control-empty">{loaded ? (message?.text ?? t('mcp.peers.loadFailed')) : t('mcp.peers.loading')}</div>;
  }
  const autoTimeout = effectivePeerTimeoutSeconds({ heartbeatSecondsText: draft.heartbeatSecondsText, timeoutSecondsText: '' });
  const numberField = (field: NumberField, label: MessageKey, unit: 'seconds' | 'count', help?: string) => (
    <Field label={t(label)} htmlFor={`mcp-peers-${field}`} className="mcp-control-field" help={help} error={errors[field] ? t(errors[field]!) : undefined}>
      <span className="ui-unit-wrap">
        <TextInput
          id={`mcp-peers-${field}`}
          value={draft[field]}
          inputMode="decimal"
          onChange={(event) => update(field, event.target.value)}
        />
        {unit === 'seconds' && <span className="ui-unit" aria-hidden="true">{t('mcp.security.unitSeconds')}</span>}
      </span>
    </Field>
  );

  return (
    <div className="mcp-control-section">
      <p className="mcp-peers-intro">{t('mcp.peers.intro')}</p>

      <h3 className="mcp-peers-heading">{t('mcp.peers.statusTitle')}</h3>
      {data.peers.length === 0 ? (
        <div className="mcp-control-empty">{t('mcp.peers.statusEmpty')}</div>
      ) : (
        <dl className="mcp-control-status-grid mcp-peers-status">
          {data.peers.map((peer) => (
            <div key={`${peer.direction}:${peer.name}`} className="mcp-peers-status-row">
              <dt>
                <span className={`mcp-peers-dot is-${peer.state}`} aria-hidden="true" />
                {peer.name}
              </dt>
              <dd>
                {t(peerStateLabelKey(peer.state))}
                {' · '}
                {t(peer.direction === 'outbound' ? 'mcp.peers.direction.outbound' : 'mcp.peers.direction.inbound')}
                {' · '}
                {t('mcp.peers.col.queued')} {peer.queued}
                {peer.lastError && <span className="mcp-peers-error"> · {t('mcp.peers.col.lastError')} {peer.lastError}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mcp-control-form-grid">
        <Field label={t('mcp.peers.nodeName')} htmlFor="mcp-peers-node-name" className="mcp-control-field" help={t('mcp.peers.nodeNameHelp')}>
          <TextInput id="mcp-peers-node-name" mono value={draft.nodeName} spellCheck={false} onChange={(event) => update('nodeName', event.target.value)} />
        </Field>
      </div>

      <h3 className="mcp-peers-heading">{t('mcp.peers.linksTitle')}</h3>
      {draft.links.length === 0 && <div className="mcp-control-empty">{t('mcp.peers.linksEmpty')}</div>}
      {draft.links.map((row, index) => (
        <div key={index} className="mcp-control-item mcp-peers-link">
          <div className="mcp-peers-link-grid">
            <Field label={t('mcp.peers.link.name')} htmlFor={`mcp-peers-link-name-${index}`} className="mcp-control-field">
              <TextInput id={`mcp-peers-link-name-${index}`} mono value={row.name} spellCheck={false} onChange={(event) => updateRow(index, { name: event.target.value })} />
            </Field>
            <Field label={t('mcp.peers.link.url')} htmlFor={`mcp-peers-link-url-${index}`} className="mcp-control-field mcp-peers-wide">
              <TextInput id={`mcp-peers-link-url-${index}`} mono value={row.url} placeholder="wss://host:port/mcp/peer" spellCheck={false} onChange={(event) => updateRow(index, { url: event.target.value })} />
            </Field>
            <Field
              label={t('mcp.peers.link.accessKey')}
              htmlFor={`mcp-peers-link-key-${index}`}
              className="mcp-control-field"
              help={row.hasAccessKey ? t('mcp.peers.link.accessKeyStored') : undefined}
            >
              <TextInput id={`mcp-peers-link-key-${index}`} type="password" mono autoComplete="off" value={row.accessKey} onChange={(event) => updateRow(index, { accessKey: event.target.value })} />
            </Field>
            <Field label={t('mcp.peers.link.fingerprint')} htmlFor={`mcp-peers-link-fp-${index}`} className="mcp-control-field mcp-peers-wide">
              <TextInput id={`mcp-peers-link-fp-${index}`} mono value={row.tlsFingerprintSha256} spellCheck={false} onChange={(event) => updateRow(index, { tlsFingerprintSha256: event.target.value })} />
            </Field>
          </div>
          <div className="mcp-control-item-actions">
            <Switch checked={row.enabled} onChange={(event) => updateRow(index, { enabled: event.target.checked })}>
              {t('mcp.peers.link.enabled')}
            </Switch>
            <Button
              variant="secondary"
              size="sm"
              icon="trash"
              onClick={() => update('links', draft.links.filter((_, i) => i !== index))}
            >
              {t('mcp.peers.link.remove')}
            </Button>
          </div>
        </div>
      ))}
      <div className="mcp-control-actions mcp-peers-add">
        <Button variant="secondary" size="sm" icon="plus" onClick={() => update('links', [...draft.links, emptyPeerLinkRow()])}>
          {t('mcp.peers.addLink')}
        </Button>
      </div>

      <h3 className="mcp-peers-heading">{t('mcp.peers.advancedTitle')}</h3>
      <div className="mcp-control-form-grid">
        {numberField('heartbeatSecondsText', 'mcp.peers.heartbeat', 'seconds')}
        {numberField('timeoutSecondsText', 'mcp.peers.timeout', 'seconds',
          autoTimeout === undefined ? undefined : t('mcp.peers.timeoutAuto', { seconds: autoTimeout }))}
        {numberField('queueTtlSecondsText', 'mcp.peers.queueTtl', 'seconds')}
        {numberField('keyQueueTtlSecondsText', 'mcp.peers.keyQueueTtl', 'seconds')}
        {numberField('maxQueuedMessagesText', 'mcp.peers.maxQueued', 'count')}
      </div>

      <Field label={t('mcp.peers.inboundScopes')} className="mcp-control-field" help={t('mcp.peers.inboundHelp')}>
        <div className="mcp-peers-scopes">
          {data.defaults.inboundScopeChoices.map((scope) => (
            <Checkbox
              key={scope}
              checked={draft.inboundScopes.includes(scope)}
              onChange={(event) => update('inboundScopes', event.target.checked
                ? [...draft.inboundScopes, scope]
                : draft.inboundScopes.filter((item) => item !== scope))}
            >
              {SCOPE_LABELS[scope] ? t(SCOPE_LABELS[scope]!) : scope}
            </Checkbox>
          ))}
        </div>
      </Field>

      {message && (
        <div className={message.kind === 'ok' ? 'mcp-control-toast' : 'mcp-control-error'} role={message.kind === 'ok' ? 'status' : 'alert'}>
          <Icon name={message.kind === 'ok' ? 'check-circle' : 'alert'} size={14} />
          <span>
            {message.text}
            {message.lines && message.lines.length > 0 && (
              <ul className="mcp-peers-field-errors">
                {message.lines.map((line) => <li key={line}>{line}</li>)}
              </ul>
            )}
          </span>
        </div>
      )}

      <div className="mcp-control-actions">
        <Button variant="secondary" size="md" icon="refresh" onClick={() => void load(true)} disabled={saving}>
          {t('common.refresh')}
        </Button>
        <Button variant="primary" size="md" onClick={() => void save()} disabled={saving}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
