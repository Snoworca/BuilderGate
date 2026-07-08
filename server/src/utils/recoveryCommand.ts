import path from 'path';
import { AppError, ErrorCode } from './errors.js';

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/;
const WINDOWS_EXECUTABLE_EXTENSION_PATTERN = /\.(?:exe|cmd|bat|ps1)$/i;
const MAX_COMMAND_LENGTH = 200;
const MAX_ARGUMENT_LENGTH = 2000;
const RECOVERY_COMMAND_QUOTE_PATTERN = /[\s"'&|<>()^%;!]/;
const SAFE_UNQUOTED_RECOVERY_TOKEN_PATTERN = /^[A-Za-z0-9_./:@+=,-]+$/;

export type RecoveryRestoreShell = 'auto' | 'powershell' | 'wsl' | 'bash' | 'zsh' | 'sh' | 'cmd';

// @req FR-AITUI-002
export function normalizeRecoveryExecutable(input: string): string {
  const trimmed = input.trim().replace(/^["']|["']$/g, '');
  const basename = (trimmed.split(/[\\/]/).at(-1) ?? path.basename(trimmed))
    .replace(WINDOWS_EXECUTABLE_EXTENSION_PATTERN, '');
  return basename.toLowerCase();
}

// @req FR-AITUI-002
export function validateRecoveryCommand(input: unknown): string {
  if (typeof input !== 'string') {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option command is required');
  }
  if (CONTROL_CHARACTER_PATTERN.test(input)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option command is invalid');
  }
  const command = input.trim();
  if (!command || command.length > MAX_COMMAND_LENGTH || /\s/.test(command)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option command is invalid');
  }
  return command;
}

// @req SEC-AITUI-001
export function validateRecoveryArguments(input: unknown): string[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option arguments must be an array');
  }
  return input.map((argument) => {
    if (
      typeof argument !== 'string'
      || argument.length > MAX_ARGUMENT_LENGTH
      || CONTROL_CHARACTER_PATTERN.test(argument)
    ) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'Recovery option argument is invalid');
    }
    return argument;
  });
}

// @req FR-AITUI-003
export function getRecoveryExecutableToken(commandLine: string): string | null {
  const tokens = tokenizeSubmittedCommand(commandLine);
  if (tokens.length === 0) {
    return null;
  }

  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
    index += 1;
  }
  while (index < tokens.length && (tokens[index] === 'env' || tokens[index] === 'command')) {
    index += 1;
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[index])) {
      index += 1;
    }
  }

  const executable = tokens[index];
  return executable ? normalizeRecoveryExecutable(executable) : null;
}

// @req FR-AITUI-004
// @req SEC-AITUI-001
export function buildRecoveryRestoreInput(shell: RecoveryRestoreShell, commandInput: string, argumentInput: string[]): string {
  const command = validateRecoveryCommand(commandInput);
  const args = validateRecoveryArguments(argumentInput);
  const segments = [
    quoteRecoveryCommand(shell, command),
    ...args.map(argument => quoteRecoveryArgument(shell, argument)),
  ];
  return `${segments.join(' ')}\r`;
}

// @req SEC-AITUI-001
function quoteRecoveryCommand(shell: RecoveryRestoreShell, command: string): string {
  if (SAFE_UNQUOTED_RECOVERY_TOKEN_PATTERN.test(command) && !RECOVERY_COMMAND_QUOTE_PATTERN.test(command)) {
    return command;
  }
  const quotedCommand = quoteRecoveryArgument(shell, command);
  return shell === 'powershell' ? `& ${quotedCommand}` : quotedCommand;
}

// @req SEC-AITUI-001
function quoteRecoveryArgument(shell: RecoveryRestoreShell, argument: string): string {
  if (shell === 'cmd') {
    return `"${argument.replace(/"/g, '""').replace(/%/g, '^%').replace(/!/g, '^!')}"`;
  }
  if (shell === 'powershell') {
    return `'${argument.replace(/'/g, "''")}'`;
  }
  return `'${argument.replace(/'/g, "'\\''")}'`;
}

// @req FR-AITUI-003
function tokenizeSubmittedCommand(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of commandLine.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}
