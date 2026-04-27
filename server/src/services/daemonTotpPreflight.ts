import os from 'os';
import path from 'path';
import { CryptoService } from './CryptoService.js';
import { TOTPService, type ConsoleQrWriter } from './TOTPService.js';
import type { Config } from '../types/config.types.js';
import { loadConfigFromPathStrict } from '../utils/configStrictLoader.js';

export interface DaemonTotpPreflightOptions {
  configPath: string;
  secretFilePath: string;
  platform?: NodeJS.Platform;
  config?: Config;
  cryptoService?: CryptoService;
  qrCodeWriter?: ConsoleQrWriter;
  suppressConsoleQr?: boolean;
}

export interface DaemonTotpPreflightResult {
  enabled: boolean;
  secretFilePath: string;
  issuer?: string;
  accountName?: string;
  registered?: boolean;
}

function createDaemonCryptoService(): CryptoService {
  const machineId = `${os.hostname()}-${os.platform()}-${os.arch()}`;
  return new CryptoService(machineId);
}

function normalizeSecretFilePath(secretFilePath: string): string {
  return path.resolve(path.normalize(secretFilePath));
}

export async function runDaemonTotpPreflight(options: DaemonTotpPreflightOptions): Promise<DaemonTotpPreflightResult> {
  const config = options.config ?? loadConfigFromPathStrict(options.configPath, options.platform ?? process.platform);
  return runDaemonTotpPreflightForConfig(config, options);
}

export async function runDaemonTotpPreflightForConfig(
  config: Config,
  options: Omit<DaemonTotpPreflightOptions, 'configPath' | 'config'> & { configPath?: string },
): Promise<DaemonTotpPreflightResult> {
  const secretFilePath = normalizeSecretFilePath(options.secretFilePath);
  const twoFactor = config.twoFactor;

  if (twoFactor?.enabled !== true) {
    return {
      enabled: false,
      secretFilePath,
    };
  }

  const service = new TOTPService(
    twoFactor,
    options.cryptoService ?? createDaemonCryptoService(),
    secretFilePath,
    {
      suppressConsoleQr: options.suppressConsoleQr ?? false,
      qrCodeWriter: options.qrCodeWriter,
    },
  );

  try {
    service.initialize();
    return {
      enabled: true,
      secretFilePath,
      issuer: twoFactor.issuer ?? 'BuilderGate',
      accountName: twoFactor.accountName ?? 'admin',
      registered: service.isRegistered(),
    };
  } finally {
    service.destroy();
  }
}
