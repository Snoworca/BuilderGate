import type { PTYConfig, WindowsPowerShellBackend } from '../types/config.types.js';
import type { ShellType } from '../types/index.js';

const WINDOWS_SETTINGS_SHELL_OPTIONS: ShellType[] = ['auto', 'powershell', 'wsl', 'bash'];
const NON_WINDOWS_SETTINGS_SHELL_OPTIONS: ShellType[] = ['auto', 'bash'];

export interface PlatformNormalizedPtyConfig {
  useConpty: boolean;
  windowsPowerShellBackend: WindowsPowerShellBackend;
  shell: PTYConfig['shell'];
}

export function getBootstrapPtyDefaults(
  platform: NodeJS.Platform,
): Pick<PTYConfig, 'useConpty' | 'windowsPowerShellBackend' | 'shell'> {
  if (platform === 'win32') {
    return {
      useConpty: true,
      windowsPowerShellBackend: 'inherit',
      shell: 'auto',
    };
  }

  return {
    useConpty: false,
    windowsPowerShellBackend: 'inherit',
    shell: 'auto',
  };
}

export function getSettingsShellOptions(platform: NodeJS.Platform): ShellType[] {
  return platform === 'win32'
    ? [...WINDOWS_SETTINGS_SHELL_OPTIONS, 'zsh', 'sh', 'cmd']
    : [...NON_WINDOWS_SETTINGS_SHELL_OPTIONS, 'zsh', 'sh'];
}

export function isWindowsOnlyShell(shell: PTYConfig['shell']): boolean {
  return shell === 'powershell' || shell === 'wsl' || shell === 'cmd';
}

export function normalizeShellForPlatform(
  shell: PTYConfig['shell'] | undefined,
  platform: NodeJS.Platform,
): PTYConfig['shell'] {
  const resolved = shell ?? 'auto';
  if (platform !== 'win32' && isWindowsOnlyShell(resolved)) {
    return 'auto';
  }
  return resolved;
}

export function normalizePtyConfigForPlatform(
  pty: Partial<Pick<PTYConfig, 'useConpty' | 'windowsPowerShellBackend' | 'shell'>>,
  platform: NodeJS.Platform,
): PlatformNormalizedPtyConfig {
  const defaults = getBootstrapPtyDefaults(platform);

  if (platform !== 'win32') {
    return {
      useConpty: false,
      windowsPowerShellBackend: 'inherit',
      shell: normalizeShellForPlatform(pty.shell, platform),
    };
  }

  return {
    useConpty: pty.useConpty ?? defaults.useConpty,
    windowsPowerShellBackend: pty.windowsPowerShellBackend ?? defaults.windowsPowerShellBackend ?? 'inherit',
    shell: normalizeShellForPlatform(pty.shell, platform),
  };
}

export function normalizeRawConfigForPlatform(
  rawConfig: Record<string, unknown>,
  platform: NodeJS.Platform,
): Record<string, unknown> {
  const normalized = structuredClone(rawConfig);
  if (normalized.pty === undefined) {
    normalized.pty = {};
  }

  if (typeof normalized.pty !== 'object' || normalized.pty === null || Array.isArray(normalized.pty)) {
    return normalized;
  }

  const ptySection = normalized.pty as Record<string, unknown>;
  const defaults = getBootstrapPtyDefaults(platform);
  if (ptySection.useConpty === undefined) {
    ptySection.useConpty = defaults.useConpty;
  }
  if (ptySection.windowsPowerShellBackend === undefined) {
    ptySection.windowsPowerShellBackend = defaults.windowsPowerShellBackend;
  }
  if (ptySection.shell === undefined) {
    ptySection.shell = defaults.shell;
  }

  if (platform !== 'win32' && ptySection.useConpty === true) {
    ptySection.useConpty = false;
  }

  if (
    platform !== 'win32'
    && isWindowsPowerShellBackend(ptySection.windowsPowerShellBackend)
    && ptySection.windowsPowerShellBackend !== 'inherit'
  ) {
    ptySection.windowsPowerShellBackend = 'inherit';
  }

  if (platform !== 'win32' && isShellType(ptySection.shell) && isWindowsOnlyShell(ptySection.shell)) {
    ptySection.shell = 'auto';
  }

  return normalized;
}

export function applyBootstrapPtyDefaultsToConfigText(
  configText: string,
  platform: NodeJS.Platform,
): string {
  const defaults = getBootstrapPtyDefaults(platform);
  const replacements = new Map<string, string>([
    ['pty.useConpty', String(defaults.useConpty)],
    ['pty.windowsPowerShellBackend', JSON.stringify(defaults.windowsPowerShellBackend)],
    ['pty.shell', JSON.stringify(defaults.shell)],
  ]);
  const newline = configText.includes('\r\n') ? '\r\n' : '\n';
  const lines = configText.split(/\r?\n/);
  const stack: string[] = [];
  const renderedLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('}')) {
      const closingCount = (trimmed.match(/}/g) || []).length;
      for (let index = 0; index < closingCount; index += 1) {
        stack.pop();
      }
      renderedLines.push(line);
      continue;
    }

    const objectMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*\{\s*(,?\s*(?:\/\/.*)?)?$/);
    if (objectMatch) {
      stack.push(objectMatch[2]);
      renderedLines.push(line);
      continue;
    }

    const valueMatch = line.match(/^(\s*)([A-Za-z0-9_]+):\s*(.+)$/);
    if (!valueMatch) {
      renderedLines.push(line);
      continue;
    }

    const key = valueMatch[2];
    const path = [...stack, key].join('.');
    const replacement = replacements.get(path);
    if (!replacement) {
      renderedLines.push(line);
      continue;
    }

    const suffix = parseJson5ValueSuffix(valueMatch[3]);
    renderedLines.push(`${valueMatch[1]}${key}: ${replacement}${suffix.hasTrailingComma ? ',' : ''}${suffix.comment}`);
  }

  return renderedLines.join(newline);
}

function isWindowsPowerShellBackend(value: unknown): value is WindowsPowerShellBackend {
  return value === 'inherit' || value === 'conpty' || value === 'winpty';
}

function isShellType(value: unknown): value is PTYConfig['shell'] {
  return value === 'auto'
    || value === 'powershell'
    || value === 'wsl'
    || value === 'bash'
    || value === 'zsh'
    || value === 'sh'
    || value === 'cmd';
}

function parseJson5ValueSuffix(rawValue: string): { hasTrailingComma: boolean; comment: string } {
  const commentIndex = findCommentStart(rawValue);
  const valueWithoutComment = commentIndex >= 0 ? rawValue.slice(0, commentIndex) : rawValue;
  const hasTrailingComma = /\s*,\s*$/.test(valueWithoutComment);
  const comment = commentIndex >= 0 ? rawValue.slice(commentIndex) : '';
  return { hasTrailingComma, comment };
}

function findCommentStart(rawValue: string): number {
  let inString = false;
  let quoteChar = '';
  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue[index];
    const nextChar = rawValue[index + 1];

    if (inString) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quoteChar) {
        inString = false;
        quoteChar = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quoteChar = char;
      continue;
    }

    if (char === '/' && nextChar === '/') {
      return index;
    }
  }

  return -1;
}
