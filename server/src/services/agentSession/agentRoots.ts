// Where each agent keeps its records (FR-AITUI-006 AC-6). Defaults follow the
// agents' own conventions; BUILDERGATE_AGENT_* variables override them so a
// test can point the server at fixture trees.
//
// A tab whose cwd is a Linux path on a Windows host runs inside WSL, and its
// agent writes under the WSL user's home. That home is read over the
// \\wsl.localhost share, found once per server run.

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { AgentRoots } from './agentSessionResolver.js';

type Env = Record<string, string | undefined>;

export function defaultAgentRoots(env: Env = process.env, home: string = os.homedir()): AgentRoots {
  return {
    claudeHome: env.BUILDERGATE_AGENT_CLAUDE_HOME ?? env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    codexHome: env.BUILDERGATE_AGENT_CODEX_HOME ?? env.CODEX_HOME ?? path.join(home, '.codex'),
    opencodeData: env.BUILDERGATE_AGENT_OPENCODE_DATA
      ?? path.join(env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'opencode'),
    hermesHome: env.BUILDERGATE_AGENT_HERMES_HOME ?? env.HERMES_HOME ?? path.join(home, '.hermes'),
  };
}

/** Roots under a WSL home reached from Windows, e.g. \\wsl.localhost\Ubuntu\home\dev. */
export function wslAgentRoots(uncHome: string, env: Env = process.env): AgentRoots {
  const join = (...parts: string[]) => path.win32.join(uncHome, ...parts);
  return {
    claudeHome: env.BUILDERGATE_AGENT_CLAUDE_HOME ?? join('.claude'),
    codexHome: env.BUILDERGATE_AGENT_CODEX_HOME ?? join('.codex'),
    opencodeData: env.BUILDERGATE_AGENT_OPENCODE_DATA ?? join('.local', 'share', 'opencode'),
    hermesHome: env.BUILDERGATE_AGENT_HERMES_HOME ?? join('.hermes'),
  };
}

export function toWslUncHome(distro: string, linuxHome: string): string {
  return `\\\\wsl.localhost\\${distro}${linuxHome.replace(/\//g, '\\')}`;
}

let wslHomePromise: Promise<string | null> | null = null;

function discoverWslHome(env: Env): Promise<string | null> {
  if (env.BUILDERGATE_AGENT_WSL_HOME) return Promise.resolve(env.BUILDERGATE_AGENT_WSL_HOME);
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-e', 'sh', '-c', 'printf "%s|%s" "$WSL_DISTRO_NAME" "$HOME"'], { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const [distro, home] = String(stdout).trim().split('|');
      resolve(distro && home ? toWslUncHome(distro, home) : null);
    });
  });
}

/** The roots for a tab: its WSL home when the cwd is a Linux path on Windows. */
export async function agentRootsForCwd(cwd: string | null, env: Env = process.env): Promise<AgentRoots> {
  if (process.platform === 'win32' && typeof cwd === 'string' && cwd.startsWith('/')) {
    wslHomePromise ??= discoverWslHome(env);
    const uncHome = await wslHomePromise;
    if (uncHome) return wslAgentRoots(uncHome, env);
  }
  return defaultAgentRoots(env);
}
