import type { CommandPresetKind, ShellType } from '../../types';

export type CommandPresetExecutionShell = ShellType | string | null | undefined;

export function buildTerminalInput(
  kind: CommandPresetKind,
  value: string,
  shellType: CommandPresetExecutionShell,
): string {
  if (kind === 'prompt') {
    return value;
  }

  if (kind === 'command') {
    return `${value}\r`;
  }

  const directory = value.trim();
  if (!directory) {
    return '';
  }

  return `${buildDirectoryCommand(directory, shellType)}\r`;
}

function buildDirectoryCommand(path: string, shellType: CommandPresetExecutionShell): string {
  switch (shellType) {
    case 'powershell':
      return `Set-Location -LiteralPath '${escapePowerShellSingleQuoted(path)}'`;
    case 'cmd':
      return `cd /d "${escapeCmdDoubleQuoted(path)}"`;
    case 'bash':
    case 'zsh':
    case 'sh':
    case 'wsl':
      return `cd -- '${escapePosixSingleQuoted(path)}'`;
    default:
      return `cd "${escapeDoubleQuoted(path)}"`;
  }
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replaceAll("'", "''");
}

function escapePosixSingleQuoted(value: string): string {
  return value.replaceAll("'", "'\\''");
}

function escapeDoubleQuoted(value: string): string {
  return value.replaceAll('"', '\\"');
}

function escapeCmdDoubleQuoted(value: string): string {
  return value.replaceAll('"', '""');
}
