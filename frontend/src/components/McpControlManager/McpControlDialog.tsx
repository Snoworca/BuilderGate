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

const TAB_DEFINITIONS: Array<{ id: McpControlTab; label: string }> = [
  { id: 'security', label: '보안' },
  { id: 'agents', label: '에이전트 프로필' },
  { id: 'webhooks', label: '웹훅' },
  { id: 'sessions', label: '세션' },
  { id: 'status', label: '감사/상태' },
];

const MCP_BIND_MODE_LABELS: Record<string, string> = {
  loopback: '로컬 호스트 전용',
  whitelist: '허용 목록 사용',
};

const MCP_TRANSPORT_SECURITY_LABELS: Record<string, string> = {
  none: '보안 사용 안 함',
  direct_tls: '직접 TLS',
  trusted_tls_proxy: '신뢰 프록시 TLS',
};

const MCP_CLIENT_CONFIG_MODE_LABELS: Record<McpClientConfigMode, string> = {
  'generated-file': '생성 파일',
  env: '환경 변수',
  manual: '수동 설정',
};

const AUDIT_RECORD_FIELD_LABELS: Record<string, string> = {
  ok: '성공',
  code: '코드',
  status: '상태',
  message: '메시지',
  changedFields: '변경 항목',
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

const DEFAULT_WEBHOOK_DRAFT: WebhookDraft = {
  targetSessionKey: '',
  profileId: '',
  mode: formatMcpWebhookMode('paste'),
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
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [webhookDraft, setWebhookDraft] = useState<WebhookDraft>(DEFAULT_WEBHOOK_DRAFT);
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
      setStatusMessage('MCP 보안 설정을 저장했습니다.');
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
        ? '고정 인증키를 재생성했습니다. 지금 복사해 안전한 곳에 보관하세요.'
        : '고정 인증키를 생성했습니다. 지금 복사해 안전한 곳에 보관하세요.');
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
      setStatusMessage('고정 인증키를 클립보드에 복사했습니다.');
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
      setStatusMessage(editingAgentId ? '에이전트 프로필을 저장했습니다.' : '에이전트 프로필을 추가했습니다.');
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
      setStatusMessage('에이전트 프로필을 삭제했습니다.');
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
      setWebhookDraft(DEFAULT_WEBHOOK_DRAFT);
      await loadWebhooks();
      setStatusMessage('웹훅 키를 생성했습니다.');
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
      setStatusMessage('웹훅 키를 교체했습니다. 이전 키는 더 이상 쓸 수 없습니다.');
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
      setStatusMessage('웹훅 키를 폐기했습니다.');
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

  const handleCreateSessionClaimCode = useCallback(async (session: McpSessionRecord) => {
    setSaving(true);
    setError(null);
    setStatusMessage(null);
    try {
      const response = await mcpControlApi.createSessionClaimCode(session.sessionKey);
      setSessionClaimCode(response);
      setStatusMessage('일회성 연결 코드를 발급했습니다.');
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleReplyTest = useCallback(async (session: McpSessionRecord) => {
    const prompt = replyPrompt.trim();
    if (!prompt) {
      setError('전달 테스트 프롬프트가 필요합니다.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await mcpControlApi.replyTest(session.sessionKey, prompt);
      setStatusMessage(result.accepted ? '메시지 전달 테스트를 접수했습니다.' : `전달 테스트 거부: ${result.code ?? '알 수 없음'}`);
    } catch (nextError) {
      setError(getErrorMessage(nextError));
    } finally {
      setSaving(false);
    }
  }, [replyPrompt]);

  const handleCloseSession = useCallback(async (session: McpSessionRecord) => {
    const confirmationNonce = session.closeConfirmationNonce;
    if (!confirmationNonce) {
      setError('이 세션에는 닫기 확인 토큰이 없습니다. 세션 목록을 다시 조회하십시오.');
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
      setStatusMessage(result.ok ? '세션 닫기 요청을 접수했습니다.' : `세션 닫기 거부: ${result.code ?? result.status ?? '알 수 없음'}`);
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
      title="MCP 관리"
      mode="modal"
      defaultRect={{ x: 160, y: 88, width: 860, height: 620 }}
      minSize={{ width: 680, height: 480 }}
      onClose={handleClose}
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
              onClick={() => handleTabChange(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="mcp-control-loading" role="status">
            <Spinner />
            불러오는 중
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
          title={fixedAccessKeyOperation === 'regenerate' ? '고정 인증키 재생성' : '고정 인증키 생성'}
          message={fixedAccessKeyOperation === 'regenerate'
            ? '정말로 재생성하시겠습니까? 현재 고정 인증키는 즉시 사용할 수 없게 됩니다.'
            : '새 고정 인증키를 생성하시겠습니까? 생성된 키는 이번 응답에서만 표시됩니다.'}
          okLabel={fixedAccessKeyOperation === 'regenerate' ? '재생성' : '생성'}
          cancelLabel="취소"
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
    return <div className="mcp-control-empty">MCP 설정을 불러오지 못했습니다.</div>;
  }

  return (
    <div className="mcp-control-section">
      <div className="mcp-control-form-grid">
        <div className="mcp-control-checkbox-field">
          <Switch
            checked={draft.enabled}
            onChange={(event) => onDraftChange('enabled', event.target.checked)}
          >
            MCP 엔드포인트 사용
          </Switch>
        </div>

        <Field label="바인드 모드" htmlFor="mcp-security-bind-mode" className="mcp-control-field">
          <Select
            id="mcp-security-bind-mode"
            value={draft.bindMode}
            onChange={(event) => onDraftChange('bindMode', event.target.value)}
          >
            <option value="loopback">{MCP_BIND_MODE_LABELS.loopback}</option>
            <option value="whitelist">{MCP_BIND_MODE_LABELS.whitelist}</option>
          </Select>
        </Field>

        <Field label="호스트 주소" htmlFor="mcp-security-host" className="mcp-control-field">
          <TextInput
            id="mcp-security-host"
            mono
            value={draft.host}
            onChange={(event) => onDraftChange('host', event.target.value)}
            spellCheck={false}
          />
        </Field>

        <Field label="포트" htmlFor="mcp-security-port" className="mcp-control-field">
          <TextInput
            id="mcp-security-port"
            mono
            value={draft.portText}
            inputMode="numeric"
            onChange={(event) => onDraftChange('portText', event.target.value)}
          />
        </Field>

        <Field label="전송 보안" htmlFor="mcp-security-transport" className="mcp-control-field">
          <Select
            id="mcp-security-transport"
            value={draft.transportSecurity}
            onChange={(event) => onDraftChange('transportSecurity', event.target.value)}
          >
            <option value="none">{MCP_TRANSPORT_SECURITY_LABELS.none}</option>
            <option value="direct_tls">{MCP_TRANSPORT_SECURITY_LABELS.direct_tls}</option>
            <option value="trusted_tls_proxy">{MCP_TRANSPORT_SECURITY_LABELS.trusted_tls_proxy}</option>
          </Select>
        </Field>

        <Field label="웹훅 헤더" htmlFor="mcp-security-webhook-header" className="mcp-control-field">
          <TextInput
            id="mcp-security-webhook-header"
            mono
            value={draft.webhookKeyHeaderName}
            onChange={(event) => onDraftChange('webhookKeyHeaderName', event.target.value)}
            spellCheck={false}
          />
        </Field>

        <Field label="웹훅 요청 제한 시간" htmlFor="mcp-security-rate-window" className="mcp-control-field">
          <span className="ui-unit-wrap">
            <TextInput
              id="mcp-security-rate-window"
              value={draft.webhookRateLimitWindowSecondsText}
              inputMode="numeric"
              onChange={(event) => onDraftChange('webhookRateLimitWindowSecondsText', event.target.value)}
            />
            <span className="ui-unit" aria-hidden="true">초</span>
          </span>
        </Field>

        <Field label="웹훅 순간 요청 한도" htmlFor="mcp-security-rate-burst" className="mcp-control-field">
          <span className="ui-unit-wrap">
            <TextInput
              id="mcp-security-rate-burst"
              value={draft.webhookRateLimitBurstLimitText}
              inputMode="numeric"
              onChange={(event) => onDraftChange('webhookRateLimitBurstLimitText', event.target.value)}
            />
            <span className="ui-unit" aria-hidden="true">회</span>
          </span>
        </Field>
      </div>

      <div className="mcp-control-textarea-grid">
        <Field
          label="외부 IP/CIDR 허용 목록"
          htmlFor="mcp-security-external-whitelist"
          help="한 줄에 하나씩, 또는 쉼표로 나눠 적습니다."
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

        <Field label="신뢰 프록시" htmlFor="mcp-security-trusted-proxies" className="mcp-control-field">
          <textarea
            id="mcp-security-trusted-proxies"
            className="ui-input mcp-control-textarea"
            value={draft.trustedProxiesText}
            onChange={(event) => onDraftChange('trustedProxiesText', event.target.value)}
            rows={5}
            spellCheck={false}
          />
        </Field>

        <Field label="허용 오리진" htmlFor="mcp-security-allowed-origins" className="mcp-control-field">
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
            <h3>고정 인증키</h3>
            <div className="mcp-control-item-meta">
              <span>외부 MCP 클라이언트의 Bearer 인증에 사용합니다.</span>
              <span>세션 목록, 검색, 메시지 전달 권한만 부여합니다.</span>
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
            {config?.fixedAccessKeyConfigured ? '고정 인증키 재생성' : '고정 인증키 생성'}
          </Button>
        </div>
        {fixedAccessKey && (
          <Field
            label="새 고정 인증키"
            htmlFor="mcp-security-new-access-key"
            help="이 창을 닫거나 다른 탭으로 옮기면 다시 볼 수 없습니다."
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
                복사
              </Button>
            </div>
          </Field>
        )}
      </div>

      <div className="mcp-control-status-strip">
        <span>상태: {formatMcpControlStatus(config?.status)}</span>
        <span>최근 재바인드: {summarizeUnknown(config?.lastRebindResult)}</span>
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
          새로고침
        </Button>
        <Button variant="primary" size="md" className="mcp-control-primary-button" onClick={onSave} disabled={saving}>
          저장
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
        <Field label="프로필 이름" htmlFor="mcp-agent-display-name" className="mcp-control-field">
          <TextInput
            id="mcp-agent-display-name"
            value={draft.displayName}
            onChange={(event) => onDraftChange({ ...draft, displayName: event.target.value })}
          />
        </Field>
        <Field label="실행 명령" htmlFor="mcp-agent-command" className="mcp-control-field">
          <TextInput
            id="mcp-agent-command"
            mono
            value={draft.command}
            onChange={(event) => onDraftChange({ ...draft, command: event.target.value })}
            spellCheck={false}
          />
        </Field>
        <Field label="설정 방식" htmlFor="mcp-agent-config-mode" className="mcp-control-field">
          <Select
            id="mcp-agent-config-mode"
            value={draft.mcpClientConfigMode}
            onChange={(event) => onDraftChange({ ...draft, mcpClientConfigMode: event.target.value as McpClientConfigMode })}
          >
            <option value="generated-file">{MCP_CLIENT_CONFIG_MODE_LABELS['generated-file']}</option>
            <option value="env">{MCP_CLIENT_CONFIG_MODE_LABELS.env}</option>
            <option value="manual">{MCP_CLIENT_CONFIG_MODE_LABELS.manual}</option>
          </Select>
        </Field>
        <div className="mcp-control-checkbox-field">
          <Checkbox
            checked={draft.enabled}
            onChange={(event) => onDraftChange({ ...draft, enabled: event.target.checked })}
          >
            사용
          </Checkbox>
        </div>
        <div className="mcp-control-checkbox-field">
          <Checkbox
            checked={draft.isDefault}
            onChange={(event) => onDraftChange({ ...draft, isDefault: event.target.checked })}
          >
            기본 프로필
          </Checkbox>
        </div>
      </div>
      <div className="mcp-control-textarea-grid">
        <Field label="실행 인수" htmlFor="mcp-agent-args" help="한 줄에 인수 하나씩 적습니다." className="mcp-control-field">
          <textarea
            id="mcp-agent-args"
            className="ui-input mcp-control-textarea"
            value={draft.argsText}
            rows={3}
            onChange={(event) => onDraftChange({ ...draft, argsText: event.target.value })}
          />
        </Field>
        <Field label="별칭" htmlFor="mcp-agent-aliases" help="한 줄에 별칭 하나씩 적습니다." className="mcp-control-field">
          <textarea
            id="mcp-agent-aliases"
            className="ui-input mcp-control-textarea"
            value={draft.aliasesText}
            rows={3}
            onChange={(event) => onDraftChange({ ...draft, aliasesText: event.target.value })}
          />
        </Field>
        <Field label="시작 프롬프트" htmlFor="mcp-agent-kickoff-prompt" className="mcp-control-field">
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
          새로고침
        </Button>
        {editingAgentId && (
          <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onCancelEdit} disabled={saving}>
            취소
          </Button>
        )}
        <Button variant="primary" size="md" className="mcp-control-primary-button" onClick={onSave} disabled={saving}>
          {editingAgentId ? '프로필 저장' : '프로필 추가'}
        </Button>
      </div>
      <div className="mcp-control-list" aria-label="에이전트 프로필 목록">
        {agents.length === 0 ? (
          <div className="mcp-control-empty">등록된 에이전트 프로필이 없습니다.</div>
        ) : agents.map(agent => (
          <div key={agent.id} className="mcp-control-item">
            <div className="mcp-control-item-main">
              <div className="mcp-control-item-title">
                <h3>{agent.displayName}</h3>
                {agent.isDefault && <Chip tone="accent">기본 프로필</Chip>}
                {!agent.enabled && <Chip tone="neutral">사용 안 함</Chip>}
              </div>
              <div className="mcp-control-item-meta">
                <span>{agent.commandSummary ?? [agent.command, ...agent.args].join(' ')}</span>
                <span>{MCP_CLIENT_CONFIG_MODE_LABELS[agent.mcpClientConfigMode]}</span>
                {agent.aliases.length > 0 && <span>별칭: {agent.aliases.join(', ')}</span>}
              </div>
            </div>
            <div className="mcp-control-item-actions">
              <Button variant="secondary" size="md" onClick={() => onEdit(agent)} disabled={saving}>
                수정
              </Button>
              <Button variant="secondary" size="md" onClick={() => onToggle(agent)} disabled={saving}>
                {agent.enabled ? '끄기' : '켜기'}
              </Button>
              <Button variant="danger-text" size="md" onClick={() => onDelete(agent)} disabled={saving}>
                삭제
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
        <Field label="대상 세션" htmlFor="mcp-webhook-target-session" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-target-session"
            mono
            value={draft.targetSessionKey}
            onChange={(event) => onDraftChange({ ...draft, targetSessionKey: event.target.value })}
          />
        </Field>
        <Field label="프로필 ID" htmlFor="mcp-webhook-profile-id" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-profile-id"
            mono
            value={draft.profileId}
            onChange={(event) => onDraftChange({ ...draft, profileId: event.target.value })}
          />
        </Field>
        <Field label="전달 방식" htmlFor="mcp-webhook-mode" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-mode"
            value={draft.mode}
            onChange={(event) => onDraftChange({ ...draft, mode: event.target.value })}
          />
        </Field>
        <Field label="만료 시각" htmlFor="mcp-webhook-expires-at" className="mcp-control-field">
          <TextInput
            id="mcp-webhook-expires-at"
            mono
            value={draft.expiresAt}
            onChange={(event) => onDraftChange({ ...draft, expiresAt: event.target.value })}
          />
        </Field>
      </div>
      <Field label="권한 범위" htmlFor="mcp-webhook-scopes" className="mcp-control-field">
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
          <Field label="전체 키" htmlFor="mcp-webhook-full-key" className="mcp-control-field">
            <TextInput id="mcp-webhook-full-key" mono value={credential.fullKey} readOnly autoComplete="off" />
          </Field>
          <Field label="전체 URL" htmlFor="mcp-webhook-full-url" className="mcp-control-field">
            <TextInput id="mcp-webhook-full-url" mono value={credential.fullUrl} readOnly autoComplete="off" />
          </Field>
          <div className="mcp-control-actions">
            <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onDismissCredential}>
              숨기기
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
          새로고침
        </Button>
        <Button variant="primary" size="md" icon="plus" className="mcp-control-primary-button" onClick={onCreate} disabled={saving}>
          웹훅 키 생성
        </Button>
      </div>
      <div className="mcp-control-list" aria-label="웹훅 목록">
        {webhooks.length === 0 ? (
          <div className="mcp-control-empty">등록된 웹훅 키가 없습니다.</div>
        ) : webhooks.map(webhook => (
          <div key={getWebhookId(webhook)} className="mcp-control-item">
            <div className="mcp-control-item-main">
              <div className="mcp-control-item-title">
                <h3>{webhook.maskedKey || getWebhookId(webhook)}</h3>
                <Chip tone={webhook.revoked ? 'neutral' : 'ok'}>{webhook.revoked ? '폐기됨' : '사용 중'}</Chip>
              </div>
              <div className="mcp-control-item-meta">
                <span>{webhook.targetSessionKey ?? '세션 대상 없음'}</span>
                <span>{webhook.scopes.join(', ')}</span>
              </div>
            </div>
            <div className="mcp-control-item-actions">
              <Button variant="secondary" size="md" onClick={() => onRotate(webhook)} disabled={saving || webhook.revoked}>
                키 교체
              </Button>
              <Button variant="danger-text" size="md" onClick={() => onRevoke(webhook)} disabled={saving || webhook.revoked}>
                폐기
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
        <Field label="검색" htmlFor="mcp-session-query" className="mcp-control-field">
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
            조회
          </Button>
          <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onSearchTest} disabled={saving}>
            검색 테스트
          </Button>
        </div>
      </div>
      <Field label="전달 테스트 프롬프트" htmlFor="mcp-session-reply-prompt" className="mcp-control-field">
        <TextInput
          id="mcp-session-reply-prompt"
          value={replyPrompt}
          onChange={(event) => onReplyPromptChange(event.target.value)}
        />
      </Field>
      {claimCode && (
        <div className="mcp-control-credential" role="status">
          <Field label="세션 키" htmlFor="mcp-session-claim-key" className="mcp-control-field">
            <TextInput id="mcp-session-claim-key" mono value={claimCode.sessionKey} readOnly autoComplete="off" />
          </Field>
          <Field label="일회성 연결 코드" htmlFor="mcp-session-claim-code" className="mcp-control-field">
            <TextInput id="mcp-session-claim-code" mono value={claimCode.claimCode} readOnly autoComplete="off" />
          </Field>
          <div className="mcp-control-actions">
            <Button variant="secondary" size="md" className="mcp-control-secondary-button" onClick={onDismissClaimCode}>
              숨기기
            </Button>
          </div>
        </div>
      )}
      <div className="mcp-control-list" aria-label="세션 목록">
        {sessions.length === 0 ? (
          <div className="mcp-control-empty">조회된 세션이 없습니다.</div>
        ) : sessions.map((session, index) => (
          <div key={session.sessionKey} className="mcp-control-item mcp-control-session-item">
            <div className="mcp-control-item-main">
              <div className="mcp-control-item-title">
                <h3>{session.alias || session.name || session.sessionKey}</h3>
                <Chip tone={session.mcpConnected ? 'ok' : 'neutral'}>
                  {session.mcpConnected ? 'MCP 연결됨' : 'MCP 연결 끊김'}
                </Chip>
                {session.leader && <Chip tone="accent">리더</Chip>}
              </div>
              <div className="mcp-control-item-meta">
                <span>세션 키: {session.sessionKey}</span>
                <span>세션 ID: {session.sessionId ?? session.currentSessionId ?? '알 수 없음'}</span>
                {session.currentSessionId && session.currentSessionId !== session.sessionId && (
                  <span>현재 세션 ID: {session.currentSessionId}</span>
                )}
                <span>{formatMcpAgentStatus(session.agentStatus ?? session.status)}</span>
                <span>{formatMcpBindingLifecycle(session.bindingLifecycle)}</span>
                {session.lastSeenAt && <span>마지막 확인: {session.lastSeenAt}</span>}
                <span>{session.cwd ?? ''}</span>
              </div>
              <Field label="별칭" htmlFor={`mcp-session-alias-${index}`} className="mcp-control-field">
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
              <Button variant="secondary" size="md" onClick={() => onSaveAlias(session)} disabled={saving}>별칭 저장</Button>
              <Button variant="secondary" size="md" onClick={() => onCreateClaimCode(session)} disabled={saving}>연결 코드 발급</Button>
              <Button variant="secondary" size="md" onClick={() => onReplyTest(session)} disabled={saving}>전달 테스트</Button>
              <Button
                variant="danger-text"
                size="md"
                onClick={() => onCloseSession(session)}
                disabled={saving || !session.closeConfirmationNonce}
                title={session.closeConfirmationNonce ? '세션 닫기' : '목록 조회에서 발급된 닫기 확인 토큰이 필요합니다'}
              >
                세션 닫기
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
        <dt>사용 여부</dt>
        <dd>{formatMcpEnabled(config?.enabled)}</dd>
        <dt>바인드</dt>
        <dd>{config ? `${formatMcpBindMode(config.bindMode)} ${config.host}:${config.port}` : '알 수 없음'}</dd>
        <dt>전송 보안</dt>
        <dd>{formatMcpTransportSecurity(config?.transportSecurity)}</dd>
        <dt>상태</dt>
        <dd>{formatMcpControlStatus(config?.status)}</dd>
        <dt>최근 오류</dt>
        <dd>{summarizeUnknown(config?.lastError)}</dd>
        <dt>최근 재바인드</dt>
        <dd>{summarizeUnknown(config?.lastRebindResult)}</dd>
        <dt>감사 기록</dt>
        <dd>{recentAuditEvents.length > 0 ? `최근 비식별화된 감사 기록 ${recentAuditEvents.length}건` : '최근 감사 기록이 없습니다.'}</dd>
        <dt>에이전트 프로필</dt>
        <dd>{agents.length}개</dd>
        <dt>웹훅 키</dt>
        <dd>{webhooks.length}개</dd>
        <dt>세션</dt>
        <dd>{sessions.length}개</dd>
      </dl>
      {recentAuditEvents.length > 0 && (
        <div className="mcp-control-audit-list" aria-label="최근 감사 기록">
          {recentAuditEvents.map((event, index) => (
            <div key={`${event.auditId ?? 'audit'}-${index}`} className="mcp-control-audit-item">
              {summarizeAuditEvent(event)}
            </div>
          ))}
        </div>
      )}
      <div className="mcp-control-actions">
        <Button variant="secondary" size="md" icon="refresh" className="mcp-control-secondary-button" onClick={onReload}>
          새로고침
        </Button>
      </div>
    </div>
  );
}

function formatMcpEnabled(value: boolean | undefined): string {
  if (value === undefined) {
    return '알 수 없음';
  }
  return value ? '사용' : '사용 안 함';
}

function formatMcpBindMode(value: string | undefined): string {
  return formatMcpControlValue(value, MCP_BIND_MODE_LABELS);
}

function formatMcpTransportSecurity(value: string | undefined): string {
  return formatMcpControlValue(value, MCP_TRANSPORT_SECURITY_LABELS);
}

function formatMcpControlValue(value: string | undefined, labels: Record<string, string>): string {
  if (!value) {
    return '알 수 없음';
  }
  return labels[value] ?? `알 수 없음: ${value}`;
}

function summarizeAuditEvent(event: McpRecentAuditEvent): string {
  const label = formatMcpAuditAction(event.action ?? event.category);
  const outcome = formatMcpAuditOutcome(event.result ?? event.code ?? event.reason);
  const target = summarizeUnknown(event.targetBinding ?? event.target);
  return `${event.timestamp ?? '시간 없음'} ${label} ${outcome} 대상=${target}`;
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
      throw new Error('클립보드에 복사하지 못했습니다.');
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
  return 'MCP 제어 요청을 처리하지 못했습니다.';
}

function summarizeUnknown(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '없음';
  }
  if (typeof value === 'string') {
    return truncate(value, 180);
  }
  if (typeof value === 'boolean') {
    return value ? '예' : '아니오';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = ['ok', 'code', 'status', 'message', 'changedFields']
      .filter(key => record[key] !== undefined)
      .map(key => `${AUDIT_RECORD_FIELD_LABELS[key]}=${formatRecordValue(record[key])}`);
    return parts.length > 0 ? truncate(parts.join(' '), 220) : '객체';
  }
  return '알 수 없음';
}

function formatRecordValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(',');
  }
  if (typeof value === 'boolean') {
    return value ? '예' : '아니오';
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  return '객체';
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
