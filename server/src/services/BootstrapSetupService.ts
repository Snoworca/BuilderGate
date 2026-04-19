import type {
  BootstrapPasswordResponse,
  BootstrapStatusResponse,
} from '../types/auth.types.js';
import { AuthService } from './AuthService.js';
import { CryptoService } from './CryptoService.js';
import { ConfigFileRepository } from './ConfigFileRepository.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import {
  evaluateBootstrapAccess,
  parseBootstrapAllowedIpsFromEnv,
} from '../utils/bootstrapAccessPolicy.js';

interface BootstrapSetupServiceDeps {
  authService: AuthService;
  cryptoService: CryptoService;
  configRepository: ConfigFileRepository;
  getConfiguredAllowedIps: () => string[];
}

interface BootstrapThrottleEntry {
  count: number;
  windowStartedAt: number;
}

const BOOTSTRAP_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const BOOTSTRAP_RATE_LIMIT_MAX_ATTEMPTS = 10;

export class BootstrapSetupService {
  private readonly throttle = new Map<string, BootstrapThrottleEntry>();

  constructor(private readonly deps: BootstrapSetupServiceDeps) {}

  getStatus(requestIp: string): BootstrapStatusResponse {
    if (!this.deps.authService.hasConfiguredPassword()) {
      const access = evaluateBootstrapAccess(
        requestIp,
        this.deps.getConfiguredAllowedIps(),
        parseBootstrapAllowedIpsFromEnv(),
      );

      return {
        setupRequired: true,
        requesterAllowed: access.requesterAllowed,
        allowPolicy: access.allowPolicy,
      };
    }

    return {
      setupRequired: false,
      requesterAllowed: false,
      allowPolicy: 'configured',
    };
  }

  bootstrapPassword(requestIp: string, password: string, confirmPassword: string): BootstrapPasswordResponse {
    const status = this.getStatus(requestIp);

    if (!status.setupRequired) {
      console.warn(`[Bootstrap] Rejected password bootstrap from ${requestIp}: already configured`);
      throw new AppError(ErrorCode.BOOTSTRAP_NOT_REQUIRED);
    }

    if (!status.requesterAllowed) {
      console.warn(`[Bootstrap] Rejected password bootstrap from ${requestIp}: requester not allowed`);
      throw new AppError(ErrorCode.BOOTSTRAP_NOT_ALLOWED);
    }

    this.enforceRateLimit(requestIp);

    if (password !== confirmPassword) {
      throw new AppError(ErrorCode.PASSWORD_CONFIRM_MISMATCH);
    }

    const normalizedPassword = password.trim();
    if (normalizedPassword.length < 4) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Password must be at least 4 characters long');
    }

    const encryptedPassword = this.deps.cryptoService.encrypt(normalizedPassword);
    this.deps.configRepository.persistAuthPassword(encryptedPassword);
    this.deps.authService.updateRuntimeConfig({ password: encryptedPassword });
    this.clearRateLimit(requestIp);

    const { token } = this.deps.authService.issueToken();
    console.log(`[Bootstrap] Initial administrator password configured from ${requestIp} (${status.allowPolicy})`);

    return {
      success: true,
      token,
      expiresIn: this.deps.authService.getSessionDuration(),
    };
  }

  private enforceRateLimit(requestIp: string): void {
    const now = Date.now();
    const current = this.throttle.get(requestIp);

    if (!current || now - current.windowStartedAt > BOOTSTRAP_RATE_LIMIT_WINDOW_MS) {
      this.throttle.set(requestIp, { count: 1, windowStartedAt: now });
      return;
    }

    current.count += 1;
    if (current.count > BOOTSTRAP_RATE_LIMIT_MAX_ATTEMPTS) {
      throw new AppError(ErrorCode.RATE_LIMITED, 'Too many bootstrap attempts, please try again later');
    }
  }

  private clearRateLimit(requestIp: string): void {
    this.throttle.delete(requestIp);
  }
}
