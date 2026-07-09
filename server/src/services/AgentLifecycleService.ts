import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  getDefaultMcpSessionScopes,
  mintMcpCapabilityToken,
  validateMcpAgentStatus,
} from './McpSecurityContract.js';

type StringRecord = Record<string, unknown>;

type AgentCommandProfile = {
  id: string;
  storeKind: 'agent-command-profile';
  displayName: string;
  command: string;
  args: string[];
  aliases: string[];
  isDefault: boolean;
  enabled: boolean;
  kickoffPrompt?: string;
  mcpClientConfigMode: 'env' | 'generated-file' | 'manual';
  createdAt: string;
  updatedAt: string;
};

type AgentLifecycleDeps = {
  now?: () => string;
  readinessMode?: unknown;
  failAt?: unknown;
  mcpUrl?: string;
  profiles?: {
    getProfile?: (profileId: string) => unknown;
  };
  workspace?: {
    preallocateMcpSession?: (request: unknown) => unknown;
    addTabWithLaunchContext?: (request: unknown) => unknown;
    deleteTab?: (request: unknown) => unknown;
    broadcast?: (event: unknown) => unknown;
  };
  inputGateway?: {
    submitInput?: (request: unknown) => unknown;
  };
  tokenStore?: {
    mint?: (request: unknown) => unknown;
    revoke?: (request: unknown) => unknown;
  };
  claimCodeStore?: {
    create?: (request: unknown) => unknown;
  };
  configStore?: {
    create?: (request: unknown) => unknown;
    delete?: (request: unknown) => unknown;
  };
  registry?: {
    update?: (request: unknown) => unknown;
    getSession?: (sessionKey: string) => unknown;
  };
  launchAttempts?: {
    record?: (request: unknown) => unknown;
  };
  scheduleClose?: (request: unknown) => unknown;
  audit?: (event: unknown) => void;
  recordCleanupEvidence?: (event: unknown) => unknown;
};

type PendingKickoff = {
  sessionKey: string;
  currentSessionId: string;
  leaderSessionKey: string;
  prompt: string;
  actor: StringRecord;
};

const DEFAULT_PROFILE_DATA_PATH = './data/agent-command-profiles.json';
const DEFAULT_MCP_URL = 'http://127.0.0.1:3333/mcp';
// @req FR-MCP-003
export function createAgentCommandProfileService(options: { dataPath?: string } = {}): StringRecord {
  const dataFilePath = path.resolve(options.dataPath ?? DEFAULT_PROFILE_DATA_PATH);
  let profiles: AgentCommandProfile[] = [];
  let loaded = false;
  let mutationChain: Promise<unknown> = Promise.resolve();

  const ensureLoaded = async (): Promise<void> => {
    if (loaded) {
      return;
    }
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
    try {
      const raw = await fs.readFile(dataFilePath, 'utf-8');
      const file = JSON.parse(raw) as { version?: number; profiles?: unknown[] };
      profiles = Array.isArray(file.profiles)
        ? file.profiles.map(normalizeProfile).filter((profile): profile is AgentCommandProfile => profile !== null)
        : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[AgentCommandProfileService] Failed to load profile store:', error);
      }
      profiles = [];
      await flush();
    }
    loaded = true;
  };

  const flush = async (): Promise<void> => {
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
    await fs.writeFile(dataFilePath, JSON.stringify({
      version: 1,
      profiles,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf-8');
  };

  const runMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(operation, operation);
    mutationChain = next.catch(() => undefined);
    return next;
  };

  return {
    initialize: ensureLoaded,
    getDataFilePath: () => dataFilePath,
    listProfiles: async () => {
      await ensureLoaded();
      return profiles.map(cloneProfile);
    },
    getProfile: async (profileId: string) => {
      await ensureLoaded();
      return cloneProfile(profiles.find(profile => profile.id === profileId || profile.aliases.includes(profileId)) ?? null);
    },
    createProfile: async (input: unknown) => runMutation(async () => {
      await ensureLoaded();
      const record = asRecord(input);
      const now = new Date().toISOString();
      const profile: AgentCommandProfile = {
        id: asString(record.id) ?? uuidv4(),
        storeKind: 'agent-command-profile',
        displayName: asString(record.displayName) ?? asString(record.name) ?? 'Agent',
        command: asString(record.command) ?? 'codex',
        args: asStringArray(record.args),
        aliases: asStringArray(record.aliases),
        isDefault: record.isDefault === true,
        enabled: record.enabled !== false,
        kickoffPrompt: asString(record.kickoffPrompt),
        mcpClientConfigMode: normalizeConfigMode(record.mcpClientConfigMode),
        createdAt: now,
        updatedAt: now,
      };
      if (profile.isDefault) {
        profiles = profiles.map(item => ({ ...item, isDefault: false }));
      }
      profiles.push(profile);
      await flush();
      return cloneProfile(profile);
    }),
    updateProfile: async (profileId: string, input: unknown) => runMutation(async () => {
      await ensureLoaded();
      const index = profiles.findIndex(profile => profile.id === profileId);
      if (index < 0) {
        return { ok: false, code: 'AGENT_PROFILE_NOT_FOUND' };
      }
      const record = asRecord(input);
      const current = profiles[index]!;
      const next: AgentCommandProfile = {
        ...current,
        displayName: asString(record.displayName) ?? current.displayName,
        command: asString(record.command) ?? current.command,
        args: record.args === undefined ? current.args : asStringArray(record.args),
        aliases: record.aliases === undefined ? current.aliases : asStringArray(record.aliases),
        isDefault: record.isDefault === undefined ? current.isDefault : record.isDefault === true,
        enabled: record.enabled === undefined ? current.enabled : record.enabled !== false,
        kickoffPrompt: record.kickoffPrompt === undefined ? current.kickoffPrompt : asString(record.kickoffPrompt),
        mcpClientConfigMode: record.mcpClientConfigMode === undefined
          ? current.mcpClientConfigMode
          : normalizeConfigMode(record.mcpClientConfigMode),
        updatedAt: new Date().toISOString(),
      };
      if (next.isDefault) {
        profiles = profiles.map(item => item.id === profileId ? next : { ...item, isDefault: false });
      } else {
        profiles[index] = next;
      }
      await flush();
      return cloneProfile(next);
    }),
    deleteProfile: async (profileId: string) => runMutation(async () => {
      await ensureLoaded();
      const before = profiles.length;
      profiles = profiles.filter(profile => profile.id !== profileId);
      if (profiles.length === before) {
        return { ok: false, code: 'AGENT_PROFILE_NOT_FOUND' };
      }
      await flush();
      return { ok: true, id: profileId };
    }),
  };
}

// @req FR-MCP-003
// @req REL-MCP-001
export function createMcpAgentLifecycleService(deps: AgentLifecycleDeps = {}): StringRecord {
  const pendingKickoffs = new Map<string, PendingKickoff>();

  const openAgent = async (request: unknown): Promise<StringRecord> => {
    const input = asRecord(request);
    const actor = asRecord(input.actor);
    const profileId = asString(input.profileId) ?? 'default';
    const leaderSessionKey = asString(input.leaderSessionKey) ?? asString(actor.sessionKey);
    if (!leaderSessionKey) {
      return { ok: false, code: 'LEADER_SESSION_REQUIRED' };
    }

    const profile = await resolveProfile(deps, profileId);
    if (!profile || profile.enabled === false) {
      return { ok: false, code: 'AGENT_PROFILE_NOT_FOUND' };
    }

    const mode = normalizeConfigMode(input.mcpClientConfigMode ?? profile.mcpClientConfigMode);
    const now = nowIso(deps);
    const launchAttemptId = `launch_${uuidv4()}`;
    const preallocated = asRecord(await callMaybeAsync(deps.workspace?.preallocateMcpSession, {
      workspaceId: input.workspaceId,
      profileId,
      leaderSessionKey,
      requestedAt: now,
    }));
    const sessionKey = asString(preallocated.sessionKey) ?? uuidv4();
    const currentSessionId = asString(preallocated.currentSessionId) ?? uuidv4();
    const agentKind = asString(input.agentKind) ?? inferAgentKind(profile.command);
    let actorToken: string | undefined;
    let configPath: string | undefined;
    let tabCreated = false;

    await recordLaunchAttempt(deps, {
      launchAttemptId,
      sessionKey,
      currentSessionId,
      leaderSessionKey,
      profileId,
      status: 'preallocated',
      requestedAt: now,
    });

    try {
      if (mode !== 'manual') {
        const tokenRecord = asRecord(await mintActorToken(deps, sessionKey));
        actorToken = asString(tokenRecord.token) ?? asString(tokenRecord.actorToken);
      }

      if (mode === 'generated-file') {
        const configRecord = asRecord(await createClientConfig(deps, {
          mcpUrl: mcpUrl(deps),
          sessionKey,
          currentSessionId,
          leaderSessionKey,
          actorToken,
          mode,
        }));
        configPath = asString(configRecord.path) ?? asString(configRecord.generatedConfigPath);
      }

      if (deps.failAt === 'before-tab') {
        throw lifecycleFailure('AGENT_LAUNCH_PRE_TAB_FAILED');
      }

      const claimRecord = mode === 'manual'
        ? asRecord(await createClaimCode(deps, { sessionKey, leaderSessionKey, profileId }))
        : {};
      const claimCode = asString(claimRecord.claimCode);
      const envPatch = buildLaunchEnvPatch({
        mcpUrl: mcpUrl(deps),
        sessionKey,
        currentSessionId,
        leaderSessionKey,
        actorToken,
        configPath,
      });
      const kickoffPrompt = asString(input.kickoffPrompt) ?? asString(profile.kickoffPrompt) ?? '';
      const launchContext = {
        workspaceId: input.workspaceId,
        profileId,
        launchAttemptId,
        sessionKey,
        currentSessionId,
        leaderSessionKey,
        name: asString(input.displayName) ?? profile.displayName,
        displayName: profile.displayName,
        command: commandLineForLaunch(input, profile),
        shellType: asString(input.shellType) ?? 'auto',
        cwd: asString(input.cwd),
        agentKind,
        agentStatus: 'starting',
        bindingLifecycle: 'live',
        mcpConnected: mode !== 'manual',
        lastSeenAt: now,
        kickoffPending: kickoffPrompt.length > 0,
        envPatch,
        generatedConfigPath: configPath,
      };
      await callMaybeAsync(deps.workspace?.addTabWithLaunchContext, launchContext);
      tabCreated = true;

      if (deps.failAt === 'after-tab') {
        throw lifecycleFailure('AGENT_LAUNCH_POST_TAB_FAILED');
      }

      await submitAgentCommand(deps, {
        actor,
        sessionKey,
        currentSessionId,
        command: String(launchContext.command),
      });

      const readinessTimedOut = deps.readinessMode === 'timeout';
      if (kickoffPrompt && readinessTimedOut) {
        pendingKickoffs.set(sessionKey, {
          sessionKey,
          currentSessionId,
          leaderSessionKey,
          prompt: kickoffPrompt,
          actor,
        });
        await updateRegistry(deps, {
          sessionKey,
          agentKind,
          agentStatus: 'starting',
          detail: 'kickoff pending until agent reports ready',
          mcpConnected: mode !== 'manual',
          kickoffPending: true,
          lastSeenAt: nowIso(deps),
        });
      } else if (kickoffPrompt) {
        await updateRegistry(deps, {
          sessionKey,
          agentKind,
          agentStatus: 'ready',
          detail: 'agent ready',
          mcpConnected: mode !== 'manual',
          kickoffPending: false,
          lastSeenAt: nowIso(deps),
        });
        await submitKickoff(deps, pendingKickoffs, {
          sessionKey,
          currentSessionId,
          leaderSessionKey,
          prompt: kickoffPrompt,
          actor,
        });
      }

      return {
        ok: true,
        sessionKey,
        currentSessionId,
        leaderSessionKey,
        actorToken: mode === 'manual' ? undefined : actorToken,
        claimCode,
        generatedConfigPath: mode === 'generated-file' ? configPath : undefined,
        kickoffPending: Boolean(kickoffPrompt && readinessTimedOut),
      };
    } catch (error) {
      const code = error instanceof LifecycleFailure ? error.code : 'AGENT_LAUNCH_FAILED';
      const cleanup = tabCreated
        ? await cleanupPostTabFailure(deps, { sessionKey, configPath, actorToken })
        : await cleanupPreTabFailure(deps, { sessionKey, configPath, actorToken });
      await recordLaunchAttempt(deps, {
        launchAttemptId,
        sessionKey,
        currentSessionId,
        leaderSessionKey,
        profileId,
        status: tabCreated ? 'failed' : 'cancelled',
        errorCode: code,
        cleanupStatus: cleanup.cleanupStatus,
        recordedAt: nowIso(deps),
      });
      return {
        ok: false,
        code,
        sessionKey,
        currentSessionId,
        cleanupStatus: cleanup.cleanupStatus,
      };
    }
  };

  const updateStatus = async (request: unknown): Promise<StringRecord> => {
    const input = asRecord(request);
    const actor = asRecord(input.actor);
    const sessionKey = asString(input.sessionKey) ?? asString(actor.sessionKey);
    const agentStatus = asString(input.agentStatus);
    if (!sessionKey || !agentStatus) {
      return { ok: false, code: 'INVALID_AGENT_STATUS' };
    }
    const validation = validateMcpAgentStatus(agentStatus);
    if (validation.ok === false) {
      return { ok: false, code: validation.code };
    }
    const update = {
      sessionKey,
      actor,
      agentKind: asString(input.agentKind),
      agentStatus,
      detail: asString(input.detail) ?? asString(input.statusMessage),
      mcpConnected: true,
      lastSeenAt: nowIso(deps),
    };
    await updateRegistry(deps, update);

    if (agentStatus === 'ready') {
      const pending = pendingKickoffs.get(sessionKey);
      if (pending) {
        await submitKickoff(deps, pendingKickoffs, pending);
      }
    }

    return {
      ok: true,
      ...update,
    };
  };

  const closeSession = async (request: unknown): Promise<StringRecord> => {
    const input = asRecord(request);
    const actor = asRecord(input.actor);
    const scopeDenied = requireAnyScope(actor, ['mcp:session.close']);
    if (scopeDenied) {
      return scopeDenied;
    }
    const sessionKey = asString(input.sessionKey);
    if (!sessionKey) {
      return { ok: false, code: 'TARGET_NOT_FOUND' };
    }
    if (
      input.confirmClose !== true
      || asString(input.expectedSessionKey) !== sessionKey
      || !asString(input.confirmationNonce)
    ) {
      return { ok: false, code: 'CLOSE_CONFIRMATION_REQUIRED' };
    }

    await updateRegistry(deps, { sessionKey, bindingLifecycle: 'closing', lastSeenAt: nowIso(deps) });
    const deleteResult = await deleteWorkspaceTab(deps, {
      sessionKey,
      confirmClose: true,
      confirmationNonce: asString(input.confirmationNonce),
    });
    const cleanupStatus = asString(deleteResult.processTreeCleanupStatus) ?? (deleteResult.ok === false ? 'failed' : 'completed');

    if (deleteResult.ok === false) {
      await updateRegistry(deps, { sessionKey, bindingLifecycle: 'closing-failed', lastSeenAt: nowIso(deps) });
      recordCleanupEvidence(deps, {
        sessionKey,
        processTreeCleanupStatus: cleanupStatus,
        cleanupStatus,
      });
      auditLifecycle(deps, {
        action: 'buildergate.session.close',
        actor,
        sessionKey,
        result: 'failed',
        code: asString(deleteResult.code) ?? 'TAB_DELETE_FAILED',
      });
      return {
        ok: false,
        code: asString(deleteResult.code) ?? 'TAB_DELETE_FAILED',
        sessionKey,
      };
    }

    deps.workspace?.broadcast?.({ type: 'tab:removed', sessionKey });
    recordCleanupEvidence(deps, {
      sessionKey,
      processTreeCleanupStatus: cleanupStatus,
      cleanupStatus,
    });
    auditLifecycle(deps, {
      action: 'buildergate.session.close',
      actor,
      sessionKey,
      result: 'closed',
    });
    return {
      ok: true,
      sessionKey,
      status: 'closed',
    };
  };

  const closeSelf = async (request: unknown): Promise<StringRecord> => {
    const input = asRecord(request);
    const actor = asRecord(input.actor);
    const scopeDenied = requireAnyScope(actor, ['mcp:session.close.self', 'mcp:session.close_self']);
    if (scopeDenied) {
      return scopeDenied;
    }
    const sessionKey = asString(actor.sessionKey);
    const registrySession = sessionKey && deps.registry?.getSession
      ? asRecord(await deps.registry.getSession(sessionKey))
      : {};
    const leaderSessionKey = asString(actor.leaderSessionKey) ?? asString(registrySession.leaderSessionKey);
    if (!sessionKey || !leaderSessionKey) {
      return { ok: false, code: 'SELF_CLOSE_DENIED_NO_LEADER' };
    }
    const delayMs = 500;
    const job = {
      sessionKey,
      leaderSessionKey,
      delayMs,
      reason: 'close_self',
    };
    if (deps.scheduleClose) {
      await callMaybeAsync(deps.scheduleClose, job);
    } else {
      setTimeout(() => {
        void closeSession({
          actor: { type: 'system', scopes: ['mcp:session.close'] },
          sessionKey,
          confirmClose: true,
          expectedSessionKey: sessionKey,
          confirmationNonce: 'deferred-close-self',
        });
      }, delayMs).unref?.();
    }
    return {
      ok: true,
      status: 'accepted',
      sessionKey,
      delayMs,
    };
  };

  return {
    openAgent,
    updateStatus,
    closeSession,
    closeSelf,
  };
}

function normalizeProfile(raw: unknown): AgentCommandProfile | null {
  const record = asRecord(raw);
  const id = asString(record.id);
  const command = asString(record.command);
  if (!id || !command) {
    return null;
  }
  const now = new Date().toISOString();
  return {
    id,
    storeKind: 'agent-command-profile',
    displayName: asString(record.displayName) ?? id,
    command,
    args: asStringArray(record.args),
    aliases: asStringArray(record.aliases),
    isDefault: record.isDefault === true,
    enabled: record.enabled !== false,
    kickoffPrompt: asString(record.kickoffPrompt),
    mcpClientConfigMode: normalizeConfigMode(record.mcpClientConfigMode),
    createdAt: asString(record.createdAt) ?? now,
    updatedAt: asString(record.updatedAt) ?? now,
  };
}

function cloneProfile(profile: AgentCommandProfile | null | undefined): AgentCommandProfile | null {
  return profile ? { ...profile, args: [...profile.args], aliases: [...profile.aliases] } : null;
}

async function resolveProfile(deps: AgentLifecycleDeps, profileId: string): Promise<StringRecord | null> {
  const profile = deps.profiles?.getProfile
    ? await deps.profiles.getProfile(profileId)
    : null;
  const record = asRecord(profile);
  if (Object.keys(record).length === 0) {
    return null;
  }
  return {
    id: asString(record.id) ?? profileId,
    displayName: asString(record.displayName) ?? profileId,
    command: asString(record.command) ?? 'codex',
    args: asStringArray(record.args),
    aliases: asStringArray(record.aliases),
    enabled: record.enabled !== false,
    kickoffPrompt: asString(record.kickoffPrompt),
    mcpClientConfigMode: normalizeConfigMode(record.mcpClientConfigMode),
  };
}

function normalizeConfigMode(value: unknown): 'env' | 'generated-file' | 'manual' {
  return value === 'generated-file' || value === 'manual' ? value : 'env';
}

function commandLineForLaunch(input: StringRecord, profile: StringRecord): string {
  const override = asString(input.command);
  if (override) {
    return override;
  }
  const command = asString(profile.command) ?? 'codex';
  const args = asStringArray(profile.args);
  return [command, ...args].join(' ');
}

function inferAgentKind(command: unknown): string {
  const text = asString(command) ?? 'agent';
  const executable = text.split(/\s+/u)[0] ?? text;
  return path.basename(executable).replace(/\.[^.]+$/u, '') || 'agent';
}

async function mintActorToken(deps: AgentLifecycleDeps, sessionKey: string): Promise<unknown> {
  const scopes = getDefaultMcpSessionScopes();
  if (deps.tokenStore?.mint) {
    return callMaybeAsync(deps.tokenStore.mint, {
      sessionKey,
      scopes,
      audience: 'buildergate-mcp',
    });
  }
  return mintMcpCapabilityToken({
    audience: 'buildergate-mcp',
    sessionKey,
    scopes,
    expiresInSeconds: 300,
  });
}

async function createClaimCode(deps: AgentLifecycleDeps, request: StringRecord): Promise<unknown> {
  if (deps.claimCodeStore?.create) {
    return callMaybeAsync(deps.claimCodeStore.create, request);
  }
  return {
    claimCode: `claim_${uuidv4()}`,
    ...request,
  };
}

async function createClientConfig(deps: AgentLifecycleDeps, request: StringRecord): Promise<unknown> {
  if (deps.configStore?.create) {
    return callMaybeAsync(deps.configStore.create, request);
  }
  const dir = path.join(os.tmpdir(), 'buildergate-mcp');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `mcp-client-${asString(request.sessionKey) ?? uuidv4()}.json`);
  await fs.writeFile(filePath, JSON.stringify(request, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return { path: filePath };
}

async function deleteClientConfig(deps: AgentLifecycleDeps, request: StringRecord): Promise<void> {
  if (deps.configStore?.delete) {
    await callMaybeAsync(deps.configStore.delete, request);
    return;
  }
  const filePath = asString(request.path);
  if (filePath) {
    await fs.rm(filePath, { force: true });
  }
}

function buildLaunchEnvPatch(input: {
  mcpUrl: string;
  sessionKey: string;
  currentSessionId: string;
  leaderSessionKey: string;
  actorToken?: string;
  configPath?: string;
}): Record<string, string> {
  return {
    BUILDERGATE_MCP_URL: input.mcpUrl,
    BUILDERGATE_MCP_SESSION_KEY: input.sessionKey,
    BUILDERGATE_MCP_CURRENT_SESSION_ID: input.currentSessionId,
    BUILDERGATE_MCP_LEADER_SESSION_KEY: input.leaderSessionKey,
    ...(input.actorToken ? { BUILDERGATE_MCP_TOKEN: input.actorToken } : {}),
    ...(input.configPath ? { BUILDERGATE_MCP_CLIENT_CONFIG_PATH: input.configPath } : {}),
  };
}

async function submitAgentCommand(deps: AgentLifecycleDeps, input: {
  actor: StringRecord;
  sessionKey: string;
  currentSessionId: string;
  command: string;
}): Promise<void> {
  const result = await submitInput(deps, {
    source: 'open-agent-command',
    actor: gatewayActor(input.actor),
    target: {
      sessionKey: input.sessionKey,
      sessionId: input.currentSessionId,
      expectedGeneration: 1,
    },
    data: input.command,
    delivery: { mode: 'submit', submit: true },
    replayPolicy: 'allow',
    auditContext: { purpose: 'agent-command' },
  });
  assertGatewayAccepted(result, 'AGENT_COMMAND_DELIVERY_FAILED');
}

async function submitKickoff(
  deps: AgentLifecycleDeps,
  pendingKickoffs: Map<string, PendingKickoff>,
  input: PendingKickoff,
): Promise<void> {
  const result = await submitInput(deps, {
    source: 'open-agent-kickoff',
    actor: gatewayActor(input.actor),
    target: {
      sessionKey: input.sessionKey,
      sessionId: input.currentSessionId,
      expectedGeneration: 1,
    },
    data: input.prompt,
    delivery: { mode: 'submit', submit: true },
    replayPolicy: 'allow',
    auditContext: { purpose: 'agent-kickoff' },
  });
  assertGatewayAccepted(result, 'AGENT_KICKOFF_DELIVERY_FAILED');
  pendingKickoffs.delete(input.sessionKey);
  await updateRegistry(deps, {
    sessionKey: input.sessionKey,
    agentStatus: 'ready',
    kickoffPending: false,
    mcpConnected: true,
    lastSeenAt: nowIso(deps),
  });
}

function gatewayActor(actor: StringRecord): StringRecord {
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  return {
    type: asString(actor.type) ?? 'mcp',
    sessionKey: actor.sessionKey,
    leaderSessionKey: actor.leaderSessionKey,
    scopes: [...new Set([...scopes, 'mcp:message.paste', 'mcp:message.submit'])],
  };
}

async function submitInput(deps: AgentLifecycleDeps, request: StringRecord): Promise<StringRecord> {
  const result = deps.inputGateway?.submitInput
    ? await callMaybeAsync(deps.inputGateway.submitInput, request)
    : { accepted: true };
  return asRecord(result);
}

function assertGatewayAccepted(result: StringRecord, fallbackCode: string): void {
  if (result.accepted === false || result.ok === false || result.status === 'failed') {
    throw lifecycleFailure(asString(result.code) ?? fallbackCode);
  }
}

async function updateRegistry(deps: AgentLifecycleDeps, request: StringRecord): Promise<void> {
  if (deps.registry?.update) {
    await callMaybeAsync(deps.registry.update, request);
  }
}

async function recordLaunchAttempt(deps: AgentLifecycleDeps, request: StringRecord): Promise<void> {
  if (deps.launchAttempts?.record) {
    await callMaybeAsync(deps.launchAttempts.record, request);
  }
}

async function cleanupPreTabFailure(
  deps: AgentLifecycleDeps,
  input: { sessionKey: string; configPath?: string; actorToken?: string },
): Promise<{ cleanupStatus: string }> {
  await revokeToken(deps, input);
  await deleteConfigIfNeeded(deps, input);
  return { cleanupStatus: 'completed' };
}

async function cleanupPostTabFailure(
  deps: AgentLifecycleDeps,
  input: { sessionKey: string; configPath?: string; actorToken?: string },
): Promise<{ cleanupStatus: string }> {
  const deleteResult = await deleteWorkspaceTab(deps, { sessionKey: input.sessionKey });
  const cleanupStatus = asString(deleteResult.processTreeCleanupStatus) ?? (deleteResult.ok === false ? 'failed' : 'completed');
  await revokeToken(deps, input);
  await deleteConfigIfNeeded(deps, input);
  recordCleanupEvidence(deps, {
    sessionKey: input.sessionKey,
    cleanupStatus,
    processTreeCleanupStatus: cleanupStatus,
  });
  return { cleanupStatus };
}

async function revokeToken(deps: AgentLifecycleDeps, input: { sessionKey: string; actorToken?: string }): Promise<void> {
  if (!deps.tokenStore?.revoke) {
    return;
  }
  await callMaybeAsync(deps.tokenStore.revoke, {
    sessionKey: input.sessionKey,
    token: input.actorToken,
    reason: 'agent-launch-cleanup',
  });
}

async function deleteConfigIfNeeded(deps: AgentLifecycleDeps, input: { sessionKey: string; configPath?: string }): Promise<void> {
  if (!input.configPath) {
    return;
  }
  await deleteClientConfig(deps, {
    sessionKey: input.sessionKey,
    path: input.configPath,
  });
}

async function deleteWorkspaceTab(deps: AgentLifecycleDeps, request: StringRecord): Promise<StringRecord> {
  if (!deps.workspace?.deleteTab) {
    return { ok: true, processTreeCleanupStatus: 'completed' };
  }
  try {
    const result = await callMaybeAsync(deps.workspace.deleteTab, request);
    const record = asRecord(result);
    return record.ok === undefined ? { ok: true, ...record } : record;
  } catch (error) {
    return {
      ok: false,
      code: error instanceof Error ? error.message : 'TAB_DELETE_FAILED',
      processTreeCleanupStatus: 'failed',
    };
  }
}

function recordCleanupEvidence(deps: AgentLifecycleDeps, event: StringRecord): void {
  deps.recordCleanupEvidence?.(event);
}

function auditLifecycle(deps: AgentLifecycleDeps, event: StringRecord): void {
  deps.audit?.({
    ...event,
    timestamp: nowIso(deps),
  });
}

function requireAnyScope(actor: StringRecord, requiredScopes: string[]): StringRecord | null {
  const scopes = Array.isArray(actor.scopes) ? actor.scopes.map(String) : [];
  return requiredScopes.some(scope => scopes.includes(scope))
    ? null
    : { ok: false, code: 'INVALID_SCOPE' };
}

function mcpUrl(deps: AgentLifecycleDeps): string {
  return asString(deps.mcpUrl) ?? DEFAULT_MCP_URL;
}

function nowIso(deps: AgentLifecycleDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function lifecycleFailure(code: string): LifecycleFailure {
  return new LifecycleFailure(code);
}

class LifecycleFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function callMaybeAsync(fn: ((request: unknown) => unknown) | undefined, request: unknown): Promise<unknown> {
  return fn ? await fn(request) : undefined;
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as StringRecord
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text && !result.includes(text)) {
      result.push(text);
    }
  }
  return result;
}
