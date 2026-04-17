/**
 * BuilderGate Server - Main Entry Point
 * Phase 1: Security Infrastructure (HTTPS + Security Headers)
 * Phase 2: Authentication Core (JWT + Password)
 * Phase 3: Two-Factor Authentication
 */

import express from 'express';
import cors from 'cors';
import https from 'https';
import http, { type ServerResponse } from 'http';
import { existsSync } from 'fs';
import os from 'os';
import httpProxy from 'http-proxy';
import path from 'path';
import sessionRoutes from './routes/sessionRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createFileRoutes } from './routes/fileRoutes.js';
import { createSettingsRoutes } from './routes/settingsRoutes.js';
import { createWorkspaceRoutes } from './routes/workspaceRoutes.js';
import { WorkspaceService } from './services/WorkspaceService.js';
import { config, getServerRoot } from './utils/config.js';
import { FileService } from './services/FileService.js';
import { RuntimeConfigStore } from './services/RuntimeConfigStore.js';
import { ConfigFileRepository } from './services/ConfigFileRepository.js';
import { SettingsService } from './services/SettingsService.js';
import { SessionManager, sessionManager } from './services/SessionManager.js';
import { SSLService } from './services/SSLService.js';
import { CryptoService } from './services/CryptoService.js';
import { AuthService } from './services/AuthService.js';
import { TOTPService } from './services/TOTPService.js';
import { reconcileTotpRuntime } from './services/twoFactorRuntime.js';
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

const app = express();
const PORT = process.env.PORT || config.server.port;
const HTTP_PORT = Number(PORT) - 1; // HTTP redirect port

// ============================================================================
// Service Instances (initialized in startServer)
// ============================================================================

let cryptoService: CryptoService;
let authService: AuthService;
let totpService: TOTPService | undefined;
let fileService: FileService;
let runtimeConfigStore: RuntimeConfigStore;
let settingsService: SettingsService;
let workspaceService: WorkspaceService;
let cwdSnapshotTimer: ReturnType<typeof setInterval> | null = null;
let terminalObservabilityTimer: ReturnType<typeof setInterval> | null = null;

const PRODUCTION_PUBLIC_DIR = path.join(getServerRoot(), 'dist', 'public');
const PRODUCTION_INDEX_HTML = path.join(PRODUCTION_PUBLIC_DIR, 'index.html');

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

function applyTwoFactorRuntime(nextConfig: Config, changedKeys: EditableSettingsKey[] = []): string[] {
  const result = reconcileTotpRuntime({
    currentService: totpService,
    nextConfig,
    cryptoService,
    changedKeys,
  });
  totpService = result.service;
  return result.warnings;
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
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      https: true,
      authenticated: false
    });
  });

  // Auth routes (no auth required for login)
  const authRoutes = createAuthRoutes({
    getAuthService: () => authService,
    getTOTPService: () => totpService,
    getTwoFactorExternalOnly: () => runtimeConfigStore?.getEditableValues().twoFactor.externalOnly ?? false,
  });
  app.use('/api/auth', authRoutes);

  // Protected session routes (auth required)
  const authMiddleware = createAuthMiddleware(() => authService);
  const settingsRoutes = createSettingsRoutes(settingsService);
  app.use('/api/settings', authMiddleware, settingsRoutes);
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
  console.log('  - /api/sessions/* (protected)');
  console.log('  - /api/sessions/:id/cwd (protected, File API)');
  console.log('  - /api/sessions/:id/files (protected, File API)');
}

// ============================================================================
// Error Handling
// ============================================================================

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err.message);
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

    // ========================================================================
    // Initialize TOTP Service (Step 6 — FR-102)
    // ========================================================================
    if (config.twoFactor?.enabled) {
      applyTwoFactorRuntime(config);
      try {
        void totpService;
      } catch (err) {
        console.error('[TOTP] Failed to initialize TOTPService:', err);
        // Server continues — TOTP unregistered state handled in auth routes (FR-401)
      }
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
      updateTwoFactorRuntime: (nextConfig, changedKeys) => applyTwoFactorRuntime(nextConfig, changedKeys),
    });

    // ========================================================================
    // Initialize Workspace Service (Step 7)
    // ========================================================================
    workspaceService = new WorkspaceService(sessionManager);
    await workspaceService.initialize();
    const orphanTabs = await workspaceService.checkOrphanTabs();
    if (orphanTabs.length > 0) {
      console.log(`[Workspace] ${orphanTabs.length} orphan tab(s) recovered with saved CWD`);
    }
    console.log('[Workspace] WorkspaceService initialized');

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
    const wsRouter = new WsRouter(authService, sessionManager);
    sessionManager.setWsRouter(wsRouter);
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
  const shutdown = async (signal: string) => {
    console.log(`[Shutdown] ${signal} received, saving session CWDs...`);
    try {
      sessionManager.stopAllCwdWatching();          // (1) Stop watchFile callbacks
      workspaceService?.snapshotAllCwds();           // (2) Final CWD snapshot
      await workspaceService?.forceFlush();          // (3) Flush to disk
      if (cwdSnapshotTimer) clearInterval(cwdSnapshotTimer); // (4) Clear periodic timer
      if (terminalObservabilityTimer) clearInterval(terminalObservabilityTimer);
      console.log('[Shutdown] Workspace state + CWDs saved');
    } catch (err) {
      console.error('[Shutdown] Failed to save workspace state:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Start the server
startServer().then(() => setupGracefulShutdown());
