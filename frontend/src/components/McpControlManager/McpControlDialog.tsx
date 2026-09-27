import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageBox, WindowDialog } from '../dialog';
import { Icon } from '../common/Icon';
import { Button, Checkbox, Chip, Field, Select, Spinner, Switch, TextInput } from '../ui';
import { mcpControlApi } from '../../services/api';
import type {
  McpAgentProfile,
  McpClientConfigMode,
  McpControlConfig,
  McpFixedAccessKeyRotation,
  McpRecentAuditEvent,
  McpSessionClaimCode,
  McpSessionRecord,
  McpWebhookCreateResponse,
  McpWebhookKey,
} from '../../types';
import {
  buildMcpAgentProfileInput,
  buildMcpControlConfigPatch,
  createMcpSecurityDraft,
  formatMcpAuditAction,
  formatMcpAuditOutcome,
  formatMcpAgentStatus,
  formatMcpBindingLifecycle,
  formatMcpControlStatus,
  formatMcpControlListInput,
  formatMcpWebhookMode,
  normalizeMcpWebhookMode,
  parseMcpControlListInput,
  validateMcpAgentDraft,
  validateMcpWebhookDraft,
  validateMcpSecurityDraft,
  type McpSecurityDraft,
} from './mcpControlDialogModel';
import { t, tn } from '../../i18n/i18n.ts';
import type { MessageKey } from '../../i18n/i18n.ts';
import './McpControlDialog.css';

export interface McpControlDialogProps {
  open: boolean;
  onClose: () => void;
}

type McpControlTab = 'security' | 'agents' | 'webhooks' | 'sessions' | 'status';
type FixedAccessKeyOperation = 'generate' | 'regenerate';

interface AgentDraft {
  displayName: string;
  command: string;
  argsText: string;
  aliasesText: string;
  enabled: boolean;
  isDefault: boolean;
  kickoffPrompt: string;
  mcpClientConfigMode: McpClientConfigMode;
}

/** Alias text being edited, by session key. */
type AliasDrafts = Record<string, string>;

interface WebhookDraft {
  targetSessionKey: string;
  profileId: string;
  mode: string;
  scopesText: string;
  expiresAt: string;
}

const TAB_DEFINITIONS: Array<{ id: McpControlTab; labelKey: MessageKey }> = [
  { id: 'security', labelKey: 'mcp.tab.security' },
  { id: 'agents', labelKey: 'mcp.tab.agents' },
  { id: 'webhooks', labelKey: 'mcp.tab.webhooks' },
  { id: 'sessions', labelKey: 'mcp.tab.sessions' },
  { id: 'status', labelKey: 'mcp.tab.status' },
];

const MCP_BIND_MODE_LABELS: Record<string, MessageKey> = {
  loopback: 'mcp.bindMode.loopback',
  whitelist: 'mcp.bindMode.whitelist',
};

const MCP_TRANSPORT_SECURITY_LABELS: Record<string, MessageKey> = {
  none: 'mcp.transport.none',
  direct_tls: 'mcp.transport.directTls',
  trusted_tls_proxy: 'mcp.transport.trustedTlsProxy',
};

const MCP_CLIENT_CONFIG_MODE_LABELS: Record<McpClientConfigMode, MessageKey> = {
  'generated-file': 'mcp.configMode.generatedFile',
  env: 'mcp.configMode.env',
  manual: 'mcp.configMode.manual',
};

const AUDIT_RECORD_FIELD_LABELS: Record<string, MessageKey> = {
  ok: 'mcp.auditField.ok',
  code: 'mcp.auditField.code',
  status: 'mcp.auditField.status',
  message: 'mcp.auditField.message',
  changedFields: 'mcp.auditField.changedFields',
};

const DEFAULT_AGENT_DRAFT: AgentDraft = {
  displayName: '',
  command: '',
  argsText: '',
  aliasesText: '',
  enabled: true,
  isDefault: false,
  kickoffPrompt: '',
  mcpClientConfigMode: 'generated-file',
};

// A function, not a constant: the mode label is translated, so it must not be
// evaluated during module load (FR-I18N-002 AC-4).
function createDefaultWebhookDraft(): WebhookDraft {
  return {
    targetSessionKey: '',
    profileId: '',
    mode: formatMcpWebhookMode('paste'),
    scopesText: 'mcp:webhook.invoke',
    expiresAt: '',
  };
}

const DEFAULT_REPLY_TEST_PROMPT = 'Hello, World!';

export function McpControlDialog({ open, onClose }: McpControlDialogProps) {
  const [activeTab, setActiveTab] = useState<McpControlTab>('security');
  const [config, setConfig] = useState<McpControlConfig | null>(null);
  const [securityDraft, setSecurityDraft] = useState<McpSecurityDraft | null>(null);
  const [agents, setAgents] = useState<McpAgentProfile[]>([]);
  const [webhooks, setWebhooks] = useState<McpWebhookKey[]>([]);
  const [sessions, setSessions] = useState<McpSessionRecord[]>([]);
  const [agentDraft, setAgentDraft] = useState<AgentDraft>(DEFAULT_AGENT_DRAFT);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [webhookDraft, setWebhookDraft] = useState<WebhookDraft>(createDefaultWebhookDraft);
  const [webhookCredential, setWebhookCredential] = useState<McpWebhookCreateResponse | null>(null);
  const [fixedAccessKey, setFixedAccessKey] = useState<McpFixedAccessKeyRotation | null>(null);
  const [fixedAccessKeyOperation, setFixedAccessKeyOperation] = useState<FixedAccessKeyOperation>('generate');
  const [fixedAccessKeyRotationConfirmOpen, setFixedAccessKeyRotationConfirmOpen] = useState(false);
  const [fixedAccessKeyRotationError, setFixedAccessKeyRotationError] = useState<string | null>(null);
  const [sessionClaimCode, setSessionClaimCode] = useState<McpSessionClaimCode | null>(null);
  const [sessionQuery, setSessionQuery] = useState('');
  const [aliasDrafts, setAliasDrafts] = useState<AliasDrafts>({});
  const [replyPrompt, setReplyPrompt] = useState(DEFAULT_REPLY_TEST_PROMPT);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const fixedAccessKeyEpochRef = useRef(0);
  const fixedAccessKeyAbortRef = useRef<AbortController | null>(null);
  const fixedAccessKeyInFlightRef = useRef(false);

  const invalidateFixedAccessKeyResponse = useCallback(() => {
    fixedAccessKeyEpochRef.current += 1;
    fixedAccessKeyAbortRef.current?.abort();
    fixedAccessKeyAbortRef.current = null;
    setFixedAccessKey(null);
    setFixedAccessKeyRotationConfirmOpen(false);
    setFixedAccessKeyRotationError(null);
    if (fixedAccessKeyInFlightRef.current) {
      fixedAccessKeyInFlightRef.current = false;
      setSaving(false);
    }
  }, []);

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
    invalidateFixedAccessKeyResponse();
    const nextConfig = await mcpControlApi.getConfig();
    setConfig(nextConfig);
    setSecurityDraft(createMcpSecurityDraft(nextConfig));
  }, [invalidateFixedAccessKeyResponse]);

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
    setSessionClaimCode(null);
    setFixedAccessKey(null);
    setFixedAccessKeyRotationConfirmOpen(false);
    setFixedAccessKeyRotationError(null);
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
    if (open) {
      return;
    }
    invalidateFixedAccessKeyResponse();
  }, [invalidateFixedAccessKeyResponse, open]);

  useEffect(() => {
    if (activeTab !== 'webhooks') {
      setWebhookCredential(null);
    }
    if (activeTab !== 'sessions') {
      setSessionClaimCode(null);
    }
    if (activeTab !== 'security') {
      invalidateFixedAccessKeyResponse();
    }
  }, [activeTab, invalidateFixedAccessKeyResponse]);

  useEffect(() => () => {
    fixedAccessKeyEpochRef.current += 1;
    fixedAccessKeyAbortRef.current?.abort();
  }, []);

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
      setStatusMessage(t('mcp.security.saved'));
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [securityDraft]);

  const handleRequestFixedAccessKeyRotation = useCallback(() => {
    fixedAccessKeyEpochRef.current += 1;
    fixedAccessKeyAbortRef.current?.abort();
    fixedAccessKeyAbortRef.current = null;
    setError(null);
    setStatusMessage(null);
    setFixedAccessKey(null);
    setFixedAccessKeyRotationError(null);
    setFixedAccessKeyOperation(config?.fixedAccessKeyConfigured === true ? 'regenerate' : 'generate');
    setFixedAccessKeyRotationConfirmOpen(true);
  }, [config?.fixedAccessKeyConfigured]);

  const handleConfirmFixedAccessKeyRotation = useCallback(async () => {
    const operationEpoch = fixedAccessKeyEpochRef.current;
    const abortController = new AbortController();
    fixedAccessKeyAbortRef.current?.abort();
    fixedAccessKeyAbortRef.current = abortController;
    fixedAccessKeyInFlightRef.current = true;
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    setFixedAccessKey(null);
    setFixedAccessKeyRotationError(null);
    try {
      const response = await mcpControlApi.rotateFixedAccessKey(abortController.signal);
      if (operationEpoch !== fixedAccessKeyEpochRef.current || abortController.signal.aborted) {
        return;
      }
      setFixedAccessKey(response);
      setConfig(current => current ? { ...current, fixedAccessKeyConfigured: true } : current);
      setFixedAccessKeyRotationConfirmOpen(false);
      setStatusMessage(fixedAccessKeyOperation === 'regenerate'
        ? t('mcp.fixedKey.regenerated')
        : t('mcp.fixedKey.generated'));
    } catch (nextError) {
      if (operationEpoch !== fixedAccessKeyEpochRef.current || abortController.signal.aborted) {
        return;
      }
      setFixedAccessKeyRotationError(getErrorMessage(nextError));
    } finally {
      if (operationEpoch === fixedAccessKeyEpochRef.current) {
        fixedAccessKeyAbortRef.current = null;
        fixedAccessKeyInFlightRef.current = false;
        setSaving(false);
      }
    }
  }, [fixedAccessKeyOperation]);

  const handleTabChange = useCallback((tab: McpControlTab) => {
    if (tab !== 'security') {
      invalidateFixedAccessKeyResponse();
    }
    setActiveTab(tab);
  }, [invalidateFixedAccessKeyResponse]);

  const handleClose = useCallback(() => {
    invalidateFixedAccessKeyResponse();
    onClose();
  }, [invalidateFixedAccessKeyResponse, onClose]);

  const handleCopyFixedAccessKey = useCallback(async () => {
    if (!fixedAccessKey) return;
    setError(null);
    try {
      await copyTextToClipboard(fixedAccessKey.accessKey);
      setStatusMessage(t('mcp.fixedKey.copied'));
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    }
  }, [fixedAccessKey]);

  const handleSaveAgent = useCallback(async () => {
    const validationError = validateMcpAgentDraft(agentDraft);
    if (validationError) {
      setError(validationError);
      setStatusMessage(null);
      return;
    }

    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const payload = buildMcpAgentProfileInput(agentDraft);
      if (editingAgentId) {
        await mcpControlApi.updateAgent(editingAgentId, payload);
      } else {
        await mcpControlApi.createAgent(payload);
      }
      setAgentDraft(DEFAULT_AGENT_DRAFT);
      setEditingAgentId(null);
      await loadAgents();
      setStatusMessage(editingAgentId ? t('mcp.agent.saved') : t('mcp.agent.added'));
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [agentDraft, editingAgentId, loadAgents]);

  const handleEditAgent = useCallback((agent: McpAgentProfile) => {
    setEditingAgentId(agent.id);
    setAgentDraft({
      displayName: agent.displayName,
      command: agent.command,
      argsText: formatMcpControlListInput(agent.args),
      aliasesText: formatMcpControlListInput(agent.aliases),
      enabled: agent.enabled,
      isDefault: agent.isDefault,
      kickoffPrompt: agent.kickoffPrompt ?? '',
      mcpClientConfigMode: agent.mcpClientConfigMode,
    });
    setActiveTab('agents');
    setError(null);
    setStatusMessage(null);
  }, []);

  const handleCancelAgentEdit = useCallback(() => {
    setEditingAgentId(null);
    setAgentDraft(DEFAULT_AGENT_DRAFT);
    setError(null);
  }, []);

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
      if (editingAgentId === agent.id) {
        setEditingAgentId(null);
        setAgentDraft(DEFAULT_AGENT_DRAFT);
      }
      await loadAgents();
      setStatusMessage(t('mcp.agent.deleted'));
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [editingAgentId, loadAgents]);

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
        mode: normalizeMcpWebhookMode(webhookDraft.mode) || undefined,
        scopes: parseMcpControlListInput(webhookDraft.scopesText),
        expiresAt: webhookDraft.expiresAt.trim() || undefined,
      });
      setWebhookCredential(response);
      setWebhookDraft(createDefaultWebhookDraft());
      await loadWebhooks();
      setStatusMessage(t('mcp.webhook.created'));
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
      setStatusMessage(t('mcp.webhook.rotated'));
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
      setStatusMessage(t('mcp.webhook.revoked'));
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
      setStatusMessage(tn('mcp.session.searchResults', result.matches.length));
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
      setStatusMessage(t('mcp.session.aliasSaved'));
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [aliasDrafts, loadSessions, sessionQuery]);

  const handleCreateSessionClaimCode = useCallback(async (session: McpSessionRecord) => {
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await mcpControlApi.createSessionClaimCode(session.sessionKey);
      setSessionClaimCode(response);
      setStatusMessage(t('mcp.session.claimCodeIssued'));
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleReplyTest = useCallback(async (session: McpSessionRecord) => {
    const prompt = replyPrompt.trim();
    if (!prompt) {
      setError(t('mcp.session.replyPromptRequired'));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await mcpControlApi.replyTest(session.sessionKey, prompt);
      setStatusMessage(result.accepted ? t('mcp.session.replyAccepted') : t('mcp.session.replyRejected', { code: result.code ?? t('common.unknown') }));
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [replyPrompt]);

  const handleCloseSession = useCallback(async (session: McpSessionRecord) => {
    const confirmationNonce = session.closeConfirmationNonce;
    if (!confirmationNonce) {
      setError(t('mcp.session.noCloseToken'));
      return;
    }

    if (!window.confirm(t('mcp.session.closeConfirm', { name: session.alias || session.name || session.sessionKey }))) {
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
      setStatusMessage(result.ok ? t('mcp.session.closeAccepted') : t('mcp.session.closeRejected', { code: result.code ?? result.status ?? t('common.unknown') }));
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
    <>
      <WindowDialog
      dialogId="mcp-control-manager"
      title={t('mcp.dialog.title')}
      mode="modal"
      defaultRect={{ x: 160, y: 88, width: 860, height: 620 }}
      minSize={{ width: 680, height: 480 }}
      onClose={handleClose}
      surfaceClassName="mcp-control-dialog-surface"
    >
      <div className="mcp-control-dialog" data-testid="mcp-control-dialog">
        <div className="mcp-control-tabs" role="tablist" aria-label={t('mcp.dialog.tabsLabel')}>
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
              onClick={() => handleTabChange(tab.id)}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {loading && (
          <div className="mcp-control-loading" role="status">
            <Spinner />
            {t('mcp.dialog.loading')}
          </div>
        )}
        {error && (
          <div className="mcp-control-error" role="alert">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </div>
        )}
        {statusMessage && (
          <div className="mcp-control-toast" role="status">
            <Icon name="check-circle" size={14} />
            <span>{statusMessage}</span>
          </div>
        )}

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
            fixedAccessKey,
            saving,
            onDraftChange: updateSecurityDraft,
            onSave: handleSaveSecurity,
            onReload: loadConfig,
            onRequestFixedAccessKeyRotation: handleRequestFixedAccessKeyRotation,
            onCopyFixedAccessKey: handleCopyFixedAccessKey,
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
            editingAgentId,
            saving,
            onDraftChange: setAgentDraft,
            onSave: handleSaveAgent,
            onEdit: handleEditAgent,
            onCancelEdit: handleCancelAgentEdit,
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
            claimCode: sessionClaimCode,
            saving,
            onQueryChange: setSessionQuery,
            onAliasChange: setAliasDrafts,
            onReplyPromptChange: setReplyPrompt,
            onSearch: handleSessionSearch,
            onSearchTest: handleSessionSearchTest,
            onSaveAlias: handleSaveAlias,
            onCreateClaimCode: handleCreateSessionClaimCode,
            onReplyTest: handleReplyTest,
            onCloseSession: handleCloseSession,
            onDismissClaimCode: () => setSessionClaimCode(null),
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
      {fixedAccessKeyRotationConfirmOpen && (
        <MessageBox
          dialogId="mcp-fixed-access-key-rotate-confirm"
          title={fixedAccessKeyOperation === 'regenerate' ? t('mcp.fixedKey.regenerate') : t('mcp.fixedKey.generate')}
          message={fixedAccessKeyOperation === 'regenerate'
            ? t('mcp.fixedKey.regenerateConfirm')
            : t('mcp.fixedKey.generateConfirm')}
          okLabel={fixedAccessKeyOperation === 'regenerate' ? t('mcp.fixedKey.regenerateOk') : t('mcp.fixedKey.generateOk')}
          cancelLabel={t('common.cancel')}
          okVariant="danger"
          busy={saving}
          error={fixedAccessKeyRotationError}
          onOk={() => void handleConfirmFixedAccessKeyRotation()}
          onCancel={() => {
            if (!saving) {
              invalidateFixedAccessKeyResponse();
            }
          }}
        />
      )}
    </>
  );
}

// Every panel below is a plain render function rather than a component, so the
// field ids are fixed strings: there is one MCP dialog at a time.

function renderSecurityPanel({
  config,
  draft,
  fixedAccessKey,
  saving,
  onDraftChange,
  onSave,
  onReload,
  onRequestFixedAccessKeyRotation,
  onCopyFixedAccessKey,
}: {
  config: McpControlConfig | null;
  draft: McpSecurityDraft | null;
  fixedAccessKey: McpFixedAccessKeyRotation | null;
  saving: boolean;
  onDraftChange: <K extends keyof McpSecurityDraft>(key: K, value: McpSecurityDraft[K]) => void;
  onSave: () => void;
  onReload: () => void;
  onRequestFixedAccessKeyRotation: () => void;
  onCopyFixedAccessKey: () => void;
}) {
  if (!draft) {
    return <div className="mcp-control-empty">{t('mcp.security.loadFailed')}</div>;
  }

  return (
    <div className="mcp-control-section">
      <div className="mcp-control-form-grid">
        <div className="mcp-control-checkbox-field">
          <Switch
            checked={draft.enabled}
            onChange={(event) => onDraftChange('enabled', event.target.checked)}
          >
            {t('mcp.security.enabled')}
          </Switch>
        </div>

        <Field label={t('mcp.security.bindMode')} htmlFor="mcp-security-bind-mode" className="mcp-control-field">
          <Select
            id="mcp-security-bind-mode"
            value={draft.bindMode}
            onChange={(event) => onDraftChange('bindMode', event.target.value)}
          >
            <option value="loopback">{t(MCP_BIND_MODE_LABELS.loopback)}</option>
            <option value="whitelist">{t(MCP_BIND_MODE_LABELS.whitelist)}</option>
          </Select>
        </Field>

        <Field label={t('mcp.security.host')} htmlFor="mcp-security-host" className="mcp-control-field">
          <TextInput
            id="mcp-security-host"
            mono
            value={draft.host}
            onChange={(event) => onDraftChange('host', event.target.value)}
            spellCheck={false}
          />
        </Field>

        <Field label={t('mcp.security.port')} htmlFor="mcp-security-port" className="mcp-control-field">
          <TextInput
            id="mcp-security-port"
            mono
            value={draft.portText}
            inputMode="numeric"
            onChange={(event) => onDraftChange('portText', event.target.value)}
          />
        </Field>

        <Field label={t('mcp.security.transport')} htmlFor="mcp-security-transport" className="mcp-control-field">
          <Select
            id="mcp-security-transport"
            value={draft.transportSecurity}
            onChange={(event) => onDraftChange('transportSecurity', event.target.value)}
          >
            <option value="none">{t(MCP_TRANSPORT_SECURITY_LABELS.none)}</option>
            <option value="direct_tls">{t(MCP_TRANSPORT_SECURITY_LABELS.direct_tls)}</option>
            <option value="trusted_tls_proxy">{t(MCP_TRANSPORT_SECURITY_LABELS.trusted_tls_proxy)}</option>
          </Select>
        </Field>

        <Field label={t('mcp.security.webhookHeader')} htmlFor="mcp-security-webhook-header" className="mcp-control-field">
          <TextInput
            id="mcp-security-webhook-header"
            mono
            value={draft.webhookKeyHeaderName}
            onChange={(event) => onDraftChange('webhookKeyHeaderName', event.target.value)}
            spellCheck={false}
          />
        </Field>

        <Field label={t('mcp.security.rateWindow')} htmlFor="mcp-security-rate-window" className="mcp-control-field">
          <span className="ui-unit-wrap">
            <TextInput
              id="mcp-security-rate-window"
              value={draft.webhookRateLimitWindowSecondsText}
              inputMode="numeric"
              onChange={(event) => onDraftChange('webhookRateLimitWindowSecondsText', event.target.value)}
            />
            <span className="ui-unit" aria-hidden="true">{t('mcp.security.unitSeconds')}</span>
          </span>
        </Field>

        <Field label={t('mcp.security.rateBurst')} htmlFor="mcp-security-rate-burst" className="mcp-control-field">
          <span className="ui-unit-wrap">
            <TextInput
              id="mcp-security-rate-burst"
              value={draft.webhookRateLimitBurstLimitText}
              inputMode="numeric"
              onChange={(event) => onDraftChange('webhookRateLimitBurstLimitText', event.target.value)}
            />
            <span className="ui-unit" aria-hidden="true">{t('mcp.security.unitTimes')}</span>
          </span>
        </Field>
      </div>

      <div className="mcp-control-textarea-grid">
        <Field
          label={t('mcp.security.externalWhitelist')}
          htmlFor="mcp-security-external-whitelist"
          help={t('mcp.security.listHelp')}
          className="mcp-control-field"
        >
          <textarea
            id="mcp-security-external-whitelist"
            className="ui-input mcp-control-textarea"
            value={draft.externalWhitelistText}
            onChange={(event) => onDraftChange('externalWhitelistText', event.target.value)}
            rows={5}
            spellCheck={false}
          />
        </Field>

        <Field label={t('mcp.security.trustedProxies')} htmlFor="mcp-security-trusted-proxies" className="mcp-control-field">
          <textarea
            id="mcp-security-trusted-proxies"
            className="ui-input mcp-control-textarea"
            value={draft.trustedProxiesText}
            onChange={(event) => onDraftChange('trustedProxiesText', event.target.value)}
            rows={5}
            spellCheck={false}
          />
        </Field>

        <Field label={t('mcp.security.allowedOrigins')} htmlFor="mcp-security-allowed-origins" className="mcp-control-field">
          <textarea
            id="mcp-security-allowed-origins"
            className="ui-input mcp-control-textarea"
            value={draft.allowedOriginsText}
            onChange={(event) => onDraftChange('allowedOriginsText', event.target.value)}
            rows={5}
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="mcp-control-credential mcp-control-access-key">
        <div className="mcp-control-access-key-head">
          <span className="mcp-control-access-key-icon"><Icon name="lock" size={18} /></span>
          <div className="mcp-control-item-main">
            <h3>{t('mcp.fixedKey.heading')}</h3>
            <div className="mcp-control-item-meta">
              <span>{t('mcp.fixedKey.descBearer')}</span>
              <span>{t('mcp.fixedKey.descScope')}</span>
            </div>
          </div>
          <Button
            variant="secondary"
            size="md"
            icon={config?.fixedAccessKeyConfigured ? 'refresh' : 'plus'}
            className="mcp-control-secondary-button"
            onClick={onRequestFixedAccessKeyRotation}
            disabled={saving}
          >
            {config?.fixedAccessKeyConfigured ? t('mcp.fixedKey.regenerate') : t('mcp.fixedKey.generate')}
          </Button>
        </div>
        {fixedAccessKey && (
          <Field
            label={t('mcp.fixedKey.newKey')}
            htmlFor="mcp-security-new-access-key"
            help={t('mcp.fixedKey.newKeyHelp')}
            className="mcp-control-field"
          >
            <div className="mcp-control-secret-value">
              <TextInput
                id="mcp-security-new-access-key"
                mono
                value={fixedAccessKey.accessKey}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                variant="secondary"
                size="md"
                icon="copy"
                className="mcp-control-secondary-button"
                onClick={onCopyFixedAccessKey}
              >
                {t('common.copy')}
              </Button>
            </div>
          </Field>
        )}
      </div>

      <div className="mcp-control-status-strip">
        <span>{t('mcp.security.statusLine', { status: formatMcpControlStatus(config?.status) })}</span>
        <span>{t('mcp.security.lastRebindLine', { result: summarizeUnknown(config?.lastRebindResult) })}</span>
      </div>

      <div className="mcp-control-actions">
        <Button
          variant="secondary"
          size="md"
          icon="refresh"
          className="mcp-control-secondary-button"
          onClick={onReload}
          disabled={saving}
        >
          {t('common.refresh')}
        </Button>
        <Button variant="primary" size="md" className="mcp-control-primary-button" onClick={onSave} disabled={saving}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

function renderAgentsPanel({
  agents,
  draft,
  editingAgentId,
  saving,
  onDraftChange,
  onSave,
  onEdit,
  onCancelEdit,
  onToggle,
  onDelete,
  onReload,
}: {
  agents: McpAgentProfile[];
  draft: AgentDraft;
  editingAgentId: string | null;
  saving: boolean;
  onDraftChange: (draft: AgentDraft) => void;
  onSave: () => void;
  onEdit: (agent: McpAgentProfile) => void;
  onCancelEdit: () => void;
  onToggle: (agent: McpAgentProfile) => void;
  onDelete: (agent: McpAgentProfile) => void;
  onReload: () => void;
}) {
  return (
    <div className="mcp-control-section">
      <div className="mcp-control-form-grid">
        <Field label={t('mcp.agent.displayName')} htmlFor="mcp-agent-display-name" className="mcp-control-field">
          <TextInput
            id="mcp-agent-display-name"
            value={draft.displayName}
            onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })}
          />
        </Field>
        <Field label={t('mcp.agent.command')} htmlFor="mcp-agent-command" className="mcp-control-field">
          <TextInput
            id="mcp-agent-command"
            mono
            value={draft.command}
            onChange={(event) => onDraftChange({ ...draft, command: event.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label={t('mcp.agent.configMode')} htmlFor="mcp-agent-config-mode" className="mcp-control-field">
          <Select
            id="mcp-agent-config-mode"
            value={draft.mcpClientConfigMode}
            onChange={(event) => onDraftChange({ ...draft, mcpClientConfigMode: event.target.value as McpClientConfigMode })}
          >
            <option value="generated-file">{t(MCP_CLIENT_CONFIG_MODE_LABELS['generated-file'])}</option>
            <option value="env">{t(MCP_CLIENT_CONFIG_MODE_LABELS.env)}</option>
            <option value="manual">{t(MCP_CLIENT_CONFIG_MODE_LABELS.manual)}</option>
          </Select>
        </Field>
        <div className="mcp-control-checkbox-field">
          <Checkbox
            checked={draft.enabled}
            onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })}
          >
            {t('mcp.agent.enabled')}
          </Checkbox>
        </div>
        <div className="mcp-control-checkbox-field">
          <Checkbox
            checked={draft.isDefault}
            onChange={(event) => onDraftChange({ ...draft, isDefault: event.target.checked })}
          >
            {t('mcp.agent.default')}
          </Checkbox>
        </div>
      </div>
      <div className="mcp-control-textarea-grid">
        <Field label={t('mcp.agent.args')} htmlFor="mcp-agent-args" help={t('mcp.agent.argsHelp')} className="mcp-control-field">
          <textarea
            id="mcp-agent-args"
            className="ui-input mcp-control-textarea"
            value={draft.argsText}
            rows={3}
            onChange={(event) => onDraftChange({ ...draft, argsText: event.target.value })}
          />
        </Field>
        <Field label={t('mcp.agent.aliases')} htmlFor="mcp-agent-aliases" help={t('mcp.agent.aliasesHelp')} className="mcp-control-field">
          <textarea
            id="mcp-agent-aliases"
            className="ui-input mcp-control-textarea"
            value={draft.aliasesText}
            rows={3}
            onChange={(event) => onDraftChange({ ...draft, aliasesText: event.target.value })}
          />
        </Field>
        <Field label={t('mcp.agent.kickoffPrompt')} htmlFor="mcp-agent-kickoff-prompt" className="mcp-control-field">
          <textarea
            id="mcp-agent-kickoff-prompt"
            className="ui-input mcp-control-textarea"
            value={draft.kickoffPrompt}
            rows={3}
            onChange={(event) => onDraftChange({ ...draft, kickoffPrompt: event.target.value })}
          />
        </Field>
      </div>
      <div className="mcp-control-actions">
        <Button
          variant="secondary"
          size="md"
          icon="refresh"
          className="mcp-control-secondary-button"
          onClick={onReload}
          disabled={saving}
        >
          {t('common.refresh')}
        </Button>
        {editingAgentId && (
          <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onCancelEdit} disabled={saving}>
            {t('common.cancel')}
          </Button>
        )}
        <Button variant="primary" size="md" className="mcp-control-primary-button" onClick={onSave} disabled={saving}>
          {editingAgentId ? t('mcp.agent.save') : t('mcp.agent.add')}
        </Button>
      </div>
      <div className="mcp-control-list" aria-label={t('mcp.agent.listLabel')}>
        {agents.length === 0 ? (
          <div className="mcp-control-empty">{t('mcp.agent.empty')}</div>
        ) : agents.map(agent => (
          <div key={agent.id} className="mcp-control-item">
            <div className="mcp-control-item-main">
              <div className="mcp-control-item-title">
                <h3>{agent.displayName}</h3>
                {agent.isDefault && <Chip tone="accent">{t('mcp.agent.default')}</Chip>}
                {!agent.enabled && <Chip tone="neutral">{t('mcp.agent.disabled')}</Chip>}
              </div>
              <div className="mcp-control-item-meta">
                <span>{agent.commandSummary ?? [agent.command, ...agent.args].join(' ')}</span>
                <span>{t(MCP_CLIENT_CONFIG_MODE_LABELS[agent.mcpClientConfigMode])}</span>
                {agent.aliases.length > 0 && <span>{t('mcp.agent.aliasesLine', { aliases: agent.aliases.join(', ') })}</span>}
              </div>
            </div>
            <div className="mcp-control-item-actions">
              <Button variant="secondary" size="md" onClick={() => onEdit(agent)} disabled={saving}>
                {t('mcp.agent.edit')}
              </Button>
              <Button variant="secondary" size="md" onClick={() => onToggle(agent)} disabled={saving}>
                {agent.enabled ? t('mcp.agent.turnOff') : t('mcp.agent.turnOn')}
              </Button>
              <Button variant="danger-text" size="md" onClick={() => onDelete(agent)} disabled={saving}>
                {t('common.delete')}
              </Button>
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
        <Field label={t('mcp.webhook.targetSession')} htmlFor="mcp-webhook-target-session" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-target-session"
            mono
            value={draft.targetSessionKey}
            onChange={(event) => onDraftChange({ ...draft, targetSessionKey: event.target.value })}
          />
        </Field>
        <Field label={t('mcp.webhook.profileId')} htmlFor="mcp-webhook-profile-id" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-profile-id"
            mono
            value={draft.profileId}
            onChange={(event) => onDraftChange({ ...draft, profileId: event.target.value })}
          />
        </Field>
        <Field label={t('mcp.webhook.mode')} htmlFor="mcp-webhook-mode" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-mode"
            value={draft.mode}
            onChange={(event) => onDraftChange({ ...draft, mode: event.target.value })}
          />
        </Field>
        <Field label={t('mcp.webhook.expiresAt')} htmlFor="mcp-webhook-expires-at" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-expires-at"
            mono
            value={draft.expiresAt}
            onChange={(event) => onDraftChange({ ...draft, expiresAt: event.target.value })}
          />
        </Field>
      </div>
      <Field label={t('mcp.webhook.scopes')} htmlFor="mcp-webhook-scopes" className="mcp-control-field">
        <textarea
          id="mcp-webhook-scopes"
          className="ui-input mcp-control-textarea"
          value={draft.scopesText}
          rows={3}
          onChange={(event) => onDraftChange({ ...draft, scopesText: event.target.value })}
        />
      </Field>
      {credential && (
        <div className="mcp-control-credential" role="status">
          <Field label={t('mcp.webhook.fullKey')} htmlFor="mcp-webhook-full-key" className="mcp-control-field">
            <TextInput id="mcp-webhook-full-key" mono value={credential.fullKey} readOnly autoComplete="off" />
          </Field>
          <Field label={t('mcp.webhook.fullUrl')} htmlFor="mcp-webhook-full-url" className="mcp-control-field">
            <TextInput id="mcp-webhook-full-url" mono value={credential.fullUrl} readOnly autoComplete="off" />
          </Field>
          <div className="mcp-control-actions">
            <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onDismissCredential}>
              {t('mcp.common.hide')}
            </Button>
          </div>
        </div>
      )}
      <div className="mcp-control-actions">
        <Button
          variant="secondary"
          size="md"
          icon="refresh"
          className="mcp-control-secondary-button"
          onClick={onReload}
          disabled={saving}
        >
          {t('common.refresh')}
        </Button>
        <Button variant="primary" size="md" icon="plus" className="mcp-control-primary-button" onClick={onCreate} disabled={saving}>
          {t('mcp.webhook.create')}
        </Button>
      </div>
      <div className="mcp-control-list" aria-label={t('mcp.webhook.listLabel')}>
        {webhooks.length === 0 ? (
          <div className="mcp-control-empty">{t('mcp.webhook.empty')}</div>
        ) : webhooks.map(webhook => (
          <div key={getWebhookId(webhook)} className="mcp-control-item">
            <div className="mcp-control-item-main">
              <div className="mcp-control-item-title">
                <h3>{webhook.maskedKey || getWebhookId(webhook)}</h3>
                <Chip tone={webhook.revoked ? 'neutral' : 'ok'}>{webhook.revoked ? t('mcp.webhook.revokedChip') : t('mcp.webhook.activeChip')}</Chip>
              </div>
              <div className="mcp-control-item-meta">
                <span>{webhook.targetSessionKey ?? t('mcp.webhook.noTarget')}</span>
                <span>{webhook.scopes.join(', ')}</span>
              </div>
            </div>
            <div className="mcp-control-item-actions">
              <Button variant="secondary" size="md" onClick={() => onRotate(webhook)} disabled={saving || webhook.revoked}>
                {t('mcp.webhook.rotate')}
              </Button>
              <Button variant="danger-text" size="md" onClick={() => onRevoke(webhook)} disabled={saving || webhook.revoked}>
                {t('mcp.webhook.revoke')}
              </Button>
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
  claimCode,
  saving,
  onQueryChange,
  onAliasChange,
  onReplyPromptChange,
  onSearch,
  onSearchTest,
  onSaveAlias,
  onCreateClaimCode,
  onReplyTest,
  onCloseSession,
  onDismissClaimCode,
}: {
  sessions: McpSessionRecord[];
  query: string;
  aliasDrafts: AliasDrafts;
  replyPrompt: string;
  claimCode: McpSessionClaimCode | null;
  saving: boolean;
  onQueryChange: (query: string) => void;
  onAliasChange: (updater: (current: AliasDrafts) => AliasDrafts) => void;
  onReplyPromptChange: (prompt: string) => void;
  onSearch: () => void;
  onSearchTest: () => void;
  onSaveAlias: (session: McpSessionRecord) => void;
  onCreateClaimCode: (session: McpSessionRecord) => void;
  onReplyTest: (session: McpSessionRecord) => void;
  onCloseSession: (session: McpSessionRecord) => void;
  onDismissClaimCode: () => void;
}) {
  return (
    <div className="mcp-control-section">
      <div className="mcp-control-session-search">
        <Field label={t('mcp.session.query')} htmlFor="mcp-session-query" className="mcp-control-field">
          <TextInput id="mcp-session-query" value={query} onChange={(event) => onQueryChange(event.target.value)} />
        </Field>
        <div className="mcp-control-actions">
          <Button
            variant="secondary"
            size="md"
            icon="search"
            className="mcp-control-secondary-button"
            onClick={onSearch}
            disabled={saving}
          >
            {t('mcp.session.list')}
          </Button>
          <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onSearchTest} disabled={saving}>
            {t('mcp.session.searchTest')}
          </Button>
        </div>
      </div>
      <Field label={t('mcp.session.replyPrompt')} htmlFor="mcp-session-reply-prompt" className="mcp-control-field">
        <TextInput
          id="mcp-session-reply-prompt"
          value={replyPrompt}
          onChange={(event) => onReplyPromptChange(event.target.value)}
        />
      </Field>
      {claimCode && (
        <div className="mcp-control-credential" role="status">
          <Field label={t('mcp.session.claimKey')} htmlFor="mcp-session-claim-key" className="mcp-control-field">
            <TextInput id="mcp-session-claim-key" mono value={claimCode.sessionKey} readOnly autoComplete="off" />
          </Field>
          <Field label={t('mcp.session.claimCode')} htmlFor="mcp-session-claim-code" className="mcp-control-field">
            <TextInput id="mcp-session-claim-code" mono value={claimCode.claimCode} readOnly autoComplete="off" />
          </Field>
          <div className="mcp-control-actions">
            <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onDismissClaimCode}>
              {t('mcp.common.hide')}
            </Button>
          </div>
        </div>
      )}
      <div className="mcp-control-list" aria-label={t('mcp.session.listLabel')}>
        {sessions.length === 0 ? (
          <div className="mcp-control-empty">{t('mcp.session.empty')}</div>
        ) : sessions.map((session, index) => (
          <div key={session.sessionKey} className="mcp-control-item mcp-control-session-item">
            <div className="mcp-control-item-main">
              <div className="mcp-control-item-title">
                <h3>{session.alias || session.name || session.sessionKey}</h3>
                <Chip tone={session.mcpConnected ? 'ok' : 'neutral'}>
                  {session.mcpConnected ? t('mcp.session.connected') : t('mcp.session.disconnected')}
                </Chip>
                {session.leader && <Chip tone="accent">{t('mcp.session.leader')}</Chip>}
              </div>
              <div className="mcp-control-item-meta">
                <span>{t('mcp.session.keyLine', { key: session.sessionKey })}</span>
                <span>{t('mcp.session.idLine', { id: session.sessionId ?? session.currentSessionId ?? t('common.unknown') })}</span>
                {session.currentSessionId && session.currentSessionId !== session.sessionId && (
                  <span>{t('mcp.session.currentIdLine', { id: session.currentSessionId })}</span>
                )}
                <span>{formatMcpAgentStatus(session.agentStatus ?? session.status)}</span>
                <span>{formatMcpBindingLifecycle(session.bindingLifecycle)}</span>
                {session.lastSeenAt && <span>{t('mcp.session.lastSeenLine', { time: session.lastSeenAt })}</span>}
                <span>{session.cwd ?? ''}</span>
              </div>
              <Field label={t('mcp.session.alias')} htmlFor={`mcp-session-alias-${index}`} className="mcp-control-field">
                <TextInput
                  id={`mcp-session-alias-${index}`}
                  value={aliasDrafts[session.sessionKey] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    onAliasChange(current => ({ ...current, [session.sessionKey]: value }));
                  }}
                />
              </Field>
            </div>
            <div className="mcp-control-item-actions">
              <Button variant="secondary" size="md" onClick={() => onSaveAlias(session)} disabled={saving}>{t('mcp.session.saveAlias')}</Button>
              <Button variant="secondary" size="md" onClick={() => onCreateClaimCode(session)} disabled={saving}>{t('mcp.session.issueClaimCode')}</Button>
              <Button variant="secondary" size="md" onClick={() => onReplyTest(session)} disabled={saving}>{t('mcp.session.replyTest')}</Button>
              <Button
                variant="danger-text"
                size="md"
                onClick={() => onCloseSession(session)}
                disabled={saving || !session.closeConfirmationNonce}
                title={session.closeConfirmationNonce ? t('common.closeSession') : t('mcp.session.closeTokenRequired')}
              >
                {t('common.closeSession')}
              </Button>
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
  const recentAuditEvents = config?.recentAuditEvents ?? [];
  return (
    <div className="mcp-control-section">
      <dl className="mcp-control-status-grid">
        <dt>{t('mcp.status.enabledLabel')}</dt>
        <dd>{formatMcpEnabled(config?.enabled)}</dd>
        <dt>{t('mcp.status.bind')}</dt>
        <dd>{config ? `${formatMcpBindMode(config.bindMode)} ${config.host}:${config.port}` : t('common.unknown')}</dd>
        <dt>{t('mcp.status.transport')}</dt>
        <dd>{formatMcpTransportSecurity(config?.transportSecurity)}</dd>
        <dt>{t('mcp.status.statusLabel')}</dt>
        <dd>{formatMcpControlStatus(config?.status)}</dd>
        <dt>{t('mcp.status.lastError')}</dt>
        <dd>{summarizeUnknown(config?.lastError)}</dd>
        <dt>{t('mcp.status.lastRebind')}</dt>
        <dd>{summarizeUnknown(config?.lastRebindResult)}</dd>
        <dt>{t('mcp.status.audit')}</dt>
        <dd>{recentAuditEvents.length > 0 ? tn('mcp.status.auditCount', recentAuditEvents.length) : t('mcp.status.auditEmpty')}</dd>
        <dt>{t('mcp.status.agents')}</dt>
        <dd>{tn('mcp.status.agentCount', agents.length)}</dd>
        <dt>{t('mcp.status.webhooks')}</dt>
        <dd>{tn('mcp.status.webhookCount', webhooks.length)}</dd>
        <dt>{t('mcp.status.sessions')}</dt>
        <dd>{tn('mcp.status.sessionCount', sessions.length)}</dd>
      </dl>
      {recentAuditEvents.length > 0 && (
        <div className="mcp-control-audit-list" aria-label={t('mcp.status.recentAudit')}>
          {recentAuditEvents.map((event, index) => (
            <div key={`${event.auditId ?? 'audit'}-${index}`} className="mcp-control-audit-item">
              {summarizeAuditEvent(event)}
            </div>
          ))}
        </div>
      )}
      <div className="mcp-control-actions">
        <Button variant="secondary" size="md" icon="refresh" className="mcp-control-secondary-button" onClick={onReload}>
          {t('common.refresh')}
        </Button>
      </div>
    </div>
  );
}

function formatMcpEnabled(value: boolean | undefined): string {
  if (value === undefined) {
    return t('common.unknown');
  }
  return value ? t('mcp.status.enabled') : t('mcp.status.disabled');
}

function formatMcpBindMode(value: string | undefined): string {
  return formatMcpControlValue(value, MCP_BIND_MODE_LABELS);
}

function formatMcpTransportSecurity(value: string | undefined): string {
  return formatMcpControlValue(value, MCP_TRANSPORT_SECURITY_LABELS);
}

function formatMcpControlValue(value: string | undefined, labels: Record<string, MessageKey>): string {
  if (!value) {
    return t('common.unknown');
  }
  return labels[value] ? t(labels[value]) : t('mcp.common.unknownValue', { value });
}

function summarizeAuditEvent(event: McpRecentAuditEvent): string {
  const label = formatMcpAuditAction(event.action ?? event.category);
  const outcome = formatMcpAuditOutcome(event.result ?? event.code ?? event.reason);
  const target = summarizeUnknown(event.targetBinding ?? event.target);
  return t('mcp.audit.summary', { time: event.timestamp ?? t('mcp.audit.noTime'), label, outcome, target });
}

function getWebhookId(webhook: McpWebhookKey): string {
  return webhook.id ?? webhook.keyId;
}

async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!copied) {
      throw new Error(t('mcp.common.copyFailed'));
    }
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return t('mcp.common.requestFailed');
}

function summarizeUnknown(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return t('mcp.common.none');
  }
  if (typeof value === 'string') {
    return truncate(value, 180);
  }
  if (typeof value === 'boolean') {
    return value ? t('mcp.common.yes') : t('mcp.common.no');
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = ['ok', 'code', 'status', 'message', 'changedFields']
      .filter(key => record[key] !== undefined)
      .map(key => `${t(AUDIT_RECORD_FIELD_LABELS[key])}=${formatRecordValue(record[key])}`);
    return parts.length > 0 ? truncate(parts.join(' '), 220) : t('mcp.common.object');
  }
  return t('common.unknown');
}

function formatRecordValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(',');
  }
  if (typeof value === 'boolean') {
    return value ? t('mcp.common.yes') : t('mcp.common.no');
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return t('mcp.common.object');
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
