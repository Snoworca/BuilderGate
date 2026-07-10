/**
 * BuilderGate Server - Main Entry Point
 * Phase 1: Security Infrastructure (HTTPS + Security Headers)
 * Phase 2: Authentication Core (JWT + Password)
 * Phase 3: Two-Factor Authentication
 */

import express from 'express';
import cors from 'cors';
import https from 'https';
import http, { type IncomingMessage, type ServerResponse } from 'http';
import { existsSync } from 'fs';
import crypto from 'node:crypto';
import os from 'os';
import httpProxy from 'http-proxy';
import path from 'path';
import { createSessionRoutes } from './routes/sessionRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createFileRoutes } from './routes/fileRoutes.js';
import { createSettingsRoutes } from './routes/settingsRoutes.js';
import { createCommandPresetRoutes } from './routes/commandPresetRoutes.js';
import { createTerminalShortcutRoutes } from './routes/terminalShortcutRoutes.js';
import { createRecoveryOptionRoutes } from './routes/recoveryOptionRoutes.js';
import { createWorkspaceRoutes } from './routes/workspaceRoutes.js';
import { createInternalShutdownRoutes } from './routes/internalShutdownRoutes.js';
import { WorkspaceService } from './services/WorkspaceService.js';
import { config, getServerRoot } from './utils/config.js';
import { inputReliabilityMode } from './utils/inputReliabilityMode.js';
import { FileService } from './services/FileService.js';
import { RuntimeConfigStore } from './services/RuntimeConfigStore.js';
import { ConfigFileRepository } from './services/ConfigFileRepository.js';
import { SettingsService } from './services/SettingsService.js';
import { CommandPresetService } from './services/CommandPresetService.js';
import { TerminalShortcutService } from './services/TerminalShortcutService.js';
import { RecoveryOptionService } from './services/RecoveryOptionService.js';
import { SessionManager, sessionManager } from './services/SessionManager.js';
import { SSLService } from './services/SSLService.js';
import { CryptoService } from './services/CryptoService.js';
import { AuthService } from './services/AuthService.js';
import { BootstrapSetupService } from './services/BootstrapSetupService.js';
import { TOTPService } from './services/TOTPService.js';
import { reconcileTotpRuntime } from './services/twoFactorRuntime.js';
import { performGracefulShutdown } from './services/gracefulShutdown.js';
import type { Config } from './types/config.types.js';
import type { EditableSettingsKey } from './types/settings.types.js';
import {
  createSecurityHeadersMiddleware,
  createNoCacheMiddleware,
  createPermissionsPolicyMiddleware,
  createAuthMiddleware
} from './middleware/index.js';
import { ensureDebugCaptureSessionExists, requireLocalDebugCapture } from './middleware/debugCaptureGuards.js';
import { WsRouter } from './ws/WsRouter.js';
import {
  createMcpHttpHandler,
  createMcpListenerController,
  createMcpToolService,
} from './services/McpToolService.js';
import {
  buildMcpNodeRequestErrorResponse,
  readMcpIncomingRequestBody,
} from './services/McpNodeHttpBoundary.js';
import {
  buildMcpGatewayDeliveryResponse,
} from './services/McpGatewayDeliveryResult.js';
import {
  createAgentCommandProfileService,
  createMcpAgentLifecycleService,
} from './services/AgentLifecycleService.js';
import {
  createMcpControlService,
  mergeMcpControlSecurityConfig,
} from './services/McpControlService.js';
import {
  createMcpControlConfigFileStore,
  mergeStoredMcpControlConfig,
} from './services/McpControlConfigStore.js';
import {
  applyMcpControlConfigPatch,
} from './services/McpControlConfigCoordinator.js';
import {
  buildMcpControlRouteFailure,
  isMcpControlRouteFailure,
} from './services/McpControlRouteResult.js';
import {
  createWebhookInvocationService,
  createWebhookRecordFileStore,
} from './services/WebhookInvocationService.js';
import {
  createSessionInputGateway,
  submitMcpMessageInput,
} from './services/SessionInputGateway.js';
import {
  mintMcpCapabilityToken,
  validateMcpSecurityConfig,
  validateMcpWebhookKeyHeaderName,
} from './services/McpSecurityContract.js';

type McpHttpHandler = {
  handleRequest: (request: unknown) => unknown | Promise<unknown>;
};

type StringRecord = Record<string, unknown>;

type McpNodeListenerHandle = {
  server: http.Server;
  bindHost: string;
  port: number;
  listenerStatus: 'listening';
  activeConnectionCount: number;
};

const app = express();
const PORT = process.env.PORT || config.server.port;
const HTTP_PORT = Number(PORT) - 1; // HTTP redirect port
const DAEMON_START_ATTEMPT_ID = process.env.BUILDERGATE_DAEMON_START_ID ?? null;
const DAEMON_STATE_GENERATION = Number.parseInt(process.env.BUILDERGATE_DAEMON_STATE_GENERATION ?? '', 10);
const TOTP_SECRET_FILE_PATH = process.env.BUILDERGATE_TOTP_SECRET_PATH;
const SUPPRESS_TOTP_QR = process.env.BUILDERGATE_SUPPRESS_TOTP_QR === '1';
const SHUTDOWN_TOKEN = process.env.BUILDERGATE_SHUTDOWN_TOKEN;
const WEB_ROOT_ENV_KEY = 'BUILDERGATE_WEB_ROOT';
let fatalErrorLoggingInstalled = false;

// ============================================================================
// Service Instances (initialized in startServer)
// ============================================================================

let cryptoService: CryptoService;
let authService: AuthService;
let bootstrapSetupService: BootstrapSetupService;
let totpService: TOTPService | undefined;
let fileService: FileService;
let runtimeConfigStore: RuntimeConfigStore;
let settingsService: SettingsService;
let commandPresetService: CommandPresetService;
let terminalShortcutService: TerminalShortcutService;
let recoveryOptionService: RecoveryOptionService;
let workspaceService: WorkspaceService;
let mcpListenerControllerInstance: StringRecord | null = null;
let mcpControlService: StringRecord | null = null;
let webhookInvocationService: StringRecord | null = null;
let mcpControlConfigStore: StringRecord | null = null;
let agentCommandProfileService: StringRecord | null = null;
let cwdSnapshotTimer: ReturnType<typeof setInterval> | null = null;
let terminalObservabilityTimer: ReturnType<typeof setInterval> | null = null;

const PRODUCTION_PUBLIC_DIR = process.env[WEB_ROOT_ENV_KEY]?.trim()
  ? path.resolve(process.env[WEB_ROOT_ENV_KEY]!)
  : path.join(getServerRoot(), 'dist', 'public');
const PRODUCTION_INDEX_HTML = path.join(PRODUCTION_PUBLIC_DIR, 'index.html');

function setupFatalErrorLogging(): void {
  if (fatalErrorLoggingInstalled) {
    return;
  }

  process.on('uncaughtException', (error) => {
    console.error('[Fatal] Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Fatal] Unhandled rejection:', reason);
  });

  fatalErrorLoggingInstalled = true;
}

function isReservedRuntimePath(pathname: string): boolean {
  return pathname === '/health' || pathname === '/ws' || pathname === '/api' || pathname.startsWith('/api/');
}

function isStaticAssetRequest(pathname: string): boolean {
  return pathname === '/assets' || pathname.startsWith('/assets/') || path.posix.extname(pathname) !== '';
}

function isHtmlNavigationRequest(req: express.Request): boolean {
  if (req.method !== 'GET') {
    return false;
  }

  const pathname = req.path;
  return !isReservedRuntimePath(pathname) && !isStaticAssetRequest(pathname);
}

function applyTwoFactorRuntime(
  nextConfig: Config,
  changedKeys: EditableSettingsKey[] = [],
  options: { initialStartup?: boolean } = {},
): string[] {
  const result = reconcileTotpRuntime({
    currentService: totpService,
    nextConfig,
    cryptoService,
    changedKeys,
    secretFilePath: TOTP_SECRET_FILE_PATH,
    suppressConsoleQr: SUPPRESS_TOTP_QR,
    initialStartup: options.initialStartup ?? false,
  });
  totpService = result.service;
  return result.warnings;
}

async function performServerGracefulShutdown(reason: string) {
  const stopMcpListener = mcpListenerControllerInstance?.stop;
  if (typeof stopMcpListener === 'function') {
    await stopMcpListener();
  }
  const result = await performGracefulShutdown(reason, {
    sessionManager,
    workspaceService,
    timers: [
      { timer: cwdSnapshotTimer },
      { timer: terminalObservabilityTimer },
    ],
  });
  cwdSnapshotTimer = null;
  terminalObservabilityTimer = null;
  return result;
}

async function createMcpNodeHttpListener(
  configRecord: StringRecord,
  dispatch: (request: unknown) => unknown | Promise<unknown>,
): Promise<McpNodeListenerHandle> {
  const bindHost = typeof configRecord.bindHost === 'string' ? configRecord.bindHost : '127.0.0.1';
  const port = Number(configRecord.port ?? 3333);
  if (configRecord.transportSecurity === 'direct_tls') {
    throw new Error('MCP_DIRECT_TLS_REQUIRES_HTTPS_LISTENER');
  }
  const server = http.createServer((req, res) => {
    void handleMcpNodeRequest(req, res, dispatch);
  });
  const handle: McpNodeListenerHandle = {
    server,
    bindHost,
    port,
    listenerStatus: 'listening',
    activeConnectionCount: 0,
  };
  server.on('connection', (socket) => {
    handle.activeConnectionCount += 1;
    socket.on('close', () => {
      handle.activeConnectionCount = Math.max(0, handle.activeConnectionCount - 1);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, bindHost);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  handle.port = boundPort;
  return handle;
}

async function closeMcpNodeHttpListener(handle: unknown): Promise<void> {
  const server = (handle as Partial<McpNodeListenerHandle> | null)?.server;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function handleMcpNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  dispatch: (request: unknown) => unknown | Promise<unknown>,
): Promise<void> {
  try {
    const body = await readMcpIncomingRequestBody(req);
    const bearer = typeof req.headers.authorization === 'string'
      ? req.headers.authorization.match(/^Bearer\s+(.+)$/iu)?.[1]
      : undefined;
    const response = asRecord(await dispatch({
      method: req.method ?? 'GET',
      path: new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname,
      headers: req.headers,
      credential: bearer ? { type: 'mcp-capability', token: bearer } : undefined,
      body,
      remoteAddress: req.socket.remoteAddress ?? '',
    }));
    writeMcpNodeResponse(res, response);
  } catch (error) {
    console.warn('[MCP] Request handling failed:', error instanceof Error ? error.message : String(error));
    writeMcpNodeResponse(res, buildMcpNodeRequestErrorResponse(error));
  }
}

function writeMcpNodeResponse(res: ServerResponse, response: StringRecord): void {
  const body = response.body ?? {};
  res.statusCode = typeof response.status === 'number' ? response.status : 500;
  res.setHeader('Content-Type', typeof response.contentType === 'string' ? response.contentType : 'application/json; charset=utf-8');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function callMcpControlRoute(service: StringRecord | null, method: string, payload: unknown): Promise<unknown> {
  const fn = service?.[method];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'MCP_CONTROL_UNAVAILABLE', requestId: `req_${crypto.randomUUID()}` };
  }
  return await (fn as (request: unknown) => unknown)(payload);
}

function sendMcpControlRouteResult(res: express.Response, result: StringRecord, successStatus = 200): void {
  if (isMcpControlRouteFailure(result)) {
    const failure = buildMcpControlRouteFailure(result);
    res.status(failure.status).json(failure.body);
    return;
  }
  res.status(successStatus).json(result);
}

function sendMcpControlRouteError(res: express.Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'MCP_CONTROL_ERROR';
  res.status(500).json({
    ok: false,
    code: 'MCP_CONTROL_ERROR',
    message,
    requestId: `req_${crypto.randomUUID()}`,
  });
}

function flattenWebhookCredentialResult(result: StringRecord): StringRecord {
  const record = asRecord(result.record);
  return {
    ...record,
    fullKey: result.fullKey,
    fullUrl: result.fullUrl,
  };
}

function parseBooleanQuery(value: unknown, defaultValue: boolean): boolean {
  if (typeof value !== 'string') {
    return defaultValue;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }
  if (value.toLowerCase() === 'true') {
    return true;
  }
  return defaultValue;
}

function createMcpGatewayDelivery(): (delivery: StringRecord) => Promise<StringRecord> {
  return async (delivery: StringRecord) => {
    const sessionKey = typeof delivery.sessionKey === 'string' ? delivery.sessionKey : '';
    const prompt = typeof delivery.prompt === 'string' ? delivery.prompt : '';
    const actor = asRecord(delivery.actor);
    const deliveryMode = delivery.deliveryMode === 'submit' ? 'submit' : 'paste';
    const targetBinding = resolveMcpGatewayTarget(sessionKey, typeof actor.sessionKey === 'string' ? actor.sessionKey : undefined);
    const gateway = createSessionInputGateway({
      writeInput: (write) => sessionManager.writeInput(
        String(write.sessionId ?? ''),
        String(write.data ?? ''),
        write.metadata as never,
        {
          inputSeqStart: typeof write.inputSeqStart === 'number' ? write.inputSeqStart : undefined,
          inputSeqEnd: typeof write.inputSeqEnd === 'number' ? write.inputSeqEnd : undefined,
        },
      ),
      auditInput: (event) => console.info('[MCP Input Audit]', JSON.stringify(event)),
      resolveTarget: () => targetBinding,
      readReplayState: () => readMcpReplayState(targetBinding),
      evaluateInputPolicy: () => ({ ok: true }),
    });
    const result = asRecord(await submitMcpMessageInput(gateway, {
      target: { sessionKey },
      data: prompt,
      actor,
      delivery: { mode: deliveryMode, submit: deliveryMode === 'submit' },
      replayPolicy: 'reject',
      auditContext: {
        requestId: asRecord(delivery.context).requestId,
        sourceIp: asRecord(delivery.context).sourceIp,
        promptPreviewMaxChars: 24,
      },
    }));
    return buildMcpGatewayDeliveryResponse(result);
  };
}

function createMcpAgentInputGateway(): { submitInput: (request: unknown) => Promise<StringRecord> } {
  return {
    submitInput: async (request: unknown) => {
      const input = asRecord(request);
      const actor = asRecord(input.actor);
      const target = asRecord(input.target);
      const sessionKey = typeof target.sessionKey === 'string' ? target.sessionKey : '';
      const targetBinding = resolveMcpGatewayTarget(sessionKey, typeof actor.sessionKey === 'string' ? actor.sessionKey : undefined);
      const gateway = createSessionInputGateway({
        writeInput: (write) => sessionManager.writeInput(
          String(write.sessionId ?? ''),
          String(write.data ?? ''),
          write.metadata as never,
          {
            inputSeqStart: typeof write.inputSeqStart === 'number' ? write.inputSeqStart : undefined,
            inputSeqEnd: typeof write.inputSeqEnd === 'number' ? write.inputSeqEnd : undefined,
          },
        ),
        auditInput: (event) => console.info('[MCP Agent Input Audit]', JSON.stringify(event)),
        resolveTarget: () => targetBinding,
        readReplayState: () => readMcpReplayState(targetBinding),
        evaluateInputPolicy: () => ({ ok: true }),
      });
      return asRecord(await gateway.submitInput(input));
    },
  };
}

function readMcpReplayState(targetBinding: StringRecord): { replayPending: boolean; screenRepairPending: boolean } {
  const binding = asRecord(targetBinding.binding);
  const currentSessionId = typeof binding.currentSessionId === 'string' ? binding.currentSessionId : '';
  const wsRouter = app.get('wsRouter') as WsRouter | undefined;
  if (!currentSessionId || !wsRouter) {
    return { replayPending: false, screenRepairPending: false };
  }
  return wsRouter.readInputReplayState(currentSessionId);
}

function resolveMcpGatewayTarget(targetSessionKey: string, actorSessionKey?: string): StringRecord {
  const binding = workspaceService
    .listMcpSessions(actorSessionKey, true)
    .find((session) => session.sessionKey === targetSessionKey);
  if (!binding) {
    return {
      ok: false,
      code: 'TARGET_NOT_FOUND',
      message: 'MCP target session was not found',
      details: { sessionKey: targetSessionKey },
      fieldErrors: { sessionKey: 'not found' },
    };
  }
  const currentSessionId = typeof binding.currentSessionId === 'string'
    ? binding.currentSessionId
    : typeof binding.sessionId === 'string' ? binding.sessionId : '';
  if (!currentSessionId || binding.bindingLifecycle !== 'live' || !sessionManager.hasSession(currentSessionId)) {
    return {
      ok: false,
      code: 'TARGET_NOT_LIVE',
      message: 'MCP target session is not live',
      details: {
        sessionKey: targetSessionKey,
        currentSessionId,
        bindingLifecycle: binding.bindingLifecycle ?? 'unknown',
      },
      fieldErrors: { sessionKey: 'not live' },
    };
  }
  return {
    ok: true,
    binding: {
      sessionKey: targetSessionKey,
      currentSessionId,
      generation: binding.generation ?? 1,
      lifecycle: 'live',
    },
  };
}

function asRecord(value: unknown): StringRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as StringRecord : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(item => item.trim() !== '') : [];
}

// ============================================================================
// Security Middleware Stack (Phase 1)
// ============================================================================

// Security headers (helmet)
// In development, relax CSP to allow Vite's inline scripts and HMR WebSocket
const isDev = process.env.NODE_ENV !== 'production';
app.use(createSecurityHeadersMiddleware({
  enableHSTS: true,
  ...(isDev && {
    cspDirectives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "wss:", "ws:"],
      workerSrc: ["'self'", "blob:"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'none'"],
      frameSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    }
  })
}));

// Permissions-Policy header
app.use(createPermissionsPolicyMiddleware());

// No-cache for sensitive endpoints (applied selectively later)
const noCacheMiddleware = createNoCacheMiddleware();

// ============================================================================
// CORS Configuration
// ============================================================================

app.use(cors((req, callback) => {
  try {
    const runtimeCors = runtimeConfigStore?.getEditableValues().security.cors ?? {
      allowedOrigins: config.security?.cors.allowedOrigins ?? [],
      credentials: config.security?.cors.credentials ?? true,
      maxAge: config.security?.cors.maxAge ?? 86400,
    };

    const requestOrigin = req.header('Origin');
    const allowAllOrigins = runtimeCors.allowedOrigins.length === 0 && process.env.NODE_ENV !== 'production';
    const origin = !requestOrigin
      ? true
      : allowAllOrigins
        ? true
        : runtimeCors.allowedOrigins.includes(requestOrigin)
          ? requestOrigin
          : false;

    callback(null, {
      origin,
      credentials: runtimeCors.credentials,
      maxAge: runtimeCors.maxAge,
    });
  } catch (error) {
    callback(error as Error, {
      origin: false,
      credentials: false,
    });
  }
}));

app.all('/mcp', noCacheMiddleware, (_req, res) => {
  res.status(404).json({ error: { code: 'MCP_LISTENER_ONLY' } });
});

// ============================================================================
// Body Parser & General Middleware
// ============================================================================

app.use(express.json());

// Keep-alive header for all responses
app.use((_req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=120, max=1000');
  next();
});

// ============================================================================
// Routes Setup Function
// ============================================================================

function setupRoutes(): void {
  // Health check (no cache, no auth required)
  app.get('/health', noCacheMiddleware, (_req, res) => {
    res.setHeader('X-BuilderGate-Pid', String(process.pid));
    if (DAEMON_START_ATTEMPT_ID) {
      res.setHeader('X-BuilderGate-Start-Attempt-Id', DAEMON_START_ATTEMPT_ID);
    }
    if (Number.isInteger(DAEMON_STATE_GENERATION)) {
      res.setHeader('X-BuilderGate-State-Generation', String(DAEMON_STATE_GENERATION));
    }

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      https: true,
      authenticated: false,
      pid: process.pid,
      startAttemptId: DAEMON_START_ATTEMPT_ID,
      stateGeneration: Number.isInteger(DAEMON_STATE_GENERATION) ? DAEMON_STATE_GENERATION : null
    });
  });

  app.get('/api/runtime-config', noCacheMiddleware, (_req, res) => {
    res.json(runtimeConfigStore.getPublicRuntimeConfig(inputReliabilityMode));
  });

  app.use('/api/internal', createInternalShutdownRoutes({
    token: SHUTDOWN_TOKEN,
    performShutdown: performServerGracefulShutdown,
  }));

  // Auth routes (no auth required for login)
  const authRoutes = createAuthRoutes({
    getAuthService: () => authService,
    getTOTPService: () => totpService,
    getTwoFactorExternalOnly: () => runtimeConfigStore?.getEditableValues().twoFactor.externalOnly ?? false,
    getBootstrapSetupService: () => bootstrapSetupService,
    getRequestIp: (req) => req.socket.remoteAddress ?? req.ip ?? '',
  });
  app.use('/api/auth', authRoutes);

  // Protected session routes (auth required)
  const authMiddleware = createAuthMiddleware(() => authService);
  const settingsRoutes = createSettingsRoutes(settingsService);
  app.use('/api/settings', authMiddleware, settingsRoutes);
  const commandPresetRoutes = createCommandPresetRoutes(commandPresetService);
  app.use('/api/command-presets', authMiddleware, commandPresetRoutes);
  const terminalShortcutRoutes = createTerminalShortcutRoutes(terminalShortcutService);
  app.use('/api/terminal-shortcuts', authMiddleware, terminalShortcutRoutes);
  const recoveryOptionRoutes = createRecoveryOptionRoutes(recoveryOptionService, {
    onOptionUpdated: (option) => workspaceService.applyRecoveryOptionToTabs(option),
    onOptionDeleted: (id) => workspaceService.clearRecoveryMetadataForOption(id),
  });
  app.use('/api/recovery-options', authMiddleware, recoveryOptionRoutes);

  app.all('/webhook/agent', async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(webhookInvocationService, 'invokeWebhook', {
        method: req.method,
        path: req.path,
        url: req.originalUrl,
        remoteAddress: req.ip ?? req.socket.remoteAddress ?? '',
        headers: req.headers,
        query: req.query,
        body: req.body,
        prompt: asString(asRecord(req.body).prompt),
      }));
      sendMcpControlRouteResult(res, result, result.ok === false ? undefined : 202);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.get('/api/mcp-control/config', authMiddleware, async (_req, res) => {
    try {
      const control = asRecord(await callMcpControlRoute(mcpControlService, 'getConfig', { auth: { type: 'browser-jwt' } }));
      if (isMcpControlRouteFailure(control)) {
        sendMcpControlRouteResult(res, control);
        return;
      }
      const webhook = asRecord(await callMcpControlRoute(webhookInvocationService, 'getWebhookConfig', {}));
      if (isMcpControlRouteFailure(webhook)) {
        sendMcpControlRouteResult(res, webhook);
        return;
      }
      res.json({ ...control, webhookKeyHeaderName: webhook.webhookKeyHeaderName, webhookRateLimit: webhook.rateLimit });
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.patch('/api/mcp-control/config', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await applyMcpControlConfigPatch({
        body: req.body,
        controlService: mcpControlService,
        webhookService: webhookInvocationService,
        configStore: mcpControlConfigStore,
        validateWebhookHeaderName: validateMcpWebhookKeyHeaderName,
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.get('/api/mcp-control/agents', authMiddleware, async (_req, res) => {
    try {
      const listProfiles = agentCommandProfileService?.listProfiles as (() => Promise<unknown[]>) | undefined;
      res.json({ agents: listProfiles ? await listProfiles() : [] });
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.post('/api/mcp-control/agents', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'createAgentProfile', {
        ...asRecord(req.body),
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result, result.ok === false ? undefined : 201);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.patch('/api/mcp-control/agents/:id', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'updateAgentProfile', {
        ...asRecord(req.body),
        id: req.params.id,
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.delete('/api/mcp-control/agents/:id', authMiddleware, async (req, res) => {
    try {
      const deleteProfile = agentCommandProfileService?.deleteProfile as ((id: string) => Promise<unknown>) | undefined;
      const result = asRecord(deleteProfile ? await deleteProfile(req.params.id) : { ok: false, code: 'AGENT_PROFILE_NOT_FOUND' });
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.get('/api/mcp-control/webhooks', authMiddleware, async (_req, res) => {
    try {
      const rawResult = await callMcpControlRoute(webhookInvocationService, 'listWebhookKeys', {});
      const result = asRecord(rawResult);
      if (isMcpControlRouteFailure(result)) {
        sendMcpControlRouteResult(res, result);
        return;
      }
      res.json({ webhooks: Array.isArray(rawResult) ? rawResult : Array.isArray(result.webhooks) ? result.webhooks : [] });
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.post('/api/mcp-control/webhooks', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(webhookInvocationService, 'createWebhookKey', req.body));
      sendMcpControlRouteResult(res, result.ok === false ? result : flattenWebhookCredentialResult(result), 201);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.post('/api/mcp-control/webhooks/:id/rotate', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(webhookInvocationService, 'rotateWebhookKey', {
        ...asRecord(req.body),
        id: req.params.id,
      }));
      sendMcpControlRouteResult(res, result.ok === false ? result : flattenWebhookCredentialResult(result));
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.delete('/api/mcp-control/webhooks/:id', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(webhookInvocationService, 'revokeWebhookKey', { id: req.params.id }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.get('/api/mcp-control/sessions', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'listSessions', {
        query: asString(req.query.query),
        includeSelf: parseBooleanQuery(req.query.includeSelf, true),
        actorSessionKey: asString(req.query.actorSessionKey),
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.post('/api/mcp-control/sessions/search-test', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'searchTest', {
        ...asRecord(req.body),
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.patch('/api/mcp-control/sessions/:sessionKey/alias', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'setSessionAlias', {
        ...asRecord(req.body),
        sessionKey: req.params.sessionKey,
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.post('/api/mcp-control/sessions/:sessionKey/reply-test', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'replyTest', {
        ...asRecord(req.body),
        sessionKey: req.params.sessionKey,
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.post('/api/mcp-control/sessions/:sessionKey/close', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'closeSession', {
        ...asRecord(req.body),
        sessionKey: req.params.sessionKey,
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.patch('/api/mcp-control/sessions/:sessionKey/status', authMiddleware, async (req, res) => {
    try {
      const result = asRecord(await callMcpControlRoute(mcpControlService, 'updateAgentStatus', {
        ...asRecord(req.body),
        sessionKey: req.params.sessionKey,
        auth: { type: 'browser-jwt' },
      }));
      sendMcpControlRouteResult(res, result);
    } catch (error) {
      sendMcpControlRouteError(res, error);
    }
  });

  app.get('/api/sessions/telemetry', authMiddleware, (_req, res) => {
    const wsRouter = app.get('wsRouter') as WsRouter | undefined;
    res.json({
      sessions: sessionManager.getObservabilitySnapshot(),
      ws: wsRouter?.getObservabilitySnapshot() ?? null,
    });
  });
  const requireExistingDebugSession = ensureDebugCaptureSessionExists(sessionManager);
  app.get('/api/sessions/debug-capture/:id', authMiddleware, requireLocalDebugCapture, requireExistingDebugSession, (req, res) => {
    const wsRouter = app.get('wsRouter') as WsRouter | undefined;
    const sessionId = req.params.id;
    const limit = Math.max(1, Math.min(500, Number.parseInt(String(req.query.limit ?? '200'), 10) || 200));
    res.json({
      sessionId,
      enabled: sessionManager.isDebugCaptureEnabled(sessionId),
      server: sessionManager.getDebugCapture(sessionId, limit),
      replay: sessionManager.isDebugCaptureEnabled(sessionId)
        ? wsRouter?.getDebugReplayEvents(sessionId, limit) ?? []
        : [],
    });
  });
  app.post('/api/sessions/debug-capture/:id/enable', authMiddleware, requireLocalDebugCapture, requireExistingDebugSession, (req, res) => {
    const wsRouter = app.get('wsRouter') as WsRouter | undefined;
    sessionManager.enableDebugCapture(req.params.id);
    wsRouter?.enableDebugReplayCapture(req.params.id);
    res.status(204).send();
  });
  app.delete('/api/sessions/debug-capture/:id', authMiddleware, requireLocalDebugCapture, requireExistingDebugSession, (req, res) => {
    const wsRouter = app.get('wsRouter') as WsRouter | undefined;
    sessionManager.disableDebugCapture(req.params.id);
    sessionManager.clearDebugCapture(req.params.id);
    wsRouter?.disableDebugReplayCapture(req.params.id);
    wsRouter?.clearReplayEvents(req.params.id);
    res.status(204).send();
  });
  const sessionRoutes = createSessionRoutes({
    onSessionDeleting: (sessionId) => workspaceService.markSessionStoppedByDirectDelete(sessionId),
  });
  app.use('/api/sessions', authMiddleware, sessionRoutes);

  // Workspace routes (auth required, Step 7)
  const workspaceRoutes = createWorkspaceRoutes(workspaceService);
  app.use('/api/workspaces', authMiddleware, workspaceRoutes);

  // File manager routes (auth required, same base path)
  const fileRoutes = createFileRoutes(fileService);
  app.use('/api/sessions', authMiddleware, fileRoutes);

  console.log('[Routes] API routes configured');
  console.log('  - GET  /health (public)');
  console.log('  - POST /api/auth/login (public)');
  if (totpService?.isRegistered()) {
    console.log('  - POST /api/auth/verify (public, TOTP)');
  }
  console.log('  - POST /api/auth/logout (protected)');
  console.log('  - POST /api/auth/refresh (protected)');
  console.log('  - GET  /api/auth/status (protected)');
  console.log('  - GET  /api/settings (protected)');
  console.log('  - PATCH /api/settings (protected)');
  console.log('  - /api/command-presets/* (protected)');
  console.log('  - /api/terminal-shortcuts/* (protected)');
  console.log('  - /api/sessions/* (protected)');
  console.log('  - /api/sessions/:id/cwd (protected, File API)');
  console.log('  - /api/sessions/:id/files (protected, File API)');
}

// ============================================================================
// Error Handling
// ============================================================================

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err.message);
  if (req.path === '/mcp') {
    res.status(400).type('application/json; charset=utf-8').json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
        data: { code: 'MCP_JSON_PARSE_ERROR' },
      },
    });
    return;
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// Server Initialization
// ============================================================================

async function startServer(): Promise<void> {
  try {
    // ========================================================================
    // Initialize Crypto Service (Phase 2)
    // ========================================================================
    // Use machine ID + hostname as master key source for consistency
    const machineId = `${os.hostname()}-${os.platform()}-${os.arch()}`;
    cryptoService = new CryptoService(machineId);
    console.log('[Crypto] CryptoService initialized');

    // ========================================================================
    // Initialize Runtime Settings Services (Step 5)
    // ========================================================================
    runtimeConfigStore = new RuntimeConfigStore(config);
    const configRepository = new ConfigFileRepository();
    sessionManager.assertRuntimePtyCapabilities();
    await sessionManager.warmPowerShellWinptyCapability();

    // ========================================================================
    // Initialize Auth Service (Phase 2)
    // ========================================================================
    const authConfig = config.auth || {
      password: '',
      durationMs: 1800000,
      maxDurationMs: 86400000,
      jwtSecret: ''
    };
    authService = new AuthService(authConfig, cryptoService);
    if (!authConfig.jwtSecret) {
      const encryptedJwtSecret = authService.getEncryptedJwtSecret();
      configRepository.persistAuthSecrets({ authJwtSecret: encryptedJwtSecret });
      authConfig.jwtSecret = encryptedJwtSecret;
      console.log('[Auth] Persisted generated JWT secret');
    }
    bootstrapSetupService = new BootstrapSetupService({
      authService,
      cryptoService,
      configRepository,
      getConfiguredAllowedIps: () => config.bootstrap?.allowedIps ?? [],
    });

    // ========================================================================
    // Initialize TOTP Service (Step 6 — FR-102)
    // ========================================================================
    if (config.twoFactor?.enabled) {
      applyTwoFactorRuntime(config, [], { initialStartup: true });
    } else {
      console.log('[TOTP] TOTP is disabled');
    }

    const fileManagerConfig = config.fileManager || {
      maxFileSize: 1048576,
      maxCodeFileSize: 524288,
      maxDirectoryEntries: 10000,
      blockedExtensions: ['.exe', '.dll', '.so', '.bin'],
      blockedPaths: ['.ssh', '.gnupg', '.aws'],
      cwdCacheTtlMs: 1000,
    };
    fileService = new FileService(sessionManager, fileManagerConfig);
    settingsService = new SettingsService({
      runtimeConfigStore,
      configRepository,
      cryptoService,
      authService,
      getFileService: () => fileService,
      sessionManager,
      getWsRouter: () => app.get('wsRouter') as WsRouter | undefined,
      updateTwoFactorRuntime: (nextConfig, changedKeys) => applyTwoFactorRuntime(nextConfig, changedKeys),
    });
    commandPresetService = new CommandPresetService();
    await commandPresetService.initialize();
    console.log('[CommandPreset] CommandPresetService initialized');
    terminalShortcutService = new TerminalShortcutService();
    await terminalShortcutService.initialize();
    console.log('[TerminalShortcut] TerminalShortcutService initialized');
    recoveryOptionService = new RecoveryOptionService();
    await recoveryOptionService.initialize();
    console.log('[RecoveryOption] RecoveryOptionService initialized');

    // ========================================================================
    // Initialize Workspace Service (Step 7)
    // ========================================================================
    workspaceService = new WorkspaceService(sessionManager, { recoveryOptionService });
    await workspaceService.initialize();
    const orphanTabs = await workspaceService.checkOrphanTabs();
    if (orphanTabs.length > 0) {
      console.log(`[Workspace] ${orphanTabs.length} orphan tab(s) recovered with saved CWD`);
    }
    console.log('[Workspace] WorkspaceService initialized');

    const agentProfileService = createAgentCommandProfileService();
    agentCommandProfileService = agentProfileService;
    if (typeof agentProfileService.initialize === 'function') {
      await (agentProfileService.initialize as () => Promise<void>)();
    }
    const existingAgentProfiles = typeof agentProfileService.listProfiles === 'function'
      ? await (agentProfileService.listProfiles as () => Promise<unknown[]>)()
      : [];
    if (existingAgentProfiles.length === 0 && typeof agentProfileService.createProfile === 'function') {
      await (agentProfileService.createProfile as (input: unknown) => Promise<unknown>)({
        id: 'codex-env',
        displayName: 'Codex',
        command: 'codex',
        args: [],
        aliases: ['codex', 'builder'],
        isDefault: true,
        enabled: true,
        mcpClientConfigMode: 'env',
      });
    }

    const mcpClaimCodes = new Map<string, Record<string, unknown>>();
    const mcpAgentTokens = new Map<string, { sessionKey: string; revoked: boolean; createdAt: string }>();
    const agentTokenStore = {
      mint: (request: unknown) => {
        const record = asRecord(request);
        const sessionKey = asString(record.sessionKey) ?? '';
        const scopes = Array.isArray(record.scopes) ? record.scopes.map(String) : [];
        const requestedExpiresInSeconds = Number(record.expiresInSeconds ?? 300);
        const tokenRecord = asRecord(mintMcpCapabilityToken({
          audience: asString(record.audience) ?? 'buildergate-mcp',
          sessionKey,
          scopes,
          expiresInSeconds: Number.isFinite(requestedExpiresInSeconds) ? requestedExpiresInSeconds : 300,
        }));
        const token = asString(tokenRecord.token);
        if (token) {
          mcpAgentTokens.set(token, {
            sessionKey,
            revoked: false,
            createdAt: new Date().toISOString(),
          });
        }
        return tokenRecord;
      },
      revoke: (request: unknown) => {
        const record = asRecord(request);
        const token = asString(record.token);
        const sessionKey = asString(record.sessionKey);
        let revoked = 0;
        if (token && mcpAgentTokens.has(token)) {
          const entry = mcpAgentTokens.get(token);
          if (entry) {
            entry.revoked = true;
            revoked += 1;
          }
        }
        if (sessionKey) {
          for (const entry of mcpAgentTokens.values()) {
            if (entry.sessionKey === sessionKey && !entry.revoked) {
              entry.revoked = true;
              revoked += 1;
            }
          }
        }
        return { ok: true, revoked };
      },
      isRevoked: (credential: StringRecord) => {
        const token = asString(credential.token);
        return token ? mcpAgentTokens.get(token)?.revoked === true : false;
      },
    };
    mcpControlConfigStore = createMcpControlConfigFileStore();
    const loadMcpControlConfig = mcpControlConfigStore.loadConfig as (() => Promise<unknown>) | undefined;
    const getMcpControlConfigDataPath = mcpControlConfigStore.getDataFilePath as (() => string) | undefined;
    const defaultMcpPort = Number.parseInt(process.env.BUILDERGATE_MCP_PORT ?? '3333', 10) || 3333;
    const initialMcpControlConfig = mergeStoredMcpControlConfig({
      enabled: true,
      bindMode: 'loopback',
      bindHost: '127.0.0.1',
      host: '127.0.0.1',
      port: defaultMcpPort,
      externalWhitelist: [],
      transportSecurity: 'none',
      trustedProxies: [],
      allowedOrigins: [],
    }, loadMcpControlConfig ? await loadMcpControlConfig() : {}, {
      dataPath: getMcpControlConfigDataPath?.(),
      warn: event => console.warn('[McpControlConfigStore] Ignoring invalid persisted MCP control config:', event),
    });
    const mcpPort = Number(initialMcpControlConfig.port ?? defaultMcpPort) || defaultMcpPort;
    let mcpAgentLifecycleService: Record<string, unknown>;
    let mcpHandlerForListener: McpHttpHandler | null = null;
    const mcpListenerController = createMcpListenerController({
      current: {
        bindMode: asString(initialMcpControlConfig.bindMode) ?? 'loopback',
        bindHost: asString(initialMcpControlConfig.bindHost) ?? asString(initialMcpControlConfig.host) ?? '127.0.0.1',
        port: mcpPort,
        externalWhitelist: stringArray(initialMcpControlConfig.externalWhitelist),
        transportSecurity: asString(initialMcpControlConfig.transportSecurity) ?? 'none',
        trustedProxies: stringArray(initialMcpControlConfig.trustedProxies),
        allowedOrigins: stringArray(initialMcpControlConfig.allowedOrigins),
        listenerStatus: 'stopped',
      },
      audit: (event) => console.info('[MCP Audit]', JSON.stringify(event)),
      bindListener: (candidate) => createMcpNodeHttpListener(asRecord(candidate), async (request) => {
        if (!mcpHandlerForListener) {
          return {
            status: 503,
            contentType: 'application/json; charset=utf-8',
            body: { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP_LISTENER_UNAVAILABLE' } },
          };
        }
        return await mcpHandlerForListener.handleRequest(request);
      }),
      closeListener: (handle) => closeMcpNodeHttpListener(handle),
      isCredentialRevoked: agentTokenStore.isRevoked,
    });
    mcpAgentLifecycleService = createMcpAgentLifecycleService({
      now: () => new Date().toISOString(),
      mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      profiles: {
        getProfile: (profileId: string) => {
          const getProfile = agentProfileService.getProfile as ((id: string) => unknown) | undefined;
          return getProfile?.(profileId);
        },
      },
      workspace: {
        preallocateMcpSession: (request) => workspaceService.preallocateMcpSession(request),
        addTabWithLaunchContext: (request) => workspaceService.addTabWithLaunchContext(request),
        deleteTab: (request) => workspaceService.deleteMcpSession(request),
        broadcast: (event) => {
          const record = asRecord(event);
          const wsRouter = app.get('wsRouter') as WsRouter | undefined;
          wsRouter?.broadcastAll(asString(record.type) ?? 'tab:removed', record);
        },
      },
      inputGateway: createMcpAgentInputGateway(),
      tokenStore: agentTokenStore,
      claimCodeStore: {
        create: (request) => {
          const claimCode = `claim_${crypto.randomUUID()}`;
          mcpClaimCodes.set(claimCode, {
            ...asRecord(request),
            claimCode,
            used: false,
            createdAt: new Date().toISOString(),
          });
          return { claimCode, ...asRecord(request) };
        },
      },
      registry: {
        update: (request) => workspaceService.updateMcpAgentStatus(request),
        getSession: (sessionKey: string) => workspaceService.getMcpSessionByKey(sessionKey),
      },
      scheduleClose: (request) => {
        const job = asRecord(request);
        const delayMs = Math.min(1000, Math.max(250, Number(job.delayMs ?? 500)));
        setTimeout(() => {
          const closeSession = mcpAgentLifecycleService.closeSession as ((payload: unknown) => Promise<unknown>) | undefined;
          void closeSession?.({
            actor: { type: 'system', scopes: ['mcp:session.close'] },
            sessionKey: job.sessionKey,
            confirmClose: true,
            expectedSessionKey: job.sessionKey,
            confirmationNonce: 'deferred-close-self',
          });
        }, delayMs).unref?.();
        return { ok: true, delayMs };
      },
      audit: (event) => console.info('[MCP Agent Audit]', JSON.stringify(event)),
      recordCleanupEvidence: (event) => console.info('[MCP Agent Cleanup]', JSON.stringify(event)),
    });
    const mcpToolService = createMcpToolService({
      now: () => new Date().toISOString(),
      audit: (event) => console.info('[MCP Tool Audit]', JSON.stringify(event)),
      log: (event) => console.info('[MCP]', JSON.stringify(event)),
      claimCodes: mcpClaimCodes,
      listSessions: (actorSessionKey, includeSelf) => workspaceService.listMcpSessions(actorSessionKey, includeSelf),
      searchSessions: (actorSessionKey, query, includeSelf) => workspaceService.searchMcpSessions(actorSessionKey, query, includeSelf),
      setSessionAlias: (targetSessionKey, alias, actorSessionKey) => workspaceService.setMcpSessionAlias(targetSessionKey, alias, actorSessionKey),
      deliverMessage: createMcpGatewayDelivery(),
      agentLifecycle: mcpAgentLifecycleService,
      listener: () => {
        const getStatus = mcpListenerController.getStatus;
        return typeof getStatus === 'function' ? getStatus({}) : {};
      },
    });
    const webhookRateLimits = new Map<string, { windowStartedAt: number; count: number }>();
    const mcpControlSecurityConfig: StringRecord = {
      enabled: initialMcpControlConfig.enabled !== false,
      bindMode: asString(initialMcpControlConfig.bindMode) ?? 'loopback',
      bindHost: asString(initialMcpControlConfig.bindHost) ?? asString(initialMcpControlConfig.host) ?? '127.0.0.1',
      port: mcpPort,
      externalWhitelist: stringArray(initialMcpControlConfig.externalWhitelist),
      transportSecurity: asString(initialMcpControlConfig.transportSecurity) ?? 'none',
      trustedProxies: stringArray(initialMcpControlConfig.trustedProxies),
      allowedOrigins: stringArray(initialMcpControlConfig.allowedOrigins),
    };
    const webhookRecordStore = createWebhookRecordFileStore();
    const existingWebhookRecords = typeof webhookRecordStore.loadRecords === 'function'
      ? await (webhookRecordStore.loadRecords as () => Promise<StringRecord[]>)()
      : [];
    webhookInvocationService = createWebhookInvocationService({
      now: () => new Date().toISOString(),
      webhookRecords: existingWebhookRecords,
      webhookKeyHeaderName: initialMcpControlConfig.webhookKeyHeaderName,
      webhookRateLimit: initialMcpControlConfig.webhookRateLimit,
      persistWebhookRecords: async (records) => {
        const saveRecords = webhookRecordStore.saveRecords as ((payload: unknown) => Promise<unknown>) | undefined;
        await saveRecords?.(records);
      },
      securityConfig: mcpControlSecurityConfig,
      defaultProfile: Object.keys(asRecord(existingAgentProfiles[0])).length > 0
        ? asRecord(existingAgentProfiles[0])
        : { id: 'codex-env', enabled: true },
      audit: (event) => console.info('[MCP Webhook Audit]', JSON.stringify(event)),
      accessLog: (event) => console.info('[MCP Webhook Access]', JSON.stringify(event)),
      recordAssignment: (assignment) => console.info('[MCP Webhook Assignment]', JSON.stringify(assignment)),
      searchSessions: (request) => {
        const input = asRecord(request);
        return workspaceService.searchMcpSessions(undefined, asString(input.query) ?? '', input.includeSelf !== false);
      },
      openAgent: (request) => {
        const openAgent = mcpAgentLifecycleService.openAgent as ((payload: unknown) => Promise<unknown>) | undefined;
        return openAgent?.({
          ...asRecord(request),
          actor: { type: 'webhook', sessionKey: '0', scopes: ['mcp:session.open'] },
          leaderSessionKey: '0',
        }) ?? { ok: false, code: 'AGENT_PROFILE_NOT_FOUND' };
      },
      deliverMessage: (request) => createMcpGatewayDelivery()(asRecord(request)),
      checkRateLimit: (request) => {
        const input = asRecord(request);
        const keyId = asString(input.keyId) ?? 'unknown';
        const ip = asString(input.effectiveClientIp) ?? '0.0.0.0';
        const windowSeconds = Math.max(1, Number(input.windowSeconds ?? 60));
        const burstLimit = Math.max(1, Number(input.burstLimit ?? 10));
        const bucketKey = `${keyId}:${ip}`;
        const now = Date.now();
        const bucket = webhookRateLimits.get(bucketKey);
        if (!bucket || now - bucket.windowStartedAt > windowSeconds * 1000) {
          webhookRateLimits.set(bucketKey, { windowStartedAt: now, count: 1 });
          return { ok: true };
        }
        bucket.count += 1;
        return bucket.count > burstLimit ? { ok: false, code: 'WEBHOOK_RATE_LIMITED' } : { ok: true };
      },
    });
    mcpControlService = createMcpControlService({
      now: () => new Date().toISOString(),
      config: {
        enabled: initialMcpControlConfig.enabled !== false,
        bindMode: asString(initialMcpControlConfig.bindMode) ?? 'loopback',
        host: asString(initialMcpControlConfig.host) ?? asString(initialMcpControlConfig.bindHost) ?? '127.0.0.1',
        port: mcpPort,
        transportSecurity: asString(initialMcpControlConfig.transportSecurity) ?? 'none',
        trustedProxies: stringArray(initialMcpControlConfig.trustedProxies),
        externalWhitelist: stringArray(initialMcpControlConfig.externalWhitelist),
        allowedOrigins: stringArray(initialMcpControlConfig.allowedOrigins),
        status: initialMcpControlConfig.enabled === false ? 'stopped' : 'listening',
        lastError: null,
        lastRebindResult: null,
      },
      mutateConfig: async (request) => {
        const input = asRecord(request);
        const nextSecurityConfig = mergeMcpControlSecurityConfig(mcpControlSecurityConfig, input, {
          bindHost: '127.0.0.1',
          port: mcpPort,
        });
        const nextPort = Number(nextSecurityConfig.port ?? mcpPort);
        const validation = asRecord(validateMcpSecurityConfig(
          nextSecurityConfig as Parameters<typeof validateMcpSecurityConfig>[0],
          { activeConfig: mcpControlSecurityConfig },
        ));
        if (validation.ok === false) {
          return validation;
        }
        if (input.enabled === false) {
          Object.assign(mcpControlSecurityConfig, nextSecurityConfig);
          const stop = mcpListenerController.stop as (() => Promise<unknown>) | undefined;
          const stopped = stop ? await stop() : { ok: true };
          return { ok: true, ...asRecord(stopped) };
        }
        const rebind = mcpListenerController.rebind as ((payload: unknown) => Promise<unknown>) | undefined;
        if (rebind && input.rebindRequested === true) {
          const result = await rebind({
            candidate: {
              ...nextSecurityConfig,
              port: nextPort,
            },
          });
          if (asRecord(result).ok === false) {
            return result;
          }
          Object.assign(mcpControlSecurityConfig, nextSecurityConfig);
          return result;
        }
        const updatePolicy = mcpListenerController.updatePolicy as ((payload: unknown) => unknown) | undefined;
        if (updatePolicy) {
          const result = asRecord(await updatePolicy({
            ...nextSecurityConfig,
            port: nextPort,
          }));
          if (result.ok === false) {
            return result;
          }
          Object.assign(mcpControlSecurityConfig, nextSecurityConfig);
          return result;
        }
        Object.assign(mcpControlSecurityConfig, nextSecurityConfig);
        return { ok: true };
      },
      listSessions: (request) => {
        const input = asRecord(request);
        return workspaceService.listMcpSessions(asString(input.actorSessionKey), input.includeSelf !== false);
      },
      searchSessions: (request) => {
        const input = asRecord(request);
        return workspaceService.searchMcpSessions(
          asString(input.actorSessionKey),
          asString(input.query) ?? '',
          input.includeSelf !== false,
        );
      },
      setAlias: (request) => {
        const input = asRecord(request);
        return workspaceService.setMcpSessionAlias(asString(input.sessionKey) ?? '', asString(input.alias) ?? '', asString(input.actorSessionKey));
      },
      updateAgentStatus: (request) => workspaceService.updateMcpAgentStatus(request),
      replyGateway: (request) => {
        const input = asRecord(request);
        const target = asRecord(input.target);
        return createMcpGatewayDelivery()({
          sessionKey: asString(target.sessionKey) ?? asString(input.sessionKey),
          prompt: asString(input.data) ?? asString(input.prompt) ?? '',
          deliveryMode: asString(asRecord(input.delivery).mode) ?? 'paste',
          actor: {
            type: 'ui',
            sessionKey: '0',
            scopes: ['mcp:message.paste', 'mcp:message.submit'],
          },
          context: { requestId: asString(input.requestId), sourceIp: 'ui' },
        });
      },
      closeLifecycle: (request) => workspaceService.deleteMcpSession(request),
      mutateProfile: (request) => {
        const createProfile = agentProfileService.createProfile as ((input: unknown) => Promise<unknown>) | undefined;
        return createProfile?.(request);
      },
      updateProfile: (request) => {
        const input = asRecord(request);
        const updateProfile = agentProfileService.updateProfile as ((id: string, input: unknown) => Promise<unknown>) | undefined;
        return updateProfile?.(asString(input.id) ?? '', input);
      },
    });
    const mcpHttpHandler = createMcpHttpHandler({
      service: mcpToolService,
      listenerController: mcpListenerController,
    }) as McpHttpHandler;
    mcpHandlerForListener = mcpHttpHandler;
    await (mcpListenerController.start as (request: unknown) => Promise<unknown>)({ enabled: mcpControlSecurityConfig.enabled !== false });
    mcpListenerControllerInstance = mcpListenerController;
    app.set('mcpListenerController', mcpListenerController);
    app.set('mcpClaimCodes', mcpClaimCodes);

    // Periodic CWD snapshot every 30s for crash recovery
    cwdSnapshotTimer = setInterval(() => {
      workspaceService.snapshotAllCwds();
      workspaceService.forceFlush().catch(err =>
        console.warn('[CWD Snapshot] Flush error:', err.message)
      );
    }, 30_000);

    // ========================================================================
    // Setup Routes (after services are initialized)
    // ========================================================================
    setupRoutes();

    // ========================================================================
    // Vite Dev Server Proxy (development only)
    // ========================================================================
    let viteProxy: ReturnType<typeof httpProxy.createProxyServer> | null = null;
    if (process.env.NODE_ENV !== 'production') {
      const viteDevPort = process.env.DEV_FRONTEND_PORT || '4545';
      viteProxy = httpProxy.createProxyServer({
        target: `http://localhost:${viteDevPort}`,
        ws: true,
      });
      viteProxy.on('error', (err, _req, res) => {
        console.warn('[ViteProxy]', err.message);
        if (res && typeof res === 'object' && 'writeHead' in (res as object)) {
          const httpRes = res as ServerResponse;
          if (!httpRes.headersSent) {
            httpRes.writeHead(502);
            httpRes.end('Vite dev server unavailable');
          }
        }
      });

      // Fallback: proxy non-API requests to Vite dev server
      app.use((req, res) => {
        viteProxy!.web(req, res);
      });

      console.log(`[ViteProxy] Development proxy to http://localhost:${viteDevPort} enabled`);
    } else {
      if (!existsSync(PRODUCTION_INDEX_HTML)) {
        console.warn(`[Static] Production index not found at ${PRODUCTION_INDEX_HTML}`);
      }

      app.use(express.static(PRODUCTION_PUBLIC_DIR, {
        index: false,
        fallthrough: true,
      }));

      app.get('*', (req, res, next) => {
        if (!isHtmlNavigationRequest(req)) {
          return next();
        }

        res.sendFile(PRODUCTION_INDEX_HTML, (error) => {
          if (error) {
            next(error);
          }
        });
      });

      console.log(`[Static] Production assets served from ${PRODUCTION_PUBLIC_DIR}`);
    }

    // ========================================================================
    // Initialize SSL Service (Phase 1)
    // ========================================================================
    const sslConfig = config.ssl || { certPath: '', keyPath: '', caPath: '' };
    const sslService = new SSLService(sslConfig);

    // Load or generate SSL certificates
    const credentials = await sslService.loadCertificates();
    const tlsOptions = sslService.getTLSOptions(credentials);

    // Create HTTPS server
    const httpsServer = https.createServer(tlsOptions, app);
    httpsServer.keepAliveTimeout = 120000;
    httpsServer.headersTimeout = 125000;

    // Initialize WebSocket Router (Step 8)
    const runtimeValues = runtimeConfigStore.getEditableValues();
    const wsRouter = new WsRouter(authService, sessionManager, {
      resourceLimits: runtimeValues.resourceLimits,
      stabilityModes: runtimeValues.stabilityModes,
    });
    sessionManager.setWsRouter(wsRouter);
    workspaceService.onTabUpdated((event) => {
      wsRouter.broadcastAll('tab:updated', {
        id: event.tab.id,
        workspaceId: event.tab.workspaceId,
        changes: event.changes,
      });
    });
    // Make wsRouter accessible to workspace routes via Express app
    app.set('wsRouter', wsRouter);

    // Upgrade event dispatcher: /ws → WsRouter, others → Vite (dev only)
    httpsServer.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`).pathname;
      if (pathname === '/ws') {
        wsRouter.handleUpgrade(req, socket, head);
      } else if (viteProxy) {
        viteProxy.ws(req, socket, head);
      } else {
        socket.destroy();
      }
    });

    // Start HTTPS server
    httpsServer.listen(PORT, () => {
      const powerShellBackend = config.pty.windowsPowerShellBackend ?? 'inherit';
      const effectivePowerShellBackend = powerShellBackend === 'inherit'
        ? (config.pty.useConpty ? 'conpty' : 'winpty')
        : powerShellBackend;
      console.log(`[PTY] Global Windows backend default: ${config.pty.useConpty ? 'conpty' : 'winpty'}`);
      console.log(`[PTY] Effective PowerShell backend default: ${effectivePowerShellBackend} (policy: ${powerShellBackend})`);
      const twoFAStatus = (() => {
        const totpEnabled = config.twoFactor?.enabled ?? false;
        if (!totpEnabled) return 'Disabled';
        const ext = config.twoFactor?.externalOnly ? ' [externalOnly]' : '';
        return `TOTP${ext}`;
      })();
      console.log('');
      console.log('╔════════════════════════════════════════════════════════════════╗');
      console.log('║           BuilderGate Server (HTTPS)                             ║');
      console.log('╠════════════════════════════════════════════════════════════════╣');
      console.log(`║  HTTPS Server: https://localhost:${PORT}                        ║`);
      console.log(`║  Health Check: https://localhost:${PORT}/health                 ║`);
      console.log(`║  Login:        POST https://localhost:${PORT}/api/auth/login    ║`);
      console.log(`║  Global PTY:   ${config.pty.useConpty ? 'ConPTY' : 'winpty'}                                       ║`);
      console.log('║  TLS Version:  1.2 - 1.3                                       ║');
      console.log('║  Auth:         JWT (HS256)                                     ║');
      console.log(`║  2FA:          ${twoFAStatus.padEnd(30)}     ║`);
      console.log('╚════════════════════════════════════════════════════════════════╝');
      console.log('');
    });

    // Create HTTP redirect server (optional)
    const httpApp = express();
    httpApp.use((req, res) => {
      const host = req.headers.host?.split(':')[0] || 'localhost';
      res.redirect(301, `https://${host}:${PORT}${req.url}`);
    });

    const httpServer = http.createServer(httpApp);
    httpServer.listen(HTTP_PORT, () => {
      console.log(`[HTTP] Redirect server running on http://localhost:${HTTP_PORT}`);
      console.log(`[HTTP] All requests redirected to HTTPS`);
    });

    terminalObservabilityTimer = setInterval(() => {
      const sessionStats = sessionManager.getObservabilitySnapshot();
      const wsStats = wsRouter.getObservabilitySnapshot();
      console.log('[TerminalObs]', JSON.stringify({
        sessions: sessionStats,
        ws: wsStats,
      }));
    }, 60_000);
    terminalObservabilityTimer.unref();

    // Check certificate expiry
    const expiryInfo = sslService.checkCertExpiry();
    if (expiryInfo.isExpiringSoon) {
      console.warn('');
      console.warn('⚠️  WARNING: SSL certificate expires in', expiryInfo.daysRemaining, 'days');
      console.warn('   Expiry date:', expiryInfo.expiresAt.toISOString());
      console.warn('');
    }

  } catch (error) {
    console.error('[Fatal] Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown — stop CWD watchers, snapshot CWDs, flush state
function setupGracefulShutdown(): void {
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      return;
    }
    shutdownInProgress = true;
    console.log(`[Shutdown] ${signal} received, saving session CWDs...`);
    try {
      const result = await performServerGracefulShutdown(signal);
      console.log('[Shutdown] Workspace state + CWDs saved');
      console.log(
        '[Shutdown] Session cleanup '
        + `attempted=${result.sessionCleanupAttempted} `
        + `completed=${result.sessionCleanupCompleted} `
        + `degraded=${result.sessionCleanupDegraded} `
        + `skippedUnverified=${result.sessionCleanupSkippedUnverified} `
        + `remainingVerifiedDescendants=${result.remainingVerifiedDescendants}`,
      );
    } catch (err) {
      console.error('[Shutdown] Failed to save workspace state:', err);
      process.exit(1);
      return;
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Start the server
setupFatalErrorLogging();
startServer().then(() => setupGracefulShutdown());
