import JSON5 from 'json5';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { configSchema } from '../schemas/config.schema.js';
import type { Config } from '../types/config.types.js';
import { normalizeRawConfigForPlatform } from './ptyPlatformPolicy.js';
import { renderBootstrapConfigTemplate } from './configTemplate.js';

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

function ensureConfigExists(configPath: string, platform: NodeJS.Platform): void {
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
 * Strict production/native config loader.
 *
 * Missing config files still bootstrap from the built-in template, but existing
 * invalid files must fail instead of falling back to schema defaults. This
 * module intentionally does not export a config singleton.
 */
export function loadConfigFromPathStrict(configPath: string, platform: NodeJS.Platform = process.platform): Config {
  ensureConfigExists(configPath, platform);
  const rawConfig = readNormalizedRawConfig(configPath);
  const normalizedConfig = normalizeRawConfigForPlatform(rawConfig, platform);
  const validatedConfig = configSchema.parse(normalizedConfig);
  return validatedConfig as Config;
}
