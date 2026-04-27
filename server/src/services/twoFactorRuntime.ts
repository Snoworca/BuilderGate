import type { Config } from '../types/config.types.js';
import type { EditableSettingsKey } from '../types/settings.types.js';
import type { CryptoService } from './CryptoService.js';
import { TOTPService } from './TOTPService.js';
import path from 'path';

const TOTP_SECRET_PATH_ENV_KEY = 'BUILDERGATE_TOTP_SECRET_PATH';
const SUPPRESS_TOTP_QR_ENV_KEY = 'BUILDERGATE_SUPPRESS_TOTP_QR';

interface ReconcileTotpRuntimeArgs {
  currentService?: TOTPService;
  nextConfig: Config;
  cryptoService: CryptoService;
  changedKeys?: EditableSettingsKey[];
  secretFilePath?: string;
  suppressConsoleQr?: boolean;
  initialStartup?: boolean;
}

interface ReconcileTotpRuntimeResult {
  service?: TOTPService;
  warnings: string[];
}

export function reconcileTotpRuntime({
  currentService,
  nextConfig,
  cryptoService,
  changedKeys = [],
  secretFilePath,
  suppressConsoleQr,
  initialStartup = false,
}: ReconcileTotpRuntimeArgs): ReconcileTotpRuntimeResult {
  if (!nextConfig.twoFactor?.enabled) {
    currentService?.destroy();
    return { service: undefined, warnings: [] };
  }

  const resolvedSecretFilePath = resolveTotpSecretFilePath(secretFilePath);
  const nextService = new TOTPService(
    nextConfig.twoFactor,
    cryptoService,
    resolvedSecretFilePath,
    {
      suppressConsoleQr: suppressConsoleQr ?? process.env[SUPPRESS_TOTP_QR_ENV_KEY] === '1',
    },
  );
  const warnings: string[] = [];

  try {
    nextService.initialize();
    currentService?.destroy();
    return { service: nextService, warnings };
  } catch (error) {
    console.error('[TOTP] Failed to initialize TOTPService:', error);

    if (initialStartup) {
      nextService.destroy();
      throw error;
    }

    if (changedKeys.length > 0 && currentService?.isRegistered()) {
      nextService.destroy();
      warnings.push('TOTP runtime refresh failed. The previous QR/runtime state was kept; restart or repair the secret before retrying.');
      return { service: currentService, warnings };
    }

    currentService?.destroy();
    warnings.push(
      changedKeys.length > 0
        ? 'TOTP secret could not be initialized. QR code is unavailable until the secret is repaired or regenerated.'
        : 'TOTP is enabled but the secret could not be initialized.',
    );
    return { service: nextService, warnings };
  }
}

export function resolveTotpSecretFilePath(secretFilePath?: string): string | undefined {
  const configuredPath = secretFilePath ?? process.env[TOTP_SECRET_PATH_ENV_KEY]?.trim();
  if (!configuredPath) {
    return undefined;
  }

  return path.resolve(path.normalize(configuredPath));
}
