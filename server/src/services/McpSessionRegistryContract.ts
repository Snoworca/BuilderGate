import { v4 as uuidv4 } from 'uuid';

export const MCP_SESSION_REGISTRY_DENIAL_CODES = {
  STALE_SESSION_ID: 'STALE_SESSION_ID',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  TARGET_NOT_FOUND: 'TARGET_NOT_FOUND',
  AMBIGUOUS_TARGET: 'AMBIGUOUS_TARGET',
} as const;

type AliasSource = 'default' | 'terminal-title' | 'user';
type LifecycleState = 'active' | 'stopped';

interface WorkspaceTabLike {
  id: string;
  workspaceId: string;
  sessionId?: string;
  currentSessionId?: string;
  previousSessionIds?: string[];
  sessionKey?: string;
  name?: string;
  nameSource?: AliasSource;
  terminalTitle?: string;
  lastCwd?: string;
  cwd?: string;
  recoveryCommand?: string;
  agentAlias?: string;
  agentAliases?: string[];
  lifecycleState?: LifecycleState;
  sortOrder?: number;
  generation?: number;
}

export interface McpSessionBinding {
  sessionKey: string;
  currentSessionId: string;
  previousSessionIds: string[];
  tabId?: string;
  workspaceId?: string;
  alias: string;
  aliasSource: AliasSource;
  terminalTitle?: string;
  cwd?: string;
  recoveryCommand?: string;
  agentAlias?: string;
  agentAliases?: string[];
  lifecycleState: LifecycleState;
  sortOrder: number;
  generation: number;
  generationReason?: string;
  updatedAt?: string;
  agentKind?: string;
  agentStatus?: string;
  mcpConnected?: boolean;
  leaderSessionKey?: string | null;
  bindingLifecycle?: string;
}

interface LiveSessionLike {
  tabId?: string;
  sessionId: string;
}

export type SearchMcpSessionsResult = {
  allowed: boolean;
  code?: string;
  reason?: string;
  matches: Array<Record<string, unknown>>;
  candidates?: Array<Record<string, unknown>>;
};

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function normalizeAliasSource(value: unknown): AliasSource {
  return value === 'user' || value === 'terminal-title' || value === 'default' ? value : 'default';
}

function normalizeLifecycleState(value: unknown): LifecycleState {
  return value === 'stopped' ? 'stopped' : 'active';
}

function normalizePreviousSessionIds(value: unknown, currentSessionId?: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    const sessionId = asNonEmptyString(raw);
    if (!sessionId || sessionId === currentSessionId || seen.has(sessionId)) {
      continue;
    }
    seen.add(sessionId);
    result.push(sessionId);
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value) {
    const item = asNonEmptyString(raw);
    if (!item || seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function createStableSessionKey(tabId?: string): string {
  const normalized = asNonEmptyString(tabId)?.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return normalized ? `sess_${normalized}` : `sess_${uuidv4()}`;
}

function allocateUniqueSessionKey(preferredSessionKey: string | undefined, tabId: string | undefined, used: Set<string>): { sessionKey: string; changed: boolean } {
  const preferred = asNonEmptyString(preferredSessionKey) ?? createStableSessionKey(tabId);
  if (!used.has(preferred)) {
    used.add(preferred);
    return { sessionKey: preferred, changed: preferred !== preferredSessionKey };
  }

  const stableForTab = createStableSessionKey(tabId);
  if (!used.has(stableForTab)) {
    used.add(stableForTab);
    return { sessionKey: stableForTab, changed: true };
  }

  let fallback = createStableSessionKey();
  while (used.has(fallback)) {
    fallback = createStableSessionKey();
  }
  used.add(fallback);
  return { sessionKey: fallback, changed: true };
}

function repairActiveBindingKeys(bindings: McpSessionBinding[]): McpSessionBinding[] {
  const used = new Set<string>();
  for (const binding of bindings) {
    if (binding.lifecycleState === 'stopped') {
      used.add(binding.sessionKey);
    }
  }

  return bindings.filter(binding => binding.lifecycleState !== 'stopped').map(binding => {
    const allocated = allocateUniqueSessionKey(binding.sessionKey, binding.tabId, used);
    if (!allocated.changed) {
      return binding;
    }
    return {
      ...binding,
      sessionKey: allocated.sessionKey,
    };
  });
}

function toBinding(raw: unknown): McpSessionBinding | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const input = raw as Record<string, unknown>;
  const currentSessionId = asNonEmptyString(input.currentSessionId) ?? asNonEmptyString(input.sessionId);
  if (!currentSessionId) {
    return null;
  }
  const tabId = asNonEmptyString(input.tabId) ?? asNonEmptyString(input.id) ?? undefined;
  const sessionKey = asNonEmptyString(input.sessionKey) ?? createStableSessionKey(tabId);
  const alias = asNonEmptyString(input.alias) ?? asNonEmptyString(input.name) ?? sessionKey;
  const workspaceId = asNonEmptyString(input.workspaceId) ?? undefined;
  return {
    sessionKey,
    currentSessionId,
    previousSessionIds: normalizePreviousSessionIds(input.previousSessionIds, currentSessionId),
    tabId,
    workspaceId,
    alias,
    aliasSource: normalizeAliasSource(input.aliasSource ?? input.nameSource),
    terminalTitle: asNonEmptyString(input.terminalTitle) ?? undefined,
    cwd: asNonEmptyString(input.cwd) ?? asNonEmptyString(input.lastCwd) ?? undefined,
    recoveryCommand: asNonEmptyString(input.recoveryCommand) ?? undefined,
    agentAlias: asNonEmptyString(input.agentAlias) ?? undefined,
    agentAliases: normalizeStringArray(input.agentAliases),
    lifecycleState: normalizeLifecycleState(input.lifecycleState),
    sortOrder: Number.isFinite(input.sortOrder) ? Number(input.sortOrder) : 0,
    generation: Number.isInteger(input.generation) && Number(input.generation) > 0 ? Number(input.generation) : 1,
    generationReason: asNonEmptyString(input.generationReason) ?? undefined,
    updatedAt: asNonEmptyString(input.updatedAt) ?? undefined,
    agentKind: asNonEmptyString(input.agentKind) ?? undefined,
    agentStatus: asNonEmptyString(input.agentStatus) ?? undefined,
    mcpConnected: typeof input.mcpConnected === 'boolean' ? input.mcpConnected : undefined,
    leaderSessionKey: asNonEmptyString(input.leaderSessionKey),
    bindingLifecycle: asNonEmptyString(input.bindingLifecycle) ?? undefined,
  };
}

function materializeRegistry(registry: unknown): McpSessionBinding[] {
  if (!Array.isArray(registry)) {
    return [];
  }
  return repairActiveBindingKeys(registry
    .map(toBinding)
    .filter((binding): binding is McpSessionBinding => binding !== null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.sessionKey.localeCompare(b.sessionKey)));
}

// @req FR-MCP-001
export function createMcpSessionBinding(input: { tab: WorkspaceTabLike; now?: string }): McpSessionBinding {
  const binding = toBinding(input.tab);
  if (!binding) {
    throw new Error('Workspace tab must provide a current session id');
  }
  return {
    ...binding,
    updatedAt: input.now ?? binding.updatedAt,
  };
}

// @req FR-MCP-001
export function updateCurrentSessionIdGeneration(input: {
  binding: McpSessionBinding;
  nextSessionId: string;
  reason: string;
  now?: string;
}): McpSessionBinding {
  const previous = normalizePreviousSessionIds(input.binding.previousSessionIds, input.nextSessionId);
  if (input.binding.currentSessionId !== input.nextSessionId && !previous.includes(input.binding.currentSessionId)) {
    previous.push(input.binding.currentSessionId);
  }
  return {
    ...input.binding,
    currentSessionId: input.nextSessionId,
    previousSessionIds: previous,
    generation: (Number.isInteger(input.binding.generation) ? input.binding.generation : 1) + 1,
    generationReason: input.reason,
    updatedAt: input.now ?? input.binding.updatedAt,
  };
}

// @req FR-MCP-001
export function resolveMcpSessionTarget(input: {
  actorSessionKey?: string;
  target: { sessionKey?: string; sessionId?: string };
  registry: unknown;
}): Record<string, unknown> {
  const registry = materializeRegistry(input.registry);
  const targetSessionKey = asNonEmptyString(input.target.sessionKey);
  const targetSessionId = asNonEmptyString(input.target.sessionId);
  const binding = registry.find(item => (
    (targetSessionKey !== null && item.sessionKey === targetSessionKey)
    || (targetSessionId !== null && item.currentSessionId === targetSessionId)
    || (targetSessionId !== null && item.previousSessionIds.includes(targetSessionId))
  ));

  if (!binding) {
    return { allowed: false, code: MCP_SESSION_REGISTRY_DENIAL_CODES.SESSION_NOT_FOUND };
  }
  if (targetSessionId !== null && targetSessionId !== binding.currentSessionId) {
    return {
      allowed: false,
      code: MCP_SESSION_REGISTRY_DENIAL_CODES.STALE_SESSION_ID,
      sessionKey: binding.sessionKey,
      currentSessionId: binding.currentSessionId,
    };
  }
  return {
    allowed: true,
    sessionKey: binding.sessionKey,
    currentSessionId: binding.currentSessionId,
    tabId: binding.tabId,
    workspaceId: binding.workspaceId,
  };
}

// @req FR-MCP-001
export function reconcileMcpSessionRegistry(input: {
  reason: string;
  workspaceTabs: WorkspaceTabLike[];
  liveSessions: LiveSessionLike[];
  now?: string;
}): { bindings: McpSessionBinding[]; removedStaleBindings: number; tabs: WorkspaceTabLike[] } {
  const liveByTabId = new Map(input.liveSessions.map(session => [session.tabId, session.sessionId]));
  const bindings: McpSessionBinding[] = [];
  const tabs: WorkspaceTabLike[] = [];
  const usedSessionKeys = new Set<string>();
  let removedStaleBindings = 0;

  for (const tab of input.workspaceTabs) {
    const liveSessionId = liveByTabId.get(tab.id);
    if (tab.lifecycleState === 'stopped' || !liveSessionId) {
      usedSessionKeys.add(asNonEmptyString(tab.sessionKey) ?? createStableSessionKey(tab.id));
    }
  }

  for (const tab of input.workspaceTabs) {
    if (tab.lifecycleState === 'stopped') {
      removedStaleBindings += 1;
      continue;
    }
    const liveSessionId = liveByTabId.get(tab.id);
    if (!liveSessionId) {
      removedStaleBindings += 1;
      continue;
    }
    const allocated = allocateUniqueSessionKey(tab.sessionKey ?? createStableSessionKey(tab.id), tab.id, usedSessionKeys);
    const backfilledTab = {
      ...tab,
      sessionKey: allocated.sessionKey,
      currentSessionId: tab.currentSessionId ?? tab.sessionId,
    };
    let binding = createMcpSessionBinding({ tab: backfilledTab, now: input.now });
    if (binding.currentSessionId !== liveSessionId) {
      binding = updateCurrentSessionIdGeneration({
        binding,
        nextSessionId: liveSessionId,
        reason: input.reason,
        now: input.now,
      });
      backfilledTab.currentSessionId = binding.currentSessionId;
      backfilledTab.previousSessionIds = binding.previousSessionIds;
      backfilledTab.generation = binding.generation;
    }
    bindings.push(binding);
    tabs.push(backfilledTab);
  }

  return {
    bindings: bindings.sort((a, b) => a.sortOrder - b.sortOrder || a.sessionKey.localeCompare(b.sessionKey)),
    removedStaleBindings,
    tabs,
  };
}

// @req FR-MCP-001
export function backfillLegacyWorkspaceTabs(input: {
  workspaceTabs: WorkspaceTabLike[];
  now?: string;
}): { tabs: WorkspaceTabLike[]; changed: boolean } {
  let changed = false;
  const usedSessionKeys = new Set<string>();
  const reservedStoppedSessionKeys = new Map<WorkspaceTabLike, string>();
  for (const tab of input.workspaceTabs) {
    if (tab.lifecycleState !== 'stopped') {
      continue;
    }
    const allocated = allocateUniqueSessionKey(tab.sessionKey ?? createStableSessionKey(tab.id), tab.id, usedSessionKeys);
    reservedStoppedSessionKeys.set(tab, allocated.sessionKey);
    if (tab.sessionKey !== allocated.sessionKey) {
      changed = true;
    }
  }

  const tabs = input.workspaceTabs.map(tab => {
    const currentSessionId = tab.currentSessionId ?? tab.sessionId;
    const reservedStoppedSessionKey = reservedStoppedSessionKeys.get(tab);
    const allocated = reservedStoppedSessionKey
      ? { sessionKey: reservedStoppedSessionKey, changed: false }
      : allocateUniqueSessionKey(tab.sessionKey ?? createStableSessionKey(tab.id), tab.id, usedSessionKeys);
    const sessionKey = allocated.sessionKey;
    if (tab.sessionKey !== sessionKey || (currentSessionId && tab.currentSessionId !== currentSessionId)) {
      changed = true;
    }
    return {
      ...tab,
      sessionKey,
      currentSessionId,
      previousSessionIds: normalizePreviousSessionIds(tab.previousSessionIds, currentSessionId),
    };
  });
  return { tabs, changed };
}

function toListItem(binding: McpSessionBinding, actorSessionKey?: string): Record<string, unknown> {
  return {
    sessionKey: binding.sessionKey,
    sessionId: binding.currentSessionId,
    currentSessionId: binding.currentSessionId,
    tabId: binding.tabId,
    workspaceId: binding.workspaceId,
    alias: binding.alias,
    aliasSource: binding.aliasSource,
    nameSource: binding.aliasSource,
    cwd: binding.cwd,
    lifecycleState: binding.lifecycleState,
    bindingLifecycle: binding.bindingLifecycle ?? 'live',
    agentKind: binding.agentKind ?? 'terminal',
    agentStatus: binding.agentStatus ?? 'unknown',
    mcpConnected: binding.mcpConnected ?? false,
    leaderSessionKey: binding.leaderSessionKey ?? null,
    sortOrder: binding.sortOrder,
    isSelf: binding.sessionKey === actorSessionKey,
  };
}

// @req FR-MCP-006
export function listMcpSessions(input: {
  actorSessionKey?: string;
  includeSelf?: boolean;
  registry: unknown;
}): { sessions: Array<Record<string, unknown>> } {
  const actorSessionKey = asNonEmptyString(input.actorSessionKey) ?? undefined;
  const includeSelf = input.includeSelf === true;
  const sessions = materializeRegistry(input.registry)
    .filter(binding => includeSelf || binding.sessionKey !== actorSessionKey)
    .map(binding => toListItem(binding, actorSessionKey));
  return { sessions };
}

function normalizeSearchValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function buildFieldMatch(
  value: unknown,
  query: string,
  matchSource: string,
  exactMatchType: string,
  partialMatchType: string,
  exactScore: number,
  partialScore: number,
): { matchType: string; matchSource: string; score: number } | null {
  const normalized = normalizeSearchValue(value);
  if (!normalized || !query) {
    return null;
  }
  if (normalized === query) {
    return { matchType: exactMatchType, matchSource, score: exactScore };
  }
  if (normalized.includes(query)) {
    return { matchType: partialMatchType, matchSource, score: partialScore };
  }
  return null;
}

function buildPrefixMatch(
  value: unknown,
  query: string,
  matchSource: string,
  exactScore: number,
  prefixScore: number,
): { matchType: string; matchSource: string; score: number } | null {
  const normalized = normalizeSearchValue(value);
  if (!normalized || !query) {
    return null;
  }
  if (normalized === query) {
    return { matchType: 'exact-tab', matchSource, score: exactScore };
  }
  if (normalized.startsWith(query)) {
    return { matchType: 'prefix-tab', matchSource, score: prefixScore };
  }
  return null;
}

function buildBestSearchMatch(binding: McpSessionBinding, actorSessionKey: string | undefined, query: string): Record<string, unknown> | null {
  const candidates: Array<{ matchType: string; matchSource: string; score: number }> = [];
  const userAlias = binding.aliasSource === 'user';
  const aliasSource = userAlias ? 'user-alias' : `${binding.aliasSource}-alias`;

  const sessionKeyMatch = buildFieldMatch(
    binding.sessionKey,
    query,
    'session-key',
    'exact-session-key',
    'partial-session-key',
    980,
    560,
  );
  if (sessionKeyMatch) {
    candidates.push(sessionKeyMatch);
  }

  const currentSessionIdMatch = buildFieldMatch(
    binding.currentSessionId,
    query,
    'current-session-id',
    'exact-current-session-id',
    'partial-current-session-id',
    970,
    550,
  );
  if (currentSessionIdMatch) {
    candidates.push(currentSessionIdMatch);
  }

  for (const previousSessionId of binding.previousSessionIds ?? []) {
    const match = buildFieldMatch(
      previousSessionId,
      query,
      'previous-session-id',
      'exact-previous-session-id',
      'partial-previous-session-id',
      880,
      440,
    );
    if (match) {
      candidates.push(match);
    }
  }

  const aliasMatch = buildFieldMatch(
    binding.alias,
    query,
    aliasSource,
    'exact-alias',
    'partial-alias',
    userAlias ? 1000 : 900,
    userAlias ? 600 : 520,
  );
  if (aliasMatch) {
    candidates.push(aliasMatch);
  }

  const terminalTitleMatch = buildFieldMatch(
    binding.terminalTitle,
    query,
    'terminal-title',
    'exact-terminal-title',
    'partial-terminal-title',
    800,
    500,
  );
  if (terminalTitleMatch) {
    candidates.push(terminalTitleMatch);
  }

  const tabMatch = buildPrefixMatch(binding.tabId, query, 'tab-prefix', 760, 740);
  if (tabMatch) {
    candidates.push(tabMatch);
  }

  const agentAliasMatch = buildFieldMatch(
    binding.agentAlias,
    query,
    'agent-alias',
    'exact-agent-alias',
    'partial-agent-alias',
    700,
    460,
  );
  if (agentAliasMatch) {
    candidates.push(agentAliasMatch);
  }

  for (const alias of binding.agentAliases ?? []) {
    const match = buildFieldMatch(alias, query, 'agent-alias', 'exact-agent-alias', 'partial-agent-alias', 700, 460);
    if (match) {
      candidates.push(match);
    }
  }

  const cwdMatch = buildFieldMatch(binding.cwd, query, 'cwd', 'exact-cwd', 'partial-cwd', 430, 420);
  if (cwdMatch) {
    candidates.push(cwdMatch);
  }

  const recoveryCommandMatch = buildFieldMatch(
    binding.recoveryCommand,
    query,
    'recovery-command',
    'exact-recovery-command',
    'partial-recovery-command',
    360,
    350,
  );
  if (recoveryCommandMatch) {
    candidates.push(recoveryCommandMatch);
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return {
    ...toListItem(binding, actorSessionKey),
    matchType: best.matchType,
    matchSource: best.matchSource,
    score: best.score,
  };
}

// @req FR-MCP-006
export function searchMcpSessions(input: {
  actorSessionKey?: string;
  query: string;
  includeSelf?: boolean;
  registry: unknown;
}): SearchMcpSessionsResult {
  const query = input.query.trim().toLowerCase();
  const actorSessionKey = asNonEmptyString(input.actorSessionKey) ?? undefined;
  const includeSelf = input.includeSelf === true;
  const matches: Array<Record<string, unknown>> = [];
  for (const binding of materializeRegistry(input.registry)) {
    if (!includeSelf && binding.sessionKey === actorSessionKey) {
      continue;
    }
    const match = buildBestSearchMatch(binding, actorSessionKey, query);
    if (match) {
      matches.push(match);
    }
  }
  matches.sort((a, b) => Number(b.score) - Number(a.score) || Number(a.sortOrder) - Number(b.sortOrder) || String(a.sessionKey).localeCompare(String(b.sessionKey)));
  if (matches.length === 0) {
    return {
      allowed: false,
      code: MCP_SESSION_REGISTRY_DENIAL_CODES.TARGET_NOT_FOUND,
      reason: 'zero-matches',
      matches: [],
      candidates: [],
    };
  }

  const topScore = Number(matches[0].score);
  const candidates = matches.filter(match => Number(match.score) === topScore);
  if (candidates.length > 1) {
    return {
      allowed: false,
      code: MCP_SESSION_REGISTRY_DENIAL_CODES.AMBIGUOUS_TARGET,
      reason: 'ambiguous-equal-rank',
      matches,
      candidates,
    };
  }

  return { allowed: true, matches };
}

// @req FR-MCP-006
export function setMcpSessionAlias(input: {
  actorSessionKey?: string;
  targetSessionKey: string;
  alias: string;
  registry: unknown;
  broadcast?: boolean;
}): Record<string, unknown> {
  const alias = input.alias.trim();
  if (!alias || alias.length > 32) {
    throw new Error('Alias must be 1-32 characters');
  }
  const registry = materializeRegistry(input.registry);
  const binding = registry.find(item => item.sessionKey === input.targetSessionKey);
  if (!binding) {
    return { allowed: false, code: MCP_SESSION_REGISTRY_DENIAL_CODES.SESSION_NOT_FOUND };
  }
  const updatedBinding: McpSessionBinding = {
    ...binding,
    alias,
    aliasSource: 'user',
  };
  const updatedTab = {
    id: binding.tabId,
    workspaceId: binding.workspaceId,
    sessionId: binding.currentSessionId,
    sessionKey: binding.sessionKey,
    currentSessionId: binding.currentSessionId,
    name: alias,
    nameSource: 'user',
  };
  const payload = {
    tabId: binding.tabId,
    workspaceId: binding.workspaceId,
    sessionKey: binding.sessionKey,
    currentSessionId: binding.currentSessionId,
    name: alias,
    nameSource: 'user',
  };
  return {
    allowed: true,
    updatedTab,
    binding: updatedBinding,
    broadcast: input.broadcast === true ? { event: 'tab:updated', payload } : undefined,
  };
}
