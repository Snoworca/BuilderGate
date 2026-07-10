import { useCallback, useEffect, useMemo, useState } from 'react';
import { WindowDialog } from '../dialog';
import { mcpControlApi } from '../../services/api';
import type {
  McpAgentProfile,
  McpClientConfigMode,
  McpControlConfig,
  McpSessionRecord,
  McpWebhookCreateResponse,
  McpWebhookKey,
} from '../../types';
import {
  buildMcpControlConfigPatch,
  createMcpSecurityDraft,
  parseMcpControlListInput,
  validateMcpWebhookDraft,
  validateMcpSecurityDraft,
  type McpSecurityDraft,
} from './mcpControlDialogModel';
import './McpControlDialog.css';

export interface McpControlDialogProps {
  open: boolean;
  onClose: () => void;
}

type McpControlTab = 'security' | 'agents' | 'webhooks' | 'sessions' | 'status';

interface AgentDraft {
  displayName: string;
  command: string;
  argsText: string;
  aliasesText: string;
  enabled: boolean;
  kickoffPrompt: string;
  mcpClientConfigMode: McpClientConfigMode;
}

interface WebhookDraft {
  targetSessionKey: string;
  profileId: string;
  mode: string;
  scopesText: string;
  expiresAt: string;
}

const TAB_DEFINITIONS: Array<{ id: McpControlTab; label: string }> = [
  { id: 'security', label: 'Security' },
  { id: 'agents', label: 'Agent Profiles' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'status', label: 'Audit/Status' },
];

const DEFAULT_AGENT_DRAFT: AgentDraft = {
  displayName: '',
  command: '',
  argsText: '',
  aliasesText: '',
  enabled: true,
  kickoffPrompt: '',
  mcpClientConfigMode: 'generated-file',
};

const DEFAULT_WEBHOOK_DRAFT: WebhookDraft = {
  targetSessionKey: '',
  profileId: '',
  mode: 'paste',
  scopesText: 'mcp:webhook.invoke',
  expiresAt: '',
};

const DEFAULT_REPLY_TEST_PROMPT = 'Hello, World!';

export function McpControlDialog({ open, onClose }: McpControlDialogProps) {
  const [activeTab, setActiveTab] = useState<McpControlTab>('security');
  const [config, setConfig] = useState<McpControlConfig | null>(null);
  const [securityDraft, setSecurityDraft] = useState<McpSecurityDraft | null>(null);
  const [agents, setAgents] = useState<McpAgentProfile[]>([]);
  const [webhooks, setWebhooks] = useState<McpWebhookKey[]>([]);
  const [sessions, setSessions] = useState<McpSessionRecord[]>([]);
  const [agentDraft, setAgentDraft] = useState<AgentDraft>(DEFAULT_AGENT_DRAFT);
  const [webhookDraft, setWebhookDraft] = useState<WebhookDraft>(DEFAULT_WEBHOOK_DRAFT);
  const [webhookCredential, setWebhookCredential] = useState<McpWebhookCreateResponse | null>(null);
  const [sessionQuery, setSessionQuery] = useState('');
  const [aliasDrafts, setAliasDrafts] = useState<Record<string, string>>({});
  const [replyPrompt, setReplyPrompt] = useState(DEFAULT_REPLY_TEST_PROMPT);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const updateAliasDrafts = useCallback((records: McpSessionRecord[]) => {
    setAliasDrafts((current) => {
      const next: Record<string, string> = {};
      for (const session of records) {
        next[session.sessionKey] = current[session.sessionKey] ?? session.alias ?? '';
      }
      return next;
    });
  }, []);

  const loadConfig = useCallback(async () => {
    const nextConfig = await mcpControlApi.getConfig();
    setConfig(nextConfig);
    setSecurityDraft(createMcpSecurityDraft(nextConfig));
  }, []);

  const loadAgents = useCallback(async () => {
    setAgents(await mcpControlApi.listAgents());
  }, []);

  const loadWebhooks = useCallback(async () => {
    setWebhooks(await mcpControlApi.listWebhooks());
  }, []);

  const loadSessions = useCallback(async (query = '') => {
    const result = await mcpControlApi.listSessions({
      query: query.trim() || undefined,
      includeSelf: true,
    });
    const records = result.matches ?? result.sessions;
    setSessions(records);
    updateAliasDrafts(records);
  }, [updateAliasDrafts]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWebhookCredential(null);
    try {
      await Promise.all([
        loadConfig(),
        loadAgents(),
        loadWebhooks(),
        loadSessions(''),
      ]);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [loadAgents, loadConfig, loadSessions, loadWebhooks]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadAll();
  }, [loadAll, open]);

  useEffect(() => {
    if (activeTab !== 'webhooks') {
      setWebhookCredential(null);
    }
  }, [activeTab]);

  const visibleTabs = useMemo(() => TAB_DEFINITIONS, []);

  const updateSecurityDraft = useCallback(<K extends keyof McpSecurityDraft>(
    key: K,
    value: McpSecurityDraft[K],
  ) => {
    setSecurityDraft(current => current ? { ...current, [key]: value } : current);
  }, []);

  const handleSaveSecurity = useCallback(async () => {
    if (!securityDraft) return;
    const validationError = validateMcpSecurityDraft(securityDraft);
    if (validationError) {
      setError(validationError);
      setStatusMessage(null);
      return;
    }

    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const nextConfig = await mcpControlApi.patchConfig(buildMcpControlConfigPatch(securityDraft));
      setConfig(nextConfig);
      setSecurityDraft(createMcpSecurityDraft(nextConfig));
      setStatusMessage('MCP 보안 설정을 저장했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [securityDraft]);

  const handleCreateAgent = useCallback(async () => {
    const displayName = agentDraft.displayName.trim();
    const command = agentDraft.command.trim();
    if (!displayName || !command) {
      setError('Agent profile은 이름과 command가 필요합니다.');
      return;
    }

    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      await mcpControlApi.createAgent({
        displayName,
        command,
        args: parseMcpControlListInput(agentDraft.argsText),
        aliases: parseMcpControlListInput(agentDraft.aliasesText),
        enabled: agentDraft.enabled,
        kickoffPrompt: agentDraft.kickoffPrompt.trim() || undefined,
        mcpClientConfigMode: agentDraft.mcpClientConfigMode,
      });
      setAgentDraft(DEFAULT_AGENT_DRAFT);
      await loadAgents();
      setStatusMessage('Agent profile을 추가했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [agentDraft, loadAgents]);

  const handleToggleAgent = useCallback(async (agent: McpAgentProfile) => {
    setSaving(true);
    setError(null);
    try {
      await mcpControlApi.updateAgent(agent.id, { enabled: !agent.enabled });
      await loadAgents();
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [loadAgents]);

  const handleDeleteAgent = useCallback(async (agent: McpAgentProfile) => {
    setSaving(true);
    setError(null);
    try {
      await mcpControlApi.deleteAgent(agent.id);
      await loadAgents();
      setStatusMessage('Agent profile을 삭제했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [loadAgents]);

  const handleCreateWebhook = useCallback(async () => {
    const validationError = validateMcpWebhookDraft(webhookDraft);
    if (validationError) {
      setError(validationError);
      setStatusMessage(null);
      return;
    }

    setSaving(true);
    setError(null);
    setStatusMessage(null);
    setWebhookCredential(null);
    try {
      const response = await mcpControlApi.createWebhook({
        targetSessionKey: webhookDraft.targetSessionKey.trim() || undefined,
        profileId: webhookDraft.profileId.trim() || undefined,
        mode: webhookDraft.mode.trim() || undefined,
        scopes: parseMcpControlListInput(webhookDraft.scopesText),
        expiresAt: webhookDraft.expiresAt.trim() || undefined,
      });
      setWebhookCredential(response);
      setWebhookDraft(DEFAULT_WEBHOOK_DRAFT);
      await loadWebhooks();
      setStatusMessage('Webhook key를 생성했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [loadWebhooks, webhookDraft]);

  const handleRotateWebhook = useCallback(async (webhook: McpWebhookKey) => {
    setSaving(true);
    setError(null);
    setWebhookCredential(null);
    try {
      const response = await mcpControlApi.rotateWebhook(getWebhookId(webhook));
      setWebhookCredential(response);
      await loadWebhooks();
      setStatusMessage('Webhook key를 회전했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [loadWebhooks]);

  const handleRevokeWebhook = useCallback(async (webhook: McpWebhookKey) => {
    setSaving(true);
    setError(null);
    setWebhookCredential(null);
    try {
      await mcpControlApi.revokeWebhook(getWebhookId(webhook));
      await loadWebhooks();
      setStatusMessage('Webhook key를 폐기했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [loadWebhooks]);

  const handleReloadWebhooks = useCallback(async () => {
    setWebhookCredential(null);
    await loadWebhooks();
  }, [loadWebhooks]);

  const handleSessionSearch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadSessions(sessionQuery);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [loadSessions, sessionQuery]);

  const handleSessionSearchTest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await mcpControlApi.searchTest(sessionQuery);
      setSessions(result.matches);
      updateAliasDrafts(result.matches);
      setStatusMessage(`검색 결과 ${result.matches.length}건`);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [sessionQuery, updateAliasDrafts]);

  const handleSaveAlias = useCallback(async (session: McpSessionRecord) => {
    setSaving(true);
    setError(null);
    try {
      await mcpControlApi.setSessionAlias(session.sessionKey, aliasDrafts[session.sessionKey] ?? '');
      await loadSessions(sessionQuery);
      setStatusMessage('세션 별칭을 저장했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [aliasDrafts, loadSessions, sessionQuery]);

  const handleReplyTest = useCallback(async (session: McpSessionRecord) => {
    const prompt = replyPrompt.trim();
    if (!prompt) {
      setError('전달 테스트 prompt가 필요합니다.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await mcpControlApi.replyTest(session.sessionKey, prompt);
      setStatusMessage(result.accepted ? '메시지 전달 테스트를 접수했습니다.' : `전달 테스트 거부: ${result.code ?? 'unknown'}`);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [replyPrompt]);

  const handleCloseSession = useCallback(async (session: McpSessionRecord) => {
    const confirmationNonce = session.closeConfirmationNonce;
    if (!confirmationNonce) {
      setError('이 세션에는 닫기 확인 nonce가 없습니다. 세션 목록을 다시 조회하십시오.');
      return;
    }

    if (!window.confirm(`${session.alias || session.name || session.sessionKey} 세션을 닫습니까?`)) {
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await mcpControlApi.closeSession(session.sessionKey, {
        confirmClose: true,
        expectedSessionKey: session.sessionKey,
        confirmationNonce,
      });
      setStatusMessage(result.ok ? '세션 닫기 요청을 접수했습니다.' : `세션 닫기 거부: ${result.code ?? result.status ?? 'unknown'}`);
      await loadSessions(sessionQuery);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [loadSessions, sessionQuery]);

  if (!open) {
    return null;
  }

  return (
    <WindowDialog
      dialogId="mcp-control-manager"
      title="MCP 관리"
      mode="modal"
      defaultRect={{ x: 160, y: 88, width: 860, height: 620 }}
      minSize={{ width: 680, height: 480 }}
      onClose={onClose}
      surfaceClassName="mcp-control-dialog-surface"
    >
      <div className="mcp-control-dialog" data-testid="mcp-control-dialog">
        <div className="mcp-control-tabs" role="tablist" aria-label="MCP 관리 탭">
          {visibleTabs.map(tab => (
            <button
              key={tab.id}
              id={`mcp-control-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`mcp-control-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={`mcp-control-tab${activeTab === tab.id ? ' is-active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {loading && <div className="mcp-control-loading" role="status">불러오는 중</div>}
        {error && <div className="mcp-control-error" role="alert">{error}</div>}
        {statusMessage && <div className="mcp-control-toast" role="status">{statusMessage}</div>}

        <section
          id="mcp-control-panel-security"
          role="tabpanel"
          aria-labelledby="mcp-control-tab-security"
          hidden={activeTab !== 'security'}
          className="mcp-control-panel"
        >
          {renderSecurityPanel({
            config,
            draft: securityDraft,
            saving,
            onDraftChange: updateSecurityDraft,
            onSave: handleSaveSecurity,
            onReload: loadConfig,
          })}
        </section>

        <section
          id="mcp-control-panel-agents"
          role="tabpanel"
          aria-labelledby="mcp-control-tab-agents"
          hidden={activeTab !== 'agents'}
          className="mcp-control-panel"
        >
          {renderAgentsPanel({
            agents,
            draft: agentDraft,
            saving,
            onDraftChange: setAgentDraft,
            onCreate: handleCreateAgent,
            onToggle: handleToggleAgent,
            onDelete: handleDeleteAgent,
            onReload: loadAgents,
          })}
        </section>

        <section
          id="mcp-control-panel-webhooks"
          role="tabpanel"
          aria-labelledby="mcp-control-tab-webhooks"
          hidden={activeTab !== 'webhooks'}
          className="mcp-control-panel"
        >
          {renderWebhooksPanel({
            webhooks,
            draft: webhookDraft,
            credential: webhookCredential,
            saving,
            onDraftChange: setWebhookDraft,
            onCreate: handleCreateWebhook,
            onRotate: handleRotateWebhook,
            onRevoke: handleRevokeWebhook,
            onReload: handleReloadWebhooks,
            onDismissCredential: () => setWebhookCredential(null),
          })}
        </section>

        <section
          id="mcp-control-panel-sessions"
          role="tabpanel"
          aria-labelledby="mcp-control-tab-sessions"
          hidden={activeTab !== 'sessions'}
          className="mcp-control-panel"
        >
          {renderSessionsPanel({
            sessions,
            query: sessionQuery,
            aliasDrafts,
            replyPrompt,
            saving,
            onQueryChange: setSessionQuery,
            onAliasChange: setAliasDrafts,
            onReplyPromptChange: setReplyPrompt,
            onSearch: handleSessionSearch,
            onSearchTest: handleSessionSearchTest,
            onSaveAlias: handleSaveAlias,
            onReplyTest: handleReplyTest,
            onCloseSession: handleCloseSession,
          })}
        </section>

        <section
          id="mcp-control-panel-status"
          role="tabpanel"
          aria-labelledby="mcp-control-tab-status"
          hidden={activeTab !== 'status'}
          className="mcp-control-panel"
        >
          {renderStatusPanel({ config, agents, webhooks, sessions, onReload: loadAll })}
        </section>
      </div>
    </WindowDialog>
  );
}

function renderSecurityPanel({
  config,
  draft,
  saving,
  onDraftChange,
  onSave,
  onReload,
}: {
  config: McpControlConfig | null;
  draft: McpSecurityDraft | null;
  saving: boolean;
  onDraftChange: <K extends keyof McpSecurityDraft>(key: K, value: McpSecurityDraft[K]) => void;
  onSave: () => void;
  onReload: () => void;
}) {
  if (!draft) {
    return <div className="mcp-control-empty">MCP 설정을 불러오지 못했습니다.</div>;
  }

  return (
    <div className="mcp-control-section">
      <div className="mcp-control-form-grid">
        <label className="mcp-control-field mcp-control-checkbox-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onDraftChange('enabled', event.target.checked)}
          />
          <span>MCP endpoint enabled</span>
        </label>

        <label className="mcp-control-field">
          <span>Bind mode</span>
          <select
            value={draft.bindMode}
            onChange={(event) => onDraftChange('bindMode', event.target.value)}
          >
            <option value="loopback">loopback</option>
            <option value="whitelist">whitelist</option>
          </select>
        </label>

        <label className="mcp-control-field">
          <span>Host</span>
          <input
            value={draft.host}
            onChange={(event) => onDraftChange('host', event.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="mcp-control-field">
          <span>Port</span>
          <input
            value={draft.portText}
            inputMode="numeric"
            onChange={(event) => onDraftChange('portText', event.target.value)}
          />
        </label>

        <label className="mcp-control-field">
          <span>Transport security</span>
          <select
            value={draft.transportSecurity}
            onChange={(event) => onDraftChange('transportSecurity', event.target.value)}
          >
            <option value="none">none</option>
            <option value="direct_tls">direct_tls</option>
            <option value="trusted_tls_proxy">trusted_tls_proxy</option>
          </select>
        </label>

        <label className="mcp-control-field">
          <span>Webhook header</span>
          <input
            value={draft.webhookKeyHeaderName}
            onChange={(event) => onDraftChange('webhookKeyHeaderName', event.target.value)}
            spellCheck={false}
          />
        </label>

        <label className="mcp-control-field">
          <span>Webhook rate window seconds</span>
          <input
            value={draft.webhookRateLimitWindowSecondsText}
            inputMode="numeric"
            onChange={(event) => onDraftChange('webhookRateLimitWindowSecondsText', event.target.value)}
          />
        </label>

        <label className="mcp-control-field">
          <span>Webhook burst limit</span>
          <input
            value={draft.webhookRateLimitBurstLimitText}
            inputMode="numeric"
            onChange={(event) => onDraftChange('webhookRateLimitBurstLimitText', event.target.value)}
          />
        </label>
      </div>

      <div className="mcp-control-textarea-grid">
        <label className="mcp-control-field">
          <span>외부 IP/CIDR whitelist</span>
          <textarea
            value={draft.externalWhitelistText}
            onChange={(event) => onDraftChange('externalWhitelistText', event.target.value)}
            rows={5}
            spellCheck={false}
          />
        </label>

        <label className="mcp-control-field">
          <span>Trusted proxies</span>
          <textarea
            value={draft.trustedProxiesText}
            onChange={(event) => onDraftChange('trustedProxiesText', event.target.value)}
            rows={5}
            spellCheck={false}
          />
        </label>

        <label className="mcp-control-field">
          <span>Allowed origins</span>
          <textarea
            value={draft.allowedOriginsText}
            onChange={(event) => onDraftChange('allowedOriginsText', event.target.value)}
            rows={5}
            spellCheck={false}
          />
        </label>
      </div>

      <div className="mcp-control-status-strip">
        <span>Status: {config?.status ?? 'unknown'}</span>
        <span>Last rebind: {summarizeUnknown(config?.lastRebindResult)}</span>
      </div>

      <div className="mcp-control-actions">
        <button type="button" className="mcp-control-secondary-button" onClick={onReload} disabled={saving}>
          새로고침
        </button>
        <button type="button" className="mcp-control-primary-button" onClick={onSave} disabled={saving}>
          저장
        </button>
      </div>
    </div>
  );
}

function renderAgentsPanel({
  agents,
  draft,
  saving,
  onDraftChange,
  onCreate,
  onToggle,
  onDelete,
  onReload,
}: {
  agents: McpAgentProfile[];
  draft: AgentDraft;
  saving: boolean;
  onDraftChange: (draft: AgentDraft) => void;
  onCreate: () => void;
  onToggle: (agent: McpAgentProfile) => void;
  onDelete: (agent: McpAgentProfile) => void;
  onReload: () => void;
}) {
  return (
    <div className="mcp-control-section">
      <div className="mcp-control-form-grid">
        <label className="mcp-control-field">
          <span>Profile name</span>
          <input
            value={draft.displayName}
            onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })}
          />
        </label>
        <label className="mcp-control-field">
          <span>Command</span>
          <input
            value={draft.command}
            onChange={(event) => onDraftChange({ ...draft, command: event.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="mcp-control-field">
          <span>Config mode</span>
          <select
            value={draft.mcpClientConfigMode}
            onChange={(event) => onDraftChange({ ...draft, mcpClientConfigMode: event.target.value as McpClientConfigMode })}
          >
            <option value="generated-file">generated-file</option>
            <option value="env">env</option>
            <option value="manual">manual</option>
          </select>
        </label>
        <label className="mcp-control-field mcp-control-checkbox-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })}
          />
          <span>Enabled</span>
        </label>
      </div>
      <div className="mcp-control-textarea-grid">
        <label className="mcp-control-field">
          <span>Args</span>
          <textarea value={draft.argsText} rows={3} onChange={(event) => onDraftChange({ ...draft, argsText: event.target.value })} />
        </label>
        <label className="mcp-control-field">
          <span>Aliases</span>
          <textarea value={draft.aliasesText} rows={3} onChange={(event) => onDraftChange({ ...draft, aliasesText: event.target.value })} />
        </label>
        <label className="mcp-control-field">
          <span>Kickoff prompt</span>
          <textarea value={draft.kickoffPrompt} rows={3} onChange={(event) => onDraftChange({ ...draft, kickoffPrompt: event.target.value })} />
        </label>
      </div>
      <div className="mcp-control-actions">
        <button type="button" className="mcp-control-secondary-button" onClick={onReload} disabled={saving}>새로고침</button>
        <button type="button" className="mcp-control-primary-button" onClick={onCreate} disabled={saving}>추가</button>
      </div>
      <div className="mcp-control-list" aria-label="Agent Profiles 목록">
        {agents.length === 0 ? (
          <div className="mcp-control-empty">등록된 agent profile이 없습니다.</div>
        ) : agents.map(agent => (
          <div key={agent.id} className="mcp-control-item">
            <div className="mcp-control-item-main">
              <h3>{agent.displayName}</h3>
              <div className="mcp-control-item-meta">
                <span>{agent.commandSummary ?? [agent.command, ...agent.args].join(' ')}</span>
                <span>{agent.enabled ? 'enabled' : 'disabled'}</span>
                <span>{agent.mcpClientConfigMode}</span>
              </div>
            </div>
            <div className="mcp-control-item-actions">
              <button type="button" onClick={() => onToggle(agent)} disabled={saving}>
                {agent.enabled ? '비활성' : '활성'}
              </button>
              <button type="button" onClick={() => onDelete(agent)} disabled={saving}>
                삭제
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderWebhooksPanel({
  webhooks,
  draft,
  credential,
  saving,
  onDraftChange,
  onCreate,
  onRotate,
  onRevoke,
  onReload,
  onDismissCredential,
}: {
  webhooks: McpWebhookKey[];
  draft: WebhookDraft;
  credential: McpWebhookCreateResponse | null;
  saving: boolean;
  onDraftChange: (draft: WebhookDraft) => void;
  onCreate: () => void;
  onRotate: (webhook: McpWebhookKey) => void;
  onRevoke: (webhook: McpWebhookKey) => void;
  onReload: () => void;
  onDismissCredential: () => void;
}) {
  return (
    <div className="mcp-control-section">
      <div className="mcp-control-form-grid">
        <label className="mcp-control-field">
          <span>Target session</span>
          <input value={draft.targetSessionKey} onChange={(event) => onDraftChange({ ...draft, targetSessionKey: event.target.value })} />
        </label>
        <label className="mcp-control-field">
          <span>Profile id</span>
          <input value={draft.profileId} onChange={(event) => onDraftChange({ ...draft, profileId: event.target.value })} />
        </label>
        <label className="mcp-control-field">
          <span>Mode</span>
          <input value={draft.mode} onChange={(event) => onDraftChange({ ...draft, mode: event.target.value })} />
        </label>
        <label className="mcp-control-field">
          <span>Expires at</span>
          <input value={draft.expiresAt} onChange={(event) => onDraftChange({ ...draft, expiresAt: event.target.value })} />
        </label>
      </div>
      <label className="mcp-control-field">
        <span>Scopes</span>
        <textarea value={draft.scopesText} rows={3} onChange={(event) => onDraftChange({ ...draft, scopesText: event.target.value })} />
      </label>
      {credential && (
        <div className="mcp-control-credential" role="status">
          <label className="mcp-control-field">
            <span>Full key</span>
            <input value={credential.fullKey} readOnly autoComplete="off" />
          </label>
          <label className="mcp-control-field">
            <span>Full URL</span>
            <input value={credential.fullUrl} readOnly autoComplete="off" />
          </label>
          <div className="mcp-control-actions">
            <button type="button" className="mcp-control-secondary-button" onClick={onDismissCredential}>
              숨기기
            </button>
          </div>
        </div>
      )}
      <div className="mcp-control-actions">
        <button type="button" className="mcp-control-secondary-button" onClick={onReload} disabled={saving}>새로고침</button>
        <button type="button" className="mcp-control-primary-button" onClick={onCreate} disabled={saving}>키 생성</button>
      </div>
      <div className="mcp-control-list" aria-label="Webhooks 목록">
        {webhooks.length === 0 ? (
          <div className="mcp-control-empty">등록된 webhook key가 없습니다.</div>
        ) : webhooks.map(webhook => (
          <div key={getWebhookId(webhook)} className="mcp-control-item">
            <div className="mcp-control-item-main">
              <h3>{webhook.maskedKey || getWebhookId(webhook)}</h3>
              <div className="mcp-control-item-meta">
                <span>{webhook.revoked ? 'revoked' : 'active'}</span>
                <span>{webhook.targetSessionKey ?? 'no-session-target'}</span>
                <span>{webhook.scopes.join(', ')}</span>
              </div>
            </div>
            <div className="mcp-control-item-actions">
              <button type="button" onClick={() => onRotate(webhook)} disabled={saving || webhook.revoked}>회전</button>
              <button type="button" onClick={() => onRevoke(webhook)} disabled={saving || webhook.revoked}>폐기</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderSessionsPanel({
  sessions,
  query,
  aliasDrafts,
  replyPrompt,
  saving,
  onQueryChange,
  onAliasChange,
  onReplyPromptChange,
  onSearch,
  onSearchTest,
  onSaveAlias,
  onReplyTest,
  onCloseSession,
}: {
  sessions: McpSessionRecord[];
  query: string;
  aliasDrafts: Record<string, string>;
  replyPrompt: string;
  saving: boolean;
  onQueryChange: (query: string) => void;
  onAliasChange: (updater: (current: Record<string, string>) => Record<string, string>) => void;
  onReplyPromptChange: (prompt: string) => void;
  onSearch: () => void;
  onSearchTest: () => void;
  onSaveAlias: (session: McpSessionRecord) => void;
  onReplyTest: (session: McpSessionRecord) => void;
  onCloseSession: (session: McpSessionRecord) => void;
}) {
  return (
    <div className="mcp-control-section">
      <div className="mcp-control-session-search">
        <label className="mcp-control-field">
          <span>Search</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} />
        </label>
        <div className="mcp-control-actions">
          <button type="button" className="mcp-control-secondary-button" onClick={onSearch} disabled={saving}>조회</button>
          <button type="button" className="mcp-control-secondary-button" onClick={onSearchTest} disabled={saving}>검색 테스트</button>
        </div>
      </div>
      <label className="mcp-control-field">
        <span>Reply test prompt</span>
        <input value={replyPrompt} onChange={(event) => onReplyPromptChange(event.target.value)} />
      </label>
      <div className="mcp-control-list" aria-label="Sessions 목록">
        {sessions.length === 0 ? (
          <div className="mcp-control-empty">조회된 세션이 없습니다.</div>
        ) : sessions.map(session => (
          <div key={session.sessionKey} className="mcp-control-item mcp-control-session-item">
            <div className="mcp-control-item-main">
              <h3>{session.alias || session.name || session.sessionKey}</h3>
              <div className="mcp-control-item-meta">
                <span>key {session.sessionKey}</span>
                <span>session {session.sessionId ?? session.currentSessionId ?? 'unknown'}</span>
                {session.currentSessionId && session.currentSessionId !== session.sessionId && (
                  <span>current {session.currentSessionId}</span>
                )}
                <span>{session.status ?? 'unknown'}</span>
                <span>{session.bindingLifecycle ?? 'lifecycle unknown'}</span>
                <span>{session.mcpConnected ? 'mcp connected' : 'mcp disconnected'}</span>
                {session.leader && <span>leader</span>}
                {session.lastSeenAt && <span>seen {session.lastSeenAt}</span>}
                <span>{session.cwd ?? ''}</span>
              </div>
              <label className="mcp-control-field">
                <span>Alias</span>
                <input
                  value={aliasDrafts[session.sessionKey] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    onAliasChange(current => ({ ...current, [session.sessionKey]: value }));
                  }}
                />
              </label>
            </div>
            <div className="mcp-control-item-actions">
              <button type="button" onClick={() => onSaveAlias(session)} disabled={saving}>별칭 저장</button>
              <button type="button" onClick={() => onReplyTest(session)} disabled={saving}>전달 테스트</button>
              <button
                type="button"
                onClick={() => onCloseSession(session)}
                disabled={saving || !session.closeConfirmationNonce}
                title={session.closeConfirmationNonce ? '세션 닫기' : '목록 조회에서 발급된 닫기 nonce가 필요합니다'}
              >
                닫기
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderStatusPanel({
  config,
  agents,
  webhooks,
  sessions,
  onReload,
}: {
  config: McpControlConfig | null;
  agents: McpAgentProfile[];
  webhooks: McpWebhookKey[];
  sessions: McpSessionRecord[];
  onReload: () => void;
}) {
  return (
    <div className="mcp-control-section">
      <dl className="mcp-control-status-grid">
        <dt>Enabled</dt>
        <dd>{config?.enabled ? 'true' : 'false'}</dd>
        <dt>Bind</dt>
        <dd>{config ? `${config.bindMode} ${config.host}:${config.port}` : 'unknown'}</dd>
        <dt>Transport</dt>
        <dd>{config?.transportSecurity ?? 'unknown'}</dd>
        <dt>Status</dt>
        <dd>{config?.status ?? 'unknown'}</dd>
        <dt>Last error</dt>
        <dd>{summarizeUnknown(config?.lastError)}</dd>
        <dt>Last rebind</dt>
        <dd>{summarizeUnknown(config?.lastRebindResult)}</dd>
        <dt>Audit stream</dt>
        <dd>REST status only</dd>
        <dt>Agent profiles</dt>
        <dd>{agents.length}</dd>
        <dt>Webhook keys</dt>
        <dd>{webhooks.length}</dd>
        <dt>Sessions</dt>
        <dd>{sessions.length}</dd>
      </dl>
      <div className="mcp-control-actions">
        <button type="button" className="mcp-control-secondary-button" onClick={onReload}>새로고침</button>
      </div>
    </div>
  );
}

function getWebhookId(webhook: McpWebhookKey): string {
  return webhook.id ?? webhook.keyId;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'MCP control 요청을 처리하지 못했습니다.';
}

function summarizeUnknown(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '없음';
  }
  if (typeof value === 'string') {
    return truncate(value, 180);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = ['ok', 'code', 'status', 'message', 'changedFields']
      .filter(key => record[key] !== undefined)
      .map(key => `${key}=${formatRecordValue(record[key])}`);
    return parts.length > 0 ? truncate(parts.join(' '), 220) : 'object';
  }
  return 'unknown';
}

function formatRecordValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(',');
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return 'object';
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
