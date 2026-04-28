/**
 * Configuration Loader with Zod Validation
 * Phase 1: Security Infrastructure
 * Phase 2: Password Auto-Encryption
 *
 * Loads and validates configuration from config.json5
 * Automatically encrypts plaintext passwords on first load
 */

import JSON5 from 'json5';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { configSchema, type ConfigSchema } from '../schemas/config.schema.js';
import type { Config } from '../types/config.types.js';
import { CryptoService } from '../services/CryptoService.js';
import {
  normalizeRawConfigForPlatform,
} from './ptyPlatformPolicy.js';
import { renderBootstrapConfigTemplate } from './configTemplate.js';
import { loadConfigFromPathStrict } from './configStrictLoader.js';

export { loadConfigFromPathStrict };

const MODULE_DIR = typeof __dirname === 'string'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH_ENV_KEY = 'BUILDERGATE_CONFIG_PATH';
const SERVER_ROOT_ENV_KEY = 'BUILDERGATE_SERVER_ROOT';

/**
 * Get config file path
 */
export function getConfigPath(): string {
  const configuredPath = process.env[CONFIG_PATH_ENV_KEY]?.trim();
  if (configuredPath) {
    return resolve(configuredPath);
  }

  return join(MODULE_DIR, '../../config.json5');
}

/**
 * Create CryptoService instance with machine-specific key
 */
function createCryptoService(): CryptoService {
  const machineId = `${os.hostname()}-${os.platform()}-${os.arch()}`;
  return new CryptoService(machineId);
}

/**
 * Password location definition for encryption
 */
interface PasswordLocation {
  path: string[];           // Object path (e.g., ['auth', 'password'])
  sectionMarker: string;    // Regex pattern to find section start
  depth: number;            // Expected depth relative to root
}

/**
 * Get passwords that need encryption
 */
function getPasswordsToEncrypt(rawConfig: Record<string, unknown>, cryptoService: CryptoService): PasswordLocation[] {
  const locations: PasswordLocation[] = [];

  // Check auth.password
  const auth = rawConfig.auth as { password?: string } | undefined;
  if (auth?.password && !cryptoService.isEncrypted(auth.password)) {
    locations.push({
      path: ['auth', 'password'],
      sectionMarker: '^\\s*auth:\\s*\\{',
      depth: 1
    });
  }

  return locations;
}

/**
 * Encrypt plaintext passwords in config and save back to file
 * Creates a backup before modifying
 * Handles both auth.password and twoFactor.smtp.auth.password
 */
function encryptPasswordsInConfig(configPath: string, rawConfig: Record<string, unknown>): void {
  const cryptoService = createCryptoService();
  const passwordLocations = getPasswordsToEncrypt(rawConfig, cryptoService);

  if (passwordLocations.length === 0) {
    console.log('[Config] All passwords already encrypted');
    return;
  }

  // Create backup
  const backupPath = `${configPath}.bak`;
  if (!existsSync(backupPath)) {
    copyFileSync(configPath, backupPath);
    console.log('[Config] Backup created:', backupPath);
  }

  // Encrypt passwords in memory
  const encryptedValues: Map<string, string> = new Map();
  for (const loc of passwordLocations) {
    let obj: Record<string, unknown> = rawConfig;
    for (let i = 0; i < loc.path.length - 1; i++) {
      obj = obj[loc.path[i]] as Record<string, unknown>;
    }
    const plaintext = obj[loc.path[loc.path.length - 1]] as string;
    const encrypted = cryptoService.encrypt(plaintext);
    encryptedValues.set(loc.path.join('.'), encrypted);
  }

  // Read original file to preserve formatting and comments
  let content = readFileSync(configPath, 'utf-8');

  // Process each password location
  for (const loc of passwordLocations) {
    const encrypted = encryptedValues.get(loc.path.join('.'));
    if (!encrypted) continue;

    // Find and replace the specific password
    if (loc.path[0] === 'auth' && loc.path.length === 2) {
      // auth.password - direct child of root-level auth
      content = replacePasswordInSection(content, 'auth', encrypted, 2);
      console.log('[Config] auth.password encrypted');
    }
  }

  writeFileSync(configPath, content, 'utf-8');
  console.log('[Config] Passwords encrypted and saved to config file');
}

/**
 * Replace password in a specific section at a given depth
 */
function replacePasswordInSection(content: string, sectionName: string, encrypted: string, targetDepth: number): string {
  const lines = content.split('\n');
  let braceCount = 0;
  let inSection = false;
  let sectionDepth = 0;
  let replaced = false;

  const updatedLines = lines.map(line => {
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    // Check if entering the target section at root level
    const sectionRegex = new RegExp(`^\\s*${sectionName}:\\s*\\{`);
    if (braceCount === 1 && sectionRegex.test(line)) {
      inSection = true;
      sectionDepth = braceCount;
      braceCount += openBraces - closeBraces;
      return line;
    }

    const prevCount = braceCount;
    braceCount += openBraces - closeBraces;

    if (inSection && !replaced) {
      // Replace password at the correct depth
      if (prevCount === sectionDepth + 1 && line.match(/^\s*password:/)) {
        replaced = true;
        return line.replace(
          /(password:\s*)(["'])([^"']*)\2/,
          `$1$2${encrypted}$2`
        );
      }

      // Exit section
      if (braceCount <= sectionDepth) {
        inSection = false;
      }
    }

    return line;
  });

  return updatedLines.join('\n');
}

function normalizeAuthPasswordState(rawConfig: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(rawConfig);

  if (typeof normalized.auth !== 'object' || normalized.auth === null || Array.isArray(normalized.auth)) {
    normalized.auth = {};
  }

  const authSection = normalized.auth as Record<string, unknown>;
  if (authSection.password == null) {
    authSection.password = '';
  }

  return normalized;
}

/**
 * Ensure config.json5 exists — render a built-in bootstrap template if missing
 */
function ensureConfigExists(configPath: string, platform: NodeJS.Platform = process.platform): void {
  if (existsSync(configPath)) return;

  const bootstrapContent = renderBootstrapConfigTemplate(platform);
  writeFileSync(configPath, bootstrapContent, 'utf-8');
  console.log('[Config] config.json5 not found — created from built-in bootstrap template');
  console.log('[Config] Initial administrator password must be configured in the browser bootstrap flow.');
}

function readNormalizedRawConfig(configPath: string): Record<string, unknown> {
  const configContent = readFileSync(configPath, 'utf-8');
  return normalizeAuthPasswordState(JSON5.parse(configContent));
}

/**
 * Load and validate configuration from config.json5
 * Uses Zod schema for validation and default values
 * Automatically encrypts plaintext passwords
 */
export function loadConfigFromPath(configPath: string, platform: NodeJS.Platform = process.platform): Config {
  try {
    ensureConfigExists(configPath, platform);
    const rawConfig = readNormalizedRawConfig(configPath);

    // Encrypt passwords if they're plaintext
    try {
      encryptPasswordsInConfig(configPath, rawConfig);

      // Reload config after encryption
      const updatedRawConfig = normalizeRawConfigForPlatform(
        readNormalizedRawConfig(configPath),
        platform,
      );

      // Validate and apply defaults using Zod schema
      const validatedConfig = configSchema.parse(updatedRawConfig);
      console.log('[Config] Configuration loaded successfully');
      return validatedConfig as Config;
    } catch (encryptError) {
      console.warn('[Config] Passwords encryption skipped:', encryptError);
    }

    // Validate and apply defaults using Zod schema
    const validatedConfig = configSchema.parse(normalizeRawConfigForPlatform(rawConfig, platform));

    console.log('[Config] Configuration loaded successfully');

    return validatedConfig as Config;
  } catch (error) {
    if (error instanceof Error) {
      // Check if it's a Zod validation error
      if (error.name === 'ZodError') {
        console.error('[Config] Configuration validation failed:');
        console.error(error.message);
        throw new Error(`Configuration validation failed: ${error.message}`);
      }

      // File not found or other error
      console.warn('[Config] Failed to load config.json5:', error.message);
      console.warn('[Config] Using default configuration');
    }

    // Return validated defaults
    return configSchema.parse({}) as Config;
  }
}

function loadConfig(): Config {
  return loadConfigFromPath(getConfigPath(), process.platform);
}

/**
 * Get the server root directory path
 */
export function getServerRoot(): string {
  const configuredRoot = process.env[SERVER_ROOT_ENV_KEY]?.trim();
  if (configuredRoot) {
    return resolve(configuredRoot);
  }

  return join(MODULE_DIR, '../..');
}

/**
 * Configuration singleton
 */
export const config = loadConfig();
