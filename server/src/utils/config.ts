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
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { configSchema, type ConfigSchema } from '../schemas/config.schema.js';
import type { Config } from '../types/config.types.js';
import { CryptoService } from '../services/CryptoService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Get config file path
 */
export function getConfigPath(): string {
  return join(__dirname, '../../config.json5');
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

/**
 * Ensure config.json5 exists — copy from config.json5.example if missing
 */
function ensureConfigExists(configPath: string): void {
  if (existsSync(configPath)) return;

  const examplePath = `${configPath}.example`;
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, configPath);
    console.log('[Config] config.json5 not found — created from config.json5.example');
    console.log('[Config] ⚠️  Edit config.json5 to set your password and options before proceeding.');
  } else {
    console.warn('[Config] config.json5 and config.json5.example both missing — using built-in defaults');
  }
}

/**
 * Load and validate configuration from config.json5
 * Uses Zod schema for validation and default values
 * Automatically encrypts plaintext passwords
 */
function loadConfig(): Config {
  try {
    const configPath = getConfigPath();
    ensureConfigExists(configPath);
    const configContent = readFileSync(configPath, 'utf-8');
    const rawConfig = JSON5.parse(configContent);

    // Encrypt passwords if they're plaintext
    try {
      encryptPasswordsInConfig(configPath, rawConfig);

      // Reload config after encryption
      const updatedContent = readFileSync(configPath, 'utf-8');
      const updatedRawConfig = JSON5.parse(updatedContent);

      // Validate and apply defaults using Zod schema
      const validatedConfig = configSchema.parse(updatedRawConfig);
      console.log('[Config] Configuration loaded successfully');
      return validatedConfig as Config;
    } catch (encryptError) {
      console.warn('[Config] Passwords encryption skipped:', encryptError);
    }

    // Validate and apply defaults using Zod schema
    const validatedConfig = configSchema.parse(rawConfig);

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

/**
 * Get the server root directory path
 */
export function getServerRoot(): string {
  return join(__dirname, '../..');
}

/**
 * Configuration singleton
 */
export const config = loadConfig();
