// FR-USAGE-001 / FR-USAGE-003: where usage is read from on this machine — the server's own homes
// and, on Windows, the WSL user's home over \\wsl.localhost — and how the Claude relay is put in
// and taken out of each Claude config folder.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { agentRootsForCwd, defaultAgentRoots } from '../agentSession/agentRoots.js';
import { CLAUDE_RELAY_STATE_FILE, installClaudeRelay, readClaudeUsage, relayStatus, uninstallClaudeRelay, type ClaudeConfigRef } from './claudeUsageRelay.js';
import { createCodexUsageReader, type CodexHomeRef } from './codexUsageReader.js';
import type { ClaudeCollectionDirStatus } from './UsageLimitsService.js';
import type { UsageReading, UsageSource } from './usageModel.js';

/** `\\wsl.localhost\<distro>\home\dev\.claude` → `/home/dev/.claude`; null for a Windows path. */
export function uncToLinuxPath(uncPath: string): string | null {
  const match = /^\\\\wsl(?:\.localhost|\$)\\[^\\]+(\\.*)$/iu.exec(uncPath);
  return match ? match[1].replace(/\\/g, '/') : null;
}

/** The node an existing statusline command runs with, so the relay runs where it did. */
export function nodeCommandFrom(command: string | null | undefined): string {
  const first = /^\s*('[^']*'|"[^"]*"|\S+)/u.exec(command ?? '')?.[1] ?? '';
  const bare = first.replace(/^['"]|['"]$/g, '');
  return /(^|[\\/])node(\.exe)?$/iu.test(bare) ? first : 'node';
}

interface Locations {
  codex: CodexHomeRef[];
  claude: ClaudeConfigRef[];
}

async function defaultLocations(): Promise<Locations> {
  const local = defaultAgentRoots();
  const localSource: UsageSource = process.platform === 'win32' ? 'windows' : 'local';
  const out: Locations = {
    codex: [{ codexHome: local.codexHome, source: localSource }],
    claude: [{ configDir: local.claudeHome, source: localSource }],
  };
  if (process.platform === 'win32') {
    const wsl = await agentRootsForCwd('/').catch(() => null);
    if (wsl && wsl.codexHome !== local.codexHome) {
      out.codex.push({ codexHome: wsl.codexHome, source: 'wsl' });
      out.claude.push({ configDir: wsl.claudeHome, source: 'wsl' });
    }
  }
  return out;
}

const exists = (dir: string) => fs.stat(dir).then((stat) => stat.isDirectory(), () => false);

async function originalCommand(configDir: string): Promise<string | null> {
  const read = async (file: string) => JSON.parse(await fs.readFile(path.join(configDir, file), 'utf8').catch(() => 'null'));
  const state = await read(CLAUDE_RELAY_STATE_FILE).catch(() => null);
  if (state?.original?.command) return state.original.command;
  const settings = await read('settings.json').catch(() => null);
  return typeof settings?.statusLine?.command === 'string' ? settings.statusLine.command : null;
}

/** `/home/dev/x` under the WSL share this config folder is on: `\\wsl.localhost\Ubuntu\home\dev\x`. */
function linuxToUnc(linuxPath: string, uncConfigDir: string): string | null {
  const root = /^(\\\\wsl(?:\.localhost|\$)\\[^\\]+)/iu.exec(uncConfigDir)?.[1];
  return root ? `${root}${linuxPath.replace(/\//g, '\\')}` : null;
}

const run = (file: string, args: string[]) => new Promise<boolean>((resolve) => {
  execFile(file, args, { timeout: 8000, windowsHide: true }, (error) => resolve(!error));
});

/**
 * Whether Claude Code can start the relay with this node; without it the statusline would vanish.
 * A path is checked on disk; a bare `node` is looked up where Claude Code runs.
 */
async function defaultNodeExists(ref: ClaudeConfigRef, nodeCommand: string): Promise<boolean> {
  const bare = nodeCommand.replace(/^['"]|['"]$/g, '');
  if (bare !== 'node') {
    const target = ref.source === 'wsl' ? linuxToUnc(bare, ref.configDir) : bare;
    return target ? fs.stat(target).then(() => true, () => false) : false;
  }
  if (ref.source === 'wsl') {
    // A login shell, so a node from nvm is found; the distro is the one the folder is on.
    const distro = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/iu.exec(ref.configDir)?.[1];
    return run('wsl.exe', [...(distro ? ['-d', distro] : []), '-e', 'bash', '-lc', 'command -v node']);
  }
  return run(process.platform === 'win32' ? 'where' : 'which', ['node']);
}

export interface UsageSourcesDeps {
  locations?: () => Promise<Locations>;
  nodeExists?: (ref: ClaudeConfigRef, nodeCommand: string) => Promise<boolean>;
}

export function createUsageSources(deps: UsageSourcesDeps = {}) {
  const codex = createCodexUsageReader();
  const locations = deps.locations ?? defaultLocations;
  const nodeExists = deps.nodeExists ?? defaultNodeExists;
  return {
    async readReadings(): Promise<UsageReading[]> {
      const where = await locations();
      const [codexReadings, claudeReadings] = await Promise.all([
        codex.read(where.codex).catch(() => []),
        readClaudeUsage(where.claude).catch(() => []),
      ]);
      return [...claudeReadings, ...codexReadings];
    },
    async setClaudeCollection(on: boolean): Promise<ClaudeCollectionDirStatus[]> {
      const results: ClaudeCollectionDirStatus[] = [];
      for (const ref of (await locations()).claude) {
        if (!(await exists(ref.configDir))) continue;
        try {
          if (on) {
            const commandPath = ref.source === 'wsl' ? uncToLinuxPath(ref.configDir) : ref.configDir.replace(/\\/g, '/');
            if (!commandPath) throw new Error('the WSL path could not be mapped');
            const nodeCommand = nodeCommandFrom(await originalCommand(ref.configDir));
            if (!(await nodeExists(ref, nodeCommand))) throw new Error(`node was not found for this Claude (${nodeCommand}); the statusline was left as it is`);
            await installClaudeRelay({ configDir: ref.configDir, commandPath, nodeCommand });
          } else {
            await uninstallClaudeRelay(ref.configDir);
          }
          results.push({ configDir: ref.configDir, source: ref.source, ...(await relayStatus(ref.configDir)) });
        } catch (error) {
          results.push({ configDir: ref.configDir, source: ref.source, installed: false, drifted: false, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return results;
    },
    async claudeCollectionStatus(): Promise<ClaudeCollectionDirStatus[]> {
      const results: ClaudeCollectionDirStatus[] = [];
      for (const ref of (await locations()).claude) {
        if (!(await exists(ref.configDir))) continue;
        results.push({ configDir: ref.configDir, source: ref.source, ...(await relayStatus(ref.configDir).catch(() => ({ installed: false, drifted: false }))) });
      }
      return results;
    },
  };
}
