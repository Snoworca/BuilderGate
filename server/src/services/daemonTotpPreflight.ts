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
  printConsoleQr?: boolean;
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
      // #80: the daemon preflight IS the enrolment moment -- it runs before detach precisely so
      // an operator can scan the code. That is the one place printing the QR is the point, so it
      // defaults ON here while the process-wide default stays OFF. The SECRET is never printed
      // from anywhere; that is enforced in TOTPService, not by this flag.
      printConsoleQr: options.printConsoleQr ?? true,
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
