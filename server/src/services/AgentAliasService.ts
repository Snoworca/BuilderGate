// FR-AITUI-011: extra launch commands for Claude and Codex (e.g. claudep, codexp). A command
// whose executable is one of these is the agent itself for foreground detection, session
// save and resume. Stored in ./data/agent-aliases.json; the built-in names are not stored.
import fs from 'fs/promises';
import path from 'path';
import { AppError, ErrorCode } from '../utils/errors.js';
import { publishStoreAtomically } from '../utils/atomicStoreWrite.js';
import { normalizeRecoveryExecutable } from '../utils/recoveryCommand.js';

export type AliasAgent = 'claude' | 'codex';

export const BUILT_IN_AGENT_COMMANDS: Readonly<Record<AliasAgent, readonly string[]>> = Object.freeze({
  claude: Object.freeze(['claude', 'claude-code']),
  codex: Object.freeze(['codex']),
});

export interface AgentAliasList {
  builtIn: string[];
  aliases: string[];
}

export type AgentAliasView = Record<AliasAgent, AgentAliasList>;
export type AgentAliasUpdate = Partial<Record<AliasAgent, string[]>>;

const AGENTS: readonly AliasAgent[] = ['claude', 'codex'];
const DEFAULT_DATA_PATH = './data/agent-aliases.json';
const MAX_ALIASES_PER_AGENT = 32;
const MAX_ALIAS_LENGTH = 64;
// A bare command name: no spaces, no path separators, no shell metacharacters.
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export class AgentAliasService {
  private aliases: Record<AliasAgent, string[]> = { claude: [], codex: [] };
  private readonly dataFilePath: string;

  constructor(options: { dataPath?: string } = {}) {
    this.dataFilePath = path.resolve(options.dataPath ?? DEFAULT_DATA_PATH);
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.dataFilePath, 'utf8')) as Partial<Record<AliasAgent, unknown>>;
      this.aliases = this.validate({
        claude: Array.isArray(parsed.claude) ? parsed.claude.map(String) : [],
        codex: Array.isArray(parsed.codex) ? parsed.codex.map(String) : [],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn(`[AgentAlias] Ignoring unreadable ${this.dataFilePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.aliases = { claude: [], codex: [] };
    }
  }

  getAll(): AgentAliasView {
    return {
      claude: { builtIn: [...BUILT_IN_AGENT_COMMANDS.claude], aliases: [...this.aliases.claude] },
      codex: { builtIn: [...BUILT_IN_AGENT_COMMANDS.codex], aliases: [...this.aliases.codex] },
    };
  }

  async update(update: AgentAliasUpdate): Promise<AgentAliasView> {
    const next = this.validate({
      claude: update.claude ?? this.aliases.claude,
      codex: update.codex ?? this.aliases.codex,
    });
    await publishStoreAtomically(this.dataFilePath, `${JSON.stringify(next, null, 2)}\n`, { ensureDirectory: true });
    this.aliases = next;
    return this.getAll();
  }

  /** The agent an executable launches, built-in names included; null for anything else. */
  resolve(executable: string | null | undefined): AliasAgent | null {
    if (!executable) return null;
    const name = normalizeRecoveryExecutable(executable);
    for (const agent of AGENTS) {
      if (BUILT_IN_AGENT_COMMANDS[agent].includes(name) || this.aliases[agent].includes(name)) return agent;
    }
    return null;
  }

  private validate(input: Record<AliasAgent, string[]>): Record<AliasAgent, string[]> {
    const used = new Map<string, AliasAgent>();
    for (const agent of AGENTS) for (const name of BUILT_IN_AGENT_COMMANDS[agent]) used.set(name, agent);
    const out: Record<AliasAgent, string[]> = { claude: [], codex: [] };
    for (const agent of AGENTS) {
      const list = input[agent];
      if (list.length > MAX_ALIASES_PER_AGENT) {
        throw new AppError(ErrorCode.INVALID_INPUT, `At most ${MAX_ALIASES_PER_AGENT} aliases per agent`);
      }
      for (const raw of list) {
        const trimmed = String(raw).trim();
        if (trimmed === '' || trimmed.length > MAX_ALIAS_LENGTH || !ALIAS_PATTERN.test(trimmed)) {
          throw new AppError(ErrorCode.INVALID_INPUT, `Invalid alias: ${JSON.stringify(raw)}`);
        }
        const name = normalizeRecoveryExecutable(trimmed);
        if (used.has(name)) {
          throw new AppError(ErrorCode.INVALID_INPUT, `Alias already used: ${name}`);
        }
        used.set(name, agent);
        out[agent].push(name);
      }
    }
    return out;
  }
}
