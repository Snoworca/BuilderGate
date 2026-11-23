// FR-AITUI-025 — the permission mode a Claude session runs in, and the resume arguments
// that open it in that mode again.
//
// Claude Code records the mode only with a user message (`"permissionMode":"..."` on the
// message, then a `permission-mode` entry), in <claudeHome>/projects/<folder>/<id>.jsonl.
// A session resumed with a new flag keeps the old value at the end of its transcript until
// the next message, so the transcript tells the current mode only for messages sent after
// the agent started; before that, the launch line or the process command line does.

import { constants as fsConstants } from 'node:fs';
import { access, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto' | 'dontAsk';

const MODES: ReadonlySet<string> = new Set<ClaudePermissionMode>(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP = '--dangerously-skip-permissions';
const ALLOW_SKIP = '--allow-dangerously-skip-permissions';
const MODE_FLAG = '--permission-mode';
/** Read backwards in chunks; a transcript can be tens of MB. */
const CHUNK = 256 * 1024;
const MAX_READ = 16 * 1024 * 1024;

export function isClaudePermissionMode(value: unknown): value is ClaudePermissionMode {
  return typeof value === 'string' && MODES.has(value);
}

export interface TranscriptPermissionModes {
  /** The last mode the transcript recorded, of any entry. */
  last: ClaudePermissionMode | null;
  /** The last mode recorded on a timestamped message, with that time. */
  lastStamped: { mode: ClaudePermissionMode; atMs: number } | null;
}

const NONE: TranscriptPermissionModes = { last: null, lastStamped: null };

/** Claude's project folder name for a cwd: every character but [A-Za-z0-9] becomes '-'. */
function projectFolderOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function readable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function findTranscript(claudeHome: string, sessionId: string, cwds: ReadonlyArray<string | null>): Promise<string | null> {
  const projects = path.join(claudeHome, 'projects');
  const file = `${sessionId}.jsonl`;
  for (const cwd of cwds) {
    if (cwd && await readable(path.join(projects, projectFolderOf(cwd), file))) return path.join(projects, projectFolderOf(cwd), file);
  }
  // A long path is shortened in the folder name; the session may also have changed folders.
  let folders: string[];
  try {
    folders = await readdir(projects);
  } catch {
    return null;
  }
  for (const folder of folders) {
    if (await readable(path.join(projects, folder, file))) return path.join(projects, folder, file);
  }
  return null;
}

/** One transcript line's mode and time; an unknown mode reads as none. */
function modeOfLine(text: string): { mode: ClaudePermissionMode; atMs: number | null } | null {
  if (!text.includes('"permissionMode"')) return null;
  try {
    const data = JSON.parse(text) as { permissionMode?: unknown; timestamp?: unknown };
    if (!isClaudePermissionMode(data.permissionMode)) return null;
    const atMs = typeof data.timestamp === 'string' ? Date.parse(data.timestamp) : NaN;
    return { mode: data.permissionMode, atMs: Number.isFinite(atMs) ? atMs : null };
  } catch {
    return null;
  }
}

/** The modes a Claude session's transcript recorded last; nothing known gives nulls. */
export async function readClaudePermissionModes(
  claudeHome: string,
  sessionId: string,
  cwds: ReadonlyArray<string | null>,
): Promise<TranscriptPermissionModes> {
  if (!SESSION_ID.test(sessionId)) return NONE;
  const file = await findTranscript(claudeHome, sessionId, cwds);
  if (!file) return NONE;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const found: { last: ClaudePermissionMode | null; lastStamped: TranscriptPermissionModes['lastStamped'] } = { last: null, lastStamped: null };
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    let end = size;
    // The start of a line cut by the previous (later) chunk's boundary.
    let carry = Buffer.alloc(0);
    while (end > 0 && size - end < MAX_READ && !found.lastStamped) {
      const start = Math.max(0, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      await handle.read(chunk, 0, chunk.length, start);
      const joined = Buffer.concat([chunk, carry]);
      // The first line may be cut; it is read whole with the next chunk, unless this is the file's start.
      const cut = start > 0 ? joined.indexOf(0x0a) : -1;
      if (start > 0 && cut < 0) {
        // One line longer than a chunk (a pasted image): keep all of it for the next round.
        carry = joined;
        end = start;
        continue;
      }
      const lines = (cut >= 0 ? joined.subarray(cut + 1) : joined).toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && !found.lastStamped; i -= 1) {
        const seen = modeOfLine(lines[i]);
        if (!seen) continue;
        found.last ??= seen.mode;
        if (seen.atMs !== null) found.lastStamped = { mode: seen.mode, atMs: seen.atMs };
      }
      carry = cut >= 0 ? joined.subarray(0, cut) : Buffer.alloc(0);
      end = start;
    }
  } catch {
    // What was read so far stands.
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return found;
}

/** Splits a command line on whitespace outside double or single quotes. */
function tokens(commandLine: string): string[] {
  const out: string[] = [];
  for (const match of commandLine.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

/**
 * The mode a Claude process was launched in, from its command line: null when there is no
 * command line, 'unknown' for a mode this server does not know. A prompt passed as an argument
 * is one quoted token and never reads as a flag.
 */
export function permissionModeOfCommandLine(commandLine: string | null | undefined): ClaudePermissionMode | 'unknown' | null {
  if (!commandLine) return null;
  const args = tokens(commandLine);
  if (args.includes(SKIP)) return 'bypassPermissions';
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i] === MODE_FLAG ? args[i + 1] : args[i].startsWith(`${MODE_FLAG}=`) ? args[i].slice(MODE_FLAG.length + 1) : undefined;
    if (value !== undefined) return isClaudePermissionMode(value) ? value : 'unknown';
  }
  return 'default';
}

/**
 * AC-2/AC-3: the resume arguments with their permission flags set for the mode. The new
 * flag goes before a trailing `--resume <id>`, which stays the last two arguments.
 */
export function applyClaudePermissionMode(args: readonly string[], mode: ClaudePermissionMode): string[] {
  const kept: string[] = [];
  let droppedSkip = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === SKIP) {
      droppedSkip = true;
      continue;
    }
    if (arg === MODE_FLAG) {
      if (i + 1 < args.length) i += 1;
      continue;
    }
    if (arg.startsWith(`${MODE_FLAG}=`)) continue;
    kept.push(arg);
  }
  const added: string[] = [];
  if (mode === 'bypassPermissions') {
    added.push(SKIP);
  } else {
    // Leaving bypass: Shift+Tab can go back to it only when the launch allows it.
    if (droppedSkip && !kept.includes(ALLOW_SKIP)) added.push(ALLOW_SKIP);
    if (mode !== 'default') added.push(MODE_FLAG, mode);
  }
  const at = kept.length >= 2 && kept[kept.length - 2] === '--resume' ? kept.length - 2 : kept.length;
  return [...kept.slice(0, at), ...added, ...kept.slice(at)];
}

export interface LivePermissionInput {
  /** The launch line was seen; the resume arguments already carry its flags. */
  launchKnown: boolean;
  /** The command line of the Claude process running in the tab, when the process list has it. */
  processCommandLine: string | null;
  /** When the running agent started (ms), if known. */
  agentStartedAtMs: number | undefined;
  transcript: TranscriptPermissionModes;
}

/**
 * AC-1: the mode a live Claude tab is saved with, or null to keep the resume arguments as they
 * are. A message sent since the agent started tells the mode it runs in now (Shift+Tab included);
 * the record written after that message's turn is newer still, and from this run, because the
 * transcript is only appended to. Before any such message, the launch line (already in the
 * arguments) or the process command line does, and only when neither is known the transcript's
 * last record. A mode this server does not know keeps the arguments.
 */
export function decideLivePermissionMode(input: LivePermissionInput): ClaudePermissionMode | null {
  const stamped = input.transcript.lastStamped;
  if (stamped && input.agentStartedAtMs !== undefined && stamped.atMs >= input.agentStartedAtMs) return input.transcript.last ?? stamped.mode;
  if (input.launchKnown) return null;
  const launched = permissionModeOfCommandLine(input.processCommandLine);
  if (launched === 'unknown') return null;
  return launched ?? input.transcript.last;
}
