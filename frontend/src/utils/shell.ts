export type ShellFamily = 'windows' | 'unix';

const WINDOWS_SHELLS = ['powershell', 'cmd'];

export function getShellFamily(shell: string): ShellFamily {
  return WINDOWS_SHELLS.includes(shell) ? 'windows' : 'unix';
}

export function resolveCwd(
  selectedShell: string,
  currentShell: string | undefined,
  currentCwd: string | undefined
): string | undefined {
  if (!currentCwd || !currentShell) return undefined;
  return getShellFamily(selectedShell) === getShellFamily(currentShell)
    ? currentCwd
    : undefined;
}
