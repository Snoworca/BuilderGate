/**
 * Claude Web Shell Server - Main Entry Point
 * Phase 1: Security Infrastructure (HTTPS + Security Headers)
 * Phase 2: Authentication Core (JWT + Password)
 * Phase 3: Two-Factor Authentication
 */

import express from 'express';
import cors from 'cors';
import https from 'https';
import http from 'http';
import os from 'os';
import sessionRoutes from './routes/sessionRoutes.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { config } from './utils/config.js';
import { SSLService } from './services/SSLService.js';
import { CryptoService } from './services/CryptoService.js';
import { AuthService } from './services/AuthService.js';
import { TwoFactorService } from './services/TwoFactorService.js';
import {
  createSecurityHeadersMiddleware,
  createNoCacheMiddleware,
  createPermissionsPolicyMiddleware,
  createAuthMiddleware
} from './middleware/index.js';

const app = express();
const PORT = process.env.PORT || config.server.port;
const HTTP_PORT = Number(PORT) - 1; // HTTP redirect port

// ============================================================================
// Service Instances (initialized in startServer)
// ============================================================================

let cryptoService: CryptoService;
let authService: AuthService;
let twoFactorService: TwoFactorService | undefined;

// ============================================================================
// Security Middleware Stack (Phase 1)
// ============================================================================

// Security headers (helmet)
app.use(createSecurityHeadersMiddleware({
  enableHSTS: true
}));

// Permissions-Policy header
app.use(createPermissionsPolicyMiddleware());

// No-cache for sensitive endpoints (applied selectively later)
const noCacheMiddleware = createNoCacheMiddleware();

// ============================================================================
// CORS Configuration
// ============================================================================

const corsOptions: cors.CorsOptions = {
  origin: config.security?.cors.allowedOrigins.length
    ? config.security.cors.allowedOrigins
    : true, // Allow all in development
  credentials: config.security?.cors.credentials ?? true,
  maxAge: config.security?.cors.maxAge ?? 86400,
};

app.use(cors(corsOptions));

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
  const authRoutes = createAuthRoutes(authService, twoFactorService);
  app.use('/api/auth', authRoutes);

  // Protected session routes (auth required)
  const authMiddleware = createAuthMiddleware(authService);
  app.use('/api/sessions', authMiddleware, sessionRoutes);

  console.log('[Routes] API routes configured');
  console.log('  - GET  /health (public)');
  console.log('  - POST /api/auth/login (public)');
  if (twoFactorService?.isEnabled()) {
    console.log('  - POST /api/auth/verify (public, 2FA)');
  }
  console.log('  - POST /api/auth/logout (protected)');
  console.log('  - POST /api/auth/refresh (protected)');
  console.log('  - GET  /api/auth/status (protected)');
  console.log('  - /api/sessions/* (protected)');
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
    // Initialize Two-Factor Service (Phase 3)
    // ========================================================================
    if (config.twoFactor?.enabled) {
      twoFactorService = new TwoFactorService(config.twoFactor, cryptoService);
      console.log('[2FA] TwoFactorService initialized');
      console.log(`[2FA] OTP delivery to: ${twoFactorService.maskEmail(config.twoFactor.email || '')}`);
    } else {
      console.log('[2FA] Two-factor authentication is disabled');
    }

    // ========================================================================
    // Setup Routes (after services are initialized)
    // ========================================================================
    setupRoutes();

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

    // Start HTTPS server
    httpsServer.listen(PORT, () => {
      const twoFAStatus = twoFactorService?.isEnabled() ? 'Enabled (Email OTP)' : 'Disabled';
      console.log('');
      console.log('╔════════════════════════════════════════════════════════════════╗');
      console.log('║           Claude Web Shell Server (HTTPS)                      ║');
      console.log('╠════════════════════════════════════════════════════════════════╣');
      console.log(`║  HTTPS Server: https://localhost:${PORT}                        ║`);
      console.log(`║  Health Check: https://localhost:${PORT}/health                 ║`);
      console.log(`║  Login:        POST https://localhost:${PORT}/api/auth/login    ║`);
      console.log(`║  PTY Backend:  ${config.pty.useConpty ? 'ConPTY' : 'winpty'}                                       ║`);
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

// Start the server
startServer();
